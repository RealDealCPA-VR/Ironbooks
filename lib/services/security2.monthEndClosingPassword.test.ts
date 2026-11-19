/**
 * Security package G2 — month-end close and the closing-date password (security 2.1 follow-up).
 *
 * setClosingDate needs the current closing-date password from someone who is not an Admin to
 * replace or remove it. Month-end close offered "Set a new password" / "Remove the password" with
 * no way to give the current one, so an Accountant choosing either got an error and no way
 * forward. The checklist now says when it is needed (currentPasswordRequired), the close route
 * accepts `currentPassword` and passes it on; keeping the password needs nothing, and an Admin's
 * flow is unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import { setClosingDateSchema } from '@/lib/validation/company';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { CLOSING_CURRENT_PASSWORD_NEEDED, CLOSING_CURRENT_PASSWORD_WRONG, setClosingDate, verifyClosingDatePassword } from './company';
import { closeMonth, getMonthEndChecklist, updateMonthEndStep } from './monthEndClose';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as closePOST } from '@/app/api/month-end-close/close/route';

let t: TestCompany;
let owner: ServiceContext;
let admin: ServiceContext;
let accountant: ServiceContext;

const roleCtx = (key: string): ServiceContext => ({ ...owner, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)) });

/** Review whatever is still open so the period can be closed (an empty company: the error scan). */
async function ready(periodEnd: string) {
  let c = await getMonthEndChecklist(owner, periodEnd);
  for (const key of c.outstanding) {
    c = await updateMonthEndStep(owner, { periodEnd, stepKey: key, action: 'review', version: c.version });
  }
  expect(c.ready).toBe(true);
  return c;
}

function closeReq(body: unknown) {
  return closePOST(
    new NextRequest('http://localhost/api/month-end-close/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  t = await makeTestCompany('g2-monthend-pw');
  owner = t.ctx;
  admin = roleCtx('admin');
  accountant = roleCtx('accountant');
  // Books closed through January with a password, by the Admin.
  await setClosingDate(owner, { closingDate: '2026-01-31', password: 'lock123' });
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(() => {
  (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
});

describe('month-end close: replacing or removing the closing-date password', () => {
  it('the checklist says when the current password is needed (non-Admin, password set)', async () => {
    expect((await getMonthEndChecklist(accountant, '2026-02-28')).currentPasswordRequired).toBe(true);
    expect((await getMonthEndChecklist(admin, '2026-02-28')).currentPasswordRequired).toBe(false);
    expect((await getMonthEndChecklist(owner, '2026-02-28')).currentPasswordRequired).toBe(false);
  });

  it('the closing-date route schema keeps the current password (zod used to strip it)', () => {
    const parsed = setClosingDateSchema.safeParse({ closingDate: '2026-01-31', password: 'x', currentPassword: 'lock123' });
    expect(parsed.success && parsed.data.currentPassword).toBe('lock123');
    expect(setClosingDateSchema.safeParse({ closingDate: '2026-01-31' }).success).toBe(true);
    expect(setClosingDateSchema.safeParse({ closingDate: '2026-01-31', currentPassword: 5 }).success).toBe(false);
  });

  it('an Accountant setting a new password gives the current one through the route', async () => {
    const c = await ready('2026-02-28');
    // Without it: refused, nothing changes.
    await expect(closeMonth(accountant, { periodEnd: '2026-02-28', password: 'feb456', version: c.version })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: CLOSING_CURRENT_PASSWORD_NEEDED,
    });
    // A wrong one: refused.
    routeCtx = accountant;
    const wrong = await closeReq({ periodEnd: '2026-02-28', password: 'feb456', currentPassword: 'guess', version: c.version });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toBe(CLOSING_CURRENT_PASSWORD_WRONG);
    expect(await verifyClosingDatePassword(t.db, owner.companyId, 'lock123')).toBe(true);
    // The right one (the route used to refuse the field: 400): closed, new password in force.
    const res = await closeReq({ periodEnd: '2026-02-28', password: 'feb456', currentPassword: 'lock123', version: c.version });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closingDate: '2026-02-28', hasPassword: true });
    expect(await verifyClosingDatePassword(t.db, owner.companyId, 'feb456')).toBe(true);
    expect(await verifyClosingDatePassword(t.db, owner.companyId, 'lock123')).toBe(false);
  });

  it('keeping the password while closing a later month needs nothing (unchanged)', async () => {
    const c = await ready('2026-03-31');
    const res = await closeMonth(accountant, { periodEnd: '2026-03-31', version: c.version });
    expect(res).toMatchObject({ closingDate: '2026-03-31', hasPassword: true });
    expect(await verifyClosingDatePassword(t.db, owner.companyId, 'feb456')).toBe(true);
  });

  it('removing it takes the current one too', async () => {
    const c = await ready('2026-04-30');
    await expect(closeMonth(accountant, { periodEnd: '2026-04-30', password: null, version: c.version })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const res = await closeMonth(accountant, { periodEnd: '2026-04-30', password: null, currentPassword: 'feb456', version: c.version });
    expect(res).toMatchObject({ closingDate: '2026-04-30', hasPassword: false });
  });

  it("an Admin's close is unchanged: no current password asked", async () => {
    const c = await ready('2026-05-31');
    await closeMonth(admin, { periodEnd: '2026-05-31', password: 'may789', version: c.version });
    const c2 = await ready('2026-06-30');
    const res = await closeMonth(admin, { periodEnd: '2026-06-30', password: 'jun000', version: c2.version });
    expect(res).toMatchObject({ closingDate: '2026-06-30', hasPassword: true });
    expect(await verifyClosingDatePassword(t.db, owner.companyId, 'jun000')).toBe(true);
  });

  it('the close route still refuses anything else in the body', async () => {
    routeCtx = owner;
    const res = await closeReq({ periodEnd: '2026-07-31', surprise: true });
    expect(res.status).toBe(400);
  });
});
