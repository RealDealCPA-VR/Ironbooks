/**
 * Feature round (accountant) fix: opening balances in the EasyStep setup interview.
 * Bank / credit card / loan / A/R / A/P balances as of the day before the start date, balanced
 * through Opening Balance Equity, closing-date aware, safe to re-run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import { accounts, bills, creditMemos, invoices, journalEntries, vendorCredits } from '@/lib/db/schema';
import { setClosingDate } from './company';
import { trialBalance } from './reports';
import { applySetupInterview, type SetupInterviewInput } from './setupInterview';
import { dayBefore } from './setupOpeningBalances';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const base: SetupInterviewInput = {
  businessType: 'service',
  entityType: 'sole_prop',
  fiscalYearStartMonth: 1,
  startDate: '2026-01-01',
  reportBasis: 'accrual',
  salesTax: false,
  inventory: false,
  employees: false,
} as SetupInterviewInput;

const bal = async (id: string) => (await t.db.select().from(accounts).where(eq(accounts.id, id)))[0].balance;
const byName = async (name: string) => (await t.db.select().from(accounts).where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.name, name))))[0];

describe('Setup interview opening balances', () => {
  beforeAll(async () => {
    t = await makeTestCompany('setupob');
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('dayBefore', () => {
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
  });

  it('posts bank, card, loan, A/R and A/P balances on the day before the start date, through Opening Balance Equity', async () => {
    const res = await applySetupInterview(t.ctx, {
      ...base,
      openingBalances: {
        accounts: [
          { accountId: t.acct['1000'], kind: 'bank', amount: '5000.00' },
          { name: 'Visa Card', kind: 'credit_card', amount: '300.00' },
          { name: 'Truck Loan', kind: 'loan', amount: '12000.00' },
        ],
        customers: [{ name: 'Acme Client', amount: '800.00' }],
        vendors: [{ name: 'Paper Co', amount: '150.00' }],
      },
    });
    expect(res.openingBalances).toHaveLength(5);
    expect(await bal(t.acct['1000'])).toBe('5000.00');
    const visa = await byName('Visa Card');
    expect(String(visa.subtype)).toBe('credit_card');
    expect(visa.balance).toBe('300.00');
    expect((await byName('Truck Loan')).balance).toBe('12000.00');
    // OBE = 5000 + 800 - 300 - 12000 - 150 = -6650 (a debit balance on an equity account).
    const obe = await byName('Opening Balance Equity');
    expect(Number(obe.balance)).toBe(-6650);
    // Every entry is dated 2025-12-31.
    const entries = await t.db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, t.ctx.companyId), ne(journalEntries.status, 'void')));
    expect(entries.length).toBe(5);
    for (const e of entries) expect(e.date.toISOString().slice(0, 10)).toBe('2025-12-31');
    // A/R and A/P are real documents, so aging shows who owes what.
    const inv = await t.db.select().from(invoices).where(eq(invoices.companyId, t.ctx.companyId));
    expect(inv).toHaveLength(1);
    expect(inv[0].total).toBe('800.00');
    const b = await t.db.select().from(bills).where(eq(bills.companyId, t.ctx.companyId));
    expect(b).toHaveLength(1);
    expect(b[0].total).toBe('150.00');
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('re-running keeps what was entered and re-posts a changed account balance', async () => {
    const res = await applySetupInterview(t.ctx, {
      ...base,
      openingBalances: {
        accounts: [{ accountId: t.acct['1000'], kind: 'bank', amount: '5500.00' }, { name: 'Visa Card', kind: 'credit_card', amount: '300.00' }],
        customers: [{ name: 'Acme Client', amount: '800.00' }],
      },
    });
    expect(res.openingBalances.some((l) => /Visa Card.*already entered/.test(l))).toBe(true);
    expect(res.openingBalances.some((l) => /Acme Client: already has/.test(l))).toBe(true);
    expect(await bal(t.acct['1000'])).toBe('5500.00');
    expect((await byName('Visa Card')).balance).toBe('300.00');
    expect((await t.db.select().from(invoices).where(eq(invoices.companyId, t.ctx.companyId)))).toHaveLength(1);
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('re-running with NEGATIVE customer / vendor balances adds no second credit (review round 2 P1)', async () => {
    const input = { ...base, openingBalances: { customers: [{ name: 'Neg Cust', amount: '-50.00' }], vendors: [{ name: 'Neg Vend', amount: '-30.00' }] } };
    await applySetupInterview(t.ctx, input);
    await applySetupInterview(t.ctx, input);
    const cms = await t.db.select().from(creditMemos).where(and(eq(creditMemos.companyId, t.ctx.companyId), ne(creditMemos.status, 'void')));
    const vcs = await t.db.select().from(vendorCredits).where(and(eq(vendorCredits.companyId, t.ctx.companyId), ne(vendorCredits.status, 'void')));
    expect(cms).toHaveLength(1);
    expect(vcs).toHaveLength(1);
    // A sign change on a re-run is not a second document either.
    await applySetupInterview(t.ctx, { ...base, openingBalances: { customers: [{ name: 'Neg Cust', amount: '50.00' }] } });
    expect(
      (await t.db.select().from(invoices).where(and(eq(invoices.companyId, t.ctx.companyId), eq(invoices.memo, 'Opening balance (setup interview)'), ne(invoices.status, 'void')))).length,
    ).toBe(1); // only Acme Client's
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('a balance changed to 0 on a re-run voids the earlier opening entry / document (review round 2 P2)', async () => {
    await applySetupInterview(t.ctx, {
      ...base,
      openingBalances: {
        accounts: [{ name: 'Visa Card', kind: 'credit_card', amount: '0' }],
        customers: [{ name: 'Acme Client', amount: '0' }],
        vendors: [{ name: 'Neg Vend', amount: '0.00' }],
      },
    });
    expect((await byName('Visa Card')).balance).toBe('0.00');
    const inv = await t.db.select().from(invoices).where(and(eq(invoices.companyId, t.ctx.companyId), ne(invoices.status, 'void')));
    expect(inv).toHaveLength(0);
    const vcs = await t.db.select().from(vendorCredits).where(and(eq(vendorCredits.companyId, t.ctx.companyId), ne(vendorCredits.status, 'void')));
    expect(vcs).toHaveLength(0);
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('respects the closing date: a balance dated in a closed period is refused and nothing is saved', async () => {
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' });
    await expect(
      applySetupInterview(t.ctx, {
        ...base,
        startDate: '2026-01-15',
        openingBalances: { accounts: [{ accountId: t.acct['1010'] ?? t.acct['1000'], kind: 'bank', amount: '10.00' }] },
      }),
    ).rejects.toBeTruthy();
    expect(await bal(t.acct['1000'])).toBe('5500.00');
  });

  it('refuses A/R or A/P accounts in the accounts section and bad amounts', async () => {
    await expect(
      applySetupInterview(t.ctx, { ...base, startDate: '2026-03-01', openingBalances: { accounts: [{ accountId: t.acct['1200'], kind: 'other_current_asset', amount: '1.00' }] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      applySetupInterview(t.ctx, { ...base, startDate: '2026-03-01', openingBalances: { accounts: [{ accountId: t.acct['1000'], kind: 'bank', amount: '1.005' }] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
