/**
 * Review round 5 — accountant tools (each test failed before its fix):
 *  A  Reclassify Transactions changes the source document's rows, so it must move the document's
 *     version too: a bill / invoice / check someone had open before the reclassify is then
 *     refused as stale ("This record was changed by …") instead of silently re-posting the old
 *     account when it is saved.
 *  B  Fix Incorrectly Recorded Sales Tax: a double-submitted "count as a tax payment" posts the
 *     correcting entry once (the "already moved" check runs inside the transaction).
 *  C  Client Data Review's "Apply" fixes apply customer payments / credits and bill credits: they
 *     need the Customers / Vendors modify right like Receive Payments / Pay Bills (the route only
 *     guarantees Accounting).
 *  D  Voided/Deleted Transactions shows the number on the form (an invoice's typed number, a bill
 *     credit's Ref. No. — not its memo) and a one-time payee's name.
 *  E  Batch Enter never drops a class typed in the grid: bill credits keep it on their line; deposits
 *     and credit memos (whose lines keep no class) refuse it instead of saving without it.
 *  F  Voided/Deleted Transactions and Review List Changes filter WHEN something happened by the
 *     company's calendar day (Preferences time zone), not the UTC day.
 *  G  Client Data Review "Troubleshoot prior account balances" lists entries changed in place after
 *     the review (Reclassify Transactions), not only entries entered or voided after it — the
 *     balance comparison showed the change but nothing explained it. Changes that move no account
 *     balance (printing a check, a memo-only edit, a class-only reclassify) are not listed.
 *  H  Write Off Invoices shows and records the invoice number on the form (a typed ref number such
 *     as INV-1001), not the internal sequence number nobody sees elsewhere.
 *  I  Closing Date Exception report: each entry is checked against the closing date in effect when
 *     it was entered. Entries made while the period was open again (closing date moved back, then
 *     closed again) are not exceptions; an entry imported while January was closed stays one after
 *     February is closed and reopened; a password-only change moves nothing.
 *  J  Review List Changes hides reviewed changes before the row limit and counts every unreviewed
 *     change: 1,000 newer reviewed changes never hide an older unreviewed one, and the Accountant
 *     Center shows the true count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, expenses, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createInvoice } from '../invoices';
import { createBill } from '../bills';
import { createExpense } from '../expenses';
import { createTaxAgency } from '../salesTax';
import { assertCurrentVersion, currentVersion } from '../concurrency';
import { trialBalance } from '../reports';
import { reclassifyLines } from './reclassify';
import { findMisrecordedSalesTax, reclassifySalesTaxPayment } from './salesTaxTools';
import { autoApplyCustomerCredit, autoApplyVendorCredit, clientDataReview, takeReviewSnapshot } from './clientDataReview';
import { closingDateExceptionReport, voidedDeletedTransactions } from './auditReports';
import { setClosingDate } from '../company';
import { createManualEntry } from '../journal';
import { listWriteOffCandidates, writeOffInvoices } from './writeOff';
import { listListChanges } from './listChanges';
import { updateCompany } from '../company';
import { auditLogs } from '@/lib/db/schema';
import { batchEnterTransactions } from './batchEnter';
import { createClass } from '../dimensions';
import { vendorCreditLines } from '@/lib/db/schema';
import { voidInvoice } from '../invoices';
import { markExpensePrinted, updateExpense, voidExpense } from '../expenses';
import { receivePayment } from '../payments';
import { createVendorCredit, voidVendorCredit } from '../vendorCredits';
import { creditMemos, paymentsReceived } from '@/lib/db/schema';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-accountant');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

async function lineOn(table: typeof bills | typeof invoices | typeof expenses, id: string, accountId: string) {
  const [row] = await db.select({ e: table.postedEntryId }).from(table).where(eq(table.id, id));
  const lines = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, row.e!), eq(journalEntryLines.accountId, accountId)));
  return lines[0];
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-acct@test.local', name: 'Accountant', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 Accountant Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  acct.e1 = (await createAccount(ctx, { code: '6810', name: 'R5 Supplies', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.e2 = (await createAccount(ctx, { code: '6820', name: 'R5 Repairs', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.e3 = (await createAccount(ctx, { code: '6830', name: 'R5 Taxes & Licenses', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.i1 = (await createAccount(ctx, { code: '4810', name: 'R5 Consulting', type: 'revenue' as never, subtype: 'service_revenue' })).id;
  acct.i2 = (await createAccount(ctx, { code: '4820', name: 'R5 Other Sales', type: 'revenue' as never, subtype: 'sales' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'R5 Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'R5 Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('A: reclassify makes an open copy of the source document stale', () => {
  it('bill', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-03-02'),
      lines: [{ accountId: acct.e1, amount: '120.00', description: 'Paper' }],
    });
    const opened = await currentVersion(ctx, 'bill', bill.id);
    const line = await lineOn(bills, bill.id, acct.e1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.e2 });
    await expect(assertCurrentVersion(ctx, 'bill', bill.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('invoice', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-03'),
      lines: [{ description: 'Work', quantity: 1, rate: '300.00', accountId: acct.i1 }],
    });
    const opened = await currentVersion(ctx, 'invoice', inv.id);
    const line = await lineOn(invoices, inv.id, acct.i1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.i2 });
    await expect(assertCurrentVersion(ctx, 'invoice', inv.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('check', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-03-04'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e1, amount: '45.00' }],
    });
    const opened = await currentVersion(ctx, 'expense', exp.id);
    const line = await lineOn(expenses, exp.id, acct.e1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.e2 });
    await expect(assertCurrentVersion(ctx, 'expense', exp.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});

describe('B: Fix Incorrectly Recorded Sales Tax', () => {
  it('a double-submitted "count as a tax payment" posts one correcting entry', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'R5 State Revenue Dept' })).id;
    await createExpense(ctx, {
      payeeName: 'R5 State Revenue Dept',
      date: D('2026-04-15'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e3, amount: '210.00', description: 'Q1 sales tax' }],
    });
    const issue = (await findMisrecordedSalesTax(ctx)).find((i) => i.issue === 'expense_payment' && i.amount === '210.00');
    expect(issue).toBeDefined();
    await Promise.allSettled([
      reclassifySalesTaxPayment(ctx, { lineId: issue!.lineId, agencyId: agency }),
      reclassifySalesTaxPayment(ctx, { lineId: issue!.lineId, agencyId: agency }),
    ]);
    const fixes = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          like(journalEntries.reference, `fix-line:${issue!.lineId}`),
        ),
      );
    expect(fixes).toHaveLength(1);
  });
});

function accessWith(grant: PermissionGrant): EffectiveAccess {
  return {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

describe('C: Client Data Review is no side door around Customers / Vendors', () => {
  it('applying a customer payment needs Customers: modify; a bill credit needs Vendors: modify', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R5 Review Customer' })).id;
    await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-05-01'),
      lines: [{ description: 'Work', quantity: 1, rate: '100.00', accountId: acct.i1 }],
    });
    const pay = await receivePayment(ctx, { customerId: cust, date: D('2026-05-03'), method: 'check', amount: '100.00', applications: [] });
    const payId = pay.payment.id;
    const vend = (await createVendor(ctx, { displayName: 'R5 Review Vendor' })).id;
    await createBill(ctx, { vendorId: vend, date: D('2026-05-01'), lines: [{ accountId: acct.e1, amount: '60.00' }] });
    const credit = await createVendorCredit(ctx, { vendorId: vend, date: D('2026-05-02'), lines: [{ accountId: acct.e1, amount: '20.00' }] });

    // Accounting: full, but nothing in Customers / Vendors.
    const accountantOnly = { ...ctx, access: accessWith({ accounting: ['full'] }) };
    await expect(autoApplyCustomerCredit(accountantOnly, { refType: 'payment', refId: payId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(autoApplyVendorCredit(accountantOnly, { refId: credit.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [p] = await db.select({ unapplied: paymentsReceived.unapplied }).from(paymentsReceived).where(eq(paymentsReceived.id, payId));
    expect(p.unapplied).toBe('100.00');

    // With the area rights it works.
    const full = { ...ctx, access: accessWith({ accounting: ['full'], customers: ['full'], vendors: ['full'] }) };
    expect((await autoApplyCustomerCredit(full, { refType: 'payment', refId: payId })).applied).toBe('100.00');
    expect((await autoApplyVendorCredit(full, { refId: credit.id })).applied).toBe('20.00');
  });
});

describe('D: Voided/Deleted Transactions shows the number the user sees', () => {
  it('invoice ref number, bill credit ref number and the check payee', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      refNumber: 'INV-R5-77',
      date: D('2026-06-02'),
      lines: [{ description: 'Work', quantity: 1, rate: '50.00', accountId: acct.i1 }],
    });
    await voidInvoice(ctx, inv.id);
    const vc = await createVendorCredit(ctx, {
      vendorId,
      refNumber: 'VC-9001',
      memo: 'Returned damaged paper',
      date: D('2026-06-03'),
      lines: [{ accountId: acct.e1, amount: '15.00' }],
    });
    await voidVendorCredit(ctx, vc.id);
    const chk = await createExpense(ctx, {
      payeeName: 'R5 One-time Plumber',
      date: D('2026-06-04'),
      method: 'check',
      reference: '7001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e2, amount: '90.00' }],
    });
    await voidExpense(ctx, chk.id);

    const rep = await voidedDeletedTransactions(ctx);
    expect(rep.rows.find((r) => r.entityId === inv.id)).toMatchObject({ number: 'INV-R5-77', name: 'R5 Customer' });
    expect(rep.rows.find((r) => r.entityId === vc.id)).toMatchObject({ number: 'VC-9001', name: 'R5 Vendor' });
    expect(rep.rows.find((r) => r.entityId === chk.id)).toMatchObject({ number: '7001', name: 'R5 One-time Plumber' });
  });
});

describe('E: Batch Enter never drops a typed class', () => {
  it('bill credits keep the class; deposits and credit memos (no class on their lines) refuse one', async () => {
    const cls = await createClass(ctx, { name: 'R5 East' });
    const credit = await batchEnterTransactions(ctx, {
      type: 'bill_credit',
      rows: [{ date: '2026-06-10', ref: 'BC-R5', name: 'R5 Vendor', account: '6810', amount: '12.00', memo: 'Refund', className: 'R5 East' }],
    });
    expect(credit.rolledBack).toBe(false);
    const [vcl] = await db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, credit.results[0].id!));
    expect(vcl.classId).toBe(cls.id);

    const dep = await batchEnterTransactions(ctx, {
      type: 'deposit',
      bankAccountId: acct['1000'],
      rows: [{ date: '2026-06-11', name: 'Owner', account: '3000', amount: '50.00', className: 'R5 East' }],
    });
    expect(dep.saved).toBe(0);
    expect(dep.results[0].ok).toBe(false);
    expect(dep.results[0].errors.join(' ')).toMatch(/class/i);

    const cm = await batchEnterTransactions(ctx, {
      type: 'credit_memo',
      rows: [{ date: '2026-06-11', name: 'R5 Customer', account: '4810', amount: '5.00', className: 'R5 East' }],
    });
    expect(cm.saved).toBe(0);
    expect(cm.results[0].errors.join(' ')).toMatch(/class/i);
  });
});

describe('F: audit reports filter by the company calendar day', () => {
  it('a void at 9:30 pm New York time on Oct 26 is "on Oct 26", not Oct 27', async () => {
    await updateCompany(ctx, { settings: { timezone: 'America/New_York' } });
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-10-20'),
      lines: [{ description: 'Late void', quantity: 1, rate: '33.00', accountId: acct.i1 }],
    });
    await voidInvoice(ctx, inv.id);
    // 9:30 pm EDT on Oct 26 = 01:30 UTC on Oct 27.
    await db
      .update(auditLogs)
      .set({ createdAt: new Date('2026-10-27T01:30:00.000Z') })
      .where(and(eq(auditLogs.entityId, inv.id), eq(auditLogs.action, 'void')));
    const on26 = await voidedDeletedTransactions(ctx, { from: '2026-10-26', to: '2026-10-26' });
    expect(on26.rows.map((r) => r.entityId)).toContain(inv.id);
    const from27 = await voidedDeletedTransactions(ctx, { from: '2026-10-27' });
    expect(from27.rows.map((r) => r.entityId)).not.toContain(inv.id);

    // Review List Changes "changed since" follows the same calendar.
    const v = await createVendor(ctx, { displayName: 'R5 Evening Vendor' });
    await db.update(auditLogs).set({ createdAt: new Date('2026-10-27T02:00:00.000Z') }).where(eq(auditLogs.entityId, v.id));
    const since27 = await listListChanges(ctx, { since: '2026-10-27', includeReviewed: true });
    expect(since27.rows.map((r) => r.entityId)).not.toContain(v.id);
    const since26 = await listListChanges(ctx, { since: '2026-10-26', includeReviewed: true });
    expect(since26.rows.map((r) => r.entityId)).toContain(v.id);
  });
});

describe('G: Troubleshoot prior account balances lists entries changed in place', () => {
  it('a line reclassified after the review shows as the transaction behind the changed balances', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-01-15'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e1, amount: '64.00' }],
    });
    await takeReviewSnapshot(ctx, { asOf: '2026-01-31' });
    await new Promise((r) => setTimeout(r, 20));
    const line = await lineOn(expenses, exp.id, acct.e1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.e2 });

    const review = await clientDataReview(ctx);
    const compare = review.tasks.find((t) => t.key === 'compare_balances')!;
    expect(compare.issues.map((i) => i.id)).toEqual(expect.arrayContaining([`acct:${acct.e1}`, `acct:${acct.e2}`]));
    const prior = review.tasks.find((t) => t.key === 'prior_balances')!;
    const [row] = await db.select({ e: expenses.postedEntryId }).from(expenses).where(eq(expenses.id, exp.id));
    const hit = prior.issues.find((i) => i.id === `je:${row.e}`);
    expect(hit, 'the reclassified check is listed').toBeDefined();
    expect(hit!.title).toMatch(/changed after the last review/);
  });

  it('printing a check, a memo-only edit or a class-only reclassify after the review changes no reviewed balance', async () => {
    const queued = await createExpense(ctx, {
      vendorId,
      date: D('2026-01-15'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e1, amount: '41.00' }],
    });
    const memoInput = {
      vendorId,
      date: D('2026-01-16'),
      method: 'check' as const,
      reference: '5501',
      paymentAccountId: acct['1000'],
      memo: 'R5 original memo',
      lines: [{ accountId: acct.e1, amount: '17.00' }],
    };
    const memoCheck = await createExpense(ctx, memoInput);
    const classCheck = await createExpense(ctx, {
      vendorId,
      date: D('2026-01-17'),
      method: 'check',
      reference: '5502',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e1, amount: '23.00' }],
    });
    await takeReviewSnapshot(ctx, { asOf: '2026-01-31' });
    await new Promise((r) => setTimeout(r, 20));
    await markExpensePrinted(ctx, { expenseId: queued.id, checkNumber: '1234' });
    await updateExpense(ctx, memoCheck.id, { ...memoInput, memo: 'R5 memo fixed after the review' });
    const cls = await createClass(ctx, { name: 'R5 West' });
    await reclassifyLines(ctx, { lineIds: [(await lineOn(expenses, classCheck.id, acct.e1)).id], newClassId: cls.id });

    const review = await clientDataReview(ctx);
    expect(review.tasks.find((t) => t.key === 'compare_balances')!.issues).toEqual([]);
    const prior = review.tasks.find((t) => t.key === 'prior_balances')!;
    const entryIds = await db
      .select({ e: expenses.postedEntryId })
      .from(expenses)
      .where(inArray(expenses.id, [queued.id, memoCheck.id, classCheck.id]));
    expect(entryIds).toHaveLength(3);
    for (const { e } of entryIds) expect(prior.issues.map((i) => i.id)).not.toContain(`je:${e}`);
  });
});

describe('H: Write Off Invoices names invoices by the number on the form', () => {
  it('the candidate list, the credit memo and the messages use the typed invoice number', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R5 Bad Payer' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      refNumber: 'INV-R5-901',
      date: D('2026-01-10'),
      dueDate: D('2026-02-09'),
      lines: [{ description: 'Old work', quantity: 1, rate: '80.00', accountId: acct.i1 }],
    });
    const cands = await listWriteOffCandidates(ctx, { asOf: D('2026-09-30'), customerId: cust });
    expect(cands.find((c) => c.invoiceId === inv.id)).toMatchObject({ number: 'INV-R5-901' });
    const res = await writeOffInvoices(ctx, { invoiceIds: [inv.id], date: D('2026-09-30'), badDebtAccountId: acct.e3 });
    expect(res.results[0]).toMatchObject({ number: 'INV-R5-901' });
    const [memo] = await db.select({ memo: creditMemos.memo }).from(creditMemos).where(eq(creditMemos.id, res.results[0].creditMemoId));
    expect(memo.memo).toContain('INV-R5-901');
    // Writing it off again: the refusal names the invoice the same way.
    await expect(writeOffInvoices(ctx, { invoiceIds: [inv.id], date: D('2026-09-30'), badDebtAccountId: acct.e3 })).rejects.toThrow(/INV-R5-901/);
  });
});

describe('I: Closing Date Exception report after reopening the period', () => {
  it('measures "entered after close" from the last time the books were closed on that date', async () => {
    await setClosingDate(ctx, { closingDate: '2025-01-31' });
    await new Promise((r) => setTimeout(r, 15));
    // Reopen January to fix it, post the fix, then close January again.
    await setClosingDate(ctx, { closingDate: '2024-12-31' });
    const fix = await createManualEntry(ctx, {
      date: D('2025-01-15'),
      description: 'R5 January fix while open',
      lines: [
        { accountId: acct.e1, debit: '12.00' },
        { accountId: acct['1000'], credit: '12.00' },
      ],
    });
    await new Promise((r) => setTimeout(r, 15));
    await setClosingDate(ctx, { closingDate: '2025-01-31' });
    await new Promise((r) => setTimeout(r, 15));
    // A late entry slipped in after the re-close (e.g. an import), then only the password changed.
    const late = await createManualEntry({ ...ctx, closingDateOverride: true }, {
      date: D('2025-01-20'),
      description: 'R5 late January entry',
      lines: [
        { accountId: acct.e1, debit: '7.00' },
        { accountId: acct['1000'], credit: '7.00' },
      ],
    });
    await new Promise((r) => setTimeout(r, 15));
    await setClosingDate(ctx, { closingDate: '2025-01-31', password: 'r5-close' });

    const rows = (await closingDateExceptionReport(ctx)).rows;
    expect(rows.filter((r) => r.entryId === fix.id)).toEqual([]);
    expect(rows.some((r) => r.entryId === late.id)).toBe(true);
    await setClosingDate(ctx, { closingDate: null });
  });
});
describe('I: Closing Date Exception report when the closing date moves forward and back', () => {
  /** An entry written straight into the ledger (like a QuickBooks GL import): no override row. */
  async function importEntry(n: number, day: string): Promise<string> {
    const res = await db.execute(sql`
      WITH e AS (
        INSERT INTO journal_entries (company_id, entry_number, date, description, status, source_ref, created_by)
        VALUES (${ctx.companyId}::uuid, ${n}, ${`${day}T12:00:00Z`}::timestamp, ${`R5 imported ${day}`}, 'posted', ${`qbgl:r5-${n}`}, ${ctx.userId}::uuid)
        RETURNING id
      ), l AS (
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        SELECT id, ${acct.e1}::uuid, 3.00, NULL FROM e
        UNION ALL
        SELECT id, ${acct['1000']}::uuid, NULL, 3.00 FROM e
      )
      SELECT id FROM e`);
    return (res.rows[0] as { id: string }).id;
  }

  it('an entry imported while January was closed stays listed after February is closed and reopened', async () => {
    const pause = () => new Promise((r) => setTimeout(r, 15));
    const before = await importEntry(970001, '2025-01-05'); // before any closing date: not an exception
    await pause();
    await setClosingDate(ctx, { closingDate: '2025-01-31' });
    await pause();
    const jan = await importEntry(970002, '2025-01-10');
    await pause();
    expect((await closingDateExceptionReport(ctx)).rows.filter((r) => r.entryId === jan)).toHaveLength(1);

    await setClosingDate(ctx, { closingDate: '2025-02-28' }); // close February
    await pause();
    const feb = await importEntry(970003, '2025-02-10'); // into February while it was closed
    await pause();
    await setClosingDate(ctx, { closingDate: '2025-01-31' }); // reopen February only
    await pause();

    const rows = (await closingDateExceptionReport(ctx)).rows;
    const late = rows.filter((r) => r.source === 'entered_after_close').map((r) => r.entryId);
    expect(late, 'January was closed the whole time').toContain(jan);
    expect(late, 'dated after the current closing date').not.toContain(feb);
    expect(late, 'entered before the books were ever closed').not.toContain(before);
    expect(rows.find((r) => r.entryId === jan)).toMatchObject({ closingDate: '2025-01-31', transactionDate: '2025-01-10' });
    await setClosingDate(ctx, { closingDate: null });
  });
});

describe('J: Review List Changes never hides older unreviewed changes behind reviewed ones', () => {
  it('an old unreviewed vendor change is shown and counted when the newest 1,000 are reviewed', async () => {
    // Its own company: the other tests' list changes stay out of the counts.
    const [u] = await db.insert(users).values({ email: 'r5-acct-j@test.local', name: 'Accountant J', passwordHash: 'x' }).returning();
    const co = await createCompany(db, { name: 'Review5 List Changes Co', ownerId: u.id });
    const jctx: ServiceContext = { db, companyId: co.id, userId: u.id };
    const v = await createVendor(jctx, { displayName: 'R5 Old Vendor' });
    await db.update(auditLogs).set({ createdAt: new Date('2020-03-02T15:00:00Z') }).where(and(eq(auditLogs.companyId, co.id), eq(auditLogs.entityId, v.id)));
    // 1,000 newer vendor changes (a large QuickBooks conversion), all already reviewed.
    await db.execute(sql`
      WITH a AS (
        INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, new_values, created_at)
        SELECT ${co.id}::uuid, ${u.id}::uuid, 'create', 'vendor', gen_random_uuid(),
               jsonb_build_object('displayName', 'Imported vendor ' || g), now() - (g || ' minutes')::interval
        FROM generate_series(1, 1000) AS g
        RETURNING id
      )
      INSERT INTO list_change_reviews (company_id, audit_log_id, reviewed_by)
      SELECT ${co.id}::uuid, id, ${u.id}::uuid FROM a`);

    const open = await listListChanges(jctx, { includeReviewed: false });
    expect(open.rows.map((r) => r.entityId)).toEqual([v.id]);
    expect(open.unreviewed).toBe(1);
    // With reviewed rows shown the window is the newest 1,000, but the count is still complete.
    const all = await listListChanges(jctx, { includeReviewed: true });
    expect(all.rows).toHaveLength(1000);
    expect(all.unreviewed).toBe(1);
    const { accountantCenterSummary } = await import('./accountantCenter');
    expect((await accountantCenterSummary(jctx)).unreviewedListChanges).toBe(1);
  }, 120_000);
});
