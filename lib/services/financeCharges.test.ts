/**
 * Integration tests for financeCharges.ts (QB Assess Finance Charges).
 *
 * Uses an isolated PGlite throwaway directory. Verifies:
 *  - settings: defaults, persistence in companies.settings, validation
 *  - preview: simple-interest math, grace days, minimum charge, exclusions
 *  - assess: creates one posted finance-charge invoice per customer
 *    (Dr A/R 1200 / Cr Finance Charge Income 4400), idempotent per period,
 *    and never compounds on prior finance charges
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  invoices,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  DEFAULT_FINANCE_CHARGE_SETTINGS,
  assessFinanceCharges,
  getFinanceChargeSettings,
  previewFinanceCharges,
  updateFinanceChargeSettings,
} from './financeCharges';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-finchg-e9b2');
let ctx: ServiceContext;
let db: DB;
let customerId: string;
let currentCustomerId: string;

// Assessment date used throughout: invoice due 2026-01-01, asOf 2026-03-02 = 60 days late.
const AS_OF = new Date('2026-03-02T00:00:00.000Z');

describe('financeCharges service (integration)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@finchg.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Finance Charge Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // A/R account (assess would also auto-create it, but seed the standard one).
    await db.insert(accounts).values({
      companyId: company.id,
      code: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
      subtype: 'accounts_receivable',
    });

    // Delinquent customer: $1,000 invoice 60 days past due as of AS_OF.
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Late Larry' })
      .returning();
    customerId = cust.id;

    await db.insert(invoices).values({
      companyId: company.id,
      customerId,
      invoiceNumber: 100,
      date: new Date('2025-12-01T00:00:00.000Z'),
      dueDate: new Date('2026-01-01T00:00:00.000Z'),
      status: 'open',
      subtotal: '1000.00',
      total: '1000.00',
      amountPaid: '0.00',
      balanceDue: '1000.00',
    });

    // Current customer: invoice not yet due — must never be charged.
    const [cur] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Current Carol' })
      .returning();
    currentCustomerId = cur.id;
    await db.insert(invoices).values({
      companyId: company.id,
      customerId: currentCustomerId,
      invoiceNumber: 101,
      date: new Date('2026-02-20T00:00:00.000Z'),
      dueDate: new Date('2026-03-20T00:00:00.000Z'),
      status: 'open',
      subtotal: '500.00',
      total: '500.00',
      amountPaid: '0.00',
      balanceDue: '500.00',
    });

    // Paid + void invoices for the delinquent customer — both excluded.
    await db.insert(invoices).values([
      {
        companyId: company.id,
        customerId,
        invoiceNumber: 102,
        date: new Date('2025-11-01T00:00:00.000Z'),
        dueDate: new Date('2025-12-01T00:00:00.000Z'),
        status: 'paid',
        subtotal: '300.00',
        total: '300.00',
        amountPaid: '300.00',
        balanceDue: '0.00',
      },
      {
        companyId: company.id,
        customerId,
        invoiceNumber: 103,
        date: new Date('2025-11-15T00:00:00.000Z'),
        dueDate: new Date('2025-12-15T00:00:00.000Z'),
        status: 'void',
        subtotal: '400.00',
        total: '400.00',
        amountPaid: '0.00',
        balanceDue: '400.00',
      },
    ]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  it('returns defaults when nothing is stored', async () => {
    const s = await getFinanceChargeSettings(ctx);
    expect(s).toEqual(DEFAULT_FINANCE_CHARGE_SETTINGS);
  });

  it('persists updated settings in companies.settings', async () => {
    const s = await updateFinanceChargeSettings(ctx, {
      annualRate: '18',
      minCharge: '5',
      graceDays: 10,
    });
    expect(s.annualRate).toBe('18.00');
    expect(s.minCharge).toBe('5.00');
    expect(s.graceDays).toBe(10);

    const again = await getFinanceChargeSettings(ctx);
    expect(again.minCharge).toBe('5.00');

    // Other settings keys must survive the merge.
    const [row] = await db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, ctx.companyId));
    expect(row.settings?.financeCharges).toBeDefined();

    // Reset for the math tests below.
    await updateFinanceChargeSettings(ctx, { annualRate: '18', minCharge: '0', graceDays: 0 });
  });

  it('rejects invalid settings', async () => {
    await expect(updateFinanceChargeSettings(ctx, { annualRate: '150' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(updateFinanceChargeSettings(ctx, { graceDays: -3 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(updateFinanceChargeSettings(ctx, { minCharge: '-1' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  it('computes simple interest per overdue invoice (1000 × 18%/365 × 60d = 29.59)', async () => {
    const preview = await previewFinanceCharges(ctx, { asOf: AS_OF });
    expect(preview.periodKey).toBe('2026-03');

    const larry = preview.customers.find((c) => c.customerId === customerId);
    expect(larry).toBeDefined();
    expect(larry!.overdueInvoices).toHaveLength(1);
    expect(larry!.overdueInvoices[0].invoiceNumber).toBe(100);
    expect(larry!.overdueInvoices[0].daysOverdue).toBe(60);
    expect(larry!.baseCharge).toBe('29.59');
    expect(larry!.charge).toBe('29.59');
    expect(larry!.minimumApplied).toBe(false);
    expect(larry!.alreadyAssessed).toBe(false);

    // The current customer has nothing overdue.
    expect(preview.customers.find((c) => c.customerId === currentCustomerId)).toBeUndefined();
  });

  it('grace days suppress charges until the invoice is past the grace period', async () => {
    const preview = await previewFinanceCharges(ctx, {
      asOf: AS_OF,
      settings: { graceDays: 90 },
    });
    expect(preview.customers.find((c) => c.customerId === customerId)).toBeUndefined();
  });

  it('applies the minimum charge when computed interest is below it', async () => {
    const preview = await previewFinanceCharges(ctx, {
      asOf: AS_OF,
      settings: { minCharge: '50' },
    });
    const larry = preview.customers.find((c) => c.customerId === customerId)!;
    expect(larry.baseCharge).toBe('29.59');
    expect(larry.charge).toBe('50.00');
    expect(larry.minimumApplied).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Assess
  // -------------------------------------------------------------------------

  it('creates one posted finance-charge invoice per customer', async () => {
    const result = await assessFinanceCharges(ctx, { asOf: AS_OF });
    expect(result.assessed).toHaveLength(1);
    expect(result.assessed[0].customerId).toBe(customerId);
    expect(result.assessed[0].charge).toBe('29.59');
    expect(result.skipped).toHaveLength(0);

    // Invoice exists with the period marker and an open balance.
    const [fcInvoice] = await db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.companyId, ctx.companyId), like(invoices.memo, '%[FC:2026-03]%')),
      );
    expect(fcInvoice).toBeDefined();
    expect(fcInvoice.customerId).toBe(customerId);
    expect(fcInvoice.total).toBe('29.59');
    expect(fcInvoice.balanceDue).toBe('29.59');
    expect(fcInvoice.status).toBe('open');
    expect(fcInvoice.postedEntryId).not.toBeNull();

    // GL posting: Dr 1200 / Cr 4400 for 29.59, traceable via sourceRef.
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, fcInvoice.postedEntryId!));
    expect(entry.sourceRef).toBe(`invoice:${fcInvoice.id}`);
    expect(entry.status).toBe('posted');

    const lines = await db
      .select({
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        code: accounts.code,
      })
      .from(journalEntryLines)
      .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
      .where(eq(journalEntryLines.journalEntryId, entry.id));
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.debit !== null)!;
    const credit = lines.find((l) => l.credit !== null)!;
    expect(debit.code).toBe('1200');
    expect(debit.debit).toBe('29.59');
    expect(credit.code).toBe('4400');
    expect(credit.credit).toBe('29.59');

    // The income account was find-or-created with the right shape.
    const [fcAcct] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '4400')));
    expect(fcAcct.name).toBe('Finance Charge Income');
    expect(fcAcct.type).toBe('revenue');
  });

  it('is idempotent per period — re-running the same month assesses nothing', async () => {
    const again = await assessFinanceCharges(ctx, { asOf: AS_OF });
    expect(again.assessed).toHaveLength(0);
    expect(again.skipped).toHaveLength(1);
    expect(again.skipped[0].reason).toContain('2026-03');

    const markers = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(eq(invoices.companyId, ctx.companyId), like(invoices.memo, '%[FC:2026-03]%')),
      );
    expect(markers).toHaveLength(1); // still exactly one
  });

  it('never compounds: the finance-charge invoice is excluded from later charge bases', async () => {
    // A month later, only the ORIGINAL $1,000 invoice accrues interest —
    // the open $29.59 finance-charge invoice is excluded by its marker.
    const later = new Date('2026-04-01T00:00:00.000Z'); // 90 days past due
    const preview = await previewFinanceCharges(ctx, { asOf: later });
    const larry = preview.customers.find((c) => c.customerId === customerId)!;
    expect(larry.overdueInvoices).toHaveLength(1);
    expect(larry.overdueInvoices[0].invoiceNumber).toBe(100);
    expect(larry.alreadyAssessed).toBe(false); // new period
    // 90 days past due, but the 60 days up to the March 2 assessment were already charged:
    // only Mar 2 -> Apr 1 is new (round 5; QB counts from the last finance charge date).
    // 1000 × 0.18/365 × 30 = 14.79
    expect(larry.overdueInvoices[0].daysOverdue).toBe(90);
    expect(larry.overdueInvoices[0].daysCharged).toBe(30);
    expect(larry.charge).toBe('14.79');
  });

  it('respects the customerIds subset filter', async () => {
    const later = new Date('2026-04-01T00:00:00.000Z');
    const result = await assessFinanceCharges(ctx, {
      asOf: later,
      customerIds: ['00000000-0000-0000-0000-000000000000'], // nobody real
    });
    expect(result.assessed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('rejects viewer contexts on assessment (RBAC choke-point)', async () => {
    const later = new Date('2026-04-01T00:00:00.000Z');
    await expect(
      assessFinanceCharges({ ...ctx, role: 'viewer' }, { asOf: later }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
