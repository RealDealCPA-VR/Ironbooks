/**
 * Agent full access, records (plan §7.3 and §12):
 *
 *  - writeAudit stores what an agent's change ran under (ServiceContext.approval: set by the route
 *    bridge on an agent's run, and by the approval center on a person's decision) on the audit row
 *    (approved_by / agent_request_id / agent_grant_id) and on the transaction log record; any
 *    other change by a person is recorded exactly as before;
 *  - the audit trail and the transaction log name the agent and how its change was allowed:
 *    "<Agent> (agent)", "..., approved by <person>", "..., under permission from <person> until
 *    <time>", or "..., under standing permission" when the grant is no longer on file, and
 *    "..., under standing permission from a removed user until <time>" for a giver no longer on
 *    file; a run under one grant words it once per database transaction (savepoints included);
 *  - the new record fields are inside the log's hash: changing one breaks the chain;
 *  - an entry's snapshot shows the account number in memo text ("Acct # …") masked to a person
 *    without "view full account numbers";
 *  - the records of agents' requests and standing permission are for people who manage users; their
 *    note, message and limits only for one who may also view the work they were about, in the
 *    audit trail and in a transaction-log record (logRecordDataFor);
 *  - an agent's read of the audit trail leaves out Users & Roles and File Utilities and never sees
 *    the whole log, whatever its role;
 *  - the Agent Activity report lists every permission request whatever its status, is empty-safe,
 *    keeps to its dates and company, reads each status through the approval center's own
 *    shownStatus (expired past its time) and says "being carried out" and "waiting for a second
 *    person" in the center's own words, marks a first-of-two approver before and after the request
 *    is settled, hides what a request was about from a person who may not view that area, and is
 *    refused to an agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { agentGrants, agentPermissionRequests, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, can, canActivity, unionRoles, type EffectiveAccess } from '@/lib/permissions/model';
import { allOperations } from '@/lib/agent/operations/registry';
import { REQUEST_STATUSES, type RequestStatus } from '@/lib/agent/operations/types';
import { CATALOG_BY_KEY, REPORT_FAMILIES, listedReports } from '@/lib/reports/catalog';
import { inTransaction, writeAudit, type ServiceContext } from './_base';
import { STATUS_LABELS, statusLabel } from '@/app/agent-requests/words';
import {
  FIRST_OF_TWO,
  WAITING_FOR_SECOND_PERSON,
  auditReaderFor,
  getAuditLog,
  listAuditLogs,
  logRecordDataFor,
  REQUEST_STATUS_WORDS,
} from './auditTrail';
import { auditEntityRef, auditValuesFor, canSeeAuditEntry } from './auditVisibility';
import { approveAgentRequest, cancelAgentRequest, expireRequests, shownStatus } from './agentRequests';
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

  it('a grant whose giver was removed: "under standing permission from a removed user until <time>"', async () => {
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId: owner.companyId, agentId, operation: 'customers.update', class: 'change', givenBy: '55555555-0000-4000-8000-000000000001', expiresAt: new Date('2026-11-20T18:00:00.000Z') })
      .returning();
    const entityId = '11111111-0000-4000-8000-000000000010';
    await writeAudit(asAgent({ approval: { approvedBy: null, requestId: null, grantId: grant.id } }), update(entityId, 'Giver gone'));
    const words = 'Ledger bot (agent), under standing permission from a removed user until 2026-11-20 18:00';
    expect((await trailName(entityId))?.actorName).toBe(words);
    expect(logRecord(entityId)?.userName).toBe(words);
  });

  it('a run under one grant words it once per transaction, savepoints included; the next transaction words it afresh', async () => {
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId: owner.companyId, agentId, operation: 'customers.update', class: 'change', givenBy: people.giver, expiresAt: new Date('2026-11-21T09:00:00.000Z') })
      .returning();
    const run = asAgent({ approval: { approvedBy: null, requestId: null, grantId: grant.id } });
    const e = (n: number) => `11111111-0000-4000-8000-00000000010${n}`;
    const until = (t: string) => `Ledger bot (agent), under permission from Gina Giver until 2026-11-21 ${t}`;
    const moveEnd = (tx: ServiceContext, iso: string) => tx.db.update(agentGrants).set({ expiresAt: new Date(iso) }).where(eq(agentGrants.id, grant.id));

    await inTransaction(run, async (tx) => {
      await writeAudit(tx, update(e(1), 'First'));
      // Changed behind the app's back inside the run: the rest of it keeps the words it already
      // has, which shows it did not look the grant up again for the next record.
      await moveEnd(tx, '2026-11-21T10:00:00.000Z');
      await writeAudit(tx, update(e(2), 'Second'));
      // A service's own inTransaction inside the run is a savepoint of the same transaction.
      await inTransaction(tx, async (inner) => writeAudit(inner, update(e(3), 'Third')));
    });
    expect(logRecord(e(1))?.userName).toBe(until('09:00'));
    expect(logRecord(e(2))?.userName).toBe(until('09:00'));
    expect(logRecord(e(3))?.userName).toBe(until('09:00'));

    // The next transaction looks the grant up again: nothing is older than the run that uses it.
    await inTransaction(run, async (tx) => writeAudit(tx, update(e(4), 'Fourth')));
    expect(logRecord(e(4))?.userName).toBe(until('10:00'));
    // So does a write outside any transaction (it is one of its own).
    await moveEnd(owner, '2026-11-21T11:00:00.000Z');
    await writeAudit(run, update(e(5), 'Fifth'));
    expect(logRecord(e(5))?.userName).toBe(until('11:00'));

    // A change to the company (its Preferences hold the time zone) inside the run words it afresh.
    await inTransaction(run, async (tx) => {
      await writeAudit(tx, update(e(6), 'Sixth'));
      await moveEnd(tx, '2026-11-21T12:00:00.000Z');
      await writeAudit({ ...tx, agent: undefined, approval: undefined, userId: people.owner }, { action: 'update', entityType: 'company', entityId: owner.companyId, newValues: { name: 'Agent Audit Co' } });
      await writeAudit(tx, update(e(7), 'Seventh'));
    });
    expect(logRecord(e(6))?.userName).toBe(until('11:00'));
    expect(logRecord(e(7))?.userName).toBe(until('12:00'));
    // The audit trail always reads the grant as it is now.
    expect((await trailName(e(1)))?.actorName).toBe(until('12:00'));
  });

  it('a rolled-back run leaves no words behind for the next one', async () => {
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId: owner.companyId, agentId, operation: 'customers.update', class: 'change', givenBy: people.giver, expiresAt: new Date('2026-11-22T09:00:00.000Z') })
      .returning();
    const run = asAgent({ approval: { approvedBy: null, requestId: null, grantId: grant.id } });
    const entityId = '11111111-0000-4000-8000-000000000201';
    await expect(
      inTransaction(run, async (tx) => {
        await writeAudit(tx, update(entityId, 'Rolled back'));
        throw new Error('dry run');
      }),
    ).rejects.toThrow('dry run');
    expect(logRecord(entityId)).toBeUndefined();
    await db.update(agentGrants).set({ expiresAt: new Date('2026-11-22T10:00:00.000Z') }).where(eq(agentGrants.id, grant.id));
    await inTransaction(run, async (tx) => writeAudit(tx, update(entityId, 'Kept')));
    expect(logRecord(entityId)?.userName).toBe('Ledger bot (agent), under permission from Gina Giver until 2026-11-22 10:00');
  });
});

describe('an entry\'s snapshot as a person may see it', () => {
  const bookkeeperAccess = (): EffectiveAccess => unionRoles([builtinRole('bookkeeper')!]);
  const FULL = 'Acct # 000123456789';
  const MASKED = 'Acct # ••••6789';

  it('masks the account number in a check\'s memo for a person without "view full account numbers"', async () => {
    const checkId = '66666666-0000-4000-8000-000000000001';
    // As liabilityPayments.ts insertPaymentCheck writes it: the whole stored row.
    await writeAudit(owner, {
      action: 'create',
      entityType: 'payment_check',
      entityId: checkId,
      newValues: { id: checkId, kind: 'sales_tax', payeeName: 'State Tax Board', memo: FULL, amount: '120.00', accountNumber: '000123456789' },
    });
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, checkId));
    const access = bookkeeperAccess();
    expect(access.flags.fullAccountNumbers).toBe(false);
    expect(canSeeAuditEntry(access, 'payment_check', null, row.newValues)).toBe(true);

    const masked = await getAuditLog({ ...owner, role: 'accountant', access }, row.id);
    expect(masked.newValues).toMatchObject({ memo: MASKED, accountNumber: '••••6789', payeeName: 'State Tax Board', amount: '120.00' });
    expect(JSON.stringify(masked)).not.toContain('000123456789');
    // The transaction log's record of the same change, by the same rule (logRecordDataFor).
    const logged = logRecordDataFor(access, logRecord(checkId)!);
    expect(logged).toMatchObject({ new: { memo: MASKED, accountNumber: '••••6789' } });
    expect(JSON.stringify(logged)).not.toContain('000123456789');

    // With the right, and for a trusted context, the memo is as stored.
    const withRight: EffectiveAccess = { ...access, flags: { ...access.flags, fullAccountNumbers: true } };
    expect((await getAuditLog({ ...owner, role: 'accountant', access: withRight }, row.id)).newValues).toMatchObject({ memo: FULL });
    expect((await getAuditLog(owner, row.id)).newValues).toMatchObject({ memo: FULL });
  });

  it('masks it on journal lines too (older Sales Tax Payment entries), and leaves text the mask wrote as it is', () => {
    const access = bookkeeperAccess();
    const entry = { description: 'Pay Sales Tax — State Tax Board', lines: [{ memo: FULL, debit: '120.00' }, { memo: 'Paid in full', credit: '120.00' }] };
    expect(auditValuesFor(access, entry)).toEqual({ ...entry, lines: [{ memo: MASKED, debit: '120.00' }, { memo: 'Paid in full', credit: '120.00' }] });
    // Already masked (a check's answer that found its way into a snapshot): unchanged.
    expect(auditValuesFor(access, { memo: MASKED })).toEqual({ memo: MASKED });
    expect(auditValuesFor(access, auditValuesFor(access, { memo: FULL }))).toEqual({ memo: MASKED });
    // A "*" or "•" in a typed memo does not make the rest safe to show.
    expect(auditValuesFor(access, { memo: 'acct # *1234-5678*' })).toEqual({ memo: 'acct # ••••678*' });
    // Only memo text: a name that happens to read like a label is left as stored.
    expect(auditValuesFor(access, { displayName: 'Acct # 42 Holdings' })).toEqual({ displayName: 'Acct # 42 Holdings' });
    // The input is never changed.
    expect(entry.lines[0].memo).toBe(FULL);
    // Credential material is gone for everyone, trusted contexts included; they see the rest as stored.
    expect(auditValuesFor(undefined, { memo: FULL, passwordHash: 'x' })).toEqual({ memo: FULL });
  });
});

describe('records of agents\' requests and standing permission', () => {
  it('belong to Users & Roles > Users, like the agent: not Admin-only by accident, never for a Bookkeeper', async () => {
    for (const kind of ['agent_permission_request', 'agent_grant']) expect(auditEntityRef(kind), kind).toBe('users.users');
    expect(auditEntityRef('agent')).toBe('users.users');

    const manager = unionRoles([
      { key: 'user-manager', name: 'User manager', description: '', builtin: false, permissions: { users: ['view'], reports_financial: ['view'] }, flags: {} },
    ]);
    expect(manager.isAdmin).toBe(false);
    const bookkeeper = unionRoles([builtinRole('bookkeeper')!]);
    for (const kind of ['agent_permission_request', 'agent_grant']) {
      expect(canSeeAuditEntry(manager, kind, null, { status: 'denied' }), kind).toBe(true);
      expect(canSeeAuditEntry(bookkeeper, kind, null, { status: 'denied' }), kind).toBe(false);
    }

    const requestId = '77777777-0000-4000-8000-000000000001';
    await writeAudit({ ...owner, approval: { approvedBy: null, requestId, grantId: null } }, {
      action: 'update',
      entityType: 'agent_permission_request',
      entityId: requestId,
      oldValues: { status: 'pending' },
      newValues: { status: 'denied', operation: 'customers.update', agentId },
    });
    const managerRows = await listAuditLogs({ ...owner, role: 'accountant', access: manager }, { entityType: 'agent_permission_request' });
    expect(managerRows.rows.map((r) => r.entityId)).toContain(requestId);
    expect((await listAuditLogs({ ...owner, role: 'accountant', access: bookkeeper }, { entityType: 'agent_permission_request' })).total).toBe(0);
  });

  it('show the note, the message and the limits only to someone who may view the work they were about', async () => {
    const payroll = allOperations().find((o) => o.area === 'payroll' && o.method !== 'GET')!;
    const customers = allOperations().find((o) => o.area === 'customers' && o.method !== 'GET')!;
    const NOTE = 'Dana Lee is on leave, pay her next week';
    const ERROR = "Dana Lee's paycheck for this period is already posted.";
    const LIMITS = { maxAmount: '2500.00', entityIds: ['88888888-0000-4000-8000-000000000001'] };
    const e = { payroll: '77777777-0000-4000-8000-000000000002', grant: '77777777-0000-4000-8000-000000000003', customer: '77777777-0000-4000-8000-000000000004', unknown: '77777777-0000-4000-8000-000000000005' };
    const decided = (entityId: string, newValues: Record<string, unknown>) =>
      writeAudit({ ...owner, approval: { approvedBy: null, requestId: entityId, grantId: null } }, { action: 'update', entityType: 'agent_permission_request', entityId, oldValues: { status: 'pending' }, newValues });
    // As agentRequests.ts auditDecision writes them.
    await decided(e.payroll, { operation: payroll.id, agentId, status: 'failed', approvedBy: people.approver, error: ERROR, grantNotGiven: 'Standing permission was not given for Dana Lee.', note: NOTE });
    await decided(e.customer, { operation: customers.id, agentId, status: 'denied', deniedBy: people.approver, note: 'Use the other customer' });
    // A record that names no operation (fail closed: Admins only).
    await decided(e.unknown, { status: 'denied', note: 'Not this one' });
    // As agentGrants.ts writes a new grant.
    await writeAudit(owner, {
      action: 'create',
      entityType: 'agent_grant',
      entityId: e.grant,
      newValues: { agentId, agentName: AGENT.name, operation: payroll.id, class: 'enter', constraints: LIMITS, minutes: 60, expiresAt: '2026-11-20T18:00:00.000Z', requestId: e.payroll },
    });

    const manager = unionRoles([
      { key: 'user-manager', name: 'User manager', description: '', builtin: false, permissions: { users: ['view'], customers: ['view'], reports_financial: ['view'] }, flags: {} },
    ]);
    const payrollManager = unionRoles([
      {
        key: 'payroll-user-manager',
        name: 'Payroll and user manager',
        description: '',
        builtin: false,
        permissions: { users: ['view'], customers: ['view'], payroll: ['view'], reports_financial: ['view'] },
        flags: {},
      },
    ]);
    const admin = unionRoles([builtinRole('admin')!]);
    const values = async (access: EffectiveAccess | undefined, entityId: string) =>
      (await getAuditLog(access ? { ...owner, role: 'accountant', access } : owner, (await auditRow(entityId)).id)).newValues;
    const HIDDEN = 'Details hidden. An Admin, or someone who may view Employees & Payroll, can see them.';

    // Managing agents shows that the payroll request was made and how it ended, not its details.
    expect(await values(manager, e.payroll)).toEqual({ operation: payroll.id, agentId, status: 'failed', approvedBy: people.approver, error: HIDDEN, grantNotGiven: HIDDEN, note: HIDDEN });
    expect(JSON.stringify(await getAuditLog({ ...owner, role: 'accountant', access: manager }, (await auditRow(e.payroll)).id))).not.toContain('Dana Lee');
    expect(await values(manager, e.grant)).toMatchObject({ operation: payroll.id, class: 'enter', minutes: 60, constraints: HIDDEN });
    // A request whose work they may view: shown.
    expect(await values(manager, e.customer)).toMatchObject({ note: 'Use the other customer' });
    // No operation on record: only an Admin sees its details.
    expect(await values(manager, e.unknown)).toEqual({ status: 'denied', note: 'Details hidden. An Admin can see them.' });
    // With the payroll right, as an Admin and in a trusted context: as stored.
    for (const access of [payrollManager, admin, undefined]) {
      expect(await values(access, e.payroll)).toMatchObject({ note: NOTE, error: ERROR });
      expect(await values(access, e.grant)).toMatchObject({ constraints: LIMITS });
    }
    expect(await values(admin, e.unknown)).toMatchObject({ note: 'Not this one' });

    // The same rule for the transaction log's record of it.
    const rec = logRecord(e.payroll)!;
    expect(logRecordDataFor(manager, rec)).toEqual({ old: { status: 'pending' }, new: expect.objectContaining({ note: HIDDEN, error: HIDDEN, operation: payroll.id }) });
    expect(logRecordDataFor(payrollManager, rec)).toMatchObject({ new: { note: NOTE, error: ERROR } });
    expect(logRecordDataFor(manager, logRecord(e.grant)!)).toMatchObject({ new: { constraints: HIDDEN } });
    expect((rec.data as { new: { note: string } }).new.note).toBe(NOTE); // the record itself is never changed
  });
});

describe('an agent reading the audit trail', () => {
  const agentOf = { id: '44444444-0000-4000-8000-000000000002', ...AGENT };

  it('never sees the entries of Users & Roles or File Utilities, nor the whole log, whatever its role', async () => {
    const admin = unionRoles([builtinRole('admin')!]);
    expect(admin.isAdmin).toBe(true);
    const reader = auditReaderFor({ access: admin, agent: agentOf })!;
    expect(reader.isAdmin).toBe(false);
    for (const kind of ['user', 'role', 'agent', 'agent_permission_request', 'agent_grant', 'company_restore', 'sandbox']) {
      expect(canSeeAuditEntry(reader, kind, null, null), kind).toBe(false);
    }
    expect(canSeeAuditEntry(reader, 'customer', null, null)).toBe(true);
    // A person with the same role reads them all.
    expect(auditReaderFor({ access: admin })).toBe(admin);
    // A context without an access (a test's) is not the whole log for an agent either.
    const bare = auditReaderFor({ agent: agentOf })!;
    expect(bare.isAdmin).toBe(false);
    expect(canSeeAuditEntry(bare, 'agent_permission_request', null, null)).toBe(false);
    expect(bare.flags.fullAccountNumbers).toBe(false);

    // A run through the door keeps its role's Users area (lib/agent/operate.ts ownRunAccess): the
    // audit trail leaves it out anyway, so an agent never reads other agents' requests or the
    // approvers' notes this way.
    const manager = unionRoles([
      { key: 'user-manager', name: 'User manager', description: '', builtin: false, permissions: { users: ['view'], customers: ['view'], reports_financial: ['view'] }, flags: {} },
    ]);
    const asPerson = await listAuditLogs({ ...owner, role: 'accountant', access: manager }, { entityType: 'agent_permission_request' });
    expect(asPerson.total).toBeGreaterThan(0);
    const run = asAgent({ access: manager });
    expect((await listAuditLogs(run, { entityType: 'agent_permission_request' })).total).toBe(0);
    await expect(getAuditLog(run, asPerson.rows[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Its own and everyone's customer changes are still there.
    const customersSeen = await listAuditLogs(run, { entityType: 'customer', limit: 200 });
    expect(customersSeen.total).toBeGreaterThan(0);
    expect((await getAuditLog(run, customersSeen.rows[0].id)).entityType).toBe('customer');
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
    // Claimed by a person's yes and not yet marked done or failed: what the approval center calls
    // "being carried out right now", never read as done.
    expect(by('approved')).toMatchObject({ status: 'Approved, being carried out', decidedBy: 'Pat Approver' });
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

  it('says what the approval center says of a waiting request: expired past its time, or waiting for a second person, whose first approver is marked', async () => {
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
      // The first of two said yes, then nobody else did in time.
      row('first-then-expired', { decidedBy: people.approver, decidedAt: new Date(asked + 150_000), createdAt: new Date(asked + 150_000), expiresAt: new Date(asked + 86_400_000) }),
      row('just-asked', {}),
      // Settled already: the sweep keeps decided_by when it marks a request expired, and so does
      // the agent taking a request back (or a copy of the company cancelling it).
      row('first-then-marked-expired', { status: 'expired', decidedBy: people.approver, decidedAt: new Date(asked + 180_000), createdAt: new Date(asked + 180_000), expiresAt: new Date(asked + 86_400_000) }),
      row('first-then-taken-back', { status: 'cancelled', decidedBy: people.approver, decidedAt: new Date(asked + 210_000), createdAt: new Date(asked + 210_000) }),
      // Copied from an older proposal, which never takes two approvals: a person there is the one
      // who decided the proposal under Ask AI, not a first of two.
      row('copied-decided', { status: 'cancelled', operation: 'action:enter_journal_entry', proposalId: '99999999-0000-4000-8000-000000000001', decidedBy: people.approver, decidedAt: new Date(asked + 240_000), createdAt: new Date(asked + 240_000) }),
    ]);
    const report = async () => {
      const r = await runStandardReport(owner, 'agent-activity', { from: '2026-04-01', to: '2026-04-01' });
      expect(r.rows).toHaveLength(7);
      return (key: string) => r.rows.find((x) => x.cells.what === `Waiting ${key}`)!.cells;
    };
    const cells = await report();
    expect(cells('past-its-time')).toMatchObject({ status: 'Expired', decidedBy: '' });
    expect(cells('first-of-two')).toMatchObject({ status: WAITING_FOR_SECOND_PERSON, decidedBy: `Pat Approver ${FIRST_OF_TWO}` });
    expect(cells('first-of-two').decidedBy).toBe('Pat Approver (first of two)');
    expect(cells('first-then-expired')).toMatchObject({ status: 'Expired', decidedBy: 'Pat Approver (first of two)' });
    expect(cells('just-asked')).toMatchObject({ status: 'Waiting for approval', decidedBy: '' });
    expect(cells('first-then-marked-expired')).toMatchObject({ status: 'Expired', decidedBy: 'Pat Approver (first of two)' });
    expect(cells('first-then-taken-back')).toMatchObject({ status: 'Cancelled', decidedBy: 'Pat Approver (first of two)' });
    expect(cells('copied-decided')).toMatchObject({ status: 'Cancelled', decidedBy: 'Pat Approver' });

    // The approval center's own sweep marks the two past their time expired: the report reads the
    // same before and after it.
    expect(await expireRequests(owner)).toBeGreaterThanOrEqual(2);
    const [swept] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.requestKey, 'first-then-expired'));
    expect(swept).toMatchObject({ status: 'expired', decidedBy: people.approver, secondApprover: null });
    const after = await report();
    for (const key of ['past-its-time', 'first-of-two', 'first-then-expired', 'just-asked', 'first-then-marked-expired', 'first-then-taken-back', 'copied-decided']) {
      expect(after(key), key).toEqual(cells(key));
    }
  });

  it('keeps the first approver marked when the agent takes back a request one of two people approved (the real paths)', async () => {
    const op = allOperations().find((o) => o.area === 'customers' && o.method !== 'GET' && o.availability === 'agent' && !o.hostOnly && !o.fileAdmin)!;
    const [asked] = await db
      .insert(agentPermissionRequests)
      .values({
        companyId: owner.companyId,
        agentId,
        requestKey: 'first-then-withdrawn',
        operation: op.id,
        class: 'change',
        summary: 'Waiting first-then-withdrawn',
        status: 'pending',
        // Two people must say yes (D8); nothing else is asked of them.
        needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, flags: [], grantAdminOnly: false, secrets: [], twoPerson: true, grantable: 'no' },
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date('2026-05-01T09:00:00.000Z'),
      })
      .returning();
    // The first yes, through the approval center; then the agent withdraws the request.
    expect((await approveAgentRequest(owner, asked.id, {}, { atHost: true })).status).toBe('needs_second_approver');
    expect((await cancelAgentRequest(asAgent(), asked.id)).status).toBe('cancelled');
    const [stored] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, asked.id));
    expect(stored).toMatchObject({ status: 'cancelled', decidedBy: people.owner, secondApprover: null });
    const r = await runStandardReport(owner, 'agent-activity', { from: '2026-05-01', to: '2026-05-01' });
    expect(r.rows.map((x) => x.cells)).toEqual([
      expect.objectContaining({ what: 'Waiting first-then-withdrawn', status: 'Cancelled', decidedBy: 'Olivia Owner (first of two)' }),
    ]);
  });

  it('reads every request through the approval center\'s own shownStatus', async () => {
    const stored = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.companyId, owner.companyId));
    const r = await runStandardReport(owner, 'agent-activity', {});
    expect(r.rows).toHaveLength(stored.length);
    const now = new Date();
    for (const s of stored) {
      const shown = shownStatus(s, now);
      const words = shown === 'pending' && s.decidedBy ? WAITING_FOR_SECOND_PERSON : REQUEST_STATUS_WORDS[shown];
      expect(r.rows.find((x) => x.id === `aa:${s.id}`)!.cells.status, s.requestKey).toBe(words);
    }
  });

  it('says "being carried out" and "waiting for a second person" in the approval center\'s own words', async () => {
    // Claimed by a person's yes just now (the sweep above marked the older one failed: its run
    // could not still be going).
    const customers = allOperations().find((o) => o.area === 'customers' && o.method !== 'GET')!;
    await db.insert(agentPermissionRequests).values({
      companyId: owner.companyId,
      agentId,
      requestKey: 'being-carried-out',
      operation: customers.id,
      class: 'change',
      summary: 'Being carried out',
      status: 'approved',
      decidedBy: people.approver,
      decidedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const stored = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.companyId, owner.companyId));
    const r = await runStandardReport(owner, 'agent-activity', {});
    const now = new Date();
    const center = (s: (typeof stored)[number]) => statusLabel({ status: shownStatus(s, now), decidedByName: s.decidedBy ? 'Pat Approver' : null });
    const reportWords = (s: (typeof stored)[number]) => r.rows.find((x) => x.id === `aa:${s.id}`)!.cells.status;
    const carriedOut = stored.filter((s) => s.status === 'approved');
    const secondPerson = stored.filter((s) => shownStatus(s, now) === 'pending' && s.decidedBy);
    expect(carriedOut.length && secondPerson.length).toBeTruthy();
    for (const s of [...carriedOut, ...secondPerson]) expect(reportWords(s), s.requestKey).toBe(center(s));
    // Expired, denied and done read the same in both too.
    for (const s of stored.filter((x) => ['expired', 'denied', 'executed'].includes(shownStatus(x, now)))) {
      expect(reportWords(s), s.requestKey).toBe(center(s));
    }
    // They differ on purpose only for these: a report row says what it waits for, "Failed" is the
    // audit's word, and a cancellation may not be the agent's own (a copy of the company).
    const differ = (Object.keys(REQUEST_STATUS_WORDS) as RequestStatus[]).filter((k) => REQUEST_STATUS_WORDS[k] !== STATUS_LABELS[k]);
    expect(differ.sort()).toEqual(['cancelled', 'failed', 'pending']);
  });

  it('is refused to an agent, which reads its own requests another way', async () => {
    await expect(runStandardReport(asAgent(), 'agent-activity', {})).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/people only.*list_my_requests/) });
  });
});

describe('work two people approved names both', () => {
  it('approved by two people (the two-person rule): "<Agent> (agent), approved by <first> and <second>" (WAVE5C F16)', async () => {
    const [req] = await db
      .insert(agentPermissionRequests)
      .values({
        companyId: owner.companyId,
        agentId,
        requestKey: 'two-people',
        operation: 'customers.update',
        class: 'change',
        summary: 'Change a customer',
        status: 'approved',
        decidedBy: people.approver,
        secondApprover: people.second,
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const entityId = '11111111-0000-4000-8000-000000000016';
    await writeAudit(asAgent({ userId: people.second, approval: { approvedBy: people.second, requestId: req.id, grantId: null } }), {
      action: 'update',
      entityType: 'customer',
      entityId,
      newValues: { displayName: 'Two-person change' },
    });
    const words = 'Ledger bot (agent), approved by Pat Approver and Sam Second';
    const row = await trailName(entityId);
    expect(row).toMatchObject({ actorName: words, approvedById: people.second, approvedByName: 'Sam Second', agentRequestId: req.id });
    expect((await getAuditLog(owner, row!.id)).actorName).toBe(words);
    expect(logRecord(entityId)?.userName).toBe(words);
    // One person's approval (the request names no second approver) still names one.
    expect((await trailName(ids.approved))?.actorName).toBe('Ledger bot (agent), approved by Pat Approver');
    // Out of the Agent Activity report's counts below.
    await db.delete(agentPermissionRequests).where(eq(agentPermissionRequests.id, req.id));
  });
});
