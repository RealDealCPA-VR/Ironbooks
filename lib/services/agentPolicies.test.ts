/**
 * Agent full access: an agent's policy as stored (lib/services/agentPolicies.ts).
 *
 *  - an agent's policy is its preset, its stored overrides and the limits on its row, read through
 *    the policy engine; an unknown, removed or other agent is "not found";
 *  - the grid shows the locked cells with the reason in plain words;
 *  - only a signed-in person who may modify Users & Roles changes an agent's settings, and never a
 *    context that carries an agent or runs inside an agent's bridged run (D9, the hard floor);
 *  - a person who is not an Admin may not change or turn back on an agent beyond their own access;
 *  - a save is checked against the engine's rules and refused with what to change; it replaces
 *    the overrides, keeps the older mode in step with the preset and writes one audit row;
 *  - folders must be full paths that exist, and never the books' own folders;
 *  - pause one agent, or all of them through the Integrated Applications switch;
 *  - the ceiling, the detail page and the activity list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-policies');
const TEST_DIR = path.join(ROOT, 'live');
const FOLDERS = path.join(ROOT, 'folders');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-policies-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_COMPANY_FILE;
delete process.env.BKA_COMPANY_STATE;
delete process.env.BKA_AGENT_FILES_DIR;

// Another unit's modules, replaced here: whether code runs inside an agent's bridged run (the
// service scope), and the folder check the save check shares with save_file and where staged
// files are kept (lib/agent/files.ts).
const scope = vi.hoisted(() => ({ inside: false, staged: null as string | null }));
vi.mock('@/lib/serviceScope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inServiceScope: () => scope.inside,
}));
vi.mock('@/lib/agent/files', () => ({
  stagedFilesRoot: () => scope.staged,
  allowedFolder: async (allowed: readonly string[], folder: string) => {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    if (!allowed.includes(folder) || !nodePath.isAbsolute(folder)) return null;
    try {
      return nodeFs.statSync(folder).isDirectory() ? nodePath.resolve(folder) : null;
    } catch {
      return null;
    }
  },
}));

import { getDb, closeDb, type DB } from '@/lib/db';
import { agentGrants, agentPermissionRequests, agentPolicies, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, fullAccess, unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import { DEFAULT_BULK_CAP, PRESET_DEFAULTS, isPaused } from '@/lib/agent/policy';
import { NEVER_ALLOW_CLASSES } from '@/lib/agent/operations/types';
import { createCompany } from './company';
import { ServiceError, type ServiceContext, writeAudit } from './_base';
import { agentAccess, createAgent, findAgentByToken, revokeAgent } from './agents';
import {
  agentCeiling,
  getAgentDetail,
  getAgentPolicyView,
  listAgentActivity,
  loadAgentPolicy,
  mayPauseAllAgents,
  pauseAgent,
  pauseAllAgents,
  saveAgentPolicy,
} from './agentPolicies';

let db: DB;
let admin: ServiceContext;
let bookkeeperPerson: ServiceContext;
let manager: ServiceContext;
let otherCompanyAdmin: ServiceContext;
let adminId: string;

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    expect(e.code).toBe(code);
    if (message) expect(e.message).toMatch(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** A context that carries the agent itself, with an Admin's access handed to it. */
function asAgent(agentId: string): ServiceContext {
  return { ...admin, userId: null, agent: { id: agentId, name: 'Agent', mode: 'post' } };
}

async function newAgent(name: string, roleKeys: string[], preset?: 'read_only' | 'ask_every_change' | 'trusted_bookkeeper' | 'full_with_asks') {
  const made = await createAgent(admin, { name, roleKeys, ...(preset ? { preset } : {}) });
  return made;
}

async function auditRowsFor(entityId: string) {
  return db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'admin@policies.test', name: 'Ada Admin', passwordHash: 'x' }).returning();
  const [bk] = await db.insert(users).values({ email: 'bk@policies.test', name: 'Bo Bookkeeper', passwordHash: 'x' }).returning();
  const [mgr] = await db.insert(users).values({ email: 'mgr@policies.test', name: 'Max Manager', passwordHash: 'x' }).returning();
  adminId = owner.id;
  const company = await createCompany(db, { name: 'Policies Co', ownerId: owner.id });
  admin = { db, companyId: company.id, userId: owner.id, role: 'owner', access: fullAccess() };
  bookkeeperPerson = { db, companyId: company.id, userId: bk.id, role: 'accountant', access: unionRoles([builtinRole('bookkeeper')!]) };
  // Manages users but is not an Admin: Full Access (no closing date) plus Users & Roles.
  const usersRole: RoleDefinition = {
    key: 'user_manager',
    name: 'User manager',
    description: 'test',
    builtin: false,
    permissions: { users: ['view', 'create', 'modify'] },
    flags: {},
  };
  manager = { db, companyId: company.id, userId: mgr.id, role: 'accountant', access: unionRoles([builtinRole('full_access')!, usersRole]) };
  const other = await createCompany(db, { name: 'Other Co', ownerId: owner.id });
  otherCompanyAdmin = { db, companyId: other.id, userId: owner.id, role: 'owner', access: fullAccess() };
  fs.mkdirSync(path.join(FOLDERS, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(FOLDERS, 'statements'), { recursive: true });
});

beforeEach(() => {
  scope.inside = false;
  scope.staged = null;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('reading a policy for a decision', () => {
  it("is the preset's defaults with the stored overrides and limits on top", async () => {
    const { agent } = await newAgent('Reader', ['bookkeeper']);
    const policy = await loadAgentPolicy(admin, agent.id);
    expect(policy).toMatchObject({
      preset: 'ask_every_change',
      classes: PRESET_DEFAULTS.ask_every_change,
      areas: {},
      bulkCap: null,
      twoPersonOver: null,
      requestExpiryDays: 7,
      folders: [],
      notifyEmail: false,
      pausedAt: null,
    });

    await db.insert(agentPolicies).values({ companyId: admin.companyId, agentId: agent.id, class: 'enter', area: 'banking', setting: 'allow' });
    await db.update(agents).set({ twoPersonOver: '2500.00', requestExpiryDays: 3 }).where(eq(agents.id, agent.id));
    const again = await loadAgentPolicy(admin, agent.id);
    expect(again.areas).toEqual({ banking: { enter: 'allow' } });
    expect(again).toMatchObject({ twoPersonOver: '2500.00', requestExpiryDays: 3 });
    await revokeAgent(admin, agent.id);
  });

  it('an unknown, removed or other agent is not found, and an agent reads only its own', async () => {
    const { agent } = await newAgent('Own', ['view_only']);
    const { agent: sibling } = await newAgent('Sibling', ['view_only']);
    await expectError(loadAgentPolicy(admin, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectError(loadAgentPolicy(admin, 'not-a-uuid'), 'NOT_FOUND');
    // Another company of the file does not see it.
    await expectError(loadAgentPolicy(otherCompanyAdmin, agent.id), 'NOT_FOUND');
    // The agent itself reads its own policy and ceiling, never another agent's.
    expect((await loadAgentPolicy(asAgent(agent.id), agent.id)).preset).toBe('ask_every_change');
    expect((await agentCeiling(asAgent(agent.id), agent.id)).roleNames).toEqual(['View-Only']);
    await expectError(loadAgentPolicy(asAgent(agent.id), sibling.id), 'NOT_FOUND');
    await expectError(agentCeiling(asAgent(agent.id), sibling.id), 'NOT_FOUND');
    await revokeAgent(admin, agent.id);
    await expectError(loadAgentPolicy(admin, agent.id), 'NOT_FOUND');
    await expectError(agentCeiling(admin, agent.id), 'NOT_FOUND');
    await revokeAgent(admin, sibling.id);
  });
});

describe('the policy grid', () => {
  it('shows the stored overrides and the locked cells with the reason', async () => {
    const { agent } = await newAgent('Grid', ['bookkeeper']);
    const view = await getAgentPolicyView(admin, agent.id);
    expect(view).toMatchObject({ agentId: agent.id, preset: 'ask_every_change', overrides: [] });
    expect(view.locked.map((l) => l.class).sort()).toEqual([...NEVER_ALLOW_CLASSES].sort());
    expect(view.locked.every((l) => l.setting === 'allow')).toBe(true);
    expect(view.locked.find((l) => l.class === 'remove')?.reason).toMatch(/"Delete for good" can never be Allow/);
    expect(view.locked.find((l) => l.class === 'admin')?.reason).toMatch(/only an Admin can approve/);
    expect(view.locked.find((l) => l.class === 'outside')?.reason).not.toMatch(/Admin/);
    await revokeAgent(admin, agent.id);
  });

  it('is for a person who may see Users & Roles, never an agent', async () => {
    const { agent } = await newAgent('Hidden', ['bookkeeper']);
    await expectError(getAgentPolicyView(asAgent(agent.id), agent.id), 'FORBIDDEN', /cannot open the Agents tab/);
    await expectError(getAgentDetail(asAgent(agent.id), agent.id), 'FORBIDDEN');
    await expectError(listAgentActivity(asAgent(agent.id), agent.id), 'FORBIDDEN');
    await expectError(getAgentPolicyView(bookkeeperPerson, agent.id), 'FORBIDDEN', /permission to view Users/);
    expect((await getAgentPolicyView(manager, agent.id)).agentId).toBe(agent.id);
    await revokeAgent(admin, agent.id);
  });
});

describe('saving a policy', () => {
  it('replaces the overrides, keeps the mode in step and writes one audit row', async () => {
    const { agent } = await newAgent('Saver', ['bookkeeper']);
    const before = (await auditRowsFor(agent.id)).length;
    const view = await saveAgentPolicy(admin, agent.id, {
      preset: 'trusted_bookkeeper',
      overrides: [
        { class: 'enter', area: 'payroll', setting: 'ask' },
        { class: 'remove', area: null, setting: 'never' },
      ],
      twoPersonOver: '5000',
      requestExpiryDays: 3,
      notifyEmail: true,
    });
    expect(view).toMatchObject({ agentId: agent.id, preset: 'trusted_bookkeeper' });
    expect(view.overrides).toEqual([
      { class: 'enter', area: 'payroll', setting: 'ask' },
      { class: 'remove', area: null, setting: 'never' },
    ]);
    expect(view.policy).toMatchObject({ twoPersonOver: '5000.00', requestExpiryDays: 3, notifyEmail: true });
    expect(view.policy.classes.enter).toBe('allow');
    expect(view.policy.classes.remove).toBe('never');
    expect(view.policy.areas.payroll).toEqual({ enter: 'ask' });

    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row).toMatchObject({ preset: 'trusted_bookkeeper', mode: 'post', twoPersonOver: '5000.00', requestExpiryDays: 3, notifyEmail: true });
    expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toHaveLength(2);

    const rows = await auditRowsFor(agent.id);
    expect(rows).toHaveLength(before + 1);
    const audit = rows.find((r) => (r.newValues as Record<string, unknown> | null)?.preset === 'trusted_bookkeeper');
    expect(audit).toMatchObject({ action: 'update', entityType: 'agent', userId: adminId, agentId: null });
    expect(audit?.oldValues).toMatchObject({ name: 'Saver', preset: 'ask_every_change', mode: 'propose', overrides: [] });
    expect(audit?.newValues).toMatchObject({ name: 'Saver', preset: 'trusted_bookkeeper', mode: 'post', twoPersonOver: '5000.00' });

    // The same save again changes nothing and writes nothing.
    await saveAgentPolicy(admin, agent.id, { preset: 'trusted_bookkeeper', twoPersonOver: '5000.00' });
    expect(await auditRowsFor(agent.id)).toHaveLength(before + 1);

    // An empty list clears every override; leaving the list out keeps them.
    await saveAgentPolicy(admin, agent.id, { requestExpiryDays: 5 });
    expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toHaveLength(2);
    await saveAgentPolicy(admin, agent.id, { overrides: [] });
    expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toHaveLength(0);

    // Every preset keeps the older mode in step for code that still reads it.
    for (const [preset, mode] of [
      ['read_only', 'read_only'],
      ['ask_every_change', 'propose'],
      ['full_with_asks', 'post'],
    ] as const) {
      await saveAgentPolicy(admin, agent.id, { preset });
      const [r] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(r.mode).toBe(mode);
    }
    // Moving to "Full, with asks" with no cap set brought the usual one.
    expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBe(DEFAULT_BULK_CAP);
    // The two-person amount can be turned off again.
    await saveAgentPolicy(admin, agent.id, { twoPersonOver: null });
    expect((await loadAgentPolicy(admin, agent.id)).twoPersonOver).toBeNull();
    await revokeAgent(admin, agent.id);
  });

  it('refuses what the engine would read differently, with what to change', async () => {
    const { agent } = await newAgent('Strict', ['bookkeeper']);
    const refused = (input: Parameters<typeof saveAgentPolicy>[2], message: RegExp) =>
      expectError(saveAgentPolicy(admin, agent.id, input), 'VALIDATION', message);
    await refused({ overrides: [{ class: 'remove', area: null, setting: 'allow' }] }, /"Delete for good" can never be Allow for an agent. Set it to Ask or Never/);
    await refused({ overrides: [{ class: 'admin', area: 'banking', setting: 'allow' }] }, /"Users and security" in Banking can never be Allow/);
    await refused(
      {
        overrides: [
          { class: 'enter', area: null, setting: 'ask' },
          { class: 'enter', area: null, setting: 'allow' },
        ],
      },
      /set twice/,
    );
    await refused({ overrides: [{ class: 'teleport' as never, area: null, setting: 'ask' }] }, /kind of work Ironbooks does not know/);
    await refused({ overrides: [{ class: 'enter', area: 'moon' as never, setting: 'ask' }] }, /area Ironbooks does not know/);
    await refused({ overrides: [{ class: 'enter', area: null, setting: 'sometimes' as never }] }, /must be Allow, Ask or Never/);
    await refused({ preset: 'everything' as never }, /Choose what the agent may do/);
    await refused({ bulkCap: 0 }, /whole number from 1/);
    await refused({ bulkCap: 2.5 }, /whole number from 1/);
    await refused({ twoPersonOver: '-1' }, /two people must approve/);
    await refused({ twoPersonOver: 'lots' }, /two people must approve/);
    await refused({ twoPersonOver: '10.005' }, /two people must approve/);
    await refused({ requestExpiryDays: 0 }, /from 1 to 365/);
    await refused({ notifyEmail: 'yes' as never }, /on or off/);
    // Bulk work may run unasked only within a cap: saying "no cap" with it is refused...
    await refused({ overrides: [{ class: 'bulk', area: null, setting: 'allow' }], bulkCap: null }, /needs a limit/);
    // ...and saying nothing about the cap gets the usual one.
    const view = await saveAgentPolicy(admin, agent.id, { overrides: [{ class: 'bulk', area: 'banking', setting: 'allow' }] });
    expect(view.policy.bulkCap).toBe(DEFAULT_BULK_CAP);
    // Nothing refused was saved.
    expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toEqual([
      expect.objectContaining({ class: 'bulk', area: 'banking', setting: 'allow' }),
    ]);
    await revokeAgent(admin, agent.id);
    await expectError(saveAgentPolicy(admin, agent.id, { preset: 'read_only' }), 'VALIDATION', /has been removed/);
    await expectError(saveAgentPolicy(admin, '00000000-0000-4000-8000-000000000000', {}), 'NOT_FOUND');
  });

  it("refuses to save over a stored policy the engine reads differently (the engine's own check)", async () => {
    // What a save sends is checked before the engine sees it, so only what it keeps from the stored
    // policy reaches the engine's check: here a row and a limit only a hand-edited file holds.
    const { agent } = await newAgent('Hand edited', ['bookkeeper']);
    await db.insert(agentPolicies).values({ companyId: admin.companyId, agentId: agent.id, class: 'remove', area: null, setting: 'allow' });
    await expectError(
      saveAgentPolicy(admin, agent.id, { requestExpiryDays: 4 }),
      'VALIDATION',
      /^"Delete for good" can never be set to Allow for an agent, so it is set to Ask\. Fix this setting and save again\.$/,
    );
    // Nothing was saved; sending the settings again replaces the stored row and the save goes through.
    expect((await loadAgentPolicy(admin, agent.id)).requestExpiryDays).toBe(7);
    await saveAgentPolicy(admin, agent.id, { requestExpiryDays: 4, overrides: [{ class: 'remove', area: null, setting: 'never' }] });
    expect((await loadAgentPolicy(admin, agent.id)).requestExpiryDays).toBe(4);

    await db.update(agents).set({ bulkCap: 0 }).where(eq(agents.id, agent.id));
    await expectError(saveAgentPolicy(admin, agent.id, { notifyEmail: true }), 'VALIDATION', /most records per request \("0"\) must be a whole number above zero/);
    expect((await loadAgentPolicy(admin, agent.id)).notifyEmail).toBe(false);
    await saveAgentPolicy(admin, agent.id, { notifyEmail: true, bulkCap: 50 });
    expect((await loadAgentPolicy(admin, agent.id)).notifyEmail).toBe(true);
    await revokeAgent(admin, agent.id);
  });

  it('takes folders that are full paths on this computer, never the books own folders', async () => {
    const { agent } = await newAgent('Filer', ['bookkeeper']);
    const receipts = path.join(FOLDERS, 'receipts');
    const statements = path.join(FOLDERS, 'statements');
    const view = await saveAgentPolicy(admin, agent.id, { folders: [receipts, ` ${statements} `, receipts] });
    expect(view.policy.folders).toEqual([path.resolve(receipts), path.resolve(statements)]);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.folders).toEqual([path.resolve(receipts), path.resolve(statements)]);

    await expectError(saveAgentPolicy(admin, agent.id, { folders: ['receipts'] }), 'VALIDATION', /not a full folder path/);
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [path.join(FOLDERS, 'missing')] }), 'VALIDATION', /was not found on this computer/);
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [''] }), 'VALIDATION', /empty/);
    // The company's own data folder, a folder that holds it, and one inside it.
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [TEST_DIR] }), 'VALIDATION', /holds the company file/);
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [ROOT] }), 'VALIDATION', /holds the company file/);
    const inside = fs.readdirSync(TEST_DIR, { withFileTypes: true }).find((d) => d.isDirectory());
    if (inside) {
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [path.join(TEST_DIR, inside.name)] }), 'VALIDATION', /holds the company file/);
    }
    // Nothing refused replaced the saved list.
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([path.resolve(receipts), path.resolve(statements)]);
    await revokeAgent(admin, agent.id);
  });

  it("never Ironbooks' own folders: agents' staged files, the app's settings folder, the backups", async () => {
    const { agent } = await newAgent('Nosy', ['bookkeeper']);
    const appData = path.join(FOLDERS, 'appdata');
    const staged = path.join(appData, 'agent-files');
    const userData = path.join(FOLDERS, 'userdata');
    const backups = path.join(FOLDERS, 'backups');
    for (const d of [path.join(staged, 'company'), path.join(userData, 'companies'), backups]) fs.mkdirSync(d, { recursive: true });
    const saved = { userData: process.env.IRONBOOKS_USER_DATA, backups: process.env.BKA_BACKUP_DIR };
    scope.staged = staged;
    process.env.IRONBOOKS_USER_DATA = userData;
    process.env.BKA_BACKUP_DIR = backups;
    try {
      const own = /one of the folders Ironbooks keeps its own data in .* Choose another folder for the agent\./;
      // Every agent's staged files: the folder itself, a folder that holds it, one inside it.
      for (const folder of [staged, appData, path.join(staged, 'company')]) {
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', own);
      }
      // The desktop app's settings folder and what is inside it, and the backups folder.
      for (const folder of [userData, path.join(userData, 'companies'), backups]) {
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', own);
      }
      // A folder beside them is fine.
      const view = await saveAgentPolicy(admin, agent.id, { folders: [path.join(FOLDERS, 'receipts')] });
      expect(view.policy.folders).toEqual([path.resolve(FOLDERS, 'receipts')]);
    } finally {
      if (saved.userData === undefined) delete process.env.IRONBOOKS_USER_DATA;
      else process.env.IRONBOOKS_USER_DATA = saved.userData;
      if (saved.backups === undefined) delete process.env.BKA_BACKUP_DIR;
      else process.env.BKA_BACKUP_DIR = saved.backups;
    }
    await revokeAgent(admin, agent.id);
  });
});

describe('who may change an agent', () => {
  it('never an agent, its own settings included, whatever access it carries (D9)', async () => {
    const { agent } = await newAgent('Self', ['bookkeeper']);
    const self = asAgent(agent.id);
    await expectError(saveAgentPolicy(self, agent.id, { preset: 'full_with_asks' }), 'FORBIDDEN', /An agent can never change/);
    await expectError(pauseAgent(self, agent.id, false), 'FORBIDDEN', /An agent can never change/);
    await expectError(pauseAllAgents(self, false), 'FORBIDDEN', /An agent can never change/);
    expect(await mayPauseAllAgents(self)).toBe(false);
    // Work inside an agent's bridged run is refused even when handed a person's context.
    scope.inside = true;
    await expectError(saveAgentPolicy(admin, agent.id, { preset: 'full_with_asks' }), 'FORBIDDEN', /An agent can never change/);
    await expectError(pauseAgent(admin, agent.id, true), 'FORBIDDEN');
    await expectError(pauseAllAgents(admin, true), 'FORBIDDEN');
    await expectError(getAgentDetail(admin, agent.id), 'FORBIDDEN');
    scope.inside = false;
    expect((await loadAgentPolicy(admin, agent.id)).preset).toBe('ask_every_change');
    await revokeAgent(admin, agent.id);
  });

  it('only a signed-in person who may modify Users & Roles', async () => {
    const { agent } = await newAgent('Guarded', ['view_only']);
    // A context with an Admin's access but nobody signed in changes nothing here.
    const nobody: ServiceContext = { ...admin, userId: null };
    await expectError(saveAgentPolicy(nobody, agent.id, { preset: 'read_only' }), 'FORBIDDEN', /signed in/);
    await expectError(pauseAgent(nobody, agent.id, true), 'FORBIDDEN', /signed in/);
    await expectError(saveAgentPolicy(bookkeeperPerson, agent.id, { preset: 'read_only' }), 'FORBIDDEN', /permission to modify Users/);
    await expectError(pauseAgent(bookkeeperPerson, agent.id, true), 'FORBIDDEN', /permission to modify Users/);
    // A person whose context was built without access is checked from the company file.
    const fromFile: ServiceContext = { db, companyId: admin.companyId, userId: adminId };
    await saveAgentPolicy(fromFile, agent.id, { preset: 'read_only' });
    expect((await loadAgentPolicy(admin, agent.id)).preset).toBe('read_only');
    await revokeAgent(admin, agent.id);
  });

  it('a person who is not an Admin may not loosen or turn back on an agent beyond their own access', async () => {
    const within = await newAgent('Within', ['view_only']);
    const boss = await newAgent('Admin agent', ['admin']);
    // Accountant includes the closing date, which the manager's own access only views.
    const beyond = await newAgent('Beyond', ['accountant']);

    await saveAgentPolicy(manager, within.agent.id, { preset: 'read_only' });
    await expectError(saveAgentPolicy(manager, boss.agent.id, { preset: 'read_only' }), 'FORBIDDEN', /holds the Admin role/);
    await expectError(saveAgentPolicy(manager, beyond.agent.id, { preset: 'read_only' }), 'FORBIDDEN', /more access than you/);

    // Stopping is never held back; turning back on is.
    await pauseAgent(manager, beyond.agent.id, true);
    expect(isPaused((await loadAgentPolicy(admin, beyond.agent.id)).pausedAt)).toBe(true);
    await expectError(pauseAgent(manager, beyond.agent.id, false), 'FORBIDDEN', /turn back on/);
    await pauseAgent(admin, beyond.agent.id, false);
    expect((await loadAgentPolicy(admin, beyond.agent.id)).pausedAt).toBeNull();

    // An Admin may change any of them.
    await saveAgentPolicy(admin, boss.agent.id, { preset: 'full_with_asks' });
    for (const a of [within, boss, beyond]) await revokeAgent(admin, a.agent.id);
  });
});

describe('pausing', () => {
  it('pauses and resumes one agent, audited once per change', async () => {
    const made = await newAgent('Pausable', ['bookkeeper']);
    const id = made.agent.id;
    const before = (await auditRowsFor(id)).length;
    await pauseAgent(admin, id, true);
    const policy = await loadAgentPolicy(admin, id);
    expect(isPaused(policy.pausedAt)).toBe(true);
    expect(Number.isFinite(Date.parse(policy.pausedAt!))).toBe(true);
    expect(await findAgentByToken(db, made.token)).toMatchObject({ id, pausedAt: policy.pausedAt });
    expect((await getAgentDetail(admin, id)).paused).toBe(true);
    // Pausing again changes nothing and writes nothing.
    await pauseAgent(admin, id, true);
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(before + 1);
    expect(rows.find((r) => (r.newValues as Record<string, unknown> | null)?.paused === true)).toMatchObject({
      action: 'update',
      userId: adminId,
      oldValues: { name: 'Pausable', paused: false },
    });
    await pauseAgent(admin, id, false);
    expect((await loadAgentPolicy(admin, id)).pausedAt).toBeNull();
    expect(await auditRowsFor(id)).toHaveLength(before + 2);

    await expectError(pauseAgent(admin, id, 'yes' as never), 'VALIDATION', /pause \(true\)/);
    await expectError(pauseAgent(admin, '00000000-0000-4000-8000-000000000000', true), 'NOT_FOUND');
    await revokeAgent(admin, id);
    await expectError(pauseAgent(admin, id, true), 'VALIDATION', /has been removed/);
  });

  it('"Pause all agents" is the Integrated Applications switch, for an Admin', async () => {
    const { agent } = await newAgent('Everyone', ['bookkeeper']);
    expect(await mayPauseAllAgents(admin)).toBe(true);
    expect(await mayPauseAllAgents(manager)).toBe(false);
    expect(await mayPauseAllAgents(bookkeeperPerson)).toBe(false);
    await expectError(pauseAllAgents(manager, true), 'FORBIDDEN', /Only an Admin can pause or resume every agent/);
    await expectError(pauseAllAgents(bookkeeperPerson, true), 'FORBIDDEN', /permission to modify Users/);

    await pauseAllAgents(admin, true);
    const [company] = await db.select().from(companies).where(eq(companies.id, admin.companyId));
    expect((company.settings as Record<string, unknown>).integratedAppsBlocked).toBe(true);
    // Every policy reads as paused, though the agent itself was not paused.
    expect(isPaused((await loadAgentPolicy(admin, agent.id)).pausedAt)).toBe(true);
    expect(await getAgentDetail(admin, agent.id)).toMatchObject({ paused: false, allPaused: true });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'company'), eq(auditLogs.entityId, admin.companyId)));
    const switched = audits.find((r) => (r.newValues as { settings?: Record<string, unknown> } | null)?.settings?.integratedAppsBlocked === true);
    expect(switched).toBeDefined();
    // Paused since the switch, not since the company's last change: a later Preferences save moves
    // that, never the time the agents were paused.
    await db.update(companies).set({ updatedAt: new Date('2030-01-01T00:00:00.000Z') }).where(eq(companies.id, admin.companyId));
    expect((await loadAgentPolicy(admin, agent.id)).pausedAt).toBe(switched!.createdAt.toISOString());

    // Already off: nothing is written.
    const count = audits.length;
    await pauseAllAgents(admin, true);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'company'), eq(auditLogs.entityId, admin.companyId)))).toHaveLength(count);

    await pauseAllAgents(admin, false);
    expect((await loadAgentPolicy(admin, agent.id)).pausedAt).toBeNull();
    expect((await getAgentDetail(admin, agent.id)).allPaused).toBe(false);
    await revokeAgent(admin, agent.id);
  });

  it('a switch with no audit row (an older version, or by hand) reads as paused since the last company change', async () => {
    const { agent } = await createAgent(otherCompanyAdmin, { name: 'Elsewhere', roleKeys: ['bookkeeper'] });
    const when = new Date('2026-11-01T08:30:00.000Z');
    await db.update(companies).set({ settings: { integratedAppsBlocked: true }, updatedAt: when }).where(eq(companies.id, otherCompanyAdmin.companyId));
    try {
      expect((await loadAgentPolicy(otherCompanyAdmin, agent.id)).pausedAt).toBe(when.toISOString());
    } finally {
      await db.update(companies).set({ settings: {} }).where(eq(companies.id, otherCompanyAdmin.companyId));
    }
    expect((await loadAgentPolicy(otherCompanyAdmin, agent.id)).pausedAt).toBeNull();
    await revokeAgent(otherCompanyAdmin, agent.id);
  });
});

describe('ceiling, detail and activity', () => {
  it("the ceiling is the agent's roles through the agent limits, with the role word and names", async () => {
    const bk = await newAgent('Ceiling', ['bookkeeper']);
    const viewer = await newAgent('Looker', ['view_only']);
    const boss = await newAgent('Ceiling boss', ['admin']);
    const c = await agentCeiling(admin, bk.agent.id);
    expect(c.access).toEqual(await agentAccess(db, { companyId: admin.companyId, roleKeys: ['bookkeeper'] }));
    expect(c).toMatchObject({ role: 'accountant', roleNames: ['Bookkeeper'] });
    expect((await agentCeiling(admin, viewer.agent.id)).role).toBe('viewer');
    const b = await agentCeiling(admin, boss.agent.id);
    expect(b.roleNames).toEqual(['Admin']);
    expect(b.access).toEqual(await agentAccess(db, { companyId: admin.companyId, roleKeys: ['admin'] }));
    for (const a of [bk, viewer, boss]) await revokeAgent(admin, a.agent.id);
  });

  it('the detail page, a removed agent included', async () => {
    const made = await newAgent('Detailed', ['bookkeeper'], 'full_with_asks');
    const detail = await getAgentDetail(admin, made.agent.id);
    expect(detail).toMatchObject({
      id: made.agent.id,
      name: 'Detailed',
      roleKeys: ['bookkeeper'],
      roleNames: ['Bookkeeper'],
      unattended: false,
      lastUsedAt: null,
      revokedAt: null,
      paused: false,
      allPaused: false,
      policy: { agentId: made.agent.id, preset: 'full_with_asks', overrides: [] },
    });
    expect(detail.policy.policy.bulkCap).toBe(DEFAULT_BULK_CAP);
    expect(JSON.stringify(detail)).not.toContain(made.token.slice(14));
    await revokeAgent(admin, made.agent.id);
    expect((await getAgentDetail(admin, made.agent.id)).revokedAt).not.toBeNull();
    await expectError(getAgentDetail(admin, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectError(getAgentDetail(otherCompanyAdmin, made.agent.id), 'NOT_FOUND');
  });

  it('lists its operations and requests, newest first, with who approved them', async () => {
    const { agent } = await newAgent('Busy', ['bookkeeper']);
    const other = await newAgent('Quiet', ['bookkeeper']);
    const companyId = admin.companyId;
    const t = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, min));

    // Something it ran on its own.
    const runner: ServiceContext = { db, companyId, userId: null, role: 'accountant', access: admin.access, agent: { id: agent.id, name: 'Busy', mode: 'post' } };
    const ownEntity = '11111111-2222-4333-8444-000000000001';
    await writeAudit(runner, { action: 'create', entityType: 'bank_rule', entityId: ownEntity, newValues: { name: 'x' } });
    await db.update(auditLogs).set({ createdAt: t(1) }).where(eq(auditLogs.entityId, ownEntity));

    // A request a person approved, and the operation it ran.
    const [executed] = await db
      .insert(agentPermissionRequests)
      .values({
        companyId,
        agentId: agent.id,
        requestKey: 'r-1',
        operation: 'invoices.create',
        class: 'enter',
        summary: 'Enter invoice for Acme',
        status: 'executed',
        decidedBy: adminId,
        decidedAt: t(3),
        expiresAt: t(60),
        createdAt: t(2),
      })
      .returning();
    await db.insert(auditLogs).values({
      companyId,
      userId: null,
      agentId: agent.id,
      approvedBy: adminId,
      agentRequestId: executed.id,
      action: 'create',
      entityType: 'invoice',
      entityId: '11111111-2222-4333-8444-000000000002',
      createdAt: t(3),
    });

    // One still waiting, and one denied.
    await db.insert(agentPermissionRequests).values([
      { companyId, agentId: agent.id, requestKey: 'r-2', operation: 'bills.delete', class: 'remove', summary: 'Delete bill 553', expiresAt: t(60), createdAt: t(5) },
      {
        companyId,
        agentId: agent.id,
        requestKey: 'r-3',
        operation: 'customers.update',
        class: 'change',
        summary: 'Change customer Acme',
        status: 'denied',
        decidedBy: adminId,
        expiresAt: t(60),
        createdAt: t(4),
      },
    ]);

    // Something it ran under standing permission.
    const [grant] = await db
      .insert(agentGrants)
      .values({ companyId, agentId: agent.id, operation: 'invoices.create', class: 'enter', givenBy: adminId, expiresAt: t(120) })
      .returning();
    await db.insert(auditLogs).values({
      companyId,
      userId: null,
      agentId: agent.id,
      agentGrantId: grant.id,
      action: 'update',
      entityType: 'journal_entry',
      entityId: '11111111-2222-4333-8444-000000000003',
      createdAt: t(6),
    });

    // Another agent's work and a person's own change are not its activity.
    await db.insert(auditLogs).values({ companyId, userId: null, agentId: other.agent.id, action: 'create', entityType: 'invoice', entityId: '11111111-2222-4333-8444-000000000004', createdAt: t(7) });

    const rows = await listAgentActivity(admin, agent.id);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['operation', 'done'], // t6, under the grant
      ['request', 'pending'], // t5
      ['request', 'denied'], // t4
      ['operation', 'done'], // t3, the approved run
      ['request', 'executed'], // t2
      ['operation', 'done'], // t1, its own
    ]);
    expect(rows[0]).toMatchObject({ operation: 'journal_entry.update', summary: 'Changed journal entry', class: null, approvedByName: 'Ada Admin', requestId: null });
    expect(rows[0].auditId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[1]).toMatchObject({ operation: 'bills.delete', summary: 'Delete bill 553', class: 'remove', approvedByName: null, auditId: null });
    expect(rows[2]).toMatchObject({ status: 'denied', approvedByName: null });
    expect(rows[3]).toMatchObject({ operation: 'invoices.create', class: 'enter', summary: 'Added invoice', approvedByName: 'Ada Admin', requestId: executed.id });
    expect(rows[4]).toMatchObject({ kind: 'request', summary: 'Enter invoice for Acme', approvedByName: 'Ada Admin', requestId: executed.id });
    expect(rows[5]).toMatchObject({ operation: 'bank_rule.create', summary: 'Added bank rule', approvedByName: null });
    expect(rows[0].at).toBe(t(6).toISOString());

    expect(await listAgentActivity(admin, agent.id, 2)).toHaveLength(2);
    expect(await listAgentActivity(admin, other.agent.id)).toHaveLength(1);
    await expectError(listAgentActivity(bookkeeperPerson, agent.id), 'FORBIDDEN');
    await expectError(listAgentActivity(admin, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await revokeAgent(admin, agent.id);
    await revokeAgent(admin, other.agent.id);
  });
});
