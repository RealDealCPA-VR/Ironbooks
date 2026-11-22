/**
 * Agent full access (plan 4.6, D9): no agent may change or delete a role that any agent holds
 * (lib/services/users.ts updateRole / deleteRole, the service's own backstop behind the agent door).
 * A person's change of the same role is untouched, and an agent may still edit a role no agent holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companyRoles } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { createRole, deleteRole, updateRole } from './users';

const AGENT = { id: '00000000-0000-4000-8000-0000000000c4', name: 'Keeper', mode: 'post' as const };

let t: TestCompany;
let agentCtx: ServiceContext;
let n = 0;

async function role(name: string) {
  return createRole(t.ctx, { name, permissions: { customers: ['view'] } });
}
async function agentHolding(name: string, roleKeys: string[], revoked = false) {
  n += 1;
  await t.db.insert(agents).values({
    companyId: t.ctx.companyId,
    name,
    roleKeys,
    tokenHash: `${'0'.repeat(62)}${String(n).padStart(2, '0')}`,
    tokenPrefix: `ibk_test_${n}`,
    ...(revoked ? { revokedAt: new Date() } : {}),
  });
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

  it('a person may delete a role only an agent holds (people manage agents and roles)', async () => {
    const temp = await role('Temp');
    await agentHolding('Temp Agent', [temp.key]);
    await expect(deleteRole(agentCtx, temp.key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteRole(t.ctx, temp.key)).resolves.toBeUndefined();
  });
});
