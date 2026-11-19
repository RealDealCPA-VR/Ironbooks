/**
 * Security plan 1.5, row 3 — a company file from another computer is not trusted with the internet.
 *
 * Network mode, cloud opt-ins, AI servers, the mail server and report schedules travel inside the
 * company file. A crafted file could arrive with cloud access on, an AI "provider" and a mail relay
 * of the sender's, and a schedule emailing reports out. Now a company file this computer has not
 * approved (lib/net/fileTrust.ts: a stamp only this computer's device secret can make) is held to
 * the local network and tailnet until an Admin at this computer allows it; files this computer
 * already knew, brand-new files made here and quiet files saved by a local Admin are approved
 * without anyone noticing. Without a device secret nothing changes.
 *
 * Two "computers" are simulated by switching BKA_DEVICE_VAULT; every re-open is a new launch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-file-trust');
const RECEIVED = path.join(ROOT, 'received');
const KNOWN = path.join(ROOT, 'known-before');
const QUIET = path.join(ROOT, 'quiet');
const NEW_FILE = path.join(ROOT, 'brand-new');
const RESTORE_TARGET = path.join(ROOT, 'restore-target');
const CRAFTED = path.join(ROOT, 'crafted-new');
const OUT = path.join(ROOT, 'exports');

const holder = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context')>()),
  getServerContext: vi.fn(async () => holder.ctx),
}));

import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, auditLogs, companies, fileSecrets, reportSchedules, users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { fullAccess } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { setNetworkPolicy } from '@/lib/services/networkPolicy';
import { updateSettings } from '@/lib/services/aiSettings';
import { assertMailServerAllowed, mailTransport, saveEmailSetup } from '@/lib/services/emailSettings';
import { SCHEDULE_HELD_MESSAGE, createReportSchedule, runDueSchedules, saveMemorizedReport } from '@/lib/services/memorizedReports';
import { DEVICE_VAULT_ENV, deviceKeyId } from '@/lib/ai/keyVault';
import { DEFAULT_ANTHROPIC_BASE_URL } from '@/lib/ai/providers';
import { GET as policyGET, PATCH as policyPATCH, PUT as policyPUT } from '@/app/api/network-policy/route';
import { GET as checkGET } from '@/app/api/network-policy/check/route';
import { assertOutboundAllowed, checkOutbound } from './guard';
import { HELD_FOR_THIS_COMPUTER, decideOutbound, normalizePolicy } from './policy';
import {
  APPROVAL_ROW,
  KNOWN_HERE_ENV,
  MAX_APPROVALS,
  approveFileHere,
  fileApprovedHere,
  forgetOpenedFoldersForTests,
  holdStatus,
  recordApproves,
  stampFor,
} from './fileTrust';

const PC_A = 'a1'.repeat(32);
const PC_B = 'b2'.repeat(32);
const A = { secret: PC_A, keyId: deviceKeyId(PC_A) };
const B = { secret: PC_B, keyId: deviceKeyId(PC_B) };
const DUE = new Date(2026, 1, 1, 9, 0, 0);
const SLOW = 180_000;

const sent: Array<{ options: Record<string, unknown>; message: Record<string, unknown> }> = [];
const realCreate = mailTransport.create;

function onComputer(secret: string | null) {
  if (secret) process.env[DEVICE_VAULT_ENV] = secret;
  else delete process.env[DEVICE_VAULT_ENV];
}

/** Open a company file on a computer, as a new launch of its own server does. */
async function openOn(secret: string | null, dir: string, opts: { knownHere?: string | null; own?: boolean } = {}): Promise<DB> {
  await closeDb(dir);
  forgetOpenedFoldersForTests();
  onComputer(secret);
  if (opts.own !== false) process.env.BKA_DATA_DIR = dir;
  if (opts.knownHere) process.env[KNOWN_HERE_ENV] = opts.knownHere;
  else delete process.env[KNOWN_HERE_ENV];
  return getDb(dir);
}

const ownerCtx = (db: DB, companyId: string, userId: string, role: ServiceContext['role'] = 'owner'): ServiceContext => ({
  db,
  companyId,
  userId,
  access: fullAccess(),
  role,
});

interface Made {
  companyId: string;
  userId: string;
}

/** A company file made on computer B with every internet service of the sender's switched on. */
async function hostileFileFromB(dir: string, name: string): Promise<Made> {
  const db = await openOn(PC_B, dir);
  const [u] = await db.insert(users).values({ email: `${name.toLowerCase().replace(/\W/g, '')}@sender.test`, name: 'Sender', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: u.id });
  const ctx = ownerCtx(db, company.id, u.id);
  await setNetworkPolicy(ctx, {
    mode: 'allow-cloud',
    cloudOptIn: { ai: true, email: true, 'vendor-lookup': true },
    vendorLookupUrl: 'https://searx.evil.example',
  });
  await updateSettings(ctx, {
    providers: [{ kind: 'openai-compatible', label: 'Helper', baseUrl: 'https://llm.evil.example/v1', model: 'm1', enabled: true, apiKey: 'sk-any-key' }],
    cloudEnabled: true,
  });
  await saveEmailSetup(ctx, { host: 'smtp.evil.example', port: 587, security: 'starttls', fromEmail: 'books@acme.test' });
  const rep = await saveMemorizedReport(ctx, { name: 'P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31' } } });
  await createReportSchedule(ctx, {
    name: 'Monthly to sender',
    memorizedReportId: rep.id,
    frequency: 'monthly',
    startDate: '2026-02-01',
    format: 'csv',
    emailTo: 'drop@evil.example',
  });
  await closeDb(dir);
  return { companyId: company.id, userId: u.id };
}

type Who = 'host' | 'teammate';
function request(who: Who, method: string, body?: unknown, route = '/api/network-policy'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'teammate') {
    headers['x-bka-remote-addr'] = '100.64.0.9';
    headers['sec-bka-proxy'] = '1';
  } else headers['x-bka-launch'] = 'pass-of-this-launch';
  return new NextRequest(`http://127.0.0.1:3123${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function approvalRow(db: DB): Promise<string | null> {
  const [row] = await db.select().from(fileSecrets).where(eq(fileSecrets.name, APPROVAL_ROW));
  return row?.secret ?? null;
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const k of ['BKA_NETWORK_MODE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', KNOWN_HERE_ENV]) delete process.env[k];
  process.env.BKA_LAUNCH_PASS = 'pass-of-this-launch';
  mailTransport.create = (options: Record<string, unknown>) =>
    ({
      sendMail: async (message: Record<string, unknown>) => {
        sent.push({ options, message });
        return { messageId: 'test' };
      },
    }) as never;
});

afterAll(async () => {
  mailTransport.create = realCreate;
  for (const dir of [RECEIVED, KNOWN, QUIET, NEW_FILE, RESTORE_TARGET, CRAFTED]) await closeDb(dir).catch(() => undefined);
  onComputer(null);
  delete process.env[KNOWN_HERE_ENV];
  delete process.env.BKA_LAUNCH_PASS;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the cap for a file this computer has not approved (lib/net/policy.ts)', () => {
  const hostile = normalizePolicy({ mode: 'allow-cloud', cloudOptIn: { ai: true, email: true, 'vendor-lookup': true } });

  it('refuses the public internet with a plain reason, and keeps this computer, the LAN and the tailnet', () => {
    const held = decideOutbound(hostile, 'https://llm.evil.example/v1', 'ai', undefined, { heldHere: true });
    expect(held.allowed).toBe(false);
    expect(held.reason).toContain(HELD_FOR_THIS_COMPUTER);
    expect(held.reason).toMatch(/AI assistance would contact llm\.evil\.example on the internet\. This company file came from another computer/);
    expect(held.mode).toBe('tailnet-only');
    // Before: its own settings let it out.
    expect(decideOutbound(hostile, 'https://llm.evil.example/v1', 'ai', undefined).allowed).toBe(true);
    expect(decideOutbound(hostile, 'smtps://smtp.evil.example:465', 'email', undefined, { heldHere: true }).allowed).toBe(false);
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://192.168.1.20:11434', 'http://10.0.0.5:8080', 'http://100.101.102.103:11434']) {
      expect(decideOutbound(hostile, url, 'ai', undefined, { heldHere: true }).allowed, url).toBe(true);
    }
    expect(decideOutbound(hostile, 'smtp://192.168.1.5:25', 'email', undefined, { heldHere: true }).allowed).toBe(true);
  });

  it('vendor lookup is held even on the LAN (SearXNG passes the names on to public search engines)', () => {
    const d = decideOutbound(hostile, 'http://192.168.1.30:8080/search', 'vendor-lookup', undefined, { heldHere: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain(HELD_FOR_THIS_COMPUTER);
  });

  it('update checks keep their own rules (they send no company data)', () => {
    for (const mode of ['tailnet-only', 'allow-cloud'] as const) {
      const p = normalizePolicy({ mode });
      expect(decideOutbound(p, 'https://github.com/', 'updates', undefined, { heldHere: true }).allowed, mode).toBe(true);
    }
    const off = normalizePolicy({ mode: 'tailnet-only', cloudOptIn: { updates: false } });
    expect(decideOutbound(off, 'https://github.com/', 'updates', undefined, { heldHere: true }).allowed).toBe(false);
    // A machine ceiling below allow-cloud still blocks them, as before.
    expect(decideOutbound(normalizePolicy({ mode: 'allow-cloud' }), 'https://github.com/', 'updates', 'tailnet-only', { heldHere: true }).allowed).toBe(false);
  });

  it('Offline still wins, and a call the file refuses anyway keeps its own reason', () => {
    const offline = normalizePolicy({ mode: 'offline', cloudOptIn: { ai: true } });
    for (const url of ['https://llm.evil.example/v1', 'http://192.168.1.20:11434']) {
      const d = decideOutbound(offline, url, 'ai', undefined, { heldHere: true });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/Offline mode/);
      expect(d.mode).toBe('offline');
    }
    const local = decideOutbound(normalizePolicy({ mode: 'tailnet-only' }), 'https://api.anthropic.com', 'ai', undefined, { heldHere: true });
    expect(local.allowed).toBe(false);
    expect(local.reason).toMatch(/local network \+ tailnet only/);
  });
});

// ---------------------------------------------------------------------------

describe('a company file made on another computer, opened here', () => {
  let made: Made;
  let db: DB;
  let ctx: ServiceContext;

  beforeAll(async () => {
    made = await hostileFileFromB(RECEIVED, 'Received Co');
    db = await openOn(PC_A, RECEIVED);
    ctx = ownerCtx(db, made.companyId, made.userId);
    holder.ctx = ctx;
  }, SLOW);

  beforeEach(() => {
    sent.length = 0;
    onComputer(PC_A);
    holder.ctx = ctx;
  });

  it('is not approved here: it carries only the other computer’s stamp', async () => {
    expect(await fileApprovedHere(db)).toBe(false);
    const raw = await approvalRow(db);
    expect(raw).toBeTruthy();
    expect(recordApproves(raw, B)).toBe(true);
    expect(recordApproves(raw, A)).toBe(false);
  });

  it('a stamp made with another device secret, or for another file, is not valid', async () => {
    const id = (JSON.parse((await approvalRow(db))!) as { id: string }).id;
    // A's key id with a stamp made by B's secret.
    expect(recordApproves(JSON.stringify({ v: 1, id, stamps: [[A.keyId, stampFor(PC_B, id)]] }), A)).toBe(false);
    // A's real stamp of ANOTHER file id.
    expect(recordApproves(JSON.stringify({ v: 1, id, stamps: [[A.keyId, stampFor(PC_A, 'some-other-file-id')]] }), A)).toBe(false);
    // Junk is ignored.
    for (const junk of ['', 'null', '{"v":2}', '{"v":1,"id":"x","stamps":[]}', 'not json']) expect(recordApproves(junk, A)).toBe(false);
    expect(recordApproves(JSON.stringify({ v: 1, id, stamps: [[A.keyId, stampFor(PC_A, id)]] }), A)).toBe(true);
  });

  it('no device secret: no cap at all, exactly as before', async () => {
    onComputer(null);
    expect(await fileApprovedHere(db)).toBe(true);
    expect((await assertOutboundAllowed('https://llm.evil.example/v1', 'ai', ctx)).allowed).toBe(true);
    expect((await holdStatus(db)).heldForThisComputer).toBe(false);
    expect(await approveFileHere(db)).toBe(false);
    onComputer(PC_A);
    expect(await fileApprovedHere(db)).toBe(false);
  });

  it('its AI server on the internet is refused with the reason; this computer, the LAN and the tailnet are not', async () => {
    await expect(assertOutboundAllowed('https://llm.evil.example/v1/chat/completions', 'ai', ctx)).rejects.toThrow(/came from another computer/);
    for (const url of ['http://127.0.0.1:11434/api/tags', 'http://192.168.1.20:11434/api/tags', 'http://100.101.102.103:11434/api/tags']) {
      expect((await checkOutbound(url, 'ai', ctx)).allowed, url).toBe(true);
    }
  });

  it('mail to its public server is refused; a relay on the private network is allowed', async () => {
    await expect(assertMailServerAllowed(ctx, { host: 'smtp.evil.example', port: 587, security: 'starttls', username: null })).rejects.toThrow(
      /came from another computer/,
    );
    await expect(assertMailServerAllowed(ctx, { host: '192.168.1.5', port: 25, security: 'starttls', username: null })).resolves.toBeUndefined();
  });

  it('the shell’s check route holds the same, but not update checks', async () => {
    const ask = async (purpose: string, url: string) =>
      (await (await checkGET(request('host', 'GET', undefined, `/api/network-policy/check?purpose=${purpose}&url=${encodeURIComponent(url)}`))).json()) as {
        allowed: boolean;
        reason: string;
      };
    expect((await ask('ai', 'https://llm.evil.example/v1')).allowed).toBe(false);
    expect((await ask('updates', 'https://github.com/x/releases')).allowed).toBe(true);
  });

  it('the note: what would reach the internet, hosts only', async () => {
    const s = await holdStatus(db);
    expect(s.heldForThisComputer).toBe(true);
    expect(s.heldServices.map((x) => x.purpose)).toEqual(['ai', 'email', 'vendor-lookup', 'scheduled-reports']);
    expect(s.heldServices.find((x) => x.purpose === 'ai')?.hosts).toEqual(['llm.evil.example']);
    expect(s.heldServices.find((x) => x.purpose === 'email')?.hosts).toEqual(['smtp.evil.example']);
    expect(s.heldServices.find((x) => x.purpose === 'vendor-lookup')?.hosts).toEqual(['searx.evil.example']);
    expect(s.heldServices.find((x) => x.purpose === 'scheduled-reports')?.hosts).toEqual(['evil.example']);
    expect(s.heldHosts).toEqual(['evil.example', 'llm.evil.example', 'searx.evil.example', 'smtp.evil.example']);

    const view = await (await policyGET(request('host', 'GET'))).json();
    expect(view.heldForThisComputer).toBe(true);
    expect(view.heldHosts).toEqual(s.heldHosts);
    expect(view.canAllowHere).toBe(true);
    expect(view.effectiveMode).toBe('tailnet-only');
    expect(view.purposes.find((p: { purpose: string }) => p.purpose === 'ai').cloud.allowed).toBe(false);
    expect(view.purposes.find((p: { purpose: string }) => p.purpose === 'updates').cloud.allowed).toBe(true);
    // Another computer sees the note but is not offered the button.
    const remote = await (await policyGET(request('teammate', 'GET'))).json();
    expect(remote.heldForThisComputer).toBe(true);
    expect(remote.canAllowHere).toBe(false);
  });

  it('a scheduled report that emails is held, recorded once, stays due and sends nothing', async () => {
    const [before] = await db.select().from(reportSchedules).where(eq(reportSchedules.companyId, made.companyId));
    const [r] = await runDueSchedules(ctx, { now: DUE, outDir: OUT });
    expect(r.status).toBe('held');
    expect(r.message).toBe(SCHEDULE_HELD_MESSAGE);
    expect(r.message).toMatch(/^Held: internet services are off for this file on this computer/);
    expect(r.files).toEqual([]);
    const [after] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, before.id));
    expect(after.lastStatus).toBe('held');
    expect(after.lastMessage).toBe(SCHEDULE_HELD_MESSAGE);
    expect(after.nextRunAt.getTime()).toBe(before.nextRunAt.getTime());
    const audits = async () =>
      (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'report_schedule'), eq(auditLogs.entityId, before.id)))).length;
    const n = await audits();
    // The timer asks again (every 15 minutes): still held, nothing rewritten, nothing retried.
    const [again] = await runDueSchedules(ctx, { now: new Date(DUE.getTime() + 15 * 60_000), outDir: OUT });
    expect(again.status).toBe('held');
    expect(await audits()).toBe(n);
    expect(sent).toHaveLength(0);
  });

  it('saving network settings does not approve a file whose own settings reach the internet', async () => {
    const res = await policyPUT(request('host', 'PUT', { mode: 'allow-cloud', cloudOptIn: { ai: true, email: true, 'vendor-lookup': true }, vendorLookupUrl: 'https://searx.evil.example' }));
    expect(res.status).toBe(200);
    expect(await fileApprovedHere(db)).toBe(false);
  });

  it('a remote Admin, or a local user who is not an Admin, cannot allow it', async () => {
    const remote = await policyPUT(request('teammate', 'PUT', { allowOnThisComputer: true }));
    expect(remote.status).toBe(403);
    expect((await remote.json()).details).toEqual({ hostOnly: true });
    expect((await policyPATCH(request('teammate', 'PATCH', { allowOnThisComputer: true }))).status).toBe(403);
    holder.ctx = ownerCtx(db, made.companyId, made.userId, 'accountant');
    expect((await policyPUT(request('host', 'PUT', { allowOnThisComputer: true }))).status).toBe(403);
    holder.ctx = ctx;
    expect(await fileApprovedHere(db)).toBe(false);
  });

  it('an Admin at this computer allows it (audited): the stamp is added, the other computer’s kept', async () => {
    const res = await policyPUT(request('host', 'PUT', { allowOnThisComputer: true }));
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.heldForThisComputer).toBe(false);
    expect(view.canAllowHere).toBe(false);
    expect(await fileApprovedHere(db)).toBe(true);
    const raw = await approvalRow(db);
    expect(recordApproves(raw, A)).toBe(true);
    expect(recordApproves(raw, B)).toBe(true);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'network_policy'), eq(auditLogs.companyId, made.companyId)));
    const allowed = audit.find((a) => (a.newValues as { allowedOnThisComputer?: boolean } | null)?.allowedOnThisComputer === true);
    expect(allowed).toBeTruthy();
    expect(JSON.stringify(allowed!.newValues)).toContain('llm.evil.example');
    expect(JSON.stringify(allowed!.newValues)).not.toContain(PC_A);
  });

  it('after approval everything works as the file is set up, and the held schedule runs by itself', async () => {
    expect((await assertOutboundAllowed('https://llm.evil.example/v1', 'ai', ctx)).allowed).toBe(true);
    await expect(assertMailServerAllowed(ctx, { host: 'smtp.evil.example', port: 587, security: 'starttls', username: null })).resolves.toBeUndefined();
    const [r] = await runDueSchedules(ctx, { now: new Date(DUE.getTime() + 30 * 60_000), outDir: OUT });
    expect(r.status).toBe('ok');
    expect(r.files.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.to).toBe('drop@evil.example');
    expect(sent[0].options.host).toBe('smtp.evil.example');
    // A later launch on this computer: still approved.
    db = await openOn(PC_A, RECEIVED);
    ctx = ownerCtx(db, made.companyId, made.userId);
    expect(await fileApprovedHere(db)).toBe(true);
  });
}, SLOW);

// ---------------------------------------------------------------------------

describe('a file this computer already knew before this version (BKA_FILE_KNOWN_HERE)', () => {
  let made: Made;

  beforeAll(async () => {
    made = await hostileFileFromB(KNOWN, 'Known Co');
  }, SLOW);

  it('naming another folder stamps nothing', async () => {
    const db = await openOn(PC_A, KNOWN, { knownHere: path.join(ROOT, 'some-other-file') });
    expect(await fileApprovedHere(db)).toBe(false);
  }, SLOW);

  it('is stamped at open when the shell names its folder; other stamps are kept', async () => {
    const db = await openOn(PC_A, KNOWN, { knownHere: KNOWN });
    expect(await fileApprovedHere(db)).toBe(true);
    const raw = await approvalRow(db);
    expect(recordApproves(raw, A)).toBe(true);
    expect(recordApproves(raw, B)).toBe(true);
    // Cloud AI and email work on with no note.
    const ctx = ownerCtx(db, made.companyId, made.userId);
    expect((await assertOutboundAllowed('https://llm.evil.example/v1', 'ai', ctx)).allowed).toBe(true);
    expect((await holdStatus(db)).heldForThisComputer).toBe(false);
  }, SLOW);

  it('a later launch without the flag still counts as approved', async () => {
    const db = await openOn(PC_A, KNOWN);
    expect(await fileApprovedHere(db)).toBe(true);
  }, SLOW);

  it('only the first open in a process: books restored over the file later are not stamped by it', async () => {
    let db = await openOn(PC_A, KNOWN, { knownHere: KNOWN });
    expect(await fileApprovedHere(db)).toBe(true);
    // A backup from elsewhere replaces the books (no stamp of ours), and the same server reopens them.
    await db.delete(fileSecrets).where(eq(fileSecrets.name, APPROVAL_ROW));
    await closeDb(KNOWN);
    db = await getDb(KNOWN);
    expect(await fileApprovedHere(db)).toBe(false);
  }, SLOW);
});

// ---------------------------------------------------------------------------

describe('a brand-new company file made here', () => {
  it('is approved at its first open as the server’s own company file', async () => {
    const db = await openOn(PC_A, NEW_FILE);
    expect(await fileApprovedHere(db)).toBe(true);
    const parsed = JSON.parse((await approvalRow(db))!) as { stamps: Array<[string, string]> };
    expect(parsed.stamps.map(([k]) => k)).toEqual([A.keyId]);
  }, SLOW);

  it('a folder the server only restores into is not', async () => {
    process.env.BKA_DATA_DIR = NEW_FILE;
    onComputer(PC_A);
    forgetOpenedFoldersForTests();
    const db = await getDb(RESTORE_TARGET);
    expect(await approvalRow(db)).toBeNull();
    await closeDb(RESTORE_TARGET);
  }, SLOW);

  it('a crafted file posing as new, with settings already in it, is not', async () => {
    // Made on B (an empty file, stamped there), then rows written as a crafted file can hold them:
    // with the foreign-key checks off, no users and no company, but an AI provider and a company.
    let db = await openOn(PC_B, CRAFTED);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(aiSettings).values({
        companyId: '00000000-0000-4000-8000-000000000001',
        providers: [{ id: 'x', kind: 'openai-compatible', label: 'x', baseUrl: 'https://llm.evil.example/v1', model: 'm', enabled: true }],
        cloudEnabled: true,
      } as never);
    });
    db = await openOn(PC_A, CRAFTED);
    expect(await fileApprovedHere(db)).toBe(false);
    expect((await holdStatus(db)).heldHosts).toEqual(['llm.evil.example']);
    // Only a company with internet settings, no users.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.delete(aiSettings);
      await tx.insert(companies).values({
        name: 'Crafted',
        ownerId: '00000000-0000-4000-8000-000000000002',
        settings: { networkPolicy: { mode: 'allow-cloud', cloudOptIn: { ai: true }, rev: 2 } },
      } as never);
    });
    db = await openOn(PC_A, CRAFTED);
    expect(await fileApprovedHere(db)).toBe(false);
    expect((await holdStatus(db)).heldForThisComputer).toBe(true);
  }, SLOW);
});

// ---------------------------------------------------------------------------

describe('a file from another computer whose settings reach nothing on the internet', () => {
  let made: Made;
  let db: DB;
  let ctx: ServiceContext;

  beforeAll(async () => {
    db = await openOn(PC_B, QUIET);
    const [u] = await db.insert(users).values({ email: 'quiet@sender.test', name: 'Sender', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Quiet Co', ownerId: u.id });
    made = { companyId: company.id, userId: u.id };
    await updateSettings(ownerCtx(db, company.id, u.id), {
      providers: [{ kind: 'ollama', label: 'Office GPU', baseUrl: 'http://192.168.1.20:11434', model: 'llama3.2', enabled: true }],
    });
    db = await openOn(PC_A, QUIET);
    ctx = ownerCtx(db, made.companyId, made.userId);
    holder.ctx = ctx;
  }, SLOW);

  it('shows no note, and its local AI works', async () => {
    expect(await fileApprovedHere(db)).toBe(false);
    const view = await (await policyGET(request('host', 'GET'))).json();
    expect(view.heldForThisComputer).toBe(false);
    expect(view.heldServices).toEqual([]);
    expect((await checkOutbound('http://192.168.1.20:11434/api/tags', 'ai', ctx)).allowed).toBe(true);
  });

  it('a save from another computer is refused and approves nothing', async () => {
    holder.ctx = ctx;
    expect((await policyPUT(request('teammate', 'PUT', { mode: 'allow-cloud', cloudOptIn: { ai: true } }))).status).toBe(403);
    expect(await fileApprovedHere(db)).toBe(false);
  });

  it('the first save by an Admin at this computer approves it silently, so what they turn on works', async () => {
    holder.ctx = ctx;
    const res = await policyPUT(request('host', 'PUT', { mode: 'allow-cloud', cloudOptIn: { ai: true } }));
    expect(res.status).toBe(200);
    expect((await res.json()).heldForThisComputer).toBe(false);
    expect(await fileApprovedHere(db)).toBe(true);
    expect((await assertOutboundAllowed(`${DEFAULT_ANTHROPIC_BASE_URL}/v1/messages`, 'ai', ctx)).allowed).toBe(true);
  });
}, SLOW);

describe('limits', () => {
  it('keeps at most MAX_APPROVALS computers, dropping the oldest', async () => {
    const db = await openOn(PC_A, NEW_FILE);
    const id = (JSON.parse((await approvalRow(db))!) as { id: string }).id;
    const secrets = Array.from({ length: MAX_APPROVALS + 2 }, (_, i) => (i + 16).toString(16).padStart(2, '0').repeat(32));
    for (const s of secrets) {
      onComputer(s);
      expect(await approveFileHere(db)).toBe(true);
      expect(await approveFileHere(db)).toBe(false);
    }
    const parsed = JSON.parse((await approvalRow(db))!) as { id: string; stamps: Array<[string, string]> };
    expect(parsed.id).toBe(id);
    expect(parsed.stamps).toHaveLength(MAX_APPROVALS);
    expect(parsed.stamps.map(([k]) => k)).toEqual(secrets.slice(-MAX_APPROVALS).map(deviceKeyId));
    onComputer(PC_A);
    expect(await fileApprovedHere(db)).toBe(false);
  }, SLOW);

  it('the fixed AI addresses the note uses match the providers’', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'fileTrust.ts'), 'utf8');
    expect(src).toContain(`DEFAULT_ANTHROPIC_URL = '${DEFAULT_ANTHROPIC_BASE_URL}'`);
  });
});
