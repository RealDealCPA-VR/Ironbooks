/**
 * Integration tests for the Customers service.
 *
 * Boots a throwaway PGlite instance, seeds a user + company + chart-of-accounts,
 * then exercises every public function and asserts:
 *   - CRUD operations behave correctly (create, read, update, deactivate).
 *   - Validation errors are thrown for invalid inputs.
 *   - Multi-tenant isolation: company A cannot see company B's customers.
 *   - customerBalanceSummary reads invoices.balanceDue correctly.
 *   - Trial balance stays balanced throughout (customers are master data — no GL impact).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, invoices, customers as customersTable } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deactivateCustomer,
  customerBalanceSummary,
} from './customers';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-customers');
let ctx: ServiceContext;
let ctx2: ServiceContext; // second company for isolation tests
let db: DB;
const acct: Record<string, string> = {};

describe('Customers service (integration)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // ----- Company A -----
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@test.local', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed just the accounts needed for posting/trial-balance checks.
    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // ----- Company B (isolation) -----
    const [user2] = await db
      .insert(users)
      .values({ email: 'owner2@test.local', name: 'Owner 2', passwordHash: 'x' })
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
  // Create
  // -------------------------------------------------------------------------

  it('creates a customer with minimal fields', async () => {
    const c = await createCustomer(ctx, { displayName: 'Acme Corp' });
    expect(c.id).toBeTruthy();
    expect(c.displayName).toBe('Acme Corp');
    expect(c.companyId).toBe(ctx.companyId);
    expect(c.isActive).toBe(true);
    expect(c.taxable).toBe(true);
    expect(c.balance).toBe('0.00');
  });

  it('creates a customer with all optional fields', async () => {
    const c = await createCustomer(ctx, {
      displayName: 'Big Client LLC',
      companyName: 'Big Client LLC',
      email: 'billing@bigclient.com',
      phone: '555-0100',
      billingAddress: { line1: '1 Main St', city: 'Anytown', state: 'CA', zip: '90001' },
      shippingAddress: { line1: '2 Dock Rd', city: 'Anytown', state: 'CA', zip: '90002' },
      terms: 'net_15',
      creditLimit: '5000.00',
      taxable: false,
      notes: 'VIP customer',
    });
    expect(c.displayName).toBe('Big Client LLC');
    expect(c.email).toBe('billing@bigclient.com');
    expect(c.terms).toBe('net_15');
    expect(c.creditLimit).toBe('5000.00');
    expect(c.taxable).toBe(false);
    expect(c.notes).toBe('VIP customer');
  });

  it('rejects blank displayName', async () => {
    await expect(createCustomer(ctx, { displayName: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects malformed email', async () => {
    await expect(
      createCustomer(ctx, { displayName: 'Bad Email Co', email: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects duplicate displayName within same company', async () => {
    await expect(createCustomer(ctx, { displayName: 'Acme Corp' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('allows same displayName in a different company', async () => {
    // Company B can have its own "Acme Corp" — no conflict.
    const c = await createCustomer(ctx2, { displayName: 'Acme Corp' });
    expect(c.companyId).toBe(ctx2.companyId);
  });

  // -------------------------------------------------------------------------
  // Sub-customer (parentId)
  // -------------------------------------------------------------------------

  it('creates a sub-customer linked to a parent', async () => {
    const parent = await createCustomer(ctx, { displayName: 'Parent Client' });
    const sub = await createCustomer(ctx, {
      displayName: 'Sub-Job Alpha',
      parentId: parent.id,
    });
    expect(sub.parentId).toBe(parent.id);
  });

  it('rejects parentId that belongs to another company', async () => {
    const [foreignCustomer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.companyId, ctx2.companyId))
      .limit(1);

    await expect(
      createCustomer(ctx, {
        displayName: 'Bad Sub',
        parentId: foreignCustomer.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  it('getCustomer returns the correct record', async () => {
    const created = await createCustomer(ctx, { displayName: 'Readable Co' });
    const fetched = await getCustomer(ctx, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.displayName).toBe('Readable Co');
  });

  it('getCustomer throws NOT_FOUND for unknown id', async () => {
    await expect(
      getCustomer(ctx, '00000000-0000-0000-0000-000000000099'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getCustomer throws NOT_FOUND for another company\'s customer', async () => {
    const [foreignCustomer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.companyId, ctx2.companyId))
      .limit(1);
    await expect(getCustomer(ctx, foreignCustomer.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('listCustomers returns only active customers by default', async () => {
    // Create and immediately deactivate a customer.
    const toDeactivate = await createCustomer(ctx, { displayName: 'Deactivate Me' });
    await deactivateCustomer(ctx, toDeactivate.id);

    const active = await listCustomers(ctx);
    expect(active.every((c) => c.isActive)).toBe(true);
    expect(active.find((c) => c.id === toDeactivate.id)).toBeUndefined();
  });

  it('listCustomers with includeInactive returns deactivated records', async () => {
    const all = await listCustomers(ctx, { includeInactive: true });
    expect(all.some((c) => !c.isActive)).toBe(true);
  });

  it('listCustomers does not return another company\'s customers', async () => {
    const list = await listCustomers(ctx);
    expect(list.every((c) => c.companyId === ctx.companyId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  it('updates mutable fields', async () => {
    const original = await createCustomer(ctx, {
      displayName: 'Mutable Corp',
      phone: '555-1111',
    });
    const updated = await updateCustomer(ctx, original.id, {
      phone: '555-9999',
      notes: 'Updated notes',
      creditLimit: 10000,
    });
    expect(updated.phone).toBe('555-9999');
    expect(updated.notes).toBe('Updated notes');
    expect(updated.creditLimit).toBe('10000.00');
    // Unchanged field preserved.
    expect(updated.displayName).toBe('Mutable Corp');
  });

  it('updateCustomer rejects setting a self-referential parentId', async () => {
    const c = await createCustomer(ctx, { displayName: 'Self Parent' });
    await expect(updateCustomer(ctx, c.id, { parentId: c.id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('updateCustomer rejects duplicate displayName collision', async () => {
    const a = await createCustomer(ctx, { displayName: 'Rename Source' });
    await createCustomer(ctx, { displayName: 'Rename Target' });
    await expect(
      updateCustomer(ctx, a.id, { displayName: 'Rename Target' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('updateCustomer allows keeping the same displayName (no false collision)', async () => {
    const c = await createCustomer(ctx, { displayName: 'Stable Name' });
    const updated = await updateCustomer(ctx, c.id, { displayName: 'Stable Name', notes: 'ok' });
    expect(updated.displayName).toBe('Stable Name');
  });

  // -------------------------------------------------------------------------
  // Deactivate
  // -------------------------------------------------------------------------

  it('deactivateCustomer soft-deletes (isActive = false)', async () => {
    const c = await createCustomer(ctx, { displayName: 'Goodbye Corp' });
    expect(c.isActive).toBe(true);

    const deactivated = await deactivateCustomer(ctx, c.id);
    expect(deactivated.isActive).toBe(false);

    // Confirm list does not return it.
    const active = await listCustomers(ctx);
    expect(active.find((x) => x.id === c.id)).toBeUndefined();
  });

  it('deactivateCustomer throws NOT_FOUND for unknown id', async () => {
    await expect(
      deactivateCustomer(ctx, '00000000-0000-0000-0000-000000000099'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // customerBalanceSummary
  // -------------------------------------------------------------------------

  it('customerBalanceSummary aggregates open invoice balances', async () => {
    const customer = await createCustomer(ctx, { displayName: 'Summary Customer' });

    // Insert two open invoices directly (bypassing the invoices service to keep
    // this test self-contained — we only care about the read side here).
    await db.insert(invoices).values([
      {
        companyId: ctx.companyId,
        customerId: customer.id,
        invoiceNumber: 9001,
        date: new Date('2025-03-01'),
        status: 'open',
        subtotal: '1000.00',
        taxAmount: '0.00',
        total: '1000.00',
        amountPaid: '200.00',
        balanceDue: '800.00',
      },
      {
        companyId: ctx.companyId,
        customerId: customer.id,
        invoiceNumber: 9002,
        date: new Date('2025-03-15'),
        status: 'partial',
        subtotal: '500.00',
        taxAmount: '0.00',
        total: '500.00',
        amountPaid: '0.00',
        balanceDue: '500.00',
      },
    ]);

    const summary = await customerBalanceSummary(ctx);
    const row = summary.find((s) => s.customerId === customer.id);
    expect(row).toBeDefined();
    expect(row!.totalBalanceDue).toBe('1300.00'); // 800 + 500
    expect(row!.openInvoiceCount).toBe(2);
    expect(row!.displayName).toBe('Summary Customer');
  });

  it('customerBalanceSummary excludes void/paid/closed invoices', async () => {
    const customer = await createCustomer(ctx, { displayName: 'Closed Invoices Customer' });

    await db.insert(invoices).values([
      {
        companyId: ctx.companyId,
        customerId: customer.id,
        invoiceNumber: 9003,
        date: new Date('2025-04-01'),
        status: 'void',
        subtotal: '999.00',
        taxAmount: '0.00',
        total: '999.00',
        amountPaid: '0.00',
        balanceDue: '999.00',
      },
      {
        companyId: ctx.companyId,
        customerId: customer.id,
        invoiceNumber: 9004,
        date: new Date('2025-04-02'),
        status: 'paid',
        subtotal: '500.00',
        taxAmount: '0.00',
        total: '500.00',
        amountPaid: '500.00',
        balanceDue: '0.00',
      },
    ]);

    const summary = await customerBalanceSummary(ctx);
    const row = summary.find((s) => s.customerId === customer.id);
    // void and paid invoices must not appear in the summary.
    expect(row).toBeUndefined();
  });

  it('customerBalanceSummary does not leak across companies', async () => {
    const foreignCustomer = await createCustomer(ctx2, { displayName: 'Foreign Customer' });
    await db.insert(invoices).values({
      companyId: ctx2.companyId,
      customerId: foreignCustomer.id,
      invoiceNumber: 8001,
      date: new Date('2025-05-01'),
      status: 'open',
      subtotal: '9999.00',
      taxAmount: '0.00',
      total: '9999.00',
      amountPaid: '0.00',
      balanceDue: '9999.00',
    });

    // Company A's summary must not include company B's customer.
    const summary = await customerBalanceSummary(ctx);
    expect(summary.find((s) => s.customerId === foreignCustomer.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Trial balance stays balanced after all customer mutations
  // -------------------------------------------------------------------------

  it('trial balance remains balanced after all customer operations', async () => {
    // Post a journal entry to give the trial balance something to validate.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-06-01'),
      description: 'Customer service balance check',
      lines: [
        { accountId: acct['1200'], debit: '2500.00' },
        { accountId: acct['4000'], credit: '2500.00' },
      ],
    });

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
