/**
 * Review round 5 — sales tax liability on a large company file (failed before the fix): the
 * engine attributes every posted line on Sales Tax Payable to its sales form, and loaded those
 * forms with one bound parameter per form (`IN ($1 … $n)`). The database refuses more than
 * 65,535 parameters, so once a company had that many taxed invoices / sales receipts in its
 * history the Sales Tax Liability report, Pay Sales Tax and the Accountant Center all failed.
 * The forms are now loaded in chunks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { salesTaxActivity, salesTaxGlBalance, salesTaxLiabilityReport } from './salesTaxLedger';
import { makeTestCompany, type TestCompany } from '../testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-stl');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('sales tax activity on a long sales history', () => {
  it('attributes more taxed sales forms than the database allows parameters', async () => {
    const N = 66_000;
    // N posted sales entries (cash sale: Dr 1000 / Cr 2200 tax) each pointing at its own form.
    await t.db.execute(sql`
      WITH e AS (
        INSERT INTO journal_entries (company_id, entry_number, date, description, status, source_ref, created_by)
        SELECT ${t.ctx.companyId}::uuid, 900000 + g, '2026-02-01'::timestamp, 'Sale ' || g, 'posted',
               'salesreceipt:' || gen_random_uuid(), ${t.ctx.userId}::uuid
        FROM generate_series(1, ${N}) AS g
        RETURNING id
      )
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, memo)
      SELECT id, ${t.acct['1000']}::uuid, 0.10, NULL, 'cash' FROM e
      UNION ALL
      SELECT id, ${t.acct['2200']}::uuid, NULL, 0.10, 'tax' FROM e`);

    // Planner statistics, as the app takes them when a company file is opened (lib/db/plannerStats.ts).
    await t.db.execute(sql`ANALYZE journal_entries, journal_entry_lines`);

    const rows = await salesTaxActivity(t.ctx);
    expect(rows.length).toBe(N);
    const gl = await salesTaxGlBalance(t.ctx);
    expect(gl).toBe('6600.00');
    const report = await salesTaxLiabilityReport(t.ctx, { basis: 'cash' });
    expect(report).toBeTruthy();
  }, 300_000);
});
