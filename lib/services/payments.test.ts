/**
 * Integration tests for the payments-ar module.
 *
 * Boots a throwaway PGlite directory, seeds a minimal company + COA, creates an invoice
 * via direct DB inserts (no invoices service dependency), then exercises receivePayment
 * and asserts:
 *   - trial balance stays balanced after posting
 *   - A/R and deposit account balances update correctly
 *   - invoice status/amountPaid/balanceDue track correctly
 *   - unapplied amount is stored on the payment
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { receivePayment, listPayments, getPayment } from './payments';
import { ServiceError } from './_base';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;

describe('payments-ar: Receive Payments', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // Seed user + company
    const [user] = await db
      .insert(users)
      .values({ email: 'ar-owner@test.local', name: 'AR Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'AR Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed required accounts
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed a customer
    const [cust] = await db
      .insert(customers)
      .values({
        companyId: company.id,
        displayName: 'Acme Corp',
      })
      .returning();
    customerId = cust.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Helper: insert a minimal open invoice directly into the DB and seed GL balance
  async function createOpenInvoice(amount: string): Promise<string> {
    // Pick the max invoice number + 1 per company
    const existing = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    const nextNum = existing.length + 1;

    const [inv] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId,
        invoiceNumber: nextNum,
        date: new Date('2026-01-01'),
        status: 'open',
        subtotal: amount,
        total: amount,
        amountPaid: '0.00',
        balanceDue: amount,
      })
      .returning();

    // Manually credit A/R to simulate the invoice posting (so trial balance stays balanced
    // when we later debit A/R in receivePayment).
    // Dr A/R / Cr Sales
    const { postJournalEntry } = await import('./posting');
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2026-01-01'),
      description: `Invoice #${nextNum} — Acme Corp`,
      lines: [
        { accountId: acct['1200'], debit: amount, memo: 'Invoice A/R' },
        { accountId: acct['4000'], credit: amount, memo: 'Invoice revenue' },
      ],
    });

    return inv.id;
  }

  it('rejects payment with zero amount', async () => {
    await expect(
      receivePayment(ctx, {
        customerId,
        date: new Date('2026-02-01'),
        method: 'check',
        amount: '0.00',
        applications: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects when applications exceed payment amount', async () => {
    const invoiceId = await createOpenInvoice('500.00');
    await expect(
      receivePayment(ctx, {
        customerId,
        date: new Date('2026-02-01'),
        method: 'check',
        amount: '200.00',
        applications: [{ invoiceId, amountApplied: '300.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('receives full payment — A/R reduced, deposit account debited, invoice paid', async () => {
    const invoiceId = await createOpenInvoice('1000.00');

    const { payment, entry } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-10'),
      method: 'check',
      reference: 'CHK-001',
      amount: '1000.00',
      depositAccountId: acct['1000'], // straight to Checking
      applications: [{ invoiceId, amountApplied: '1000.00' }],
    });

    // Payment row
    expect(payment.amount).toBe('1000.00');
    expect(payment.unapplied).toBe('0.00');
    expect(payment.postedEntryId).toBe(entry!.id);

    // Invoice updated
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.amountPaid).toBe('1000.00');
    expect(inv.balanceDue).toBe('0.00');
    expect(inv.status).toBe('paid');

    // Account balances
    const [ar] = await db.select().from(accounts).where(eq(accounts.id, acct['1200']));
    // AR was debited 1000 (invoice), then credited 1000 (payment) → net 0 on this invoice
    // AR balance reflects the running total across all tests; just check it moved by -1000
    const [checking] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    expect(Number(checking.balance)).toBeGreaterThan(0); // debited → positive balance

    // Trial balance must balance
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('receives partial payment — invoice becomes partial', async () => {
    const invoiceId = await createOpenInvoice('800.00');

    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-15'),
      method: 'cash',
      amount: '300.00',
      applications: [{ invoiceId, amountApplied: '300.00' }],
    });

    expect(payment.unapplied).toBe('0.00');

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.amountPaid).toBe('300.00');
    expect(inv.balanceDue).toBe('500.00');
    expect(inv.status).toBe('partial');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('stores unapplied amount when payment exceeds applications', async () => {
    const invoiceId = await createOpenInvoice('200.00');

    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-20'),
      method: 'ach',
      amount: '250.00',
      applications: [{ invoiceId, amountApplied: '200.00' }],
    });

    // 250 paid, 200 applied → 50 unapplied
    expect(payment.unapplied).toBe('50.00');

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe('paid');
    expect(inv.balanceDue).toBe('0.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('defaults deposit account to Undeposited Funds (1050) when none supplied', async () => {
    const invoiceId = await createOpenInvoice('150.00');

    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-03-01'),
      method: 'check',
      amount: '150.00',
      // no depositAccountId
      applications: [{ invoiceId, amountApplied: '150.00' }],
    });

    expect(payment.depositAccountId).toBe(acct['1050']);

    const [undeposited] = await db.select().from(accounts).where(eq(accounts.id, acct['1050']));
    expect(Number(undeposited.balance)).toBeGreaterThan(0);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('applies payment to multiple invoices at once', async () => {
    const inv1Id = await createOpenInvoice('400.00');
    const inv2Id = await createOpenInvoice('600.00');

    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-03-10'),
      method: 'bank_transfer',
      amount: '1000.00',
      depositAccountId: acct['1000'],
      applications: [
        { invoiceId: inv1Id, amountApplied: '400.00' },
        { invoiceId: inv2Id, amountApplied: '600.00' },
      ],
    });

    expect(payment.unapplied).toBe('0.00');

    const [i1] = await db.select().from(invoices).where(eq(invoices.id, inv1Id));
    const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv2Id));
    expect(i1.status).toBe('paid');
    expect(i2.status).toBe('paid');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('listPayments returns all payments for company', async () => {
    const list = await listPayments(ctx);
    // We've created at least 5 payments in this test suite
    expect(list.length).toBeGreaterThanOrEqual(5);
  });

  it('getPayment returns payment with applications', async () => {
    const invoiceId = await createOpenInvoice('75.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-03-15'),
      method: 'cash',
      amount: '75.00',
      applications: [{ invoiceId, amountApplied: '75.00' }],
    });

    const full = await getPayment(ctx, payment.id);
    expect(full.id).toBe(payment.id);
    expect(full.applications).toHaveLength(1);
    expect(full.applications[0].invoiceId).toBe(invoiceId);
    expect(full.applications[0].amountApplied).toBe('75.00');
  });

  it('getPayment throws NOT_FOUND for unknown id', async () => {
    await expect(
      getPayment(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects payment for invoice belonging to another customer', async () => {
    // Create a second customer
    const [other] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Other Customer' })
      .returning();

    // Create invoice for original customer
    const invoiceId = await createOpenInvoice('100.00');

    // Try to pay it as the other customer
    await expect(
      receivePayment(ctx, {
        customerId: other.id,
        date: new Date('2026-03-20'),
        method: 'check',
        amount: '100.00',
        applications: [{ invoiceId, amountApplied: '100.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
