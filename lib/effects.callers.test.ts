/**
 * The senders brought behind the effects outbox (lib/effects.ts, agent full access plan 5.4):
 *  - the test email (lib/services/emailSettings.ts sendTestEmail),
 *  - the AI layer's calls to model servers (lib/ai/providers.ts, router.ts, outbound.ts),
 *  - scheduled report exports (lib/services/memorizedReports.ts runDueSchedules),
 *  - and the two timers started on first use (backupSchedule.ts, companyFileSave.ts), which must
 *    not carry an agent's scope for the rest of the process.
 *
 * In an agent's preview (runWithEffects 'capture') each is recorded and does not happen. Outside a
 * scope each behaves exactly as before. Nothing leaves the machine: the mail transport and the
 * model server are fakes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-effects-callers');
const TEST_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'exports');
process.env.BKA_DATA_DIR = TEST_DIR;
const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of SMTP_KEYS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}

import { closeDb, getDb, type DB } from '@/lib/db';
import { companyEmailSettings, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import { EffectNotRunInPreview, currentEffects, currentEffectsMode, effectsOfFailedRun, runWithEffects } from '@/lib/effects';
import { inServiceScope, runWithServiceContext } from '@/lib/context';
import { fullAccess, withoutAreas } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import { getEmailSetup, mailTransport, saveEmailSetup, sendTestEmail } from '@/lib/services/emailSettings';
import {
  AGENT_SCHEDULE_HELD_MESSAGE,
  createReportSchedule,
  runDueSchedules,
  saveMemorizedReport,
  updateMemorizedReport,
  updateReportSchedule,
} from '@/lib/services/memorizedReports';
import { createOllamaProvider, pullOllamaModel } from '@/lib/ai/providers';
import { AiRouter } from '@/lib/ai/router';
import { AI_TASK_PURPOSES } from '@/lib/ai/outbound';
import { AiError } from '@/lib/ai/types';
import { ensureBackupScheduler, stopBackupScheduler } from '@/lib/services/backupSchedule';
import { ensureAutosave, resetCompanyFileSaveState } from '@/lib/services/companyFileSave';

const sent: Array<{ options: Record<string, unknown>; message: Record<string, unknown> }> = [];
const realCreate = mailTransport.create;

let db: DB;
let ctx: ServiceContext;
let companyId: string;
let ownerId: string;

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
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@effects.test', name: 'Olivia Owner', passwordHash: 'x' }).returning();
  ownerId = u.id;
  const company = await createCompany(db, { name: 'Effects Callers Co', ownerId });
  companyId = company.id;
  ctx = { db, companyId, userId: ownerId };
  mailTransport.create = (options: Record<string, unknown>) =>
    ({
      sendMail: async (message: Record<string, unknown>) => {
        sent.push({ options, message });
        return { messageId: 'test' };
      },
    }) as never;
  await saveEmailSetup(ctx, SERVER);
}, 180_000);

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  mailTransport.create = realCreate;
  for (const k of SMTP_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// The test email
// ---------------------------------------------------------------------------

describe('the test email (sendTestEmail)', () => {
  it('outside a scope is sent at once, as before, and remembered as the last test', async () => {
    const r = await sendTestEmail(ctx, { to: 'me@acme.test' });
    expect(r).toMatchObject({ ok: true, sent: true, to: 'me@acme.test', from: 'billing@acme.test' });
    expect(r.message).toMatch(/^Test email sent to me@acme\.test\./);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({ to: 'me@acme.test', subject: 'Ironbooks test email' });
    expect((await getEmailSetup(ctx)).lastTest).toMatchObject({ ok: true });
  });

  it("in an agent's preview is recorded, not sent, and the answer says it WOULD be sent", async () => {
    await db.update(companyEmailSettings).set({ lastTestAt: null, lastTestOk: null, lastTestMessage: null }).where(eq(companyEmailSettings.companyId, companyId));
    const run = await runWithEffects('capture', () => sendTestEmail(ctx, { to: 'me@acme.test' }));
    expect(sent).toHaveLength(0);
    expect(run.value).toMatchObject({ ok: true, sent: false, to: 'me@acme.test' });
    expect(run.value.message).toMatch(/would be sent to me@acme\.test/);
    expect(run.value.message).not.toMatch(/\bsent to me@acme\.test\. Check/);
    expect(run.effects).toHaveLength(1);
    expect(run.effects[0]).toMatchObject({ kind: 'email', detail: { to: ['me@acme.test'], subject: 'Ironbooks test email' } });
    expect(run.effects[0].summary).toBe('Email to me@acme.test: Ironbooks test email');
    // Nothing was tested, so nothing is remembered as the last test.
    expect((await getEmailSetup(ctx)).lastTest).toBeNull();
    expect(await run.release()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("in an agent's real run is sent only once the work is saved, and the answer says it WILL be", async () => {
    const run = await runWithEffects('defer', () => sendTestEmail(ctx, { to: 'me@acme.test' }));
    expect(run.value).toMatchObject({ ok: true, sent: false });
    expect(run.value.message).toMatch(/will be sent to me@acme\.test .*once this work is saved/);
    expect(sent).toHaveLength(0);
    const reports = await run.release();
    expect(reports).toMatchObject([{ status: 'sent', error: null, ranDuringOperation: false }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({ to: 'me@acme.test' });
  });

  it('a mail server failure after release is reported in plain words', async () => {
    mailTransport.create = () =>
      ({
        sendMail: async () => {
          throw Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
        },
      }) as never;
    try {
      const run = await runWithEffects('defer', () => sendTestEmail(ctx, { to: 'me@acme.test' }));
      const [report] = await run.release();
      expect(report.status).toBe('failed');
      expect(report.error).toMatch(/refused the user name or password/);
    } finally {
      mailTransport.create = (options: Record<string, unknown>) =>
        ({
          sendMail: async (message: Record<string, unknown>) => {
            sent.push({ options, message });
            return { messageId: 'test' };
          },
        }) as never;
    }
  });
});

// ---------------------------------------------------------------------------
// The AI layer
// ---------------------------------------------------------------------------

function fakeOllama(name: string, calls: string[]) {
  const fetch = async (url: string) => {
    calls.push(`${name} ${url}`);
    if (url.endsWith('/api/pull')) return new Response('{"status":"success"}\n', { status: 200 });
    return new Response(JSON.stringify({ message: { content: `answer from ${name}` }, model: 'm' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch };
}

function routerWith(calls: string[]) {
  const a = createOllamaProvider({ id: 'a', kind: 'ollama', label: 'A', baseUrl: 'http://127.0.0.1:11434', model: 'm', enabled: true }, fakeOllama('a', calls));
  const b = createOllamaProvider({ id: 'b', kind: 'ollama', label: 'B', baseUrl: 'http://192.168.1.20:11434', model: 'm', enabled: true }, fakeOllama('b', calls));
  return new AiRouter({ providers: [a, b], cloudEnabled: false, retries: 2, sleep: async () => undefined });
}

describe('AI calls (lib/ai)', () => {
  it('outside a scope reach the model server as before', async () => {
    const calls: string[] = [];
    const res = await routerWith(calls).chat('categorize', [{ role: 'user', content: 'Office Depot $42' }]);
    expect(res.content).toBe('answer from a');
    expect(calls).toEqual(['a http://127.0.0.1:11434/api/chat']);
  });

  it("in an agent's preview contact no computer: recorded with its host and purpose, no retry, the next provider only named", async () => {
    const calls: string[] = [];
    const router = routerWith(calls);
    let caught: unknown;
    try {
      await runWithEffects('capture', () => router.chat('categorize', [{ role: 'user', content: 'Office Depot $42' }]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EffectNotRunInPreview);
    expect((caught as Error).message).toBe(
      `This would contact 127.0.0.1:11434 for ${AI_TASK_PURPOSES.categorize}. A preview does not contact other computers, so it stopped here.`,
    );
    expect(calls).toEqual([]);
    const failed = effectsOfFailedRun(caught);
    // The real run tries the second server when the first does not answer: the card names both.
    expect(failed?.effects).toHaveLength(2);
    expect(failed?.effects[0]).toMatchObject({
      kind: 'network',
      summary: `Contact 127.0.0.1:11434 for ${AI_TASK_PURPOSES.categorize}`,
      detail: { host: '127.0.0.1:11434', purpose: AI_TASK_PURPOSES.categorize, ran: false },
    });
    expect(failed?.effects[1]).toMatchObject({
      kind: 'network',
      detail: { host: '192.168.1.20:11434', purpose: `${AI_TASK_PURPOSES.categorize}, if 127.0.0.1:11434 does not answer`, ran: false },
    });
    expect(failed?.ran).toEqual([]);
  });

  /** A local server, then a cloud one (a public address counts as cloud), each with its own fake. */
  function localThenCloud(calls: string[], beforeCloudCall?: () => Promise<void>, policy: 'local-then-cloud' | 'cloud-only' = 'local-then-cloud') {
    const local = createOllamaProvider({ id: 'home', kind: 'ollama', label: 'Home', baseUrl: 'http://127.0.0.1:11434', model: 'm', enabled: true }, fakeOllama('home', calls));
    const cloud = createOllamaProvider({ id: 'cloud', kind: 'ollama', label: 'Cloud', baseUrl: 'https://ai.example.com', model: 'm', enabled: true }, fakeOllama('cloud', calls));
    expect(cloud.locality).toBe('cloud');
    return new AiRouter({
      providers: [local, cloud],
      cloudEnabled: true,
      taskPolicies: { assistant: policy },
      retries: 0,
      sleep: async () => undefined,
      beforeCloudCall,
    });
  }

  it('a cloud provider the real run could fall back to is named on the approval card, and not contacted', async () => {
    const calls: string[] = [];
    const err = await runWithEffects('capture', () => localThenCloud(calls).chat('assistant', [{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectNotRunInPreview);
    expect(calls).toEqual([]);
    expect(effectsOfFailedRun(err)?.effects.map((e) => e.summary)).toEqual([
      `Contact 127.0.0.1:11434 for ${AI_TASK_PURPOSES.assistant}`,
      `Contact ai.example.com for ${AI_TASK_PURPOSES.assistant}, if 127.0.0.1:11434 does not answer`,
    ]);
  });

  it("the daily cloud limit is checked in a preview as in the real run: a refused cloud call is not shown as one it would make", async () => {
    const calls: string[] = [];
    const limitReached = vi.fn(async () => {
      throw new AiError('POLICY', "This company's daily limit of 5 cloud AI calls is reached.");
    });
    const err = await runWithEffects('capture', () => localThenCloud(calls, limitReached, 'cloud-only').chat('assistant', [{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
    expect(limitReached).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toMatch(/daily limit of 5 cloud AI calls/);
    expect(effectsOfFailedRun(err)?.effects).toEqual([]);
    expect(calls).toEqual([]);

    // Under the limit: counted (the bridge's preview transaction rolls that back), then stopped by the outbox.
    const underLimit = vi.fn(async () => undefined);
    const stop = await runWithEffects('capture', () => localThenCloud(calls, underLimit, 'cloud-only').chat('assistant', [{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
    expect(underLimit).toHaveBeenCalledTimes(1);
    expect(stop).toBeInstanceOf(EffectNotRunInPreview);

    // A preview on a read-only handle cannot count it: still stopped by the outbox, not failed.
    const cannotCount = vi.fn(async () => {
      throw new Error('This database handle is read-only.');
    });
    const readOnly = await runWithEffects('capture', () => localThenCloud(calls, cannotCount, 'cloud-only').chat('assistant', [{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
    expect(readOnly).toBeInstanceOf(EffectNotRunInPreview);
    expect(calls).toEqual([]);
  });

  it("a caller's own purpose is what the preview shows", async () => {
    const calls: string[] = [];
    const router = routerWith(calls);
    const err = await runWithEffects('capture', () =>
      router.chatJson('categorize', [{ role: 'user', content: 'statement text' }], { safeParse: () => ({ success: true, data: {} }) } as never, {
        purpose: 'sending the bank statement to an AI model to read it',
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectNotRunInPreview);
    expect(effectsOfFailedRun(err)?.effects[0].detail).toMatchObject({ purpose: 'sending the bank statement to an AI model to read it' });
    expect(calls).toEqual([]);
  });

  it("in an agent's real run the call is made and recorded as made", async () => {
    const calls: string[] = [];
    const run = await runWithEffects('defer', () => routerWith(calls).chat('assistant', [{ role: 'user', content: 'hi' }]));
    expect(run.value.content).toBe('answer from a');
    expect(calls).toHaveLength(1);
    expect(run.effects).toMatchObject([{ kind: 'network', detail: { host: '127.0.0.1:11434', purpose: AI_TASK_PURPOSES.assistant, ran: true } }]);
    expect(await run.release()).toMatchObject([{ status: 'sent', ranDuringOperation: true }]);
  });

  it("a model download, a health check and a model list are recorded, not made, in a preview", async () => {
    const calls: string[] = [];
    const deps = fakeOllama('a', calls);
    const pull = await runWithEffects('capture', () => pullOllamaModel({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null }, 'llama3.2', deps)).catch((e: unknown) => e);
    expect(pull).toBeInstanceOf(EffectNotRunInPreview);
    expect(effectsOfFailedRun(pull)?.effects[0].summary).toBe('Contact 127.0.0.1:11434 for downloading an AI model');
    const p = createOllamaProvider({ id: 'a', kind: 'ollama', label: 'A', baseUrl: 'http://127.0.0.1:11434', model: 'm', enabled: true }, deps);
    expect(p.host).toBe('127.0.0.1:11434');
    await expect(runWithEffects('capture', () => p.health())).rejects.toBeInstanceOf(EffectNotRunInPreview);
    await expect(runWithEffects('capture', () => p.listModels())).rejects.toBeInstanceOf(EffectNotRunInPreview);
    expect(calls).toEqual([]);
    // Outside a scope the same download runs.
    await pullOllamaModel({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null }, 'llama3.2', deps);
    expect(calls).toEqual(['a http://127.0.0.1:11434/api/pull']);
  });
});

// ---------------------------------------------------------------------------
// Scheduled report exports
// ---------------------------------------------------------------------------

describe('scheduled report exports (runDueSchedules)', () => {
  const NOW = new Date(2026, 1, 1, 9, 0, 0);
  let reportId: string;

  beforeAll(async () => {
    const r = await saveMemorizedReport(ctx, { name: 'Monthly P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31' } } });
    reportId = r.id;
  });

  async function freshSchedule(name: string, by: ServiceContext = ctx): Promise<string> {
    await db.update(reportSchedules).set({ isActive: false }).where(eq(reportSchedules.companyId, companyId));
    const s = await createReportSchedule(by, { name, memorizedReportId: reportId, frequency: 'monthly', startDate: '2026-02-01', format: 'csv', folder: name });
    return s.id;
  }

  it("in an agent's preview save nothing: the file is recorded and the result says it would be saved", async () => {
    await freshSchedule('Preview');
    const run = await runWithEffects('capture', () => runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR }));
    const [res] = run.value;
    expect(res.status).toBe('ok');
    expect(res.files).toHaveLength(1);
    expect(fs.existsSync(res.files[0])).toBe(false);
    expect(fs.existsSync(path.join(OUT_DIR, 'Preview'))).toBe(false);
    expect(res.message).toBe('Would save 1 file(s)');
    expect(run.effects).toHaveLength(1);
    expect(run.effects[0]).toMatchObject({ kind: 'file', detail: { dir: path.join(OUT_DIR, 'Preview'), name: path.basename(res.files[0]) } });
    expect(run.effects[0].summary).toMatch(/^Save Monthly P&L 2026-02-01\.csv \(\d+ (bytes|KB)\) in /);
  });

  it('outside a scope save the file as before', async () => {
    await freshSchedule('Person');
    const [res] = await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR });
    expect(res.status).toBe('ok');
    expect(res.message).toBeUndefined();
    expect(res.files).toEqual([path.join(OUT_DIR, 'Person', 'Monthly P&L 2026-02-01.csv')]);
    expect(fs.readFileSync(res.files[0], 'utf8').charCodeAt(0)).toBe(0xfeff);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.name, 'Person'));
    expect(row.lastMessage).toBe('Saved 1 file(s)');
  });

  it("in an agent's real run say the files WILL be saved, and save them only once the work is saved", async () => {
    await freshSchedule('Queued');
    const run = await runWithEffects('defer', () => runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR }));
    const [res] = run.value;
    expect(res.status).toBe('ok');
    expect(res.message).toBe('Will save 1 file(s) once this work is saved');
    expect(fs.existsSync(res.files[0])).toBe(false);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.name, 'Queued'));
    expect(row.lastMessage).toBe('Will save 1 file(s) once this work is saved');
    expect(await run.release()).toMatchObject([{ status: 'sent', effect: { kind: 'file' } }]);
    expect(fs.existsSync(res.files[0])).toBe(true);
  });

  const AGENT = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Bookkeeping agent', mode: 'post' as const };
  const agentCtx = (): ServiceContext => ({ ...ctx, agent: AGENT });
  /** Audit rows are ordered by time: keep each step on its own millisecond. */
  const nextMoment = () => new Promise((r) => setTimeout(r, 5));
  const runOnce = async () => (await runDueSchedules(ctx, { now: NOW, outDir: OUT_DIR }))[0];

  it('a schedule an agent set up waits until a person saves its recipients; an agent saving it, or a person pausing it, does not count', async () => {
    const id = await freshSchedule('By agent', agentCtx());
    const held = await runOnce();
    expect(held).toMatchObject({ scheduleId: id, status: 'held', files: [], message: AGENT_SCHEDULE_HELD_MESSAGE });
    expect(fs.existsSync(path.join(OUT_DIR, 'By agent'))).toBe(false);
    let [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    expect(row).toMatchObject({ lastStatus: 'held', lastMessage: AGENT_SCHEDULE_HELD_MESSAGE });
    expect(row.nextRunAt.getTime()).toBeLessThanOrEqual(NOW.getTime()); // still due

    await nextMoment();
    await updateReportSchedule(agentCtx(), id, { emailTo: null });
    expect((await runOnce()).status).toBe('held');

    // Pausing and resuming it, or renaming it, is not a look at who it emails.
    await nextMoment();
    await updateReportSchedule(ctx, id, { isActive: false });
    await updateReportSchedule(ctx, id, { isActive: true, name: 'By agent' });
    expect((await runOnce()).status).toBe('held');

    await nextMoment();
    await updateReportSchedule(ctx, id, { emailTo: null });
    const ran = await runOnce();
    expect(ran.status).toBe('ok');
    expect(fs.existsSync(ran.files[0])).toBe(true);
    [row] = await db.select().from(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.companyId, companyId)));
    expect(row.lastStatus).toBe('ok');
  });

  it("an agent's change after a person's save holds it again", async () => {
    const id = await freshSchedule('Changed again', agentCtx());
    await nextMoment();
    await updateReportSchedule(ctx, id, { emailTo: null });
    await nextMoment();
    await updateReportSchedule(agentCtx(), id, { emailTo: 'outside@elsewhere.test', frequency: 'daily' });
    expect(await runOnce()).toMatchObject({ scheduleId: id, status: 'held', message: AGENT_SCHEDULE_HELD_MESSAGE });
    expect(sent).toHaveLength(0);
  });

  it("an agent's change of a schedule a person made holds it", async () => {
    const id = await freshSchedule('Person made');
    await nextMoment();
    await updateReportSchedule(agentCtx(), id, { emailTo: 'outside@elsewhere.test' });
    expect(await runOnce()).toMatchObject({ scheduleId: id, status: 'held', message: AGENT_SCHEDULE_HELD_MESSAGE });
    expect(sent).toHaveLength(0);
    // The person takes the agent's address out and saves: it runs, files only.
    await nextMoment();
    await updateReportSchedule(ctx, id, { emailTo: null });
    expect((await runOnce()).status).toBe('ok');
  });

  it('only someone who may view every report it runs can let it run', async () => {
    const id = await freshSchedule('Needs report rights', agentCtx());
    await nextMoment();
    const noReports: ServiceContext = { ...ctx, access: withoutAreas(fullAccess(), ['reports_financial']) };
    await expect(updateReportSchedule(noReports, id, { emailTo: null })).rejects.toThrow(/permission/i);
    expect((await runOnce()).status).toBe('held');
  });

  it("one made under an agent's standing permission (no creator) runs, once let go, with the access of the person who let it go", async () => {
    // A grant run carries no person: the schedule records no creator.
    const id = await freshSchedule('Grant made', { ...ctx, userId: null, agent: AGENT });
    let [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    expect(row.createdBy).toBeNull();
    const [pat] = await db.insert(users).values({ email: 'pat@effects.test', name: 'Pat Partner', passwordHash: 'x' }).returning();
    await db.insert(userCompanies).values({ userId: pat.id, companyId, role: 'admin' });
    await nextMoment();
    await updateReportSchedule({ db, companyId, userId: pat.id }, id, { emailTo: null });
    [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    expect(row.createdBy).toBe(pat.id);
    // It runs with Pat's access, not the timer's full access: with Pat gone it does not run.
    await db.update(userCompanies).set({ isActive: false }).where(and(eq(userCompanies.userId, pat.id), eq(userCompanies.companyId, companyId)));
    const res = await runOnce();
    expect(res).toMatchObject({ scheduleId: id, status: 'failed', message: 'The person who set up this schedule no longer has access to this company.' });
  });

  it("an agent's change of the report a person's schedule runs holds the schedule", async () => {
    const id = await freshSchedule('Report changed');
    await nextMoment();
    await updateMemorizedReport(agentCtx(), reportId, { config: { params: { from: '2025-01-01', to: '2026-01-31' } } });
    expect(await runOnce()).toMatchObject({ scheduleId: id, status: 'held', message: AGENT_SCHEDULE_HELD_MESSAGE });
    await nextMoment();
    await updateReportSchedule(ctx, id, { emailTo: null });
    expect((await runOnce()).status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Timers started on first use
// ---------------------------------------------------------------------------

describe('timers started on first use', () => {
  const agentScope = (): ServiceContext => ({
    db,
    companyId,
    userId: null,
    role: 'accountant',
    access: fullAccess(),
    agent: { id: '00000000-0000-4000-8000-0000000000a2', name: 'Bookkeeping agent', mode: 'post' },
  });

  /** Where each setInterval / setTimeout was started: inside an agent scope or an effects scope? */
  function watchTimers() {
    const seen: Array<{ kind: string; serviceScope: boolean; effectsMode: string | null; effects: unknown }> = [];
    const realInterval = globalThis.setInterval;
    const realTimeout = globalThis.setTimeout;
    const si = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      seen.push({ kind: 'interval', serviceScope: inServiceScope(), effectsMode: currentEffectsMode(), effects: currentEffects() });
      return realInterval(fn, ms);
    }) as typeof setInterval);
    const st = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      // Only the scheduler's 15-second first check; short timers belong to other code.
      if (ms === 15_000) seen.push({ kind: 'timeout', serviceScope: inServiceScope(), effectsMode: currentEffectsMode(), effects: currentEffects() });
      return realTimeout(fn, ms);
    }) as typeof setTimeout);
    return { seen, restore: () => (si.mockRestore(), st.mockRestore()) };
  }

  it('the backup scheduler started from an agent request runs outside the agent scope and the outbox', async () => {
    stopBackupScheduler();
    const w = watchTimers();
    try {
      await runWithServiceContext(agentScope(), { path: '/api/backups', method: 'GET' }, () =>
        runWithEffects('capture', () => {
          expect(inServiceScope()).toBe(true);
          expect(currentEffectsMode()).toBe('capture');
          ensureBackupScheduler();
        }),
      );
    } finally {
      w.restore();
      stopBackupScheduler();
    }
    expect(w.seen.map((s) => s.kind).sort()).toEqual(['interval', 'timeout']);
    for (const s of w.seen) expect(s).toMatchObject({ serviceScope: false, effectsMode: null, effects: null });
  });

  it('the autosave timer started from an agent request runs outside the agent scope and the outbox', async () => {
    const before = process.env.BKA_COMPANY_FILE;
    process.env.BKA_COMPANY_FILE = path.join(ROOT, 'Effects Callers.ironbooks');
    resetCompanyFileSaveState();
    const w = watchTimers();
    try {
      await runWithServiceContext(agentScope(), { path: '/api/company-file/status', method: 'GET' }, () =>
        runWithEffects('defer', () => {
          expect(inServiceScope()).toBe(true);
          ensureAutosave();
        }),
      );
    } finally {
      w.restore();
      resetCompanyFileSaveState();
      if (before === undefined) delete process.env.BKA_COMPANY_FILE;
      else process.env.BKA_COMPANY_FILE = before;
    }
    const intervals = w.seen.filter((s) => s.kind === 'interval');
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ serviceScope: false, effectsMode: null, effects: null });
  });
});
