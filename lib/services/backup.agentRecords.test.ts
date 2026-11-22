/**
 * A company backup and restore keeps the records of agent work (WAVE5C F11, F15):
 *  - audit rows keep their agent, the person who approved, and the request or standing permission
 *    they ran under, verbatim; the restored Audit Trail reads "Removed agent (agent), approved by
 *    …" (the agent is not in the copy), never the restoring person's own work;
 *  - approved_by is never set to the restorer;
 *  - journal entries keep the agent behind them;
 *  - the "company_restore" row an agent asked for names the agent and the approval.
 * A person's own audit rows are restored as before (user columns → the restorer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { createCompanyBackup, restoreCompanyBackup } from './backup';
import { listAuditLogs } from './auditTrail';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-backup-agent-records');

let db: DB;
let ownerId: string;
let approverId: string;
let restorerId: string;
let ctxA: ServiceContext;
let entryId: string;
const AGENT_ID = randomUUID();
const REQUEST_ID = randomUUID();
const GRANT_ID = randomUUID();

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const mk = async (email: string, name: string) =>
    (await db.insert(users).values({ email, name, passwordHash: 'x' }).returning())[0].id;
  ownerId = await mk('owner-ar@test.local', 'Olive Owner');
  approverId = await mk('approver-ar@test.local', 'Abe Approver');
  restorerId = await mk('restorer-ar@test.local', 'Rita Restorer');
  const company = await createCompany(db, { name: 'Agent Records Co', ownerId });
  ctxA = { db, companyId: company.id, userId: ownerId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));

  // An entry an agent made, approved by a person.
  const agentCtx: ServiceContext = {
    ...ctxA,
    agent: { id: AGENT_ID, name: 'Month-end helper', mode: 'post', onBehalfOf: approverId },
    approval: { approvedBy: approverId, requestId: REQUEST_ID, grantId: null },
  };
  const entry = await createManualEntry(agentCtx, {
    date: new Date('2026-06-01T12:00:00.000Z'),
    description: 'Agent accrual',
    lines: [
      { accountId: acct['6600'], debit: '10.00' },
      { accountId: acct['1000'], credit: '10.00' },
    ],
  });
  entryId = entry.id;
  // The entry names its agent (set directly: the column is what the restore must keep).
  await db.update(journalEntries).set({ agentId: AGENT_ID }).where(eq(journalEntries.id, entryId));
  // A person's own entry.
  await createManualEntry(ctxA, {
    date: new Date('2026-06-02T12:00:00.000Z'),
    description: 'Owner entry',
    lines: [
      { accountId: acct['6600'], debit: '5.00' },
      { accountId: acct['1000'], credit: '5.00' },
    ],
  });
  // A change made under a standing permission, with no approver.
  await db.insert(auditLogs).values({
    companyId: company.id,
    userId: null,
    action: 'update',
    entityType: 'journal_entry',
    entityId: entryId,
    agentId: AGENT_ID,
    agentGrantId: GRANT_ID,
  });
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('company backup and restore: the records of agent work', () => {
  it('keeps the agent, the approver and the request or permission on every restored row', async () => {
    const src = await db.select().from(auditLogs).where(eq(auditLogs.companyId, ctxA.companyId));
    const srcAgentRows = src.filter((r) => r.agentId === AGENT_ID);
    expect(srcAgentRows.length).toBeGreaterThanOrEqual(2);
    const srcPersonRows = src.filter((r) => !r.agentId && r.userId === ownerId);
    expect(srcPersonRows.length).toBeGreaterThan(0);

    const { buffer } = await createCompanyBackup(db, ctxA.companyId);
    const restored = await restoreCompanyBackup(db, buffer, { ownerId: restorerId, name: 'Agent Records Copy' });
    const out = await db.select().from(auditLogs).where(eq(auditLogs.companyId, restored.companyId));

    const agentRows = out.filter((r) => r.agentId === AGENT_ID);
    expect(agentRows).toHaveLength(srcAgentRows.length);
    // Approved rows keep their approver and request; none names the restorer as approver.
    const approved = agentRows.filter((r) => r.agentRequestId === REQUEST_ID);
    expect(approved.length).toBe(srcAgentRows.filter((r) => r.agentRequestId === REQUEST_ID).length);
    expect(approved.length).toBeGreaterThan(0);
    for (const r of approved) expect(r.approvedBy).toBe(approverId);
    const granted = agentRows.filter((r) => r.agentGrantId === GRANT_ID);
    expect(granted).toHaveLength(1);
    expect(granted[0].approvedBy).toBeNull();
    expect(granted[0].userId).toBeNull();
    expect(out.some((r) => r.approvedBy === restorerId)).toBe(false);

    // A person's own rows are restored as before: the restorer.
    const personRows = out.filter((r) => !r.agentId && r.entityType !== 'company_restore');
    expect(personRows.length).toBe(srcPersonRows.length);
    for (const r of personRows) expect(r.userId).toBe(restorerId);

    // The journal entry keeps the agent behind it.
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, restored.companyId), eq(journalEntries.description, 'Agent accrual')));
    expect(entry.agentId).toBe(AGENT_ID);

    // The Audit Trail of the copy: no agents on file there, so "Removed agent", and the approval.
    const ctxB: ServiceContext = { db, companyId: restored.companyId, userId: restorerId };
    const { rows } = await listAuditLogs(ctxB, { limit: 200 });
    const named = rows.filter((r) => r.agentId === AGENT_ID).map((r) => r.actorName);
    expect(named).toContain('Removed agent (agent), approved by Abe Approver');
    expect(named).toContain('Removed agent (agent), under standing permission');
    expect(named.some((n) => n?.includes('Rita Restorer'))).toBe(false);

    // A person's restore: the restore row is the person's own.
    const restoreRow = out.find((r) => r.entityType === 'company_restore')!;
    expect(restoreRow).toMatchObject({ userId: restorerId, agentId: null, approvedBy: null, agentRequestId: null });
  }, 180_000);

  it("a restore an agent asked for is recorded as the agent's, with the approval", async () => {
    const { buffer } = await createCompanyBackup(db, ctxA.companyId);
    const restoreRequest = randomUUID();
    const restored = await restoreCompanyBackup(db, buffer, {
      ownerId: approverId,
      name: 'Agent Records Copy 2',
      agent: { id: AGENT_ID, name: 'Month-end helper', mode: 'post' },
      approval: { approvedBy: approverId, requestId: restoreRequest, grantId: null },
    });
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, restored.companyId), eq(auditLogs.entityType, 'company_restore')));
    expect(row).toMatchObject({ userId: approverId, agentId: AGENT_ID, approvedBy: approverId, agentRequestId: restoreRequest });
    const { rows } = await listAuditLogs({ db, companyId: restored.companyId, userId: approverId }, { entityType: 'company_restore' });
    expect(rows[0].actorName).toBe('Removed agent (agent), approved by Abe Approver');
  }, 180_000);
});
