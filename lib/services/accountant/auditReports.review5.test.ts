/**
 * Review round 5 — Closing Date Exception report on a large file (failed before the fix): it lists
 * the entries dated in the closed period but entered after the books were closed (an imported
 * history after setting the closing date, for example) and looked up their amounts with one bound
 * parameter per entry. Past 65,535 entries the database refused the query, so the report failed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setClosingDate } from '../company';
import { closingDateExceptionReport } from './auditReports';
import { makeTestCompany, type TestCompany } from '../testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-cde');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('Closing Date Exception report', () => {
  it('lists more late entries than the database allows parameters', async () => {
    await setClosingDate(t.ctx, { closingDate: '2025-12-31', password: 'close' });
    await new Promise((r) => setTimeout(r, 20));
    const N = 66_000;
    // An imported history dated in the closed year, entered after the books were closed.
    await t.db.execute(sql`
      WITH e AS (
        INSERT INTO journal_entries (company_id, entry_number, date, description, status, source_ref, created_by)
        SELECT ${t.ctx.companyId}::uuid, 800000 + g, '2025-06-01'::timestamp, 'Imported ' || g, 'posted', 'qbgl:' || g, ${t.ctx.userId}::uuid
        FROM generate_series(1, ${N}) AS g
        RETURNING id
      )
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
      SELECT id, ${t.acct['1000']}::uuid, 1.00, NULL FROM e
      UNION ALL
      SELECT id, ${t.acct['4000'] ?? t.acct['4100']}::uuid, NULL, 1.00 FROM e`);
    await t.db.execute(sql`ANALYZE journal_entries, journal_entry_lines`);

    const report = await closingDateExceptionReport(t.ctx);
    const late = report.rows.filter((r) => r.source === 'entered_after_close');
    expect(late).toHaveLength(N);
    expect(late[0].amount).toBe('1.00');
  }, 300_000);
});
