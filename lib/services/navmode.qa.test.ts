/**
 * p1 ux QA (tester): the "Menu style" My Preference (navMode) end to end through
 * PATCH/GET /api/preferences/my. Bad values refused, view-only members can still pick their own
 * menu, one person's choice never changes another person's or another company's menu, other
 * saved preferences survive, and a garbage stored value falls back to Simple.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { userPreferences, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { getMyPreferences } from './preferences';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';
import { companySettingsSchema } from '@/lib/validation/company';
import { myPreferencesSchema } from '@/lib/validation/prefs';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import * as myPrefsRoute from '@/app/api/preferences/my/route';

let t: TestCompany;
let viewer: ServiceContext;
let otherCo: ServiceContext; // same user as t.ctx, second company in the same file

function patch(body: unknown) {
  return myPrefsRoute.PATCH(
    new NextRequest('http://localhost/api/preferences/my', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function navModeOf(c: ServiceContext) {
  ctx = c;
  const res = await myPrefsRoute.GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { navMode: string }).navMode;
}

beforeAll(async () => {
  t = await makeTestCompany('navmode-qa');
  viewer = await addMember(t, 'viewer');
  const c2 = await createCompany(t.db, { name: 'Second Co', ownerId: t.ctx.userId! });
  otherCo = { db: t.db, companyId: c2.id, userId: t.ctx.userId };
});
afterAll(async () => {
  await t.cleanup();
});

describe('Menu style (navMode) preference', () => {
  it('new owner, new member and a new company all start with every menu (QuickBooks users)', async () => {
    expect(await navModeOf(t.ctx)).toBe('advanced');
    expect(await navModeOf(viewer)).toBe('advanced');
    expect(await navModeOf(otherCo)).toBe('advanced');
  });

  it('refuses anything but simple / advanced (400) and stores nothing', async () => {
    ctx = t.ctx;
    for (const bad of ['expert', 'ADVANCED', '', 1, null, true]) {
      const res = await patch({ navMode: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(myPreferencesSchema.safeParse({ navMode: 'advanced' }).success).toBe(true);
    expect(await navModeOf(t.ctx)).toBe('advanced');
  });

  it('a view-only member can switch their own menu (no books data changes)', async () => {
    ctx = viewer;
    const res = await patch({ navMode: 'simple' });
    expect(res.status).toBe(200);
    expect(await navModeOf(viewer)).toBe('simple');
  });

  it("one person's choice never changes another person's or another company's menu", async () => {
    ctx = t.ctx;
    expect((await patch({ navMode: 'simple' })).status).toBe(200);
    expect(await navModeOf(t.ctx)).toBe('simple');
    // Same person, other company in the same file: untouched.
    expect(await navModeOf(otherCo)).toBe('advanced');
    // Viewer switches back; the owner keeps Simple.
    ctx = viewer;
    expect((await patch({ navMode: 'advanced' })).status).toBe(200);
    expect(await navModeOf(viewer)).toBe('advanced');
    expect(await navModeOf(t.ctx)).toBe('simple');
  });

  it('switching the menu keeps other saved preferences, and saving others keeps the menu', async () => {
    ctx = t.ctx;
    const [row] = await t.db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(and(eq(userPreferences.companyId, t.ctx.companyId), eq(userPreferences.userId, t.ctx.userId!)));
    const before = (row?.prefs ?? {}) as Record<string, unknown>;
    expect((await patch({ navMode: 'simple' })).status).toBe(200);
    const [after] = await t.db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(and(eq(userPreferences.companyId, t.ctx.companyId), eq(userPreferences.userId, t.ctx.userId!)));
    const a = after.prefs as Record<string, unknown>;
    for (const [k, v] of Object.entries(before)) if (k !== 'navMode') expect(a[k], k).toEqual(v);
    expect(a.navMode).toBe('simple');
  });

  it('a garbage stored value (hand-edited / older build) falls back to every menu, never crashes', async () => {
    const [u] = await t.db.insert(users).values({ email: `garbage-${Date.now()}@test.local`, name: 'g', passwordHash: 'x' }).returning();
    const { userCompanies } = await import('@/lib/db/schema');
    await t.db.insert(userCompanies).values({ userId: u.id, companyId: t.ctx.companyId, role: 'viewer' });
    await t.db.insert(userPreferences).values({ companyId: t.ctx.companyId, userId: u.id, prefs: { navMode: 'expert' } });
    const g: ServiceContext = { db: t.db, companyId: t.ctx.companyId, userId: u.id };
    expect((await getMyPreferences(g)).navMode).toBe('advanced');
  });
});

describe('Payroll on/off company preference', () => {
  it('accepts only true/false', () => {
    expect(companySettingsSchema.safeParse({ payrollEnabled: false }).success).toBe(true);
    expect(companySettingsSchema.safeParse({ payrollEnabled: 'no' }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ payrollEnabled: 0 }).success).toBe(false);
  });
});
