/**
 * Adversarial QA for optimistic concurrency (tester pass). Covers the document types the doer's
 * tests did not (invoice, bill, vendor, item), stale VOIDs, rollback on a failing save, viewer
 * access, a simultaneous race, wrong-entity / forged versions, and the "save twice in a row with
 * the version the server just returned" flow the UI relies on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, invoices, bills, userCompanies } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, updateInvoice, voidInvoice, getInvoice } from './invoices';
import { createBill, updateBill, voidBill, getBill } from './bills';
import { getVendor, updateVendor, deactivateVendor } from './vendors';
import { getItem, updateItem, deactivateItem } from './items';
import { getCustomer, updateCustomer } from './customers';
import { trialBalance } from './reports';
import { assertCurrentVersion, withVersionCheck } from './concurrency';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-adversarial');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
let viewer: ServiceContext;
let companyId: string;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

async function expectConflictBy(p: Promise<unknown>, who: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, 'expected a 409 CONFLICT').toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe('CONFLICT');
  expect((err as ServiceError).message).toMatch(
    new RegExp(`^This record was changed by ${who} at .+\\. Reload to see the latest\\.$`),
  );
}

describe('optimistic concurrency — adversarial', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [ua] = await db.insert(users).values({ email: 'alice@adv.local', name: 'Alice', passwordHash: 'x' }).returning();
    const [ub] = await db.insert(users).values({ email: 'bob@adv.local', name: 'Bob', passwordHash: 'x' }).returning();
    const [uv] = await db.insert(users).values({ email: 'vic@adv.local', name: 'Vic Viewer', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Adv Concurrency Co', ownerId: ua.id }).returning();
    companyId = company.id;
    await db.insert(userCompanies).values([
      { userId: ub.id, companyId, role: 'accountant' },
      { userId: uv.id, companyId, role: 'viewer' },
    ]);
    alice = { db, companyId, userId: ua.id, role: 'owner' };
    bob = { db, companyId, userId: ub.id, role: 'accountant' };
    viewer = { db, companyId, userId: uv.id, role: 'viewer' };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(alice, { code, name, type: type as never, subtype })).id;
    }
    const [cust] = await db.insert(customers).values({ companyId, displayName: 'Race Customer' }).returning();
    customerId = cust.id;
    const [ven] = await db.insert(vendors).values({ companyId, displayName: 'Race Vendor' }).returning();
    vendorId = ven.id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const invoiceInput = (rate: number) => ({
    customerId,
    date: new Date('2026-05-01'),
    lines: [{ description: 'Consulting', quantity: 1, rate, taxable: false }],
  });

  it('invoice: stale edit AND stale void are refused naming the editor; GL reflects only the winning edit', async () => {
    const inv = await createInvoice(alice, invoiceInput(100));
    const v0 = (await getInvoice(alice, inv.id)).updatedAt;

    await withVersionCheck(alice, 'invoice', inv.id, v0.toISOString(), (c) => updateInvoice(c, inv.id, invoiceInput(250)));

    await expectConflictBy(
      withVersionCheck(bob, 'invoice', inv.id, v0.toISOString(), (c) => updateInvoice(c, inv.id, invoiceInput(999))),
      'Alice',
    );
    await expectConflictBy(withVersionCheck(bob, 'invoice', inv.id, v0.toISOString(), (c) => voidInvoice(c, inv.id)), 'Alice');

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.status).not.toBe('void');
    expect(row.total).toBe('250.00');
    const tb = await trialBalance(alice);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('bill: stale edit AND stale void are refused naming the editor; bill unchanged', async () => {
    const bill = await createBill(alice, {
      vendorId,
      billNumber: 'ADV-1',
      date: new Date('2026-05-02'),
      lines: [{ accountId: acct['6300'], description: 'Paper', amount: '40.00' }],
    });
    const v0 = (await getBill(alice, bill.id)).updatedAt;
    const edit = (amount: string) => ({
      vendorId,
      billNumber: 'ADV-1',
      date: new Date('2026-05-02'),
      lines: [{ accountId: acct['6300'], description: 'Paper', amount }],
    });
    await withVersionCheck(bob, 'bill', bill.id, v0, (c) => updateBill(c, bill.id, edit('45.00')));
    await expectConflictBy(withVersionCheck(alice, 'bill', bill.id, v0, (c) => updateBill(c, bill.id, edit('1.00'))), 'Bob');
    await expectConflictBy(withVersionCheck(alice, 'bill', bill.id, v0, (c) => voidBill(c, bill.id)), 'Bob');
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.total).toBe('45.00');
    expect(row.status).not.toBe('void');
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('vendor: a stale deactivate is refused and the vendor stays active', async () => {
    const v0 = (await getVendor(alice, vendorId)).updatedAt;
    await withVersionCheck(alice, 'vendor', vendorId, v0, (c) => updateVendor(c, vendorId, { phone: '555-0100' }));
    await expectConflictBy(withVersionCheck(bob, 'vendor', vendorId, v0, (c) => deactivateVendor(c, vendorId)), 'Alice');
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    expect(row.isActive).toBe(true);
  });

  it('item: stale edit refused naming the editor', async () => {
    const [it0] = await db.insert(items).values({ companyId, name: 'Gadget', type: 'service', salesPrice: '10.00', incomeAccountId: acct['4000'] }).returning();
    const v0 = (await getItem(alice, it0.id)).updatedAt;
    await withVersionCheck(bob, 'item', it0.id, v0, (c) => updateItem(c, it0.id, { salesPrice: '12.00' }));
    await expectConflictBy(withVersionCheck(alice, 'item', it0.id, v0, (c) => updateItem(c, it0.id, { name: 'Gizmo' })), 'Bob');
    expect((await getItem(alice, it0.id)).name).toBe('Gadget');
  });

  it('rollback: a save that fails validation leaves the version untouched (retry is not a false 409)', async () => {
    const [it1] = await db.insert(items).values({ companyId, name: 'Rollback Item', type: 'service', salesPrice: '5.00', incomeAccountId: acct['4000'] }).returning();
    const v0 = (await getItem(alice, it1.id)).updatedAt;
    await expect(
      withVersionCheck(alice, 'item', it1.id, v0, (c) => updateItem(c, it1.id, { name: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const after = await getItem(alice, it1.id);
    expect(after.updatedAt.getTime()).toBe(v0.getTime());
    expect(after.name).toBe('Rollback Item');
    // Same version, valid input → succeeds.
    await withVersionCheck(alice, 'item', it1.id, v0, (c) => updateItem(c, it1.id, { name: 'Rollback Item 2' }));
    expect((await getItem(alice, it1.id)).name).toBe('Rollback Item 2');
  });

  it('rollback: a throw AFTER the service wrote leaves neither data nor version changed', async () => {
    const c0 = await getCustomer(alice, customerId);
    await expect(
      withVersionCheck(alice, 'customer', customerId, c0.updatedAt, async (c) => {
        await updateCustomer(c, customerId, { notes: 'half-written' });
        throw new ServiceError('VALIDATION', 'boom');
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const c1 = await getCustomer(alice, customerId);
    expect(c1.notes).toBe(c0.notes);
    expect(c1.updatedAt.getTime()).toBe(c0.updatedAt.getTime());
  });

  it('a viewer gets FORBIDDEN (never a write, never a leaked conflict) with or without a version', async () => {
    const c0 = await getCustomer(alice, customerId);
    await expect(
      withVersionCheck(viewer, 'customer', customerId, c0.updatedAt, (c) => updateCustomer(c, customerId, { notes: 'viewer' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      withVersionCheck(viewer, 'customer', customerId, new Date(0), (c) => updateCustomer(c, customerId, { notes: 'viewer' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getCustomer(alice, customerId)).notes).toBe(c0.notes);
  });

  it('two simultaneous saves from the same loaded version: exactly one wins', async () => {
    const c0 = await getCustomer(alice, customerId);
    const results = await Promise.allSettled([
      withVersionCheck(alice, 'customer', customerId, c0.updatedAt.toISOString(), (c) => updateCustomer(c, customerId, { notes: 'A' })),
      withVersionCheck(bob, 'customer', customerId, c0.updatedAt.toISOString(), (c) => updateCustomer(c, customerId, { notes: 'B' })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect(bad[0].reason).toMatchObject({ code: 'CONFLICT' });
  });

  it('forged versions: a future, an epoch and a wrong-entity id are refused, never treated as current', async () => {
    const c0 = await getCustomer(alice, customerId);
    await expect(assertCurrentVersion(alice, 'customer', customerId, new Date(c0.updatedAt.getTime() + 60_000))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assertCurrentVersion(alice, 'customer', customerId, '1970-01-01T00:00:00.000Z')).rejects.toMatchObject({ code: 'CONFLICT' });
    // A customer id checked as a vendor must not resolve to anything.
    await expect(assertCurrentVersion(alice, 'vendor', customerId, c0.updatedAt)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('UI flow: saving again with the version the server RETURNED never conflicts with yourself', async () => {
    // The client caches the record returned by each save as the next expected version.
    // Freeze the clock so the save lands in the same millisecond as the load (or the clock
    // stepped back) — the server's version bump must be reflected in what it returns.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const [it2] = await db
        .insert(items)
        .values({ companyId, name: 'Frozen Clock Item', type: 'service', salesPrice: '1.00', incomeAccountId: acct['4000'], updatedAt: new Date() })
        .returning();
      // An item's version is its editedAt (0067), as lib/client.ts versionOf reads it.
      let version: Date = (await getItem(alice, it2.id)).editedAt;
      for (const price of ['2.00', '3.00', '4.00']) {
        const saved = await withVersionCheck(alice, 'item', it2.id, version.toISOString(), (c) =>
          updateItem(c, it2.id, { salesPrice: price }),
        );
        version = saved.editedAt;
      }
      expect((await getItem(alice, it2.id)).salesPrice).toBe('4.00');
    } finally {
      vi.useRealTimers();
    }
  });
});
