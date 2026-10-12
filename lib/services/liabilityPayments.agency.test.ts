/**
 * Per-agency sales-tax liability tests.
 *
 *  - salesTaxLiabilityByAgency allocates collected invoice tax to agencies via
 *    combined-rate components and nets payments stamped "tax_agency:<id>".
 *  - paySalesTax debits the agency's own liabilityAccountId when set, falling
 *    back to the company-wide 2200 otherwise.
 *  - createTaxAgency rejects viewer contexts without persisting a row, and
 *    rejects a liabilityAccountId owned by another company.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  companies,
  customers,
  journalEntryLines,
  taxAgencies,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createTaxAgency, createTaxRate } from './salesTax';
import { setComponents } from './combinedTax';
import { paySalesTax, salesTaxLiabilityByAgency } from './liabilityPayments';
import { createInvoice } from './invoices';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-liability-agency');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let stateAgencyId: string;
let cityAgencyId: string;

describe('Pay Sales Tax — per-agency liability tracking', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'agency-tax@test.local', name: 'Agency Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Agency Tax Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2210', 'State Sales Tax Payable', 'liability', 'long_term_liability'],
      ['4000', 'Sales', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // State agency has its OWN liability account; City falls back to 2200.
    const state = await createTaxAgency(ctx, {
      name: 'State Dept of Revenue',
      liabilityAccountId: acct['2210'],
    });
    stateAgencyId = state.id;
    const city = await createTaxAgency(ctx, { name: 'City Tax Office' });
    cityAgencyId = city.id;

    // Combined 8% rate = 6% state + 2% city.
    const rate = await createTaxRate(ctx, { name: 'Combined 8%', rate: '0.08' });
    await setComponents(ctx, rate.id, [
      { name: 'State 6%', agencyId: stateAgencyId, rate: '0.06' },
      { name: 'City 2%', agencyId: cityAgencyId, rate: '0.02' },
    ]);

    // One live invoice carrying $80 of tax on the combined rate, posted through the invoice
    // service (the liability engine reads the Sales Tax Payable ledger, not invoice headers).
    const [customer] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Taxed Customer' })
      .returning();
    await createInvoice(ctx, {
      customerId: customer.id,
      date: new Date('2026-04-01T12:00:00.000Z'),
      taxRateId: rate.id,
      lines: [{ description: 'Taxable sale', quantity: 1, rate: '1000.00' }],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('allocates collected tax to agencies by component rate share', async () => {
    const result = await salesTaxLiabilityByAgency(ctx);
    expect(result.totalCollected).toBe('80.00');
    expect(result.totalPaid).toBe('0.00');

    const state = result.rows.find((r) => r.agencyId === stateAgencyId)!;
    const city = result.rows.find((r) => r.agencyId === cityAgencyId)!;
    expect(state.collected).toBe('60.00'); // 6/8 of 80
    expect(state.liabilityAccountId).toBe(acct['2210']);
    expect(city.collected).toBe('20.00'); // 2/8 of 80
    expect(city.liabilityAccountId).toBeNull();
  });

  it("paySalesTax debits the agency's own liability account when set", async () => {
    const entry = await paySalesTax(ctx, {
      amount: '40.00',
      date: new Date('2026-04-20T12:00:00.000Z'),
      paymentAccountId: acct['1000'],
      agencyId: stateAgencyId,
    });
    expect(entry.sourceRef).toBe(`tax_agency:${stateAgencyId}`);
    expect(entry.description).toContain('State Dept of Revenue');

    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entry.id));
    const debit = lines.find((l) => Number(l.debit) > 0)!;
    expect(debit.accountId).toBe(acct['2210']); // agency account, NOT 2200
    expect(debit.debit).toBe('40.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('falls back to 2200 for agencies without a liability account', async () => {
    const entry = await paySalesTax(ctx, {
      amount: '20.00',
      date: new Date('2026-04-21T12:00:00.000Z'),
      paymentAccountId: acct['1000'],
      agencyId: cityAgencyId,
    });

    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entry.id));
    const debit = lines.find((l) => Number(l.debit) > 0)!;
    expect(debit.accountId).toBe(acct['2200']);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('nets per-agency payments against collected tax', async () => {
    const result = await salesTaxLiabilityByAgency(ctx);

    const state = result.rows.find((r) => r.agencyId === stateAgencyId)!;
    expect(state.paid).toBe('40.00');
    expect(state.balance).toBe('20.00');

    const city = result.rows.find((r) => r.agencyId === cityAgencyId)!;
    expect(city.paid).toBe('20.00');
    expect(city.balance).toBe('0.00');

    expect(result.totalCollected).toBe('80.00');
    expect(result.totalPaid).toBe('60.00');
    expect(result.totalBalance).toBe('20.00');
    // 2200 (+80 −20) and the State's own 2210 (−40) together: owed == GL.
    expect(result.glBalance).toBe('20.00');
    expect(result.tiesToGl).toBe(true);
  });

  it('respects the date range for both collected and paid', async () => {
    // A range before any activity: nothing collected or paid.
    const early = await salesTaxLiabilityByAgency(ctx, {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(early.totalCollected).toBe('0.00');
    expect(early.totalPaid).toBe('0.00');

    // A range covering the invoice but not the payments.
    const collectedOnly = await salesTaxLiabilityByAgency(ctx, {
      from: new Date('2026-04-01'),
      to: new Date('2026-04-10'),
    });
    expect(collectedOnly.totalCollected).toBe('80.00');
    expect(collectedOnly.totalPaid).toBe('0.00');
  });

  it('createTaxAgency rejects viewer contexts without persisting a row (RBAC choke-point)', async () => {
    await expect(
      createTaxAgency({ ...ctx, role: 'viewer' }, { name: 'Viewer Agency' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The 403 must not leave an orphaned agency behind.
    const rows = await db
      .select()
      .from(taxAgencies)
      .where(and(eq(taxAgencies.companyId, ctx.companyId), eq(taxAgencies.name, 'Viewer Agency')));
    expect(rows).toHaveLength(0);
  });

  it("createTaxAgency rejects a liabilityAccountId owned by another company", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'other-agency@test.local', name: 'Other Owner', passwordHash: 'x' })
      .returning();
    const [otherCompany] = await db
      .insert(companies)
      .values({ name: 'Other Agency Co', ownerId: otherUser.id })
      .returning();
    const otherCtx: ServiceContext = { db, companyId: otherCompany.id, userId: otherUser.id };
    const foreign = await createAccount(otherCtx, {
      code: '2290',
      name: 'Foreign Sales Tax Payable',
      type: 'liability' as never,
      subtype: 'long_term_liability',
    });

    await expect(
      createTaxAgency(ctx, { name: 'Cross-Tenant Agency', liabilityAccountId: foreign.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
