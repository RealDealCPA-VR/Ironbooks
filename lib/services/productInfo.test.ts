/**
 * QuickBooks' Product Information window (F2 / Ctrl+1): what the open company file holds — list
 * totals and the number of transactions — counted for this company only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createClass } from './dimensions';
import { createManualEntry } from './journal';
import { productInfoCounts } from './productInfo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-keyboard-product-info');
let db: DB;
let mine: ServiceContext;
let other: ServiceContext;

async function company(name: string): Promise<ServiceContext> {
  const [user] = await db.insert(users).values({ email: `${name}@product-info.test`, name, passwordHash: 'x' }).returning();
  const [co] = await db.insert(companies).values({ name, ownerId: user.id }).returning();
  return { db, companyId: co.id, userId: user.id };
}

describe('Product Information counts (F2)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    mine = await company('Mine');
    other = await company('Other');
    const cash = await createAccount(mine, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
    const equity = await createAccount(mine, { code: '3000', name: 'Owner Equity', type: 'equity', subtype: 'owners_equity' });
    await createCustomer(mine, { displayName: 'Acme' } as never);
    await createCustomer(mine, { displayName: 'Baker' } as never);
    await createVendor(mine, { displayName: 'Ferguson' } as never);
    await createClass(mine, { name: 'East' });
    await createManualEntry(mine, {
      date: new Date('2026-10-20T00:00:00Z'),
      description: 'Owner put money in',
      lines: [
        { accountId: cash.id, debit: '500.00' },
        { accountId: equity.id, credit: '500.00' },
      ],
    });
    // Another company in the same file: none of it may count.
    await createAccount(other, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
    await createCustomer(other, { displayName: 'Someone else' } as never);
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it("counts this company's lists and transactions, and Total Names adds every kind of name", async () => {
    const c = await productInfoCounts(mine);
    expect(c.accounts).toBe(2);
    expect(c.customers).toBe(2);
    expect(c.vendors).toBe(1);
    expect(c.employees).toBe(0);
    expect(c.otherNames).toBe(0);
    expect(c.names).toBe(3);
    expect(c.classes).toBe(1);
    expect(c.items).toBe(0);
    expect(c.transactions).toBe(1);
  });

  it("another company's records never count", async () => {
    const c = await productInfoCounts(other);
    expect(c.accounts).toBe(1);
    expect(c.customers).toBe(1);
    expect(c.names).toBe(1);
    expect(c.transactions).toBe(0);
  });
});
