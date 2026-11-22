/**
 * Plan Phase 6 exit (files, shell, admin, plan §5.5, §5.7, §5.8, §4.5, §4.6), end to end in
 * process: a real PGlite company, the agent's own request context (lib/agentContext.ts), the door
 * (lib/agent/operate.ts handleVerb), the approval service (lib/services/agentRequests.ts), the route
 * bridge and the app's own route handlers.
 *
 * Replaced: next/headers (no HTTP request here) and the desktop shell. The shell is replaced twice
 * over, so both sides of the bridge are seen: lib/agent/shell.ts runShellOperation is wrapped
 * (vi.mock) to record what the server was asked to carry out, and at the shell's own endpoint the
 * REAL checking core of electron/agentShell.js (createShellCore: ticket, MAC, replay, input, the
 * folders agents may use) runs with stand-in flows that only record what they were asked.
 *
 *  - Backup to a named folder: the agent asks for a copy of the company file (File > Save Copy As)
 *    in a folder the Admin allowed; the Admin approves at the host; the shell is asked once, with
 *    a ticket for that request and that Admin, which cannot be used again. A folder outside the
 *    allowed ones is refused before any ask, again before the shell is asked, and by the shell
 *    itself. The same for a downloaded backup saved with save_file.
 *  - Add a user: the Admin approves and types the temporary password on the card; it is never in
 *    the agent's view of the request nor in any stored row, and nothing is "produced" for it.
 *  - The hard floor: no verb reaches the routes of agents, policies, grants or approvals, nor does
 *    the agent's own token, and an agent's context can never approve.
 *
 * Where the build does not do what the plan says, the test stays as it.fails with what is wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-phase6-exit`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-phase6-exit-secret';
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = `${root}/endpoints`;
  process.env.BKA_AGENT_FILES_DIR = `${root}/agent-files`;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_COMPANY_FILE;
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
  delete process.env.BKA_AGENT_DOCUMENTS;
});

/** What the server asked the shell bridge to carry out (lib/agent/shell.ts runShellOperation). */
const rec = vi.hoisted(() => ({
  calls: [] as Array<{
    approverId: string | null;
    approverIsAgent: boolean;
    operation: string;
    requestId: string;
    agentId: string;
    input: Record<string, unknown>;
    answers: Record<string, unknown>;
    secretKinds: string[];
    ok: boolean;
    error: string | null;
  }>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));

vi.mock('@/lib/agent/shell', async (orig) => {
  const real = await orig<typeof import('@/lib/agent/shell')>();
  const runShellOperation: typeof real.runShellOperation = async (approver, def, request, answers, secrets) => {
    const r = await real.runShellOperation(approver, def, request, answers, secrets);
    rec.calls.push({
      approverId: approver?.userId ?? null,
      approverIsAgent: Boolean(approver?.agent),
      operation: def?.id,
      requestId: request?.id,
      agentId: request?.agentId,
      input: { ...(request?.input ?? {}) },
      answers: { ...(answers ?? {}) },
      secretKinds: Object.keys(secrets ?? {}),
      ok: r.ok,
      error: r.error,
    });
    return r;
  };
  return { ...real, runShellOperation };
});

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentPermissionRequests, users } from '@/lib/db/schema';
import { allOperations, operationForRoute } from '@/lib/agent/operations/registry';
import { SHELL_TICKET_SECONDS, type AgentRequestView } from '@/lib/agent/contract';
import { sendShellLine } from '@/lib/agent/shell';
import { makeShellTicket, shellFileRef } from '@/lib/agent/shellTicket';
import { verifyPassword } from '@/lib/auth';
import { saveAgentPolicy } from '@/lib/services/agentPolicies';
import { approveAgentRequest, denyAgentRequest, requestForPerson } from '@/lib/services/agentRequests';
import { ServiceError } from '@/lib/services/_base';
import {
  agentRequestContext,
  answeredText,
  closeScenario,
  freshLimits,
  holds,
  makeAgent,
  openScenario,
  realShell,
  requestKey,
  scratchFolder,
  storedText,
  type RealShell,
  type Scenario,
  type ScenarioAgent,
} from './helpers/agentScenarioB';

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATA_DIR = path.resolve(process.env.BKA_DATA_DIR!);
const SAVE_COPY = 'shell.company.saveCopyAs';
const SAVE_FILE = 'files.save';
const TEMP_PASSWORD = 'Temp-Wren-8842-Harbor!';
const AGENT_PASSWORD = 'Agent-Picked-3391-Slate!';

let s: Scenario;
let agent: ScenarioAgent & { token: string };
let shell: RealShell;
/** Documents as the shell knows it (Documents\Ironbooks is an agent folder by default). */
let documents: string;
/** The folder the Admin added for this agent. */
let allowed: string;
/** A folder agents may not use. */
let outside: string;

function idOf(method: string, route: string): string {
  const op = operationForRoute(method, route);
  if (!op) throw new Error(`No operation for ${method} ${route}`);
  return op.id;
}
const ADD_USER = () => idOf('POST', '/api/users');
const BACKUP_DOWNLOAD = () => idOf('GET', '/api/backup');

async function requestRows() {
  return s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agent.id));
}

async function agentView(id: string): Promise<AgentRequestView | undefined> {
  return (await agent.verb('list_my_requests', {})).requests.find((r) => r.id === id);
}

beforeAll(async () => {
  documents = scratchFolder('documents');
  allowed = scratchFolder('allowed-backups');
  outside = scratchFolder('not-allowed');
  shell = await realShell({
    documents,
    flows: {
      [SAVE_COPY]: async ({ input }) => ({ done: true, result: { file: input.file, saved: true } }),
    },
  });

  s = await openScenario(DATA_DIR, 'Phase Six Files Co');
  // D1: an agent may hold the Admin role; "Full, with asks" keeps file, admin and secret work on Ask.
  agent = await makeAgent(s, { name: 'File Agent', roleKeys: ['admin'], preset: 'full_with_asks' });
  await saveAgentPolicy(s.admin.ctx, agent.id, { folders: [allowed] });
  freshLimits();
}, 240_000);

afterAll(async () => {
  await shell?.close();
  await closeScenario(s);
  for (const d of [documents, allowed, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe('Phase 6 exit: a backup to a named folder (a copy of the company file, through the desktop shell)', { timeout: 240_000 }, () => {
  let askId: string;
  const copyIn = (dir: string, name = 'Books backup.ironbooks') => path.join(dir, name);

  it('the agent finds Save Copy As: company-file work an Admin approves at the host computer', async () => {
    const desc = await agent.verb('describe_operation', { operation: SAVE_COPY });
    expect(desc.class).toBe('file');
    expect(desc.treatment).toBe('ask');
    expect(desc.notes.join(' ')).toMatch(/computer that holds the company file/);
    const perms = await agent.verb('get_my_permissions', {});
    expect(perms.folders).toEqual([allowed]);
  });

  // Three lines hold a path outside the folders agents may use. The door refuses it before anyone
  // is asked (lib/agent/operate.ts shellPathRefusal, in firstLook); the server refuses it again just
  // before the shell is asked, for a folder taken off the list since the ask (lib/agent/shell.ts
  // runShellOperation, pathOutsideFolders); and the desktop shell refuses it on its own side
  // (electron/agentShell.js pathProblem). The next three tests show each.
  it('a folder outside the allowed ones is refused before any ask', async () => {
    const before = (await requestRows()).length;
    const calls = rec.calls.length;
    const answer = await agent.run({ operation: SAVE_COPY, body: { file: copyIn(outside) }, requestId: requestKey('copy-outside'), reason: 'Keep a copy where the office keeps backups.' });
    expect(answer.outcome).toBe('refused');
    expect(answer.note ?? '').toMatch(/must be the full path of a file in a folder this agent may use/);
    expect(answer.note ?? '').toMatch(/Nobody was asked/);
    expect((await requestRows()).length).toBe(before);
    expect(rec.calls.length).toBe(calls);
  });

  it('a folder taken off the list after the ask: the approval fails before the shell is asked', async () => {
    const later = scratchFolder('allowed-then-removed');
    try {
      await saveAgentPolicy(s.admin.ctx, agent.id, { folders: [allowed, later] });
      const answer = await agent.run({ operation: SAVE_COPY, body: { file: copyIn(later, 'Later.ironbooks') }, requestId: requestKey('copy-later'), reason: 'Keep a copy where the office keeps backups.' });
      expect(answer.outcome, JSON.stringify(answer.note)).toBe('asked');
      // The Admin takes the folder off the agent's list before anyone approves.
      await saveAgentPolicy(s.admin.ctx, agent.id, { folders: [allowed] });
      const lines = shell.lines.length;
      const ran = shell.ran.length;
      const done = await approveAgentRequest(s.admin.ctx, answer.requestId!, {}, { atHost: true });
      expect(done.status).toBe('failed');
      // Refused by the server's own check as things are when the work runs (pathOutsideFolders):
      // the shell was never sent a line.
      expect(done.request.error ?? '').toMatch(/is not in a folder agents may use on this computer now/);
      expect(rec.calls.at(-1)).toMatchObject({ operation: SAVE_COPY, requestId: answer.requestId, ok: false });
      expect(shell.lines.length).toBe(lines);
      expect(shell.ran.length).toBe(ran);
      expect(fs.readdirSync(later)).toEqual([]);
    } finally {
      await saveAgentPolicy(s.admin.ctx, agent.id, { folders: [allowed] });
      fs.rmSync(later, { recursive: true, force: true });
    }
  });

  it('the shell itself refuses such a path before its flow runs, even on a good ticket for that request and that Admin', async () => {
    // What the server would send if both checks above were gone: a ticket made with the shell's
    // key for a request id and the Admin, over a path outside every agent folder.
    const input = { file: copyIn(outside, 'Elsewhere.ironbooks') };
    const answers = {};
    const folders = [allowed];
    const ticket = makeShellTicket(shell.key, {
      requestId: randomUUID(),
      operation: SAVE_COPY,
      input,
      approverId: s.admin.id,
      bound: { answers, folders, file: shellFileRef(null), secrets: [] },
    });
    const ran = shell.ran.length;
    const lines = shell.lines.length;
    const answer = await sendShellLine(JSON.stringify({ ticket, operation: SAVE_COPY, input, answers, folders }), 10_000, { key: shell.key, ticketMac: ticket.mac });
    expect(answer.ok).toBe(false);
    // Refused for its folder, not for its ticket: the ticket was good, so the folder rule is what held.
    expect(answer.error ?? '').toMatch(/is not in a folder agents may use on this computer/);
    expect(shell.lines.length).toBe(lines + 1);
    expect(shell.ran.length).toBe(ran);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a copy in the allowed folder: the agent asks, and the request needs an Admin at the host', async () => {
    const answer = await agent.run({ operation: SAVE_COPY, body: { file: copyIn(allowed) }, requestId: requestKey('copy-allowed'), reason: 'Month-end: keep a copy of the books before the year-end work.' });
    expect(answer.outcome).toBe('asked');
    askId = answer.requestId!;
    expect(answer.needs?.admin).toBe(true);
    expect(answer.needs?.fileAdmin).toBe(true);
    expect(answer.needs?.hostOnly).toBe(true);
    expect(answer.summary).toMatch(/^Save a copy of the company file as /);

    const away = await requestForPerson(s.admin.ctx, askId, { atHost: false });
    expect(away.canApprove).toBe(false);
    const calls = rec.calls.length;
    await expect(approveAgentRequest(s.admin.ctx, askId, {}, { atHost: false })).rejects.toBeInstanceOf(ServiceError);
    expect(rec.calls.length).toBe(calls);
    expect((await requestRows()).find((r) => r.id === askId)?.status).toBe('pending');
    const card = await requestForPerson(s.admin.ctx, askId, { atHost: true });
    expect(card.canApprove).toBe(true);
    // The card holds the whole path the agent sent ("What the agent sent").
    expect((card.input?.body as Out)?.file).toBe(copyIn(allowed));
  });

  // A path on the approval line is cut in its middle, never at its end (lib/agent/describe.ts: a
  // path field is shown through cutPath), so the Admin's one line keeps the folder the copy goes to
  // and the file's name.
  it('the approval line shows where the copy goes: its folder and its name', async () => {
    const view = await agentView(askId);
    expect(view?.summary).toContain(path.basename(allowed));
    expect(view?.summary).toContain('Books backup.ironbooks');
  });

  it('the Admin approves at the host: the shell is asked once, with a ticket for this request and this Admin', async () => {
    const calls = rec.calls.length;
    const lines = shell.lines.length;
    const at = Date.now();
    const done = await approveAgentRequest(s.admin.ctx, askId, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');

    // What the server asked: one run, as the Admin (a person, never the agent), for this request.
    expect(rec.calls.length).toBe(calls + 1);
    const call = rec.calls[calls];
    expect(call).toMatchObject({ approverId: s.admin.id, approverIsAgent: false, operation: SAVE_COPY, requestId: askId, agentId: agent.id, ok: true });
    expect(call.input).toEqual({ file: copyIn(allowed) });

    // What the shell got: one line, with a ticket its own core checked and took.
    expect(shell.lines.length).toBe(lines + 1);
    const line = shell.lines[lines];
    expect(line.ok, line.error ?? '').toBe(true);
    expect(line.operation).toBe(SAVE_COPY);
    expect(line.ticket).toMatchObject({ requestId: askId, operation: SAVE_COPY, approverId: s.admin.id });
    expect(line.ticket!.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(line.ticket!.expiresAt).toBeGreaterThan(at);
    expect(line.ticket!.expiresAt).toBeLessThanOrEqual(Date.now() + SHELL_TICKET_SECONDS * 1000);
    expect(line.folders).toContain(allowed);
    expect(shell.ran.at(-1)).toEqual({ operation: SAVE_COPY, input: { file: copyIn(allowed) } });

    const view = await agentView(askId);
    expect(view?.status).toBe('executed');
    expect((view?.result as Out)?.file).toBe(copyIn(allowed));
  });

  it('the ticket cannot be used again: the shell refuses it', async () => {
    const last = shell.lines.at(-1)!;
    const ran = shell.ran.length;
    const again = await sendShellLine(
      JSON.stringify({ ticket: last.ticket, operation: last.operation, input: last.input, answers: last.answers, folders: last.folders }),
      10_000,
      { key: shell.key, ticketMac: last.ticket!.mac },
    );
    expect(again.ok).toBe(false);
    expect(again.error ?? '').toMatch(/already used/);
    expect(shell.ran.length).toBe(ran);
  });
});

describe('Phase 6 exit: a downloaded backup saved in a named folder (save_file)', { timeout: 240_000 }, () => {
  let backupFileId: string;

  it('the agent asks for a backup of the company file; the Admin approves; the agent gets it as a staged file', async () => {
    const asked = await agent.run({ operation: BACKUP_DOWNLOAD(), requestId: requestKey('backup'), reason: 'A backup to keep with the month-end papers.' });
    expect(asked.outcome).toBe('asked');
    expect(asked.needs?.fileAdmin).toBe(true);
    const done = await approveAgentRequest(s.admin.ctx, asked.requestId!, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    const view = await agentView(asked.requestId!);
    expect(view?.file?.fileId).toBeTruthy();
    expect(view!.file!.size).toBeGreaterThan(0);
    backupFileId = view!.file!.fileId;
  });

  it('a folder outside the allowed ones is refused before any ask', async () => {
    const before = (await requestRows()).length;
    const calls = rec.calls.length;
    const answer = await agent.verb('save_file', { fileId: backupFileId, folder: outside, requestId: requestKey('save-outside'), reason: 'Keep it with the papers.' });
    expect(answer.outcome).toBe('refused');
    expect(answer.note ?? '').toMatch(/not one this agent may save to/);
    expect((await requestRows()).length).toBe(before);
    expect(rec.calls.length).toBe(calls);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('in the allowed folder: asked, approved by the Admin, and the backup is there', async () => {
    const asked = await agent.verb('save_file', { fileId: backupFileId, folder: allowed, name: 'Month-end backup.bka', requestId: requestKey('save-allowed'), reason: 'Keep it with the papers.' });
    expect(asked.outcome).toBe('asked');
    expect(asked.needs?.admin).toBe(true);
    expect(fs.existsSync(path.join(allowed, 'Month-end backup.bka'))).toBe(false);
    const done = await approveAgentRequest(s.admin.ctx, asked.requestId!, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    const saved = path.join(allowed, 'Month-end backup.bka');
    expect(fs.existsSync(saved)).toBe(true);
    const staged = await agent.verb('get_file', { fileId: backupFileId });
    expect(fs.statSync(saved).size).toBe(staged.file.size);
    expect(rec.calls.at(-1)).toMatchObject({ operation: SAVE_FILE, approverId: s.admin.id, approverIsAgent: false, ok: true });
  });
});

describe('Phase 6 exit: an agent asks to add a user; the Admin approves', { timeout: 240_000 }, () => {
  let askId: string;
  let produced: Array<{ kind: string; label: string; value: string }> = [];

  it('the agent asks with the name, login and role; a password it puts in is taken out', async () => {
    const asked = await agent.run({
      operation: ADD_USER(),
      body: { name: 'Dana Newhire', login: 'dana.newhire@exit-b.test', roleKeys: ['bookkeeper'], requireChange: true, password: AGENT_PASSWORD },
      requestId: requestKey('add-user'),
      reason: 'Dana starts on Monday as our bookkeeper.',
    });
    expect(asked.outcome).toBe('asked');
    askId = asked.requestId!;
    expect(asked.needs?.admin).toBe(true);
    expect(asked.needs?.secrets).toEqual(['new_user_password']);
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, askId));
    expect(JSON.stringify(row.input)).not.toContain(AGENT_PASSWORD);
  });

  it('the Admin approves, typing the temporary password on the card: the user can sign in with it, and only with it', async () => {
    const card = await requestForPerson(s.admin.ctx, askId, { atHost: true });
    expect(card.canApprove).toBe(true);
    const done = await approveAgentRequest(s.admin.ctx, askId, { secrets: { new_user_password: TEMP_PASSWORD } }, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    produced = done.produced;
    expect(JSON.stringify(done.request)).not.toContain(TEMP_PASSWORD);

    const [u] = await s.db.select().from(users).where(eq(users.name, 'Dana Newhire'));
    expect(u).toBeTruthy();
    expect(u.mustChangePassword).toBe(true);
    expect(await verifyPassword(TEMP_PASSWORD, u.passwordHash)).toBe(true);
    expect(await verifyPassword(AGENT_PASSWORD, u.passwordHash)).toBe(false);
  });

  it("the temporary password is in no stored row and never in the agent's view of the request", async () => {
    const view = await agentView(askId);
    expect(view?.status).toBe('executed');
    expect(holds(JSON.stringify(view), TEMP_PASSWORD)).toBe(false);
    expect(holds(answeredText(agent), TEMP_PASSWORD)).toBe(false);
    expect(holds(answeredText(agent), AGENT_PASSWORD)).toBe(false);
    const stored = await storedText(s.db);
    expect(holds(stored, TEMP_PASSWORD)).toBe(false);
    expect(holds(stored, AGENT_PASSWORD)).toBe(false);
  });

  // Decided (plan §5.8, inputs): the password of a user an agent asks to add is TYPED by the
  // approving Admin on the card (needsSecret new_user_password, put in body.password by
  // lib/agent/guards.ts applySecrets). Nothing is produced for that request, and that is correct:
  // the Admin already knows it, so there is nothing to show once. The tests above prove it
  // reaches neither the agent nor any stored row.
  it('nothing is produced for it: the Admin typed the password, so ApproveResult.produced is empty', () => {
    expect(produced).toEqual([]);
  });
});

describe('Phase 6 exit: the hard floor stays out of reach', { timeout: 240_000 }, () => {
  /** The routes of agents, their policies and standing permissions, and the approval center. */
  const FLOOR = /^\/api\/(agents|agent-grants|agent-requests)(\/|$)/;
  const floor = () => allOperations().filter((o) => FLOOR.test(o.route));
  let pendingId: string;

  beforeAll(async () => {
    // A request of this agent that is waiting: something an approval route would act on.
    const asked = await agent.run({
      operation: ADD_USER(),
      body: { name: 'Lee Waiting', login: 'lee.waiting@exit-b.test', roleKeys: ['view_only'] },
      requestId: requestKey('floor-pending'),
      reason: 'Lee needs to look at the reports.',
    });
    pendingId = asked.requestId!;
  });

  it('every one of those routes is on the hard floor', () => {
    const ops = floor();
    expect(ops.length).toBeGreaterThanOrEqual(15);
    for (const o of ops) expect(o.availability, `${o.method} ${o.route}`).toBe('hard_floor');
  });

  it('no verb reaches them: find and describe say refused; run, dry run and ask for permission are refused and ask nobody', async () => {
    const before = (await requestRows()).length;
    for (const o of floor()) {
      // Four calls per route: stay under the door's per-minute limit (a refusal for that is not the floor's).
      freshLimits();
      const params = Object.fromEntries(o.params.map((p) => [p, p === 'id' && o.route.startsWith('/api/agents/') ? agent.id : pendingId]));
      const body = o.method === 'GET' || o.method === 'DELETE' ? undefined : { paused: false, preset: 'full_with_asks', overrides: [], note: 'yes', ids: [pendingId] };
      const label = `${o.method} ${o.route}`;

      const desc = await agent.verb('describe_operation', { operation: o.id });
      expect(desc.treatment, label).toBe('refused');

      const run = await agent.run({ operation: o.id, params, ...(body ? { body } : {}), requestId: requestKey(`floor-${o.id}`), reason: 'Please.' });
      expect(run.outcome, label).toBe('refused');
      const dry = await agent.run({ operation: o.id, params, ...(body ? { body } : {}), dryRun: true });
      expect(dry.outcome, label).toBe('refused');

      const ask = await agent.verb('ask_for_permission', { operation: o.id, minutes: 30, reason: 'Please.', requestId: requestKey(`floor-ask-${o.id}`) });
      expect(ask.outcome, label).toBe('refused');
    }
    const found = await agent.verb('find_operations', { query: 'agent', limit: 30 });
    for (const op of found.operations.filter((x) => FLOOR.test(x.route))) expect(op.treatment, op.id).toBe('refused');

    expect((await requestRows()).length).toBe(before);
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, pendingId));
    expect(row.status).toBe('pending');
  });

  it("nor does the agent's own token on those routes", async () => {
    for (const o of floor()) {
      const concrete = o.route.replace(/\[[^\]]+\]/g, () => randomUUID());
      await expect(agentRequestContext(agent.token, concrete, o.method), `${o.method} ${concrete}`).rejects.toBeInstanceOf(ServiceError);
    }
  });

  it("an agent's context can never approve or deny, nor change its own policy", async () => {
    const ctx = await agent.context();
    await expect(approveAgentRequest(ctx, pendingId, { secrets: { new_user_password: TEMP_PASSWORD } }, { atHost: true })).rejects.toBeInstanceOf(ServiceError);
    await expect(denyAgentRequest(ctx, pendingId, 'no')).rejects.toBeInstanceOf(ServiceError);
    await expect(saveAgentPolicy(ctx, agent.id, { preset: 'full_with_asks', overrides: [{ class: 'admin', area: null, setting: 'allow' }] })).rejects.toBeInstanceOf(ServiceError);
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, pendingId));
    expect(row.status).toBe('pending');
    expect(row.decidedBy).toBeNull();
  });
});
