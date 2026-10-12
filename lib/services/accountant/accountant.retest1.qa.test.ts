/**
 * Independent QA — re-test of accountant fix round 1 (98aed22). Adversarial checks of the fixes:
 *   D7 cash basis with credit memos (partial credits + payments across periods, one memo spread
 *      over several invoices, penny rounding over three settlements), cash total == accrual total
 *      once everything is settled; the "historic" liability-account scope never pulls in a bank.
 *   D8 every sub-ledger control account (incl. user-created A/R / credit card / bank) refused.
 *   I8 WTB with a non-calendar fiscal year, after a real year-end close (no double count), and
 *      tied to the balance sheet (prior-years earnings / current-year net income).
 *   I5/I6 per-area permissions never partially apply; Pay Sales Tax void needs Sales Tax rights;
 *      journal amounts listed correctly.
 *   I2 orphaned-correction undo guards; closed-period orphan left in place and still listed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, creditMemos, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate, updateCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createInvoice } from '../invoices';
import { createExpense, voidExpense } from '../expenses';
import { applyToInvoice, createCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { postJournalEntry } from '../posting';
import { balanceSheet, trialBalance } from '../reports';
import { yearEndClose } from '../fiscalClose';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { paySalesTax } from '../liabilityPayments';
import { emptyPermissionSet, type Area, type EffectiveAccess } from '@/lib/permissions/model';
import { salesTaxLiabilityAccounts, salesTaxLiabilityReport } from './salesTaxLedger';
import {
  createSalesTaxAdjustment,
  findMisrecordedSalesTax,
  reclassifySalesTaxPayment,
  undoOrphanedSalesTaxFix,
} from './salesTaxTools';
import { workingTrialBalance } from './workingTrialBalance';
import { batchEnterTransactions } from './batchEnter';
import { batchVoidTransactions, listBatchTransactions } from './batchVoid';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-retest1');
let db: DB;
let userId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const cents = (v: string | number) => Math.round(Number(v) * 100);

function only(areas: Partial<Record<Area, Array<'view' | 'create' | 'modify' | 'delete' | 'print'>>>): EffectiveAccess {
  const permissions = emptyPermissionSet();
  for (const [k, v] of Object.entries(areas)) (permissions as Record<string, string[]>)[k] = v as string[];
  return {
    roleKeys: ['retest'],
    permissions,
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

async function newCompany(name: string): Promise<{ ctx: ServiceContext; acct: Record<string, string> }> {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

async function expectBalanced(ctx: ServiceContext) {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

/** Net tax (collected + credited) for one agency on a report. */
function net(r: Awaited<ReturnType<typeof salesTaxLiabilityReport>>, agencyId: string): number {
  const a = r.agencies.find((x) => x.agencyId === agencyId);
  return a ? cents(a.collected) + cents(a.credited) : 0;
}

describe('wave2 accountant — re-test of fix round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-retest@test.local', name: 'Retester', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===================================================================== D7 cash basis
  describe('D7 cash basis with credit memos', () => {
    let ctx: ServiceContext;
    let acct: Record<string, string>;
    let agency: string;
    let rate: string;

    beforeAll(async () => {
      ({ ctx, acct } = await newCompany('Retest Cash Basis Co'));
      agency = (await createTaxAgency(ctx, { name: 'Retest County' })).id;
      rate = (await createTaxRate(ctx, { name: 'Retest 5%', rate: '0.05', agencyId: agency })).id;
    });

    it('partial credit memo + later payment: each month is right and cash total == accrual total', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Partial Credit Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-03-02'),
        taxRateId: rate,
        lines: [{ description: 'Goods', quantity: 1, rate: '100' }],
      }); // 105.00, tax 5.00
      const memo = await createCreditMemo(ctx, {
        customerId: cust,
        date: d('2026-03-05'),
        taxRateId: rate,
        lines: [{ description: 'Half returned', quantity: 1, rate: '50' }],
      }); // 52.50, tax 2.50
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '52.50' });
      await receivePayment(ctx, {
        customerId: cust,
        date: d('2026-04-10'),
        method: 'check',
        amount: '52.50',
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '52.50' }],
      });

      const march = await salesTaxLiabilityReport(ctx, { from: d('2026-03-01'), to: eod('2026-03-31'), basis: 'cash' });
      const april = await salesTaxLiabilityReport(ctx, { from: d('2026-04-01'), to: eod('2026-04-30'), basis: 'cash' });
      // March: half the invoice is settled by the credit (2.50 tax) and the memo credits 2.50 → 0.
      expect(net(march, agency)).toBe(0);
      // April: the cash payment settles the other half → 2.50.
      expect(net(april, agency)).toBe(250);

      const full = { from: d('2026-03-01'), to: eod('2026-04-30') };
      const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
      const accrual = await salesTaxLiabilityReport(ctx, full);
      expect(net(cash, agency)).toBe(net(accrual, agency));
      expect(net(accrual, agency)).toBe(250);
      // Idempotent: running the cash report again gives the same figures.
      const again = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
      expect(again.totals).toEqual(cash.totals);
      await expectBalanced(ctx);
    });

    it('one credit memo spread over two invoices settles both; cash total == accrual total', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Split Credit Cust' })).id;
      const inv1 = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-05-03'),
        taxRateId: rate,
        lines: [{ description: 'A', quantity: 1, rate: '40' }],
      }); // 42.00 (tax 2.00)
      const inv2 = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-06-03'),
        taxRateId: rate,
        lines: [{ description: 'B', quantity: 1, rate: '60' }],
      }); // 63.00 (tax 3.00)
      const memo = await createCreditMemo(ctx, {
        customerId: cust,
        date: d('2026-05-20'),
        taxRateId: rate,
        lines: [{ description: 'Credit', quantity: 1, rate: '100' }],
      }); // 105.00 (tax 5.00)
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv1.id, amount: '42.00' });
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv2.id, amount: '63.00' });
      for (const id of [inv1.id, inv2.id]) {
        const [i] = await db.select().from(invoices).where(eq(invoices.id, id));
        expect(i.balanceDue).toBe('0.00');
      }
      const full = { from: d('2026-05-01'), to: eod('2026-06-30') };
      const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
      const accrual = await salesTaxLiabilityReport(ctx, full);
      expect(net(accrual, agency)).toBe(0);
      expect(net(cash, agency)).toBe(0);
    });

    it('three one-third settlements (payment, payment, credit) recognize exactly 5.00 of invoice tax', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Thirds Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-07-01'),
        taxRateId: rate,
        lines: [{ description: 'Thirds', quantity: 1, rate: '100' }],
      }); // 105.00, tax 5.00
      for (const [date, amt] of [['2026-07-15', '35.00'], ['2026-08-15', '35.00']] as const) {
        await receivePayment(ctx, {
          customerId: cust,
          date: d(date),
          method: 'check',
          amount: amt,
          depositAccountId: acct['1000'],
          applications: [{ invoiceId: inv.id, amountApplied: amt }],
        });
      }
      const memo = await createCreditMemo(ctx, {
        customerId: cust,
        date: d('2026-09-15'),
        taxRateId: rate,
        lines: [{ description: 'Final third', quantity: 1, rate: '33.33' }],
      }); // 33.33 + 1.67 = 35.00
      const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id));
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: m.total });
      const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(i.balanceDue).toBe('0.00');

      const months = ['07', '08', '09'].map((mm) => ({
        from: d(`2026-${mm}-01`),
        to: eod(`2026-${mm}-${mm === '09' ? '30' : '31'}`),
        basis: 'cash' as const,
      }));
      const collected = await Promise.all(
        months.map(async (r) => cents((await salesTaxLiabilityReport(ctx, r)).agencies.find((a) => a.agencyId === agency)?.collected ?? 0)),
      );
      // Each month recognizes about a third; the three must add up to the invoice's 5.00 exactly.
      for (const c of collected) expect(Math.abs(c - 167)).toBeLessThanOrEqual(1);
      // Bug: each settlement share is rounded on its own (1.67 x 3 = 5.01), so cash basis
      // over-reports tax on a fully settled invoice. Shares must be allocated cumulatively.
      expect(collected.reduce((s, c) => s + c, 0)).toBe(500);
      const full = { from: d('2026-07-01'), to: eod('2026-09-30') };
      const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
      const accrual = await salesTaxLiabilityReport(ctx, full);
      expect(net(cash, agency)).toBe(net(accrual, agency));
    });

    it('the historic liability-account scope never pulls in the bank a tax payment was drawn on', async () => {
      await paySalesTax(ctx, { agencyId: agency, amount: '2.50', paymentAccountId: acct['1000'], date: d('2026-10-05') });
      await paySalesTax(ctx, { agencyId: agency, amount: '1.00', paymentAccountId: acct['2100'], date: d('2026-10-06') });
      const scope = (await salesTaxLiabilityAccounts(ctx)).map((a) => a.id);
      expect(scope).not.toContain(acct['1000']);
      expect(scope).not.toContain(acct['2100']);
      const rep = await salesTaxLiabilityReport(ctx);
      expect(rep.tiesToGl).toBe(true);
      await expectBalanced(ctx);
    });
  });

  // ===================================================================== D8
  describe('D8 adjustment refuses every sub-ledger control account', () => {
    it('A/R, A/P, credit card, Undeposited Funds, inventory, payroll and user-created control accounts are refused', async () => {
      const { ctx, acct } = await newCompany('Retest D8 Co');
      const agency = (await createTaxAgency(ctx, { name: 'D8 Agency' })).id;
      const extraAr = await createAccount(ctx, { code: '1210', name: 'A/R - Second', type: 'asset' as never, subtype: 'accounts_receivable' });
      const extraCc = await createAccount(ctx, { code: '2110', name: 'Amex', type: 'liability' as never, subtype: 'credit_card' });
      const extraAp = await createAccount(ctx, { code: '2010', name: 'A/P - Second', type: 'liability' as never, subtype: 'accounts_payable' });
      const base = {
        date: d('2026-05-10'),
        agencyId: agency,
        amount: '1.00',
        direction: 'reduce' as const,
        reason: 'rounding' as const,
      };
      const refused = [
        acct['1000'],
        acct['1010'],
        acct['1050'],
        acct['1200'],
        acct['1250'],
        acct['1300'],
        acct['2000'],
        acct['2100'],
        acct['2300'],
        extraAr.id,
        extraCc.id,
        extraAp.id,
      ];
      const entriesBefore = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      for (const id of refused) {
        await expect(createSalesTaxAdjustment(ctx, { ...base, adjustmentAccountId: id })).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      }
      const entriesAfter = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      expect(entriesAfter).toBe(entriesBefore);
      // Ordinary income / expense accounts still work.
      await createSalesTaxAdjustment(ctx, { ...base, adjustmentAccountId: acct['6700'], direction: 'increase' as never, reason: 'penalty' as never });
      await createSalesTaxAdjustment(ctx, { ...base, adjustmentAccountId: acct['4900'] });
      const rep = await salesTaxLiabilityReport(ctx);
      expect(rep.tiesToGl).toBe(true);
      await expectBalanced(ctx);
    });
  });

  // ===================================================================== I8
  describe('I8 Working Trial Balance across fiscal years', () => {
    it('non-calendar fiscal year (ends 06-30): P&L restarts on July 1 and ties to the balance sheet', async () => {
      const { ctx, acct } = await newCompany('Retest FY June Co');
      await updateCompany(ctx, { settings: { fiscalYearEnd: '06-30' } });
      const je = (date: string, dr: string, cr: string, amt: string) =>
        postJournalEntry(ctx, {
          date: d(date),
          description: `${date} ${dr}/${cr}`,
          lines: [
            { accountId: acct[dr], debit: amt },
            { accountId: acct[cr], credit: amt },
          ],
        });
      await je('2024-03-10', '1000', '4100', '1000.00'); // FY ending 2024-06-30
      await je('2024-05-10', '6400', '1000', '250.00'); // FY ending 2024-06-30 → prior profit 750
      await je('2024-08-10', '1000', '4100', '400.00'); // FY2025, before the period
      await je('2024-09-10', '6600', '1000', '100.00'); // FY2025, before the period
      await je('2024-10-10', '1000', '4100', '60.00'); // inside the period
      await je('2024-10-12', '3000', '1000', '20.00'); // owner draw inside the period

      const w = await workingTrialBalance(ctx, { from: d('2024-10-01'), to: eod('2024-10-31') });
      expect(w.fiscalYearStart).toBe('2024-07-01');
      expect(w.balanced).toBe(true);
      expect(w.totals.beginning).toBe('0.00');
      expect(w.totals.ending).toBe('0.00');
      const row = (code: string) => w.rows.find((r) => r.code === code);
      expect(row('4100')!.beginning).toBe('-400.00');
      expect(row('4100')!.ending).toBe('-460.00');
      expect(row('6600')!.beginning).toBe('100.00');
      expect(row('6400')?.ending ?? '0.00').toBe('0.00');
      expect(row('3900')!.beginning).toBe('-750.00');

      // Tie to the balance sheet as of the period end.
      const bs = await balanceSheet(ctx, eod('2024-10-31'));
      let plEnding = 0;
      for (const r of w.rows) if (r.type === 'revenue' || r.type === 'expense') plEnding += cents(r.ending);
      expect(-plEnding).toBe(cents(bs.currentYearNetIncome));
      expect(-cents(row('3900')!.ending)).toBe(cents(bs.priorYearsEarnings));
      // Balance-sheet accounts carry their full history (cash = 1000-250+400-100+60-20).
      expect(row('1000')!.ending).toBe('1090.00');
      expect(cents(bs.assets.find((a) => a.code === '1000')!.amount)).toBe(109000);
    });

    it('after a real year-end close, prior earnings are not counted twice', async () => {
      const { ctx, acct } = await newCompany('Retest FY Close Co');
      await postJournalEntry(ctx, {
        date: d('2024-04-01'),
        description: 'FY24 sale',
        lines: [
          { accountId: acct['1000'], debit: '1000' },
          { accountId: acct['4100'], credit: '1000' },
        ],
      });
      await postJournalEntry(ctx, {
        date: d('2024-07-01'),
        description: 'FY24 rent',
        lines: [
          { accountId: acct['6400'], debit: '300' },
          { accountId: acct['1000'], credit: '300' },
        ],
      });
      await yearEndClose(ctx, { fiscalYear: 2024 } as never);
      await postJournalEntry(ctx, {
        date: d('2025-02-05'),
        description: 'FY25 sale',
        lines: [
          { accountId: acct['1000'], debit: '80' },
          { accountId: acct['4100'], credit: '80' },
        ],
      });
      const w = await workingTrialBalance(ctx, { from: d('2025-02-01'), to: eod('2025-02-28') });
      expect(w.balanced).toBe(true);
      const re = w.rows.find((r) => r.code === '3900')!;
      expect(re.beginning).toBe('-700.00'); // not -1400 (closing entry + synthetic roll-forward)
      expect(w.rows.some((r) => r.accountId === '' && r.code === '3900')).toBe(false);
      expect(w.rows.find((r) => r.code === '4100')!.beginning).toBe('0.00');
      expect(w.rows.find((r) => r.code === '4100')!.ending).toBe('-80.00');
      const bs = await balanceSheet(ctx, eod('2025-02-28'));
      const reBs = bs.equity.find((e) => e.code === '3900')!;
      expect(cents(reBs.amount) + cents(bs.priorYearsEarnings)).toBe(70000);

      // A period that is the closed year's last month: still balanced in every column.
      const dec = await workingTrialBalance(ctx, { from: d('2024-12-01'), to: eod('2024-12-31') });
      expect(dec.balanced).toBe(true);
      expect(dec.totals.ending).toBe('0.00');
    });
  });

  // ===================================================================== I5 / I6
  describe('I5 / I6 permissions and listings', () => {
    let ctx: ServiceContext;
    let acct: Record<string, string>;
    let agency: string;
    let rate: string;
    let customerId: string;

    beforeAll(async () => {
      ({ ctx, acct } = await newCompany('Retest Batch Co'));
      agency = (await createTaxAgency(ctx, { name: 'Batch Agency' })).id;
      rate = (await createTaxRate(ctx, { name: 'Batch 5%', rate: '0.05', agencyId: agency })).id;
      customerId = (await createCustomer(ctx, { displayName: 'Batch Customer' })).id;
    });

    it('I5: row mode and validate-only with no Banking rights save nothing', async () => {
      const noBank = { ...ctx, access: only({ accounting: ['view', 'create'] }) };
      const before = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      for (const extra of [{ mode: 'row' as const }, { mode: 'all' as const }, { validateOnly: true }]) {
        await expect(
          batchEnterTransactions(noBank, {
            type: 'check',
            bankAccountId: acct['1000'],
            rows: [{ date: '2026-02-01', name: 'Anyone', account: '6300', amount: '12.00' }],
            ...extra,
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      const after = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      expect(after).toBe(before);
      // Journal rows still only need Accounting.
      const res = await batchEnterTransactions(noBank, {
        type: 'journal',
        rows: [
          { date: '2026-02-01', ref: 'J1', account: '6300', debit: '5.00' },
          { date: '2026-02-01', ref: 'J1', account: '1000', credit: '5.00' },
        ] as never,
      });
      expect(res.saved).toBeGreaterThanOrEqual(1);
      await expectBalanced(ctx);
    });

    it('I6: a mixed batch voids only what the role may void; refused rows stay posted', async () => {
      const inv = await createInvoice(ctx, {
        customerId,
        date: d('2026-03-02'),
        taxRateId: rate,
        lines: [{ description: 'Keep me', quantity: 1, rate: '100' }],
      });
      const manual = await postJournalEntry(ctx, {
        date: d('2026-03-03'),
        description: 'Manual to void',
        sourceRef: 'manual',
        lines: [
          { accountId: acct['6300'], debit: '9.99' },
          { accountId: acct['1000'], credit: '9.99' },
        ],
      });
      const pay = await paySalesTax(ctx, { agencyId: agency, amount: '5.00', paymentAccountId: acct['1000'], date: d('2026-03-20') });
      const acctOnly = { ...ctx, access: only({ accounting: ['view', 'delete'] }) };
      const res = await batchVoidTransactions(acctOnly, [`invoice:${inv.id}`, `journal:${manual.id}`, `journal:${pay.id}`]);
      expect(res.succeeded).toBe(1);
      expect(res.results.find((r) => r.key === `journal:${manual.id}`)!.ok).toBe(true);
      const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(i.status).not.toBe('void');
      const [p] = await db.select().from(journalEntries).where(eq(journalEntries.id, pay.id));
      expect(p.status).toBe('posted');

      // With Sales Tax delete the payment can be voided and the report still ties.
      const withTax = { ...ctx, access: only({ accounting: ['view', 'delete'], sales_tax: ['view', 'delete'] }) };
      const res2 = await batchVoidTransactions(withTax, [`journal:${pay.id}`]);
      expect(res2.succeeded).toBe(1);
      expect((await salesTaxLiabilityReport(ctx)).tiesToGl).toBe(true);
      await expectBalanced(ctx);
    });

    it('I6: listed journal amounts equal the entry debit total (not 0)', async () => {
      const je = await postJournalEntry(ctx, {
        date: d('2026-04-04'),
        description: 'Listed amount',
        sourceRef: 'manual',
        lines: [
          { accountId: acct['6300'], debit: '12.34' },
          { accountId: acct['6400'], debit: '0.66' },
          { accountId: acct['1000'], credit: '13.00' },
        ],
      });
      const rows = await listBatchTransactions(ctx, { from: d('2026-04-01'), to: eod('2026-04-30') });
      const mine = rows.filter((r) => r.entryId === je.id);
      expect(mine.length).toBe(1);
      expect(mine[0].amount).toBe('13.00');
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    });
  });

  // ===================================================================== I2 orphans
  describe('I2 orphaned corrections', () => {
    it('undo guards: unknown entry, a still-needed correction and an ordinary entry are refused', async () => {
      const { ctx, acct } = await newCompany('Retest Orphan Co');
      const agency = (await createTaxAgency(ctx, { name: 'Orphan Agency' })).id;
      await expect(undoOrphanedSalesTaxFix(ctx, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'CONFLICT' });
      const exp = await createExpense(ctx, {
        payeeName: 'Orphan Agency',
        date: d('2026-05-02'),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6700'], amount: '4', description: 'Orphan Agency sales tax' }],
      });
      const expId = (exp as { id?: string; expense?: { id: string } }).expense?.id ?? (exp as { id: string }).id;
      const issue = (await findMisrecordedSalesTax(ctx)).find((i) => i.issue === 'expense_payment');
      expect(issue).toBeDefined();
      const fix = await reclassifySalesTaxPayment(ctx, { lineId: issue!.lineId, agencyId: agency });
      const fixId = (fix as { id?: string; entry?: { id: string } }).entry?.id ?? (fix as { id: string }).id;
      // The original check is still live → the correction is needed.
      await expect(undoOrphanedSalesTaxFix(ctx, fixId)).rejects.toMatchObject({ code: 'CONFLICT' });
      const plain = await postJournalEntry(ctx, {
        date: d('2026-05-03'),
        description: 'Plain',
        lines: [
          { accountId: acct['6300'], debit: '1' },
          { accountId: acct['1000'], credit: '1' },
        ],
      });
      await expect(undoOrphanedSalesTaxFix(ctx, plain.id)).rejects.toMatchObject({ code: 'CONFLICT' });

      // The check is voided from its own screen → the correction is left behind as an orphan.
      // Close the books past the correction's date: undo must then respect the closing date
      // (refused without the password, allowed with the override) and the TB stays balanced.
      await voidExpense(ctx, expId);
      const orphans = (await findMisrecordedSalesTax(ctx)).filter((i) => i.issue === 'orphaned_fix');
      expect(orphans.map((o) => o.entryId)).toEqual([fixId]);
      const [fixRow] = await db.select().from(journalEntries).where(eq(journalEntries.id, fixId));
      const closeOn = fixRow.date.toISOString().slice(0, 10);
      await setClosingDate(ctx, { closingDate: closeOn, password: 'pw' });
      try {
        await expect(undoOrphanedSalesTaxFix(ctx, fixId)).rejects.toBeDefined();
        const [still] = await db.select().from(journalEntries).where(eq(journalEntries.id, fixId));
        expect(still.status).toBe('posted');
        await undoOrphanedSalesTaxFix({ ...ctx, closingDateOverride: true } as ServiceContext, fixId);
        const [gone] = await db.select().from(journalEntries).where(eq(journalEntries.id, fixId));
        expect(gone.status).toBe('void');
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      expect((await findMisrecordedSalesTax(ctx)).some((i) => i.issue === 'orphaned_fix')).toBe(false);
      expect((await salesTaxLiabilityReport(ctx)).tiesToGl).toBe(true);
      await expectBalanced(ctx);
    });
  });
});
