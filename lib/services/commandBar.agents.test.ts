/**
 * The server command bar finds the agent pages (Agent requests) only while the company has an
 * agent, as the menu and the command palette do (lib/services/commandBar.ts executeNavigate passes
 * `hasAgents` to searchPages, counted by lib/services/agents.ts agentCount). Every other page is
 * found as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '@/lib/db/schema';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { executeIntent } from './commandBar';

const WHEN = new Date('2026-11-20T12:00:00Z');
let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('command-bar-agents');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

const go = (target: string) => executeIntent(t.ctx, { kind: 'navigate', target }, {}, WHEN);

describe('"go to agent requests"', () => {
  it('is not found while the company has no agent; other pages are', async () => {
    expect(await go('agent requests')).toMatchObject({ type: 'unknown' });
    expect(await go('invoices')).toMatchObject({ type: 'navigate', href: '/invoices' });
  });

  it('opens Agent requests once an agent exists (a paused one counts), and not after it is removed', async () => {
    const [a] = await t.db
      .insert(agents)
      .values({ companyId: t.ctx.companyId, name: 'Helper', roleKeys: ['accountant'], tokenHash: 'f'.repeat(64), tokenPrefix: 'ibk_test_cmd' })
      .returning();
    expect(await go('agent requests')).toMatchObject({ type: 'navigate', href: '/agent-requests' });
    expect(await go('invoices')).toMatchObject({ type: 'navigate', href: '/invoices' });
    // Paused, it still counts: its requests can still be waiting.
    await t.db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, a.id));
    expect(await go('agent requests')).toMatchObject({ type: 'navigate', href: '/agent-requests' });
    await t.db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, a.id));
    expect(await go('agent requests')).toMatchObject({ type: 'unknown' });
  });
});
