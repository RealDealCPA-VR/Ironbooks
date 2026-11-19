/**
 * Security plan 3.5 — mail Connection security "None".
 *
 * "None" (no encryption) was accepted for any mail server, so a mailbox password could cross the
 * internet in plain text. It is now only for a server on this computer or your own network (LAN,
 * tailnet — lib/net/cidr.ts; a name counts when every address it resolves to is private) when the
 * server signs in. Saving it for another server is refused. A set-up saved before this rule is not
 * silently broken: sends and tests refuse with a plain message saying to switch to STARTTLS or
 * SSL/TLS, and the Send Forms page shows it (insecureConnection).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-mail-none');
process.env.BKA_DATA_DIR = TEST_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { companyEmailSettings, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { allowCloudPurpose } from './networkPolicy';
import { getEmailSetup, mailDns, mailServerIsLocal, mailTransport, saveEmailSetup, sendTestEmail } from './emailSettings';
import { sendMail } from './email';

let db: DB;
let ctx: ServiceContext;
let companyId: string;
const sent: Array<Record<string, unknown>> = [];
const realCreate = mailTransport.create;
const realLookup = mailDns.lookup;
/** What the name lookups answer in this test (nothing leaves the machine). */
const DNS: Record<string, string[]> = {
  'smtp.publicmail.example.com': ['93.184.216.34'],
  'relay.office.local': ['192.168.1.20'],
  'split.example.com': ['192.168.1.20', '93.184.216.34'],
  'tail-relay.tail1234.ts.net': ['100.101.102.103'],
};

const BASE = { port: 25, username: 'billing@acme.test', password: 'Plain-Text-Risk-1', fromEmail: 'billing@acme.test' };

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner-none@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  companyId = (await createCompany(db, { name: 'Mail None Co', ownerId: u.id })).id;
  ctx = { db, companyId, userId: u.id };
  // A public mail server is allowed by the network policy here, so only the "None" rule decides.
  expect((await allowCloudPurpose(ctx, 'email')).notice).toBeNull();
  mailTransport.create = (options: Record<string, unknown>) =>
    ({
      sendMail: async () => {
        sent.push(options);
        return { messageId: 'test' };
      },
    }) as never;
  mailDns.lookup = async (host: string) => {
    const hit = DNS[host];
    if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return hit;
  };
}, 120_000);

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  mailTransport.create = realCreate;
  mailDns.lookup = realLookup;
  await closeDb(TEST_DIR).catch(() => undefined);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('where "None" is allowed', () => {
  it('this computer, the office network and the tailnet; a name only when it resolves there', async () => {
    for (const h of ['127.0.0.1', 'localhost', '10.0.0.66', '192.168.1.5', '[::1]', 'fd12:3456::1', '100.101.102.103', 'relay.office.local', 'tail-relay.tail1234.ts.net']) {
      expect(await mailServerIsLocal(h), h).toBe(true);
    }
    for (const h of ['93.184.216.34', '8.8.8.8', '2001:4860:4860::8888', 'smtp.publicmail.example.com', 'split.example.com', 'unknown-host.example.com', '169.254.169.254', '0.0.0.0']) {
      expect(await mailServerIsLocal(h), h).toBe(false);
    }
  });
});

describe('saving', () => {
  it('refuses None for a server outside your network that signs in, and says what to choose', async () => {
    await expect(saveEmailSetup(ctx, { ...BASE, host: 'smtp.publicmail.example.com', security: 'none' })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/STARTTLS or SSL\/TLS/),
    });
    await expect(saveEmailSetup(ctx, { ...BASE, host: '93.184.216.34', security: 'none' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(companyEmailSettings)).toEqual([]);
  });

  it('keeps every honest set-up: None on the office network, encryption anywhere, a relay without sign-in', async () => {
    expect((await saveEmailSetup(ctx, { ...BASE, host: 'relay.office.local', security: 'none' })).insecureConnection).toBe(false);
    expect((await saveEmailSetup(ctx, { ...BASE, host: '10.0.0.66', security: 'none' })).insecureConnection).toBe(false);
    expect((await saveEmailSetup(ctx, { ...BASE, host: 'smtp.publicmail.example.com', port: 587, security: 'starttls' })).insecureConnection).toBe(false);
    // No user name: no password is ever sent (an internet provider's relay that knows its customers).
    const relay = await saveEmailSetup(ctx, { ...BASE, host: 'smtp.publicmail.example.com', security: 'none', username: '', password: null });
    expect(relay.insecureConnection).toBe(false);
    await sendTestEmail(ctx, { to: 'me@acme.test' });
    expect(sent).toHaveLength(1);
  });
});

describe('a set-up saved before this rule (None to an internet server, with a password)', () => {
  beforeAll(async () => {
    // Saved properly first (STARTTLS), then switched to None the way an older version allowed.
    await saveEmailSetup(ctx, { ...BASE, host: 'smtp.publicmail.example.com', port: 587, security: 'starttls' });
    await db.update(companyEmailSettings).set({ security: 'none', port: 25 }).where(eq(companyEmailSettings.companyId, companyId));
  });

  it('the Send Forms page says so', async () => {
    expect(await getEmailSetup(ctx)).toMatchObject({ insecureConnection: true, configured: true, security: 'none' });
  });

  it('a test is refused with a plain message, and nothing is sent', async () => {
    const r = await sendTestEmail(ctx, { to: 'me@acme.test' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Connection security "None".*STARTTLS or SSL\/TLS/);
    expect(sent).toHaveLength(0);
    expect((await getEmailSetup(ctx)).lastTest).toMatchObject({ ok: false });
  });

  it('a real send is refused the same way, and nothing is sent', async () => {
    await expect(sendMail({ to: 'customer@b.test', subject: 's', text: 't' }, ctx)).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { insecureConnection: true },
    });
    expect(sent).toHaveLength(0);
  });

  it('switching to STARTTLS (password typed again) fixes it', async () => {
    const v = await saveEmailSetup(ctx, { ...BASE, host: 'smtp.publicmail.example.com', port: 587, security: 'starttls' });
    expect(v.insecureConnection).toBe(false);
    await sendMail({ to: 'customer@b.test', subject: 's', text: 't' }, ctx);
    expect(sent).toHaveLength(1);
  });
});
