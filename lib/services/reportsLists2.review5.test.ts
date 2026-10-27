/**
 * Review round 5 (fix pass 2) — balance summaries on a company file with more than 65,535
 * documents of one type.
 *
 * Customer Balance Summary and the Customer Contact List sum every A/R line per name
 * (ledgerTotalsByName). The names of those lines come from their source documents
 * (resolveEntryNames), which looked every invoice up in ONE `id IN (...)` query: past 65,535
 * invoices Postgres / PGlite refuse the statement ("bind message has N parameter formats but 0
 * parameters") and the report answered 500. The lookups are now chunked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-lists-large');
const N = 66_000; // more invoices than one statement can bind
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
let custId = '';
const cell = (r: StdReport, label: string, col: string) => r.rows.find((x) => x.cells.label === label)?.cells[col];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-large@test.local', name: 'R5 Large', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Large File Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  custId = (await createCustomer(ctx, { displayName: 'Busy Customer' } as never)).id;

  // 66,000 posted invoices of 0.01 each (A/R debit, income credit), the A/R line carrying no
  // line-level name (older / imported data): the name comes from the invoice document. Bulk-loaded
  // with the per-row triggers off; every entry is balanced.
  const BATCH = 11_000;
  await db.execute(sql`SET session_replication_role = replica`);
  try {
    for (let start = 0; start < N; start += BATCH) {
      await db.execute(sql`
        WITH inv AS (
          INSERT INTO invoices (company_id, customer_id, invoice_number, date, status, subtotal, total, balance_due)
          SELECT ${ctx.companyId}::uuid, ${custId}::uuid, 100000 + g, '2026-03-01'::timestamp, 'open', 0.01, 0.01, 0.01
          FROM generate_series(${start + 1}::int, ${start + BATCH}::int) AS g
          RETURNING id, invoice_number
        ), e AS (
          INSERT INTO journal_entries (company_id, entry_number, date, description, status, source_ref, reference, created_by)
          SELECT ${ctx.companyId}::uuid, invoice_number, '2026-03-01'::timestamp, 'synthetic invoice', 'posted',
                 'invoice:' || id::text, invoice_number::text, ${ctx.userId}::uuid
          FROM inv
          RETURNING id
        )
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        SELECT id, ${A['1200']}::uuid, 0.01, NULL FROM e
        UNION ALL
        SELECT id, ${A['4000']}::uuid, NULL, 0.01 FROM e
      `);
    }
  } finally {
    await db.execute(sql`SET session_replication_role = origin`);
  }
  // Reopen the file so the bulk-loaded tables get planner statistics (lib/db/plannerStats.ts).
  await closeDb(TEST_DIR);
  db = await getDb(TEST_DIR);
  ctx = { ...ctx, db };
}, 400_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('balance summaries with more than 65,535 invoices', () => {
  it('Customer Balance Summary adds up every invoice under its customer', async () => {
    const r = await runStandardReport(ctx, 'customer-balance-summary', { asOf: '2026-12-31' });
    expect(cell(r, 'Busy Customer', 'balance')).toBe('660.00');
    expect(cell(r, 'TOTAL', 'balance')).toBe('660.00');
    expect(r.truncated).toBeFalsy();
  }, 120_000);

  it('the Customer Contact List shows the full balance', async () => {
    const r = await runStandardReport(ctx, 'customer-contact-list', {});
    expect(cell(r, 'Busy Customer', 'balance')).toBe('660.00');
  }, 120_000);
});
