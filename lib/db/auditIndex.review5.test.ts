/**
 * Round-5 review regression (performance on a large company file): looking up a record's audit
 * history — Transaction History, Undo (every save with an Undo toast), "changed by" on a record
 * lock conflict, the cash-basis vendor-credit applications (every cash-basis report), refunds
 * being voided — filters audit_logs by company + entity type (+ id). The only index was
 * (company_id, created_at), so every one of those read the company's whole audit trail, which
 * grows by a row or more per change, forever. 0063 adds (company_id, entity_type, entity_id,
 * created_at).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, openDb } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-audit-idx-r5-'));
const dir = path.join(ROOT, 'file');

afterAll(async () => {
  await closeDb(dir).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('audit trail lookups by record use an index (review round 5)', () => {
  it('record and entity-type lookups on a large audit trail do not scan it', async () => {
    const db = await getDb(dir);
    const [user] = await db.insert(users).values({ email: 'r5@audit.idx', name: 'Ida', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Big Co', ownerId: user.id }).returning();
    const client = openDb(dir).client;
    // Two years of a busy company: 60,000 audit rows over a dozen entity types.
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, new_values, created_at)
       SELECT $1::uuid, $2::uuid, 'update',
              (ARRAY['invoice','bill','journal_entry','customer','vendor','item','payment_received',
                     'expense','deposit','account','vendor_credit','credit_memo'])[1 + g % 12],
              gen_random_uuid(), jsonb_build_object('n', g), now() - (g || ' minutes')::interval
         FROM generate_series(1, 60000) g`,
      [company.id, user.id],
    );
    await client.query('ANALYZE audit_logs');
    const plan = async (sql: string, params: unknown[]) =>
      (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');

    const one = await plan(
      `SELECT user_id FROM audit_logs WHERE company_id = $1 AND entity_type = 'invoice' AND entity_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [company.id, '00000000-0000-0000-0000-000000000001'],
    );
    expect(one).toMatch(/audit_logs_entity_idx/);

    const byType = await plan(
      `SELECT entity_id, new_values FROM audit_logs WHERE company_id = $1 AND entity_type = 'vendor_credit'
          AND new_values->>'action' IN ('applied_to_bill', 'unapplied_from_bill')`,
      [company.id],
    );
    expect(byType).toMatch(/audit_logs_entity_idx/);
  });
});
