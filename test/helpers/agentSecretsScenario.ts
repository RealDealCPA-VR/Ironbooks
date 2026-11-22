/**
 * Agent full access: the scenario of the secrets and prompt-injection drills (plan 4.6, 5.8, 10
 * "Secrets", 11.1-11.3). Not a test file (vitest picks up *.test.ts only).
 *
 * In process, on a real PGlite company, with the app's own modules: the agent calls the door
 * exactly as POST /api/agent/actions does (its context built from its token by
 * lib/agentContext.ts getAgentContext, then lib/agent/operate.ts handleVerb), and a person answers
 * through lib/services/agentRequests.ts with a signed-in person's context. Only two things are
 * replaced, as the unit asks:
 *  - the mail transport (lib/services/emailSettings.ts mailTransport.create, the seam that module
 *    keeps for tests): every message is recorded with the options it would have connected with,
 *    so a test can see the password a person typed really reached the mail server, and nothing
 *    leaves this computer;
 *  - the desktop shell: none is running (BKA_AGENT_SHELL unset, Documents pointed at the scenario's
 *    own folder), so a desktop flow fails plainly instead of reaching a real window.
 *
 * Two more things a real run sets elsewhere: a person signing in is noted for the data folder
 * (what lib/context.ts does on a verified sign-in), and the company's time zone is one where it is
 * about midday now, so standing permission of an hour is never cut short by the end of the day.
 *
 * Everything an agent is answered (or refused with) is kept in `transcript`, and everything the
 * app writes to the console in `consoleLines`, so a test can scan them for a secret afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { companies, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import { legacyRoleFor } from '@/lib/permissions/model';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { notePersonSignedIn, resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { getAgentContext } from '@/lib/agentContext';
import { handleVerb, resetAgentRateLimits } from '@/lib/agent/operate';
import type { AgentOperationAnswer, AgentVerb, AgentVerbs, RunOperationRequest } from '@/lib/agent/contract';
import type { AgentPreset } from '@/lib/agent/operations/types';
import { resolveAccess } from '@/lib/services/access';
import { createAgent } from '@/lib/services/agents';
import { mailTransport } from '@/lib/services/emailSettings';
import { readAllTransactionLog, transactionLogPath } from '@/lib/services/transactionLog';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';

/** The route an agent's generic verbs arrive on (app/api/agent/actions/route.ts). */
export const AGENT_ACTIONS_PATH = '/api/agent/actions';

// ---------------------------------------------------------------------------
// The fake mail transport
// ---------------------------------------------------------------------------

export interface SentMail {
  /** The nodemailer options the transport was made with (host, port, auth with the password). */
  options: Record<string, unknown>;
  /** The message as it was handed to the transport. */
  message: Record<string, unknown>;
}

/** Every message the app handed to a mail server during the scenario. */
export const mailbox: SentMail[] = [];

const realCreate = mailTransport.create;

/** Put the recording transport in place of nodemailer's (nothing leaves this computer). */
export function installFakeMail(): void {
  mailTransport.create = ((options: Record<string, unknown>) => ({
    sendMail: async (message: Record<string, unknown>) => {
      mailbox.push({ options: JSON.parse(JSON.stringify(options)), message: JSON.parse(JSON.stringify(message)) });
      return { messageId: `<fake-${mailbox.length}@scenario.test>`, accepted: [message.to], rejected: [] };
    },
  })) as unknown as typeof mailTransport.create;
}

export function removeFakeMail(): void {
  mailTransport.create = realCreate;
}

// ---------------------------------------------------------------------------
// What the app wrote to the console
// ---------------------------------------------------------------------------

export const consoleLines: string[] = [];
type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
const realConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Keep a copy of every console line (still printed). */
export function captureConsole(): void {
  for (const m of CONSOLE_METHODS) {
    if (realConsole[m]) continue;
    const real = console[m].bind(console);
    realConsole[m] = real;
    console[m] = (...args: unknown[]) => {
      consoleLines.push(args.map(asText).join(' '));
      real(...args);
    };
  }
}

export function releaseConsole(): void {
  for (const m of CONSOLE_METHODS) {
    const real = realConsole[m];
    if (real) console[m] = real;
    delete realConsole[m];
  }
}

// ---------------------------------------------------------------------------
// The agent's side: every answer kept
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  agent: string;
  verb: string;
  args: unknown;
  /** What the agent was answered (JSON as the route would send it). */
  answer?: unknown;
  /** What the agent was refused with, as the route would send it (message, code, details). */
  error?: { message: string; code: string | null; details: unknown };
}

/** Everything every agent was answered during the scenario, in order. */
export const transcript: TranscriptEntry[] = [];

function errorAsSent(err: unknown): { message: string; code: string | null; details: unknown } {
  if (err instanceof ServiceError) return { message: err.message, code: err.code, details: err.details ?? null };
  if (err instanceof Error) return { message: err.message, code: null, details: null };
  return { message: String(err), code: null, details: null };
}

export interface ScenarioAgent {
  id: string;
  name: string;
  preset: AgentPreset;
  token: string;
  /** The agent's own context from its token, as POST /api/agent/actions gets it. */
  ctx(): Promise<ServiceContext>;
  /** One verb through the door, answer or refusal kept in the transcript. Throws what the door threw. */
  verb<V extends AgentVerb>(verb: V, args: AgentVerbs[V]['args'] | Record<string, unknown>): Promise<AgentVerbs[V]['answer']>;
  /** The same with a context taken earlier (a request already under way when something changed). */
  verbWith<V extends AgentVerb>(ctx: ServiceContext, verb: V, args: AgentVerbs[V]['args'] | Record<string, unknown>): Promise<AgentVerbs[V]['answer']>;
  run(args: RunOperationRequest | Record<string, unknown>): Promise<AgentOperationAnswer>;
}

export interface ScenarioPerson {
  id: string;
  name: string;
  /** A signed-in person's context, built as lib/context.ts builds one. */
  ctx(): Promise<ServiceContext>;
}

export interface Scenario {
  db: DB;
  root: string;
  dir: string;
  companyId: string;
  rich: RichCompany;
  /** The company's owner, an Admin and the file Admin. */
  admin: ScenarioPerson;
  /** Full Access, not an Admin. */
  second: ScenarioPerson;
  makeAgent(name: string, preset: AgentPreset, opts?: { roleKeys?: string[]; unattended?: boolean }): Promise<ScenarioAgent>;
  /** Merge keys into the company's settings, as a person's save would leave them. */
  setSettings(patch: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** The environment of one scenario's data folder. Each test file runs in its own worker. */
export function scenarioEnv(name: string): { root: string; dir: string } {
  const root = path.resolve(process.cwd(), '.bookkeeper-data', name);
  const dir = path.join(root, 'data');
  process.env.BKA_DATA_DIR = dir;
  process.env.BKA_AUTH_SECRET = `${name}-secret`;
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(root, 'endpoints');
  process.env.BKA_AGENT_FILES_DIR = path.join(root, 'agent-files');
  // No desktop shell: a desktop flow fails plainly, and Documents is the scenario's own folder.
  process.env.BKA_AGENT_DOCUMENTS = path.join(root, 'Documents');
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
  delete process.env.BKA_COMPANY_FILE;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_INTERNAL_TOKEN;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_COMPANY_SEALED;
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k];
  return { root, dir };
}

/** An IANA zone where it is about midday now ("Etc/GMT-5" is UTC+5: the sign is reversed). */
export function middayZone(now: Date = new Date()): string {
  const offset = 12 - now.getUTCHours();
  if (offset === 0) return 'Etc/GMT';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

export async function setupScenario(name: string): Promise<Scenario> {
  const { root, dir } = scenarioEnv(name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'Documents'), { recursive: true });
  resetAgentEndpointState();
  resetAgentRateLimits();
  installFakeMail();

  const db = await getDb(dir);
  const rich = await seedRichCompany(db, dir, `${name} Co`);
  const companyId = rich.ctx.companyId;
  const adminId = rich.ctx.userId!;
  await db.update(users).set({ name: 'Ada Admin', email: 'ada@secrets-scenario.test' }).where(eq(users.id, adminId));

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await db
      .update(companies)
      .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(companies.id, companyId));
  }
  await setSettings({ timezone: middayZone() });

  const [ben] = await db.insert(users).values({ email: 'ben@secrets-scenario.test', name: 'Ben Second', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: ben.id, companyId, role: 'accountant', isActive: true });
  await db.insert(userRoleAssignments).values({ companyId, userId: ben.id, roleKey: 'full_access' });

  async function personCtx(userId: string): Promise<ServiceContext> {
    const r = await resolveAccess(db, companyId, userId);
    if (!r.member || !r.active) throw new Error(`${userId} is not an active member of the scenario company`);
    notePersonSignedIn(resolveDataDir());
    return { db, companyId, userId, access: r.access, role: legacyRoleFor(r.access, r.isOwner) };
  }
  const admin: ScenarioPerson = { id: adminId, name: 'Ada Admin', ctx: () => personCtx(adminId) };
  const second: ScenarioPerson = { id: ben.id, name: 'Ben Second', ctx: () => personCtx(ben.id) };
  // The Admin opens the books: from here on agents may work.
  await admin.ctx();

  async function makeAgent(agentName: string, preset: AgentPreset, opts: { roleKeys?: string[]; unattended?: boolean } = {}): Promise<ScenarioAgent> {
    const made = await createAgent(await admin.ctx(), {
      name: agentName,
      roleKeys: opts.roleKeys ?? ['full_access'],
      preset,
      ...(opts.unattended ? { unattended: true } : {}),
    });
    const token = made.token;
    const ctx = () =>
      getAgentContext(
        new Headers({
          authorization: `Bearer ${token}`,
          [ROUTE_PATH_HEADER]: AGENT_ACTIONS_PATH,
          [ROUTE_METHOD_HEADER]: 'POST',
          host: 'localhost:45123',
        }),
      );
    const verbWith = async <V extends AgentVerb>(c: ServiceContext, v: V, args: unknown) => {
      const entry: TranscriptEntry = { agent: agentName, verb: v, args: JSON.parse(JSON.stringify(args ?? null)) };
      transcript.push(entry);
      try {
        const answer = (await handleVerb(c, v, args)) as AgentVerbs[V]['answer'];
        // As the route sends it: JSON.
        entry.answer = JSON.parse(JSON.stringify(answer ?? null));
        return answer;
      } catch (err) {
        entry.error = errorAsSent(err);
        throw err;
      }
    };
    const verb = async <V extends AgentVerb>(v: V, args: unknown) => {
      let c: ServiceContext;
      try {
        c = await ctx();
      } catch (err) {
        transcript.push({ agent: agentName, verb: v, args: JSON.parse(JSON.stringify(args ?? null)), error: errorAsSent(err) });
        throw err;
      }
      return verbWith(c, v, args);
    };
    return {
      id: made.agent.id,
      name: made.agent.name,
      preset,
      token,
      ctx,
      verb: verb as ScenarioAgent['verb'],
      verbWith: verbWith as ScenarioAgent['verbWith'],
      run: (args) => verb('run_operation', args) as Promise<AgentOperationAnswer>,
    };
  }

  return {
    db,
    root,
    dir,
    companyId,
    rich,
    admin,
    second,
    makeAgent,
    setSettings,
    close: async () => {
      removeFakeMail();
      releaseConsole();
      resetAgentEndpointState();
      await closeDb(dir);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

// ---------------------------------------------------------------------------
// Looking for a secret
// ---------------------------------------------------------------------------

export interface Needle {
  /** What it is ("the closing-date password"), for the failure message. */
  label: string;
  value: string;
}

export interface Hit {
  /** Where it was found ("agent_permission_requests row 3", "transaction log"). */
  where: string;
  label: string;
  /** How it was written there: as typed, base64, base64url or hex. */
  form: string;
  /** The text around it. */
  around: string;
}

/** The ways a secret could be written down: as typed, and the encodings the app uses for headers and bytes. */
export function formsOf(value: string): Array<{ form: string; text: string }> {
  const bytes = Buffer.from(value, 'utf8');
  const out = [
    { form: 'as typed', text: value },
    { form: 'base64', text: bytes.toString('base64').replace(/=+$/, '') },
    { form: 'base64url', text: bytes.toString('base64url') },
    { form: 'hex', text: bytes.toString('hex') },
  ];
  const seen = new Set<string>();
  return out.filter((f) => f.text.length >= 6 && !seen.has(f.text) && seen.add(f.text));
}

/** Every needle found in one text. */
export function findSecrets(where: string, text: string, needles: readonly Needle[]): Hit[] {
  const hits: Hit[] = [];
  if (!text) return hits;
  const lower = text.toLowerCase();
  for (const n of needles) {
    for (const f of formsOf(n.value)) {
      // hex is case-free; the others are matched as written.
      const at = f.form === 'hex' ? lower.indexOf(f.text) : text.indexOf(f.text);
      if (at < 0) continue;
      hits.push({ where, label: n.label, form: f.form, around: text.slice(Math.max(0, at - 60), at + f.text.length + 60) });
    }
  }
  return hits;
}

/** The base tables of the company file. */
export async function tableNames(db: DB): Promise<string[]> {
  const r = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  return r.rows.map((x) => x.table_name);
}

/** Every row of each table, as JSON text, looked through for every needle. */
export async function scanTables(db: DB, tables: readonly string[], needles: readonly Needle[]): Promise<{ hits: Hit[]; rows: number }> {
  const hits: Hit[] = [];
  let rows = 0;
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`Unexpected table name ${t}`);
    const r = (await db.execute(sql.raw(`select row_to_json(t)::text as j from "${t}" t`))) as unknown as { rows: Array<{ j: string }> };
    r.rows.forEach((row, i) => {
      rows += 1;
      hits.push(...findSecrets(`${t} row ${i + 1}`, row.j, needles));
    });
  }
  return { hits, rows };
}

/** The transaction log file as text (raw, both readings) and as the app reads it back. */
export function transactionLogTexts(dataDir: string): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const file = transactionLogPath(dataDir);
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    out.push({ where: 'transaction log file (utf8)', text: raw.toString('utf8') });
    out.push({ where: 'transaction log file (latin1)', text: raw.toString('latin1') });
  }
  try {
    out.push({ where: 'transaction log records', text: JSON.stringify(readAllTransactionLog(dataDir).records) });
  } catch (err) {
    out.push({ where: 'transaction log records (unreadable)', text: String(err) });
  }
  return out;
}

/** Every file under a folder, as text (names included). */
export function folderTexts(dir: string): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const raw = fs.readFileSync(p);
        out.push({ where: `file ${path.relative(dir, p)} (name)`, text: e.name });
        out.push({ where: `file ${path.relative(dir, p)}`, text: raw.toString('latin1') });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Every file under a folder, read as raw bytes and looked through for every needle (the file names
 * too). Pointed at the scenario's own folder this reads the company file's pages and its
 * write-ahead log as they are on disk, so a secret written to a row during the run and overwritten
 * or cleared later is still found while the old page is there: a scan of the rows as they stand
 * now cannot see it. Byte by byte (Buffer.indexOf), so a large file costs no copy as text.
 */
export function scanFiles(dir: string, needles: readonly Needle[]): { hits: Hit[]; files: number; bytes: number } {
  const hits: Hit[] = [];
  let files = 0;
  let bytes = 0;
  const forms = needles.flatMap((n) =>
    formsOf(n.value).flatMap((f) =>
      // hex is case-free: both spellings.
      (f.form === 'hex' ? [f.text.toLowerCase(), f.text.toUpperCase()] : [f.text]).map((text) => ({ label: n.label, form: f.form, bytes: Buffer.from(text, 'utf8') })),
    ),
  );
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const where = `file ${path.relative(dir, p)}`;
      hits.push(...findSecrets(`${where} (name)`, e.name, needles));
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const raw = fs.readFileSync(p);
        files += 1;
        bytes += raw.length;
        for (const f of forms) {
          const at = raw.indexOf(f.bytes);
          if (at >= 0) hits.push({ where, label: f.label, form: f.form, around: raw.subarray(Math.max(0, at - 60), at + f.bytes.length + 60).toString('latin1') });
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { hits, files, bytes };
}

/**
 * From here on, keep every text and JSON value of the company file uncompressed on disk. Postgres
 * compresses a long value, and a secret inside a compressed value would hide from scanFiles. Only
 * how the value is laid out on disk changes: what is stored and read back is the same.
 */
export async function storeUncompressed(db: DB): Promise<number> {
  const bases = new Set(await tableNames(db));
  const r = (await db.execute(
    sql`select table_name, column_name from information_schema.columns where table_schema = current_schema() and data_type in ('text', 'json', 'jsonb', 'character varying') order by table_name, column_name`,
  )) as unknown as { rows: Array<{ table_name: string; column_name: string }> };
  let n = 0;
  for (const { table_name: t, column_name: c } of r.rows) {
    if (!bases.has(t)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new Error(`Unexpected column ${t}.${c}`);
    await db.execute(sql.raw(`alter table "${t}" alter column "${c}" set storage external`));
    n += 1;
  }
  return n;
}

/** Write every page the database holds in memory to its files (before scanFiles reads them). */
export async function flushToDisk(db: DB): Promise<void> {
  await db.execute(sql`checkpoint`);
}

/** Hits as lines a failing test prints. */
export function describeHits(hits: readonly Hit[]): string {
  return hits.map((h) => `${h.label} (${h.form}) in ${h.where}: …${h.around}…`).join('\n');
}

/** The answers in the transcript as the agent read them (refusals included), one text per call. */
export function transcriptTexts(entries: readonly TranscriptEntry[] = transcript): Array<{ where: string; text: string }> {
  return entries.map((e, i) => ({
    where: `answer ${i + 1} to ${e.agent}'s ${e.verb}`,
    text: JSON.stringify(e.error ? { error: e.error } : { answer: e.answer }),
  }));
}

/** Wait until `check` holds, or fail after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 5_000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The ServiceError a promise rejects with (fails when it resolves or rejects otherwise). */
export async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error('It was let through.');
}
