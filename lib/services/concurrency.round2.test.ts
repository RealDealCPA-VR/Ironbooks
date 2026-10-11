/**
 * Re-test round 1 (tester): withVersionCheck must hand back the version actually stored, for
 * every versioned document, so the UI's next save never conflicts with itself — including when
 * the clock is frozen / steps back. Also: result-shape patching edge cases and journal-entry
 * edits (void + repost under a new id).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, invoices, bills, journalEntries, userCompanies } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, updateInvoice } from './invoices';
import { createBill, updateBill } from './bills';
import { updateVendor } from './vendors';
import { updateItem, deactivateItem } from './items';
import { updateCustomer } from './customers';
import { createManualEntry, updateEntry } from './journal';
import { trialBalance } from './reports';
import { withVersionCheck, type VersionedEntity } from './concurrency';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-round2');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
let companyId: string;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

const TABLE = { invoice: invoices, bill: bills, journal_entry: journalEntries, customer: customers, vendor: vendors, item: items } as const;

async function storedVersion(entity: VersionedEntity, id: string): Promise<Date> {
  const t = TABLE[entity] as unknown as typeof customers;
  const [row] = await db.select({ updatedAt: t.updatedAt }).from(t).where(eq(t.id, id));
  return row.updatedAt;
}

/** The record the route would serialize: top level or one level down. */
function returnedVersion(result: unknown, id: string): Date | undefined {
  const r = result as Record<string, unknown>;
  if (r && r.id === id && r.updatedAt instanceof Date) return r.updatedAt;
  for (const v of Object.values(r ?? {})) {
    const o = v as Record<string, unknown>;
    if (o && typeof o === 'object' && o.id === id && o.updatedAt instanceof Date) return o.updatedAt;
  }
  return undefined;
}

describe('optimistic concurrency — re-test round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [ua] = await db.insert(users).values({ email: 'alice@r2c.local', name: 'Alice', passwordHash: 'x' }).returning();
    const [ub] = await db.insert(users).values({ email: 'bob@r2c.local', name: 'Bob', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R2 Concurrency Co', ownerId: ua.id }).returning();
    companyId = company.id;
    await db.insert(userCompanies).values([
      { userId: ua.id, companyId, role: 'owner' },
      { userId: ub.id, companyId, role: 'accountant' },
    ]);
    alice = { db, companyId, userId: ua.id, role: 'owner' };
    bob = { db, companyId, userId: ub.id, role: 'accountant' };
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
    customerId = (await db.insert(customers).values({ companyId, displayName: 'R2 Customer' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId, displayName: 'R2 Vendor' }).returning())[0].id;
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
  const billInput = (amount: string) => ({
    vendorId,
    billNumber: 'R2-1',
    date: new Date('2026-05-02'),
    lines: [{ accountId: acct['6300'], description: 'Paper', amount }],
  });

  /**
   * Save three times in a row, each time with the version the previous save RETURNED, under a
   * frozen clock; the returned version must also equal what is stored.
   */
  async function saveChain(entity: VersionedEntity, id: string, saves: Array<(c: ServiceContext) => Promise<unknown>>) {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-01T09:00:00.000Z'));
      let version = (await storedVersion(entity, id)).toISOString();
      for (const save of saves) {
        const result = await withVersionCheck(alice, entity, id, version, save);
        const v = returnedVersion(result, id);
        expect(v, `${entity}: save must return the record with its version`).toBeInstanceOf(Date);
        expect(v!.getTime(), `${entity}: returned version must be the stored one`).toBe((await storedVersion(entity, id)).getTime());
        version = v!.toISOString();
      }
    } finally {
      vi.useRealTimers();
    }
  }

  it('customer: frozen-clock save chain never conflicts with itself', async () => {
    await saveChain('customer', customerId, ['a', 'b', 'c'].map((n) => (c) => updateCustomer(c, customerId, { notes: n })));
  });

  it('vendor: frozen-clock save chain never conflicts with itself', async () => {
    await saveChain('vendor', vendorId, ['1', '2', '3'].map((n) => (c) => updateVendor(c, vendorId, { phone: `555-000${n}` })));
  });

  it('invoice: frozen-clock save chain never conflicts with itself and the books stay balanced', async () => {
    const inv = await createInvoice(alice, invoiceInput(100));
    await saveChain('invoice', inv.id, [110, 120, 130].map((r) => (c) => updateInvoice(c, inv.id, invoiceInput(r))));
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.total).toBe('130.00');
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('bill: frozen-clock save chain never conflicts with itself', async () => {
    const bill = await createBill(alice, billInput('10.00'));
    await saveChain('bill', bill.id, ['11.00', '12.00', '13.00'].map((a) => (c) => updateBill(c, bill.id, billInput(a))));
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.total).toBe('13.00');
  });

  it('item: edit then deactivate under a frozen clock — the deactivate uses the returned version', async () => {
    const [it0] = await db
      .insert(items)
      .values({ companyId, name: 'R2 Item', type: 'service', salesPrice: '1.00', incomeAccountId: acct['4000'] })
      .returning();
    await saveChain('item', it0.id, [(c) => updateItem(c, it0.id, { salesPrice: '2.00' }), (c) => deactivateItem(c, it0.id)]);
    const [row] = await db.select().from(items).where(eq(items.id, it0.id));
    expect(row.isActive).toBe(false);
  });

  it('after Bob saves, Alice\'s save with her (now stale) RETURNED version still conflicts — patching never hides a real conflict', async () => {
    const r1 = await withVersionCheck(alice, 'customer', customerId, await storedVersion('customer', customerId), (c) =>
      updateCustomer(c, customerId, { notes: 'alice-1' }),
    );
    const mine = returnedVersion(r1, customerId)!;
    await withVersionCheck(bob, 'customer', customerId, mine, (c) => updateCustomer(c, customerId, { notes: 'bob-1' }));
    const err = await withVersionCheck(alice, 'customer', customerId, mine, (c) => updateCustomer(c, customerId, { notes: 'alice-2' })).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/changed by Bob/);
  });

  it('result patching: wrapped records are patched, foreign ids and non-records pass through unchanged', async () => {
    const v = await storedVersion('customer', customerId);
    const sentinel = new Date('2001-01-01T00:00:00.000Z');
    const wrapped = await withVersionCheck(alice, 'customer', customerId, v, async () => ({
      customer: { id: customerId, updatedAt: sentinel },
      other: { id: 'someone-else', updatedAt: sentinel },
      list: [{ id: customerId, updatedAt: sentinel }],
    }));
    const now = await storedVersion('customer', customerId);
    expect(wrapped.customer.updatedAt.getTime()).toBe(now.getTime());
    expect(wrapped.other.updatedAt).toBe(sentinel);
    expect(wrapped.list[0].updatedAt).toBe(sentinel);

    const foreign = await withVersionCheck(alice, 'customer', customerId, now, async () => ({ id: 'replacement-id', updatedAt: sentinel }));
    expect(foreign.updatedAt).toBe(sentinel);
    const nothing = await withVersionCheck(alice, 'customer', customerId, await storedVersion('customer', customerId), async () => undefined);
    expect(nothing).toBeUndefined();
    const arr = await withVersionCheck(alice, 'customer', customerId, await storedVersion('customer', customerId), async () => [1, 2]);
    expect(arr).toEqual([1, 2]);
  });

  it('journal entry: a stale edit of an entry someone already edited (void + repost) is a 409 naming them; GL posted once', async () => {
    const je = await createManualEntry(alice, {
      date: new Date('2026-05-10'),
      description: 'Owner contribution',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['3000'], credit: '500.00' },
      ],
    } as never);
    const v0 = await storedVersion('journal_entry', je.id);
    const edit = (amt: string) => (c: ServiceContext) =>
      updateEntry(c, je.id, {
        date: new Date('2026-05-10'),
        description: 'Owner contribution',
        lines: [
          { accountId: acct['1000'], debit: amt },
          { accountId: acct['3000'], credit: amt },
        ],
      } as never);
    const replacement = await withVersionCheck(alice, 'journal_entry', je.id, v0, edit('600.00'));
    expect(replacement.id).not.toBe(je.id);
    const err = await withVersionCheck(bob, 'journal_entry', je.id, v0, edit('700.00')).catch((e) => e);
    expect(err?.code).toBe('CONFLICT');
    expect(err.message).toMatch(/changed by Alice/);

    const posted = await db.select().from(journalEntries).where(eq(journalEntries.companyId, companyId));
    const live = posted.filter((e) => e.status === 'posted' && e.description === 'Owner contribution');
    expect(live).toHaveLength(1);
    const tb = await trialBalance(alice);
    expect(tb.balanced).toBe(true);
  });
});
