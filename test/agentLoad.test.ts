/**
 * Agent full access, Phase 7: load (plan §9 Phase 7: "an agent doing 2,000 bank lines with grants;
 * PGlite blocking measured; limits tuned"; §11.3: time and row limits, a rate limit per agent).
 * IN PROCESS, on a real PGlite company, through the real door (lib/agent/operate.ts handleVerb with
 * the context lib/agentContext.ts builds from the agent's token), bridge, policy, grants and
 * requests (test/helpers/agentScenario.ts). Nothing of the app is mocked. Two things stand in for
 * the world outside it:
 *  - the clock: Date only, still running with real time, stepped a minute ahead where the door
 *    would make the agent wait one (test/agentLoadScenario.ts startLoadClock);
 *  - next/headers: the headers of the request, for the two routes called directly (the long poll
 *    GET /api/agent/requests/[id] and POST /api/agent/actions), as lib/context.ts reads them.
 *
 * What is pinned:
 *  1. 2,000 statement lines: the agent brings them in itself (ten imports of 200 rows, prepare
 *     work its policy allows), then adds each to the books under standing permission limited by
 *     uses and by amount, four calls at a time. Every line is
 *     decided by the policy on what its dry run showed; the grant's uses are counted exactly (no
 *     use lost or counted twice while calls overlap); the amount under it is exactly the lines it
 *     covered; it stops at its limit and the next call asks.
 *  2. The rate limit: a call over AGENT_CALLS_PER_MINUTE is refused with a retry time, runs
 *     nothing and uses no grant; five runs at once where AGENT_RUNS_AT_ONCE (4) are allowed: one
 *     is refused at once and nothing of it is done.
 *  3. 500 waiting requests from ten agents: a person's list, the title bar's badge and a batch
 *     approval of 100 stay within the times below, and the statements one listing sends do not
 *     grow with the requests. The 100 approved together are asked through the door; the other 400
 *     are put through the requests service the door itself calls (createAgentRequest, with each
 *     agent's own context and a preview of the same shape), which saves two minutes of dry runs
 *     and changes nothing a person's list or badge reads. Those 100 are lines of payees the company
 *     has not paid before, so each run would also save a bank rule: most come back "the books
 *     changed". Pinned as a defect (it.fails): those stale only because of the next rule position
 *     the runs before them took. Pinned as right: those whose payee's rule an approval before them
 *     saved (their run no longer saves the rule the person was shown). Then a second batch of 100,
 *     of payees the company has rules for, that all run: how long "approve 100" holds a person.
 *  4. One large company (20,000 journal entries seeded straight into the tables): a bridged dry
 *     run of a bill and of a journal entry stays well under BRIDGE_TIME_LIMIT_MS.
 *  5. The long poll: at most WAITS_PER_AGENT (4) open waits per agent.
 *
 * Time limits are pinned at about three times what was measured (MEASURED, below), so a machine
 * busy with other work does not fail them, and a change that makes the work several times slower
 * does. A read that takes tens of milliseconds is timed five times and judged on the median, so
 * one pause of the machine does not fail it. The statement counts come from
 * test/agentLoadScenario.ts countStatements: the database has no query hook of its own, so the
 * counter wraps the PGlite client while it counts.
 *
 * Order: vitest runs these tests one after the other, in the order written, and each describe
 * builds on the company the ones before it left (the lines, the agents, the waiting requests).
 * Run the file whole. Run with -t on one case, a case that needs what an earlier one left fails
 * on that, or (the it.fails pin, which would otherwise count any failure as the defect) is
 * skipped and says so.
 *
 * What was measured is printed at the end and written to a file: AGENT_LOAD_REPORT names it, or
 * else it is ironbooks-agent-load-report.json in the system's temp folder. Under an AI coding
 * agent, vitest 4 picks its "agent" reporter, which prints a test's console output only when the
 * test fails (whatever --silent says): add --reporter=default to see it, or read the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ store: null as AsyncLocalStorage<Map<string, string>> | null }));
vi.mock('next/headers', () => ({
  // The headers of the call the route is answering (callRoute runs each call in its own store), so
  // two calls in flight, of one agent or of two, never see each other's headers.
  headers: async () => new Headers([...(h.store?.getStore() ?? new Map<string, string>()).entries()]),
  cookies: async () => ({ get: () => undefined }),
}));
h.store = new AsyncLocalStorage<Map<string, string>>();

import { agentGrants, agentRequests, auditLogs, bankTransactions, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { Money } from '@/lib/money';
import {
  AGENT_CALLS_PER_MINUTE,
  AGENT_RUNS_AT_ONCE,
  AgentRateLimited,
  agentRetryAfter,
  resetAgentRateLimits,
} from '@/lib/agent/operate';
import { BRIDGE_TIME_LIMIT_MS, type AgentOperationAnswer, type AgentRequestView, type ApproveResult } from '@/lib/agent/contract';
import type { RequestFacts } from '@/lib/agent/operations/types';
import { operationById } from '@/lib/agent/operations/registry';
import { describeRequest } from '@/lib/agent/describe';
import { liveGrants } from '@/lib/services/agentGrants';
import { badgeForPerson, createAgentRequest, listRequestsForPerson } from '@/lib/services/agentRequests';
import { importTransactions } from '@/lib/services/import';
import { createBill } from '@/lib/services/bills';
import { postJournalEntry } from '@/lib/services/posting';
import { refreshPlannerStats } from '@/lib/db/plannerStats';
import { WAITS_PER_AGENT } from '@/app/api/agent-requests/_guards';
import { GET as waitGET } from '@/app/api/agent/requests/[id]/route';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';
import { AGENT_ACTIONS_PATH, scenarioEnv, setupScenario, type Scenario, type ScenarioAgent } from './helpers/agentScenario';
import {
  LOAD_RUN_PREFIX,
  MinutePacer,
  NEW_PAYEES,
  addBank,
  clearOldLoadRuns,
  countStatements,
  importBody,
  median,
  percentile,
  previewDifferences,
  seedJournal,
  startLoadClock,
  statementRow,
  timed,
  type LoadClock,
  type StatementRow,
} from './agentLoadScenario';

// A data folder of this run's own: two runs of this file at once (two people checking the same
// branch) must not open or remove each other's company file.
const RUN_NAME = `${LOAD_RUN_PREFIX}${process.pid}`;
scenarioEnv(RUN_NAME);

// ---------------------------------------------------------------------------
// MEASURED (Windows 11 laptop, PGlite in process, other test runs going on beside it). The
// limits below are about three times these.
// ---------------------------------------------------------------------------
const MEASURED = {
  /** One bank line added under a grant through the door (dry run, decision, commit), per line in groups of 4: median. */
  lineMs: 200,
  /** A person's badge read while the agent sends a group of four: median (the most was 41 ms). */
  badgeUnderLoadMs: 35,
  /** The first approval of a bank line, with standing permission given (dry run, commit, the grant): one, 172 ms. */
  approveFirstMs: 200,
  /** listRequestsForPerson, the approval center's first page (100), 500 waiting: median of 5. */
  list100Ms: 60,
  /** listRequestsForPerson with limit 500, 500 waiting: median of 5. */
  list500Ms: 110,
  /** badgeForPerson, 500 waiting, a read that also settles the company's requests (once a minute): median of 5. */
  badgeSettlingMs: 75,
  /** badgeForPerson, 500 waiting, the reads in between (no settling): median of 5. */
  badgeMs: 60,
  /** One approval of a bank line that runs (a dry run with the approver's rights, then the commit): 241 ms a line in a batch. */
  approveMs: 240,
  /** One approval of a batch that comes back stale (the dry run only). */
  staleApproveMs: 140,
  /** A batch approval of 100 bank lines that all run (payees the company has rules for). */
  batchAllRunMs: 24_000,
  /** A dry run of a bill or a journal entry through the door, 22,000 entries, statistics fresh: the slower (the bill). */
  dryRunLargeMs: 130,
  /** A dry run of a reclassify of 100 lines through the door, 22,000 entries, statistics fresh. */
  reclassifyLargeMs: 460,
} as const;
// The rest of what one run measured (22 Nov 2026; the file took 8.6 minutes): ten imports of 200
// rows, 0.64 s each (at most 1.5 s); the 1,999 lines in 398 s, 132 statements each, 193 ms a line
// (p95 282 ms); a person's badge read while the agent ran, 30 ms (at most 41 ms). At 100 and at
// 500 waiting alike: a listing sends 11 statements; the badge 6 for an Admin and 7 for someone who
// is not (10 and 11 on the read that settles). Their times do grow with the rows they judge: at
// 100 waiting the first page took 32 ms, the badge 15 ms (19 ms settling). The batch of 100 new
// payees, 14 s (1 ran, 99 stale: 90 for the rule position, 9 for a rule saved before them); the
// batch of 100 that all ran, 24 s. 20,000 entries seeded in 14 s. A bill's dry run 108 ms at 2,100
// entries, 127 ms at 22,100 before the statistics were refreshed and 132 ms after (a journal
// entry's 68, 93 and 82 ms), against 13 to 69 ms for a person entering the same; posted through
// the door, 246 ms (bill) and 138 ms (journal entry); the reclassify of 100 lines, 462 ms. A
// second run right after, the machine less busy, took 8 minutes and 0.5 to 0.9 of these times (the
// batch that all ran 14 s, the reclassify 391 ms, the listing of 500 67 ms): the limits are kept
// at three times the busier run.
/** About three times what was measured; never under 50 ms measured, so a pause of the machine is not a failure. */
const LIMIT = (ms: number) => Math.max(ms, 50) * 3;
/** Statements one bank line under a grant sends (131 measured), with room for the work of this wave. */
const MAX_STATEMENTS_FOR_ONE_LINE = 200;
/**
 * How often the badge settles a company's requests: lib/services/agentRequests.ts
 * BADGE_SETTLE_EVERY_MS (not exported). The clock is moved a little past it before a read that is
 * to settle; the test checks such a read sends more statements than one that does not.
 */
const BADGE_SETTLES_EVERY_MS = 60_000;
/** How many times a short read is timed (judged on the median). */
const SAMPLES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIZE = 'bank-transactions.categorize';
const IMPORT = 'import';

let s: Scenario;
let clock: LoadClock;
let bank: { bankAccountId: string; glAccountId: string };
/** What each part measured, printed and written to REPORT_FILE at the end (see the header). */
const report: Record<string, unknown> = {};
const REPORT_FILE = process.env.AGENT_LOAD_REPORT || path.join(os.tmpdir(), 'ironbooks-agent-load-report.json');

beforeAll(async () => {
  // What earlier runs left behind when they could not remove their folder (best effort).
  clearOldLoadRuns();
  // Before the company exists, so every row of it is stamped on the same clock.
  clock = startLoadClock();
  s = await setupScenario(RUN_NAME);
  bank = await addBank(await s.admin.ctx(), 'Operating');
  // The database reads the moved clock too: every time below rests on that.
  clock.jump(5 * 60_000);
  const res = (await s.db.execute(sql`SELECT (extract(epoch from now()) * 1000)::bigint::text AS t`)) as unknown as { rows: Array<{ t: string }> };
  expect(Math.abs(Number(res.rows[0].t) - Date.now())).toBeLessThan(2_000);
}, 240_000);

afterAll(async () => {
  // What was measured, kept in a file (to re-measure before changing MEASURED) and printed (the
  // header says when vitest shows it). Never fails the run.
  let written = '';
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    written = ` (also in ${REPORT_FILE})`;
  } catch {
    /* printed below all the same */
  }
  console.log(`[agent load]${written} ${JSON.stringify(report, null, 1)}`);
  await s?.close();
  clock?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The feed lines of the scenario's bank, by the number in their description (statementRow). */
async function linesByIndex(): Promise<Map<number, { id: string; amount: string; matched: boolean }>> {
  const rows = await s.db
    .select({ id: bankTransactions.id, description: bankTransactions.description, amount: bankTransactions.amount, matched: bankTransactions.matched })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, s.companyId), eq(bankTransactions.bankAccountId, bank.bankAccountId)));
  const out = new Map<number, { id: string; amount: string; matched: boolean }>();
  for (const r of rows) {
    const m = /#(\d{5})$/.exec(r.description ?? '');
    if (m) out.set(Number(m[1]), { id: r.id, amount: String(r.amount), matched: r.matched === true });
  }
  return out;
}

/** A person brings in statement rows themselves (Banking > Import, reviewed rows). */
async function personImport(rows: StatementRow[]): Promise<void> {
  await importTransactions(await s.admin.ctx(), { bankAccountId: bank.bankAccountId, fileType: 'rows', content: '', rows, skipAutoPost: true });
}

const categorizeBody = (lineId: string) => ({ bankTransactionId: lineId, accountId: s.rich.acct['6300'] });

function categorize(agent: ScenarioAgent, lineId: string, requestId: string): Promise<AgentOperationAnswer> {
  return agent.run({ operation: CATEGORIZE, body: categorizeBody(lineId), requestId, reason: 'Adding this month\'s card and bank charges.' });
}

async function grantRow(id: string) {
  const [g] = await s.db.select().from(agentGrants).where(eq(agentGrants.id, id));
  return g;
}

/** The door's claims (agent_requests) and permission requests under one request id of the agent. */
async function traces(agentId: string, requestKey: string): Promise<{ claims: number; requests: number }> {
  const claims = await s.db.select({ id: agentRequests.id }).from(agentRequests).where(and(eq(agentRequests.agentId, agentId), eq(agentRequests.requestKey, requestKey)));
  return { claims: claims.length, requests: await s.requestRows(agentId, requestKey) };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('Expected the call to be refused, and it was not.');
}

function expectExecuted(r: ApproveResult): void {
  expect(r.status, JSON.stringify({ status: r.request.status, error: r.request.error, stale: r.request.stale, grantError: r.request.grantError })).toBe('executed');
}

/** Call a route handler as a request from the agent with this token would reach it. */
async function callRoute(
  // Any route handler: called with the request and the route's own params.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>,
  method: 'GET' | 'POST',
  url: string,
  token: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const pathname = url.split('?')[0];
  const hdrs: Record<string, string> = {
    host: 'localhost:45123',
    authorization: `Bearer ${token}`,
    [ROUTE_PATH_HEADER]: pathname,
    [ROUTE_METHOD_HEADER]: method,
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const own = new Map(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
  const req = new NextRequest(`http://localhost:45123${url}`, { method, headers: hdrs, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const res = await h.store!.run(own, () => handler(req, { params: Promise.resolve(opts.params ?? {}) }));
  return { status: res.status, headers: res.headers, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

/** Wait (real time) until `check` holds, or fail after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const openWaitsOf = (agentId: string) =>
  ((globalThis as typeof globalThis & { __ironbooksAgentWaits?: Map<string, number> }).__ironbooksAgentWaits?.get(agentId) ?? 0);

// ---------------------------------------------------------------------------
// 1. 2,000 bank lines under standing permission
// ---------------------------------------------------------------------------

/** Lines of the October statement the agent brings in. */
const LINES = 2000;
const PER_IMPORT = 200;
/** The grant's amount limit for adding lines. */
const MAX_AMOUNT = '500.00';

/**
 * Line i's amount (money out). Most lines are under the limit; line 1000 is exactly at it (covered:
 * at or below); line 1001 and every line ending in 50 are over it (asked).
 */
function amountOf(i: number): string {
  if (i === 1000) return '500.00';
  if (i === 1001) return '500.01';
  if (i % 100 === 50) return `${750 + (i % 7)}.${String(i % 100).padStart(2, '0')}`;
  return `${((i * 37) % 480) + 5}.${String(i % 100).padStart(2, '0')}`;
}
const overLimit = (i: number) => Money.gt(amountOf(i), MAX_AMOUNT);
/** Lines 1 to 1999 the grant could cover (line 0 is the one asked first). */
const ELIGIBLE = Array.from({ length: LINES - 1 }, (_, k) => k + 1).filter((i) => !overLimit(i)).length;
/** One fewer use than there are lines it could cover: the last one must ask. */
const MAX_USES = ELIGIBLE - 1;

// Relies on order: the first test brings the lines in; the second adds them to the books. The
// describes after it use the company these leave.
describe('2,000 bank lines, brought in and added to the books under standing permission', () => {
  let feeder: ScenarioAgent;
  let pacer: MinutePacer;
  let lines: Map<number, { id: string; amount: string; matched: boolean }>;

  beforeAll(async () => {
    resetAgentRateLimits();
    feeder = await s.makeAgent('Feeder', 'ask_every_change');
    pacer = new MinutePacer(clock, AGENT_CALLS_PER_MINUTE);
  });

  // Bringing statement lines into the feed is prepare work (lib/agent/operations/classes/
  // documents.ts: for an agent the import only stages lines, never posts), which "Ask for every
  // change" allows: the agent's ten imports run straight away and post nothing.
  it('the agent brings in 2,000 statement lines itself: ten imports of 200 rows, staged for review, nothing posted', async () => {
    expect(operationById(IMPORT)?.class).toBe('prepare');
    const statement = Array.from({ length: LINES }, (_, i) => statementRow(i, amountOf));
    const entriesBefore = await agentEntries(feeder.id);
    const times: number[] = [];
    for (let n = 0; n < LINES / PER_IMPORT; n++) {
      pacer.before(1);
      const t = await timed(() =>
        feeder.run({ operation: IMPORT, body: importBody(bank.bankAccountId, statement.slice(n * PER_IMPORT, (n + 1) * PER_IMPORT)), requestId: `load-import-${n + 1}`, reason: 'Bringing in the October statement.' }),
      );
      expect(t.value.outcome, JSON.stringify(t.value).slice(0, 400)).toBe('done');
      expect((t.value.result as { imported?: number }).imported).toBe(PER_IMPORT);
      times.push(t.ms);
    }

    lines = await linesByIndex();
    expect(lines.size).toBe(LINES);
    expect([...lines.values()].every((l) => !l.matched)).toBe(true);
    expect(await agentEntries(feeder.id)).toBe(entriesBefore);
    report.importOf200Ms = { median: median(times), max: Math.max(...times) };
  }, 300_000);

  it('every line is decided by the policy; the grant counts its uses and amount exactly while calls overlap, stops at its limit, and the next call asks', async () => {
    expect(lines?.size).toBe(LINES);
    // Line 0 is asked; the person approves it with "this and similar": at most MAX_AMOUNT a line,
    // MAX_USES lines.
    pacer.before(1);
    const first = await categorize(feeder, lines.get(0)!.id, 'load-line-0');
    expect(first.outcome, JSON.stringify(first).slice(0, 400)).toBe('asked');
    const approval = await timed(() => s.admin.approve(first.requestId!, { grant: { minutes: 240, constraints: { maxAmount: MAX_AMOUNT, maxUses: MAX_USES } } }));
    const approved = approval.value;
    expectExecuted(approved);
    report.approveOneLineMs = approval.ms;
    const grantId = approved.request.grantId!;
    expect(grantId).toMatch(UUID);

    const answers = new Map<number, AgentOperationAnswer>();
    /** Lines that lost the race for the grant's last uses and were sent again. */
    const sentAgain: number[] = [];
    const perLine: number[] = [];
    const badgeUnderLoad: number[] = [];
    const adminCtx = await s.admin.ctx();
    const order = Array.from({ length: LINES - 1 }, (_, k) => k + 1);
    const started = performance.now();
    for (let at = 0, group = 0; at < order.length; at += AGENT_RUNS_AT_ONCE, group++) {
      const batch = order.slice(at, at + AGENT_RUNS_AT_ONCE);
      pacer.before(batch.length);
      const calls = batch.map((i) =>
        categorize(feeder, lines.get(i)!.id, `load-line-${i}`).then(
          (a) => ({ i, a, err: null as unknown }),
          (err: unknown) => ({ i, a: null as AgentOperationAnswer | null, err }),
        ),
      );
      // Now and then, the person's title bar asks for its badge while the agent's group runs:
      // how long a person waits behind the agent (PGlite answers one transaction at a time).
      const badge = group % 25 === 0 ? timed(() => badgeForPerson(adminCtx, { atHost: true })) : null;
      const t = await timed(() => Promise.all(calls));
      if (badge) badgeUnderLoad.push((await badge).ms);
      perLine.push(t.ms / batch.length);
      for (const { i, a, err } of t.value) {
        if (a) {
          answers.set(i, a);
          continue;
        }
        // Two calls that both saw the grant's last use: the one that lost is refused by the use
        // count itself, never run twice. Sent again, it asks.
        expect(err instanceof Error ? err.message : String(err)).toMatch(/standing permission this request was to run under has ended/);
        sentAgain.push(i);
        pacer.before(1);
        answers.set(i, await categorize(feeder, lines.get(i)!.id, `load-line-${i}`));
      }
    }
    const totalMs = Math.round(performance.now() - started);

    // Every line has one answer, decided on its real amount.
    expect(answers.size).toBe(LINES - 1);
    const posted = [...answers].filter(([, a]) => a.outcome === 'posted');
    const asked = [...answers].filter(([, a]) => a.outcome === 'asked');
    expect(posted.length + asked.length, JSON.stringify([...answers].find(([, a]) => a.outcome !== 'posted' && a.outcome !== 'asked'))).toBe(LINES - 1);
    for (const [i, a] of posted) {
      expect(a.grantId, `line ${i}`).toBe(grantId);
      expect(overLimit(i), `line ${i} is over the limit and was posted`).toBe(false);
    }
    // Every line over the limit asked; of the lines under it, all but the one past the grant's
    // last use ran under it.
    const askedOver = asked.filter(([i]) => overLimit(i)).map(([i]) => i);
    const askedUnder = asked.filter(([i]) => !overLimit(i)).map(([i]) => i);
    expect(askedOver.length).toBe(LINES - 1 - ELIGIBLE);
    expect(posted.length).toBe(MAX_USES);
    expect(askedUnder.length).toBe(ELIGIBLE - MAX_USES);
    // The line at exactly the limit is covered; one cent over is not.
    expect(answers.get(1000)?.outcome).toBe('posted');
    expect(answers.get(1001)?.outcome).toBe('asked');

    // The grant's own count is exactly the lines run under it, and it is used up.
    const g = await grantRow(grantId);
    expect(g.uses).toBe(MAX_USES);
    expect((await liveGrants(adminCtx, feeder.id)).map((x) => x.id)).not.toContain(grantId);

    // The amount under the grant: the entries whose audit rows name the grant are exactly one per
    // line it covered, for exactly those lines' amounts.
    const underGrant = await s.db
      .selectDistinct({ id: auditLogs.entityId })
      .from(auditLogs)
      .where(and(eq(auditLogs.agentGrantId, grantId), eq(auditLogs.entityType, 'journal_entry')));
    expect(underGrant.length).toBe(MAX_USES);
    const [{ total }] = await s.db
      .select({ total: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)::text` })
      .from(journalEntryLines)
      .where(
        inArray(
          journalEntryLines.journalEntryId,
          underGrant.map((r) => r.id),
        ),
      );
    const expected = posted.reduce((sum, [i]) => Money.add(sum, amountOf(i)), Money.zero());
    expect(Money.eq(total, expected), `${total} under the grant, ${expected.toFixed(2)} expected`).toBe(true);

    // The books match the answers: every posted line is matched, every asked line still waits,
    // and each ask shows the line's real amount.
    const now = await linesByIndex();
    for (const [i] of posted) expect(now.get(i)?.matched, `line ${i}`).toBe(true);
    for (const [i] of asked) expect(now.get(i)?.matched, `line ${i}`).toBe(false);
    const waiting = await s.admin.requests({ agentId: feeder.id, limit: 500 });
    const byId = new Map(waiting.map((r) => [r.id, r]));
    for (const [i, a] of asked) {
      const card = byId.get(a.requestId!);
      expect(card, `line ${i}`).toBeTruthy();
      expect(Money.eq(card!.amount ?? 'x', amountOf(i)), `line ${i}: ${card!.amount}`).toBe(true);
    }

    report.categorize = {
      lines: LINES - 1,
      posted: posted.length,
      asked: asked.length,
      sentAgainAfterRace: sentAgain.length,
      totalSeconds: Math.round(totalMs / 1000),
      perLineMs: { median: Math.round(median(perLine)), p95: Math.round(percentile(perLine, 0.95)), max: Math.round(Math.max(...perLine)) },
      personBadgeWhileAgentRunsMs: { median: median(badgeUnderLoad), max: Math.max(...badgeUnderLoad) },
    };
    expect(median(perLine)).toBeLessThan(LIMIT(MEASURED.lineMs));
    // The person's one approval that gave the standing permission.
    expect(approval.ms).toBeLessThan(LIMIT(MEASURED.approveFirstMs));
    // A person waits behind what the agent already has under way, never for more than that: the
    // company file answers one transaction at a time, in turn.
    expect(median(badgeUnderLoad)).toBeLessThan(LIMIT(MEASURED.badgeUnderLoadMs));
    expect(Math.max(...badgeUnderLoad)).toBeLessThan(LIMIT(MEASURED.lineMs * AGENT_RUNS_AT_ONCE));
  }, 900_000);
});

// ---------------------------------------------------------------------------
// 2. The rate limit
// ---------------------------------------------------------------------------

// Relies on order: uses the bank and the agent's grant of the test before it in this describe.
describe('the rate limit: too many calls, too many at once', () => {
  let agent: ScenarioAgent;
  let pacer: MinutePacer;
  let grantId: string;
  let lines: Map<number, { id: string; amount: string; matched: boolean }>;
  const FROM = 5000;

  beforeAll(async () => {
    resetAgentRateLimits();
    agent = await s.makeAgent('Hasty', 'ask_every_change');
    pacer = new MinutePacer(clock, AGENT_CALLS_PER_MINUTE);
    await personImport(Array.from({ length: 30 }, (_, k) => statementRow(FROM + k, (i) => `${(i % 90) + 3}.40`, '2026-09')));
    lines = await linesByIndex();
    pacer.before(1);
    const first = await categorize(agent, lines.get(FROM)!.id, 'rate-0');
    expect(first.outcome).toBe('asked');
    const approved = await s.admin.approve(first.requestId!, { grant: { minutes: 60, constraints: { maxAmount: '100.00', maxUses: 20 } } });
    expectExecuted(approved);
    grantId = approved.request.grantId!;
  });

  it(`a call over ${AGENT_CALLS_PER_MINUTE} a minute is refused with a retry time, runs nothing and uses no grant`, async () => {
    pacer.nextMinute();
    // A full minute of calls (each verb is one call, whatever it does).
    for (let n = 0; n < AGENT_CALLS_PER_MINUTE; n += 10) {
      await Promise.all(Array.from({ length: 10 }, () => agent.verb('list_my_requests', { limit: 1 })));
    }
    const line = lines.get(FROM + 1)!;
    const usesBefore = (await grantRow(grantId)).uses;

    const err = await rejection(categorize(agent, line.id, 'rate-1'));
    expect(err).toBeInstanceOf(AgentRateLimited);
    const wait = agentRetryAfter(err)!;
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect((err as Error).message).toMatch(new RegExp(`more than ${AGENT_CALLS_PER_MINUTE} requests in the last minute`));
    expect((err as Error).message).toMatch(/Wait about \d+ seconds?, then carry on\./);

    // Through the route: 429 with Retry-After, and still nothing run.
    const res = await callRoute(actionsPOST, 'POST', AGENT_ACTIONS_PATH, agent.token, {
      body: { verb: 'run_operation', operation: CATEGORIZE, body: categorizeBody(line.id), requestId: 'rate-1', reason: 'Adding a charge.' },
    });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(60);

    // Nothing of it was done: the line still waits, no request id was claimed, no person was
    // asked, the grant was not used.
    expect((await linesByIndex()).get(FROM + 1)?.matched).toBe(false);
    expect(await traces(agent.id, 'rate-1')).toEqual({ claims: 0, requests: 0 });
    expect((await grantRow(grantId)).uses).toBe(usesBefore);

    // Once the wait is over, the same request runs, under the grant.
    clock.jump((wait + 1) * 1000);
    const counter = countStatements(s.db);
    const { value: ran, statements } = await counter.measure(() => categorize(agent, line.id, 'rate-1')).finally(() => counter.stop());
    // How much of the company file one line takes (PGlite answers one statement at a time).
    report.statementsForOneLine = statements;
    expect(ran.outcome, JSON.stringify(ran).slice(0, 300)).toBe('posted');
    expect(ran.grantId).toBe(grantId);
    expect((await grantRow(grantId)).uses).toBe(usesBefore + 1);
    // The counter counted (a broken hook would count nothing), and one line stays a fixed amount
    // of work: 131 statements measured (a dry run, the decision, the commit). A statement more for
    // each rule, line or request of the company would go far past this.
    expect(statements).toBeGreaterThan(20);
    expect(statements).toBeLessThan(MAX_STATEMENTS_FOR_ONE_LINE);
  }, 120_000);

  it(`five runs at once where ${AGENT_RUNS_AT_ONCE} are allowed: one is refused at once, nothing of it is done, and it uses no grant`, async () => {
    pacer.nextMinute();
    const five = [2, 3, 4, 5, 6].map((k) => ({ k, line: lines.get(FROM + k)!, key: `rate-at-once-${k}` }));
    const usesBefore = (await grantRow(grantId)).uses;
    const entriesBefore = await agentEntries(agent.id);

    const settled = await Promise.allSettled(five.map((f) => categorize(agent, f.line.id, f.key)));
    const refused = settled.flatMap((r, n) => (r.status === 'rejected' ? [{ ...five[n], err: r.reason as unknown }] : []));
    const ran = settled.flatMap((r, n) => (r.status === 'fulfilled' ? [{ ...five[n], a: r.value }] : []));
    expect(refused.length).toBe(1);
    expect(ran.length).toBe(AGENT_RUNS_AT_ONCE);
    expect(refused[0].err).toBeInstanceOf(AgentRateLimited);
    expect(agentRetryAfter(refused[0].err)).toBe(2);
    expect((refused[0].err as Error).message).toMatch(new RegExp(`already has ${AGENT_RUNS_AT_ONCE} requests under way`));
    for (const r of ran) {
      expect(r.a.outcome, JSON.stringify(r.a).slice(0, 300)).toBe('posted');
      expect(r.a.grantId).toBe(grantId);
    }

    // The four that ran are whole; the one refused left nothing behind.
    const now = await linesByIndex();
    for (const r of ran) expect(now.get(FROM + r.k)?.matched).toBe(true);
    expect(now.get(FROM + refused[0].k)?.matched).toBe(false);
    expect(await traces(agent.id, refused[0].key)).toEqual({ claims: 0, requests: 0 });
    expect((await grantRow(grantId)).uses).toBe(usesBefore + AGENT_RUNS_AT_ONCE);
    expect(await agentEntries(agent.id)).toBe(entriesBefore + AGENT_RUNS_AT_ONCE);

    // Sent again on its own, it runs.
    const again = await categorize(agent, refused[0].line.id, refused[0].key);
    expect(again.outcome, JSON.stringify(again).slice(0, 1500)).toBe('posted');
    expect((await grantRow(grantId)).uses).toBe(usesBefore + AGENT_RUNS_AT_ONCE + 1);
  }, 120_000);
});

async function agentEntries(agentId: string): Promise<number> {
  const [{ n }] = await s.db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(eq(journalEntries.agentId, agentId));
  return Number(n);
}

// ---------------------------------------------------------------------------
// 3. 500 waiting requests
// ---------------------------------------------------------------------------

/** Agents asking; each asks at most ASKS_PER_HOUR_BEFORE_PAUSE (50) times, so none is paused. */
const ASKERS = 10;
const ASKS_EACH = 50;
let askers: ScenarioAgent[] = [];
/** How a request of the batch approval came back: it ran, or why its new preview made it stale. */
type BatchReason = 'executed' | 'position' | 'ruleMadeEarlier' | 'other';
/**
 * The batch approval of the first test below, for the cases pinned after it: each result, how
 * each came back, and the payee of each one's line (result k is line FROM + k).
 */
let batched: {
  results: ApproveResult[];
  reasons: BatchReason[];
  payees: string[];
  staleBecause: { position: number; ruleMadeEarlier: number; other: string[][] };
} | null = null;

// Relies on order: the company of the describes above. Leaves 400 requests waiting for the long poll below.
describe('500 waiting requests: the list, the badge and a batch approval of 100', () => {
  it('stay within their times, and the statements one listing sends do not grow with the requests', async () => {
    resetAgentRateLimits();
    // Only the 500 below wait: what the tests above left waiting is declined.
    for (const r of await s.admin.requests({ limit: 500 })) await s.admin.deny(r.id, 'Not now.');
    expect((await s.admin.requests({ limit: 500 })).length).toBe(0);

    const FROM = 10_000;
    // Payees the company has not paid before, as a new month's statement brings (NEW_PAYEES).
    await personImport(Array.from({ length: ASKERS * ASKS_EACH }, (_, k) => statementRow(FROM + k, (i) => `${(i % 290) + 7}.15`, '2026-08', NEW_PAYEES)));
    const lines = await linesByIndex();
    askers = [];
    for (let n = 1; n <= ASKERS; n++) askers.push(await s.makeAgent(`Asker ${n}`, 'ask_every_change'));

    // The first two ask through the door, four calls at a time (the 100 a person approves together).
    const viaDoor: string[] = [];
    let template: AgentRequestView | null = null;
    for (const [n, agent] of askers.slice(0, 2).entries()) {
      for (let k = 0; k < ASKS_EACH; k += AGENT_RUNS_AT_ONCE) {
        const ks = Array.from({ length: Math.min(AGENT_RUNS_AT_ONCE, ASKS_EACH - k) }, (_, j) => k + j);
        const got = await Promise.all(ks.map((j) => categorize(agent, lines.get(FROM + n * ASKS_EACH + j)!.id, `wait-${n}-${j}`)));
        for (const a of got) {
          expect(a.outcome, JSON.stringify(a).slice(0, 300)).toBe('asked');
          viaDoor.push(a.requestId!);
        }
      }
    }
    expect(viaDoor.length).toBe(2 * ASKS_EACH);

    const counter = countStatements(s.db);
    const READS = ['firstPage', 'all', 'badgeSettling', 'badge', 'benSettling', 'benBadge'] as const;
    /**
     * `run` SAMPLES times, one after the other (`before` ahead of each, outside the time): the
     * median time, the most statements one sent, the last answer.
     */
    const sampled = async <T>(run: () => Promise<T>, before?: () => void) => {
      const ms: number[] = [];
      const statements: number[] = [];
      let value: T | undefined;
      for (let k = 0; k < SAMPLES; k++) {
        before?.();
        const t0 = performance.now();
        const m = await counter.measure(run);
        ms.push(performance.now() - t0);
        statements.push(m.statements);
        value = m.value;
      }
      return { value: value as T, ms: Math.round(median(ms)), statements: Math.max(...statements), samplesMs: ms.map(Math.round) };
    };
    // A read of the badge that settles the company's requests (the first after its minute is up),
    // as the title bar's poll does once a minute; the reads in between do not.
    const pastTheBadgesMinute = () => clock.jump(BADGE_SETTLES_EVERY_MS + 1_000);
    const measure = async (label: string) => {
      const ctx = await s.admin.ctx();
      const ben = await s.second.ctx();
      const firstPage = await sampled(() => listRequestsForPerson(ctx, { status: 'pending', atHost: true }));
      const all = await sampled(() => listRequestsForPerson(ctx, { status: 'pending', atHost: true, limit: 500 }));
      const badgeSettling = await sampled(() => badgeForPerson(ctx, { atHost: true }), pastTheBadgesMinute);
      const badge = await sampled(() => badgeForPerson(ctx, { atHost: true }));
      const benSettling = await sampled(() => badgeForPerson(ben, { atHost: true }), pastTheBadgesMinute);
      const benBadge = await sampled(() => badgeForPerson(ben, { atHost: true }));
      report[`waiting${label}`] = {
        list100: { ms: firstPage.ms, samplesMs: firstPage.samplesMs, statements: firstPage.statements, rows: firstPage.value.length },
        list500: { ms: all.ms, samplesMs: all.samplesMs, statements: all.statements, rows: all.value.length },
        badgeAdminSettling: { ms: badgeSettling.ms, samplesMs: badgeSettling.samplesMs, statements: badgeSettling.statements, pending: badgeSettling.value.pending },
        badgeAdmin: { ms: badge.ms, samplesMs: badge.samplesMs, statements: badge.statements, pending: badge.value.pending },
        badgeNotAdminSettling: { ms: benSettling.ms, samplesMs: benSettling.samplesMs, statements: benSettling.statements, pending: benSettling.value.pending },
        badgeNotAdmin: { ms: benBadge.ms, samplesMs: benBadge.samplesMs, statements: benBadge.statements, pending: benBadge.value.pending },
      };
      return { firstPage, all, badgeSettling, badge, benSettling, benBadge };
    };
    /** The reads at 100 and at 500 waiting. */
    type Reads = Awaited<ReturnType<typeof measure>>;
    /** The counter counted, and a read that was to settle did: it sent more than the reads in between. */
    const counted = (at: Reads, waiting: number) => {
      for (const read of READS) expect(at[read].statements, `${read} at ${waiting} waiting`).toBeGreaterThan(0);
      expect(at.badgeSettling.statements, `the badge's settling read at ${waiting} waiting`).toBeGreaterThan(at.badge.statements);
      expect(at.benSettling.statements, `the badge's settling read at ${waiting} waiting`).toBeGreaterThan(at.benBadge.statements);
    };

    let at100: Reads;
    let at500: Reads;
    try {
      at100 = await measure('100');
      expect(at100.all.value.length).toBe(100);
      expect(at100.badge.value.pending).toBe(100);
      counted(at100, 100);
      template = (at100.all.value.find((r) => r.id === viaDoor[0]) ?? null) as AgentRequestView | null;
      expect(template?.preview).toBeTruthy();

      // The other eight agents ask through the requests service the door uses (createAgentRequest,
      // with each agent's own context), each with a preview of the same shape: 50 asks each.
      const op = operationById(CATEGORIZE)!;
      for (const [n, agent] of askers.slice(2).entries()) {
        const ctx = await agent.ctx();
        for (let j = 0; j < ASKS_EACH; j++) {
          const i = FROM + (n + 2) * ASKS_EACH + j;
          const input = { body: categorizeBody(lines.get(i)!.id) };
          const facts: RequestFacts = { confirm: [], reveal: false, amount: Money.abs(lines.get(i)!.amount).toFixed(2), count: null, entityIds: [], accountIds: [s.rich.acct['6300']], date: '2026-08-01', closedPeriod: false };
          await createAgentRequest(ctx, {
            kind: 'operation',
            requestKey: `wait-${n + 2}-${j}`,
            operation: op,
            input,
            reason: 'Adding this month\'s card and bank charges.',
            summary: describeRequest(op, input),
            effectiveClass: 'enter',
            needs: template!.needs!,
            facts,
            preview: template!.preview,
            stalenessKey: null,
          });
        }
      }

      at500 = await measure('500');
      expect(at500.firstPage.value.length).toBe(100);
      expect(at500.all.value.length).toBe(500);
      expect(at500.badge.value.pending).toBe(500);
      expect(at500.benBadge.value.pending).toBe(500);
      counted(at500, 500);

      // Statements per read do not grow with the requests: five times the requests, the same
      // number of statements (a few more allowed for what settling finds to do).
      for (const read of READS) expect(at500[read].statements, read).toBeLessThanOrEqual(at100[read].statements + 5);
    } finally {
      counter.stop();
    }

    // A batch approval of the 100 asked through the door: each is approved and run on its own (in
    // the order asked: result k is line FROM + k). Nothing fails; one that comes back "the books
    // changed" ran nothing and still waits.
    const shown = new Map((await listRequestsForPerson(await s.admin.ctx(), { status: 'pending', atHost: true, limit: 500 })).map((r) => [r.id, r.preview]));
    const t = await timed(() => s.admin.batch(viaDoor));
    const byStatus: Record<string, number> = {};
    for (const r of t.value) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    // How each came back, and for each stale one why: what its new preview shows that the person
    // was not shown (test/agentLoadScenario.ts previewDifferences). The evidence for the two cases
    // pinned below.
    const staleBecause = { position: 0, ruleMadeEarlier: 0, other: [] as string[][] };
    const reasons: BatchReason[] = t.value.map((r) => {
      if (r.status === 'executed') return 'executed';
      const d = previewDifferences(shown.get(r.request.id), r.request.preview);
      if (r.status === 'stale' && d.length && d.every((x) => x.startsWith('transaction_rule.priority:'))) {
        staleBecause.position += 1;
        return 'position';
      }
      if (r.status === 'stale' && d.some((x) => x.startsWith('transaction_rule create: [(record)] then []')) && d.every((x) => x.startsWith('transaction_rule'))) {
        staleBecause.ruleMadeEarlier += 1;
        return 'ruleMadeEarlier';
      }
      staleBecause.other.push([r.status, ...d]);
      return 'other';
    });
    batched = { results: t.value, reasons, payees: t.value.map((_, k) => NEW_PAYEES[(FROM + k) % NEW_PAYEES.length]), staleBecause };
    const executed = byStatus.executed ?? 0;
    const stale = byStatus.stale ?? 0;
    report.batch100 = { ms: t.ms, byStatus, staleBecause: { ...staleBecause, other: staleBecause.other.slice(0, 3) } };
    expect(t.value.length).toBe(100);
    const after = await linesByIndex();
    t.value.forEach((r, k) => {
      expect(r.request.id).toBe(viaDoor[k]);
      expect(['executed', 'stale'], `${r.status}: ${r.request.error ?? ''}`).toContain(r.status);
      expect(after.get(FROM + k)?.matched, `line ${FROM + k}`).toBe(r.status === 'executed');
      if (r.status === 'stale') expect(r.request.status).toBe('pending');
    });
    // Nothing is stale for a reason other than the two pinned below.
    expect(staleBecause.other, JSON.stringify(staleBecause.other.slice(0, 3))).toEqual([]);

    // The times, last, so a slow read does not keep the batch above from being looked at.
    expect(at500.firstPage.ms).toBeLessThan(LIMIT(MEASURED.list100Ms));
    expect(at500.all.ms).toBeLessThan(LIMIT(MEASURED.list500Ms));
    expect(at500.badgeSettling.ms).toBeLessThan(LIMIT(MEASURED.badgeSettlingMs));
    expect(at500.benSettling.ms).toBeLessThan(LIMIT(MEASURED.badgeSettlingMs));
    expect(at500.badge.ms).toBeLessThan(LIMIT(MEASURED.badgeMs));
    expect(at500.benBadge.ms).toBeLessThan(LIMIT(MEASURED.badgeMs));
    // An approval that runs costs a dry run and a commit; one that comes back stale a dry run.
    expect(t.ms).toBeLessThan(LIMIT(executed * MEASURED.approveMs + stale * MEASURED.staleApproveMs));
  }, 600_000);

  // DEFECT, pinned (owner: lib/agent/bridge.ts, the staleness key). Approving 100 waiting requests
  // to add bank lines in one batch, 90 came back "the books changed" (status 'stale') though
  // nothing they read or change had changed. Adding a payee's first line also teaches Ironbooks a
  // bank rule (POST /api/bank-transactions/categorize, learnRuleFromChoice), and the new rule's
  // `priority` is the next free position. Every approval before it that made a rule moved that
  // position, so the new preview differs from the one shown only in transaction_rule.priority
  // ("[21] then [22]") and in the entry number, which the key already leaves out (compared by
  // test/agentLoadScenario.ts previewDifferences, which keeps every reference to a record that
  // existed: the line, the account, the rule). The decision for
  // this wave: the key leaves out everything the run assigns to itself, the next number it takes
  // included; the next position is one of those. Passes once a made record's next position is left
  // out of the key like its number.
  // Skipped, not failed, when the batch above did not run (this file run with -t): without it this
  // case would count any failure as the defect.
  it.fails('a batch approval of 100: none comes back stale for the next rule position the approvals before it took', (ctx) => {
    if (!batched) ctx.skip('The batch approval of the case above did not run (run the file whole): without it this pin proves nothing.');
    expect(batched!.staleBecause.position).toBe(0);
  });

  // Pinned as RIGHT, not a defect. A line whose payee an approval earlier in the batch already
  // taught Ironbooks comes back 'stale': its run no longer saves the bank rule the person was shown
  // ("transaction_rule create: [(record)] then []"), because learnRuleFromChoice reads the live
  // rules (activeBankRules, pickRule) and saves none when one covers the payee. That rule existed
  // before this run and this run reads it, so the key covers it (the decision: the records the run
  // reads and changes that existed before it), and the card the person said yes to no longer says
  // what would happen. They say yes again on the new preview.
  it('a batch approval of 100: a line whose payee an approval before it taught comes back stale, rightly: its run no longer saves the rule the person was shown', () => {
    expect(batched, 'The batch approval of the case above did not run (run the file whole).').not.toBeNull();
    const { results, reasons, payees } = batched!;
    const taught = new Set<string>();
    let expected = 0;
    results.forEach((r, k) => {
      if (taught.has(payees[k])) {
        expected += 1;
        expect(r.status, `result ${k}`).toBe('stale');
        expect(reasons[k], `result ${k}`).toBe('ruleMadeEarlier');
      } else {
        expect(reasons[k], `result ${k}`).not.toBe('ruleMadeEarlier');
      }
      if (r.status === 'executed') taught.add(payees[k]);
    });
    // Ten payees, ten lines each: at least the nine later lines of the first payee.
    expect(expected).toBeGreaterThanOrEqual(9);
    expect(batched!.staleBecause.ruleMadeEarlier).toBe(expected);
  });

  // Relies on order: the lines of part 1 taught Ironbooks a rule for each of PAYEES, for 6300.
  it('a batch approval of 100 that all run (payees the company has rules for) stays within its time', async () => {
    resetAgentRateLimits();
    const FROM = 20_000;
    await personImport(Array.from({ length: 2 * ASKS_EACH }, (_, k) => statementRow(FROM + k, (i) => `${(i % 290) + 7}.65`, '2026-07')));
    const lines = await linesByIndex();
    const pair = [await s.makeAgent('Asker 11', 'ask_every_change'), await s.makeAgent('Asker 12', 'ask_every_change')];
    const ids: string[] = [];
    for (const [n, agent] of pair.entries()) {
      for (let k = 0; k < ASKS_EACH; k += AGENT_RUNS_AT_ONCE) {
        const ks = Array.from({ length: Math.min(AGENT_RUNS_AT_ONCE, ASKS_EACH - k) }, (_, j) => k + j);
        const got = await Promise.all(ks.map((j) => categorize(agent, lines.get(FROM + n * ASKS_EACH + j)!.id, `all-run-${n}-${j}`)));
        for (const a of got) {
          expect(a.outcome, JSON.stringify(a).slice(0, 300)).toBe('asked');
          ids.push(a.requestId!);
        }
      }
    }
    // What each card shows: no rule saved or moved (each payee has its rule, for this account).
    for (const agent of pair) {
      for (const r of await s.admin.requests({ agentId: agent.id, limit: ASKS_EACH })) {
        expect((r.preview?.records ?? []).filter((x) => x.kind === 'transaction_rule'), r.id).toEqual([]);
      }
    }

    const t = await timed(() => s.admin.batch(ids));
    const byStatus: Record<string, number> = {};
    for (const r of t.value) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    report.batch100AllRun = { ms: t.ms, perApprovalMs: Math.round(t.ms / ids.length), byStatus };
    expect(t.value.length).toBe(2 * ASKS_EACH);
    const after = await linesByIndex();
    t.value.forEach((r, k) => {
      expect(r.request.id).toBe(ids[k]);
      expectExecuted(r);
      expect(after.get(FROM + k)?.matched, `line ${FROM + k}`).toBe(true);
    });
    // How long "approve 100" holds a person's window when all 100 run.
    expect(t.ms).toBeLessThan(LIMIT(MEASURED.batchAllRunMs));
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 4. One large company
// ---------------------------------------------------------------------------

const SEEDED = 20_000;

describe(`one large company: ${SEEDED.toLocaleString('en-US')} journal entries more`, () => {
  it(`a bridged dry run of a bill and of a journal entry stays well under BRIDGE_TIME_LIMIT_MS (${BRIDGE_TIME_LIMIT_MS} ms)`, async () => {
    resetAgentRateLimits();
    const bookkeeper = await s.makeAgent('Bookkeeper', 'trusted_bookkeeper');
    const acct = s.rich.acct;
    const bill = (n: number) => ({ vendorId: s.rich.vendorId, billNumber: `LOAD-${n}`, date: '2026-11-09', lines: [{ accountId: acct['6300'], description: 'Office supplies', amount: '84.20' }] });
    const journal = () => ({ date: '2026-11-09', description: 'Accrue the month\'s rent', lines: [{ accountId: acct['6300'], debit: '1200.00' }, { accountId: acct['1000'], credit: '1200.00' }] });

    let n = 0;
    const dryRuns = async () => {
      const billMs: number[] = [];
      const jeMs: number[] = [];
      for (let k = 0; k < 3; k++) {
        const b = await timed(() => bookkeeper.run({ operation: 'bills.create', body: bill((n += 1)), dryRun: true }));
        expect(b.value.outcome, JSON.stringify(b.value).slice(0, 300)).toBe('dry_run');
        billMs.push(b.ms);
        const j = await timed(() => bookkeeper.run({ operation: 'journal-entries.create', body: journal(), dryRun: true }));
        expect(j.value.outcome, JSON.stringify(j.value).slice(0, 300)).toBe('dry_run');
        jeMs.push(j.ms);
      }
      return { bill: median(billMs), journal: median(jeMs) };
    };

    // The same work entered by a person (the services the routes call, no bridge): what the
    // company file itself costs, beside what the bridge adds.
    const byPerson = async () => {
      const ctx = await s.admin.ctx();
      const day = new Date('2026-11-09T12:00:00Z');
      const b = await timed(() => createBill(ctx, { vendorId: s.rich.vendorId, billNumber: `PERSON-${(n += 1)}`, date: day, lines: [{ accountId: acct['6300'], description: 'Office supplies', amount: '84.20' }] } as Parameters<typeof createBill>[1]));
      const j = await timed(() => postJournalEntry(ctx, { date: day, description: 'Petty cash', lines: [{ accountId: acct['6300'], debit: '10.00' }, { accountId: acct['1000'], credit: '10.00' }] }));
      return { bill: b.ms, journal: j.ms };
    };

    const entries = async () => Number((await s.db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(eq(journalEntries.companyId, s.companyId)))[0].n);
    const before = { entries: await entries(), ...(await dryRuns()), person: await byPerson() };
    const seeding = await timed(() => seedJournal(s.db, s.companyId, s.admin.id, SEEDED, { debit: acct['6300'], credit: acct['1000'] }));
    // Right after the entries arrived, the planner still plans from the smaller company it last
    // measured (PGlite has no background ANALYZE): the worst case.
    const unanalyzed = { entries: await entries(), ...(await dryRuns()), person: await byPerson() };
    // Then as the company file is when it is opened (lib/db/index.ts: tables that grew a lot are
    // analyzed): the everyday case.
    await refreshPlannerStats(s.db, 'load test', { staleOnly: true });
    const after = { entries: await entries(), ...(await dryRuns()), person: await byPerson() };
    expect(after.entries).toBe(before.entries + SEEDED + 4);

    // And a real one of each on the large company: the door tries it (a dry run), then commits,
    // and the commit reads the journal as the dry run does.
    const postedBill = await timed(() => bookkeeper.run({ operation: 'bills.create', body: bill((n += 1)), requestId: 'large-bill' }));
    expect(postedBill.value.outcome).toBe('posted');
    const postedJe = await timed(() => bookkeeper.run({ operation: 'journal-entries.create', body: journal(), requestId: 'large-je' }));
    expect(postedJe.value.outcome).toBe('posted');

    // The heaviest form of the scan (WAVE3 bridge finding 2): a reclassify rewrites posted lines,
    // so the bridge also reads every journal line of the company. A dry run of 100 seeded lines.
    const reclassifier = await s.makeAgent('Reclassifier', 'full_with_asks');
    const seededLines = await s.db
      .select({ id: journalEntryLines.id, entryId: journalEntryLines.journalEntryId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(eq(journalEntries.companyId, s.companyId), eq(journalEntryLines.memo, 'Seeded'), eq(journalEntryLines.accountId, acct['6300'])))
      .orderBy(sql`${journalEntries.date} desc`)
      .limit(100);
    expect(new Set(seededLines.map((l) => l.entryId)).size).toBe(100);
    const reclassify = await timed(() =>
      reclassifier.run({ operation: 'accountant.reclassify.apply', body: { lineIds: seededLines.map((l) => l.id), newAccountId: acct['6200'] }, dryRun: true }),
    );
    expect(reclassify.value.outcome, JSON.stringify(reclassify.value).slice(0, 400)).toBe('dry_run');
    // It was really tried and rewrote the 100 lines (a dry run the door could not try, a closed
    // period say, answers 'dry_run' too, with nothing timed): the route's answer counts them, and
    // the preview shows each of their entries with the line moved to 6200 and none left on 6300.
    expect(reclassify.value.result, JSON.stringify(reclassify.value).slice(0, 400)).toMatchObject({ linesChanged: 100, entriesChanged: 100 });
    const shownEntries = new Map((reclassify.value.preview?.ledger?.entries ?? []).map((e) => [e.journalEntryId.toLowerCase(), e]));
    for (const { entryId } of seededLines) {
      const e = shownEntries.get(entryId.toLowerCase());
      expect(e, `entry ${entryId} in the preview`).toBeTruthy();
      const accountsOf = e!.lines.map((l) => l.accountId.toLowerCase());
      expect(accountsOf, `entry ${entryId}`).toContain(acct['6200'].toLowerCase());
      expect(accountsOf, `entry ${entryId}`).not.toContain(acct['6300'].toLowerCase());
    }

    report.largeCompany = {
      seededEntries: SEEDED,
      seedingSeconds: Math.round(seeding.ms / 1000),
      before,
      unanalyzed,
      after,
      postedThroughTheDoorMs: { bill: postedBill.ms, journal: postedJe.ms },
      reclassify100DryRunMs: reclassify.ms,
    };
    // Well under the bridge's own limit (a quarter of it at most; a run through the door is a dry
    // run and a commit, two bridged runs), and within three times what was measured.
    for (const ms of [unanalyzed.bill, unanalyzed.journal]) expect(ms).toBeLessThan(BRIDGE_TIME_LIMIT_MS / 4);
    for (const ms of [after.bill, after.journal]) {
      expect(ms).toBeLessThan(BRIDGE_TIME_LIMIT_MS / 4);
      expect(ms).toBeLessThan(LIMIT(MEASURED.dryRunLargeMs));
    }
    for (const ms of [postedBill.ms, postedJe.ms]) expect(ms).toBeLessThan(LIMIT(2 * MEASURED.dryRunLargeMs));
    expect(reclassify.ms).toBeLessThan(BRIDGE_TIME_LIMIT_MS / 4);
    expect(reclassify.ms).toBeLessThan(LIMIT(MEASURED.reclassifyLargeMs));
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 5. The long poll: at most WAITS_PER_AGENT open waits per agent
// ---------------------------------------------------------------------------

// Relies on order: the requests the describe above left waiting (Askers 3 to 10).
describe(`the long poll: at most ${WAITS_PER_AGENT} open waits per agent`, () => {
  it('one wait more is answered at once with 429 and Retry-After; a slot comes back when a wait ends; another agent is not held back', async () => {
    const agent = askers[2];
    const other = askers[3];
    expect(agent).toBeTruthy();
    const mine = (await s.admin.requests({ agentId: agent.id, limit: 50 })).map((r) => r.id);
    const theirs = (await s.admin.requests({ agentId: other.id, limit: 50 })).map((r) => r.id);
    expect(mine.length).toBeGreaterThanOrEqual(WAITS_PER_AGENT + 2);
    expect(openWaitsOf(agent.id)).toBe(0);

    const wait = (who: ScenarioAgent, id: string, seconds = 50) =>
      callRoute(waitGET, 'GET', `/api/agent/requests/${id}?wait=${seconds}`, who.token, { params: { id } });

    // Four waits open and stay open.
    const open = mine.slice(0, WAITS_PER_AGENT).map((id) => wait(agent, id));
    await until(() => openWaitsOf(agent.id) === WAITS_PER_AGENT, 20_000, 'four waits to open');

    // One more is answered at once, and nothing waits for it.
    const fifth = await timed(() => wait(agent, mine[WAITS_PER_AGENT]));
    expect(fifth.value.status).toBe(429);
    expect(fifth.value.body.code).toBe('RATE_LIMITED');
    expect(fifth.value.headers.get('retry-after')).toBe('5');
    expect(String(fifth.value.body.error)).toMatch(/already waiting on 4 requests at once/);
    expect(fifth.ms).toBeLessThan(5_000);
    expect(openWaitsOf(agent.id)).toBe(WAITS_PER_AGENT);

    // Reading a request without waiting is never held back.
    const read = await wait(agent, mine[WAITS_PER_AGENT], 0);
    expect(read.status).toBe(200);
    expect((read.body.request as { id?: string })?.id).toBe(mine[WAITS_PER_AGENT]);

    // Another agent's wait is its own.
    const otherWait = wait(other, theirs[0]);
    await until(() => openWaitsOf(other.id) === 1, 20_000, "the other agent's wait to open");

    // A person decides one: that wait answers, and its slot comes back.
    await s.admin.deny(mine[0], 'Not this one.');
    const first = await timed(() => open[0]);
    expect(first.value.status).toBe(200);
    expect((first.value.body.request as { status?: string }).status).toBe('denied');
    await until(() => openWaitsOf(agent.id) === WAITS_PER_AGENT - 1, 10_000, 'the slot to come back');
    const reopened = wait(agent, mine[WAITS_PER_AGENT]);
    await until(() => openWaitsOf(agent.id) === WAITS_PER_AGENT, 20_000, 'the new wait to open');
    expect((await wait(agent, mine[WAITS_PER_AGENT + 1])).status).toBe(429);

    // Everything decided: every wait answers, and no slot is left held.
    for (const id of [...mine.slice(1, WAITS_PER_AGENT + 1), theirs[0]]) await s.admin.deny(id, 'Not now.');
    const answered = await timed(() => Promise.all([...open.slice(1), reopened, otherWait]));
    for (const r of answered.value) {
      expect(r.status).toBe(200);
      expect((r.body.request as { status?: string }).status).toBe('denied');
    }
    expect(answered.ms).toBeLessThan(10_000);
    expect(openWaitsOf(agent.id)).toBe(0);
    expect(openWaitsOf(other.id)).toBe(0);
  }, 120_000);
});
