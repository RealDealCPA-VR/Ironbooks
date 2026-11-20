/**
 * Full account numbers and SSNs reach only callers with the matching right (plan 5.9, decision D6),
 * person or agent. The first wave's reviewers found four answers that skipped lib/permissions/mask.ts
 * (_vr_tmp/WAVE1-NOTES.md, banking / planning / lists / payroll):
 *
 *   1. the check print queue put the payee's full account number in the memo ("Acct # …");
 *   2. Sales Tax Payment checks store that memo, and every answer that lists or returns them sent it
 *      (the payment also copied it onto its journal entry's line, which the ledger answers unmasked);
 *   3. assigning a vendor type answered the whole vendor row (tax ID, account number);
 *   4. the state wage worksheet answered the employer's state account number in full.
 *
 * Each case: a caller without the right gets the masked form, a caller with it the full value, and
 * the text printed on the check is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, paymentChecks, users, vendors } from '@/lib/db/schema';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import { createExpense } from '@/lib/services/expenses';
import { createEntry } from '@/lib/services/lists/simpleLists';
import { createBill } from '@/lib/services/bills';
import { payBills } from '@/lib/services/billPayments';
import { createTaxAgency } from '@/lib/services/salesTax';
import {
  checkMemoFor,
  getPaymentCheck,
  listPaymentChecks,
  paySalesTax,
  paySalesTaxAgencies,
  voidPaymentCheck,
} from '@/lib/services/liabilityPayments';
import { getEntry } from '@/lib/services/journal';
import { checkPrintData, listPrintQueue, markPrinted } from '@/lib/services/printQueue';
import { assignVendorType, createType } from '@/lib/services/typeLists';
import { listStateTaxSettings, upsertStateTaxSetting } from '@/lib/services/payrollAdjustments';
import { stateWageWorksheet } from '@/lib/services/payrollReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-masking-units');
let db: DB;
/** Trusted (no access): sets the company up. */
let ctx: ServiceContext;
/** Every right but "view full account numbers" and "sensitive payroll". */
let masked: ServiceContext;
/** Every right, both flags included. */
let full: ServiceContext;
let acct: Record<string, string>;

const FULL_NUMBER = '000123456789';
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

/** Admin permissions with the two "view sensitive data" flags set as given: only the flags differ. */
function accessWithFlags(on: boolean): EffectiveAccess {
  const a = fullAccess();
  return { ...a, flags: { ...a.flags, fullAccountNumbers: on, sensitivePayroll: on } };
}

async function vendorWithNumber(displayName: string, extra: Partial<typeof vendors.$inferInsert> = {}) {
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName, accountNumber: FULL_NUMBER, ...extra })
    .returning();
  return v;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'masking@units.local', name: 'Masking', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Masking Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  masked = { ...ctx, access: accessWithFlags(false) };
  full = { ...ctx, access: accessWithFlags(true) };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('checkMemoFor (the memo text as a caller may see it)', () => {
  it('masks the account number after "Acct #" for a caller without the right', () => {
    expect(checkMemoFor(masked, `Acct # ${FULL_NUMBER}`)).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # 1234 5678 9012')).toBe('Acct # ••••9012');
    expect(checkMemoFor(masked, 'ACCT#ACC-778')).toBe('ACCT#••••-778');
    expect(checkMemoFor(masked, 'Acct # 12')).toBe('Acct # ••••');
    // A memo typed over two lines: everything after "Acct #" is masked, the line break included.
    expect(checkMemoFor(masked, 'Paid in full\nAcct # 0001\n23456789')).toBe('Paid in full\nAcct # ••••6789');
  });

  it('shows the memo as stored to a caller with the right and to a trusted context', () => {
    expect(checkMemoFor(full, `Acct # ${FULL_NUMBER}`)).toBe(`Acct # ${FULL_NUMBER}`);
    expect(checkMemoFor(ctx, `Acct # ${FULL_NUMBER}`)).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('leaves other memos, blanks and already masked text alone', () => {
    expect(checkMemoFor(masked, 'Q3 extra')).toBe('Q3 extra');
    expect(checkMemoFor(masked, null)).toBeNull();
    expect(checkMemoFor(masked, '')).toBe('');
    expect(checkMemoFor(masked, 'Acct # ••••6789')).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # ••••')).toBe('Acct # ••••');
  });

  it('a "*" or "•" in the text does not count as masked unless it is exactly the mask', () => {
    // A typed note after the number, or a number brought in by import that holds a "*".
    const typed = checkMemoFor(masked, `Acct # ${FULL_NUMBER} *rush*`);
    expect(typed).toBe('Acct # ••••ush*');
    expect(typed).not.toContain(FULL_NUMBER);
    expect(checkMemoFor(masked, 'Acct # 0001*23456789')).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # ••••0001 23456789')).toBe('Acct # ••••6789');
  });

  it('errs on the safe side for typed memos: everything after "Acct #" is masked', () => {
    // Deliberate: the end of an account number cannot be told from the text that follows it.
    expect(checkMemoFor(masked, 'Ref acct #5 of 12 invoices')).toBe('Ref acct #••••ices');
    expect(checkMemoFor(masked, `Paid (Acct # ${FULL_NUMBER})`)).toBe('Paid (Acct # ••••789)');
    // A caller with the right sees what was typed.
    expect(checkMemoFor(full, 'Ref acct #5 of 12 invoices')).toBe('Ref acct #5 of 12 invoices');
  });
});

describe('1. the check print queue', () => {
  it('a Write Checks check: the listing masks the memo, the printed check keeps the full number', async () => {
    const v = await vendorWithNumber('Water Utility');
    const exp = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-03-02'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '10.00' }],
    });
    const hidden = (await listPrintQueue(masked)).find((q) => q.id === exp.id);
    expect(hidden?.memo).toBe('Acct # ••••6789');
    expect((await listPrintQueue(full)).find((q) => q.id === exp.id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    // The paper check: unchanged, whoever prints it.
    expect((await checkPrintData(masked, 'expense', exp.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await checkPrintData(full, 'expense', exp.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('an Other Names payee: same rule; a typed memo is shown as typed', async () => {
    const landlord = await createEntry(ctx, 'other-names', { name: 'Landlord LLC', accountNumber: 'LEASE-55501234' });
    const exp = await createExpense(ctx, {
      otherNameId: String(landlord.id),
      date: d('2026-03-03'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '900.00' }],
    });
    expect((await listPrintQueue(masked)).find((q) => q.id === exp.id)?.memo).toBe('Acct # ••••1234');
    expect((await listPrintQueue(full)).find((q) => q.id === exp.id)?.memo).toBe('Acct # LEASE-55501234');
    expect((await checkPrintData(masked, 'expense', exp.id)).memo).toBe('Acct # LEASE-55501234');

    const typed = await createExpense(ctx, {
      otherNameId: String(landlord.id),
      date: d('2026-03-04'),
      method: 'check',
      toPrint: true,
      memo: 'March rent',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '900.00' }],
    });
    expect((await listPrintQueue(masked)).find((q) => q.id === typed.id)?.memo).toBe('March rent');
  });

  it('a Pay Bills check: the listing masks the memo, the printed check keeps the full number', async () => {
    const v = await vendorWithNumber('Paper Supplier', { printOnCheckAs: 'Paper Supplier LLC' });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-03'), lines: [{ accountId: acct['6600'], amount: '60.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-04-04'),
      method: 'check',
      paymentAccountId: acct['1000'],
      toPrint: true,
      applications: [{ billId: bill.id, amountApplied: '60.00' }],
    });
    const list = await listPrintQueue(masked);
    expect(list.find((q) => q.id === pay.id)?.memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(list)).not.toContain(FULL_NUMBER);
    expect((await listPrintQueue(full)).find((q) => q.id === pay.id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await checkPrintData(masked, 'bill_payment', pay.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
  });
});

describe('2. Sales Tax Payment checks', () => {
  let agencyId: string;

  beforeAll(async () => {
    // The agency's vendor, found by name when the payment links it, carries the account number.
    await vendorWithNumber('State Revenue Dept');
    agencyId = (await createTaxAgency(ctx, { name: 'State Revenue Dept' })).id;
  });

  it('stores and prints the full number on the check; the check answers mask it and the ledger never holds it', async () => {
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-05'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '25.00' }],
      toPrint: true,
    });
    const id = paid.checks[0].id;
    const entryId = paid.checks[0].entryId;
    // The answer of POST /api/sales-tax/pay.
    expect(paid.checks[0].memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(paid)).not.toContain(FULL_NUMBER);

    // Stored in full: the check prints it, the agency applies the payment by it.
    const [stored] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, id));
    expect(stored.memo).toBe(`Acct # ${FULL_NUMBER}`);
    const printData = await checkPrintData(masked, 'payment_check', id);
    expect(printData.memo).toBe(`Acct # ${FULL_NUMBER}`);
    // The voucher stub prints what it printed before: the check's memo on the 2200 line.
    expect(printData.voucher).toEqual([
      { account: '2200 – Sales Tax Payable', description: `Acct # ${FULL_NUMBER}`, amount: '25.00' },
    ]);

    // The journal entry's lines do not carry the number: the journal entry (GET
    // /api/journal-entries/[id]), the General Ledger, the transaction reports and the assistant
    // answer line memos unmasked, to every caller.
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
    expect(lines.map((l) => l.memo).sort()).toEqual(['Sales Tax Payment — State Revenue Dept', 'Sales tax — State Revenue Dept']);
    expect(JSON.stringify(await getEntry(masked, entryId))).not.toContain(FULL_NUMBER);
    expect(JSON.stringify(await getEntry(full, entryId))).not.toContain(FULL_NUMBER);

    // GET /api/sales-tax/payments and /api/sales-tax/payments/[id].
    const listed = await listPaymentChecks(masked, { kind: 'sales_tax' });
    expect(listed.find((c) => c.id === id)?.memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(listed)).not.toContain(FULL_NUMBER);
    expect((await getPaymentCheck(masked, id)).memo).toBe('Acct # ••••6789');
    expect((await listPaymentChecks(full, { kind: 'sales_tax' })).find((c) => c.id === id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await getPaymentCheck(full, id)).memo).toBe(`Acct # ${FULL_NUMBER}`);

    // The print queue lists the stored memo.
    expect((await listPrintQueue(masked)).find((q) => q.id === id)?.memo).toBe('Acct # ••••6789');
    expect((await listPrintQueue(full)).find((q) => q.id === id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);

    // Recording the printed number (POST /api/print-queue) and voiding answer the check too.
    const printed = (await markPrinted(masked, { source: 'payment_check', id, checkNumber: '9001' })) as { memo: string | null };
    expect(printed.memo).toBe('Acct # ••••6789');
    expect((await voidPaymentCheck(masked, id)).memo).toBe('Acct # ••••6789');
    expect((await voidPaymentCheck(full, id)).memo).toBe(`Acct # ${FULL_NUMBER}`); // already void: answered as is
    const [after] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, id));
    expect(after.memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('a caller with the right gets the full number from the payment itself', async () => {
    const paid = await paySalesTaxAgencies(full, {
      date: d('2026-10-06'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '5.00' }],
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('a typed memo is answered as typed, and printed and posted as before', async () => {
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-07'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '1.00' }],
      memo: 'Q3 extra',
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBe('Q3 extra');
    expect((await checkPrintData(masked, 'payment_check', paid.checks[0].id)).voucher[0].description).toBe('Q3 extra');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, paid.checks[0].entryId));
    expect(lines.find((l) => l.debit && Number(l.debit) > 0)?.memo).toBe('Q3 extra');
  });

  it('an agency without an account number prints the agency on the voucher, as before', async () => {
    const otherAgency = (await createTaxAgency(ctx, { name: 'City Tax Office' })).id;
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-08'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId: otherAgency, amount: '3.00' }],
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBeNull();
    expect((await checkPrintData(masked, 'payment_check', paid.checks[0].id)).voucher[0].description).toBe('Sales tax — City Tax Office');
  });

  it('a payment with no agency keeps its voucher text (the check memo is not printed there)', async () => {
    const entry = await paySalesTax(masked, {
      amount: '2.00',
      date: d('2026-10-09'),
      paymentAccountId: acct['1000'],
      memo: 'Unattributed',
      toPrint: true,
    });
    const [check] = await db.select().from(paymentChecks).where(eq(paymentChecks.postedEntryId, entry.id));
    const data = await checkPrintData(masked, 'payment_check', check.id);
    expect(data.memo).toBe('Unattributed');
    expect(data.voucher[0].description).toBe('Sales Tax Payment');
  });
});

describe('3. assigning a vendor type', () => {
  it('answers the vendor masked without the rights, in full with them', async () => {
    const v = await vendorWithNumber('Sole Prop Plumbing', { taxId: '123-45-6789' });
    const type = await createType(ctx, 'vendor', { name: 'Trades' });

    const hidden = await assignVendorType(masked, v.id, type.id);
    expect(hidden.vendorTypeId).toBe(type.id);
    expect(hidden.accountNumber).toBe('••••6789');
    expect(hidden.taxId).toBe('***-**-6789');
    expect(JSON.stringify(hidden)).not.toContain(FULL_NUMBER);

    const shown = await assignVendorType(full, v.id, null);
    expect(shown.vendorTypeId).toBeNull();
    expect(shown.accountNumber).toBe(FULL_NUMBER);
    expect(shown.taxId).toBe('123-45-6789');

    // Only the answer is masked: the vendor keeps its numbers.
    const [row] = await db.select().from(vendors).where(eq(vendors.id, v.id));
    expect(row.accountNumber).toBe(FULL_NUMBER);
    expect(row.taxId).toBe('123-45-6789');
  });
});

describe('4. the state wage worksheet', () => {
  it("answers the employer's state account number like the state settings list does", async () => {
    await upsertStateTaxSetting(ctx, { state: 'NY', year: 2026, suiRate: '0.025', suiWageBase: '12000', accountNumber: '987654321' });
    const hidden = await stateWageWorksheet(masked, { state: 'NY', year: 2026, quarter: 1 });
    expect(hidden.accountNumber).toBe('••••4321');
    expect(hidden.accountNumber).toBe((await listStateTaxSettings(masked))[0].accountNumber);
    expect((await stateWageWorksheet(full, { state: 'NY', year: 2026, quarter: 1 })).accountNumber).toBe('987654321');
    expect((await stateWageWorksheet(ctx, { state: 'NY', year: 2026, quarter: 1 })).accountNumber).toBe('987654321');
  });
});
