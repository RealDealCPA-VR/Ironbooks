/**
 * Agent full access: an agent's policy as stored (lib/services/agentPolicies.ts).
 *
 *  - an agent's policy is its preset, its stored overrides and the limits on its row, read through
 *    the policy engine; an unknown, removed or other agent is "not found";
 *  - the grid shows the locked cells with the reason in plain words;
 *  - only a signed-in person who may modify Users & Roles changes an agent's settings, and never a
 *    context that carries an agent or runs inside an agent's bridged run (D9, the hard floor);
 *  - letting an agent do more is an Admin's (plan 4.4): a non-Admin's save that loosens any field
 *    is refused whole and keeps nothing; tightening is open to everyone who manages agents, for
 *    any agent; a person who is not an Admin may not turn back on an agent beyond their own access;
 *  - a save is checked against the engine's rules and refused with what to change; it replaces
 *    the overrides, keeps the older mode in step with the preset and writes one audit row; the
 *    engine's own check catches what a hand-edited file keeps (a cell stored twice, a stored Allow);
 *  - a new folder must be a full path that exists, never a whole drive or share, never a share of
 *    this very computer, and never the books' or Ironbooks' own folders (staged files, working
 *    copies of every company file, settings, backups, archives, practice copies: overlapsAppData);
 *    a folder the agent already has is kept as stored and never looked at again on the disk, so
 *    taking folders away is never stopped by one that has since gone missing; its words still meet
 *    the rules (an Admin sending back one Ironbooks now keeps its own data in is told, anyone else
 *    has it taken away);
 *  - pause one agent, or all of them through the Integrated Applications switch, "paused since"
 *    staying put through later company saves;
 *  - the ceiling, the detail page and the activity list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

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
// files are kept (lib/agent/files.ts); the rest of that module (overlapsAppData, isThisComputerShare,
// appDataPlaces) is the real one.
// `realFolders` hands the folder check to the real allowedFolder, to show what a person is told
// for what it never takes (a whole drive or share). The stand-in takes an existing folder that is
// one of `allowed` or inside one. `looked` is every path either was asked of, and every path the
// real overlapsAppData was asked of; `overlapAsked` only the latter, word for word.
// `overlapSays`, when set, is a path (exactly as asked) that overlapsAppData answers true for
// whatever the real one says: a place only that check knows of. `skip`, when set, is a folder the
// folder check answers null for, as the real one does for a folder it skips.
// `beforeLook`, when set, runs once just before the folder check looks (another save landing then).
const scope = vi.hoisted(() => ({
  inside: false,
  staged: null as string | null,
  realFolders: false,
  looked: [] as string[],
  overlapAsked: [] as string[],
  overlapSays: null as string | null,
  skip: null as string | null,
  beforeLook: null as null | (() => Promise<void>),
}));
vi.mock('@/lib/serviceScope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inServiceScope: () => scope.inside,
}));
vi.mock('@/lib/agent/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/agent/files')>();
  return {
    ...real,
    stagedFilesRoot: () => scope.staged,
    overlapsAppData: (folder: string) => {
      scope.looked.push(folder);
      scope.overlapAsked.push(folder);
      if (scope.overlapSays !== null && folder === scope.overlapSays) return true;
      return real.overlapsAppData(folder);
    },
    allowedFolder: async (allowed: readonly string[], folder: string) => {
      scope.looked.push(...allowed, folder);
      const meanwhile = scope.beforeLook;
      scope.beforeLook = null;
      if (meanwhile) await meanwhile();
      if (scope.skip !== null) {
        const nodePath = await import('node:path');
        if (nodePath.resolve(folder) === nodePath.resolve(scope.skip)) return null;
      }
      if (scope.realFolders) return real.allowedFolder(allowed, folder);
      const nodeFs = await import('node:fs');
      const nodePath = await import('node:path');
      if (!nodePath.isAbsolute(folder)) return null;
      const want = nodePath.resolve(folder);
      const inside = (a: string) => nodePath.isAbsolute(a) && (want === nodePath.resolve(a) || want.startsWith(nodePath.resolve(a) + nodePath.sep));
      if (!allowed.some(inside)) return null;
      try {
        return nodeFs.statSync(folder).isDirectory() ? want : null;
      } catch {
        return null;
      }
    },
  };
});

import { getDb, closeDb, type DB } from '@/lib/db';
import { agentGrants, agentPermissionRequests, agentPolicies, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { builtinRole, fullAccess, unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import { DEFAULT_BULK_CAP, PRESET_DEFAULTS, isPaused } from '@/lib/agent/policy';
import { NEVER_ALLOW_CLASSES } from '@/lib/agent/operations/types';
import { createCompany, updateCompany } from './company';
import { ServiceError, type ServiceContext, writeAudit } from './_base';
import { agentAccess, createAgent, findAgentByToken, revokeAgent } from './agents';
import { rememberChosenFolder } from './backupHistory';
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
  scope.realFolders = false;
  scope.looked = [];
  scope.overlapAsked = [];
  scope.overlapSays = null;
  scope.skip = null;
  scope.beforeLook = null;
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

  it("the engine's check also catches the same cell stored twice, and a stored Allow in an area", async () => {
    // A save can never send either (readPolicyInput refuses both), so only a hand-edited file holds
    // them: here one without the index that keeps one row per cell.
    const { agent } = await newAgent('Doubled', ['bookkeeper']);
    const companyId = admin.companyId;
    await db.execute(sql`DROP INDEX IF EXISTS "agent_policies_key_idx"`);
    try {
      await db.insert(agentPolicies).values([
        { companyId, agentId: agent.id, class: 'enter', area: 'banking', setting: 'allow' },
        { companyId, agentId: agent.id, class: 'enter', area: 'banking', setting: 'never' },
      ]);
      await expectError(
        saveAgentPolicy(admin, agent.id, { requestExpiryDays: 4 }),
        'VALIDATION',
        /^"Enter new" in Banking was saved twice with different settings; the stricter one \(Never\) is used\. Fix this setting and save again\.$/,
      );
      expect((await loadAgentPolicy(admin, agent.id)).requestExpiryDays).toBe(7);
      expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toHaveLength(2);
      // Sending the settings replaces both rows with one, and the save goes through.
      const view = await saveAgentPolicy(admin, agent.id, { requestExpiryDays: 4, overrides: [{ class: 'enter', area: 'banking', setting: 'ask' }] });
      expect(view.overrides).toEqual([{ class: 'enter', area: 'banking', setting: 'ask' }]);
      expect(await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agent.id))).toHaveLength(1);
    } finally {
      await db.delete(agentPolicies).where(eq(agentPolicies.agentId, agent.id));
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "agent_policies_key_idx" ON "agent_policies" ("agent_id", "class", "area") NULLS NOT DISTINCT`,
      );
    }

    // An Allow kept in one area on a class that can never be Allow.
    await db.insert(agentPolicies).values({ companyId, agentId: agent.id, class: 'file', area: 'banking', setting: 'allow' });
    await expectError(
      saveAgentPolicy(admin, agent.id, { notifyEmail: true }),
      'VALIDATION',
      /^"Company file" in Banking can never be set to Allow for an agent, so it is set to Ask\. Fix this setting and save again\.$/,
    );
    expect((await loadAgentPolicy(admin, agent.id)).notifyEmail).toBe(false);
    // The engine itself never lets it run unasked meanwhile.
    expect((await loadAgentPolicy(admin, agent.id)).areas.banking?.file).toBe('ask');
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

  it('never the staging folder stagedFilesRoot names, wherever it is, nor any company file’s working folder, nor the company file’s own folder', async () => {
    const { agent } = await newAgent('Working', ['bookkeeper']);
    const working = path.join(FOLDERS, 'Working');
    const openOne = path.join(working, 'Acme-1a2b');
    const otherOne = path.join(working, 'Other-3c4d');
    // Where files.ts keeps staged files when the open file's working folder will not do: this
    // computer's local app data (the shape of %LOCALAPPDATA%\Ironbooks\agent-files), outside every
    // working folder and under a name the usual places do not list, so only stagedFilesRoot refuses it.
    const localApp = path.join(FOLDERS, 'LocalAppData', 'IronbooksTest');
    const staged = path.join(localApp, 'agent-files');
    const beside = path.join(FOLDERS, 'LocalAppData', 'Other app');
    const filed = path.join(FOLDERS, 'books');
    for (const d of [path.join(staged, 'company'), openOne, otherOne, beside, filed]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(filed, 'Acme.ironbooks'), 'x');
    const saved = { state: process.env.BKA_COMPANY_STATE, file: process.env.BKA_COMPANY_FILE };
    // As the desktop app starts the server for an open company file (electron/main.js).
    process.env.BKA_COMPANY_STATE = path.join(openOne, 'state.json');
    process.env.BKA_COMPANY_FILE = path.join(filed, 'Acme.ironbooks');
    try {
      // While stagedFilesRoot names no folder, the one it would name is an ordinary folder here:
      // what refuses it below is the staging rule and nothing else.
      scope.staged = null;
      await saveAgentPolicy(admin, agent.id, { folders: [staged] });
      await saveAgentPolicy(admin, agent.id, { folders: [] });
      scope.staged = staged;
      const own = /one of the folders Ironbooks keeps its own data in/;
      // The staging folder, a folder inside it and the folder that holds it.
      for (const folder of [staged, path.join(staged, 'company'), localApp]) {
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', own);
      }
      // A folder beside it is fine.
      expect((await saveAgentPolicy(admin, agent.id, { folders: [beside] })).policy.folders).toEqual([path.resolve(beside)]);
      await saveAgentPolicy(admin, agent.id, { folders: [] });
      // Another company file's working folder: not the open one's, so only the rule for all of them refuses it.
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [otherOne] }), 'VALIDATION', own);
      // The open file's working folder and the folder of them all hold, or sit in, the open books
      // as well: refused, by whichever rule comes first.
      for (const folder of [openOne, working]) {
        await expectError(
          saveAgentPolicy(admin, agent.id, { folders: [folder] }),
          'VALIDATION',
          /holds the company file or its working data|one of the folders Ironbooks keeps its own data in/,
        );
      }
      // The folder that holds the company file itself.
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [filed] }), 'VALIDATION', /holds the company file/);
    } finally {
      for (const [key, value] of [['BKA_COMPANY_STATE', saved.state], ['BKA_COMPANY_FILE', saved.file]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
    await revokeAgent(admin, agent.id);
  });

  it('never a whole drive or network share, and the person is told so (the real folder check)', async () => {
    const { agent } = await newAgent('Drive', ['bookkeeper']);
    const whole = /is a whole drive or network share\. Choose a folder on it for the agent/;
    const drive = path.parse(process.cwd()).root;
    // The real allowedFolder answers null for a whole drive or share, as for a folder that is not
    // there: the save says which it is, by the words, before asking it.
    for (const real of [false, true]) {
      scope.realFolders = real;
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [drive] }), 'VALIDATION', whole);
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [path.join(FOLDERS, 'missing')] }), 'VALIDATION', /was not found on this computer/);
      if (process.platform === 'win32') {
        // The drive letter alone, written without its separator, is the current folder of that
        // drive: not a full path at all.
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [drive.slice(0, 2)] }), 'VALIDATION', /not a full folder path/);
        // A share's own folder, by the words alone: the server is never looked at, so one that
        // does not exist is refused the same way. (A share of this computer is told something
        // else, its own folder included: see the test below.)
        for (const folder of [String.raw`\\no-such-server.invalid\books`, String.raw`\\no-such-server.invalid\books\\`]) {
          await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', whole);
        }
      }
    }
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
    await revokeAgent(admin, agent.id);
  });

  it('never a folder Ironbooks keeps copies of the books in, nor one holding a chosen backups folder (overlapsAppData)', async () => {
    const { agent } = await newAgent('Copies', ['bookkeeper']);
    const own = /one of the folders Ironbooks keeps its own data in .* Choose another folder for the agent\./;
    // Beside the books' data folder: the condense archives, and the practice copies (sandboxes)
    // where lib/services/sandbox.ts keeps them when the shell names no folder.
    const besideBooks = path.dirname(TEST_DIR);
    const archives = path.join(besideBooks, 'archives');
    const sandboxes = path.join(besideBooks, 'Ironbooks Sandboxes', 'practice-1');
    // Beside the company file: its condense archives. The folder of the company file itself is
    // refused by the books' rule; a folder inside it that holds no books is refused by this one.
    const filed = path.join(FOLDERS, 'filed');
    const fileArchives = path.join(filed, 'archives');
    // A backups folder chosen on this computer (Back Up settings), and the folder that holds it.
    const office = path.join(FOLDERS, 'office');
    const chosen = path.join(office, 'backups');
    for (const d of [archives, sandboxes, fileArchives, chosen]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(filed, 'Acme.ironbooks'), 'x');
    const saved = process.env.BKA_COMPANY_FILE;
    process.env.BKA_COMPANY_FILE = path.join(filed, 'Acme.ironbooks');
    try {
      for (const folder of [archives, sandboxes, path.dirname(sandboxes), fileArchives]) {
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', own);
      }
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [filed] }), 'VALIDATION', /holds the company file/);

      // Until it is chosen for backups, the office folder is an ordinary folder.
      expect((await saveAgentPolicy(admin, agent.id, { folders: [office] })).policy.folders).toEqual([path.resolve(office)]);
      await saveAgentPolicy(admin, agent.id, { folders: [] });
      rememberChosenFolder(chosen);
      for (const folder of [chosen, office]) {
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [folder] }), 'VALIDATION', own);
      }
      // A folder beside them is fine.
      expect((await saveAgentPolicy(admin, agent.id, { folders: [path.join(FOLDERS, 'receipts')] })).policy.folders).toEqual([
        path.resolve(FOLDERS, 'receipts'),
      ]);
    } finally {
      if (saved === undefined) delete process.env.BKA_COMPANY_FILE;
      else process.env.BKA_COMPANY_FILE = saved;
      // The list of chosen backup folders lives in the default backups folder beside the data.
      fs.rmSync(path.join(besideBooks, 'backups'), { recursive: true, force: true });
    }
    await revokeAgent(admin, agent.id);
  });

  it("overlapsAppData is asked of the folder as typed and as the disk has it, and its answer alone refuses", async () => {
    const { agent } = await newAgent('Only overlaps', ['bookkeeper']);
    const own = /one of the folders Ironbooks keeps its own data in .* Choose another folder for the agent\./;
    // An ordinary folder, typed with a detour (".."), so the path as typed and the real path the
    // folder check hands back are two different strings. No other rule refuses it.
    const ordinary = path.join(FOLDERS, 'ordinary');
    fs.mkdirSync(ordinary, { recursive: true });
    const typed = [FOLDERS, 'receipts', '..', 'ordinary'].join(path.sep);
    scope.realFolders = true;
    const real = fs.realpathSync.native(ordinary);
    expect(real).not.toBe(typed);
    // A place only overlapsAppData knows of (stood in), named once by each spelling.
    for (const says of [typed, real]) {
      scope.overlapSays = says;
      scope.overlapAsked = [];
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [typed] }), 'VALIDATION', own);
      expect(scope.overlapAsked).toContain(says);
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
    }
    // When it says nothing, the same folder is taken, as the disk has it.
    scope.overlapSays = null;
    expect((await saveAgentPolicy(admin, agent.id, { folders: [typed] })).policy.folders).toEqual([real]);
    await revokeAgent(admin, agent.id);
  });

  it('a folder it already has that Ironbooks keeps its own data in: an Admin is told, anyone else has it taken away', async () => {
    const { agent } = await newAgent('Kept own', ['view_only']);
    const own = /one of the folders Ironbooks keeps its own data in .* Choose another folder for the agent\./;
    const receipts = path.resolve(FOLDERS, 'receipts');
    // The condense archives beside the books' data folder, as an earlier round stored them before
    // they were one of Ironbooks' own folders (it is gone today: only its words are judged).
    const archives = path.join(path.dirname(TEST_DIR), 'archives');
    fs.rmSync(archives, { recursive: true, force: true });
    await db.update(agents).set({ folders: [archives, receipts], requestExpiryDays: 7 }).where(eq(agents.id, agent.id));
    // An Admin sending it back is told why, as for a new folder, and nothing is saved.
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [archives, receipts] }), 'VALIDATION', own);
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([archives, receipts]);
    // A manager who sends it back while tightening something else is not blocked: it is taken away
    // (a tightening), the rest is saved, the audit row says which and why, and neither kept folder
    // is looked at, on the disk or by the folder check.
    scope.looked = [];
    const disk = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs.realpathSync, 'native')];
    const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    let onDisk: string[];
    let view: Awaited<ReturnType<typeof saveAgentPolicy>>;
    try {
      view = await saveAgentPolicy(manager, agent.id, { folders: [archives, receipts], requestExpiryDays: 3 });
      onDisk = disk.flatMap((spy) => spy.mock.calls.map((call) => key(String(call[0]))));
    } finally {
      for (const spy of disk) spy.mockRestore();
    }
    expect(view.policy).toMatchObject({ folders: [receipts], requestExpiryDays: 3 });
    expect(scope.looked).toEqual([]);
    expect(onDisk.filter((p) => p === key(archives) || p === key(receipts))).toEqual([]);
    const rows = await auditRowsFor(agent.id);
    const audit = rows.find((r) => (r.newValues as Record<string, unknown> | null)?.foldersTakenAway);
    expect(audit?.newValues).toMatchObject({ folders: [receipts], foldersTakenAway: [{ folder: archives, why: expect.stringMatching(own) }] });

    // A folder it was given while it was ordinary, which has since come to hold a chosen backups
    // folder: the same, for an Admin and for anyone else.
    const office = path.join(FOLDERS, 'office-kept');
    const chosen = path.join(office, 'backups');
    fs.mkdirSync(chosen, { recursive: true });
    await saveAgentPolicy(admin, agent.id, { folders: [office, receipts] });
    const stored = (await loadAgentPolicy(admin, agent.id)).folders;
    expect(stored).toHaveLength(2);
    try {
      rememberChosenFolder(chosen);
      await expectError(saveAgentPolicy(admin, agent.id, { folders: stored }), 'VALIDATION', own);
      // A save that sends no folders judges none (the screen sends only what changed).
      await saveAgentPolicy(manager, agent.id, { requestExpiryDays: 2 });
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual(stored);
      expect((await saveAgentPolicy(manager, agent.id, { folders: stored })).policy.folders).toEqual([receipts]);
    } finally {
      fs.rmSync(path.join(path.dirname(TEST_DIR), 'backups'), { recursive: true, force: true });
    }
    await revokeAgent(admin, agent.id);
  });

  it.runIf(process.platform === 'win32')('never a share of this very computer, and the person is told to type its own path', async () => {
    const { agent } = await newAgent('Loopback', ['bookkeeper']);
    const onThisComputer = /that folder is on this computer, reached as a network share\. Type its own path on this computer instead, like C:\\/;
    const host = os.hostname();
    const shares = [
      String.raw`\\localhost\c$\Users\Public\Documents`,
      String.raw`\\127.0.0.1\c$\Users\Public`,
      String.raw`\\[::1]\c$\Users\Public`,
      `\\\\${host}\\c$\\Users\\Public`,
      // The share's own folder too: "choose a folder on it" would only lead to \\localhost\c$\...,
      // refused in turn, so it is told to type the path on this computer as well.
      String.raw`\\localhost\c$`,
      String.raw`\\localhost\c$\\`,
      `\\\\${host}\\c$`,
    ];
    for (const real of [false, true]) {
      scope.realFolders = real;
      for (const share of shares) {
        scope.looked = [];
        await expectError(saveAgentPolicy(admin, agent.id, { folders: [share] }), 'VALIDATION', onThisComputer);
        // Refused by the words: the share is never looked at, so nothing is offered a sign-in.
        expect(scope.looked, share).toEqual([]);
      }
    }
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
    await revokeAgent(admin, agent.id);
  });

  it.runIf(process.platform === 'win32')('a drive letter the disk answers as a share of this computer is told so, not "not found"', async () => {
    const { agent } = await newAgent('Mapped', ['bookkeeper']);
    const onThisComputer = /that folder is on this computer, reached as a network share\. Type its own path on this computer instead/;
    // As a drive mapped to \\localhost\c$ looks: a local path the folder check skips, which the disk
    // spells as a share of this computer. Stood in for (mapping a drive changes this computer).
    const mapped = path.join(FOLDERS, 'mapped');
    fs.mkdirSync(mapped, { recursive: true });
    scope.skip = mapped;
    // Skipped for another reason (the disk spells it as itself): not found, as before.
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [mapped] }), 'VALIDATION', /was not found on this computer/);
    const realpath = fs.realpathSync.native;
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, options?: unknown) =>
      path.resolve(String(p)).toLowerCase() === path.resolve(mapped).toLowerCase()
        ? String.raw`\\localhost\c$\Shared\mapped`
        : realpath(p, options as fs.EncodingOption)) as typeof fs.realpathSync.native);
    try {
      await expectError(saveAgentPolicy(admin, agent.id, { folders: [mapped] }), 'VALIDATION', onThisComputer);
    } finally {
      spy.mockRestore();
    }
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
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

  it('a person who is not an Admin may tighten any agent, but not turn back on one beyond their own access', async () => {
    const within = await newAgent('Within', ['view_only']);
    const boss = await newAgent('Admin agent', ['admin']);
    // Accountant includes the closing date, which the manager's own access only views.
    const beyond = await newAgent('Beyond', ['accountant']);

    // Changed on purpose (plan 4.4, wave 3): a non-Admin's save may only tighten, so it is open
    // for every agent, an Admin-role one and one beyond the manager's own access included.
    await saveAgentPolicy(manager, within.agent.id, { preset: 'read_only' });
    await saveAgentPolicy(manager, boss.agent.id, { preset: 'read_only' });
    await saveAgentPolicy(manager, beyond.agent.id, { overrides: [{ class: 'enter', area: null, setting: 'never' }] });
    expect((await loadAgentPolicy(admin, boss.agent.id)).preset).toBe('read_only');
    expect((await loadAgentPolicy(admin, beyond.agent.id)).classes.enter).toBe('never');
    // Loosening any of them is not, within the manager's access or not.
    await expectError(saveAgentPolicy(manager, boss.agent.id, { preset: 'full_with_asks' }), 'FORBIDDEN', /Only an Admin can let an agent do more/);
    await expectError(saveAgentPolicy(manager, within.agent.id, { preset: 'ask_every_change' }), 'FORBIDDEN', /Only an Admin/);

    // Stopping is never held back; turning back on is.
    await pauseAgent(manager, beyond.agent.id, true);
    expect(isPaused((await loadAgentPolicy(admin, beyond.agent.id)).pausedAt)).toBe(true);
    await expectError(pauseAgent(manager, beyond.agent.id, false), 'FORBIDDEN', /turn back on/);
    await pauseAgent(manager, boss.agent.id, true);
    await expectError(pauseAgent(manager, boss.agent.id, false), 'FORBIDDEN', /holds the Admin role/);
    await pauseAgent(admin, beyond.agent.id, false);
    expect((await loadAgentPolicy(admin, beyond.agent.id)).pausedAt).toBeNull();

    // An Admin may change any of them, in either direction.
    await saveAgentPolicy(admin, boss.agent.id, { preset: 'full_with_asks' });
    for (const a of [within, boss, beyond]) await revokeAgent(admin, a.agent.id);
  });
});

describe('letting an agent do more is for an Admin (plan 4.4)', () => {
  /** The stored row and override rows, to show a refused save kept nothing. */
  async function snapshot(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const rows = await db.select().from(agentPolicies).where(eq(agentPolicies.agentId, agentId));
    return {
      row: { ...row, lastUsedAt: null },
      overrides: rows.map((r) => [r.class, r.area, r.setting]).sort(),
      audits: (await auditRowsFor(agentId)).length,
    };
  }

  /** A manager's save is refused whole, naming the loosening, and keeps nothing. */
  async function refusedForManager(agentId: string, input: Parameters<typeof saveAgentPolicy>[2], names: RegExp) {
    const before = await snapshot(agentId);
    const e = await saveAgentPolicy(manager, agentId, input).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e, `expected ${JSON.stringify(input)} to be refused`).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe('FORBIDDEN');
    expect((e as ServiceError).message).toMatch(/^Only an Admin can let an agent do more\. This change would /);
    expect((e as ServiceError).message).toMatch(names);
    expect((e as ServiceError).message).toMatch(/Ask an Admin to make it\. You can still tighten this agent's settings or pause it\.$/);
    expect(((e as ServiceError).details as { looser: string[] }).looser.length).toBeGreaterThan(0);
    expect(await snapshot(agentId)).toEqual(before);
  }

  it('the preset: a higher one only for an Admin, a lower one for anyone who manages agents', async () => {
    const { agent } = await newAgent('Preset steps', ['view_only']);
    await refusedForManager(agent.id, { preset: 'trusted_bookkeeper' }, /move it from "Ask for every change" to "Trusted bookkeeper"/);
    await refusedForManager(agent.id, { preset: 'full_with_asks' }, /to "Full, with asks"/);
    await saveAgentPolicy(manager, agent.id, { preset: 'read_only' });
    expect((await loadAgentPolicy(admin, agent.id)).preset).toBe('read_only');
    // Back up again is loosening, even to where it was.
    await refusedForManager(agent.id, { preset: 'ask_every_change' }, /move it from "Read only" to "Ask for every change"/);
    await saveAgentPolicy(admin, agent.id, { preset: 'trusted_bookkeeper' });
    expect((await loadAgentPolicy(admin, agent.id)).preset).toBe('trusted_bookkeeper');
    await revokeAgent(admin, agent.id);
  });

  it('a cell, everywhere or in one area: toward Allow only for an Admin, toward Never for anyone', async () => {
    const { agent } = await newAgent('Cells', ['view_only']);
    const o = (cls: 'enter' | 'change', area: 'banking' | 'payroll' | null, setting: 'allow' | 'ask' | 'never') => ({ class: cls, area, setting });
    await refusedForManager(agent.id, { overrides: [o('enter', null, 'allow')] }, /set "Enter new" from Ask to Allow/);
    await refusedForManager(agent.id, { overrides: [o('enter', 'banking', 'allow')] }, /set "Enter new" in Banking from Ask to Allow/);

    await saveAgentPolicy(manager, agent.id, { overrides: [o('enter', null, 'never')] });
    expect((await loadAgentPolicy(admin, agent.id)).classes.enter).toBe('never');
    // Taking that adjustment away again puts the cell back at Ask: loosening.
    await refusedForManager(agent.id, { overrides: [] }, /set "Enter new" from Never to Ask/);
    // An area that keeps what everywhere says changes nothing; one that steps back from it loosens.
    await saveAgentPolicy(manager, agent.id, { overrides: [o('enter', null, 'never'), o('enter', 'payroll', 'never')] });
    await refusedForManager(agent.id, { overrides: [o('enter', null, 'never'), o('enter', 'banking', 'ask')] }, /set "Enter new" in Banking from Never to Ask/);
    // One save that tightens one cell and loosens another is refused whole.
    await refusedForManager(agent.id, { overrides: [o('change', null, 'never')] }, /set "Enter new" from Never to Ask/);
    expect((await loadAgentPolicy(admin, agent.id)).classes.change).toBe('ask');

    // A loosening everywhere is named once, not again for every area that follows it.
    const { agent: wide } = await newAgent('Cells wide', ['view_only']);
    const e = await saveAgentPolicy(manager, wide.id, { preset: 'trusted_bookkeeper' }).catch((err: ServiceError) => err);
    const looser = ((e as ServiceError).details as { looser: string[] }).looser;
    expect(looser.filter((l) => l.startsWith('set "Enter new"'))).toEqual(['set "Enter new" from Ask to Allow']);
    expect((e as ServiceError).message).toMatch(/; and \d+ more\./);

    // An Admin moves any cell toward Allow.
    await saveAgentPolicy(admin, agent.id, { overrides: [o('enter', null, 'allow'), o('enter', 'banking', 'allow')] });
    expect((await loadAgentPolicy(admin, agent.id)).classes.enter).toBe('allow');
    for (const id of [agent.id, wide.id]) await revokeAgent(admin, id);
  });

  it('the bulk cap: higher or none only for an Admin, lower for anyone', async () => {
    const { agent } = await newAgent('Capped', ['view_only']);
    await saveAgentPolicy(manager, agent.id, { bulkCap: 50 }); // none to 50: a limit where there was none
    await refusedForManager(agent.id, { bulkCap: 100 }, /raise the most records one request may change from 50 to 100/);
    await refusedForManager(agent.id, { bulkCap: null }, /remove the limit of 50 records one request may change/);
    await saveAgentPolicy(manager, agent.id, { bulkCap: 20 });
    expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBe(20);
    await saveAgentPolicy(admin, agent.id, { bulkCap: null });
    expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBeNull();
    await revokeAgent(admin, agent.id);
  });

  it('the bulk cap where there was none: above the usual one only for an Admin, since grants are held to it', async () => {
    // "Ask for every change" and "Trusted bookkeeper" store no cap; a standing permission for bulk
    // work is then held to DEFAULT_BULK_CAP (createGrant), so a higher cap would let grants cover more.
    for (const preset of ['ask_every_change', 'trusted_bookkeeper'] as const) {
      const { agent } = await newAgent(`No cap ${preset}`, ['view_only'], preset);
      expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBeNull(); // as created: no stored cap
      await refusedForManager(
        agent.id,
        { bulkCap: DEFAULT_BULK_CAP + 1 },
        new RegExp(`raise the most records one request may change from the usual ${DEFAULT_BULK_CAP} to ${DEFAULT_BULK_CAP + 1}`),
      );
      await refusedForManager(agent.id, { bulkCap: 100000 }, /from the usual \d+ to 100000/);
      // The usual cap itself, or less, only tightens.
      await saveAgentPolicy(manager, agent.id, { bulkCap: DEFAULT_BULK_CAP });
      expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBe(DEFAULT_BULK_CAP);
      await refusedForManager(agent.id, { bulkCap: DEFAULT_BULK_CAP + 1 }, new RegExp(`from ${DEFAULT_BULK_CAP} to ${DEFAULT_BULK_CAP + 1}`));
      await saveAgentPolicy(admin, agent.id, { bulkCap: null });
      await saveAgentPolicy(manager, agent.id, { bulkCap: 10 });
      expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBe(10);
      // An Admin may set any cap.
      await saveAgentPolicy(admin, agent.id, { bulkCap: 100000 });
      expect((await loadAgentPolicy(admin, agent.id)).bulkCap).toBe(100000);
      await revokeAgent(admin, agent.id);
    }
  });

  it('two-person approval: on or lower for anyone, higher or off only for an Admin', async () => {
    const { agent } = await newAgent('Two people', ['view_only']);
    await saveAgentPolicy(manager, agent.id, { twoPersonOver: '1000' });
    await saveAgentPolicy(manager, agent.id, { twoPersonOver: '500.00' });
    expect((await loadAgentPolicy(admin, agent.id)).twoPersonOver).toBe('500.00');
    await refusedForManager(agent.id, { twoPersonOver: '800' }, /raise the amount that needs two people from 500\.00 to 800\.00/);
    await refusedForManager(agent.id, { twoPersonOver: null }, /turn off two-person approval \(now needed above 500\.00\)/);
    // The same amount written another way is no change.
    await saveAgentPolicy(manager, agent.id, { twoPersonOver: '500' });
    await saveAgentPolicy(admin, agent.id, { twoPersonOver: null });
    expect((await loadAgentPolicy(admin, agent.id)).twoPersonOver).toBeNull();
    await revokeAgent(admin, agent.id);
  });

  it('folders: a folder it could not reach before only for an Admin; fewer, or one inside its own, for anyone', async () => {
    const { agent } = await newAgent('Folders', ['view_only']);
    const receipts = path.join(FOLDERS, 'receipts');
    const statements = path.join(FOLDERS, 'statements');
    const year = path.join(receipts, '2026');
    fs.mkdirSync(year, { recursive: true });
    await refusedForManager(agent.id, { folders: [receipts] }, /let it use the folder ".*receipts"/);
    await saveAgentPolicy(admin, agent.id, { folders: [receipts, statements] });
    await saveAgentPolicy(manager, agent.id, { folders: [receipts] });
    await saveAgentPolicy(manager, agent.id, { folders: [year] });
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([path.resolve(year)]);
    // Wider again, or another folder, is loosening.
    await refusedForManager(agent.id, { folders: [receipts] }, /let it use the folder/);
    await refusedForManager(agent.id, { folders: [year, statements] }, /let it use the folder ".*statements"/);
    await saveAgentPolicy(manager, agent.id, { folders: [] });
    await revokeAgent(admin, agent.id);
  });

  it('folders: a stored folder that reaches nothing today (a whole drive, the books) is not one it already had', async () => {
    const { agent } = await newAgent('Stored folders', ['view_only']);
    const receipts = path.join(FOLDERS, 'receipts');
    const drive = path.parse(FOLDERS).root;
    // As an older version or a hand edit may have left them: the folder check never takes a whole
    // drive (allowedFolder skips one when used), nor a folder that holds the books' data folder.
    for (const stored of [[drive], [ROOT]]) {
      await db.update(agents).set({ folders: stored }).where(eq(agents.id, agent.id));
      await refusedForManager(agent.id, { folders: [receipts] }, /let it use the folder ".*receipts"/);
    }
    // A stored folder that does reach something still counts: a folder inside it only tightens.
    await db.update(agents).set({ folders: [FOLDERS] }).where(eq(agents.id, agent.id));
    await saveAgentPolicy(manager, agent.id, { folders: [receipts] });
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([path.resolve(receipts)]);
    // An Admin may add it either way.
    await db.update(agents).set({ folders: [drive] }).where(eq(agents.id, agent.id));
    await saveAgentPolicy(admin, agent.id, { folders: [receipts] });
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([path.resolve(receipts)]);
    await revokeAgent(admin, agent.id);
  });

  it('folders: one it already has is not new, whatever the disk says of it today, and is never looked at', async () => {
    const { agent } = await newAgent('Kept folders', ['view_only']);
    // An Admin gave it a folder that was later deleted.
    const gone = path.join(FOLDERS, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    await saveAgentPolicy(admin, agent.id, { folders: [gone] });
    fs.rmSync(gone, { recursive: true, force: true });
    const deleted = (await loadAgentPolicy(admin, agent.id)).folders;
    expect(deleted).toEqual([path.resolve(gone)]);
    const drive = path.parse(FOLDERS).root;
    // A network folder, as an older or crafted company file may hold one: looking at it would offer
    // this person's sign-in to that server, or hang the save while the share is offline.
    const share = '\\\\nowhere.invalid\\share\\Receipts';
    const tighten = { class: 'enter' as const, area: null, setting: 'never' as const };
    // Every way this module looks at the disk (lib/agent/files.ts's allowedFolder is the stand-in's `looked`).
    const disk = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs.realpathSync, 'native')];
    const asked = () => [...scope.looked, ...disk.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))];
    const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    try {
      for (const stored of [deleted, [drive], [share], [ROOT], [...deleted, drive, share, ROOT]]) {
        await db.update(agents).set({ folders: stored, requestExpiryDays: 7 }).where(eq(agents.id, agent.id));
        await db.delete(agentPolicies).where(eq(agentPolicies.agentId, agent.id));
        scope.looked = [];
        for (const spy of disk) spy.mockClear();
        // A manager tightens one cell, then shortens the wait. Neither save sends folders (the
        // screen sends only what changed), so the folders kept are the ones it had: no loosening.
        await saveAgentPolicy(manager, agent.id, { overrides: [tighten] });
        await saveAgentPolicy(manager, agent.id, { requestExpiryDays: 3 });
        const policy = await loadAgentPolicy(admin, agent.id);
        expect(policy).toMatchObject({ folders: stored, requestExpiryDays: 3 });
        expect(policy.classes.enter).toBe('never');
        // No stored folder was looked at, on the disk or by the folder check.
        const keys = new Set(stored.map(key));
        expect(asked().filter((p) => keys.has(key(p)))).toEqual([]);
        // Taking a folder away is tightening too, and looks at none of the rest.
        if (stored.length > 1) {
          await saveAgentPolicy(manager, agent.id, { folders: [] });
          expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
          expect(asked().filter((p) => keys.has(key(p)))).toEqual([]);
        }
      }
      // The watch above sees this module's looks: a folder a save sends is looked at.
      const receipts = path.join(FOLDERS, 'receipts');
      await saveAgentPolicy(admin, agent.id, { folders: [receipts] });
      expect(disk.flatMap((spy) => spy.mock.calls.map((call) => key(String(call[0]))))).toContain(key(receipts));
    } finally {
      for (const spy of disk) spy.mockRestore();
    }
    await revokeAgent(admin, agent.id);
  });

  it('folders: taking one away is never stopped by another it keeps that has since gone missing, and a kept one is never looked at', async () => {
    const { agent } = await newAgent('Gone but kept', ['view_only']);
    const receipts = path.join(FOLDERS, 'receipts');
    const statements = path.join(FOLDERS, 'statements');
    const gone = path.join(FOLDERS, 'gone-later');
    fs.mkdirSync(gone, { recursive: true });
    await saveAgentPolicy(admin, agent.id, { folders: [receipts, gone] });
    fs.rmSync(gone, { recursive: true, force: true });
    const stored = (await loadAgentPolicy(admin, agent.id)).folders;
    const goneAsStored = stored.find((f) => f !== path.resolve(receipts))!;
    // A network folder an older version took, offline now (looking would offer it a sign-in).
    const share = '\\\\nowhere.invalid\\share\\Receipts';
    const disk = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs.realpathSync, 'native')];
    const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const lookedAt = (p: string) =>
      [...scope.looked, ...disk.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))].some((q) => key(q) === key(p));
    const fresh = () => {
      scope.looked = [];
      for (const spy of disk) spy.mockClear();
    };
    try {
      // A manager takes receipts away and keeps the folder that is gone: tightening, saved as asked,
      // and the gone folder is never looked at (it is not "made first").
      fresh();
      const view = await saveAgentPolicy(manager, agent.id, { folders: [goneAsStored] });
      expect(view.policy.folders).toEqual([goneAsStored]);
      expect(lookedAt(gone)).toBe(false);
      // Sent back spelled another way (another case on Windows), it is still the one it had: kept as stored.
      if (process.platform === 'win32') {
        fresh();
        expect((await saveAgentPolicy(manager, agent.id, { folders: [goneAsStored.toUpperCase()] })).policy.folders).toEqual([goneAsStored]);
        expect(lookedAt(gone)).toBe(false);
      }
      // The same with a stored share that is offline, kept beside it.
      await db.update(agents).set({ folders: [goneAsStored, share, path.resolve(receipts)] }).where(eq(agents.id, agent.id));
      fresh();
      await saveAgentPolicy(manager, agent.id, { folders: [share, goneAsStored] });
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([share, goneAsStored]);
      expect(lookedAt(gone) || lookedAt(share)).toBe(false);
      // An Admin adding a folder beside a kept one that is gone: only the new one is looked at.
      fresh();
      await saveAgentPolicy(admin, agent.id, { folders: [goneAsStored, statements] });
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([goneAsStored, path.resolve(statements)]);
      expect(lookedAt(gone)).toBe(false);
      expect(lookedAt(statements)).toBe(true);
      // Sending it twice keeps it once.
      await saveAgentPolicy(manager, agent.id, { folders: [goneAsStored, goneAsStored] });
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([goneAsStored]);
    } finally {
      for (const spy of disk) spy.mockRestore();
    }
    // A folder that is gone and was never the agent's is new: refused as before.
    await expectError(saveAgentPolicy(admin, agent.id, { folders: [path.join(FOLDERS, 'never-there')] }), 'VALIDATION', /was not found on this computer/);
    await revokeAgent(admin, agent.id);
  });

  it('folders: a kept folder someone took away while the save was being checked saves nothing', async () => {
    const { agent } = await newAgent('Raced', ['view_only']);
    const receipts = path.join(FOLDERS, 'receipts');
    const statements = path.join(FOLDERS, 'statements');
    await saveAgentPolicy(admin, agent.id, { folders: [receipts] });
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([path.resolve(receipts)]);
    const audits = (await auditRowsFor(agent.id)).length;
    // Another person's save lands while this one checks its new folder: receipts is no longer the
    // agent's, so this save would add it back unchecked. It is refused, and saves nothing.
    scope.beforeLook = async () => {
      await db.update(agents).set({ folders: [] }).where(eq(agents.id, agent.id));
    };
    await expectError(
      saveAgentPolicy(admin, agent.id, { folders: [path.resolve(receipts), statements] }),
      'CONFLICT',
      /changed by someone else while you were saving\. Open the agent again and save once more\./,
    );
    expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([]);
    expect((await auditRowsFor(agent.id)).length).toBe(audits);
    await revokeAgent(admin, agent.id);
  });

  it('folders: only a stored folder that holds one just chosen is looked at, and the check is the save check', async () => {
    const { agent } = await newAgent('Narrowing', ['view_only']);
    const receipts = path.join(FOLDERS, 'receipts');
    const gone = path.join(FOLDERS, 'never-made');
    const share = '\\\\nowhere.invalid\\share\\Receipts';
    for (const real of [false, true]) {
      scope.realFolders = real;
      await db.update(agents).set({ folders: [FOLDERS, gone, share] }).where(eq(agents.id, agent.id));
      scope.looked = [];
      // Narrowing to a folder inside one it has, while another it has is gone: tightening.
      await saveAgentPolicy(manager, agent.id, { folders: [receipts] });
      expect((await loadAgentPolicy(admin, agent.id)).folders).toEqual([real ? fs.realpathSync.native(receipts) : path.resolve(receipts)]);
      expect(scope.looked).toContain(FOLDERS);
      expect(scope.looked).not.toContain(gone);
      expect(scope.looked).not.toContain(share);
    }
    // Wider than the folder it has is still new, and the stored folders are not looked at for it.
    await db.update(agents).set({ folders: [receipts, gone, share] }).where(eq(agents.id, agent.id));
    scope.looked = [];
    await refusedForManager(agent.id, { folders: [FOLDERS] }, /let it use the folder ".*folders"/);
    expect(scope.looked.filter((p) => p !== FOLDERS)).toEqual([]);
    await revokeAgent(admin, agent.id);
  });

  it('a longer wait and the email notice only for an Admin; shorter and off for anyone', async () => {
    const { agent } = await newAgent('Waits', ['view_only']);
    await saveAgentPolicy(manager, agent.id, { requestExpiryDays: 3 });
    await refusedForManager(agent.id, { requestExpiryDays: 10 }, /let its requests wait 10 days instead of 3/);
    await refusedForManager(agent.id, { notifyEmail: true }, /turn on the email notice, which sends email outside this computer/);
    await saveAgentPolicy(admin, agent.id, { notifyEmail: true, requestExpiryDays: 10 });
    await saveAgentPolicy(manager, agent.id, { notifyEmail: false, requestExpiryDays: 5 });
    expect(await loadAgentPolicy(admin, agent.id)).toMatchObject({ notifyEmail: false, requestExpiryDays: 5 });
    await revokeAgent(admin, agent.id);
  });

  it('a person read from the company file is judged the same way', async () => {
    const { agent } = await newAgent('From file', ['view_only']);
    const [mgr] = await db.select().from(users).where(eq(users.email, 'mgr@policies.test'));
    const notMember: ServiceContext = { db, companyId: admin.companyId, userId: mgr.id };
    // Not a member of the company in the file: no access at all.
    await expectError(saveAgentPolicy(notMember, agent.id, { preset: 'read_only' }), 'FORBIDDEN');
    // The owner, read from the file, is an Admin and may loosen.
    await saveAgentPolicy({ db, companyId: admin.companyId, userId: adminId }, agent.id, { preset: 'full_with_asks' });
    expect((await loadAgentPolicy(admin, agent.id)).preset).toBe('full_with_asks');
    await revokeAgent(admin, agent.id);
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

  it('"paused since" stays put through later company saves that do not turn the switch', async () => {
    const { agent } = await newAgent('Steady', ['bookkeeper']);
    await pauseAllAgents(admin, true);
    try {
      const first = (await loadAgentPolicy(admin, agent.id)).pausedAt;
      expect(Number.isFinite(Date.parse(first!))).toBe(true);
      // Another Preferences save, a save that sends the switch again unchanged, and the company's
      // last-change time moved by hand: none of them is when the agents were paused.
      await new Promise((r) => setTimeout(r, 5));
      await updateCompany(admin, { settings: { phone: '555-0100' } });
      await updateCompany(admin, { settings: { integratedAppsBlocked: true } });
      await db.update(companies).set({ updatedAt: new Date('2031-05-05T00:00:00.000Z') }).where(eq(companies.id, admin.companyId));
      expect((await loadAgentPolicy(admin, agent.id)).pausedAt).toBe(first);
    } finally {
      await pauseAllAgents(admin, false);
    }
    expect((await loadAgentPolicy(admin, agent.id)).pausedAt).toBeNull();
    await revokeAgent(admin, agent.id);
  });

  it('a switch with no audit row (an older version, or by hand) reads as paused since a time no save moves', async () => {
    const { agent } = await createAgent(otherCompanyAdmin, { name: 'Elsewhere', roleKeys: ['bookkeeper'] });
    const [company] = await db.select().from(companies).where(eq(companies.id, otherCompanyAdmin.companyId));
    await db
      .update(companies)
      .set({ settings: { integratedAppsBlocked: true }, updatedAt: new Date('2026-11-01T08:30:00.000Z') })
      .where(eq(companies.id, otherCompanyAdmin.companyId));
    try {
      const policy = await loadAgentPolicy(otherCompanyAdmin, agent.id);
      expect(isPaused(policy.pausedAt)).toBe(true);
      // When the company was made: the earliest it can have been switched off, and nothing moves it.
      expect(policy.pausedAt).toBe(company.createdAt.toISOString());
      await db.update(companies).set({ updatedAt: new Date('2032-01-01T00:00:00.000Z') }).where(eq(companies.id, otherCompanyAdmin.companyId));
      expect((await loadAgentPolicy(otherCompanyAdmin, agent.id)).pausedAt).toBe(company.createdAt.toISOString());
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
