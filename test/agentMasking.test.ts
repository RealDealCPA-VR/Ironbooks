/**
 * Agent full access, masking (plan §10 "Masking", Phase 2, §5.9, decision D6): no operation an
 * agent can run as a read shows a full SSN, tax ID or account number unless a person approved a
 * reveal of exactly that kind for that one call.
 *
 * Every operation of class 'read' in the registry runs through the real route bridge
 * (lib/agent/bridge.ts runOperation, mode 'read') on one PGlite company seeded with protected
 * values to find (test/helpers/agentReadsFixture.ts: employees with full SSNs and a paycheck,
 * vendors with tax IDs and account numbers, a 1099 contractor, a bank account, an Other Names
 * payee, the employer's state account number, checks whose memo is "Acct # <full number>").
 * The agent's role is Admin, which holds both View flags (full SSNs, full account numbers): any
 * masking seen here is the bridge's, which switches the flags off for a run without a reveal.
 *
 * What is scanned is everything that reaches the agent: the JSON answer, the error, warnings and
 * preview, and a staged file (text and CSV as they are, a PDF's text layer through pdf.js, the XML
 * parts of an .xlsx or .zip). A value counts as shown when it appears in full: as stored, as its
 * digits alone, or as its digits with other separators (findSecrets).
 *
 * Every leak is a FINDING: it stays on LEAKS as an it.fails case naming the case and where the
 * value appeared. Such a case turns red the day the leak is closed (take it off then), and also
 * if the case stops answering at all.
 *
 * Every 'read' is scanned, all but the few the fixture's lists leave out (KNOWN, REFUSED_BY_DESIGN,
 * NOT_FOR_AGENTS, shared with the purity test): a read with no case to run, or a case that does
 * not answer, fails unless it is on one of them.
 *
 * More sides:
 *  - A 'read_sensitive' operation may show protected data without a reveal (a PDF cannot be
 *    masked): it always asks a person, and that person must hold the View flag of everything it
 *    shows (lib/agent/policy.ts approvalNeeds). What one shows that its approval does not ask the
 *    flag for is a finding. The fixture files a W-9 as a text document, so the document read has
 *    a tax ID and an account number to show.
 *  - A search that matches a protected value as stored answers guesses at it, even when the
 *    answer shows only the last digits: the right guess and two wrong ones must answer alike. A
 *    control first proves each search's filter is applied at all (text a seeded row holds answers
 *    differently from text none holds).
 *  - With an approved reveal on one operation the value appears, of that kind only, and only for
 *    a role that holds the flag; one reveal runs end to end through the door and a real approval.
 *  - GETs of the classes 'file' and 'admin' (exports, report files, a shareable copy, the raw
 *    transaction log), run as an approval without a reveal runs them, show only what their
 *    approver is asked to hold the flag for (APPROVED_UNGATED otherwise).
 *
 * Also noted on the way (decision: File Utilities reads that show file names or folders are class
 * 'file'): a 'read' whose answer holds the company file's folder is listed on SHOWS_FOLDER.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Set before anything is loaded: the door (one test below runs a reveal through it) opens the
// database with getDb() and no folder, and the scenario helper asks for this (its header).
const env = vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-masking`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-masking-test-secret';
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = `${root}/endpoints`;
  process.env.BKA_AGENT_FILES_DIR = `${root}/agent-files`;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
  return { root, cookies: new Map<string, string>(), headers: new Map<string, string>() };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (env.cookies.has(n) ? { name: n, value: env.cookies.get(n)! } : undefined), getAll: () => [], has: () => false }),
  headers: async () => new Headers([...env.headers.entries()]),
}));

import { sql } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import { SIMPLE_LIST_KEYS } from '@/lib/services/lists/simpleLists';
import { allOperations, operationById } from '@/lib/agent/operations/registry';
import type { Operation, RequestFacts } from '@/lib/agent/operations/types';
import type { BridgeActor, BridgeMode, BridgeResult, FileOwner, OperationInput } from '@/lib/agent/contract';
import { runOperation } from '@/lib/agent/bridge';
import { approvalNeeds } from '@/lib/agent/policy';
import { notePersonSignedIn } from '@/lib/agent/endpointFile';
import { approveAgentRequest } from '@/lib/services/agentRequests';
import { freshLimits, makeAgent, personContext, requestKey, type Scenario } from './helpers/agentScenarioB';
import {
  AGENCY_ACCOUNT,
  BANK_ACCOUNT,
  CONTRACTOR_ACCOUNT,
  KNOWN,
  LEFT_OUT,
  OTHER_NAME_ACCOUNT,
  SECRETS,
  SSN_DANA,
  SSN_LEE,
  STATE_ACCOUNT,
  TAX_ID_EIN,
  TAX_ID_SOLE,
  VENDOR_ACCOUNT,
  WIDE_RANGE,
  answerText,
  buildCases,
  digitsOf,
  findSecrets,
  listedIn,
  makeReadsAgent,
  opOfLabel as opAmong,
  seedAgentRequest,
  seedFirstUseRecords,
  seedReadsCompany,
  type CasesFor,
  type ReadCase,
  type ReadsAgent,
  type ReadsCompany,
  type Secret,
} from './helpers/agentReadsFixture';

const ROOT = path.resolve(env.root);
const TEST_DIR = path.resolve(process.env.BKA_DATA_DIR!);

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/**
 * 'read' cases that show a protected value in full without a reveal, by case label (the operation
 * id, or "<operation id> <report key or list>"): what shows and where. Each is an it.fails case.
 * (checks.pdf was one until it was filed as read_sensitive with reveal 'account_numbers'.)
 */
const LEAKS: Record<string, string> = {};

/**
 * 'read_sensitive' cases that show, without a reveal, a kind of protected value whose View flag
 * the approving person is not asked to hold. Each is an it.fails case.
 */
const UNGATED: Record<string, string> = {};

/** Searches whose answer tells a right guess at a protected value from a wrong one. it.fails each. */
const ORACLES: Record<string, string> = {};

/**
 * 'read' cases whose answer holds the company file's folder (the decision files such reads as
 * 'file'), by case label: what shows it. Each is an it.fails case.
 */
const SHOWS_FOLDER: Record<string, string> = {};

// ---------------------------------------------------------------------------

let db: DB;
let fx: ReadsCompany;
let casesFor: CasesFor;
let agent: ReadsAgent;
let owner: FileOwner;

const AGENT_ROUTES: readonly Operation[] = allOperations().filter((o) => o.kind === 'route' && o.availability === 'agent');
const READ_OPS = AGENT_ROUTES.filter((o) => o.class === 'read');
const SENSITIVE_OPS = AGENT_ROUTES.filter((o) => o.class === 'read_sensitive');
const ALL_READS = [...READ_OPS, ...SENSITIVE_OPS];

const opOfLabel = (label: string, among: readonly Operation[] = ALL_READS): Operation | undefined => opAmong(label, among);

function casesOfLabel(label: string): { op: Operation; cases: ReadCase[] | null } {
  const op = opOfLabel(label)!;
  const all = casesFor(op);
  if (label === op.id) return { op, cases: all };
  return { op, cases: all ? all.filter((c) => c.label === label) : null };
}

const GROUPS = 6;
function groupOf(op: Operation): number {
  let n = 0;
  for (const c of op.id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % GROUPS;
}

/** The company file's folder as an answer could hold it (as it is, JSON-escaped, with forward slashes). */
function folderForms(): string[] {
  const dir = path.resolve(TEST_DIR);
  return [...new Set([dir, JSON.stringify(dir).slice(1, -1), dir.replace(/\\/g, '/')])];
}

interface Scan {
  /** "<label>: <what> in <where>: …<text around it>…" */
  leaks: string[];
  /** The kinds of protected value that showed. */
  kinds: Set<Secret['kind']>;
  /** The case answered (outcome ok). */
  answered: boolean;
  /** Why it did not answer: "<status> <code> <message>". */
  refusal: string | null;
  unscanned: string | null;
  /** Where the company file's folder showed. */
  folder: string[];
  file: string | null;
}

/** Run one case as the agent and look for every protected value in what comes back. */
async function scan(
  op: Operation,
  c: ReadCase,
  actor: BridgeActor = agent.actor,
  secrets: readonly Secret[] = SECRETS,
  mode: BridgeMode = 'read',
): Promise<Scan> {
  const r = await runOperation(agent.base, op, c.input, mode, actor);
  const seen = await answerText(owner, r);
  const leaks: string[] = [];
  const kinds = new Set<Secret['kind']>();
  const folder: string[] = [];
  const forms = folderForms();
  for (const part of seen.parts) {
    for (const f of findSecrets(part.text, secrets)) {
      leaks.push(`${c.label}: ${f.secret.label} in ${part.where}: …${f.at}…`);
      kinds.add(f.secret.kind);
    }
    if (part.where !== 'file info' && forms.some((p) => part.text.includes(p))) folder.push(part.where);
  }
  return {
    leaks,
    kinds,
    answered: r.outcome === 'ok',
    refusal: r.outcome === 'ok' ? null : `${r.httpStatus} ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.replace(/\s+/g, ' ').trim(),
    unscanned: seen.unscanned ? `${c.label}: ${seen.unscanned}` : null,
    folder,
    file: r.file ? r.file.type : null,
  };
}

/** The values of one secret, as the scan looks for them. */
const only = (...values: string[]) => SECRETS.filter((s) => values.includes(s.value));

/** The View flag a person needs to see a kind of protected value. */
const FLAG_OF: Record<Secret['kind'], 'sensitivePayroll' | 'fullAccountNumbers'> = {
  ssn: 'sensitivePayroll',
  tax_id: 'sensitivePayroll',
  account_number: 'fullAccountNumbers',
};

const BARE_FACTS: RequestFacts = { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false };

const coverage = {
  cases: 0,
  answered: 0,
  notAnswered: [] as string[],
  notAnsweredLabels: [] as string[],
  unscanned: [] as string[],
  files: {} as Record<string, number>,
  folder: [] as string[],
};
let started = 0;

beforeAll(async () => {
  started = Date.now();
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  fx = await seedReadsCompany(db, TEST_DIR, 'Agent Masking Co');
  await seedFirstUseRecords(fx);
  agent = await makeReadsAgent(db, fx, 'Masking Agent');
  await seedAgentRequest(fx, agent);
  owner = { companyId: fx.ctx.companyId, agentId: agent.actor.agent.id };
  casesFor = await buildCases(db, fx, { reportKeys: REPORT_CATALOG.map((r) => r.key), listKeys: SIMPLE_LIST_KEYS });
}, 300_000);

afterAll(async () => {
  const files = Object.entries(coverage.files)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  console.log(
    `[agentMasking] ${READ_OPS.length} read + ${SENSITIVE_OPS.length} read_sensitive operations, ${coverage.cases} read cases ` +
      `(${coverage.answered} answered), ${Math.round((Date.now() - started) / 1000)} s with the seed\n` +
      `  files scanned: ${files || 'none'}; not scanned: ${coverage.unscanned.length ? coverage.unscanned.join(' | ') : 'none'}\n` +
      `  did not answer: ${coverage.notAnswered.length ? coverage.notAnswered.join(' | ') : 'none'}\n` +
      `  answers holding the company folder: ${coverage.folder.length ? coverage.folder.join(' | ') : 'none'}`,
  );
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the company and the agent', () => {
  it('the fixture seeded everything it means to', () => {
    expect(fx.seedErrors).toEqual([]);
  });

  it('every protected value is stored in full, so a scan that finds none means it was masked', async () => {
    const one = async (q: string) => ((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ v: string | null }> }).rows.map((r) => r.v ?? '');
    const c = fx.ctx.companyId;
    expect(await one(`select ssn as v from employees where company_id = '${c}'`)).toEqual(expect.arrayContaining([SSN_DANA, SSN_LEE]));
    expect(await one(`select tax_id as v from vendors where company_id = '${c}'`)).toEqual(expect.arrayContaining([TAX_ID_SOLE, TAX_ID_EIN]));
    expect(await one(`select account_number as v from vendors where company_id = '${c}'`)).toEqual(
      expect.arrayContaining([VENDOR_ACCOUNT, CONTRACTOR_ACCOUNT, AGENCY_ACCOUNT]),
    );
    expect(await one(`select account_number as v from bank_accounts where company_id = '${c}'`)).toContain(BANK_ACCOUNT);
    expect(await one(`select account_number as v from other_names where company_id = '${c}'`)).toContain(OTHER_NAME_ACCOUNT);
    expect(await one(`select account_number as v from payroll_state_settings where company_id = '${c}'`)).toContain(STATE_ACCOUNT);
    expect(await one(`select memo as v from payment_checks where company_id = '${c}'`)).toContain(`Acct # ${AGENCY_ACCOUNT}`);
    expect(await one(`select memo as v from expenses where company_id = '${c}'`)).toContain(`Acct # ${VENDOR_ACCOUNT}`);
    expect(await one(`select memo as v from journal_entry_lines where memo like 'Acct #%'`)).toContain(`Acct # ${AGENCY_ACCOUNT}`);
  });

  it('the records that hold protected values are among those read (audit rows included)', () => {
    const labels = (id: string) => (casesFor(operationById(id)!) ?? []).map((c) => c.label);
    expect(labels('audit-trail.get').length, 'audit rows holding a full value').toBeGreaterThan(3);
    expect(labels('expenses.get')).toEqual(expect.arrayContaining(['expenses.get typedMemoCheck', 'expenses.get queuedCheck']));
    expect(labels('vendors.get')).toEqual(expect.arrayContaining(['vendors.get', 'vendors.get vendorWithNumber']));
    expect(labels('audit-trail').length).toBeGreaterThan(1);
  });

  it("the agent's role holds both View flags: any masking below is the bridge's own", () => {
    expect(agent.ceiling.flags.sensitivePayroll).toBe(true);
    expect(agent.ceiling.flags.fullAccountNumbers).toBe(true);
    expect(agent.actor.reveal).toBe(false);
  });

  it('the scan finds a value however it is written, and never its masked form', () => {
    const at = (t: string) => findSecrets(t, only(BANK_ACCOUNT, SSN_DANA)).map((f) => f.secret.value);
    expect(at(`{"n":"${BANK_ACCOUNT}"}`)).toEqual([BANK_ACCOUNT]);
    expect(at('Account 0044-1782-9013 is open')).toEqual([BANK_ACCOUNT]);
    expect(at('SSN 521 73\n9846')).toEqual([SSN_DANA]);
    expect(at('521739846')).toEqual([SSN_DANA]);
    expect(at('"ssn":"***-**-9846","accountNumber":"••••9013"')).toEqual([]);
    // A longer number that holds the same digits is another number.
    expect(at('1004417829013')).toEqual([]);
  });

});

describe("no 'read' shows a full SSN, tax ID or account number without an approved reveal", () => {
  for (let g = 0; g < GROUPS; g++) {
    const ops = READ_OPS.filter((o) => groupOf(o) === g);
    it(`group ${g + 1} of ${GROUPS} (${ops.length} operations)`, async () => {
      const leaks: string[] = [];
      const folder: string[] = [];
      const unrun: string[] = [];
      for (const op of ops) {
        const cases = casesFor(op);
        // A read with nothing to run it with is not scanned: it must be on KNOWN, with why.
        if (!cases?.length) {
          if (!(op.id in KNOWN)) unrun.push(`${op.id}: the fixture cannot supply ${op.params.join(', ') || 'what it needs'} (seed one, or put it on KNOWN with why)`);
          continue;
        }
        for (const c of cases) {
          const s = await scan(op, c);
          coverage.cases++;
          if (s.answered) coverage.answered++;
          else {
            coverage.notAnswered.push(`${c.label} (${s.refusal})`);
            coverage.notAnsweredLabels.push(c.label);
          }
          if (s.unscanned) coverage.unscanned.push(s.unscanned);
          if (s.file) coverage.files[s.file] = (coverage.files[s.file] ?? 0) + 1;
          if (s.folder.length) coverage.folder.push(`${c.label} in ${s.folder.join(', ')}`);
          if (!LEAKS[c.label]) leaks.push(...s.leaks);
          if (!SHOWS_FOLDER[c.label] && s.folder.length) folder.push(`${c.label}: the company folder in ${s.folder.join(', ')}`);
        }
      }
      if (process.env.AGENT_MASKING_DUMP) fs.appendFileSync(process.env.AGENT_MASKING_DUMP, [...leaks, ...folder, ...unrun].join('\n') + '\n');
      expect(unrun).toEqual([]);
      expect(leaks).toEqual([]);
      expect(folder).toEqual([]);
    }, 900_000);
  }

  // A read that only answers an error shows nothing and proves nothing. Exactly the cases on the
  // fixture's lists of reads left out (KNOWN, REFUSED_BY_DESIGN, NOT_FOR_AGENTS) may not answer;
  // the purity test (test/agentReads.contract.test.ts) checks why each is there.
  it('the reads above really answered (all but the ones left out on purpose), and every staged file was scanned', () => {
    expect(coverage.cases).toBeGreaterThan(READ_OPS.length);
    const leftOut = LEFT_OUT.map(([l]) => l);
    const expected = READ_OPS.flatMap((op) => (casesFor(op) ?? []).filter((c) => listedIn(leftOut, c.label, op)).map((c) => c.label));
    // Today: agent.hello, companies.list, file-protection.status, reports.std.get agent-activity,
    // accountant-copy.changes, accountant-copy.changes.review.
    expect([...coverage.notAnsweredLabels].sort(), coverage.notAnswered.join(' | ')).toEqual([...expected].sort());
    expect(coverage.unscanned).toEqual([]);
    // PDFs are read through their text layer; a report of files with none would prove nothing.
    expect(Object.keys(coverage.files).some((t) => t.includes('pdf'))).toBe(true);
  });
});

describe("a 'read_sensitive' read shows only what its approver is asked to hold the flag for", () => {
  it(`every read_sensitive operation (${SENSITIVE_OPS.length})`, async () => {
    const ungated: string[] = [];
    const unrun: string[] = [];
    for (const op of SENSITIVE_OPS) {
      const needs = approvalNeeds(op, op.class, BARE_FACTS, { twoPersonOver: null });
      const asked = new Set(needs.flags ?? (needs.flag ? [needs.flag] : []));
      const cases = casesFor(op);
      if (!cases?.length && !(op.id in KNOWN)) unrun.push(`${op.id}: the fixture cannot supply ${op.params.join(', ') || 'what it needs'}`);
      for (const c of cases ?? []) {
        if (UNGATED[c.label]) continue;
        const s = await scan(op, c);
        for (const kind of s.kinds) {
          if (!asked.has(FLAG_OF[kind])) {
            ungated.push(`${c.label}: shows a full ${kind} without a reveal, but its approval asks for ${[...asked].join(', ') || 'no View flag'}: ${s.leaks.join(' / ')}`);
          }
        }
      }
    }
    expect(unrun).toEqual([]);
    expect(ungated).toEqual([]);
  }, 300_000);

  it('attachments.get (the W-9 filed as text): shows the full tax ID and account number, and its approver must hold both View flags', async () => {
    const op = operationById('attachments.get')!;
    expect(op.class).toBe('read_sensitive');
    const s = await scan(op, { label: 'attachments.get taxFormDocument', input: { params: { id: fx.ids.taxFormDocument } } }, agent.actor, only(TAX_ID_SOLE, CONTRACTOR_ACCOUNT));
    expect(s.answered, s.refusal ?? '').toBe(true);
    expect(s.unscanned).toBeNull();
    // A document cannot be masked: what the gate is for is really there.
    expect([...s.kinds].sort()).toEqual(['account_number', 'tax_id']);
    const needs = approvalNeeds(op, op.class, BARE_FACTS, { twoPersonOver: null });
    expect(needs.flags ?? []).toEqual(expect.arrayContaining(['sensitivePayroll', 'fullAccountNumbers']));
  });

  it('checks.pdf (the reason the class exists): the check PDF shows the full vendor account number, and its approver must hold "view full account numbers"', async () => {
    const op = operationById('checks.pdf')!;
    expect(op.class).toBe('read_sensitive');
    const s = await scan(op, { label: 'checks.pdf', input: { body: { source: 'expense', id: fx.ids.queuedCheck } } }, agent.actor, only(VENDOR_ACCOUNT));
    expect(s.answered).toBe(true);
    expect(s.leaks.join('\n')).toContain('file');
    const needs = approvalNeeds(op, op.class, BARE_FACTS, { twoPersonOver: null });
    expect(needs.flags).toContain('fullAccountNumbers');
  });
});

/**
 * Reads that match free text against what the books store, the text each is asked to match, and a
 * needle that is no secret and matches a seeded row (the control: see judge).
 */
interface Probe {
  label: string;
  op: string;
  input: (needle: string) => OperationInput;
  /** Matches a seeded row: the memo "Acct # …" of the typed check and the journal line, or the paper mill. */
  control: string;
}
const PROBES: Probe[] = [
  { label: 'find (memo)', op: 'find', input: (n) => ({ query: { ...WIDE_RANGE, memo: n } }), control: 'Acct #' },
  {
    label: 'reports.std.get general-ledger (memo)',
    op: 'reports.std.get',
    input: (n) => ({ params: { report: 'general-ledger' }, query: { ...WIDE_RANGE, memo: n } }),
    control: 'Acct #',
  },
  {
    label: 'reports.std.get journal (memo)',
    op: 'reports.std.get',
    input: (n) => ({ params: { report: 'journal' }, query: { ...WIDE_RANGE, memo: n } }),
    control: 'Acct #',
  },
  { label: 'reports.transaction-detail (search)', op: 'reports.transaction-detail', input: (n) => ({ query: { ...WIDE_RANGE, search: n } }), control: 'Ledger paper' },
  {
    label: 'registers.get checking (search)',
    op: 'registers.get',
    input: (n) => ({ params: { accountId: fx.ids.checking }, query: { search: n } }),
    control: 'Ledger Paper Mill',
  },
  { label: 'search (q)', op: 'search', input: (n) => ({ query: { q: n } }), control: 'Ledger Paper' },
  { label: 'transaction-log (q)', op: 'transaction-log', input: (n) => ({ query: { q: n, limit: '5000' } }), control: 'Ledger Paper' },
];

/** Text no seeded row holds. */
const NONSENSE = 'Qzxv no row holds this';

/** One search for one protected value: "<probe> <secret> "<needle>"". */
interface ProbeCase {
  label: string;
  probe: Probe;
  needle: string;
}
const PROBE_CASES: ProbeCase[] = PROBES.flatMap((p) =>
  SECRETS.flatMap((s) => [...new Set([s.value, digitsOf(s.value)])].map((needle) => ({ label: `${p.label} ${s.label} "${needle}"`, probe: p, needle }))),
);

/** The needle with its first digit changed (the last four show anyway). */
function wrongGuess(needle: string, by: number): string {
  const i = needle.search(/\d/);
  return `${needle.slice(0, i)}${(Number(needle[i]) + by) % 10}${needle.slice(i + 1)}`;
}

let probeRuns = 0;
/** One search's answer, with the needle taken out of it (an answer may repeat what it was asked). */
async function probeAnswer(op: Operation, p: Probe, needle: string): Promise<{ ok: boolean; text: string }> {
  const r: BridgeResult = await runOperation(agent.base, op, p.input(needle), 'read', agent.actor);
  probeRuns++;
  return { ok: r.outcome === 'ok', text: JSON.stringify(r.result ?? r.error).split(needle).join('<GUESS>') };
}

/**
 * The control of one search: a needle that matches a seeded row must answer differently from one
 * nothing matches. Otherwise the filter is ignored (or misnamed) and the right and wrong guesses
 * answer alike whatever the books hold, which proves nothing. Null when the control held.
 */
const controls = new Map<string, Promise<string | null>>();
function controlOf(op: Operation, p: Probe): Promise<string | null> {
  let c = controls.get(p.label);
  if (!c) {
    c = (async () => {
      const hit = await probeAnswer(op, p, p.control);
      const miss = await probeAnswer(op, p, NONSENSE);
      if (!hit.ok || !miss.ok) return `unjudged: the control search did not answer (${hit.ok ? miss.text : hit.text})`.slice(0, 300);
      if (hit.text === miss.text) return `unjudged: "${p.control}", which a seeded row holds, answered the same as text nothing holds, so the filter is not applied and a guess proves nothing`;
      return null;
    })();
    controls.set(p.label, c);
  }
  return c;
}

/** 'alike', 'oracle: …' (the right guess answers differently), or 'unjudged: …'. */
async function judge(p: ProbeCase): Promise<string> {
  const op = operationById(p.probe.op);
  if (!op) return `unjudged: no operation ${p.probe.op}`;
  const control = await controlOf(op, p.probe);
  if (control) return control;
  const answer = (guess: string) => probeAnswer(op, p.probe, guess);
  const right = await answer(p.needle);
  const w1 = await answer(wrongGuess(p.needle, 1));
  const w2 = await answer(wrongGuess(p.needle, 3));
  if (!right.ok || !w1.ok || !w2.ok) return 'unjudged: it did not answer';
  if (w1.text !== w2.text) return 'unjudged: two wrong guesses answered differently';
  if (right.text !== w1.text) return `oracle: the right guess answers differently (${right.text.length} characters against ${w1.text.length})`;
  return 'alike';
}

describe('a search never answers a guess at a protected value', () => {
  it(`the right guess and two wrong ones answer alike (${PROBE_CASES.length} searches)`, async () => {
    const oracles: string[] = [];
    const unjudged: string[] = [];
    for (const p of PROBE_CASES) {
      if (ORACLES[p.label]) continue;
      const v = await judge(p);
      if (v.startsWith('oracle')) oracles.push(`${p.label}: ${v}`);
      else if (v.startsWith('unjudged')) unjudged.push(`${p.label}: ${v}`);
    }
    console.log(`[agentMasking] search probes: ${probeRuns} runs; not judged: ${unjudged.length ? unjudged.join(' | ') : 'none'}`);
    expect(oracles).toEqual([]);
    expect(unjudged).toEqual([]);
  }, 300_000);

  it('ORACLES names real searches', () => {
    expect(Object.keys(ORACLES).filter((l) => !PROBE_CASES.some((p) => p.label === l))).toEqual([]);
  });

  for (const [label, what] of Object.entries(ORACLES)) {
    it.fails(`FINDING, a search answers a guess: ${label}: ${what}`, async () => {
      const p = PROBE_CASES.find((c) => c.label === label);
      // Not judged at all is not the finding: returning makes this it.fails case red.
      if (!p) return;
      const v = await judge(p);
      if (v.startsWith('unjudged')) return;
      expect(v).toBe('alike');
    }, 120_000);
  }
});

describe('FINDINGS', () => {
  it('the finding lists name real cases of the right class', () => {
    expect(Object.keys(LEAKS).filter((l) => !opOfLabel(l, READ_OPS))).toEqual([]);
    expect(Object.keys(SHOWS_FOLDER).filter((l) => !opOfLabel(l, READ_OPS))).toEqual([]);
    expect(Object.keys(UNGATED).filter((l) => !opOfLabel(l, SENSITIVE_OPS))).toEqual([]);
  });

  /** Not run at all is not the finding: returning makes the it.fails case red. */
  const guarded = (label: string, check: (s: Scan, op: Operation) => void) => async () => {
    const { op, cases } = casesOfLabel(label);
    if (!cases?.length) return;
    const scans: Scan[] = [];
    try {
      for (const c of cases) scans.push(await scan(op, c));
    } catch {
      return;
    }
    for (const s of scans) check(s, op);
  };
  for (const [label, what] of Object.entries(LEAKS)) {
    it.fails(`a read shows a protected value without a reveal: ${label}: ${what}`, guarded(label, (s) => expect(s.leaks).toEqual([])), 120_000);
  }
  for (const [label, what] of Object.entries(UNGATED)) {
    it.fails(
      `a read_sensitive read shows more than its approver is asked to hold: ${label}: ${what}`,
      guarded(label, (s, op) => {
        const needs = approvalNeeds(op, op.class, BARE_FACTS, { twoPersonOver: null });
        for (const kind of s.kinds) expect(needs.flags ?? []).toContain(FLAG_OF[kind]);
      }),
      120_000,
    );
  }
  for (const [label, what] of Object.entries(SHOWS_FOLDER)) {
    it.fails(`a read shows the company file's folder: ${label}: ${what}`, guarded(label, (s) => expect(s.folder).toEqual([])), 120_000);
  }

  it('company-file.info never tells an agent where the company file is', async () => {
    const r = await runOperation(agent.base, operationById('company-file.info')!, {}, 'read', agent.actor);
    expect(r.outcome).toBe('ok');
    expect((r.result as { location?: unknown }).location ?? null).toBeNull();
  });

  it.fails(
    "company-file.info (class 'read') answers the company file's name; the decision files File Utilities reads that show file names as 'file' (lib/agent/operations/classes/admin.ts)",
    async () => {
      const op = operationById('company-file.info');
      // Filed as 'file' (or no longer open to agents): this case turns red, take it off.
      if (!op || op.class !== 'read' || op.availability !== 'agent') return;
      const r = await runOperation(agent.base, op, {}, 'read', agent.actor);
      if (r.outcome !== 'ok') return;
      expect((r.result as { fileName?: unknown }).fileName ?? null).toBeNull();
    },
  );
});

// The bridge's side of a reveal: the actor carries reveal as an approved run sets it (operate.ts
// runApproved), so the many operations can be checked one call each. One reveal runs the whole way
// (asked through the door, approved by a person, read back) at the end of this file.
describe('an approved reveal shows the value: on that one call, of that kind, for a role with the flag', () => {
  const revealed = (): BridgeActor => ({ ...agent.actor, reveal: true });
  const opOf = (id: string) => {
    const op = operationById(id);
    if (!op) throw new Error(`No operation ${id}`);
    return op;
  };
  const run = (id: string, input: OperationInput, actor: BridgeActor, secrets: readonly Secret[]) =>
    scan(opOf(id), { label: id, input }, actor, secrets);

  it("employees.get: the employee's full SSN, only with the reveal (the agent asking is not enough)", async () => {
    const input = { params: { id: fx.ids.employee }, reveal: true };
    const shown = await run('employees.get', input, revealed(), only(SSN_DANA));
    expect(shown.answered).toBe(true);
    expect(shown.leaks.length, 'the full SSN should show with an approved reveal').toBeGreaterThan(0);
    expect((await run('employees.get', input, agent.actor, only(SSN_DANA))).leaks).toEqual([]);
  });

  it("vendors.get: a reveal of SSNs shows the vendor's tax ID and still masks its account number", async () => {
    const input = { params: { id: fx.ids.contractor }, reveal: true };
    expect(opOf('vendors.get').reveal).toBe('ssn');
    const tax = await run('vendors.get', input, revealed(), only(TAX_ID_SOLE));
    expect(tax.answered).toBe(true);
    expect(tax.leaks.length).toBeGreaterThan(0);
    expect((await run('vendors.get', input, revealed(), only(CONTRACTOR_ACCOUNT))).leaks).toEqual([]);
  });

  it('bank-accounts.list: a reveal of account numbers shows the full bank account number', async () => {
    expect(opOf('bank-accounts.list').reveal).toBe('account_numbers');
    const shown = await run('bank-accounts.list', { reveal: true }, revealed(), only(BANK_ACCOUNT));
    expect(shown.answered).toBe(true);
    expect(shown.leaks.length).toBeGreaterThan(0);
    expect((await run('bank-accounts.list', { reveal: true }, agent.actor, only(BANK_ACCOUNT))).leaks).toEqual([]);
  });

  it("reports.1099-xml (read_sensitive): the e-file carries the contractor's full tax ID with the reveal, and is refused without it", async () => {
    const input = { query: { year: '2026' }, reveal: true };
    const shown = await run('reports.1099-xml', input, revealed(), only(TAX_ID_SOLE));
    expect(shown.answered).toBe(true);
    expect(shown.leaks.length).toBeGreaterThan(0);
    const masked = await run('reports.1099-xml', input, agent.actor, only(TAX_ID_SOLE));
    expect(masked.answered).toBe(false);
    expect(masked.leaks).toEqual([]);
  });

  // The PDFs: also proves the scan reads a PDF's text (a masked PDF would otherwise pass unseen).
  it("payroll.w2 (a PDF): the employee's full SSN with the reveal, masked without it", async () => {
    expect(opOf('payroll.w2').reveal).toBe('ssn');
    const input = { query: { employeeId: fx.ids.employee, year: '2026' }, reveal: true };
    const shown = await run('payroll.w2', input, revealed(), only(SSN_DANA));
    expect(shown.answered).toBe(true);
    expect(shown.unscanned).toBeNull();
    expect(shown.leaks.join('\n')).toContain('file');
    const masked = await run('payroll.w2', input, agent.actor, only(SSN_DANA));
    expect(masked.answered).toBe(true);
    expect(masked.leaks).toEqual([]);
  });

  it("reports.1099-pdf (a PDF): the contractor's full tax ID with the reveal, masked without it", async () => {
    expect(opOf('reports.1099-pdf').reveal).toBe('ssn');
    const input = { query: { vendorId: fx.ids.contractor, year: '2026' }, reveal: true };
    const shown = await run('reports.1099-pdf', input, revealed(), only(TAX_ID_SOLE));
    expect(shown.answered).toBe(true);
    expect(shown.leaks.join('\n')).toContain('file');
    const masked = await run('reports.1099-pdf', input, agent.actor, only(TAX_ID_SOLE));
    expect(masked.answered).toBe(true);
    expect(masked.leaks).toEqual([]);
  });

  it("a reveal shows nothing for a role without the flag (the approver's yes is not enough)", async () => {
    const noFlags: BridgeActor = {
      ...revealed(),
      access: { ...agent.ceiling, flags: { ...agent.ceiling.flags, sensitivePayroll: false, fullAccountNumbers: false } },
    };
    const input = { params: { id: fx.ids.employee }, reveal: true };
    const r = await run('employees.get', input, noFlags, only(SSN_DANA));
    expect(r.answered).toBe(true);
    expect(r.leaks).toEqual([]);
  });

  it('a reveal on an operation that names nothing to reveal is refused and unmasks nothing', async () => {
    // The check with "Acct # <full number>" typed in its memo: expenses.get reveals nothing.
    expect(opOf('expenses.get').reveal).toBeNull();
    const asked = await run('expenses.get', { params: { id: fx.ids.typedMemoCheck }, reveal: true }, revealed(), only(VENDOR_ACCOUNT));
    expect(asked.answered).toBe(false);
    expect(asked.refusal).toMatch(/nothing to reveal/i);
    expect(asked.leaks).toEqual([]);
  });

  it('every read that reveals one kind shows no value of the other kind with an approved reveal (D6: one kind at a time)', async () => {
    const crossed: string[] = [];
    let shownOwn = 0;
    for (const op of READ_OPS.filter((o) => o.reveal)) {
      const own: ReadonlyArray<Secret['kind']> = op.reveal === 'account_numbers' ? ['account_number'] : ['ssn', 'tax_id'];
      const other = SECRETS.filter((s) => !own.includes(s.kind));
      for (const c of casesFor(op) ?? []) {
        const s = await scan(op, { label: c.label, input: { ...c.input, reveal: true } }, revealed());
        if (s.kinds.size && [...s.kinds].some((k) => own.includes(k))) shownOwn++;
        const wrong = s.leaks.filter((l) => other.some((o) => l.startsWith(`${c.label}: ${o.label} in `)));
        crossed.push(...wrong.map((l) => `(reveal ${op.reveal}) ${l}`));
      }
    }
    expect(crossed).toEqual([]);
    // The reveals did show their own kind somewhere: a scan that finds nothing proves nothing.
    expect(shownOwn).toBeGreaterThan(5);
  }, 300_000);

  it('payroll.state-wage-worksheet: the employer state account number, only with a reveal of account numbers', async () => {
    expect(opOf('payroll.state-wage-worksheet').reveal).toBe('account_numbers');
    const input = { query: { state: 'IL', year: '2026', quarter: '1' }, reveal: true };
    const shown = await run('payroll.state-wage-worksheet', input, revealed(), only(STATE_ACCOUNT));
    expect(shown.answered).toBe(true);
    expect(shown.leaks.length).toBeGreaterThan(0);
    const masked = await run('payroll.state-wage-worksheet', input, agent.actor, only(STATE_ACCOUNT));
    expect(masked.answered).toBe(true);
    expect(masked.leaks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Beyond the reads: what other GETs hand the agent once a person approved them without a reveal
// ---------------------------------------------------------------------------

/**
 * GETs of the classes 'file' and 'admin' whose answer reaches the agent once a person approved
 * the request (an export, a report file, a shareable copy of the books, the raw transaction log),
 * with no reveal asked. Run as an approved run runs them (lib/agent/operate.ts runApproved:
 * commit, the approver's access within the agent's ceiling, approvedBy set, reveal off). Not
 * here: the copies of the whole company file (backup.download, backup.company.download,
 * portable), which are compressed database files this scan cannot read.
 */
const APPROVED_SCANS: Array<{ label: string; op: string; input: OperationInput }> = [
  { label: 'export.get vendors (CSV)', op: 'export.get', input: { params: { list: 'vendors' } } },
  { label: 'export.get vendors (IIF)', op: 'export.get', input: { params: { list: 'vendors' }, query: { format: 'iif' } } },
  { label: 'export.get employees (CSV)', op: 'export.get', input: { params: { list: 'employees' } } },
  { label: 'export.get employees (IIF)', op: 'export.get', input: { params: { list: 'employees' }, query: { format: 'iif' } } },
  { label: 'export.get all (workbook)', op: 'export.get', input: { params: { list: 'all' }, query: { format: 'xlsx' } } },
  { label: 'users.permissions-report user_list (CSV)', op: 'users.permissions-report', input: { query: { kind: 'user_list', format: 'csv' } } },
  { label: 'portable.shareable (workbook)', op: 'portable.shareable', input: { query: { format: 'xlsx' } } },
  { label: 'portable.shareable (PDF)', op: 'portable.shareable', input: { query: { format: 'pdf' } } },
  { label: 'transaction-log.download', op: 'transaction-log.download', input: {} },
];

/**
 * FINDINGS: approved GETs above that show, without a reveal, a kind of protected value whose View
 * flag the approving person is not asked to hold, by label: what and where. it.fails each.
 */
const APPROVED_UNGATED: Record<string, string> = {
  'portable.shareable (workbook)':
    "the Journal sheet's Memo column holds the journal line memo \"Acct # TAX-66019283745\" in full (lib/services/shareableLedger.ts writes l.memo as stored, where the reports mask it with lib/services/journal.ts lineMemoFor), and approving this 'file' operation asks for no View flag (lib/agent/operations/classes/admin.ts 'GET /api/portable/shareable': no reveal, no sensitiveFields)",
  'transaction-log.download':
    "the raw log (.bktlg) holds every vendor's full tax ID and account number, the Other Names account number and the employer's state account number as recorded (its registry entry says \"nothing masked\"), and approving it asks for no View flag (lib/agent/operations/classes/reports.ts 'GET /api/transaction-log/download': no reveal, no sensitiveFields)",
};

describe('a GET of another class, approved without a reveal, shows only what its approver is asked to hold the flag for', () => {
  const approved = (): BridgeActor => ({
    ...agent.actor,
    // The owner approved: their access within the agent's ceiling is the ceiling.
    access: agent.ceiling,
    userId: fx.ctx.userId!,
    approval: { approvedBy: fx.ctx.userId!, requestId: null, grantId: null },
    reveal: false,
  });
  const judgeApproved = async (a: (typeof APPROVED_SCANS)[number]): Promise<{ notRun: string | null; ungated: string[] }> => {
    const op = operationById(a.op);
    if (!op || op.kind !== 'route' || op.availability !== 'agent') return { notRun: `${a.label}: no agent operation ${a.op}`, ungated: [] };
    const s = await scan(op, { label: a.label, input: a.input }, approved(), SECRETS, 'commit');
    if (!s.answered) return { notRun: `${a.label}: did not answer (${s.refusal})`, ungated: [] };
    if (s.unscanned) return { notRun: s.unscanned, ungated: [] };
    const needs = approvalNeeds(op, op.class, BARE_FACTS, { twoPersonOver: null });
    const asked = new Set(needs.flags ?? (needs.flag ? [needs.flag] : []));
    const ungated = [...s.kinds]
      .filter((k) => !asked.has(FLAG_OF[k]))
      .map((k) => `${a.label} (class ${op.class}): shows a full ${k} without a reveal, but its approval asks for ${[...asked].join(', ') || 'no View flag'}: ${s.leaks.join(' / ')}`);
    return { notRun: null, ungated };
  };

  it(`each of them (${APPROVED_SCANS.length})`, async () => {
    const notRun: string[] = [];
    const ungated: string[] = [];
    for (const a of APPROVED_SCANS) {
      if (APPROVED_UNGATED[a.label]) continue;
      const j = await judgeApproved(a);
      if (j.notRun) notRun.push(j.notRun);
      ungated.push(...j.ungated);
    }
    if (process.env.AGENT_MASKING_DUMP) fs.appendFileSync(process.env.AGENT_MASKING_DUMP, [...notRun, ...ungated].join('\n') + '\n');
    expect(notRun).toEqual([]);
    expect(ungated).toEqual([]);
  }, 300_000);

  it('APPROVED_UNGATED names scans above', () => {
    expect(Object.keys(APPROVED_UNGATED).filter((l) => !APPROVED_SCANS.some((a) => a.label === l))).toEqual([]);
  });

  for (const [label, what] of Object.entries(APPROVED_UNGATED)) {
    it.fails(`FINDING, an approved GET shows more than its approver is asked to hold: ${label}: ${what}`, async () => {
      const a = APPROVED_SCANS.find((x) => x.label === label);
      // Not run at all is not the finding: returning makes this it.fails case red.
      if (!a) return;
      const j = await judgeApproved(a);
      if (j.notRun) return;
      expect(j.ungated).toEqual([]);
    }, 120_000);
  }
});

describe('an approved reveal end to end: asked through the door, approved by a person, read back once', () => {
  it("vendors.get with reveal: the ask shows nothing, the owner approves, the agent's answer holds the contractor's full tax ID (not its account number), and the next read is masked", async () => {
    const ownerId = fx.ctx.userId!;
    const s: Scenario = {
      db,
      dataDir: TEST_DIR,
      companyId: fx.ctx.companyId,
      admin: { id: ownerId, name: 'Owner Person', ctx: await personContext(db, fx.ctx.companyId, ownerId) },
      seed: fx.ctx,
    };
    // A person signed in to this company file during this run: an agent may work (lib/agentContext.ts).
    notePersonSignedIn(resolveDataDir(TEST_DIR));
    notePersonSignedIn(resolveDataDir());
    freshLimits();
    const door = await makeAgent(s, { name: 'Door Agent', roleKeys: ['admin'], preset: 'trusted_bookkeeper' });
    const ask = {
      operation: 'vendors.get',
      params: { id: fx.ids.contractor },
      reveal: true,
      requestId: requestKey('masking-reveal'),
      reason: 'The 1099 needs the full tax ID to match the W-9.',
    };

    const asked = await door.run(ask);
    expect(asked.outcome).toBe('asked');
    expect(findSecrets(JSON.stringify(asked))).toEqual([]);

    const done = await approveAgentRequest(s.admin.ctx, asked.requestId!, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error ?? null)).toBe('executed');

    const again = await door.run(ask);
    expect(again.outcome).toBe('read');
    expect(again.replayed).toBe(true);
    const shown = JSON.stringify(again.result);
    expect(findSecrets(shown, only(TAX_ID_SOLE)).length, 'the approved reveal should show the full tax ID').toBeGreaterThan(0);
    // A reveal of SSNs shows SSNs and tax IDs only.
    expect(findSecrets(shown, only(CONTRACTOR_ACCOUNT))).toEqual([]);

    const next = await door.run({ operation: 'vendors.get', params: { id: fx.ids.contractor } });
    expect(next.outcome).toBe('read');
    expect(findSecrets(JSON.stringify(next))).toEqual([]);
    // Nothing else the agent was answered held a protected value.
    expect(findSecrets(JSON.stringify(door.seen.filter((x) => x.answer !== again)))).toEqual([]);
  }, 120_000);
});
