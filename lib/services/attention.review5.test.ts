/**
 * Review round 5 — "Needs attention" payment reminders (failed before the fix): a member whose role
 * may print / email customer forms but changes nothing in the books (Customers: view + print — the
 * right POST /api/attention/invoice-reminder asks for) got "view-only members can't make changes"
 * AFTER the reminder email had already gone out: the audit row was refused for the view-only
 * legacy role, so the inbox never showed "you last sent a reminder" and a retry emailed the
 * customer again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '@/lib/db/schema';
import { normalizeGrant, type EffectiveAccess } from '@/lib/permissions/model';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

const sent: Array<{ to: string; subject: string }> = [];
vi.mock('./email', async (orig) => {
  const real = await orig<typeof import('./email')>();
  return {
    ...real,
    isConfigured: () => true,
    sendMail: async (opts: { to: string; subject: string }) => {
      sent.push({ to: opts.to, subject: opts.subject });
    },
  };
});

const { sendPaymentReminder } = await import('./attention');

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  t = await makeTestCompany('r5-attention');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('payment reminder by a print-only member', () => {
  it('is sent once and recorded', async () => {
    const cust = await createCustomer(t.ctx, { displayName: 'R5 Slow Payer', email: 'ap@slow.test' });
    const inv = await createInvoice(t.ctx, {
      customerId: cust.id,
      date: day('2026-01-05'),
      dueDate: day('2026-02-04'),
      lines: [{ description: 'Work', quantity: '1', rate: '120.00' }],
    });
    const access: EffectiveAccess = {
      roleKeys: ['custom'],
      permissions: normalizeGrant({ customers: ['view', 'print'] }),
      flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
      isAdmin: false,
    };
    const printOnly = { ...t.ctx, role: 'viewer' as const, access };
    await expect(sendPaymentReminder(printOnly, inv.id)).resolves.toMatchObject({ ok: true, to: 'ap@slow.test' });
    expect(sent).toHaveLength(1);
    const audit = await t.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, t.ctx.companyId), eq(auditLogs.entityType, 'payment_reminder'), eq(auditLogs.entityId, inv.id)));
    expect(audit).toHaveLength(1);

    // A member without the print right is refused before anything is sent.
    const viewOnly = { ...printOnly, access: { ...access, permissions: normalizeGrant({ customers: ['view'] }) } };
    await expect(sendPaymentReminder(viewOnly, inv.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sent).toHaveLength(1);
  });
});
