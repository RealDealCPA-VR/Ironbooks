/**
 * Test helper (not a test file) for the end-to-end exit tests of plan Phases 3 to 6
 * (test/agentPhase3.exit.test.ts … agentPhase6.exit.test.ts): one real PGlite company, the real
 * modules, an agent that talks only through the door (handleVerb, lib/agent/operate.ts) with the
 * context its own HTTP request would get (lib/agentContext.ts getAgentContext, built afresh for
 * every call as each request is), and people who approve through lib/services/agentRequests.ts
 * with their own signed-in context.
 *
 * What a test file must do itself, before anything here is loaded (vi.hoisted):
 *  - set BKA_DATA_DIR to its own folder (the door's request-id table opens the database with
 *    getDb() and no folder), BKA_AUTH_SECRET, IRONBOOKS_AGENT_ENDPOINT_DIR and BKA_AGENT_FILES_DIR,
 *    and delete BKA_DEVICE_VAULT, BKA_AGENT_SHELL and BKA_AGENT_SHELL_KEY;
 *  - mock next/headers (the route handlers and the limiter read it; there is no request here).
 *
 * The only things replaced are the mail transport (fakeMail: what the mail server is handed is
 * recorded, nothing leaves the computer) and the desktop shell's flows (realShell: the shell's
 * REAL checking core, electron/agentShell.js createShellCore, listens where the shell would and
 * checks each ticket, its MAC, replay, the input and the folders exactly as the desktop app does;
 * only the flows it would run are stand-ins that record what they were asked). The clock is the
 * test's own business. closingGuesses reads the closing-date password's guess limiter.
 *
 * Nothing here weakens a check: every agent call goes through the real door, every approval through
 * the real approval service, and every run through the real route bridge and route handler.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type Mail from 'nodemailer/lib/mailer';
import { getDb, closeDb, resolveDataDir, type DB } from '@/lib/db';
import {
  agentGrants,
  agentPermissionRequests,
  agentRequests,
  auditLogs,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { legacyRoleFor } from '@/lib/permissions/model';
import { attemptKeys, loginLimiter } from '@/lib/net/rateLimit';
import { UNVERIFIED_LOCAL_ADDR } from '@/lib/net/requestInfo';
import { CLOSING_PASSWORD_SCOPE } from '@/lib/closingPasswordLimiter';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { getAgentContext } from '@/lib/agentContext';
import { notePersonSignedIn } from '@/lib/agent/endpointFile';
import { handleVerb, resetAgentRateLimits } from '@/lib/agent/operate';
import type { AgentOperationAnswer, AgentVerb, AgentVerbs, RunOperationRequest, ShellTicket } from '@/lib/agent/contract';
import type { AgentPreset } from '@/lib/agent/operations/types';
import { createCompany } from '@/lib/services/company';
import { createAgent } from '@/lib/services/agents';
import { resolveAccess } from '@/lib/services/access';
import { mailTransport } from '@/lib/services/emailSettings';
import type { ServiceContext } from '@/lib/services/_base';

// ---------------------------------------------------------------------------
// The company and its people
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
  /** Their signed-in context, as their own window's request would carry it. */
  ctx: ServiceContext & { userId: string };
}

export interface Scenario {
  db: DB;
  dataDir: string;
  companyId: string;
  /** The company's owner: an Admin of every company in the file (so its file Admin too). */
  admin: Person;
  /** A context without access: what a seed step uses (trusted, as the services' own tests do). */
  seed: ServiceContext;
}

let seq = 0;
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** A person's context as their window would carry it: their own access in this company. */
export async function personContext(db: DB, companyId: string, userId: string): Promise<ServiceContext & { userId: string }> {
  const r = await resolveAccess(db, companyId, userId);
  return { db, companyId, userId, access: r.access, role: legacyRoleFor(r.access, r.isOwner) };
}

/**
 * Open (from scratch) the company file in `dataDir` with one company whose owner is `adminName`.
 * The folder is emptied first: each test file has its own.
 */
export async function openScenario(dataDir: string, companyName: string, adminName = 'Ada Admin'): Promise<Scenario> {
  fs.rmSync(dataDir, { recursive: true, force: true });
  const db = await getDb(dataDir);
  const [owner] = await db
    .insert(users)
    .values({ email: `${slug(adminName)}-${++seq}@exit-b.test`, name: adminName, passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: companyName, ownerId: owner.id });
  // A person signed in to this company file during this run: an agent may work (lib/agentContext.ts rule 3).
  notePersonSignedIn(resolveDataDir(dataDir));
  notePersonSignedIn(resolveDataDir());
  return {
    db,
    dataDir,
    companyId: company.id,
    admin: { id: owner.id, name: adminName, ctx: await personContext(db, company.id, owner.id) },
    seed: { db, companyId: company.id, userId: owner.id },
  };
}

export async function closeScenario(s: Scenario | undefined): Promise<void> {
  if (!s) return;
  await closeDb(s.dataDir);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

/** Add a person with one built-in role (lib/permissions/model.ts BUILTIN_ROLES). */
export async function addPerson(s: Scenario, name: string, roleKey: string): Promise<Person> {
  const [u] = await s.db
    .insert(users)
    .values({ email: `${slug(name)}-${++seq}@exit-b.test`, name, passwordHash: 'x' })
    .returning();
  await s.db.insert(userCompanies).values({ userId: u.id, companyId: s.companyId, role: 'accountant', isActive: true });
  await s.db.insert(userRoleAssignments).values({ companyId: s.companyId, userId: u.id, roleKey });
  return { id: u.id, name, ctx: await personContext(s.db, s.companyId, u.id) };
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export interface SeenAnswer {
  verb: AgentVerb;
  args: unknown;
  /** What came back, or the error the door threw (message, code, details). */
  answer?: unknown;
  error?: { message: string; code: string | null; details: unknown };
}

export interface ScenarioAgent {
  id: string;
  name: string;
  /** Everything the agent was answered, errors included, in order: what a scan of "every answer" reads. */
  seen: SeenAnswer[];
  /** The context its next HTTP request would get (built afresh: a pause or a policy change applies). */
  context(): Promise<ServiceContext>;
  verb<V extends AgentVerb>(verb: V, args: AgentVerbs[V]['args']): Promise<AgentVerbs[V]['answer']>;
  run(args: RunOperationRequest): Promise<AgentOperationAnswer>;
}

/** The context an agent's own request to POST /api/agent/actions gets (getAgentContext, the real one). */
export async function agentRequestContext(token: string, route = '/api/agent/actions', method = 'POST'): Promise<ServiceContext> {
  const h = new Map<string, string>([
    ['authorization', `Bearer ${token}`],
    [ROUTE_PATH_HEADER, route],
    [ROUTE_METHOD_HEADER, method],
  ]);
  return getAgentContext({ get: (n: string) => h.get(n.toLowerCase()) ?? null });
}

function errorOf(e: unknown): { message: string; code: string | null; details: unknown } {
  const err = e as { message?: unknown; code?: unknown; details?: unknown };
  return {
    message: typeof err?.message === 'string' ? err.message : String(e),
    code: typeof err?.code === 'string' ? err.code : null,
    details: err?.details ?? null,
  };
}

/**
 * Make an agent the way the Agents tab does (createAgent as the Admin) and return a handle that
 * calls the door with the agent's own request context. Its token stays in here.
 */
export async function makeAgent(
  s: Scenario,
  opts: { name: string; roleKeys: string[]; preset: AgentPreset; unattended?: boolean },
): Promise<ScenarioAgent & { token: string }> {
  const made = await createAgent(s.admin.ctx, { name: opts.name, roleKeys: opts.roleKeys, preset: opts.preset, unattended: opts.unattended });
  const token = made.token;
  const seen: SeenAnswer[] = [];
  const context = () => agentRequestContext(token);
  const verb = async <V extends AgentVerb>(v: V, args: AgentVerbs[V]['args']): Promise<AgentVerbs[V]['answer']> => {
    const ctx = await context();
    try {
      const answer = (await handleVerb(ctx, v, args)) as AgentVerbs[V]['answer'];
      seen.push({ verb: v, args, answer });
      return answer;
    } catch (e) {
      seen.push({ verb: v, args, error: errorOf(e) });
      throw e;
    }
  };
  return {
    id: made.agent.id,
    name: made.agent.name,
    token,
    seen,
    context,
    verb,
    run: (args) => verb('run_operation', args) as Promise<AgentOperationAnswer>,
  };
}

/** A fresh request id the door accepts ("exit-b:<label>:<n>"). */
export function requestKey(label: string): string {
  return `exit-b:${label.replace(/[^A-Za-z0-9._:-]/g, '-')}:${++seq}:${randomUUID().slice(0, 8)}`;
}

/** Forget the door's per-agent call counts (each test file sends many calls). */
export function freshLimits(): void {
  resetAgentRateLimits();
}

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

/** The rows of the tables a secret must never reach, as JSON text (plan §10 "Secrets"). */
export async function storedText(db: DB): Promise<string> {
  return JSON.stringify({
    agent_permission_requests: await db.select().from(agentPermissionRequests),
    agent_requests: await db.select().from(agentRequests),
    audit_logs: await db.select().from(auditLogs),
    agent_grants: await db.select().from(agentGrants),
  });
}

/** Everything the agent sent and was answered, as one text to scan. */
export function seenText(agent: Pick<ScenarioAgent, 'seen'>): string {
  return JSON.stringify(agent.seen);
}

/** Only what the agent was answered (answers and errors, not what it sent itself), as one text. */
export function answeredText(agent: Pick<ScenarioAgent, 'seen'>): string {
  return JSON.stringify(agent.seen.map((x) => ({ answer: x.answer ?? null, error: x.error ?? null })));
}

/** The digits of a value ("521-73-9846" → "521739846"), to find it however it was written. */
export function digitsOf(v: string): string {
  return v.replace(/\D/g, '');
}

/** True when `text` holds `value` as written or as its bare digits. */
export function holds(text: string, value: string): boolean {
  const digits = digitsOf(value);
  return text.includes(value) || (digits.length >= 6 && text.includes(digits));
}

// ---------------------------------------------------------------------------
// The mail server (replaced: what it is handed is recorded)
// ---------------------------------------------------------------------------

export interface FakeMail {
  sent: Mail.Options[];
  /** Put the real transport back and the environment as it was. */
  restore(): void;
}

const SMTP_ENV = {
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '587',
  SMTP_USER: 'books',
  SMTP_PASS: 'smtp-env-password',
  SMTP_FROM: 'Exit B Books <books@exit-b.test>',
} as const;

/**
 * A mail server on this computer (the SMTP_* fallback of lib/services/emailSettings.ts, a relay on
 * 127.0.0.1, which the network policy always allows), whose transport records each message.
 */
export function fakeMail(): FakeMail {
  const sent: Mail.Options[] = [];
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(SMTP_ENV)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  const original = mailTransport.create;
  mailTransport.create = (() => ({
    sendMail: async (m: Mail.Options) => {
      sent.push(m);
      return { messageId: `<${sent.length}@exit-b.test>`, accepted: [m.to] };
    },
  })) as unknown as typeof mailTransport.create;
  return {
    sent,
    restore() {
      mailTransport.create = original;
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The addresses a recorded message went to. */
export function recipientsOf(m: Mail.Options): string[] {
  // A recipient is an address, an { address } object, or a list of either (nested lists flattened).
  const out: string[] = [];
  const add = (t: unknown): void => {
    if (typeof t === 'string') out.push(t);
    else if (Array.isArray(t)) t.forEach(add);
    else if (t && typeof t === 'object' && typeof (t as { address?: unknown }).address === 'string') out.push((t as { address: string }).address);
  };
  add(m.to);
  return out;
}

// ---------------------------------------------------------------------------
// The desktop shell's own checks (electron/agentShell.js createShellCore), with recorded flows
// ---------------------------------------------------------------------------

/** What a flow of the stand-in shell gets: the input as the shell checked it. */
export type ShellFlow = (a: { input: Record<string, unknown> }) => Promise<{ done: boolean; restarting?: boolean; result?: unknown }>;

export interface RealShellLine {
  ticket: ShellTicket | null;
  operation: string;
  input: Record<string, unknown>;
  answers: Record<string, unknown>;
  folders: string[];
  /** What the shell's own core answered (before its MAC). */
  ok: boolean;
  error: string | null;
}

export interface RealShell {
  key: string;
  endpoint: string;
  /** Documents as the shell knows it (BKA_AGENT_DOCUMENTS): Documents\Ironbooks and its Agent Outbox are under it. */
  documents: string;
  /** Every line the shell was sent, with what its core answered. */
  lines: RealShellLine[];
  /** Every flow the shell actually ran (after all its checks), with its input. */
  ran: Array<{ operation: string; input: Record<string, unknown> }>;
  close(): Promise<void>;
}

/**
 * The real checking core of the desktop shell (electron/agentShell.js createShellCore: the ticket
 * and its MAC, replay, the input, the folders agents may use, never over an existing file) at the
 * shell's own endpoint, with stand-in flows that record what they were asked and do nothing else.
 * Documents is `documents` (a scratch folder), so nothing is ever looked for in the real one.
 */
export async function realShell(opts: { documents: string; flows: Record<string, ShellFlow> }): Promise<RealShell> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core = require('../../electron/agentShell.js') as {
    createShellCore: (o: Record<string, unknown>) => { handle: (line: string) => Promise<Record<string, unknown>> };
    defaultFolders: (o: { companyFile?: string; documents?: string }) => string[];
  };
  const key = randomBytes(32).toString('hex');
  const name = `ironbooks-exit-b-real-${process.pid}-${randomBytes(4).toString('hex')}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const lines: RealShellLine[] = [];
  const ran: RealShell['ran'] = [];
  const flows: Record<string, (a: { input: Record<string, unknown> }) => Promise<unknown>> = {};
  for (const [op, flow] of Object.entries(opts.flows)) {
    flows[op] = async (a) => {
      ran.push({ operation: op, input: { ...(a.input ?? {}) } });
      return flow(a);
    };
  }
  const shellCore = core.createShellCore({
    key,
    flows,
    folders: () => core.defaultFolders({ documents: opts.documents }),
    fileExists: (p: string) => fs.existsSync(p),
  });
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      void shellCore.handle(line).then((answer) => {
        lines.push({
          ticket: (parsed.ticket ?? null) as ShellTicket | null,
          operation: String(parsed.operation ?? ''),
          input: (parsed.input ?? {}) as Record<string, unknown>,
          answers: (parsed.answers ?? {}) as Record<string, unknown>,
          folders: (Array.isArray(parsed.folders) ? parsed.folders : []) as string[],
          ok: answer.ok === true,
          error: typeof answer.error === 'string' ? answer.error : null,
        });
        socket.end(`${JSON.stringify(answer)}\n`);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  const before = { endpoint: process.env.BKA_AGENT_SHELL, key: process.env.BKA_AGENT_SHELL_KEY, docs: process.env.BKA_AGENT_DOCUMENTS };
  process.env.BKA_AGENT_SHELL = endpoint;
  process.env.BKA_AGENT_SHELL_KEY = key;
  process.env.BKA_AGENT_DOCUMENTS = opts.documents;
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  return {
    key,
    endpoint,
    documents: opts.documents,
    lines,
    ran,
    close: async () => {
      put('BKA_AGENT_SHELL', before.endpoint);
      put('BKA_AGENT_SHELL_KEY', before.key);
      put('BKA_AGENT_DOCUMENTS', before.docs);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// The closing-date password's guess limit (lib/closingPasswordLimiter.ts)
// ---------------------------------------------------------------------------

export interface ClosingGuesses {
  /** The wrong guesses on the person's lock key of the app's own realm ('local'). */
  app: number;
  /** The wrong guesses on the person's lock key of the agent realm (UNVERIFIED_LOCAL_ADDR). */
  agentScope: number;
  /** The larger of the two: how near the person is to a lockout. */
  wrong: number;
  /** A guess by this person in this company would be refused now, in either realm. */
  locked: boolean;
}

/** The limiter keys lib/closingPasswordLimiter.ts uses for a person from `addr` (its ':addr:' key left out). */
function closingKeys(companyId: string, userId: string, addr: string): string[] {
  return attemptKeys(CLOSING_PASSWORD_SCOPE, `${companyId}:${userId}`, addr).filter((k) => !k.includes(':addr:'));
}

/**
 * The closing-date password's guess limit as it stands for one person in one company
 * (lib/closingPasswordLimiter.ts, the one process-wide limiter lib/net/rateLimit.ts loginLimiter).
 *
 * A password typed on an agent's approval card is checked twice, in two realms of that limiter:
 * lib/agent/bridge.ts closingOverride checks it outside the service scope, with the approving
 * person's 'local' keys, and the route (lib/services/company.ts setClosingDate) checks it again as
 * body.currentPassword inside the agent's service scope, whose origin is UNVERIFIED_LOCAL_ADDR
 * (lib/net/requestInfo.ts), so with that realm's keys. Both are read here.
 *
 *  - `locked` goes through the limiter's public check() with the keys closingPasswordLimiter builds
 *    (attemptKeys), so it follows the limiter's own rules, whatever its limits are.
 *  - `app` and `agentScope` are the failures held on the person's lock key of each realm
 *    ("closing-password:acct:local:<company>:<user>" and "closing-password:acct-at:<addr>|<company>:<user>").
 *    The limiter has no public way to read a count, so this reads its PRIVATE `buckets` map
 *    (LoginRateLimiter.buckets, each Bucket's `failures`, lib/net/rateLimit.ts): if those names
 *    change, change them here. A lockout empties a bucket's failures, so compare counts only
 *    between guesses before a lockout and use `locked` for the lockout itself. Throttle levels
 *    (the agent realm's "acct-slow" and "global-slow") are not counted: they drain with time and a
 *    right password never clears them (by design), so they say nothing about this person's count.
 */
export function closingGuesses(companyId: string, userId: string): ClosingGuesses {
  const limiter = loginLimiter();
  const appKeys = closingKeys(companyId, userId, 'local');
  const agentKeys = closingKeys(companyId, userId, UNVERIFIED_LOCAL_ADDR);
  const buckets = (limiter as unknown as { buckets: Map<string, { failures: number[] }> }).buckets;
  const failuresOn = (key: string | undefined): number => (key ? (buckets.get(key)?.failures.length ?? 0) : 0);
  const app = failuresOn(appKeys.find((k) => k.startsWith(`${CLOSING_PASSWORD_SCOPE}:acct:`)));
  const agentScope = failuresOn(agentKeys.find((k) => k.startsWith(`${CLOSING_PASSWORD_SCOPE}:acct-at:`)));
  const now = Date.now();
  const locked = !limiter.check(appKeys, now).allowed || !limiter.check(agentKeys, now).allowed;
  return { app, agentScope, wrong: Math.max(app, agentScope), locked };
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/** A fresh empty folder under the system's temporary folder (outside every Ironbooks folder). */
export function scratchFolder(label: string): string {
  const dir = path.join(os.tmpdir(), `ironbooks-exit-b-${process.pid}-${slug(label)}-${randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

/** Wait until the database has answered once more: any transaction still running has ended. */
export async function settled(db: DB): Promise<void> {
  await db.select({ id: users.id }).from(users).limit(1);
  await new Promise((r) => setTimeout(r, 20));
}

export { getDb };
