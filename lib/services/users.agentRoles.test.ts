/**
 * Agent full access (plan 4.6, D9): no agent may change or delete a role that any agent holds
 * (lib/services/users.ts updateRole / deleteRole, the service's own backstop behind the agent door).
 * A person's change of the same role is untouched, and an agent may still edit a role no agent holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companyRoles, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { agentsHoldingRole, createRole, deleteRole, heldRoleKeyForm, updateRole } from './users';

const AGENT = { id: '00000000-0000-4000-8000-0000000000c4', name: 'Keeper', mode: 'post' as const };

let t: TestCompany;
let agentCtx: ServiceContext;
let n = 0;

async function role(name: string) {
  return createRole(t.ctx, { name, permissions: { customers: ['view'] } });
}
async function agentHolding(name: string, roleKeys: string[], revoked = false, paused = false) {
  n += 1;
  await t.db.insert(agents).values({
    companyId: t.ctx.companyId,
    name,
    roleKeys,
    tokenHash: `${'0'.repeat(62)}${String(n).padStart(2, '0')}`,
    tokenPrefix: `ibk_test_${n}`,
    ...(revoked ? { revokedAt: new Date() } : {}),
    ...(paused ? { pausedAt: new Date() } : {}),
  });
}
/** A person of this company who holds the role (the stored id, as Users & Roles writes it). */
async function userHolding(roleKey: string) {
  n += 1;
  const [u] = await t.db
    .insert(users)
    .values({ email: `holder-${n}-${Date.now()}@test.local`, name: `Holder ${n}`, passwordHash: 'x' })
    .returning();
  await t.db.insert(userCompanies).values({ userId: u.id, companyId: t.ctx.companyId, role: 'viewer' });
  await t.db.insert(userRoleAssignments).values({ userId: u.id, companyId: t.ctx.companyId, roleKey });
}
const stored = async (id: string) => (await t.db.select().from(companyRoles).where(eq(companyRoles.id, id)))[0];

beforeAll(async () => {
  t = await makeTestCompany('agent-roles');
  agentCtx = { ...t.ctx, agent: AGENT };
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('a role an agent holds', () => {
  it('cannot be changed or deleted by an agent, whichever agent holds it (its own or another)', async () => {
    const clerk = await role('Clerk');
    await agentHolding('Clerk Agent', ['accountant', clerk.key]);
    await expect(updateRole(agentCtx, clerk.key, { permissions: { customers: ['view', 'create', 'modify'] } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'An agent cannot change the role "Clerk": an agent holds it, and changing a role an agent holds changes what that agent may do. A person can change it under Users & Roles.',
    });
    await expect(deleteRole(agentCtx, clerk.key)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/^An agent cannot delete the role "Clerk": an agent holds it/),
    });
    // The note never names the agent that holds it: agents may not learn other agents' names.
    await expect(updateRole(agentCtx, clerk.key, { name: 'x' })).rejects.toMatchObject({
      message: expect.not.stringContaining('Clerk Agent'),
    });
    expect(await stored(clerk.key)).toMatchObject({ name: 'Clerk', permissions: clerk.permissions });

    // Held by two: the note counts them.
    await agentHolding('Second Agent', [clerk.key]);
    await expect(updateRole(agentCtx, clerk.key, { name: 'Clerk 2' })).rejects.toMatchObject({
      message: expect.stringContaining('2 agents hold it'),
    });

    // A person's change is as before.
    await expect(updateRole(t.ctx, clerk.key, { name: 'Clerk (renamed)' })).resolves.toMatchObject({ name: 'Clerk (renamed)' });
  });

  it('a removed agent no longer holds its roles; a role no agent holds an agent may still change', async () => {
    const spare = await role('Spare');
    await agentHolding('Gone Agent', [spare.key], true);
    await expect(updateRole(agentCtx, spare.key, { name: 'Spare 2' })).resolves.toMatchObject({ name: 'Spare 2' });
    await expect(deleteRole(agentCtx, spare.key)).resolves.toBeUndefined();
    expect(await stored(spare.key)).toBeUndefined();
  });

  it('one rule, however the id is spelled: the agent sends it or holds it in capitals, braces or without hyphens', async () => {
    const spelled = await role('Spelled');
    const hex = spelled.key.replace(/-/g, '');
    // The agent sends the id in another spelling the database reads as the same uuid.
    await agentHolding('Plain Holder', [spelled.key]);
    for (const sent of [spelled.key.toUpperCase(), `{${spelled.key}}`, hex]) {
      await expect(updateRole(agentCtx, sent, { name: 'Spelled 2' }), sent).rejects.toMatchObject({ code: 'FORBIDDEN', details: { hardFloor: true, roleId: spelled.key } });
      await expect(deleteRole(agentCtx, sent), sent).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // An agent whose stored key is another spelling of the id holds the role too.
    const other = await role('Other spelling');
    await agentHolding('Capitals Holder', [`{${other.key.toUpperCase()}}`]);
    expect(await agentsHoldingRole(t.db, t.ctx.companyId, other.key)).toBe(1);
    await expect(updateRole(agentCtx, other.key, { name: 'Other 2' })).rejects.toMatchObject({ message: expect.stringContaining('an agent holds it') });
    // Removed agents do not count, in any spelling; nor do another company's agents.
    const gone = await role('Gone spelling');
    await agentHolding('Gone Capitals', [gone.key.toUpperCase()], true);
    expect(await agentsHoldingRole(t.db, t.ctx.companyId, gone.key)).toBe(0);
    expect(await agentsHoldingRole(t.db, '00000000-0000-4000-8000-0000000000ff', other.key)).toBe(0);
    expect(heldRoleKeyForm(` {${other.key.toUpperCase()}} `)).toBe(heldRoleKeyForm(other.key));
    expect(heldRoleKeyForm('Bookkeeper')).toBe('bookkeeper');
    expect(heldRoleKeyForm('')).toBeNull();
    expect(await stored(spelled.key)).toMatchObject({ name: 'Spelled' });
  });

  it('a paused agent still holds its roles (only a removed one gives them up)', async () => {
    const held = await role('Paused hold');
    await agentHolding('Paused Agent', [held.key], false, true);
    expect(await agentsHoldingRole(t.db, t.ctx.companyId, held.key)).toBe(1);
    await expect(updateRole(agentCtx, held.key, { name: 'Paused hold 2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('an agent holds it'),
      details: { hardFloor: true, roleId: held.key },
    });
    await expect(deleteRole(agentCtx, held.key)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { hardFloor: true } });
    expect(await stored(held.key)).toMatchObject({ name: 'Paused hold' });
  });

  it('a role users hold is not deleted, however its id is spelled (by a person or an agent)', async () => {
    const used = await role('Used by people');
    await userHolding(used.key);
    const spellings = [used.key, used.key.toUpperCase(), `{${used.key}}`, used.key.replace(/-/g, '')];
    for (const sent of spellings) {
      for (const ctx of [t.ctx, agentCtx]) {
        await expect(deleteRole(ctx, sent), sent).rejects.toMatchObject({
          code: 'CONFLICT',
          message: '"Used by people" is assigned to 1 user(s). Remove it from them first.',
        });
      }
    }
    expect(await stored(used.key)).toMatchObject({ name: 'Used by people' });
  });

  it('a person may delete a role only an agent holds (people manage agents and roles)', async () => {
    const temp = await role('Temp');
    await agentHolding('Temp Agent', [temp.key]);
    await expect(deleteRole(agentCtx, temp.key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteRole(t.ctx, temp.key)).resolves.toBeUndefined();
  });
});
