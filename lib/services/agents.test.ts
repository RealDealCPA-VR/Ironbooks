/**
 * Agent access: the life of an agent and its token (lib/services/agents.ts).
 *
 *  - an Admin makes an agent and gets the token once; the database holds only a digest;
 *  - nothing listed or returned afterwards contains the token or the digest;
 *  - a token finds its agent until the agent is removed, and never on another computer's key;
 *  - only an Admin makes or removes agents, and both are audited with the Admin as the one who
 *    did it; removing one also takes back the standing permission it still holds; anyone who may
 *    see Users & Roles > Users lists them, each with how many adjustments it has; an agent, or
 *    work inside an agent's bridged run, does none of it. An agent may hold any role, Admin
 *    included (D1): the role is its ceiling;
 *  - a new agent asks for every change unless the Admin chose otherwise (D2), and the older mode
 *    follows its preset;
 *  - an agent's access is its roles' access through the agent limits (clampForAgent);
 *  - what an agent does is recorded under its own name (audit trail and transaction log);
 *  - the agents table never travels in copies, and restoring a backup removes every agent's access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agents');
const TEST_DIR = path.join(ROOT, 'live');
const RESTORE_DIR = path.join(ROOT, 'restored');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agents-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

// Another unit's module, replaced here: whether code runs inside an agent's bridged run.
const scope = vi.hoisted(() => ({ inside: false }));
vi.mock('@/lib/serviceScope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inServiceScope: () => scope.inside,
}));

import { getDb, closeDb, type DB } from '@/lib/db';
import { agentGrants, agentPolicies, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, fullAccess, unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import { canActivity } from '@/lib/permissions/model';
import { clampForAgent } from '@/lib/permissions/agentAccess';
import { presetForMode } from '@/lib/agent/policy';
import { AGENT_TOKEN_RE } from '@/lib/net/agentToken';
import { stripSecrets } from '@/lib/permissions/mask';
import { createAgentSchema } from '@/lib/validation/agents';
import { createCompany } from './company';
import { ServiceError, type ServiceContext, writeAudit } from './_base';
import {
  agentAccess,
  agentCount,
  agentFileTag,
  agentTokenDigest,
  createAgent,
  findAgentByToken,
  listAgents,
  modeForPreset,
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
let manager: ServiceContext;
let adminId: string;
/** May see Users & Roles > Users, and change nothing there. */
const usersViewRole: RoleDefinition = {
  key: 'users_viewer',
  name: 'Users viewer',
  description: 'test',
  builtin: false,
  permissions: { 'users.users': ['view'] },
  flags: {},
};

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
  // Manages users but is not an Admin.
  const usersRole: RoleDefinition = {
    key: 'user_manager',
    name: 'User manager',
    description: 'test',
    builtin: false,
    permissions: { users: ['view', 'create', 'modify'] },
    flags: {},
  };
  manager = { db, companyId: company.id, userId: other.id, role: 'accountant', access: unionRoles([builtinRole('bookkeeper')!, usersRole]) };
});

beforeEach(() => {
  scope.inside = false;
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
    expect(made.agent).toMatchObject({
      name: 'Month-end helper',
      roleKeys: ['bookkeeper'],
      roleNames: ['Bookkeeper'],
      preset: 'read_only',
      mode: 'read_only',
      pausedAt: null,
      status: 'active',
    });

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
    expect(await findAgentByToken(db, token)).toMatchObject({
      id: agentId,
      name: 'Month-end helper',
      preset: 'read_only',
      mode: 'read_only',
      pausedAt: null,
      roleKeys: ['bookkeeper'],
    });
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

  it('removing it takes back the standing permission it still holds, each audited', async () => {
    const made = await createAgent(admin, { name: 'Granted helper', roleKeys: ['bookkeeper'] });
    const other = await createAgent(admin, { name: 'Other helper', roleKeys: ['bookkeeper'] });
    const companyId = admin.companyId;
    const hour = 60 * 60 * 1000;
    const grant = async (agent: string, over: Partial<typeof agentGrants.$inferInsert> = {}) =>
      (
        await db
          .insert(agentGrants)
          .values({ companyId, agentId: agent, operation: 'invoices.create', class: 'enter', givenBy: adminId, expiresAt: new Date(Date.now() + hour), ...over })
          .returning()
      )[0];
    const standing = await grant(made.agent.id);
    const usedUp = await grant(made.agent.id, { constraints: { maxUses: 1 }, uses: 1 });
    const expired = await grant(made.agent.id, { expiresAt: new Date(Date.now() - hour) });
    const earlierBy = new Date(Date.now() - 1000);
    const alreadyBack = await grant(made.agent.id, { revokedAt: earlierBy, revokedBy: other.agent.id });
    const othersOwn = await grant(other.agent.id);

    await revokeAgent(admin, made.agent.id);
    const byId = async (id: string) => (await db.select().from(agentGrants).where(eq(agentGrants.id, id)))[0];
    // Every grant that still stood is taken back now, by the Admin who removed the agent.
    for (const g of [standing, usedUp]) {
      const after = await byId(g.id);
      expect(after.revokedAt).toBeInstanceOf(Date);
      expect(after.revokedBy).toBe(adminId);
      const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, g.id));
      expect(audit).toMatchObject({ action: 'update', entityType: 'agent_grant', userId: adminId, agentId: null });
      expect(audit.newValues).toMatchObject({ agentId: made.agent.id, operation: 'invoices.create', revoked: true, reason: 'agent removed' });
    }
    // An expired one stays as it ended; one already taken back keeps who took it back; another agent's stands.
    expect((await byId(expired.id)).revokedAt).toBeNull();
    expect(await byId(alreadyBack.id)).toMatchObject({ revokedAt: earlierBy, revokedBy: other.agent.id });
    expect((await byId(othersOwn.id)).revokedAt).toBeNull();
    const [agentAudit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, made.agent.id)).then((r) => r.filter((a) => a.action === 'update'));
    expect(agentAudit.newValues).toMatchObject({ revoked: true, grantsTakenBack: 2 });

    // Removing again finds nothing more to take back.
    await revokeAgent(admin, made.agent.id);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.entityId, standing.id))).toHaveLength(1);
    await revokeAgent(admin, other.agent.id);
    expect((await byId(othersOwn.id)).revokedBy).toBe(adminId);
  });

  it('lists how many adjustments each agent has on top of its preset', async () => {
    const adjusted = await createAgent(admin, { name: 'Adjusted', roleKeys: ['bookkeeper'] });
    const plain = await createAgent(admin, { name: 'Plain', roleKeys: ['bookkeeper'] });
    expect(adjusted.agent.overrideCount).toBe(0);
    const companyId = admin.companyId;
    await db.insert(agentPolicies).values([
      { companyId, agentId: adjusted.agent.id, class: 'enter', area: null, setting: 'never' },
      { companyId, agentId: adjusted.agent.id, class: 'enter', area: 'banking', setting: 'ask' },
    ]);
    const listed = await listAgents(admin);
    expect(listed.find((a) => a.id === adjusted.agent.id)?.overrideCount).toBe(2);
    expect(listed.find((a) => a.id === plain.agent.id)?.overrideCount).toBe(0);
    expect(listed.every((a) => Number.isInteger(a.overrideCount))).toBe(true);
    // The view a removal answers says it too.
    expect((await revokeAgent(admin, adjusted.agent.id)).overrideCount).toBe(2);
    await revokeAgent(admin, plain.agent.id);
  });

  it('counts only adjustments that change what their cell would otherwise follow', async () => {
    const companyId = admin.companyId;
    // "Ask for every change": Enter new is Ask everywhere; "Trusted bookkeeper" lets it run.
    const kept = await createAgent(admin, { name: 'Kept as chosen', roleKeys: ['bookkeeper'] });
    const mixed = await createAgent(admin, { name: 'Mixed', roleKeys: ['bookkeeper'], preset: 'trusted_bookkeeper' });
    const row = (agentId: string, cls: string, area: string | null, setting: string) => ({ companyId, agentId, class: cls, area, setting });
    await db.insert(agentPolicies).values([
      // The preset's own setting, clicked again: no adjustment.
      row(kept.agent.id, 'enter', null, 'ask'),
      // An area that says what everywhere says: no adjustment.
      row(kept.agent.id, 'enter', 'banking', 'ask'),
      // An Allow the engine never gives is the Ask the preset already has: no adjustment.
      row(kept.agent.id, 'remove', null, 'allow'),
      // Rows the engine ignores: no adjustment.
      row(kept.agent.id, 'no_such_class', null, 'never'),
      row(kept.agent.id, 'change', 'no_such_area', 'never'),
      row(kept.agent.id, 'change', 'payroll', 'maybe'),

      // Everywhere moved from the preset's Allow to Ask: one.
      row(mixed.agent.id, 'enter', null, 'ask'),
      // Banking back at Allow, as the preset had it, but against everywhere's Ask now: one.
      row(mixed.agent.id, 'enter', 'banking', 'allow'),
      // Payroll following everywhere's Ask: none.
      row(mixed.agent.id, 'enter', 'payroll', 'ask'),
      // Never for deleting in payroll, where everywhere is Ask: one.
      row(mixed.agent.id, 'remove', 'payroll', 'never'),
    ]);
    const listed = await listAgents(admin);
    expect(listed.find((a) => a.id === kept.agent.id)?.overrideCount).toBe(0);
    expect(listed.find((a) => a.id === mixed.agent.id)?.overrideCount).toBe(3);

    // The same rows read under another preset count against that one. Read only: Enter new is Never,
    // so Ask everywhere and Allow in Banking still differ, Ask in Payroll follows everywhere, and
    // Never for deleting in Payroll is now what everywhere says anyway.
    await db.update(agents).set({ preset: 'read_only' }).where(eq(agents.id, mixed.agent.id));
    expect((await listAgents(admin)).find((a) => a.id === mixed.agent.id)?.overrideCount).toBe(2);
    expect((await revokeAgent(admin, kept.agent.id)).overrideCount).toBe(0);
    expect((await revokeAgent(admin, mixed.agent.id)).overrideCount).toBe(2);
  });
});

describe('who may make agents, and what an agent may be', () => {
  it('only an Admin makes or removes agents; anyone who may see Users & Roles lists them', async () => {
    await expectError(createAgent(bookkeeper, { name: 'Sneaky', roleKeys: ['view_only'], mode: 'read_only' }), 'FORBIDDEN', /Admin/);
    await expectError(listAgents(bookkeeper), 'FORBIDDEN', /permission to view Users/);
    const made = await createAgent(admin, { name: 'To remove', roleKeys: ['view_only'], mode: 'read_only' });
    await expectError(revokeAgent(bookkeeper, made.agent.id), 'FORBIDDEN', /Admin/);
    // A user manager who is not an Admin finds the agents they may open and pause, but makes and
    // removes none.
    expect((await listAgents(manager)).map((a) => a.id)).toContain(made.agent.id);
    await expectError(createAgent(manager, { name: 'Managed', roleKeys: ['view_only'] }), 'FORBIDDEN', /Admin/);
    await expectError(revokeAgent(manager, made.agent.id), 'FORBIDDEN', /Admin/);
    // A person whose context was built without access is checked from the company file.
    expect((await listAgents({ db, companyId: admin.companyId, userId: adminId })).length).toBeGreaterThan(0);
    // Seeing Users & Roles > Users is enough to list, as it is to open an agent's page.
    const viewer: ServiceContext = { ...bookkeeper, access: unionRoles([builtinRole('bookkeeper')!, usersViewRole]) };
    expect((await listAgents(viewer)).map((a) => a.id)).toContain(made.agent.id);
    await expectError(createAgent(viewer, { name: 'Viewer made', roleKeys: ['view_only'] }), 'FORBIDDEN', /Admin/);
    // An agent cannot manage agents either, even with an Admin's access handed to it.
    const asAgent: ServiceContext = { ...admin, userId: null, agent: { id: made.agent.id, name: 'To remove', mode: 'post' } };
    await expectError(createAgent(asAgent, { name: 'Child', roleKeys: ['view_only'], mode: 'read_only' }), 'FORBIDDEN');
    await expectError(listAgents(asAgent), 'FORBIDDEN', /An agent cannot list agents/);
    await expectError(revokeAgent(asAgent, made.agent.id), 'FORBIDDEN');
    // Nor does work inside an agent's bridged run, even when handed the Admin's own context (D9).
    scope.inside = true;
    await expectError(createAgent(admin, { name: 'Bridged', roleKeys: ['view_only'] }), 'FORBIDDEN');
    await expectError(listAgents(admin), 'FORBIDDEN');
    await expectError(revokeAgent(admin, made.agent.id), 'FORBIDDEN');
    scope.inside = false;
    expect((await listAgents(admin)).find((a) => a.id === made.agent.id)?.status).toBe('active');
    await revokeAgent(admin, made.agent.id);
  });

  it('an agent may hold the Admin role (D1), and needs a real role', async () => {
    // The role is a ceiling; the policy keeps Admin, company-file and password work on Ask.
    const boss = await createAgent(admin, { name: 'Boss', roleKeys: ['admin'] });
    expect(boss.agent).toMatchObject({ roleKeys: ['admin'], roleNames: ['Admin'], preset: 'ask_every_change', mode: 'propose' });
    const both = await createAgent(admin, { name: 'Boss two', roleKeys: ['bookkeeper', 'admin'], mode: 'read_only' });
    expect(both.agent.roleNames).toEqual(['Bookkeeper', 'Admin']);
    // Its access goes through the agent limits like any other role's: the Admin role's own access
    // is everything, so its ceiling is the limits applied to everything.
    const access = await agentAccess(db, { companyId: admin.companyId, roleKeys: ['admin'] });
    expect(access).toEqual(clampForAgent(fullAccess()));
    // By value: an Admin ceiling, Users & Roles kept (its work is the admin class, which a person
    // approves), and the books themselves.
    expect(access.isAdmin).toBe(true);
    expect(access.roleKeys).toEqual(['admin']);
    expect(canActivity(access, 'users.users', 'modify')).toBe(true);
    expect(canActivity(access, 'banking.registers', 'view_balance')).toBe(true);
    await revokeAgent(admin, boss.agent.id);
    await revokeAgent(admin, both.agent.id);

    await expectError(createAgent(admin, { name: 'Nobody', roleKeys: [], mode: 'read_only' }), 'VALIDATION', /at least one role/);
    await expectError(createAgent(admin, { name: 'Ghost', roleKeys: ['no_such_role'], mode: 'read_only' }), 'VALIDATION', /does not exist/);
    await expectError(createAgent(admin, { name: '   ', roleKeys: ['view_only'], mode: 'read_only' }), 'VALIDATION', /name/);
    await expectError(createAgent(admin, { name: 'Odd', roleKeys: ['view_only'], mode: 'everything' as never }), 'VALIDATION');
  });

  it('a new agent asks for every change unless told otherwise (D2), and its mode follows its preset', async () => {
    const plain = await createAgent(admin, { name: 'Default', roleKeys: ['view_only'] });
    expect(plain.agent).toMatchObject({ preset: 'ask_every_change', mode: 'propose', pausedAt: null });
    expect(await findAgentByToken(db, plain.token)).toMatchObject({ preset: 'ask_every_change', mode: 'propose', pausedAt: null });

    // The preset decides, and the older mode is written to match it.
    const full = await createAgent(admin, { name: 'Full', roleKeys: ['bookkeeper'], preset: 'full_with_asks' });
    expect(full.agent).toMatchObject({ preset: 'full_with_asks', mode: 'post' });
    const [row] = await db.select().from(agents).where(eq(agents.id, full.agent.id));
    // "Full, with asks" lets bulk work run unasked, so it comes with its count cap written down.
    expect(row).toMatchObject({ preset: 'full_with_asks', mode: 'post', bulkCap: 200 });
    const trusted = await createAgent(admin, { name: 'Trusted', roleKeys: ['bookkeeper'], preset: 'trusted_bookkeeper', mode: 'post' });
    expect(trusted.agent).toMatchObject({ preset: 'trusted_bookkeeper', mode: 'post' });
    const [trustedRow] = await db.select().from(agents).where(eq(agents.id, trusted.agent.id));
    expect(trustedRow.bulkCap).toBeNull();

    // The older form with a mode alone still works and gets that mode's preset.
    const old = await createAgent(admin, { name: 'Older form', roleKeys: ['bookkeeper'], mode: 'post' });
    expect(old.agent).toMatchObject({ preset: 'trusted_bookkeeper', mode: 'post' });

    // A mode that is not the preset's own is refused, not guessed; so is an unknown preset.
    await expectError(
      createAgent(admin, { name: 'Mixed', roleKeys: ['bookkeeper'], preset: 'read_only', mode: 'post' }),
      'VALIDATION',
      /does not go with/,
    );
    await expectError(createAgent(admin, { name: 'Odd', roleKeys: ['bookkeeper'], preset: 'everything' as never }), 'VALIDATION', /Choose what the agent may do/);

    // The audit row and the list name the preset.
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, full.agent.id));
    expect(audit.newValues).toMatchObject({ preset: 'full_with_asks', mode: 'post' });
    const listed = (await listAgents(admin)).find((a) => a.id === full.agent.id);
    expect(listed).toMatchObject({ preset: 'full_with_asks', mode: 'post', pausedAt: null });

    // A paused agent keeps its token, so the door can say why it is refused.
    const when = new Date('2026-11-20T10:00:00.000Z');
    await db.update(agents).set({ pausedAt: when }).where(eq(agents.id, plain.agent.id));
    expect(await findAgentByToken(db, plain.token)).toMatchObject({ id: plain.agent.id, pausedAt: when.toISOString() });

    for (const a of [plain, full, trusted, old]) await revokeAgent(admin, a.agent.id);
  });

  it('modeForPreset is the reverse of presetForMode', () => {
    for (const mode of ['read_only', 'propose', 'post'] as const) expect(modeForPreset(presetForMode(mode))).toBe(mode);
    expect(modeForPreset('full_with_asks')).toBe('post');
  });

  it('the request schema takes a preset, the older mode, or neither', () => {
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['admin'], preset: 'full_with_asks' }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'], mode: 'post' }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'] }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'], preset: 'everything' }).success).toBe(false);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'], preset: 'read_only', extra: 1 }).success).toBe(false);
  });

  it('two active agents cannot share a name', async () => {
    const a = await createAgent(admin, { name: 'Twin', roleKeys: ['view_only'], mode: 'read_only' });
    await expectError(createAgent(admin, { name: 'twin', roleKeys: ['view_only'], mode: 'read_only' }), 'CONFLICT', /already an agent named/);
    await revokeAgent(admin, a.agent.id);
    const again = await createAgent(admin, { name: 'Twin', roleKeys: ['view_only'], mode: 'read_only' });
    await revokeAgent(admin, again.agent.id);
  });

  it("an agent's access is its roles' access through the agent limits", async () => {
    // Every role it was given counts, Admin included (D1). What the agent limits keep and take away
    // (lib/permissions/agentAccess.ts clampForAgent) is checked here by value.
    const everything = Object.fromEntries(Object.keys(fullAccess().permissions).map((a) => [a, ['view', 'create', 'modify', 'delete', 'print']]));
    const role = await createRole(admin, {
      name: 'Nearly everything',
      description: 'test',
      permissions: everything as never,
      flags: { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true },
    });
    const access = await agentAccess(db, { companyId: admin.companyId, roleKeys: [role.key, 'admin'] });
    // With the Admin role, the agent's ceiling is an Admin's: both roles count.
    expect(access.isAdmin).toBe(true);
    expect([...access.roleKeys].sort()).toEqual([role.key, 'admin'].sort());
    // Without the Admin role an agent is never an Admin, whatever its other roles give.
    const noAdmin = await agentAccess(db, { companyId: admin.companyId, roleKeys: [role.key] });
    expect(noAdmin.isAdmin).toBe(false);
    expect(noAdmin.roleKeys).toEqual([role.key]);
    // What the role gives is kept, View Balance included. Users & Roles and File Utilities stay (a
    // direct request still never reaches them: their work is the admin and file classes, which a
    // person approves), and so do the View flags and the closed-period right, which the policy
    // checks before an agent may even ask to reveal data or work in a closed period.
    expect(access.permissions.banking).toContain('view');
    expect(canActivity(access, 'banking.registers', 'view_balance')).toBe(true);
    expect(noAdmin.permissions.users).toEqual(expect.arrayContaining(['view', 'modify']));
    expect(noAdmin.permissions.file_utilities.length).toBeGreaterThan(0);
    expect(noAdmin.flags).toEqual({ sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true });
    // A role without a flag gives none.
    const plain = await agentAccess(db, { companyId: admin.companyId, roleKeys: ['bookkeeper'] });
    expect(plain.isAdmin).toBe(false);
    expect(plain.flags.closedPeriod).toBe(false);
    // The ceiling is a copy: changing it never changes the next agent's.
    access.permissions.banking.length = 0;
    expect((await agentAccess(db, { companyId: admin.companyId, roleKeys: [role.key, 'admin'] })).permissions.banking).toContain('view');
    // A role that no longer exists gives nothing.
    const none = await agentAccess(db, { companyId: admin.companyId, roleKeys: ['00000000-0000-4000-8000-000000000000'] });
    expect(Object.values(none.permissions).every((a) => a.length === 0)).toBe(true);
  });

  it('counts the agents that are not removed, paused ones included', async () => {
    const start = await agentCount(db, admin.companyId);
    const a = await createAgent(admin, { name: 'Counted', roleKeys: ['view_only'] });
    const b = await createAgent(admin, { name: 'Counted too', roleKeys: ['view_only'] });
    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, b.agent.id));
    expect(await agentCount(db, admin.companyId)).toBe(start + 2);
    await revokeAgent(admin, a.agent.id);
    expect(await agentCount(db, admin.companyId)).toBe(start + 1);
    await revokeAgent(admin, b.agent.id);
    expect(await agentCount(db, admin.companyId)).toBe(start);
    expect(await agentCount(db, '00000000-0000-4000-8000-000000000000')).toBe(0);
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
