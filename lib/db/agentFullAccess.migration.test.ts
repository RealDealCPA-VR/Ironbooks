/**
 * drizzle/0097 agent full access: the data model (plan section 12, Phase 0 storage).
 *
 *  - a fresh database has agent_policies, agent_permission_requests and agent_grants, the new
 *    agents and audit_logs columns, the indexes, and no foreign key to agents or people;
 *  - a company file at 0096 (one agent per mode, agent proposals in every status) upgrades with
 *    the normal migrator: each agent gets the preset of its mode, each agent proposal becomes one
 *    request row, and the proposals themselves are left exactly as they were;
 *  - running the migration again changes nothing (a preset changed since stays changed, no
 *    request is copied twice);
 *  - the three tables never travel with a copy of the company: not in the per-company backup, not
 *    in the Accountant's Copy or Period Copy, and a restored portable file or full backup cancels
 *    what was still waiting and ends standing permission (a backup made before 0097 included, whose
 *    agent proposals the upgrade on restore turns into requests); nor does what an agent asked for
 *    count as a "use" of a record.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-full-access');
const LIVE_DIR = path.join(ROOT, 'live');
const RESTORED_DIR = path.join(ROOT, 'restored');
const BACKUP_RESTORED_DIR = path.join(ROOT, 'restored-backup');
const OLD_DIR = path.join(ROOT, 'at-0096');
const OLD_RESTORED_DIR = path.join(ROOT, 'restored-0096');
process.env.BKA_DATA_DIR = LIVE_DIR;
delete process.env.BKA_DEVICE_VAULT;

import * as schema from '@/lib/db/schema';
import { agentGrants, agentPermissionRequests, agentPolicies, agents, users } from '@/lib/db/schema';
import { closeDb, getDb, latestShippedMigrationAt, type DB } from '@/lib/db';
import { foreignKeyGaps } from '@/lib/db/ledgerGuards';
import { fullAccess } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import {
  COMPANY_BACKUP_EXCLUDED_TABLES,
  COMPANY_BACKUP_TABLE_NAMES,
  createBackup,
  exportCompanyData,
  restoreBackup,
} from '@/lib/services/backup';
import { OUTSIDER_SCRUBBED, createPortableCompanyFile, restorePortableCompanyFile } from '@/lib/services/portableFile';
import { createPeriodCopy } from '@/lib/services/periodCopy';
import { createAccountantCopy } from '@/lib/services/accountantCopy/client';
import { isReferenced } from '@/lib/services/lists/references';

const REAL = path.resolve(process.cwd(), 'drizzle');
const MIGRATION = path.join(REAL, '0097_agent_full_access.sql');
const NEW_TABLES = ['agent_policies', 'agent_permission_requests', 'agent_grants'];
const AGENT_TABLES = ['agents', 'agent_requests', ...NEW_TABLES];
const DAY = 24 * 3600_000;

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A_RO = 'a0000000-0000-4000-8000-000000000001';
const A_PROP = 'a0000000-0000-4000-8000-000000000002';
const A_POST = 'a0000000-0000-4000-8000-000000000003';
const A_ODD = 'a0000000-0000-4000-8000-000000000004';
const P = {
  pending: 'b0000000-0000-4000-8000-000000000001',
  approved: 'b0000000-0000-4000-8000-000000000002',
  rejected: 'b0000000-0000-4000-8000-000000000003',
  declined: 'b0000000-0000-4000-8000-000000000004',
  failed: 'b0000000-0000-4000-8000-000000000005',
  agentInPayload: 'b0000000-0000-4000-8000-000000000006',
  noAgent: 'b0000000-0000-4000-8000-000000000007',
  otherKind: 'b0000000-0000-4000-8000-000000000008',
};

/** A copy of the migrations folder whose journal stops before `idx` (an app of that version). */
function migrationsBefore(idx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bka-pre${String(idx).padStart(4, '0')}-`));
  fs.mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < idx);
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries as Array<{ tag: string }>) {
    fs.copyFileSync(path.join(REAL, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

/** Every statement of 0097, as the migrator runs them. */
function statements0097(): string[] {
  return fs
    .readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .filter((s) => s.trim());
}

async function memoryDb(): Promise<{ client: PGlite; db: ReturnType<typeof drizzle<typeof schema>> }> {
  const client = new PGlite();
  // As lib/db/index.ts does before migrating: timestamps are written in UTC.
  await client.exec("SET TIME ZONE 'UTC'");
  return { client, db: drizzle(client, { schema }) };
}

async function q<T = Record<string, unknown>>(client: PGlite, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(text, params)).rows;
}

async function columns(client: PGlite, table: string): Promise<string[]> {
  const rows = await q<{ column_name: string }>(
    client,
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

async function seedPeople(client: PGlite): Promise<void> {
  await client.exec(`
    INSERT INTO users (id, email, name, password_hash) VALUES
      ('${U1}', 'owner@fa.test', 'Owner One', 'x'),
      ('${U2}', 'approver@fa.test', 'Approver Two', 'x');
    INSERT INTO companies (id, name, owner_id) VALUES ('${C1}', 'Full Access Co', '${U1}');
  `);
}

describe('0097 on a fresh database', () => {
  let client: PGlite;
  let db: Awaited<ReturnType<typeof memoryDb>>['db'];

  beforeAll(async () => {
    ({ client, db } = await memoryDb());
    await migrate(db, { migrationsFolder: REAL });
    await seedPeople(client);
  });
  afterAll(async () => {
    await client.close();
  });

  it('is in the journal after 0096 with statement breakpoints, and is newer than anything an app without it knows', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(REAL, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
    };
    // Looked up by name, so a later migration (0098 …) does not break this test.
    const entry = journal.entries.find((e) => e.tag === '0097_agent_full_access');
    const before = journal.entries.find((e) => e.tag === '0096_agent_actions');
    expect(entry).toMatchObject({ idx: 97, breakpoints: true });
    expect(before).toBeDefined();
    expect(entry!.when).toBeGreaterThan(before!.when);
    expect(fs.existsSync(MIGRATION)).toBe(true);
    // This app knows it (the newest it ships is this or a later one) …
    expect(latestShippedMigrationAt(REAL)).toBeGreaterThanOrEqual(entry!.when);
    // … and the newest an app without it knows is older, which is how lib/db/index.ts
    // (refuseNewerFile) tells that a file upgraded here was made by a newer version.
    const older = migrationsBefore(97);
    try {
      expect(latestShippedMigrationAt(older)).toBe(before!.when);
    } finally {
      fs.rmSync(older, { recursive: true, force: true });
    }
  });

  it('has the three tables with exactly the planned columns', async () => {
    expect(await columns(client, 'agent_policies')).toEqual(
      ['agent_id', 'area', 'class', 'company_id', 'created_at', 'id', 'setting'],
    );
    expect(await columns(client, 'agent_permission_requests')).toEqual(
      [
        'agent_id', 'class', 'company_id', 'created_at', 'decided_at', 'decided_by', 'error', 'expires_at', 'grant_id', 'id',
        'input', 'needs', 'note', 'operation', 'preview', 'proposal_id', 'reason', 'request_key', 'result', 'second_approver',
        'staleness_key', 'status', 'summary',
      ],
    );
    expect(await columns(client, 'agent_grants')).toEqual(
      [
        'agent_id', 'class', 'company_id', 'constraints', 'created_at', 'expires_at', 'given_by', 'id', 'operation', 'request_id',
        'revoked_at', 'revoked_by', 'uses',
      ],
    );
    const agentCols = await columns(client, 'agents');
    for (const c of ['mode', 'preset', 'bulk_cap', 'two_person_over', 'request_expiry_days', 'folders', 'notify_email', 'paused_at']) {
      expect(agentCols, c).toContain(c);
    }
    const auditCols = await columns(client, 'audit_logs');
    for (const c of ['agent_id', 'approved_by', 'agent_request_id', 'agent_grant_id']) expect(auditCols, c).toContain(c);
  });

  it('matches the drizzle tables in lib/db/schema.ts (every declared column exists)', async () => {
    // A select names every declared column: one the database lacks fails the query.
    await expect(db.select().from(schema.agentPolicies)).resolves.toEqual([]);
    await expect(db.select().from(schema.agentPermissionRequests)).resolves.toEqual([]);
    await expect(db.select().from(schema.agentGrants)).resolves.toEqual([]);
    await expect(db.select().from(schema.agents)).resolves.toEqual([]);
    await expect(db.select().from(schema.auditLogs)).resolves.toEqual([]);
  });

  it('a new agent asks for every change, with the default limits', async () => {
    await client.exec(`
      INSERT INTO agents (id, company_id, name, token_hash, token_prefix)
      VALUES ('${A_PROP}', '${C1}', 'New agent', '${'1'.repeat(64)}', 'ib_agent_1');
    `);
    const [a] = await db.select().from(agents).where(eq(agents.id, A_PROP));
    expect(a).toMatchObject({
      mode: 'read_only',
      preset: 'ask_every_change',
      bulkCap: null,
      twoPersonOver: null,
      requestExpiryDays: 7,
      folders: [],
      notifyEmail: false,
      pausedAt: null,
    });
  });

  it('keeps one policy row per agent, class and area, a missing area counted as one value', async () => {
    await db.insert(agentPolicies).values({ companyId: C1, agentId: A_PROP, class: 'enter', area: null, setting: 'allow' });
    await db.insert(agentPolicies).values({ companyId: C1, agentId: A_PROP, class: 'enter', area: 'banking', setting: 'ask' });
    await db.insert(agentPolicies).values({ companyId: C1, agentId: A_RO, class: 'enter', area: null, setting: 'never' });
    await expect(
      db.insert(agentPolicies).values({ companyId: C1, agentId: A_PROP, class: 'enter', area: null, setting: 'never' }),
    ).rejects.toThrow();
    await expect(
      db.insert(agentPolicies).values({ companyId: C1, agentId: A_PROP, class: 'enter', area: 'banking', setting: 'allow' }),
    ).rejects.toThrow();
    // The way a service changes a setting: one upsert on (agent, class, area), a null area included.
    await db
      .insert(agentPolicies)
      .values({ companyId: C1, agentId: A_PROP, class: 'enter', area: null, setting: 'never' })
      .onConflictDoUpdate({ target: [agentPolicies.agentId, agentPolicies.class, agentPolicies.area], set: { setting: 'never' } });
    const rows = await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, A_PROP));
    expect(rows.map((r) => `${r.class} in ${r.area ?? 'every area'}: ${r.setting}`).sort()).toEqual([
      'enter in banking: ask',
      'enter in every area: never',
    ]);
  });

  it('keeps one request per agent and request id, and takes grants with their defaults', async () => {
    const expiresAt = new Date(Date.now() + 7 * DAY);
    const [r] = await db
      .insert(agentPermissionRequests)
      .values({ companyId: C1, agentId: A_PROP, requestKey: 'est-1', operation: 'estimates.create', class: 'enter', summary: 'Enter an estimate', expiresAt })
      .returning();
    expect(r).toMatchObject({ status: 'pending', proposalId: null, grantId: null, decidedBy: null, input: null });
    await expect(
      db.insert(agentPermissionRequests).values({ companyId: C1, agentId: A_PROP, requestKey: 'est-1', operation: 'estimates.create', class: 'enter', summary: 'Again', expiresAt }),
    ).rejects.toThrow();
    // Another agent may use the same request id.
    await db.insert(agentPermissionRequests).values({ companyId: C1, agentId: A_RO, requestKey: 'est-1', operation: 'estimates.create', class: 'enter', summary: 'Other agent', expiresAt });

    const [g] = await db
      .insert(agentGrants)
      .values({ companyId: C1, agentId: A_PROP, operation: 'estimates.create', class: 'enter', givenBy: U1, requestId: r.id, expiresAt })
      .returning();
    expect(g).toMatchObject({ constraints: {}, uses: 0, revokedAt: null, revokedBy: null });
  });

  it('has the lookup indexes, and no foreign key to agents, people, requests or grants', async () => {
    const idx = await q<{ indexname: string; indexdef: string }>(
      client,
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1::text[]) ORDER BY indexname`,
      [NEW_TABLES],
    );
    const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));
    expect(byName.get('agent_policies_key_idx')).toMatch(/UNIQUE.*\(agent_id, class, area\) NULLS NOT DISTINCT/);
    expect(byName.get('agent_permission_requests_key_idx')).toMatch(/UNIQUE.*\(agent_id, request_key\)/);
    expect(byName.get('agent_permission_requests_company_status_idx')).toMatch(/\(company_id, status, created_at\)/);
    expect(byName.get('agent_permission_requests_agent_idx')).toMatch(/\(agent_id, created_at DESC\)/);
    expect(byName.get('agent_permission_requests_proposal_idx')).toMatch(/UNIQUE.*\(proposal_id\) WHERE \(proposal_id IS NOT NULL\)/);
    expect(byName.get('agent_grants_agent_idx')).toMatch(/\(agent_id, operation\)/);

    const fks = await q<{ tbl: string; def: string }>(
      client,
      `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ANY($1::text[]) ORDER BY 1`,
      [NEW_TABLES],
    );
    expect(fks).toEqual(NEW_TABLES.slice().sort().map((tbl) => ({ tbl, def: 'FOREIGN KEY (company_id) REFERENCES companies(id)' })));
    // The new audit_logs columns are plain pointers too.
    const auditFks = await q<{ def: string }>(
      client,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND conrelid = 'audit_logs'::regclass`,
    );
    expect(auditFks.map((f) => f.def).join(' ')).not.toMatch(/approved_by|agent_request_id|agent_grant_id/);
    // The file's health check finds every foreign key the migrations declare.
    expect(await foreignKeyGaps(async (text) => (await client.query(text)).rows as never, REAL)).toEqual([]);
  });
});

describe('a company file at 0096 upgraded to 0097', () => {
  let client: PGlite;
  let db: Awaited<ReturnType<typeof memoryDb>>['db'];
  let proposalsBefore: string;
  const agentPayload = (agentId: string | null, input: Record<string, unknown>) => ({
    date: '2026-03-14',
    description: 'Office supplies',
    reference: null,
    lines: [],
    totalDebit: '77.00',
    rationale: 'Proposed by the agent.',
    agent: { id: agentId, name: 'Agent' },
    action: 'enter_journal_entry',
    input,
    changes: [],
  });

  async function requestsByProposal(): Promise<Map<string, typeof agentPermissionRequests.$inferSelect>> {
    const rows = await db.select().from(agentPermissionRequests);
    return new Map(rows.map((r) => [r.proposalId ?? r.id, r]));
  }

  let oldFolder: string;

  beforeAll(async () => {
    ({ client, db } = await memoryDb());
    oldFolder = migrationsBefore(97);
    await migrate(db, { migrationsFolder: oldFolder });
    expect(await columns(client, 'agents')).not.toContain('preset');
    expect(await columns(client, 'agent_permission_requests')).toEqual([]);
    await seedPeople(client);

    await client.exec(`
      INSERT INTO agents (id, company_id, name, mode, token_hash, token_prefix) VALUES
        ('${A_RO}', '${C1}', 'Reader', 'read_only', '${'1'.repeat(64)}', 'ib_agent_1'),
        ('${A_PROP}', '${C1}', 'Proposer', 'propose', '${'2'.repeat(64)}', 'ib_agent_2'),
        ('${A_POST}', '${C1}', 'Poster', 'post', '${'3'.repeat(64)}', 'ib_agent_3'),
        ('${A_ODD}', '${C1}', 'Odd', 'something_else', '${'4'.repeat(64)}', 'ib_agent_4');
    `);
    const proposal = async (
      id: string,
      o: { status: string; agentId: string | null; payloadAgent?: string | null; kind?: string; decidedBy?: string; resultRef?: string; error?: string },
    ) => {
      await client.query(
        `INSERT INTO ai_proposals (id, company_id, created_by, kind, summary, payload, status, result_ref, error, decided_by, decided_at, agent_id, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          C1,
          o.kind ?? 'agent_action',
          `Journal entry (${o.status})`,
          JSON.stringify(agentPayload(o.payloadAgent === undefined ? o.agentId : o.payloadAgent, { date: '2026-03-14', memo: o.status })),
          o.status,
          o.resultRef ?? null,
          o.error ?? null,
          o.decidedBy ?? null,
          o.decidedBy ? '2026-03-15 09:30:00' : null,
          o.agentId,
          '2026-03-14 10:00:00',
        ],
      );
    };
    await proposal(P.pending, { status: 'pending', agentId: A_PROP });
    await proposal(P.approved, { status: 'approved', agentId: A_PROP, decidedBy: U2, resultRef: 'agent:enter_journal_entry' });
    await proposal(P.rejected, { status: 'rejected', agentId: A_PROP, decidedBy: U2 });
    await proposal(P.declined, { status: 'declined', agentId: A_PROP, decidedBy: U2 });
    await proposal(P.failed, { status: 'failed', agentId: A_PROP, error: 'The account is inactive.' });
    // Older rows: the agent named only inside the proposal, or nowhere usable.
    await proposal(P.agentInPayload, { status: 'pending', agentId: null, payloadAgent: A_POST });
    await proposal(P.noAgent, { status: 'pending', agentId: null, payloadAgent: 'not-an-id' });
    // The built-in assistant's own proposals are not agent requests.
    await proposal(P.otherKind, { status: 'pending', agentId: null, payloadAgent: null, kind: 'journal_entry' });
    // The request id the agent sent with its pending proposal (lib/agent/actions.ts proposeAction).
    await client.query(
      `INSERT INTO agent_requests (company_id, agent_id, request_key, action, input_hash, outcome, result)
       VALUES ($1, $2, 'je-2026-03-14-supplies', 'enter_journal_entry', $3, 'proposed', $4)`,
      [C1, A_PROP, 'f'.repeat(64), JSON.stringify({ outcome: 'proposed', proposalId: P.pending })],
    );
    proposalsBefore = JSON.stringify(await q(client, 'SELECT * FROM ai_proposals ORDER BY id'));

    // What happens when a person installs this version: the normal migrator.
    await migrate(db, { migrationsFolder: REAL });
  });
  afterAll(async () => {
    await client.close();
    fs.rmSync(oldFolder, { recursive: true, force: true });
  });

  it('gives each agent the preset of its mode, and keeps the mode', async () => {
    const rows = await db.select({ id: agents.id, mode: agents.mode, preset: agents.preset }).from(agents);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.mode, r.preset]]))).toEqual({
      [A_RO]: ['read_only', 'read_only'],
      [A_PROP]: ['propose', 'ask_every_change'],
      [A_POST]: ['post', 'trusted_bookkeeper'],
      // An unknown mode was read as Read only, so it stays that.
      [A_ODD]: ['something_else', 'read_only'],
    });
    const [poster] = await db.select().from(agents).where(eq(agents.id, A_POST));
    expect(poster).toMatchObject({ requestExpiryDays: 7, folders: [], notifyEmail: false, bulkCap: null, twoPersonOver: null, pausedAt: null });
  });

  it('copies each agent proposal into one request with what a person decided', async () => {
    const byProposal = await requestsByProposal();
    expect([...byProposal.keys()].sort()).toEqual(
      [P.pending, P.approved, P.rejected, P.declined, P.failed, P.agentInPayload].sort(),
    );
    const statusOf = (id: string) => byProposal.get(id)!.status;
    expect({
      pending: statusOf(P.pending),
      approved: statusOf(P.approved),
      rejected: statusOf(P.rejected),
      declined: statusOf(P.declined),
      failed: statusOf(P.failed),
    }).toEqual({ pending: 'pending', approved: 'executed', rejected: 'denied', declined: 'denied', failed: 'cancelled' });

    const pending = byProposal.get(P.pending)!;
    expect(pending).toMatchObject({
      companyId: C1,
      agentId: A_PROP,
      // The request id the agent used is kept, so asking again with it finds this request.
      requestKey: 'je-2026-03-14-supplies',
      operation: 'action:enter_journal_entry',
      class: 'change',
      input: { date: '2026-03-14', memo: 'pending' },
      summary: 'Journal entry (pending)',
      reason: null,
      decidedBy: null,
      decidedAt: null,
      result: null,
      grantId: null,
    });
    expect(pending.createdAt.toISOString()).toBe('2026-03-14T10:00:00.000Z');
    // Still waiting: a full wait from the upgrade, not from when it was asked.
    expect(pending.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);

    const approved = byProposal.get(P.approved)!;
    expect(approved).toMatchObject({
      requestKey: `proposal:${P.approved}`,
      decidedBy: U2,
      result: { resultRef: 'agent:enter_journal_entry' },
    });
    expect(approved.decidedAt!.toISOString()).toBe('2026-03-15T09:30:00.000Z');
    expect(approved.expiresAt.toISOString()).toBe('2026-03-21T10:00:00.000Z');
    expect(byProposal.get(P.failed)!.error).toBe('The account is inactive.');
    expect(byProposal.get(P.rejected)!.decidedBy).toBe(U2);
    // The agent named only inside the proposal.
    expect(byProposal.get(P.agentInPayload)).toMatchObject({ agentId: A_POST, status: 'pending' });
  });

  it('leaves the proposals themselves exactly as they were', async () => {
    expect(JSON.stringify(await q(client, 'SELECT * FROM ai_proposals ORDER BY id'))).toBe(proposalsBefore);
  });

  it('is harmless to run again: a preset changed since stays changed, and nothing is copied twice', async () => {
    await db.update(agents).set({ preset: 'full_with_asks' }).where(eq(agents.id, A_PROP));
    await db.update(agents).set({ preset: 'ask_every_change' }).where(eq(agents.id, A_RO));
    const before = await requestsByProposal();
    for (const stmt of statements0097()) await client.exec(stmt);
    const presets = await db.select({ id: agents.id, preset: agents.preset }).from(agents);
    expect(Object.fromEntries(presets.map((r) => [r.id, r.preset]))).toEqual({
      [A_RO]: 'ask_every_change',
      [A_PROP]: 'full_with_asks',
      [A_POST]: 'trusted_bookkeeper',
      [A_ODD]: 'read_only',
    });
    const after = await requestsByProposal();
    expect(after.size).toBe(before.size);
    for (const [k, v] of before) expect(after.get(k), k).toEqual(v);
    // Still a new agent's default.
    await client.exec(
      `INSERT INTO agents (company_id, name, token_hash, token_prefix) VALUES ('${C1}', 'After', '${'5'.repeat(64)}', 'ib_agent_5')`,
    );
    const [made] = await db.select({ preset: agents.preset }).from(agents).where(eq(agents.name, 'After'));
    expect(made.preset).toBe('ask_every_change');
  });

  it('records the upgrade like any other step', async () => {
    const [m] = await q<{ n: number; last: string }>(client, 'SELECT COUNT(*)::int AS n, MAX(created_at)::text AS last FROM drizzle.__drizzle_migrations');
    expect(Number(m.last)).toBe(latestShippedMigrationAt(REAL));
  });
});

describe('the three tables never travel with a copy of the company', () => {
  let db: DB;
  let ctx: ServiceContext;
  const MARK = 'agent-full-access-marker';
  const NAMED = 'c0000000-0000-4000-8000-0000000000aa';

  /** The rows of data/<table>.jsonl in a copy. The entry must be there: every table is written, empty or not. */
  function rows(zipBuffer: Buffer, table: string): Array<Record<string, unknown>> {
    const entry = new AdmZip(zipBuffer).getEntry(`data/${table}.jsonl`);
    expect(entry, `data/${table}.jsonl`).not.toBeNull();
    const text = entry!.getData().toString('utf8');
    return text ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  /** Does any file inside a copy hold the text? Each one is unpacked: the copy itself is compressed. */
  function holds(zipBuffer: Buffer, text: string): boolean {
    return new AdmZip(zipBuffer).getEntries().some((e) => !e.isDirectory && e.getData().includes(text));
  }

  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(LIVE_DIR);
    const [owner] = await db.insert(users).values({ email: 'owner@fa-copies.test', name: 'Copy Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Copies Co', ownerId: owner.id });
    ctx = { db, companyId: company.id, userId: owner.id, role: 'owner', access: fullAccess() };
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: 'Copy agent', roleKeys: ['bookkeeper'], mode: 'propose', tokenHash: 'e'.repeat(64), tokenPrefix: 'ib_agent_e' })
      .returning();
    await db.insert(agentPolicies).values({ companyId: company.id, agentId: agent.id, class: 'enter', area: 'banking', setting: 'allow' });
    const expiresAt = new Date(Date.now() + 7 * DAY);
    const [waiting] = await db
      .insert(agentPermissionRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        requestKey: 'copy-1',
        operation: 'customers.delete',
        class: 'remove',
        input: { id: NAMED, memo: MARK },
        reason: MARK,
        summary: `Delete a customer (${MARK})`,
        expiresAt,
      })
      .returning();
    await db.insert(agentPermissionRequests).values({
      companyId: company.id,
      agentId: agent.id,
      requestKey: 'copy-2',
      operation: 'invoices.create',
      class: 'enter',
      summary: 'Entered earlier',
      status: 'executed',
      decidedBy: owner.id,
      decidedAt: new Date(),
      expiresAt,
    });
    await db.insert(agentGrants).values({
      companyId: company.id,
      agentId: agent.id,
      operation: 'invoices.create',
      class: 'enter',
      constraints: { entityIds: [NAMED] },
      givenBy: owner.id,
      requestId: waiting.id,
      expiresAt,
    });
  }, 180_000);

  afterAll(async () => {
    for (const dir of [LIVE_DIR, RESTORED_DIR, BACKUP_RESTORED_DIR, OLD_RESTORED_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the per-company backup leaves them out (and says why)', async () => {
    for (const t of NEW_TABLES) {
      expect(COMPANY_BACKUP_EXCLUDED_TABLES, t).toHaveProperty(t);
      expect(COMPANY_BACKUP_TABLE_NAMES, t).not.toContain(t);
    }
    const data = await exportCompanyData(db, ctx.companyId);
    for (const k of ['agents', 'agentRequests', 'agentPolicies', 'agentPermissionRequests', 'agentGrants']) expect(data.tables, k).not.toHaveProperty(k);
    expect(JSON.stringify(data)).not.toContain(MARK);
  });

  it('the Period Copy carries none of them', async () => {
    const copy = (await createPeriodCopy(ctx, { from: '2026-01-01', to: '2026-12-31', dataDir: LIVE_DIR })).buffer;
    for (const t of AGENT_TABLES) expect(rows(copy, t), t).toEqual([]);
    expect(holds(copy, MARK)).toBe(false);
  });

  it("the owner's own portable file carries them, and the restored books cancel what waited and end standing permission", async () => {
    expect(OUTSIDER_SCRUBBED).toMatchObject({ agent_policies: null, agent_permission_requests: null, agent_grants: null });
    const own = (await createPortableCompanyFile(ctx, { dataDir: LIVE_DIR })).buffer;
    expect(rows(own, 'agent_permission_requests')).toHaveLength(2);
    expect(rows(own, 'agent_grants')).toHaveLength(1);
    // The search the copies below are checked with does find the marker where it is.
    expect(holds(own, MARK)).toBe(true);
    await restorePortableCompanyFile(own, RESTORED_DIR);
    const restored = await getDb(RESTORED_DIR);
    expect((await restored.select().from(agents)).every((a) => a.revokedAt !== null)).toBe(true);
    const reqs = await restored.select().from(agentPermissionRequests);
    expect(Object.fromEntries(reqs.map((r) => [r.requestKey, r.status]))).toEqual({ 'copy-1': 'cancelled', 'copy-2': 'executed' });
    expect(reqs.find((r) => r.requestKey === 'copy-1')!.decidedAt).not.toBeNull();
    expect((await restored.select().from(agentGrants)).every((g) => g.revokedAt !== null)).toBe(true);
    // A policy is only a setting of an agent that no longer has access: kept as it was.
    expect(await restored.select().from(agentPolicies)).toHaveLength(1);
    // The original books are untouched.
    expect((await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.requestKey, 'copy-1')))[0].status).toBe('pending');
    expect((await db.select().from(agentGrants))[0].revokedAt).toBeNull();
  });

  it('a restored full backup also cancels what waited and ends standing permission', async () => {
    const { buffer } = createBackup('Copies Co', LIVE_DIR);
    // After the backup a person denies the waiting request; then yesterday's backup is restored.
    const copy1 = eq(agentPermissionRequests.requestKey, 'copy-1');
    await db.update(agentPermissionRequests).set({ status: 'denied', decidedBy: ctx.userId, decidedAt: new Date() }).where(copy1);
    try {
      await restoreBackup(buffer, BACKUP_RESTORED_DIR);
      const restored = await getDb(BACKUP_RESTORED_DIR);
      expect((await restored.select().from(agents)).every((a) => a.revokedAt !== null)).toBe(true);
      const reqs = await restored.select().from(agentPermissionRequests);
      // It does not come back as waiting, ready to be approved in the restored books.
      expect(Object.fromEntries(reqs.map((r) => [r.requestKey, r.status]))).toEqual({ 'copy-1': 'cancelled', 'copy-2': 'executed' });
      expect(reqs.find((r) => r.requestKey === 'copy-1')!.decidedAt).not.toBeNull();
      const grants = await restored.select().from(agentGrants);
      expect(grants).toHaveLength(1);
      expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
      // The books the backup was made from are untouched.
      expect((await db.select().from(agentPermissionRequests).where(copy1))[0].status).toBe('denied');
      expect((await db.select().from(agentGrants))[0].revokedAt).toBeNull();
    } finally {
      await db.update(agentPermissionRequests).set({ status: 'pending', decidedBy: null, decidedAt: null }).where(copy1);
    }
  }, 180_000);

  it('a backup made before 0097 is upgraded on restore, and the agent proposals it held come back cancelled, not waiting', async () => {
    const older = migrationsBefore(97);
    const at0096 = latestShippedMigrationAt(older)!;
    const client = new PGlite(OLD_DIR);
    try {
      await client.exec("SET TIME ZONE 'UTC'");
      await migrate(drizzle(client), { migrationsFolder: older });
      await seedPeople(client);
      await client.exec(`
        INSERT INTO agents (id, company_id, name, mode, token_hash, token_prefix)
        VALUES ('${A_PROP}', '${C1}', 'Proposer', 'propose', '${'6'.repeat(64)}', 'ib_agent_6');
      `);
      await client.query(
        `INSERT INTO ai_proposals (id, company_id, kind, summary, payload, status, agent_id)
         VALUES ($1, $2, 'agent_action', 'Journal entry (waiting)', $3, 'pending', $4)`,
        [P.pending, C1, JSON.stringify({ agent: { id: A_PROP, name: 'Proposer' }, action: 'enter_journal_entry', input: { memo: 'waiting' } }), A_PROP],
      );
    } finally {
      await client.close();
      fs.rmSync(older, { recursive: true, force: true });
    }
    const { buffer } = createBackup('Old Co', OLD_DIR, { dbSchemaAt: at0096 });
    await restoreBackup(buffer, OLD_RESTORED_DIR);
    const restored = await getDb(OLD_RESTORED_DIR);
    const reqs = await restored.select().from(agentPermissionRequests);
    expect(reqs.map((r) => [r.proposalId, r.operation, r.status])).toEqual([[P.pending, 'action:enter_journal_entry', 'cancelled']]);
    expect(reqs[0].decidedAt).not.toBeNull();
    expect((await restored.select().from(agents)).every((a) => a.revokedAt !== null)).toBe(true);
  }, 180_000);

  it("the Accountant's Copy carries none of them", async () => {
    const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: LIVE_DIR })).buffer;
    for (const t of AGENT_TABLES) expect(rows(transfer, t), t).toEqual([]);
    expect(holds(transfer, MARK)).toBe(false);
  });

  it('a record an agent asked about is not "in use" because of it', async () => {
    expect(await isReferenced(ctx, 'customers', NAMED)).toBe(false);
  });
});
