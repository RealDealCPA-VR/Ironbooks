/**
 * Review round 5 — the AI assistant is no side door around report permissions (failed before the
 * fix): its route needs Reports — Financial, and every tool answered from it. A member allowed
 * only financial reports could ask "who owes us?" / "whom do we owe?" and get the A/R and A/P
 * aging by customer and vendor, which need Reports — Customers & Sales / Vendors & Purchases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { ask, runTool } from './aiAssistant';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

const accessWith = (grant: PermissionGrant): EffectiveAccess => ({
  roleKeys: ['custom'],
  permissions: normalizeGrant(grant),
  flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
  isAdmin: false,
});

beforeAll(async () => {
  t = await makeTestCompany('r5-assistant');
  const c = await createCustomer(t.ctx, { displayName: 'R5 Secret Customer' });
  await createInvoice(t.ctx, {
    customerId: c.id,
    date: new Date('2026-03-01T00:00:00Z'),
    lines: [{ description: 'Work', quantity: '1', rate: '700.00' }],
  });
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('assistant tools follow the report permissions', () => {
  it('aging needs the customer / vendor report rights', async () => {
    const finOnly = { ...t.ctx, access: accessWith({ reports_financial: ['view'] }) };
    await expect(runTool(finOnly, 'ar_aging', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runTool(finOnly, 'ap_aging', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Financial reports themselves still work.
    await expect(runTool(finOnly, 'profit_and_loss', {})).resolves.toBeTruthy();
    // The offline answer to "who owes us" does not leak the customer either.
    const reply = await ask(finOnly, [], 'Who owes us money?', { today: new Date('2026-06-01T12:00:00Z') });
    expect(reply.answer).not.toContain('R5 Secret Customer');

    const withSales = { ...t.ctx, access: accessWith({ reports_financial: ['view'], reports_sales: ['view'] }) };
    const ar = (await runTool(withSales, 'ar_aging', {})) as { customers: Array<{ name: string }> };
    expect(ar.customers.map((c) => c.name)).toContain('R5 Secret Customer');
  });
});
