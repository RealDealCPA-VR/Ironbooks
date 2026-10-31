/**
 * Feature round (team purchbank): PARITY D3 — QB Print Checks for every queued check (Write
 * Checks, bill payments, sales tax / liability / refund checks, paychecks):
 *
 *  - several checks print in one run, numbered from the first check in the printer;
 *  - nothing is recorded when the PDF is made: the numbers are recorded only after "Did checks
 *    print OK?" is answered;
 *  - the checks that did not print correctly stay in the queue for a reprint, and a check that
 *    was already printed can be put back in the queue to print it again (with a new number).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { expenses, journalEntries, billPayments } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { postJournalEntry } from './posting';
import { createVendor } from './vendors';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { setClosingDate } from './company';
import { confirmPrintRun, listPrintQueue, markPrinted, preparePrintRun, requeueForReprint } from './printQueue';
import { builtinRole, unionRoles } from '@/lib/permissions/model';

let t: TestCompany;
let vendorId: string;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => t.ctx) }));
import { POST as runPOST } from '@/app/api/print-queue/run/route';
import { POST as confirmPOST } from '@/app/api/print-queue/confirm/route';
import { POST as reprintPOST } from '@/app/api/print-queue/reprint/route';

const post = (fn: (req: never) => Promise<Response>, url: string, body: unknown) =>
  fn(new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as never);
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

async function queuedCheck(amount: string, date = '2026-03-10') {
  return createExpense(t.ctx, {
    vendorId,
    date: D(date),
    method: 'check',
    toPrint: true,
    paymentAccountId: t.acct['1000'],
    lines: [{ accountId: t.acct['6300'], amount }],
  });
}

async function expenseRow(id: string) {
  const [row] = await t.ctx.db.select().from(expenses).where(eq(expenses.id, id));
  return row;
}

beforeAll(async () => {
  t = await makeTestCompany('purchbank-print-run');
  vendorId = (await createVendor(t.ctx, { displayName: 'Run Vendor' } as never)).id;
  await postJournalEntry(t.ctx, {
    date: D('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '50000.00' },
      { accountId: t.acct['3900'], credit: '50000.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('print run: numbers recorded only after "Did checks print OK?"', () => {
  it('preparing the run records nothing; confirming records each number on the check and its entry', async () => {
    const a = await queuedCheck('10.00');
    const b = await queuedCheck('20.00');
    // A bill payment by check, "To be printed", in the same run.
    const bill = await createBill(t.ctx, {
      vendorId,
      date: D('2026-03-01'),
      lines: [{ accountId: t.acct['6300'], amount: '30.00' }],
    } as never);
    const bp = await payBills(t.ctx, {
      vendorId,
      date: D('2026-03-11'),
      method: 'check',
      toPrint: true,
      paymentAccountId: t.acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '30.00' }],
    } as never);
    const items = [
      { source: 'expense' as const, id: a.id, checkNumber: '5001' },
      { source: 'expense' as const, id: b.id, checkNumber: '5002' },
      { source: 'bill_payment' as const, id: bp.id, checkNumber: '5003' },
    ];
    const run = await preparePrintRun(t.ctx, { items });
    expect(run.paymentAccountId).toBe(t.acct['1000']);
    expect(run.items.map((i) => i.checkNumber)).toEqual(['5001', '5002', '5003']);
    // Still in the queue, still without a number.
    expect((await expenseRow(a.id)).toPrint).toBe(true);
    expect((await expenseRow(a.id)).reference ?? null).toBeNull();
    expect((await listPrintQueue(t.ctx)).filter((q) => items.some((i) => i.id === q.id))).toHaveLength(3);

    const res = await confirmPrintRun(t.ctx, { items });
    expect(res.printed.map((p) => p.checkNumber)).toEqual(['5001', '5002', '5003']);
    expect(res.reprint).toEqual([]);
    const ra = await expenseRow(a.id);
    expect(ra.toPrint).toBe(false);
    expect(ra.reference).toBe('5001');
    const [je] = await t.ctx.db.select().from(journalEntries).where(eq(journalEntries.id, ra.postedEntryId!));
    expect(je.reference).toBe('5001');
    const [bpRow] = await t.ctx.db.select().from(billPayments).where(eq(billPayments.id, bp.id));
    expect(bpRow.reference).toBe('5003');
    expect(bpRow.toPrint).toBe(false);
  });

  it('checks that did not print correctly stay in the queue for a reprint with new numbers', async () => {
    const a = await queuedCheck('11.00');
    const b = await queuedCheck('12.00');
    const c = await queuedCheck('13.00');
    const items = [
      { source: 'expense' as const, id: a.id, checkNumber: '6001' },
      { source: 'expense' as const, id: b.id, checkNumber: '6002', reprint: true },
      { source: 'expense' as const, id: c.id, checkNumber: '6003', reprint: true },
    ];
    await preparePrintRun(t.ctx, { items });
    const res = await confirmPrintRun(t.ctx, { items });
    expect(res.printed.map((p) => p.id)).toEqual([a.id]);
    expect(res.reprint.map((p) => p.id)).toEqual([b.id, c.id]);
    expect((await expenseRow(a.id)).reference).toBe('6001');
    expect((await expenseRow(b.id)).toPrint).toBe(true);
    expect((await expenseRow(b.id)).reference ?? null).toBeNull();
    // The reprint: new numbers (the spoiled 6002 / 6003 are not used).
    const again = [
      { source: 'expense' as const, id: b.id, checkNumber: '6004' },
      { source: 'expense' as const, id: c.id, checkNumber: '6005' },
    ];
    await preparePrintRun(t.ctx, { items: again });
    await confirmPrintRun(t.ctx, { items: again });
    expect((await expenseRow(b.id)).reference).toBe('6004');
    expect((await expenseRow(c.id)).reference).toBe('6005');
  });

  it('asks before using a number already on the account (before printing), and refuses repeats in the run', async () => {
    const used = await queuedCheck('14.00');
    await markPrinted(t.ctx, { source: 'expense', id: used.id, checkNumber: '7001' });
    const a = await queuedCheck('15.00');
    const b = await queuedCheck('16.00');
    const items = [
      { source: 'expense' as const, id: a.id, checkNumber: '7001' },
      { source: 'expense' as const, id: b.id, checkNumber: '7002' },
    ];
    const dup = await refusal(preparePrintRun(t.ctx, { items }));
    expect(dup.code).toBe('CONFLICT');
    expect(dup.message).toMatch(/7001 .*already used on this bank account/);
    expect((dup.details as { duplicateNumber?: boolean }).duplicateNumber).toBe(true);
    // Confirmed: the run goes ahead.
    await preparePrintRun(t.ctx, { items, allowDuplicateNumber: true });
    const repeat = await refusal(
      preparePrintRun(t.ctx, {
        items: [
          { source: 'expense', id: a.id, checkNumber: '7010' },
          { source: 'expense', id: b.id, checkNumber: '7010' },
        ],
      }),
    );
    expect(repeat.code).toBe('VALIDATION');
    // Confirming without the OK is refused as a whole (nothing half-recorded).
    expect((await refusal(confirmPrintRun(t.ctx, { items }))).code).toBe('CONFLICT');
    expect((await expenseRow(b.id)).reference ?? null).toBeNull();
    await confirmPrintRun(t.ctx, { items, allowDuplicateNumber: true });
    expect((await expenseRow(a.id)).reference).toBe('7001');
  });

  it('refuses a check that is no longer waiting (printed elsewhere or voided) and checks of two bank accounts', async () => {
    const a = await queuedCheck('17.00');
    await markPrinted(t.ctx, { source: 'expense', id: a.id, checkNumber: '8001' });
    expect((await refusal(preparePrintRun(t.ctx, { items: [{ source: 'expense', id: a.id, checkNumber: '8002' }] }))).message).toMatch(
      /no longer waiting to be printed/,
    );
    const b = await queuedCheck('18.00');
    const other = await createExpense(t.ctx, {
      vendorId,
      date: D('2026-03-10'),
      method: 'check',
      toPrint: true,
      paymentAccountId: t.acct['1010'] ?? t.acct['1020'],
      lines: [{ accountId: t.acct['6300'], amount: '19.00' }],
    });
    expect(
      (
        await refusal(
          preparePrintRun(t.ctx, {
            items: [
              { source: 'expense', id: b.id, checkNumber: '8003' },
              { source: 'expense', id: other.id, checkNumber: '8004' },
            ],
          }),
        )
      ).message,
    ).toMatch(/different bank accounts/);
  });
});

describe('reprint a check that was already printed', () => {
  it('puts it back in the queue without its number; the reprint records the new number', async () => {
    const a = await queuedCheck('21.00');
    await confirmPrintRun(t.ctx, { items: [{ source: 'expense', id: a.id, checkNumber: '9001' }] });
    const back = await requeueForReprint(t.ctx, { source: 'expense', id: a.id });
    expect(back.toPrint).toBe(true);
    const row = await expenseRow(a.id);
    expect(row.toPrint).toBe(true);
    expect(row.reference ?? null).toBeNull();
    const [je] = await t.ctx.db.select().from(journalEntries).where(eq(journalEntries.id, row.postedEntryId!));
    expect(je.reference ?? null).toBeNull();
    expect((await listPrintQueue(t.ctx)).some((q) => q.id === a.id)).toBe(true);
    // Already waiting: nothing to put back.
    expect((await refusal(requeueForReprint(t.ctx, { source: 'expense', id: a.id }))).code).toBe('CONFLICT');
    await confirmPrintRun(t.ctx, { items: [{ source: 'expense', id: a.id, checkNumber: '9002' }] });
    expect((await expenseRow(a.id)).reference).toBe('9002');
    // 9001 is free again.
    const b = await queuedCheck('22.00');
    await preparePrintRun(t.ctx, { items: [{ source: 'expense', id: b.id, checkNumber: '9001' }] });
  });

  it('a check dated in a closed period needs the closing date password', async () => {
    const a = await queuedCheck('23.00', '2026-02-10');
    await confirmPrintRun(t.ctx, { items: [{ source: 'expense', id: a.id, checkNumber: '9101' }] });
    await setClosingDate(t.ctx, { closingDate: '2026-02-28', password: 'pw' } as never);
    try {
      expect((await refusal(requeueForReprint(t.ctx, { source: 'expense', id: a.id }))).code).toBe('PERIOD_CLOSED');
      expect((await expenseRow(a.id)).reference).toBe('9101');
      await requeueForReprint({ ...t.ctx, closingDateOverride: true }, { source: 'expense', id: a.id });
      expect((await expenseRow(a.id)).toPrint).toBe(true);
    } finally {
      await setClosingDate(t.ctx, { closingDate: null } as never);
    }
  });

  it('paychecks in a run or a reprint need the payroll permission', async () => {
    const a = await queuedCheck('24.00');
    const noPayroll: ServiceContext = { ...t.ctx, access: unionRoles([builtinRole('banking')!]) };
    // A banking-only user still prints ordinary checks.
    await preparePrintRun(noPayroll, { items: [{ source: 'expense', id: a.id, checkNumber: '9201' }] });
    const err = await refusal(
      preparePrintRun(noPayroll, { items: [{ source: 'paycheck', id: '00000000-0000-4000-8000-000000000000', checkNumber: '9202' }] }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect((await refusal(requeueForReprint(noPayroll, { source: 'paycheck', id: '00000000-0000-4000-8000-000000000000' }))).code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('routes: /api/print-queue/run, /confirm, /reprint', () => {
  it('check, confirm and reprint over HTTP; bad bodies are 400', async () => {
    const a = await queuedCheck('31.00');
    const items = [{ source: 'expense', id: a.id, checkNumber: '9301' }];
    const run = await post(runPOST, '/api/print-queue/run', { items });
    expect(run.status).toBe(200);
    expect((await expenseRow(a.id)).reference ?? null).toBeNull();
    expect((await post(runPOST, '/api/print-queue/run', { items: [] })).status).toBe(400);
    expect((await post(runPOST, '/api/print-queue/run', { items: [{ source: 'expense', id: a.id, checkNumber: ' ' }] })).status).toBe(400);
    const ok = await post(confirmPOST, '/api/print-queue/confirm', { items: [{ ...items[0], reprint: false }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { printed: unknown[] }).printed).toHaveLength(1);
    expect((await expenseRow(a.id)).reference).toBe('9301');
    const back = await post(reprintPOST, '/api/print-queue/reprint', { source: 'expense', id: a.id });
    expect(back.status).toBe(200);
    expect((await expenseRow(a.id)).toPrint).toBe(true);
    expect((await post(reprintPOST, '/api/print-queue/reprint', { source: 'expense', id: a.id })).status).toBe(409);
    expect((await post(reprintPOST, '/api/print-queue/reprint', { source: 'nope', id: a.id })).status).toBe(400);
  });
});
