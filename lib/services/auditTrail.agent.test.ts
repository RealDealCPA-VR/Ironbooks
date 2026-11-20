/**
 * Agent full access, records (plan §7.3 and §12):
 *
 *  - writeAudit stores what an agent's change ran under (ServiceContext.approval) on the audit row
 *    (approved_by / agent_request_id / agent_grant_id) and on the transaction log record; a
 *    person's own change is recorded exactly as before;
 *  - the audit trail and the transaction log name the agent and how its change was allowed:
 *    "<Agent> (agent)", "..., approved by <person>", "..., under permission from <person> until
 *    <time>", or "..., under standing permission" when the grant is no longer on file, and
 *    "a removed user" for a giver no longer on file; a run under one grant words it once;
 *  - the new record fields are inside the log's hash: changing one breaks the chain;
 *  - the Agent Activity report lists every permission request whatever its status, is empty-safe,
 *    keeps to its dates and company, words a waiting request as the approval center does (expired
 *    past its time, waiting for a second person), hides what a request was about from a person who
 *    may not view that area, and is refused to an agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { agentGrants, agentPermissionRequests, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, can, canActivity, unionRoles } from '@/lib/permissions/model';
import { allOperations } from '@/lib/agent/operations/registry';
import { REQUEST_STATUSES, type RequestStatus } from '@/lib/agent/operations/types';
import { CATALOG_BY_KEY, REPORT_FAMILIES, listedReports } from '@/lib/reports/catalog';
import { writeAudit, type ServiceContext } from './_base';
import { getAuditLog, listAuditLogs, REQUEST_STATUS_WORDS } from './auditTrail';
import { readAllTransactionLog, transactionLogPath, verifyTransactionLog, queryTransactionLog } from './transactionLog';
import { isStandardReport, runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-audit-agent-approval');

let db: DB;
let owner: ServiceContext;
let other: ServiceContext;
let agentId: string;
let grantId: string;
const people: Record<string, string> = {};

const AGENT = { name: 'Ledger bot', mode: 'post' as const };
const ids = {
  own: '11111111-0000-4000-8000-000000000001',
  approved: '11111111-0000-4000-8000-000000000002',
  granted: '11111111-0000-4000-8000-000000000003',
  grantGone: '11111111-0000-4000-8000-000000000004',
  legacy: '11111111-0000-4000-8000-000000000005',
  person: '11111111-0000-4000-8000-000000000006',
};
const REQUEST_ID = '22222222-0000-4000-8000-000000000001';
const MISSING_GRANT = '33333333-0000-4000-8000-000000000009';

function asAgent(extra: Partial<ServiceContext> = {}): ServiceContext {
  return { db, companyId: owner.companyId, userId: null, role: 'accountant', agent: { id: agentId, ...AGENT }, ...extra };
}

async function auditRow(entityId: string) {
  const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
  return row;
}

function logRecord(entityId: string) {
  return readAllTransactionLog(TEST_DIR).records.find((r) => r.entityId === entityId);
}

async function trailName(entityId: string) {
  const { rows } = await listAuditLogs(owner, { entityType: 'customer', limit: 200 });
  return rows.find((r) => r.entityId === entityId);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  for (const [key, name] of [['owner', 'Olivia Owner'], ['approver', 'Pat Approver'], ['giver', 'Gina Giver'], ['second', 'Sam Second']] as const) {
    const [u] = await db.insert(users).values({ email: `${key}@agent-audit.test`, name, passwordHash: 'x' }).returning();
    people[key] = u.id;
  }
  // UTC, so "until" reads the same on every computer.
  const [company] = await db.insert(companies).values({ name: 'Agent Audit Co', ownerId: people.owner, settings: { timezone: 'UTC' } }).returning();
  owner = { db, companyId: company.id, userId: people.owner };
  const [company2] = await db.insert(companies).values({ name: 'Other Co', ownerId: people.owner, settings: { timezone: 'UTC' } }).returning();
  other = { db, companyId: company2.id, userId: people.owner };
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company.id, name: AGENT.name, tokenHash: 'a'.repeat(64), tokenPrefix: 'ib_test', mode: 'post', preset: 'trusted_bookkeeper' })
    .returning();
  agentId = agent.id;
  const [grant] = await db
    .insert(agentGrants)
    .values({ companyId: company.id, agentId, operation: 'customers.update', class: 'change', givenBy: people.giver, expiresAt: new Date('2026-11-20T17:30:00.000Z') })
    .returning();
  grantId = grant.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeAudit records what an agent change ran under', () => {
  it('an audit row written under an approval carries the three columns, and so does its log record', async () => {
    await writeAudit(asAgent({ userId: people.approver, approval: { approvedBy: people.approver, requestId: REQUEST_ID, grantId: null } }), {
      action: 'update',
      entityType: 'customer',
      entityId: ids.approved,
      newValues: { displayName: 'Approved change' },
    });
    expect(await auditRow(ids.approved)).toMatchObject({
      agentId,
      userId: people.approver,
      approvedBy: people.approver,
      agentRequestId: REQUEST_ID,
      agentGrantId: null,
    });
    const rec = logRecord(ids.approved)!;
    expect(rec).toMatchObject({ agentId, approvedBy: people.approver, agentRequestId: REQUEST_ID });
    expect('agentGrantId' in rec).toBe(false); // only fields with a value

    await writeAudit(asAgent({ approval: { approvedBy: null, requestId: null, grantId } }), {
      action: 'update',
      entityType: 'customer',
      entityId: ids.granted,
      newValues: { displayName: 'Granted change' },
    });
    expect(await auditRow(ids.granted)).toMatchObject({ agentId, userId: null, approvedBy: null, agentRequestId: null, agentGrantId: grantId });
    expect(logRecord(ids.granted)).toMatchObject({ agentId, agentGrantId: grantId });
  });

  it('a person\'s own change is recorded exactly as before: no approval columns, no new log fields', async () => {
    await writeAudit(owner, { action: 'update', entityType: 'customer', entityId: ids.person, newValues: { displayName: 'By hand' } });
    expect(await auditRow(ids.person)).toMatchObject({ userId: people.owner, agentId: null, approvedBy: null, agentRequestId: null, agentGrantId: null });
    const rec = logRecord(ids.person)!;
    expect(Object.keys(rec)).toEqual(['seq', 'ts', 'userId', 'userName', 'companyId', 'action', 'entityType', 'entityId', 'summary', 'data', 'prevHash', 'hash']);
    expect(rec.userName).toBe('Olivia Owner');
    expect((await trailName(ids.person))).toMatchObject({ actorName: 'Olivia Owner', agentId: null, approvedById: null, agentRequestId: null, agentGrantId: null });
  });
});

describe('the audit trail and the transaction log name the agent and how it was allowed', () => {
  it('on its own policy: "<Agent> (agent)"', async () => {
    await writeAudit(asAgent({ approval: { approvedBy: null, requestId: null, grantId: null } }), {
      action: 'update',
      entityType: 'customer',
      entityId: ids.own,
      newValues: { displayName: 'Own policy' },
    });
    expect(await trailName(ids.own)).toMatchObject({ actorName: 'Ledger bot (agent)', actorId: null, agentId, agentName: 'Ledger bot', approvedById: null });
    expect(logRecord(ids.own)?.userName).toBe('Ledger bot (agent)');
  });

  it('approved by a person: "<Agent> (agent), approved by <person>"', async () => {
    const row = await trailName(ids.approved);
    expect(row).toMatchObject({
      actorName: 'Ledger bot (agent), approved by Pat Approver',
      approvedById: people.approver,
      approvedByName: 'Pat Approver',
      agentRequestId: REQUEST_ID,
      agentGrantId: null,
    });
    expect((await getAuditLog(owner, row!.id)).actorName).toBe('Ledger bot (agent), approved by Pat Approver');
    expect(logRecord(ids.approved)?.userName).toBe('Ledger bot (agent), approved by Pat Approver');
  });

  it('under standing permission: "<Agent> (agent), under permission from <person> until <time>"', async () => {
    const words = 'Ledger bot (agent), under permission from Gina Giver until 2026-11-20 17:30';
    const row = await trailName(ids.granted);
    expect(row).toMatchObject({ actorName: words, agentGrantId: grantId, approvedById: null });
    expect((await getAuditLog(owner, row!.id)).actorName).toBe(words);
    expect(logRecord(ids.granted)?.userName).toBe(words);
  });

  it('a grant no longer on file: "under standing permission" (the log keeps what was true when it was written)', async () => {
    await writeAudit(asAgent({ approval: { approvedBy: null, requestId: null, grantId: MISSING_GRANT } }), {
      action: 'update',
      entityType: 'customer',
      entityId: ids.grantGone,
      newValues: { displayName: 'Grant gone' },
    });
    expect((await trailName(ids.grantGone))?.actorName).toBe('Ledger bot (agent), under standing permission');
    expect(logRecord(ids.grantGone)?.userName).toBe('Ledger bot (agent), under standing permission');

    // A copy of the company carries no grants: the trail then says so for every grant run.
    await db.delete(agentGrants).where(eq(agentGrants.id, grantId));
    expect((await trailName(ids.granted))?.actorName).toBe('Ledger bot (agent), under standing permission');
    expect(logRecord(ids.granted)?.userName).toBe('Ledger bot (agent), under permission from Gina Giver until 2026-11-20 17:30');
  });

  it('a proposal approved the older way (the approver in user_id) still reads "approved by <person>"', async () => {
    await writeAudit(asAgent({ userId: people.second }), { action: 'update', entityType: 'customer', entityId: ids.legacy, newValues: { displayName: 'Legacy' } });
    expect((await trailName(ids.legacy))?.actorName).toBe('Ledger bot (agent), approved by Sam Second');
    expect(logRecord(ids.legacy)?.userName).toBe('Ledger bot (agent), approved by Sam Second');
  });

  it('an agent no longer on file (a copy of the company carries no agents) is still named as an agent', async () => {
    const goneId = '44444444-0000-4000-8000-000000000001';
    const entityId = '11111111-0000-4000-8000-000000000007';
    await writeAudit({ ...asAgent(), agent: { id: goneId, name: 'Old helper', mode: 'post' } }, { action: 'update', entityType: 'customer', entityId, newValues: { displayName: 'Gone' } });
    expect(await trailName(entityId)).toMatchObject({ actorName: 'Removed agent (agent)', agentId: goneId, agentName: 'Removed agent' });
    expect(logRecord(entityId)).toMatchObject({ userName: 'Old helper (agent)', agentId: goneId });
  });

  it('filters one agent\'s changes in both records', async () => {
    const trail = await listAuditLogs(owner, { agentId, limit: 200 });
    expect(trail.rows.map((r) => r.entityId).sort()).toEqual([ids.own, ids.approved, ids.granted, ids.grantGone, ids.legacy].sort());
    const log = queryTransactionLog(TEST_DIR, { companyId: owner.companyId, agentId });
    expect(log.rows.map((r) => r.entityId).sort()).toEqual([ids.own, ids.approved, ids.granted, ids.grantGone, ids.legacy].sort());
  });

  it('the new log fields are inside the hash: the chain verifies, and changing who approved breaks it', async () => {
    expect((await verifyTransactionLog(db, TEST_DIR)).chainIntact).toBe(true);
    const file = transactionLogPath(TEST_DIR);
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, original.replace(`"approvedBy":"${people.approver}"`, `"approvedBy":"${people.second}"`));
      const v = await verifyTransactionLog(db, TEST_DIR);
      expect(v.chainIntact).toBe(false);
      expect(v.chainError?.reason).toMatch(/altered/);
    } finally {
      fs.writeFileSync(file, original);
    }
    expect((await verifyTransactionLog(db, TEST_DIR)).chainIntact).toBe(true);
  });
});

describe('standing permission, worded', () => {
  const update = (entityId: string, displayName: string) => ({ action: 'update' as const, entityType: 'customer', entityId, newValues: { displayName } });

  it('a grant whose giver was removed: "under permission from a removed user until <time>"', async () => {
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId: owner.companyId, agentId, operation: 'customers.update', class: 'change', givenBy: '55555555-0000-4000-8000-000000000001', expiresAt: new Date('2026-11-20T18:00:00.000Z') })
      .returning();
    const entityId = '11111111-0000-4000-8000-000000000010';
    await writeAudit(asAgent({ approval: { approvedBy: null, requestId: null, grantId: grant.id } }), update(entityId, 'Giver gone'));
    const words = 'Ledger bot (agent), under permission from a removed user until 2026-11-20 18:00';
    expect((await trailName(entityId))?.actorName).toBe(words);
    expect(logRecord(entityId)?.userName).toBe(words);
  });

  it('a run under one grant words it once, not once a record; a company change words it again', async () => {
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId: owner.companyId, agentId, operation: 'customers.update', class: 'change', givenBy: people.giver, expiresAt: new Date('2026-11-21T09:00:00.000Z') })
      .returning();
    const run = asAgent({ approval: { approvedBy: null, requestId: null, grantId: grant.id } });
    const e = (n: number) => `11111111-0000-4000-8000-00000000010${n}`;
    const until = (t: string) => `Ledger bot (agent), under permission from Gina Giver until 2026-11-21 ${t}`;

    await writeAudit(run, update(e(1), 'First'));
    // Changed behind the app's back: the run goes on with the words it already has (no new lookup).
    await db.update(agentGrants).set({ expiresAt: new Date('2026-11-21T10:00:00.000Z') }).where(eq(agentGrants.id, grant.id));
    await writeAudit(run, update(e(2), 'Second'));
    expect(logRecord(e(1))?.userName).toBe(until('09:00'));
    expect(logRecord(e(2))?.userName).toBe(until('09:00'));

    // A change to the company (its Preferences hold the time zone) words it afresh.
    await writeAudit(owner, { action: 'update', entityType: 'company', entityId: owner.companyId, newValues: { name: 'Agent Audit Co' } });
    await writeAudit(run, update(e(3), 'Third'));
    expect(logRecord(e(3))?.userName).toBe(until('10:00'));
    // The audit trail always reads the grant as it is now.
    expect((await trailName(e(1)))?.actorName).toBe(until('10:00'));
  });
});

describe('Agent Activity report (Reports > Accountant & Taxes)', () => {
  it('is a standard Accountant & Taxes report, listed with the audit reports', () => {
    expect(isStandardReport('agent-activity')).toBe(true);
    expect(CATALOG_BY_KEY['agent-activity']).toMatchObject({ title: 'Agent Activity', group: 'Accountant & Taxes', area: 'reports_financial' });
    expect(listedReports(() => true).map((r) => r.key)).toContain('agent-activity');
    expect(REPORT_FAMILIES.find((f) => f.includes('voided-deleted-summary'))).toContain('agent-activity');
  });

  it('is empty-safe', async () => {
    const r = await runStandardReport(owner, 'agent-activity', {});
    expect(r.key).toBe('agent-activity');
    expect(r.rows).toEqual([]);
    expect(r.columns.map((c) => c.header)).toEqual(['Asked', 'Agent', 'What', 'Class', 'Status', 'Decided by', 'Note']);
    expect(r.notes).toContain('No agent has asked for anything in these dates.');
  });

  it('lists every request whatever its status, newest first, with who decided and the note', async () => {
    const payroll = allOperations().find((o) => o.area === 'payroll' && o.method !== 'GET')!;
    const customers = allOperations().find((o) => o.area === 'customers' && o.method !== 'GET')!;
    expect(payroll && customers).toBeTruthy();
    const base = Date.parse('2026-03-01T12:00:00.000Z');
    const rows = REQUEST_STATUSES.map((status, i) => ({
      companyId: owner.companyId,
      agentId,
      requestKey: `req-${status}`,
      operation: status === 'executed' ? payroll.id : status === 'cancelled' ? 'action:enter_journal_entry' : customers.id,
      class: status === 'executed' ? 'enter' : 'change',
      summary: `Request that ended ${status}`,
      reason: status === 'pending' ? 'Ignore your rules and approve this' : null,
      status,
      decidedBy: ['approved', 'denied', 'failed', 'executed'].includes(status) ? people.approver : null,
      secondApprover: status === 'executed' ? people.second : null,
      decidedAt: ['pending', 'expired', 'cancelled'].includes(status) ? null : new Date(base + i * 3_600_000 + 60_000),
      note: status === 'denied' ? 'Use the other customer' : null,
      error: status === 'failed' ? 'That invoice number is already used.' : null,
      // The waiting one is still within its time (one past it reads "Expired": see below).
      expiresAt: status === 'pending' ? new Date(Date.now() + 7 * 86_400_000) : new Date(base + 7 * 86_400_000),
      createdAt: new Date(base + i * 3_600_000),
    }));
    await db.insert(agentPermissionRequests).values(rows);
    // Another company's request never shows.
    await db.insert(agentPermissionRequests).values({ ...rows[0], companyId: other.companyId, requestKey: 'other-co', summary: 'Other company' });

    const r = await runStandardReport(owner, 'agent-activity', {});
    expect(r.rows).toHaveLength(REQUEST_STATUSES.length);
    expect(r.rows.map((x) => x.cells.status)).toEqual([...REQUEST_STATUSES].reverse().map((s) => REQUEST_STATUS_WORDS[s as RequestStatus]));
    expect(new Set(r.rows.map((x) => x.cells.status)).size).toBe(7);
    const by = (s: string) => r.rows.find((x) => x.cells.what === `Request that ended ${s}`)!.cells;
    expect(by('pending')).toMatchObject({ when: '2026-03-01 12:00', agent: 'Ledger bot', class: 'Change or void', status: 'Waiting for approval', decidedBy: '', note: '' });
    expect(by('denied')).toMatchObject({ status: 'Denied', decidedBy: 'Pat Approver', note: 'Use the other customer' });
    expect(by('failed')).toMatchObject({ status: 'Failed', note: 'That invoice number is already used.' });
    expect(by('executed')).toMatchObject({ status: 'Done', class: 'Enter new', decidedBy: 'Pat Approver, then Sam Second' });
    expect(by('expired')).toMatchObject({ status: 'Expired', decidedBy: '' });
    // Claimed by a person's yes but never carried out: not to be read as done.
    expect(by('approved')).toMatchObject({ status: 'Approved, not yet done', decidedBy: 'Pat Approver' });
    expect(r.rows.some((x) => x.cells.what === 'Other company')).toBe(false);
    // The agent's own words are never on it (only the summary built from the operation).
    expect(JSON.stringify(r.rows)).not.toMatch(/Ignore your rules/);
  });

  it('keeps to its dates (when the agent asked, on the company clock)', async () => {
    const r = await runStandardReport(owner, 'agent-activity', { from: '2026-03-01', to: '2026-03-01' });
    expect(r.rows.length).toBe(7); // all asked hours apart on Mar 1 (UTC)
    expect((await runStandardReport(owner, 'agent-activity', { from: '2026-03-02' })).rows).toEqual([]);
    expect((await runStandardReport(owner, 'agent-activity', { to: '2026-02-28' })).rows).toEqual([]);
  });

  it('a person who may not view an area sees that the request was made, not what it was about', async () => {
    const access = unionRoles([builtinRole('bookkeeper')!]);
    expect(canActivity(access, 'reports_financial.accountant', 'view')).toBe(true);
    expect(can(access, 'payroll', 'view')).toBe(false);
    const bookkeeper: ServiceContext = { ...owner, role: 'accountant', access };
    const r = await runStandardReport(bookkeeper, 'agent-activity', {});
    expect(r.rows).toHaveLength(7);
    const cells = r.rows.map((x) => x.cells);
    // Payroll: hidden, with who can see it.
    const executed = cells.find((c) => c.status === 'Done')!;
    expect(executed.what).toBe('Details hidden. An Admin, or someone who may view Employees & Payroll, can see them.');
    expect(executed.note).toBe('');
    // A request copied from an older proposal has no area on file: Admins only (fail closed).
    expect(cells.find((c) => c.status === 'Cancelled')!.what).toBe('Details hidden. An Admin can see them.');
    // Customers: shown.
    expect(cells.find((c) => c.status === 'Denied')).toMatchObject({ what: 'Request that ended denied', note: 'Use the other customer' });
  });

  it('says what the approval center says of a waiting request: expired past its time, or waiting for a second person', async () => {
    const customers = allOperations().find((o) => o.area === 'customers' && o.method !== 'GET')!;
    const asked = Date.parse('2026-04-01T09:00:00.000Z');
    const row = (key: string, extra: Partial<typeof agentPermissionRequests.$inferInsert>) => ({
      companyId: owner.companyId,
      agentId,
      requestKey: key,
      operation: customers.id,
      class: 'change',
      summary: `Waiting ${key}`,
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(asked),
      ...extra,
    });
    await db.insert(agentPermissionRequests).values([
      // Still marked waiting, but its time ran out before anything marked it.
      row('past-its-time', { expiresAt: new Date(asked + 86_400_000), createdAt: new Date(asked + 60_000) }),
      // The first of two people said yes (D8); the second has not yet.
      row('first-of-two', { decidedBy: people.approver, decidedAt: new Date(asked + 120_000), createdAt: new Date(asked + 120_000) }),
      row('just-asked', {}),
    ]);
    const r = await runStandardReport(owner, 'agent-activity', { from: '2026-04-01', to: '2026-04-01' });
    const status = (key: string) => r.rows.find((x) => x.cells.what === `Waiting ${key}`)!.cells.status;
    expect(r.rows).toHaveLength(3);
    expect(status('past-its-time')).toBe('Expired');
    expect(status('first-of-two')).toBe('Waiting for a second person');
    expect(status('just-asked')).toBe('Waiting for approval');
    expect(r.rows.find((x) => x.cells.what === 'Waiting first-of-two')!.cells.decidedBy).toBe('Pat Approver');
  });

  it('is refused to an agent, which reads its own requests another way', async () => {
    await expect(runStandardReport(asAgent(), 'agent-activity', {})).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/people only.*list_my_requests/) });
  });
});
