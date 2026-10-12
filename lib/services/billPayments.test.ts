/**
 * Integration tests for billPayments.ts (Pay Bills — A/P).
 *
 * Boot pattern mirrors accounting.integration.test.ts:
 *  - Spin up a throwaway PGlite dir under .bookkeeper-data/test-bill-payments
 *  - Seed user + company + accounts
 *  - Create a vendor + bill, pay it, verify GL and trial balance stay balanced
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, vendors, bills, billLines, billPaymentApplications } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { payBills, listBillPayments } from './billPayments';
import { ServiceError } from './_base';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bill-payments');
let ctx: ServiceContext;
let db: DB;

// Account IDs keyed by code
const acct: Record<string, string> = {};
let vendorId: string;
let billId: string;
let apAccountId: string; // code '2000'

describe('Bill Payments (A/P) — end-to-end', () => {
  // ── setup ────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // Seed user + company
    const [user] = await db
      .insert(users)
      .values({ email: 'ap-test@bookkeeper.local', name: 'AP Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'AP Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed chart of accounts (only what we need)
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['5000', 'Office Supplies Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
    apAccountId = acct['2000'];

    // Seed a vendor
    const [v] = await db
      .insert(vendors)
      .values({
        companyId: company.id,
        displayName: 'Staples Vendor',
      })
      .returning();
    vendorId = v.id;

    // Create a bill via the GL directly (simulating what the bills service does):
    // Dr Expense 5000, Cr A/P 2000 — $500 bill
    const entry = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-01'),
      description: 'Bill: office supplies',
      lines: [
        { accountId: acct['5000'], debit: '500.00' },
        { accountId: acct['2000'], credit: '500.00' },
      ],
    });

    // Insert the bills record (mirroring what a bills service would do)
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: company.id,
        vendorId,
        billNumber: 'BILL-001',
        date: new Date('2025-03-01'),
        dueDate: new Date('2025-04-01'),
        status: 'open',
        total: '500.00',
        amountPaid: '0.00',
        balanceDue: '500.00',
        postedEntryId: entry.id,
      })
      .returning();
    billId = bill.id;

    // Insert a bill line (required for full schema integrity)
    await db.insert(billLines).values({
      billId: bill.id,
      accountId: acct['5000'],
      description: 'Office supplies',
      quantity: '1',
      amount: '500.00',
    });
  });

  // ── teardown ─────────────────────────────────────────────────────────────
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── tests ─────────────────────────────────────────────────────────────────

  it('rejects payment with no applications', async () => {
    await expect(
      payBills(ctx, {
        vendorId,
        date: new Date('2025-03-15'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects payment that exceeds the bill balance due', async () => {
    await expect(
      payBills(ctx, {
        vendorId,
        date: new Date('2025-03-15'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId, amountApplied: '600.00' }], // more than $500 balance
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects payment for a bill belonging to the wrong vendor', async () => {
    // Create a second vendor + bill to verify cross-vendor guard
    const [v2] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Wrong Vendor' })
      .returning();
    const e2 = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-02'),
      description: 'Bill: wrong vendor',
      lines: [
        { accountId: acct['5000'], debit: '100.00' },
        { accountId: acct['2000'], credit: '100.00' },
      ],
    });
    const [bill2] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId: v2.id, // different vendor
        date: new Date('2025-03-02'),
        status: 'open',
        total: '100.00',
        amountPaid: '0.00',
        balanceDue: '100.00',
        postedEntryId: e2.id,
      })
      .returning();

    await expect(
      payBills(ctx, {
        vendorId,           // original vendor
        date: new Date('2025-03-15'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill2.id, amountApplied: '100.00' }], // bill2 belongs to v2
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('pays the bill in full, clears A/P, and keeps the trial balance balanced', async () => {
    const payment = await payBills(ctx, {
      vendorId,
      date: new Date('2025-03-15'),
      method: 'check',
      reference: 'CHK-1001',
      paymentAccountId: acct['1000'],
      applications: [{ billId, amountApplied: '500.00' }],
    });

    // Payment record created with correct amount and GL link
    expect(payment.amount).toBe('500.00');
    expect(payment.vendorId).toBe(vendorId);
    expect(payment.postedEntryId).toBeTruthy();
    expect(payment.companyId).toBe(ctx.companyId);

    // Bill should be marked paid, balance zeroed
    const [updatedBill] = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.companyId, ctx.companyId)));
    expect(updatedBill.status).toBe('paid');
    expect(updatedBill.amountPaid).toBe('500.00');
    expect(updatedBill.balanceDue).toBe('0.00');

    // Application row created
    const [appRow] = await db
      .select()
      .from(billPaymentApplications)
      .where(eq(billPaymentApplications.billPaymentId, payment.id));
    expect(appRow).toBeTruthy();
    expect(appRow.amountApplied).toBe('500.00');
    expect(appRow.billId).toBe(billId);

    // A/P net for the original $500 bill should now be zero (bill Cr 500, payment Dr 500).
    // The "wrong vendor" test above also posted a valid bill GL entry (Cr A/P 100 for bill2),
    // so the running cached balance at this point is 100 (= 500 bill - 500 payment + 100 bill2).
    // We verify the original bill's own contribution via the trial balance instead, which
    // reflects the correct aggregate state across all posted entries.
    const [apRow] = await db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.id, apAccountId));
    // bill (Cr 500) + bill2 (Cr 100) - payment (Dr 500) = net credit of 100 on A/P
    expect(apRow?.balance).toBe('100.00');

    // Trial balance must remain balanced
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('supports partial bill payment', async () => {
    // Create a second bill for $300
    const e3 = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-04-01'),
      description: 'Bill: partial test',
      lines: [
        { accountId: acct['5000'], debit: '300.00' },
        { accountId: acct['2000'], credit: '300.00' },
      ],
    });
    const [bill3] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2025-04-01'),
        status: 'open',
        total: '300.00',
        amountPaid: '0.00',
        balanceDue: '300.00',
        postedEntryId: e3.id,
      })
      .returning();

    // Pay only $100 of the $300 bill
    await payBills(ctx, {
      vendorId,
      date: new Date('2025-04-10'),
      method: 'ach',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill3.id, amountApplied: '100.00' }],
    });

    const [partialBill] = await db
      .select()
      .from(bills)
      .where(eq(bills.id, bill3.id));
    expect(partialBill.status).toBe('partial');
    expect(partialBill.amountPaid).toBe('100.00');
    expect(partialBill.balanceDue).toBe('200.00');

    // Trial balance still balanced after partial payment
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('listBillPayments returns payments scoped to the company', async () => {
    const payments = await listBillPayments(ctx);
    // We made 2 payments above (full + partial)
    expect(payments.length).toBeGreaterThanOrEqual(2);
    for (const p of payments) {
      expect(p.companyId).toBe(ctx.companyId);
    }
  });

  it('listBillPayments filters by vendorId', async () => {
    const payments = await listBillPayments(ctx, { vendorId });
    expect(payments.length).toBeGreaterThanOrEqual(2);
    for (const p of payments) {
      expect(p.vendorId).toBe(vendorId);
    }
  });

  it('rejects payment for a bill that is already fully paid', async () => {
    // billId was fully paid in the "pays the bill in full" test
    await expect(
      payBills(ctx, {
        vendorId,
        date: new Date('2025-03-20'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId, amountApplied: '1.00' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
