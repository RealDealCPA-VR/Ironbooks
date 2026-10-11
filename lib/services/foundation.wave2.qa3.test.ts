/**
 * Wave-2 GL foundation — independent QA, round 3 (re-test after fix round 1).
 *
 * The fix round added: unapplied customer payments as A/R subledger credits (customerCredits.ts)
 * in aging / balance summary / integrity; name re-pointing on customer/vendor merge; QB-type
 * merge guard; names on AI proposals; typed document numbers through every create path.
 * These tests attack those fixes:
 *  - I11: overpayment / refund / void of an unapplied payment keep A/R aging, aging detail,
 *    customer balance summary, statements and the integrity check equal to the A/R GL
 *    (as of dates before and after each event).
 *  - I11: merging a customer that holds an unapplied payment + a GJ charge.
 *  - I11: AI proposal names must resolve to the right kind of name in THIS company, and a
 *    proposal approved after its customer was merged away must not post to the merged-away name.
 *  - A3: typed numbers on every document type, per-type duplicates, zod limits, concurrent
 *    saves, and the typed number (not the legacy integer) shown on aging detail / statements.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { createManualEntry } from './journal';
import { arAging, arAgingDetail } from './reportsExtra';
import { trialBalance } from './reports';
import { mergeCustomers } from './merge';
import { approveProposal, createJournalProposal } from './aiAssistant';
import { receivePayment, refundPayment, voidPayment } from './payments';
import { createInvoice } from './invoices';
import { createEstimate } from './estimates';
import { createSalesOrder } from './salesOrders';
import { createSalesReceipt } from './salesReceipts';
import { createCreditMemo } from './creditMemos';
import { createPurchaseOrder } from './purchaseOrders';
import { customerStatement } from './statements';
import { verifyIntegrity } from './integrity';
import { createInvoiceBodySchema } from '@/lib/validation/invoices';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa3');

let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const code: Record<string, string> = {};

async function idByCode(c: string, company = ctx) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, company.companyId), eq(accounts.code, c)));
  return row?.id;
}

/** Natural balance of all A/R accounts from the posted GL, as of a date. */
async function arControl(asOf: Date, c = ctx): Promise<number> {
  const tb = await trialBalance(c, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(eq(accounts.companyId, c.companyId), eq(accounts.type, 'asset'), sql`${accounts.subtype} = 'accounts_receivable'`),
        )
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round(total * 100) / 100;
}

async function arGap(asOf: Date, c = ctx): Promise<number> {
  const ar = await arAging(c, asOf);
  return Math.round(((await arControl(asOf, c)) - Number(ar.totals.total)) * 100) / 100;
}

async function custTotal(asOf: Date, id: string): Promise<number> {
  const ar = await arAging(ctx, asOf);
  return Number(ar.rows.find((r) => r.id === id)?.total ?? 0);
}

const LINE = [{ quantity: 1, rate: '100.00' }];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa3@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA3 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const company2 = await createCompany(db, { name: 'Foundation QA3 Other Co', ownerId: user.id });
  other = { db, companyId: company2.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '4000', '6000']) code[c] = (await idByCode(c))!;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I11 — unapplied customer payments are A/R subledger credits
// ---------------------------------------------------------------------------

describe('QA3: unapplied payments keep every A/R view equal to the GL', () => {
  it('overpayment, then a refund: aging ties to the GL before, between and after', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Overpayer' })).id;
    const d0 = new Date(2026, 0, 31);
    const d1 = new Date(2026, 1, 15);
    const d2 = new Date(2026, 2, 31);
    const g = [await arGap(d0), await arGap(d1), await arGap(d2)];
    const inv = await createInvoice(ctx, { customerId: cust, date: new Date(2026, 0, 10), lines: LINE });
    const pmt = await receivePayment(ctx, {
      customerId: cust,
      date: new Date(2026, 0, 20),
      method: 'check',
      amount: '130.00',
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    // Customer holds a 30.00 credit after the overpayment.
    expect(await custTotal(d0, cust)).toBeCloseTo(-30, 2);
    await refundPayment(ctx, {
      paymentId: pmt.payment.id,
      bankAccountId: code['1000'],
      amount: '30.00',
      date: new Date(2026, 2, 1),
    });
    // As of mid-February the refund had not happened: the credit is still there.
    expect(await custTotal(d1, cust)).toBeCloseTo(-30, 2);
    expect(await custTotal(d2, cust)).toBeCloseTo(0, 2);
    expect(await arGap(d0)).toBeCloseTo(g[0], 2);
    expect(await arGap(d1)).toBeCloseTo(g[1], 2);
    expect(await arGap(d2)).toBeCloseTo(g[2], 2);
  });

  it('voiding an unapplied payment removes its credit from aging at every date', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Voided Payer' })).id;
    const d = new Date(2026, 3, 30);
    const g0 = await arGap(d);
    const pmt = await receivePayment(ctx, {
      customerId: cust,
      date: new Date(2026, 3, 5),
      method: 'cash',
      amount: '40.00',
      applications: [],
    });
    expect(await custTotal(d, cust)).toBeCloseTo(-40, 2);
    expect(await arGap(d)).toBeCloseTo(g0, 2);
    await voidPayment(ctx, pmt.payment.id);
    expect(await custTotal(d, cust)).toBeCloseTo(0, 2);
    expect(await arGap(d)).toBeCloseTo(g0, 2);
  });

  it('aging detail, balance summary and statement agree with aging for a mixed customer', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Mixed Customer' })).id;
    const d = new Date(2026, 4, 31);
    const inv = await createInvoice(ctx, { customerId: cust, date: new Date(2026, 4, 1), lines: LINE });
    await createManualEntry(ctx, {
      date: new Date(2026, 4, 2),
      description: 'QA3 GJ charge',
      lines: [
        { accountId: code['1200'], debit: '25.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '25.00' },
      ],
    });
    await receivePayment(ctx, {
      customerId: cust,
      date: new Date(2026, 4, 3),
      method: 'check',
      amount: '160.00',
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    // Owes 100 + 25 - 160 = -35 (a credit).
    expect(await custTotal(d, cust)).toBeCloseTo(-35, 2);

    const detail = await arAgingDetail(ctx, d);
    const mine = detail.rows.filter((r) => r.entityId === cust);
    const detailSum = mine.reduce((s, r) => s + Number(r.openBalance), 0);
    expect(detailSum).toBeCloseTo(-35, 2);
    expect(Number(detail.total)).toBeCloseTo(Number((await arAging(ctx, d)).totals.total), 2);

    const summary = await customerBalanceSummary(ctx);
    expect(Number(summary.find((r) => r.customerId === cust)?.totalBalanceDue ?? NaN)).toBeCloseTo(-35, 2);

    const stmt = await customerStatement(ctx, cust);
    expect(Number(stmt.closingBalance)).toBeCloseTo(-35, 2);
  });

  it('the A/R integrity check passes with an overpayment and a GJ-only balance paid by Receive Payments', async () => {
    // Fresh company so the check sees only these postings.
    const c = other;
    const ar = (await idByCode('1200', c))!;
    const inc = (await idByCode('4000', c))!;
    const cust = (await createCustomer(c, { displayName: 'QA3 Integrity Customer' })).id;
    const inv = await createInvoice(c, { customerId: cust, date: new Date(2026, 5, 1), lines: LINE });
    await receivePayment(c, {
      customerId: cust,
      date: new Date(2026, 5, 2),
      method: 'check',
      amount: '120.00',
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    await createManualEntry(c, {
      date: new Date(2026, 5, 3),
      description: 'QA3 GJ charge (other co)',
      lines: [
        { accountId: ar, debit: '50.00', entityType: 'customer', entityId: cust },
        { accountId: inc, credit: '50.00' },
      ],
    });
    await receivePayment(c, {
      customerId: cust,
      date: new Date(2026, 5, 4),
      method: 'check',
      amount: '30.00',
      applications: [],
    });
    const res = await verifyIntegrity(c);
    const arCheck = res.checks.find((k) => /A\/R/i.test(k.name));
    expect(arCheck?.ok, arCheck?.detail).toBe(true);
    expect(await arGap(new Date(2026, 11, 31), c)).toBeCloseTo(0, 2);
  });

  it('merging a customer with an unapplied payment and a GJ charge moves both, aging still ties', async () => {
    const dup = (await createCustomer(ctx, { displayName: 'QA3 Merge Dup' })).id;
    const keep = (await createCustomer(ctx, { displayName: 'QA3 Merge Keep' })).id;
    const d = new Date(2026, 6, 31);
    const g0 = await arGap(d);
    await createManualEntry(ctx, {
      date: new Date(2026, 6, 1),
      description: 'QA3 GJ charge on dup',
      lines: [
        { accountId: code['1200'], debit: '70.00', entityType: 'customer', entityId: dup },
        { accountId: code['4000'], credit: '70.00' },
      ],
    });
    await receivePayment(ctx, {
      customerId: dup,
      date: new Date(2026, 6, 2),
      method: 'check',
      amount: '90.00',
      applications: [],
    });
    await mergeCustomers(ctx, { fromId: dup, toId: keep });
    const ar = await arAging(ctx, d);
    expect(ar.rows.find((r) => r.id === dup)).toBeUndefined();
    expect(Number(ar.rows.find((r) => r.id === keep)?.total ?? NaN)).toBeCloseTo(-20, 2);
    expect(await arGap(d)).toBeCloseTo(g0, 2);
  });
});

// ---------------------------------------------------------------------------
// I11 — names on AI proposals
// ---------------------------------------------------------------------------

describe('QA3: AI proposal names', () => {
  const arProposal = (name: string, amount = '45.00') => ({
    type: 'journal_entry',
    date: '2026-08-10',
    description: 'QA3 AI fee',
    lines: [
      { accountCode: '1200', debit: amount, name },
      { accountCode: '4000', credit: amount },
    ],
  });

  it('an A/R line naming a vendor (not a customer) is refused when the proposal is stored', async () => {
    await createVendor(ctx, { displayName: 'QA3 Only A Vendor' });
    await expect(createJournalProposal(ctx, arProposal('QA3 Only A Vendor'))).rejects.toMatchObject({
      name: 'ServiceError',
    });
  });

  it('an A/P line naming a customer (not a vendor) is refused', async () => {
    await createCustomer(ctx, { displayName: 'QA3 Only A Customer' });
    await expect(
      createJournalProposal(ctx, {
        type: 'journal_entry',
        date: '2026-08-10',
        description: 'QA3 AI accrual',
        lines: [
          { accountCode: '6000', debit: '10.00' },
          { accountCode: '2000', credit: '10.00', name: 'QA3 Only A Customer' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'ServiceError' });
  });

  it('a name that exists only in another company is refused (tenancy)', async () => {
    await createCustomer(other, { displayName: 'QA3 Other Company Customer' });
    await expect(createJournalProposal(ctx, arProposal('QA3 Other Company Customer'))).rejects.toMatchObject({
      name: 'ServiceError',
    });
  });

  it('a proposal approved after its customer was merged away does not post to the merged-away name', async () => {
    const dup = (await createCustomer(ctx, { displayName: 'QA3 AI Dup' })).id;
    const keep = (await createCustomer(ctx, { displayName: 'QA3 AI Keep' })).id;
    const d = new Date(2026, 11, 31);
    const g0 = await arGap(d);
    const proposal = await createJournalProposal(ctx, arProposal('QA3 AI Dup', '33.00'));
    await mergeCustomers(ctx, { fromId: dup, toId: keep });
    let posted = true;
    try {
      await approveProposal(ctx, proposal.id);
    } catch {
      posted = false; // refusing is acceptable too
    }
    expect(await arGap(d)).toBeCloseTo(g0, 2);
    if (posted) {
      // The merged-away customer is gone; its new open item must belong to the survivor.
      const ar = await arAging(ctx, d);
      expect(ar.rows.find((r) => r.id === dup)).toBeUndefined();
      expect(Number(ar.rows.find((r) => r.id === keep)?.total ?? NaN)).toBeCloseTo(33, 2);
    }
    const onDup = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.entityType, 'customer'), eq(journalEntryLines.entityId, dup)));
    expect(onDup).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — typed document numbers end to end
// ---------------------------------------------------------------------------

describe('QA3: typed document numbers on every document type', () => {
  it('each create path stores the typed number, refuses a same-type duplicate, allows it across types', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Doc Customer' })).id;
    const vend = (await createVendor(ctx, { displayName: 'QA3 Doc Vendor' })).id;
    const date = new Date(2026, 8, 1);
    const makers: Array<[string, (ref: string) => Promise<{ refNumber: string | null }>]> = [
      ['estimate', (ref) => createEstimate(ctx, { customerId: cust, date, refNumber: ref, lines: LINE })],
      ['sales_order', (ref) => createSalesOrder(ctx, { customerId: cust, date, refNumber: ref, lines: LINE })],
      [
        'sales_receipt',
        (ref) =>
          createSalesReceipt(ctx, { customerId: cust, date, refNumber: ref, depositAccountId: code['1000'], lines: LINE }),
      ],
      ['credit_memo', (ref) => createCreditMemo(ctx, { customerId: cust, date, refNumber: ref, lines: LINE })],
      [
        'purchase_order',
        (ref) =>
          createPurchaseOrder(ctx, {
            vendorId: vend,
            date,
            refNumber: ref,
            lines: [{ accountId: code['6000'], quantity: '1', rate: '5.00' }],
          }),
      ],
    ];
    for (const [type, make] of makers) {
      // Same number on every type: allowed (each type has its own sequence).
      const doc = await make('QA3-77');
      expect(doc.refNumber, type).toBe('QA3-77');
      // Same type, different case: refused with a CONFLICT the form turns into a confirm.
      await expect(make('qa3-77'), type).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('API body schema rejects over-long and non-text document numbers', () => {
    const base = { customerId: '00000000-0000-4000-8000-000000000000', date: '2026-01-15', lines: LINE };
    expect(createInvoiceBodySchema.safeParse({ ...base, refNumber: 'X'.repeat(51) }).success).toBe(false);
    expect(createInvoiceBodySchema.safeParse({ ...base, refNumber: 1001 }).success).toBe(false);
    expect(createInvoiceBodySchema.safeParse({ ...base, refNumber: 'INV-1001' }).success).toBe(true);
  });

  it('control characters in a typed number are refused and leave no document or posting behind', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Ctrl Char Customer' })).id;
    const before = await arControl(new Date(2027, 11, 31));
    await expect(
      createInvoice(ctx, { customerId: cust, date: new Date(2026, 8, 2), refNumber: 'INV\u0007BELL', lines: LINE }),
    ).rejects.toMatchObject({ name: 'ServiceError' });
    expect(await arControl(new Date(2027, 11, 31))).toBeCloseTo(before, 2);
  });

  it('two concurrent saves with the same typed number: exactly one wins', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Race Customer' })).id;
    const mk = () => createInvoice(ctx, { customerId: cust, date: new Date(2026, 8, 3), refNumber: 'RACE-1', lines: LINE });
    const results = await Promise.allSettled([mk(), mk()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('A/R aging detail and the customer statement show the typed number, not the legacy integer', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA3 Typed Number Customer' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date(2026, 8, 4),
      refNumber: 'JOB-ALPHA',
      lines: LINE,
    });
    expect(inv.refNumber).toBe('JOB-ALPHA');
    const detail = await arAgingDetail(ctx, new Date(2026, 11, 31));
    const row = detail.rows.find((r) => r.docId === inv.id);
    expect(row?.docNumber).toContain('JOB-ALPHA');
    const stmt = await customerStatement(ctx, cust);
    expect(stmt.lines.find((l) => l.type === 'invoice')?.ref).toBe('JOB-ALPHA');
  });
});
