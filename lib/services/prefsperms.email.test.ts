/**
 * prefsperms (Send Forms set-up inside the app): the mail server is stored IN the company file
 * with its password sealed by the file's own vault secret, Test explains failures and obeys the
 * network policy, each user may send from their own address, and every form (invoice, sales
 * forms, statements, purchase orders, payment reminders) is emailed with its Preferences > Send
 * Forms template. Nothing leaves the machine: lib/services/emailSettings.ts `mailTransport.create`
 * is replaced by a recorder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-email');
process.env.BKA_DATA_DIR = TEST_DIR;
const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of SMTP_KEYS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, companyEmailSettings, fileSecrets, users } from '@/lib/db/schema';
import { builtinRole, unionRoles } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createVendor } from './vendors';
import { createPurchaseOrder } from './purchaseOrders';
import { updateMyPreferences } from './preferences';
import {
  getEmailSetup,
  getEmailStatus,
  mailTransport,
  removeEmailSetup,
  resolveMailConfig,
  saveEmailSetup,
  sendTestEmail,
} from './emailSettings';
import { emailInvoice, isConfigured, sendMail } from './email';
import { emailCustomerStatement, emailSalesForm } from './salesForms';
import { emailPurchaseOrder } from './purchaseOrderEmail';
import { sendPaymentReminder } from './attention';

interface Sent {
  options: Record<string, unknown>;
  message: Record<string, unknown>;
}
const sent: Sent[] = [];
let failWith: unknown = null;
const realCreate = mailTransport.create;

let db: DB;
let ctx: ServiceContext;
let ownerId: string;
let companyId: string;
const acct: Record<string, string> = {};

const SERVER = {
  host: '127.0.0.1',
  port: 2525,
  security: 'starttls' as const,
  username: 'billing@acme.test',
  password: 'S3cret-mail-pass!',
  fromName: 'Acme Billing',
  fromEmail: 'billing@acme.test',
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@acme.test', name: 'Olivia Owner', passwordHash: 'x' }).returning();
  ownerId = u.id;
  const company = await createCompany(db, { name: 'Acme Mail Co', ownerId });
  companyId = company.id;
  ctx = { db, companyId, userId: ownerId };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, companyId))) acct[a.code] = a.id;
  mailTransport.create = (options: Record<string, unknown>) =>
    ({
      sendMail: async (message: Record<string, unknown>) => {
        if (failWith) throw failWith;
        sent.push({ options, message });
        return { messageId: 'test' };
      },
    }) as never;
}, 180_000);

beforeEach(() => {
  sent.length = 0;
  failWith = null;
});

afterAll(async () => {
  mailTransport.create = realCreate;
  for (const k of SMTP_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows */
  }
});

describe('mail server stored in the company file', () => {
  it('nothing set up: not configured, and every send says how to set it up', async () => {
    expect(await isConfigured(ctx)).toBe(false);
    expect((await getEmailStatus(ctx)).source).toBe('none');
    await expect(sendMail({ to: 'a@b.test', subject: 's', text: 't' }, ctx)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/Preferences > Send Forms/),
    });
  });

  it('saves with the password sealed by the file secret; the API never returns it, nor the audit trail', async () => {
    const view = await saveEmailSetup(ctx, SERVER);
    expect(view).toMatchObject({ source: 'file', configured: true, host: '127.0.0.1', hasPassword: true, passwordReadable: true });
    expect(JSON.stringify(view)).not.toContain(SERVER.password);
    const [row] = await db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, companyId));
    expect(row.passwordEnc).toMatch(/^v2:/);
    expect(row.passwordEnc).not.toContain(SERVER.password);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'email_settings')));
    expect(audits.length).toBeGreaterThan(0);
    const auditText = JSON.stringify(audits);
    expect(auditText).not.toContain(SERVER.password);
    expect(auditText).not.toContain(row.passwordEnc!);
    expect(auditText).toContain('"password":"set"');

    const cfg = await resolveMailConfig(ctx);
    expect(cfg).toMatchObject({ source: 'file', host: '127.0.0.1', port: 2525, password: SERVER.password });
    expect(await isConfigured(ctx)).toBe(true);
  });

  it('saving again without a password keeps the saved one; null removes it', async () => {
    await saveEmailSetup(ctx, { ...SERVER, password: undefined, fromName: 'Acme Accounts' });
    expect((await resolveMailConfig(ctx))?.password).toBe(SERVER.password);
    const removed = await saveEmailSetup(ctx, { ...SERVER, password: null });
    expect(removed.hasPassword).toBe(false);
    expect((await resolveMailConfig(ctx))?.password).toBeNull();
    await saveEmailSetup(ctx, SERVER);
  });

  it('refuses a malformed server, port or address in plain words', async () => {
    await expect(saveEmailSetup(ctx, { ...SERVER, host: 'smtp://mail.acme.test' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveEmailSetup(ctx, { ...SERVER, port: 70000 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveEmailSetup(ctx, { ...SERVER, fromEmail: 'not-an-address' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveEmailSetup(ctx, { ...SERVER, bcc: 'ok@acme.test, nope' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('the file settings win over SMTP environment variables, which remain the fallback', async () => {
    Object.assign(process.env, { SMTP_HOST: '10.0.0.9', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Server <srv@acme.test>' });
    try {
      expect((await resolveMailConfig(ctx))?.source).toBe('file');
      const backup = await db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, companyId));
      await removeEmailSetup(ctx);
      const env = await resolveMailConfig(ctx);
      expect(env).toMatchObject({ source: 'environment', host: '10.0.0.9', fromName: 'Server', fromEmail: 'srv@acme.test' });
      await db.insert(companyEmailSettings).values(backup[0]);
    } finally {
      for (const k of SMTP_KEYS) delete process.env[k];
    }
  });
});

describe('Test button', () => {
  it('sends through the saved settings and remembers the result', async () => {
    const r = await sendTestEmail(ctx, { to: 'me@acme.test' });
    expect(r).toMatchObject({ ok: true, to: 'me@acme.test', from: 'billing@acme.test' });
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toMatchObject({ host: '127.0.0.1', port: 2525, secure: false, requireTLS: true, auth: { user: 'billing@acme.test', pass: SERVER.password } });
    const view = await getEmailSetup(ctx);
    expect(view.lastTest).toMatchObject({ ok: true });
  });

  it('tests typed, unsaved settings with the saved password (same server), without saving them', async () => {
    const r = await sendTestEmail(ctx, { to: 'me@acme.test', draft: { ...SERVER, fromName: 'Acme Draft', password: undefined } });
    expect(r.ok).toBe(true);
    expect(sent[0].options).toMatchObject({ port: 2525, auth: { pass: SERVER.password } });
    expect((await getEmailSetup(ctx)).fromName).toBe('Acme Billing');
    // A changed port / security is tested with the password typed again.
    const typed = await sendTestEmail(ctx, { to: 'me@acme.test', draft: { ...SERVER, port: 465, security: 'ssl' } });
    expect(typed.ok).toBe(true);
    expect(sent[1].options).toMatchObject({ port: 465, secure: true, auth: { pass: SERVER.password } });
    expect((await getEmailSetup(ctx)).port).toBe(2525);
  });

  it('never sends the saved password to a different server, port, security or user name (review P1)', async () => {
    const changes: Array<Partial<typeof SERVER>> = [
      { host: '10.0.0.66', port: 25, security: 'none' as never },
      { host: '10.0.0.66' },
      { port: 2526 },
      { security: 'none' as never },
      { username: 'attacker@evil.test' },
    ];
    for (const change of changes) {
      const draft = { ...SERVER, ...change, password: undefined };
      await expect(sendTestEmail(ctx, { to: 'me@acme.test', draft })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/password again/),
      });
    }
    expect(sent).toHaveLength(0);
    // A relay that needs no sign-in (no user name) is tested without any password.
    const relay = await sendTestEmail(ctx, { to: 'me@acme.test', draft: { ...SERVER, host: '10.0.0.66', username: '', password: undefined } });
    expect(relay.ok).toBe(true);
    expect(sent[0].options.auth).toBeUndefined();
    expect(JSON.stringify(sent[0])).not.toContain(SERVER.password);
  });

  it('saving a different server, port, security or user name needs the password typed again (review P1)', async () => {
    const before = await db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, companyId));
    for (const change of [{ host: '10.0.0.66' }, { port: 25 }, { security: 'none' as never }, { username: 'other@acme.test' }, { host: 'localhost' }]) {
      await expect(saveEmailSetup(ctx, { ...SERVER, ...change, password: undefined })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/password again/),
      });
    }
    const after = await db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, companyId));
    expect(after).toEqual(before);
    // The same server keeps the saved password.
    await saveEmailSetup(ctx, { ...SERVER, fromName: 'Acme Billing', password: undefined });
    expect((await resolveMailConfig(ctx))?.password).toBe(SERVER.password);
    // Typed again: saved for the new server.
    await saveEmailSetup(ctx, { ...SERVER, port: 2526, password: 'New-pass-1' });
    expect((await resolveMailConfig(ctx))).toMatchObject({ port: 2526, password: 'New-pass-1' });
    // No sign-in at all: the old password is dropped, not carried to the new server.
    const relay = await saveEmailSetup(ctx, { ...SERVER, host: '10.0.0.66', username: '', password: undefined });
    expect(relay.hasPassword).toBe(false);
    await saveEmailSetup(ctx, SERVER);
  });

  it('explains a refused password in plain words', async () => {
    failWith = Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
    const r = await sendTestEmail(ctx, { to: 'me@acme.test' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/refused the user name or password/);
    expect((await getEmailSetup(ctx)).lastTest).toMatchObject({ ok: false });
  });

  it('obeys the network policy: a public mail provider needs the email opt-in', async () => {
    const r = await sendTestEmail(ctx, { to: 'me@acme.test', draft: { ...SERVER, host: 'smtp.publicmail.example.com' } });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
    // ...and so does a real send.
    await saveEmailSetup(ctx, { ...SERVER, host: 'smtp.publicmail.example.com' });
    await expect(sendMail({ to: 'a@b.test', subject: 's', text: 't' }, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sent).toHaveLength(0);
    await saveEmailSetup(ctx, SERVER);
  });

  it('without the set-up right: no saving, no typed settings, and the test goes only to yourself', async () => {
    const [clerk] = await db.insert(users).values({ email: 'clerk@acme.test', name: 'Carl Clerk', passwordHash: 'x' }).returning();
    const clerkCtx: ServiceContext = { db, companyId, userId: clerk.id, access: unionRoles([builtinRole('ar_clerk')!]) };
    await expect(saveEmailSetup(clerkCtx, SERVER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getEmailSetup(clerkCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(sendTestEmail(clerkCtx, { to: 'anyone@else.test', draft: SERVER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = await sendTestEmail(clerkCtx, { to: 'anyone@else.test' });
    expect(r.ok).toBe(true);
    expect(r.to).toBe('clerk@acme.test');
    expect(sent[0].message.to).toBe('clerk@acme.test');
    // Their own "send from" address is free text, not verified: the test still goes only to the
    // address they sign in with (review P2).
    await updateMyPreferences(clerkCtx, { sendFromName: 'Carl', sendFromEmail: 'victim@else.test', bccMe: false });
    const r2 = await sendTestEmail(clerkCtx, { to: 'anyone@else.test' });
    expect(r2.to).toBe('clerk@acme.test');
    expect(sent[1].message.to).toBe('clerk@acme.test');
    await updateMyPreferences(clerkCtx, { sendFromName: '', sendFromEmail: '', bccMe: false });
    // Status is fine for any member and says nothing secret.
    const status = await getEmailStatus(clerkCtx);
    expect(status).toEqual({ configured: true, source: 'file', fromEmail: 'billing@acme.test', useSenderAddress: true });
  });
});

describe('per-user "send from" and Bcc (My Preferences > Send Forms)', () => {
  it("uses the company's sender, with replies to the user who set an address", async () => {
    await saveEmailSetup(ctx, { ...SERVER, useSenderAddress: false, replyTo: 'office@acme.test' });
    await updateMyPreferences(ctx, { sendFromName: 'Olivia O.', sendFromEmail: 'olivia@acme.test', bccMe: true });
    await sendMail({ to: 'customer@x.test', subject: 'Hi', text: 'Body' }, ctx);
    expect(sent[0].message).toMatchObject({
      from: { name: 'Acme Billing', address: 'billing@acme.test' },
      replyTo: 'olivia@acme.test',
      bcc: ['olivia@acme.test'],
    });
  });

  it("sends from the user's own address when the company allows it", async () => {
    await saveEmailSetup(ctx, { ...SERVER, useSenderAddress: true, bcc: 'books@acme.test' });
    await sendMail({ to: 'customer@x.test', subject: 'Hi', text: 'Body' }, ctx);
    expect(sent[0].message.from).toEqual({ name: 'Olivia O.', address: 'olivia@acme.test' });
    expect(sent[0].message.replyTo).toBeUndefined();
    expect(sent[0].message.bcc).toEqual(['books@acme.test', 'olivia@acme.test']);
    await updateMyPreferences(ctx, { sendFromName: '', sendFromEmail: '', bccMe: false });
    await saveEmailSetup(ctx, SERVER);
  });
});

describe('every form uses its Send Forms template', () => {
  let customerId: string;
  beforeAll(async () => {
    const c = await createCustomer(ctx, { displayName: 'Globex LLC', email: 'ap@globex.test' } as never);
    customerId = c.id;
    await updateCompany(ctx, {
      settings: {
        sendForms: {
          invoice: { subject: 'Bill {{number}} for {{customer.name}}', body: 'Total {{total}}, due {{dueDate}}. From {{sender.name}} <{{sender.email}}>' },
          estimate: { subject: 'Quote {{number}} ({{total}})', body: 'Quote for {{customer.name}} dated {{date}}' },
          statement: { subject: 'Your statement: {{balance}}', body: 'Hello {{customer.name}}' },
          purchase_order: { subject: 'PO {{number}} to {{vendor.name}}', body: 'Total {{total}} from {{company.name}}' },
          payment_reminder: { subject: 'Overdue: {{number}}', body: '{{customer.name}}: {{balance}} {{overdue}} ({{daysOverdue}} days)' },
        },
      },
    } as never);
  });

  it('invoice (Invoices > Email)', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-03-02T00:00:00.000Z'),
      dueDate: new Date('2026-04-01T00:00:00.000Z'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '1250.00' }],
    } as never);
    await emailInvoice(ctx, inv.id);
    expect(sent[0].message.subject).toMatch(/^Bill .+ for Globex LLC$/);
    expect(sent[0].message.text).toBe('Total $1,250.00, due 2026-04-01. From Acme Billing <billing@acme.test>');
    expect(sent[0].message.to).toBe('ap@globex.test');

    // The sales-form path (Send Forms queue) uses the same template.
    await emailSalesForm(ctx, 'invoice', inv.id);
    expect(sent[1].message.subject).toBe(sent[0].message.subject);
    expect(sent[1].message.text).toBe(sent[0].message.text);
  });

  it('statement', async () => {
    await emailCustomerStatement(ctx, customerId);
    expect(sent[0].message.subject).toMatch(/^Your statement: \$/);
    expect(sent[0].message.text).toBe('Hello Globex LLC');
  });

  it('purchase order (emailed to the vendor)', async () => {
    const v = await createVendor(ctx, { displayName: 'Initech Supply', email: 'orders@initech.test' } as never);
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: new Date('2026-03-05T00:00:00.000Z'),
      lines: [{ accountId: acct['5000'], quantity: '2', rate: '40.00' }],
    } as never);
    const r = await emailPurchaseOrder(ctx, po.id);
    expect(r.to).toBe('orders@initech.test');
    expect(sent[0].message.subject).toMatch(/^PO .+ to Initech Supply$/);
    expect(sent[0].message.text).toBe('Total $80.00 from Acme Mail Co');
    const att = (sent[0].message.attachments as Array<{ content: Buffer }>)[0];
    expect(att.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('overdue invoice reminder', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-01-02T00:00:00.000Z'),
      dueDate: new Date('2026-01-10T00:00:00.000Z'),
      lines: [{ accountId: acct['4000'], description: 'Old work', quantity: 1, rate: '300.00' }],
    } as never);
    await sendPaymentReminder(ctx, inv.id);
    expect(sent[0].message.subject).toMatch(/^Overdue: /);
    expect(sent[0].message.text).toMatch(/^Globex LLC: \$300\.00 was due on Jan 10, 2026 \(\d+ days ago\) \(\d+ days\)$/);
  });
});

describe("a copy of the file without its secret (Accountant's Copy)", () => {
  it('says the password must be typed again instead of sending without it', async () => {
    await db.delete(fileSecrets);
    const view = await getEmailSetup(ctx);
    expect(view).toMatchObject({ hasPassword: true, passwordReadable: false, configured: false });
    expect(await isConfigured(ctx)).toBe(false);
    await expect(resolveMailConfig(ctx)).rejects.toMatchObject({ message: expect.stringMatching(/Enter it again/) });
  });
});
