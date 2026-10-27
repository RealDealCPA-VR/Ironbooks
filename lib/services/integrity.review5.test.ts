/**
 * Round-5 review regression (Verify Data): the A/R check compares EVERY Accounts Receivable
 * account (by account type) with the open invoices, credits and General Journal items — like the
 * month-end aging step and the balance sheet. It only looked at the account numbered 1200 (and
 * was skipped when there was none), so a second A/R account — the QuickBooks A/R a converted
 * chart brings along ("11000 Accounts Receivable") — could hold amounts no invoice or customer
 * explains while Verify Data reported the books healthy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { users, accounts } from '@/lib/db/schema';
import { createCompany } from './company';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { postJournalEntry } from './posting';
import { verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-integrity');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const arCheck = async () => (await verifyIntegrity(ctx)).checks.find((c) => /^A\/R control account/.test(c.name))!;

describe('Verify Data A/R check (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@integrity.test', name: 'Ivy', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Converted Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
    // The A/R account a QuickBooks conversion brought along, next to the app's 1200.
    acct['11000'] = (await createAccount(ctx, { code: '11000', name: 'Accounts Receivable (QB)', type: 'asset', subtype: 'accounts_receivable' })).id;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: an amount on a second A/R account that no invoice or customer explains is reported', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Converted Customer' } as never);
    await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-04-01T00:00:00Z'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }],
    } as never);
    const healthy = await arCheck();
    expect(healthy.ok).toBe(true);
    expect(healthy.detail).not.toMatch(/skipped/);
    expect(healthy.detail).toMatch(/100\.00/);

    // An amount on the converted A/R account with no customer (what an imported General Ledger
    // or a repair tool can leave behind).
    await postJournalEntry(ctx, {
      date: new Date('2026-04-02T00:00:00Z'),
      description: 'Unexplained A/R',
      allowUnnamedControl: true,
      lines: [
        { accountId: acct['11000'], debit: '50.00' },
        { accountId: acct['4000'], credit: '50.00' },
      ],
    });
    const broken = await arCheck();
    expect(broken.ok).toBe(false);
    expect(broken.detail).toMatch(/50\.00/);
  });
});
