/**
 * Agent access: the life of an agent and its token (lib/services/agents.ts).
 *
 *  - an Admin makes an agent and gets the token once; the database holds only a digest;
 *  - nothing listed or returned afterwards contains the token or the digest;
 *  - a token finds its agent until the agent is removed, and never on another computer's key;
 *  - only an Admin makes or removes agents, an agent is never an Admin, and both are audited
 *    with the Admin as the one who did it;
 *  - an agent's access is its roles' access without Admin, Users & Roles, File Utilities and the
 *    sensitive flags;
 *  - what an agent does is recorded under its own name (audit trail and transaction log);
 *  - the agents table never travels in copies, and restoring a backup removes every agent's access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agents');
const TEST_DIR = path.join(ROOT, 'live');
const RESTORE_DIR = path.join(ROOT, 'restored');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agents-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

import { getDb, closeDb, type DB } from '@/lib/db';
import { agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, fullAccess, unionRoles } from '@/lib/permissions/model';
import { canActivity } from '@/lib/permissions/model';
import { AGENT_TOKEN_RE } from '@/lib/net/agentToken';
import { stripSecrets } from '@/lib/permissions/mask';
import { createCompany } from './company';
import { ServiceError, type ServiceContext, writeAudit } from './_base';
import {
  agentAccess,
  agentFileTag,
  agentTokenDigest,
  createAgent,
  findAgentByToken,
  listAgents,
  revokeAgent,
  revokeAllAgents,
} from './agents';
import { listAuditLogs } from './auditTrail';
import { readAllTransactionLog } from './transactionLog';
import { COMPANY_BACKUP_EXCLUDED_TABLES, createBackup, restoreBackup } from './backup';
import { OUTSIDER_SCRUBBED } from './portableFile';
import { createRole } from './users';

let db: DB;
let admin: ServiceContext;
let bookkeeper: ServiceContext;
let adminId: string;

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    if (message) expect((e as ServiceError).message).toMatch(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'admin@agents.test', name: 'Ada Admin', passwordHash: 'x' }).returning();
  const [other] = await db.insert(users).values({ email: 'bk@agents.test', name: 'Bo Bookkeeper', passwordHash: 'x' }).returning();
  adminId = owner.id;
  const company = await createCompany(db, { name: 'Agents Co', ownerId: owner.id });
  admin = { db, companyId: company.id, userId: owner.id, role: 'owner', access: fullAccess() };
  bookkeeper = { db, companyId: company.id, userId: other.id, role: 'accountant', access: unionRoles([builtinRole('bookkeeper')!]) };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  await closeDb(RESTORE_DIR).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('making an agent', () => {
  let token: string;
  let agentId: string;

  it('returns the token once and stores only a digest', async () => {
    const made = await createAgent(admin, { name: 'Month-end helper', roleKeys: ['bookkeeper'], mode: 'read_only' });
    token = made.token;
    agentId = made.agent.id;
    expect(token).toMatch(AGENT_TOKEN_RE);
    expect(token.slice(5, 13)).toBe(agentFileTag());
    expect(made.agent).toMatchObject({ name: 'Month-end helper', roleKeys: ['bookkeeper'], roleNames: ['Bookkeeper'], mode: 'read_only', status: 'active' });

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(agentTokenDigest(token).hash);
    expect(row.createdBy).toBe(adminId);
    // Nothing in the row lets the token be rebuilt: only its first characters, for display.
    const secret = token.slice(14);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.tokenPrefix).toBe(token.slice(0, 18));
    expect(row.tokenPrefix.length).toBeLessThan(token.length - 30);
  });

  it('never lists the token or its digest', async () => {
    const listed = await listAgents(admin);
    expect(listed).toHaveLength(1);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(token.slice(14));
    expect(text).not.toContain(agentTokenDigest(token).hash);
    expect(Object.keys(listed[0])).not.toContain('tokenHash');
    // And an API answer that carried a row by mistake would lose the digest (stripSecrets).
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stripSecrets({ ...row })).not.toHaveProperty('tokenHash');
  });

  it('writes the audit trail with the Admin as the one who did it, and no token', async () => {
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create', entityType: 'agent', userId: adminId, agentId: null });
    expect(JSON.stringify(rows[0])).not.toContain(token.slice(14));
    expect(JSON.stringify(rows[0])).not.toContain(agentTokenDigest(token).hash);
  });

  it('finds the agent by its token, and nothing by a wrong one', async () => {
    expect(await findAgentByToken(db, token)).toMatchObject({ id: agentId, name: 'Month-end helper', mode: 'read_only', roleKeys: ['bookkeeper'] });
    const wrong = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    expect(await findAgentByToken(db, wrong)).toBeNull();
    expect(await findAgentByToken(db, 'ibka_short')).toBeNull();
    expect(await findAgentByToken(db, '')).toBeNull();
    expect(await findAgentByToken(db, agentTokenDigest(token).hash)).toBeNull(); // the digest is not a token
  });

  it('accepts a token only under the key it was made with', async () => {
    // Made here without a device secret. On a computer that has one (the desktop app), a row
    // without that secret's key id is refused: a file that arrives with agents in it has none
    // that work, even if whoever made it knows the tokens.
    process.env.BKA_DEVICE_VAULT = 'ab'.repeat(32);
    try {
      expect(await findAgentByToken(db, token)).toBeNull();
      const keyed = await createAgent(admin, { name: 'Keyed here', roleKeys: ['view_only'], mode: 'read_only' });
      expect(await findAgentByToken(db, keyed.token)).toMatchObject({ name: 'Keyed here' });
      const [row] = await db.select().from(agents).where(eq(agents.id, keyed.agent.id));
      expect(row.keyId).toMatch(/^[0-9a-f]{8}$/);
      // Another computer (another device secret): the same file, the same token, no agent.
      process.env.BKA_DEVICE_VAULT = 'cd'.repeat(32);
      expect(await findAgentByToken(db, keyed.token)).toBeNull();
      delete process.env.BKA_DEVICE_VAULT;
      expect(await findAgentByToken(db, keyed.token)).toBeNull();
      await revokeAgent(admin, keyed.agent.id);
    } finally {
      delete process.env.BKA_DEVICE_VAULT;
    }
    expect(await findAgentByToken(db, token)).toMatchObject({ id: agentId });
  });

  it('removing it stops the token at once, and is audited', async () => {
    const removed = await revokeAgent(admin, agentId);
    expect(removed.status).toBe('revoked');
    expect(await findAgentByToken(db, token)).toBeNull();
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, agentId));
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'update']);
    expect(rows.find((r) => r.action === 'update')).toMatchObject({ userId: adminId, newValues: { name: 'Month-end helper', revoked: true } });
    // Removing twice changes nothing and writes nothing more.
    await revokeAgent(admin, agentId);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.entityId, agentId))).toHaveLength(2);
  });
});

describe('who may make agents, and what an agent may be', () => {
  it('only an Admin makes, lists or removes agents', async () => {
    await expectError(createAgent(bookkeeper, { name: 'Sneaky', roleKeys: ['view_only'], mode: 'read_only' }), 'FORBIDDEN', /Admin/);
    await expectError(listAgents(bookkeeper), 'FORBIDDEN', /Admin/);
    const made = await createAgent(admin, { name: 'To remove', roleKeys: ['view_only'], mode: 'read_only' });
    await expectError(revokeAgent(bookkeeper, made.agent.id), 'FORBIDDEN', /Admin/);
    // An agent cannot manage agents either, even with an Admin's access handed to it.
    const asAgent: ServiceContext = { ...admin, userId: null, agent: { id: made.agent.id, name: 'To remove', mode: 'post' } };
    await expectError(createAgent(asAgent, { name: 'Child', roleKeys: ['view_only'], mode: 'read_only' }), 'FORBIDDEN');
    await expectError(revokeAgent(asAgent, made.agent.id), 'FORBIDDEN');
    await revokeAgent(admin, made.agent.id);
  });

  it('an agent is never an Admin and needs a real role', async () => {
    await expectError(createAgent(admin, { name: 'Boss', roleKeys: ['admin'], mode: 'read_only' }), 'VALIDATION', /cannot be an Admin/);
    await expectError(createAgent(admin, { name: 'Boss', roleKeys: ['bookkeeper', 'admin'], mode: 'read_only' }), 'VALIDATION', /cannot be an Admin/);
    await expectError(createAgent(admin, { name: 'Nobody', roleKeys: [], mode: 'read_only' }), 'VALIDATION', /at least one role/);
    await expectError(createAgent(admin, { name: 'Ghost', roleKeys: ['no_such_role'], mode: 'read_only' }), 'VALIDATION', /does not exist/);
    await expectError(createAgent(admin, { name: '   ', roleKeys: ['view_only'], mode: 'read_only' }), 'VALIDATION', /name/);
    await expectError(createAgent(admin, { name: 'Odd', roleKeys: ['view_only'], mode: 'everything' as never }), 'VALIDATION');
  });

  it('two active agents cannot share a name', async () => {
    const a = await createAgent(admin, { name: 'Twin', roleKeys: ['view_only'], mode: 'read_only' });
    await expectError(createAgent(admin, { name: 'twin', roleKeys: ['view_only'], mode: 'read_only' }), 'CONFLICT', /already an agent named/);
    await revokeAgent(admin, a.agent.id);
    const again = await createAgent(admin, { name: 'Twin', roleKeys: ['view_only'], mode: 'read_only' });
    await revokeAgent(admin, again.agent.id);
  });

  it("an agent's access is its roles' access without the things no agent gets", async () => {
    // A custom role that grants everything a role can: an agent with it still gets no Admin,
    // no Users & Roles, no File Utilities and none of the sensitive flags.
    const everything = Object.fromEntries(Object.keys(fullAccess().permissions).map((a) => [a, ['view', 'create', 'modify', 'delete', 'print']]));
    const role = await createRole(admin, {
      name: 'Nearly everything',
      description: 'test',
      permissions: everything as never,
      flags: { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true },
    });
    const access = await agentAccess(db, { companyId: admin.companyId, roleKeys: [role.key, 'admin'] });
    expect(access.isAdmin).toBe(false);
    expect(access.roleKeys).not.toContain('admin');
    expect(access.permissions.users).toEqual([]);
    expect(access.permissions.file_utilities).toEqual([]);
    expect(access.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
    expect(canActivity(access, 'users.users', 'create')).toBe(false);
    expect(canActivity(access, 'file_utilities.backup', 'create')).toBe(false);
    // What the role gives elsewhere is kept, View Balance included.
    expect(access.permissions.banking).toContain('view');
    expect(canActivity(access, 'banking.registers', 'view_balance')).toBe(true);
    // A role that no longer exists gives nothing.
    const none = await agentAccess(db, { companyId: admin.companyId, roleKeys: ['00000000-0000-4000-8000-000000000000'] });
    expect(Object.values(none.permissions).every((a) => a.length === 0)).toBe(true);
  });

  it('Integrated Applications "no applications" stops new agents', async () => {
    await db.update(companies).set({ settings: { integratedAppsBlocked: true } }).where(eq(companies.id, admin.companyId));
    await expectError(createAgent(admin, { name: 'Blocked', roleKeys: ['view_only'], mode: 'read_only' }), 'FORBIDDEN', /Integrated Applications/);
    await db.update(companies).set({ settings: {} }).where(eq(companies.id, admin.companyId));
  });
});

describe('what an agent does is recorded under its name', () => {
  it('audit rows carry the agent, and the audit trail and transaction log name it', async () => {
    const made = await createAgent(admin, { name: 'Posting agent', roleKeys: ['bookkeeper'], mode: 'post' });
    // No agent can write in this version (lib/agentContext.ts gives every agent a read-only
    // context). The recording itself is ready: a context that carries an agent and may write.
    const asAgent: ServiceContext = { db, companyId: admin.companyId, userId: null, role: 'accountant', access: admin.access, agent: { id: made.agent.id, name: 'Posting agent', mode: 'post' } };
    const entityId = '11111111-2222-4333-8444-555555555555';
    await writeAudit(asAgent, { action: 'update', entityType: 'customer', entityId, newValues: { note: 'by agent' } });

    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
    expect(row).toMatchObject({ userId: null, agentId: made.agent.id });

    const trail = await listAuditLogs(admin, { entityType: 'customer' });
    expect(trail.rows.find((r) => r.entityId === entityId)).toMatchObject({ actorId: null, actorName: 'Posting agent (agent)' });

    const records = readAllTransactionLog(TEST_DIR).records;
    const rec = records.find((r) => r.entityId === entityId);
    expect(rec).toMatchObject({ userId: null, userName: 'Posting agent (agent)' });
    // A person's change still names the person.
    const mine = records.find((r) => r.entityType === 'agent' && r.entityId === made.agent.id);
    expect(mine).toMatchObject({ userId: adminId, userName: 'Ada Admin' });
    await revokeAgent(admin, made.agent.id);
  });
});

describe('copies and restores', () => {
  it('the agents table travels in no per-company backup and no outsider copy', () => {
    expect(COMPANY_BACKUP_EXCLUDED_TABLES).toHaveProperty('agents');
    expect(OUTSIDER_SCRUBBED).toHaveProperty('agents', null);
  });

  it('restoring a backup removes every agent, so a removed one cannot come back', async () => {
    const kept = await createAgent(admin, { name: 'Before backup', roleKeys: ['view_only'], mode: 'read_only' });
    expect(await findAgentByToken(db, kept.token)).not.toBeNull();
    const { buffer } = createBackup('Agents Co', TEST_DIR);
    // After the backup the Admin removes the agent…
    await revokeAgent(admin, kept.agent.id);
    // …and the older books, where it still had access, are restored.
    await restoreBackup(buffer, RESTORE_DIR);
    const restored = await getDb(RESTORE_DIR);
    const rows = await restored.select().from(agents);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    process.env.BKA_DATA_DIR = RESTORE_DIR;
    try {
      expect(await findAgentByToken(restored, kept.token)).toBeNull();
      // A backup never carries the file id, so books restored somewhere else (the shell's
      // "restore as a new company file") are a different file: the token's digest is bound to
      // the file id and does not match there, even for a row that was never removed.
      await restored.update(agents).set({ revokedAt: null });
      expect(await findAgentByToken(restored, kept.token)).toBeNull();
      await revokeAllAgents(restored);
    } finally {
      process.env.BKA_DATA_DIR = TEST_DIR;
    }
    expect(agentTokenDigest(kept.token, 'file-a').hash).not.toBe(agentTokenDigest(kept.token, 'file-b').hash);
    expect(agentFileTag('file-a')).not.toBe(agentFileTag('file-b'));
  });

  it('revokeAllAgents covers every company of the file', async () => {
    const a = await createAgent(admin, { name: 'One more', roleKeys: ['view_only'], mode: 'read_only' });
    expect(await revokeAllAgents(db)).toBeGreaterThanOrEqual(1);
    expect(await findAgentByToken(db, a.token)).toBeNull();
    expect(await revokeAllAgents(db)).toBe(0);
  });
});
