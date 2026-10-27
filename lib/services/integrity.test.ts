/**
 * Integration tests for the data-integrity verification service.
 *
 * Boots a throwaway PGlite instance, seeds minimal company data, posts a couple
 * of balanced journal entries, and asserts that verifyIntegrity returns allOk true.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import { verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-integrity');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

describe('verifyIntegrity', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'integrity@test.local', name: 'IntegrityTest', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Integrity Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed a minimal chart of accounts.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',            'asset',     'checking'],
      ['1200', 'Accounts Receivable', 'asset',     'accounts_receivable'],
      ['3000', "Owner's Equity",      'equity',    'owners_equity'],
      ['4000', 'Sales Income',        'revenue',   'sales'],
      ['6000', 'Advertising',         'expense',   'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Post a couple of balanced entries
  // -------------------------------------------------------------------------

  it('posts entry 1 — owner investment $10,000', async () => {
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-01-01'),
      description: 'Owner investment',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
    expect(entry.status).toBe('posted');
  });

  it('posts entry 2 — revenue earned $2,500', async () => {
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-01-15'),
      description: 'Revenue earned',
      lines: [
        { accountId: acct['1000'], debit: '2500.00' },
        { accountId: acct['4000'], credit: '2500.00' },
      ],
    });
    expect(entry.status).toBe('posted');
  });

  it('posts entry 3 — advertising expense $300', async () => {
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-01-20'),
      description: 'Advertising expense',
      lines: [
        { accountId: acct['6000'], debit: '300.00' },
        { accountId: acct['1000'], credit: '300.00' },
      ],
    });
    expect(entry.status).toBe('posted');
  });

  // -------------------------------------------------------------------------
  // Trial balance sanity check
  // -------------------------------------------------------------------------

  it('trial balance is balanced after all entries', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // verifyIntegrity — all checks should pass
  // -------------------------------------------------------------------------

  it('verifyIntegrity returns allOk true with all checks passing', async () => {
    const result = await verifyIntegrity(ctx);

    // Every individual check should pass.
    for (const check of result.checks) {
      expect(check.ok, `Check "${check.name}" failed: ${check.detail}`).toBe(true);
    }

    expect(result.allOk).toBe(true);
  });

  it('result contains all four named checks', async () => {
    const result = await verifyIntegrity(ctx);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain('Journal entries balanced');
    expect(names).toContain('Cached account balances match GL');
    expect(names).toContain('A/R control account matches open invoices');
    expect(names).toContain('No cross-company journal entry lines');
  });

  it('each passing check has a non-empty detail message', async () => {
    const result = await verifyIntegrity(ctx);
    for (const check of result.checks) {
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});
