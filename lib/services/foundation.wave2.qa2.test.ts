/**
 * Wave-2 GL foundation — independent QA, round 2 (tester). Cross-feature invariants that the
 * first QA pass (foundation.wave2.qa.test.ts) did not reach:
 *  - I11: named General Journal A/R / A/P lines must follow the customer / vendor through
 *    Merge (mergeCustomers / mergeVendors), and EVERY path that posts a manual entry (AI
 *    proposals included) must keep the A/R subledger equal to the A/R control account.
 *  - B1: merging an account that has history INTO an A/R account or a non-posting account must
 *    not break the subledger or surface a raw database error; IIF import maps every QB type.
 *  - I11: aging as of a date between a named entry and its reversal still ties to the GL.
 *  - I11: Receive Payments for a General-Journal-only balance keeps aging == control.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, aiProposals, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createManualEntry, reverseEntry } from './journal';
import { postJournalEntry } from './posting';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { mergeAccounts, mergeCustomers, mergeVendors } from './merge';
import { approveProposal } from './aiAssistant';
import { receivePayment } from './payments';
import { importIIF } from './qbImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa2');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};

async function idByCode(c: string) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row?.id;
}

/** Natural balance of every account with (type, subtype), from the posted GL. */
async function controlBalance(type: 'asset' | 'liability', subtype: string, asOf?: Date): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, type), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) {
    if (!ids.has(r.accountId)) continue;
    const net = Number(r.debit) - Number(r.credit);
    total += type === 'asset' ? net : -net;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Gap between the GL control account(s) and the aging total. Tests compare the gap before and
 * after their own postings so that one failing test cannot cascade into the others.
 */
async function arGap(asOf = new Date(2027, 11, 31)): Promise<number> {
  const ar = await arAging(ctx, asOf);
  return Math.round(((await controlBalance('asset', 'accounts_receivable', asOf)) - Number(ar.totals.total)) * 100) / 100;
}

async function apGap(asOf = new Date(2027, 11, 31)): Promise<number> {
  const ap = await apAging(ctx, asOf);
  return Math.round(((await controlBalance('liability', 'accounts_payable', asOf)) - Number(ap.totals.total)) * 100) / 100;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa2@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA2 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1050', '1200', '2000', '3000', '4000', '6000']) {
    code[c] = (await idByCode(c))!;
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('QA2: named journal lines follow Merge', () => {
  it('merging customers moves General Journal open items to the surviving customer', async () => {
    const dup = (await createCustomer(ctx, { displayName: 'Merge Dup Customer' })).id;
    const keep = (await createCustomer(ctx, { displayName: 'Merge Keep Customer' })).id;
    const g0 = await arGap();
    await createManualEntry(ctx, {
      date: new Date(2026, 3, 1),
      description: 'GJ charge on the duplicate',
      lines: [
        { accountId: code['1200'], debit: '150.00', entityType: 'customer', entityId: dup },
        { accountId: code['4000'], credit: '150.00' },
      ],
    });
    await mergeCustomers(ctx, { fromId: dup, toId: keep });

    const ar = await arAging(ctx, new Date(2026, 11, 31));
    // The duplicate is gone (deactivated); its balance now belongs to the survivor.
    expect(ar.rows.find((r) => r.id === dup)).toBeUndefined();
    expect(ar.rows.find((r) => r.id === keep)?.total).toBe('150.00');
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('merging vendors moves General Journal open items to the surviving vendor', async () => {
    const dup = (await createVendor(ctx, { displayName: 'Merge Dup Vendor' })).id;
    const keep = (await createVendor(ctx, { displayName: 'Merge Keep Vendor' })).id;
    const g0 = await apGap();
    await createManualEntry(ctx, {
      date: new Date(2026, 3, 2),
      description: 'GJ accrual on the duplicate',
      lines: [
        { accountId: code['6000'], debit: '80.00' },
        { accountId: code['2000'], credit: '80.00', entityType: 'vendor', entityId: dup },
      ],
    });
    await mergeVendors(ctx, { fromId: dup, toId: keep });

    const ap = await apAging(ctx, new Date(2026, 11, 31));
    expect(ap.rows.find((r) => r.id === dup)).toBeUndefined();
    expect(ap.rows.find((r) => r.id === keep)?.total).toBe('80.00');
    expect(await apGap()).toBeCloseTo(g0, 2);
  });
});

describe('QA2: every manual-entry path keeps A/R subledger == control', () => {
  it('approving an AI proposal that hits A/R without a customer is refused', async () => {
    const g0 = await arGap();
    const [proposal] = await db
      .insert(aiProposals)
      .values({
        companyId: ctx.companyId,
        createdBy: ctx.userId,
        kind: 'journal_entry',
        summary: 'Bill a customer by journal',
        payload: {
          date: '2026-04-10',
          description: 'AI: record setup fee',
          reference: null,
          lines: [
            { accountId: code['1200'], accountCode: '1200', accountName: 'Accounts Receivable', debit: '45.00', credit: null, memo: null },
            { accountId: code['4000'], accountCode: '4000', accountName: 'Sales', debit: null, credit: '45.00', memo: null },
          ],
          totalDebit: '45.00',
          rationale: null,
        },
      })
      .returning();
    // QB rule: an A/R line needs a customer. Either the approval is refused, or the books still
    // tie out — an unnamed A/R amount that no customer owes is never acceptable.
    await approveProposal(ctx, proposal.id).catch(() => undefined);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('aging as of a date between a named entry and its reversal ties to the GL as of that date', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Reversal Timing Customer' })).id;
    const mid = new Date(2026, 4, 15);
    const later = new Date(2026, 5, 2);
    const gMid = await arGap(mid);
    const gLater = await arGap(later);
    const e = await createManualEntry(ctx, {
      date: new Date(2026, 4, 1),
      description: 'Accrued receivable',
      lines: [
        { accountId: code['1200'], debit: '60.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '60.00' },
      ],
    });
    await reverseEntry(ctx, e.id, new Date(2026, 5, 1));
    // Between the entry and the reversal the customer owes 60; afterwards nothing.
    expect((await arAging(ctx, mid)).rows.find((r) => r.id === cust)?.total).toBe('60.00');
    expect(await arGap(mid)).toBeCloseTo(gMid, 2);
    const after = await arAging(ctx, later);
    expect(Number(after.rows.find((r) => r.id === cust)?.total ?? 0)).toBe(0);
    expect(await arGap(later)).toBeCloseTo(gLater, 2);
  });

  it('receiving a payment for a General-Journal-only balance keeps aging == control', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'GJ Payer' })).id;
    const asOf = new Date(2026, 6, 31);
    const g0 = await arGap(asOf);
    await createManualEntry(ctx, {
      date: new Date(2026, 6, 1),
      description: 'GJ charge to be paid',
      lines: [
        { accountId: code['1200'], debit: '25.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '25.00' },
      ],
    });
    await receivePayment(ctx, {
      customerId: cust,
      date: new Date(2026, 6, 5),
      method: 'check',
      amount: '25.00',
      applications: [],
    });
    // The customer owes nothing any more, and A/R aging still equals the A/R account.
    const ar = await arAging(ctx, asOf);
    expect(Number(ar.rows.find((r) => r.id === cust)?.total ?? 0)).toBe(0);
    expect(await arGap(asOf)).toBeCloseTo(g0, 2);
  });
});

describe('QA2: merging accounts across QuickBooks account types', () => {
  it('merging an Other Current Asset with history INTO Accounts Receivable is refused (QB: same account type only)', async () => {
    const prepaid = await createAccount(ctx, {
      code: '1310',
      name: 'Prepaid Rent QA2',
      qbType: 'other_current_asset',
    });
    const g0 = await arGap();
    await postJournalEntry(ctx, {
      date: new Date(2026, 7, 1),
      description: 'Prepay rent',
      status: 'posted',
      lines: [
        { accountId: prepaid.id, debit: '300.00' },
        { accountId: code['1000'], credit: '300.00' },
      ],
    });
    await expect(mergeAccounts(ctx, { fromId: prepaid.id, toId: code['1200'] })).rejects.toMatchObject({
      name: 'ServiceError',
    });
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('merging an account with history INTO a non-posting account is a friendly refusal, books unchanged', async () => {
    const np = await createAccount(ctx, { code: '9001', name: 'Estimates QA2', qbType: 'non_posting' });
    const deposit = await createAccount(ctx, {
      code: '1320',
      name: 'Security Deposit QA2',
      qbType: 'other_asset',
    });
    await postJournalEntry(ctx, {
      date: new Date(2026, 7, 2),
      description: 'Pay deposit',
      status: 'posted',
      lines: [
        { accountId: deposit.id, debit: '500.00' },
        { accountId: code['1000'], credit: '500.00' },
      ],
    });
    // Must be a ServiceError (400/409), not a raw Postgres trigger error surfacing as a 500.
    await expect(mergeAccounts(ctx, { fromId: deposit.id, toId: np.id })).rejects.toMatchObject({
      name: 'ServiceError',
    });
    const [dep] = await db.select().from(accounts).where(eq(accounts.id, deposit.id));
    expect(dep.balance).toBe('500.00');
    expect(dep.isActive).toBe(true);
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.some((r) => r.accountId === np.id)).toBe(false);
  });
});

describe('QA2: IIF import maps every QuickBooks account type', () => {
  it('maps OCASSET / OCLIAB / OTHERASSET / LTLIAB / EXINC / EXEXP / COGS / NONPOSTING; Undeposited Funds stays cash', async () => {
    const iif =
      '!ACCNT\tNAME\tACCNTTYPE\tACCNUM\n' +
      'ACCNT\tQA2 Prepaid Insurance\tOCASSET\tI-01\n' +
      'ACCNT\tQA2 Undeposited Funds\tOCASSET\tI-02\n' +
      'ACCNT\tQA2 Sales Tax Payable\tOCLIAB\tI-03\n' +
      'ACCNT\tQA2 Deposits\tOTHERASSET\tI-04\n' +
      'ACCNT\tQA2 Bank Loan\tLTLIAB\tI-05\n' +
      'ACCNT\tQA2 Interest Income\tEXINC\tI-06\n' +
      'ACCNT\tQA2 Interest Expense\tEXEXP\tI-07\n' +
      'ACCNT\tQA2 Materials\tCOGS\tI-08\n' +
      'ACCNT\tQA2 Estimates\tNONPOSTING\tI-09\n';
    await importIIF(ctx, iif);
    const rows = await db
      .select({ code: accounts.code, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.code} LIKE 'I-0%'`));
    const by = Object.fromEntries(rows.map((r) => [r.code, `${r.type}/${r.subtype}`]));
    expect(by).toEqual({
      'I-01': 'asset/other_current_asset',
      'I-02': 'asset/undeposited_funds',
      'I-03': 'liability/other_current_liability',
      'I-04': 'asset/other_asset',
      'I-05': 'liability/long_term_liability',
      'I-06': 'revenue/other_income',
      'I-07': 'expense/other_expense',
      'I-08': 'expense/cost_of_goods_sold',
      'I-09': 'asset/non_posting',
    });
  });
});
