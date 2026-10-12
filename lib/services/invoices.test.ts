/**
 * Integration tests for the Invoices (A/R) service.
 *
 * Boots a throwaway PGlite database, seeds the minimum accounts, creates invoices,
 * and asserts that:
 *   - Invoice fields are correct (subtotal, tax, total, balance).
 *   - A/R account balance matches the invoiced total.
 *   - Trial balance remains balanced after every operation.
 *   - Voiding reverses the GL and zeroes the balance.
 *   - Credit limit is enforced (VALIDATION error when exceeded).
 *   - Percent discount is computed correctly from the subtotal.
 *   - Foreign-currency invoices post GL amounts in base currency (balanced).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, taxAgencies, taxRates, journalEntries, journalEntryLines, auditLogs } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, getInvoice, listInvoices, voidInvoice, markPaidAmount } from './invoices';
import { ServiceError } from './_base';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-invoices');

let ctx: ServiceContext;
let db: DB;

// account id map by code
const acct: Record<string, string> = {};
let customerId: string;
let taxRateId: string;

describe('Invoices service (end-to-end)', () => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // Seed user + company.
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@invoices.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Invoice Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed the accounts used by the invoices service.
    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4100', 'Service Income', 'revenue', 'service_revenue'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed a customer.
    const [cust] = await db
      .insert(customers)
      .values({
        companyId: company.id,
        displayName: 'Acme Corp',
        taxable: true,
      })
      .returning();
    customerId = cust.id;

    // Seed a tax agency and a tax rate (8.25%).
    const [agency] = await db
      .insert(taxAgencies)
      .values({
        companyId: company.id,
        name: 'State Tax Board',
        liabilityAccountId: acct['2200'],
      })
      .returning();

    const [tr] = await db
      .insert(taxRates)
      .values({
        companyId: company.id,
        name: 'Sales Tax 8.25%',
        rate: '0.082500',
        agencyId: agency.id,
        isActive: true,
      })
      .returning();
    taxRateId = tr.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Simple invoice without tax or discount
  // -------------------------------------------------------------------------
  it('creates a simple invoice and posts to A/R', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-01'),
      lines: [
        { accountId: acct['4000'], description: 'Widget A', quantity: 10, rate: 50 },
        { accountId: acct['4100'], description: 'Setup fee', quantity: 1, rate: 200 },
      ],
    });

    // Subtotal = 10*50 + 1*200 = 700
    expect(invoice.subtotal).toBe('700.00');
    expect(invoice.taxAmount).toBe('0.00');
    expect(invoice.discount).toBe('0.00');
    expect(invoice.total).toBe('700.00');
    expect(invoice.balanceDue).toBe('700.00');
    expect(invoice.status).toBe('open');
    expect(invoice.invoiceNumber).toBe(1);
    expect(invoice.postedEntryId).toBeTruthy();

    // A/R account balance should reflect the invoice total.
    const [arRow] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, acct['1200']));
    expect(arRow.balance).toBe('700.00');

    // Trial balance must stay balanced.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Invoice with tax
  // -------------------------------------------------------------------------
  it('creates an invoice with sales tax, credits tax payable', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-05'),
      lines: [
        { accountId: acct['4000'], description: 'Taxable item', quantity: 1, rate: 1000, taxable: true },
        { accountId: acct['4100'], description: 'Non-taxable service', quantity: 1, rate: 500, taxable: false },
      ],
      taxRateId,
    });

    // subtotal = 1500, taxable subtotal = 1000, tax = 1000*0.0825 = 82.50
    // total = 1500 - 0 + 82.50 = 1582.50
    expect(invoice.subtotal).toBe('1500.00');
    expect(invoice.taxAmount).toBe('82.50');
    expect(invoice.total).toBe('1582.50');
    expect(invoice.balanceDue).toBe('1582.50');

    // Tax payable account should have a credit balance of 82.50.
    const [taxRow] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, acct['2200']));
    expect(taxRow.balance).toBe('82.50');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Invoice with a flat discount
  // -------------------------------------------------------------------------
  it('creates an invoice with a discount and keeps the entry balanced', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-10'),
      lines: [
        { accountId: acct['4000'], description: 'Big order', quantity: 5, rate: 100 },
      ],
      discount: 50, // flat $50 discount
    });

    // subtotal = 500, discount = 50, tax = 0, total = 450
    expect(invoice.subtotal).toBe('500.00');
    expect(invoice.discount).toBe('50.00');
    expect(invoice.total).toBe('450.00');
    expect(invoice.balanceDue).toBe('450.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: getInvoice with lines
  // -------------------------------------------------------------------------
  it('getInvoice returns header + lines', async () => {
    const created = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-15'),
      lines: [
        { accountId: acct['4000'], description: 'Line 1', quantity: 2, rate: 75 },
        { accountId: acct['4100'], description: 'Line 2', quantity: 1, rate: 300 },
      ],
    });

    const fetched = await getInvoice(ctx, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.lines).toHaveLength(2);
    expect(fetched.lines[0].description).toBe('Line 1');
    expect(fetched.lines[1].description).toBe('Line 2');
  });

  // -------------------------------------------------------------------------
  // Test 5: listInvoices
  // -------------------------------------------------------------------------
  it('listInvoices returns invoices scoped to company', async () => {
    const list = await listInvoices(ctx);
    // We created 4 invoices above; all should be listed.
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const inv of list) {
      expect(inv.companyId).toBe(ctx.companyId);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: voidInvoice reverses the GL
  // -------------------------------------------------------------------------
  it('voiding an invoice reverses the A/R balance', async () => {
    // Record AR balance before the new invoice.
    const [arBefore] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, acct['1200']));
    const balanceBefore = arBefore.balance;

    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-20'),
      lines: [{ accountId: acct['4000'], description: 'To void', quantity: 1, rate: 999 }],
    });

    // Balance should have increased by 999.
    const [arMid] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, acct['1200']));
    // Use Money arithmetic to avoid float string concatenation bugs.
    const { toAmountString, Money } = await import('@/lib/money');
    expect(arMid.balance).toBe(toAmountString(Money.of(balanceBefore).plus(999)));

    await voidInvoice(ctx, invoice.id);

    // Balance should be back to what it was before.
    const [arAfter] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, acct['1200']));
    expect(arAfter.balance).toBe(balanceBefore);

    // Voided invoice status.
    const voided = await getInvoice(ctx, invoice.id);
    expect(voided.status).toBe('void');
    expect(voided.balanceDue).toBe('0.00');

    // Trial balance stays balanced.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: double-void is a CONFLICT error
  // -------------------------------------------------------------------------
  it('voiding an already-voided invoice throws CONFLICT', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-21'),
      lines: [{ accountId: acct['4000'], description: 'Void twice', quantity: 1, rate: 100 }],
    });
    await voidInvoice(ctx, invoice.id);
    await expect(voidInvoice(ctx, invoice.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // -------------------------------------------------------------------------
  // Test 8: markPaidAmount / partial then paid status
  // -------------------------------------------------------------------------
  it('markPaidAmount transitions status from open → partial → paid', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-25'),
      lines: [{ accountId: acct['4000'], description: 'Payment test', quantity: 1, rate: 400 }],
    });
    expect(invoice.total).toBe('400.00');
    expect(invoice.status).toBe('open');

    const partial = await markPaidAmount(ctx, invoice.id, 150);
    expect(partial.amountPaid).toBe('150.00');
    expect(partial.balanceDue).toBe('250.00');
    expect(partial.status).toBe('partial');

    const paid = await markPaidAmount(ctx, invoice.id, 250);
    expect(paid.amountPaid).toBe('400.00');
    expect(paid.balanceDue).toBe('0.00');
    expect(paid.status).toBe('paid');
  });

  // -------------------------------------------------------------------------
  // Test 9: invoice number auto-increments
  // -------------------------------------------------------------------------
  it('invoice numbers are sequential per company', async () => {
    const all = await listInvoices(ctx);
    const nums = all.map((i) => i.invoiceNumber).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: full trial balance balanced after all operations
  // -------------------------------------------------------------------------
  it('trial balance is balanced after all invoice operations', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  // -------------------------------------------------------------------------
  // Test 11: credit limit enforcement
  // -------------------------------------------------------------------------
  it('rejects an invoice that would exceed the customer credit limit', async () => {
    // Create a customer with a $500 credit limit.
    const [limitedCust] = await db
      .insert(customers)
      .values({
        companyId: ctx.companyId,
        displayName: 'Limited Customer',
        taxable: false,
        creditLimit: '500.00',
      })
      .returning();

    // First invoice for $400 — within limit.
    await createInvoice(ctx, {
      customerId: limitedCust.id,
      date: new Date('2025-04-01'),
      lines: [{ accountId: acct['4000'], description: 'First charge', quantity: 1, rate: 400 }],
    });

    // Second invoice for $200 — outstanding $400 + new $200 = $600 > $500 limit.
    await expect(
      createInvoice(ctx, {
        customerId: limitedCust.id,
        date: new Date('2025-04-02'),
        lines: [{ accountId: acct['4000'], description: 'Over limit', quantity: 1, rate: 200 }],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/^Credit limit exceeded/),
      details: { warning: 'CREDIT_LIMIT', creditLimit: '500.00', currentBalance: '400.00', newBalance: '600.00', overBy: '100.00' },
    });

    // Trial balance must still be balanced (the failed invoice should not have posted).
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);

    // wave2 sales (C2): QB warns, it does not block — the user may save anyway, and the
    // override is recorded in the audit trail.
    const overridden = await createInvoice(ctx, {
      customerId: limitedCust.id,
      date: new Date('2025-04-02'),
      overrideCreditLimit: true,
      lines: [{ accountId: acct['4000'], description: 'Over limit', quantity: 1, rate: 200 }],
    });
    expect(overridden.total).toBe('200.00');
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, overridden.id), eq(auditLogs.entityType, 'invoice')));
    expect(
      audits.some((a) => (a.newValues as { creditLimitOverride?: { overBy?: string } } | null)?.creditLimitOverride?.overBy === '100.00'),
    ).toBe(true);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12: percent discount math
  // -------------------------------------------------------------------------
  it('computes percent discount correctly and keeps the entry balanced', async () => {
    // subtotal = 5 * 200 = 1000, 10% discount = 100, total = 900
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-10'),
      lines: [{ accountId: acct['4000'], description: 'Bulk order', quantity: 5, rate: 200 }],
      discount: 10,
      discountType: 'percent',
    });

    expect(invoice.subtotal).toBe('1000.00');
    // Stored discount is the resolved dollar amount (10% of 1000).
    expect(invoice.discount).toBe('100.00');
    expect(invoice.discountType).toBe('percent');
    expect(invoice.total).toBe('900.00');
    expect(invoice.balanceDue).toBe('900.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 13: foreign currency invoice — GL posted in base currency
  // -------------------------------------------------------------------------
  it('converts a foreign-currency invoice to base currency in the GL (trial balance balanced)', async () => {
    // 200 EUR at 1.10 USD/EUR => GL amounts are all in USD.
    // subtotal (EUR) = 2 * 100 = 200, no tax, no discount
    // exchangeRate = 1.10
    // GL AR debit (USD)     = 200 * 1.10 = 220.00
    // GL income credit (USD) = 200 * 1.10 = 220.00 => balanced
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-15'),
      currency: 'EUR',
      exchangeRate: 1.10,
      lines: [{ accountId: acct['4000'], description: 'EUR services', quantity: 2, rate: 100 }],
    });

    // Invoice fields are stored in transaction currency (EUR).
    expect(invoice.subtotal).toBe('200.00');
    expect(invoice.total).toBe('200.00');
    expect(invoice.currency).toBe('EUR');
    // exchangeRate is stored as decimal(18,8) so compare numerically.
    expect(parseFloat(invoice.exchangeRate!)).toBeCloseTo(1.10, 2);

    // Verify the journal entry lines are in base currency (USD).
    const [je] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, invoice.postedEntryId!));
    expect(je).toBeTruthy();

    const jeLines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, je.id));

    // Sum debits and credits in GL — should be 220.00 each.
    const totalDebit = jeLines.reduce((s, l) => s.plus(Money.of(l.debit)), Money.zero());
    const totalCredit = jeLines.reduce((s, l) => s.plus(Money.of(l.credit)), Money.zero());
    expect(totalDebit.toFixed(2)).toBe('220.00');
    expect(totalCredit.toFixed(2)).toBe('220.00');

    // Trial balance stays balanced.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
