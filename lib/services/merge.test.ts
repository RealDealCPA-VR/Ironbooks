/**
 * Integration tests for the merge service.
 *
 * Boots a throwaway PGlite instance, seeds users + companies, then exercises
 * mergeCustomers and mergeVendors. Asserts:
 *   - Documents on the 'from' record are reassigned to the 'to' record.
 *   - The 'from' record is deactivated after the merge.
 *   - The 'to' record remains active.
 *   - Self-merges are rejected.
 *   - Cross-company merges are rejected (NOT_FOUND guard).
 *   - Trial balance stays balanced throughout (merge does not touch the GL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers as customersTable,
  vendors as vendorsTable,
  invoices,
  bills,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { mergeCustomers, mergeVendors } from './merge';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-merge-svc');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext; // second company for isolation tests
const acct: Record<string, string> = {};

describe('merge service (integration)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // ---- Company A ----
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@merge.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Merge Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Accounts needed to satisfy postJournalEntry for the trial balance assertion.
    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Operating Expenses', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // ---- Company B (for cross-company isolation checks) ----
    const [user2] = await db
      .insert(users)
      .values({ email: 'owner2@merge.test', name: 'Owner 2', passwordHash: 'x' })
      .returning();
    const [company2] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: user2.id })
      .returning();
    ctx2 = { db, companyId: company2.id, userId: user2.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // mergeCustomers — happy path
  // -------------------------------------------------------------------------

  it('reassigns invoices from the from-customer to the to-customer', async () => {
    const from = await createCustomer(ctx, { displayName: 'Dupe Customer A' });
    const to = await createCustomer(ctx, { displayName: 'Master Customer A' });

    // Insert an invoice on the from-customer directly (minimal required fields only).
    const [inv] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId: from.id,
        invoiceNumber: 1001,
        date: new Date('2025-01-15'),
        status: 'open',
        subtotal: '500.00',
        taxAmount: '0.00',
        total: '500.00',
        amountPaid: '0.00',
        balanceDue: '500.00',
      })
      .returning();

    const result = await mergeCustomers(ctx, { fromId: from.id, toId: to.id });

    // The merge result should report 1 reassigned invoice.
    const reassigned = result.reassigned as {
      invoices: number;
      paymentsReceived: number;
      estimates: number;
      creditMemos: number;
      salesOrders: number;
    };
    expect(reassigned.invoices).toBe(1);
    expect(result.deactivatedId).toBe(from.id);

    // The invoice must now belong to the to-customer.
    const [updated] = await db
      .select({ customerId: invoices.customerId })
      .from(invoices)
      .where(eq(invoices.id, inv.id));
    expect(updated.customerId).toBe(to.id);
  });

  it('deactivates the from-customer after merge', async () => {
    const from = await createCustomer(ctx, { displayName: 'Dupe Customer B' });
    const to = await createCustomer(ctx, { displayName: 'Master Customer B' });

    await mergeCustomers(ctx, { fromId: from.id, toId: to.id });

    const [fromRow] = await db
      .select({ isActive: customersTable.isActive })
      .from(customersTable)
      .where(eq(customersTable.id, from.id));
    expect(fromRow.isActive).toBe(false);

    // The to-customer must still be active.
    const [toRow] = await db
      .select({ isActive: customersTable.isActive })
      .from(customersTable)
      .where(eq(customersTable.id, to.id));
    expect(toRow.isActive).toBe(true);
  });

  it('rejects a self-merge for customers', async () => {
    const c = await createCustomer(ctx, { displayName: 'Self Merge Customer' });
    await expect(mergeCustomers(ctx, { fromId: c.id, toId: c.id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects merge when fromId belongs to another company', async () => {
    const foreign = await createCustomer(ctx2, { displayName: 'Foreign Customer' });
    const local = await createCustomer(ctx, { displayName: 'Local Customer X' });

    await expect(
      mergeCustomers(ctx, { fromId: foreign.id, toId: local.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects merge when toId belongs to another company', async () => {
    const local = await createCustomer(ctx, { displayName: 'Local Customer Y' });
    const foreign = await createCustomer(ctx2, { displayName: 'Foreign Customer 2' });

    await expect(
      mergeCustomers(ctx, { fromId: local.id, toId: foreign.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // mergeVendors — happy path
  // -------------------------------------------------------------------------

  it('reassigns bills from the from-vendor to the to-vendor', async () => {
    const from = await createVendor(ctx, { displayName: 'Dupe Vendor A' });
    const to = await createVendor(ctx, { displayName: 'Master Vendor A' });

    // Insert a bill on the from-vendor.
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId: from.id,
        date: new Date('2025-02-10'),
        status: 'open',
        total: '250.00',
        amountPaid: '0.00',
        balanceDue: '250.00',
      })
      .returning();

    const result = await mergeVendors(ctx, { fromId: from.id, toId: to.id });

    const reassigned = result.reassigned as {
      bills: number;
      billPayments: number;
      expenses: number;
      vendorCredits: number;
      purchaseOrders: number;
    };
    expect(reassigned.bills).toBe(1);
    expect(result.deactivatedId).toBe(from.id);

    // The bill must now belong to the to-vendor.
    const [updated] = await db
      .select({ vendorId: bills.vendorId })
      .from(bills)
      .where(eq(bills.id, bill.id));
    expect(updated.vendorId).toBe(to.id);
  });

  it('deactivates the from-vendor after merge', async () => {
    const from = await createVendor(ctx, { displayName: 'Dupe Vendor B' });
    const to = await createVendor(ctx, { displayName: 'Master Vendor B' });

    await mergeVendors(ctx, { fromId: from.id, toId: to.id });

    const [fromRow] = await db
      .select({ isActive: vendorsTable.isActive })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, from.id));
    expect(fromRow.isActive).toBe(false);

    const [toRow] = await db
      .select({ isActive: vendorsTable.isActive })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, to.id));
    expect(toRow.isActive).toBe(true);
  });

  it('rejects a self-merge for vendors', async () => {
    const v = await createVendor(ctx, { displayName: 'Self Merge Vendor' });
    await expect(mergeVendors(ctx, { fromId: v.id, toId: v.id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects vendor merge when fromId belongs to another company', async () => {
    const foreign = await createVendor(ctx2, { displayName: 'Foreign Vendor' });
    const local = await createVendor(ctx, { displayName: 'Local Vendor X' });

    await expect(
      mergeVendors(ctx, { fromId: foreign.id, toId: local.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Trial balance stays balanced throughout
  // -------------------------------------------------------------------------

  it('trial balance remains balanced after all merge operations', async () => {
    // Post a minimal balanced entry so the trial balance has something to check.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-06-01'),
      description: 'Merge service balance check',
      lines: [
        { accountId: acct['1200'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    });

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
