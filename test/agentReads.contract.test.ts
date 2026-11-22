/**
 * Agent full access, read purity (plan §10 "Read purity", Phase 2): every operation of the
 * registry that an agent can run as a read (class 'read', and 'read_sensitive', which the bridge
 * also only ever reads) runs through the real route bridge (lib/agent/bridge.ts runOperation,
 * mode 'read') on a real PGlite company, and
 *  - answers without an error, and
 *  - leaves the database as it was: row counts of every table and max(updated_at) where a table
 *    has one (test/helpers/agentReadsFixture.ts fingerprint), and the transaction log length.
 *
 * The cases are generated from the registry (lib/agent/operations/registry.ts): an operation that
 * needs no path values runs as it is, with the query or body it needs (QUERY_OF and BODY_OF in the
 * fixture); one that reads one record gets an id the fixture seeded; the standard reports run once
 * per report key, the simple lists once per list. A case that cannot be exercised here is on the
 * KNOWN list with its reason, and that list may only get shorter (KNOWN_MAX).
 *
 * A read that writes, or that the read-only handle stops from writing, is a FINDING: it stays on
 * WRITES as an it.fails case naming it and what it writes. Such a case turns red the day the read
 * stops writing (take it off then), and also if it stops being run at all. Some reads would write
 * only the first time (a default list made on first use), so every case is first run once on the
 * company before anyone opened those lists, and any write found there that is not on WRITES fails;
 * then the first-use records are made and every case runs again. The decision is that a read from
 * an agent never makes a first-use default (the default inventory site, the default payroll items)
 * and answers as if none existed yet: FIRST_USE names the reads that make one for a person, and
 * each must answer an agent cleanly on that company and leave it without one.
 *
 * Each case also runs asked as a dry run: the bridge still only reads it (on the read-only handle),
 * but then reports what the work asked to send, save or print, which a read drops unseen (the
 * effects outbox captures it). A read that asks for an email, a file or a print job is a finding.
 *
 * Two more lists: REFUSED_BY_DESIGN (reads refused to agents on purpose: they must stay refused)
 * and NOT_FOR_AGENTS (FINDINGS: reads the registry offers to agents whose route refuses every
 * agent, it.fails like WRITES). KNOWN and these two live in the fixture, as the masking test
 * leaves out exactly the same reads. The person-only reads (PERSON_ONLY: a person's own list of
 * company files, and who can open the protected file) are not offered to agents at all, and the
 * bridge refuses them.
 *
 * One company for the whole file; the operations run in a few groups that loop. The agent's role
 * is Admin, so the role refuses nothing a read needs; a read_sensitive operation runs as an
 * approved reveal would (some refuse a masked caller outright), since whether a read writes does
 * not depend on what it shows. Masking is test/agentMasking.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-reads-contract');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-reads-contract-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
process.env.BKA_AGENT_FILES_DIR = path.join(ROOT, 'agent-files');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.BKA_COMPANY_STATE;

import { sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { READ_ONLY_MESSAGE } from '@/lib/db/readOnly';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import { SIMPLE_LIST_KEYS } from '@/lib/services/lists/simpleLists';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import { allOperations, operationById } from '@/lib/agent/operations/registry';
import type { Operation } from '@/lib/agent/operations/types';
import type { BridgeResult } from '@/lib/agent/contract';
import { runOperation } from '@/lib/agent/bridge';
import {
  KNOWN,
  KNOWN_MAX,
  LEFT_OUT,
  NOT_FOR_AGENTS,
  REFUSED_BY_DESIGN,
  buildCases,
  fingerprint,
  fingerprintDiff,
  makeReadsAgent,
  opOfLabel as opAmong,
  seedAgentRequest,
  seedFirstUseRecords,
  seedReadsCompany,
  type CasesFor,
  type ReadCase,
  type ReadsAgent,
  type ReadsCompany,
} from './helpers/agentReadsFixture';

// ---------------------------------------------------------------------------
// The reads that write (findings). What cannot be run here is in the fixture (KNOWN and the rest).
// ---------------------------------------------------------------------------

/**
 * Reads that write, or that the read-only handle stopped from writing, by case label (the
 * operation id when it has one case, else "<operation id> <report key, list or kind>": one entry
 * excuses one case, never every kind of an operation at once): what they write. Each is an
 * it.fails case, run on the company before anyone opened the lists that are seeded on first use
 * (seedFirstUseRecords comes after; the same reads must then run cleanly in the groups below).
 * Take one off when its route is fixed. The pass over every case on that company fails on a write
 * that is not here.
 *
 * Empty since wave 5: the five first-use reads that were here (the inventory site list, its
 * reorder points and by-site reports, Serial/Lot in Stock, the payroll item list) make nothing for
 * an agent any more, and FIRST_USE below holds them to that.
 */
const WRITES: Record<string, string> = {};

/**
 * The reads that make a default on a person's first call, by case label (an operation id stands
 * for all its cases): what they would make, and what stops it for an agent. Decision: a read from
 * an agent, or from any read-only context, never makes it; it answers as if nothing existed yet.
 * Each runs on the company before anyone opened these lists, as a read and as a dry run, and must
 * answer cleanly and make nothing.
 */
const FIRST_USE: Record<string, string> = {
  'inventory-sites.list': 'the default inventory site (lib/services/inventorySites.ts listSites: defaultSiteForRead)',
  'inventory-sites.reorder-points': 'the default inventory site (lib/services/inventorySiteOps.ts listSiteReorderPoints: defaultSiteForRead)',
  'inventory-sites.reports':
    'the default inventory site, by every kind (lib/services/inventorySiteReports.ts loadSites, lib/services/inventorySites.ts siteQuantities: defaultSiteForRead)',
  'reports.std.get serial-lot-in-stock': 'the default inventory site (lib/services/inventorySites.ts serialsInStock: defaultSiteForRead)',
  'payroll-items.list':
    'the default payroll items (app/api/payroll-items/route.ts skips them for an agent; lib/services/payrollItems.ts ensureDefaultPayrollItems makes none in a read-only context)',
};

/** The tables a first-use default lands in: empty before the first use, and after every FIRST_USE read. */
const FIRST_USE_TABLES = ['inventory_sites', 'payroll_items'] as const;

/**
 * A person's own reads (decision): GET /api/companies (the company files the signed-in person
 * belongs to) and GET /api/file-protection (who can open the protected file). They are not offered
 * to agents at all, and the bridge refuses them.
 */
const PERSON_ONLY = ['companies.list', 'file-protection.status'] as const;

// ---------------------------------------------------------------------------

let db: DB;
let fx: ReadsCompany;
let casesFor: CasesFor;
let agent: ReadsAgent;

const READ_OPS: readonly Operation[] = allOperations().filter(
  (o) => o.kind === 'route' && o.availability === 'agent' && (o.class === 'read' || o.class === 'read_sensitive'),
);

/** The operation a case label belongs to (the longest operation id it starts with). */
const opOfLabel = (label: string): Operation | undefined => opAmong(label, READ_OPS);

/** The cases of one label: every case of an operation-level label, else the one case. */
function casesOfLabel(label: string): { op: Operation; cases: ReadCase[] | null } {
  const op = opOfLabel(label)!;
  const all = casesFor(op);
  if (label === op.id) return { op, cases: all };
  return { op, cases: all ? all.filter((c) => c.label === label) : null };
}

/** The groups the operations run in (by operation id, so a group's members stay stable). */
const GROUPS = 6;
function groupOf(op: Operation): number {
  let n = 0;
  for (const c of op.id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % GROUPS;
}

async function snapshot() {
  return { fp: await fingerprint(db), log: readAllTransactionLog(TEST_DIR).records.length };
}

/** One run of a case, with what it changed. */
async function runCase(op: Operation, c: ReadCase, mode: 'read' | 'dry_run'): Promise<{ r: BridgeResult | null; threw: string | null; wrote: string[] }> {
  const before = await snapshot();
  let r: BridgeResult | null = null;
  let threw: string | null = null;
  try {
    r = await runOperation(agent.base, op, c.input, mode, op.class === 'read_sensitive' ? { ...agent.actor, reveal: true } : agent.actor);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  const after = await snapshot();
  const wrote = fingerprintDiff(before.fp, after.fp);
  if (after.log !== before.log) wrote.push(`transaction log: ${before.log} -> ${after.log} records`);
  return { r, threw, wrote };
}

const errorOf = (r: BridgeResult) => (r.error ? `${r.httpStatus} ${r.error.code ?? ''} ${r.error.message}`.trim() : '');

/** The write one run made or tried to make ("<label>: WROTE …" / "TRIED TO WRITE …"), or null. */
function writeOf(c: ReadCase, run: Awaited<ReturnType<typeof runCase>>): string | null {
  if (run.wrote.length) return `${c.label}: WROTE ${run.wrote.join('; ')}`;
  const msg = run.r ? errorOf(run.r) : '';
  if (msg.includes(READ_ONLY_MESSAGE)) return `${c.label}: TRIED TO WRITE (${msg})`;
  return null;
}

/**
 * What went wrong running one case: null when it read cleanly. It runs twice: as a read (what an
 * agent's read is), then asked as a dry run, which the bridge still only reads (on the read-only
 * handle) but which also reports what the work asked to send, save or print (the effects outbox
 * captures those in a read and drops them unseen). A read that asks for one is a finding too.
 */
async function problemOf(op: Operation, c: ReadCase): Promise<string | null> {
  const read = await runCase(op, c, 'read');
  // A write is reported even when the handler then threw.
  const wrote = writeOf(c, read);
  if (wrote) return wrote;
  if (read.threw) return `${c.label}: threw ${read.threw}`;
  const r = read.r!;
  if (r.outcome !== 'ok') return `${c.label}: ${r.outcome} ${errorOf(r)}`;
  const asDry = await runCase(op, c, 'dry_run');
  if (asDry.threw) return `${c.label}: threw ${asDry.threw} (asked as a dry run)`;
  if (asDry.wrote.length) return `${c.label}: WROTE ${asDry.wrote.join('; ')} (asked as a dry run)`;
  const preview = asDry.r?.outcome === 'ok' ? asDry.r.preview : null;
  if (!preview) return `${c.label}: asked as a dry run it answered ${asDry.r?.outcome} without a preview, so what it would send cannot be seen`;
  const effects = preview.effects;
  if (effects.length) return `${c.label}: SENDS ${effects.map((e) => `${e.kind}: ${e.summary}`).join('; ')}`;
  return null;
}

const isWrite = (p: string) => /: (WROTE|TRIED TO WRITE|SENDS) /.test(p);

const coverage = { cases: 0, firstUse: 0 };
let started = 0;
beforeAll(async () => {
  started = Date.now();
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  fx = await seedReadsCompany(db, TEST_DIR);
  agent = await makeReadsAgent(db, fx);
  await seedAgentRequest(fx, agent);
  casesFor = await buildCases(db, fx, { reportKeys: REPORT_CATALOG.map((r) => r.key), listKeys: SIMPLE_LIST_KEYS });
}, 300_000);

afterAll(async () => {
  console.log(
    `[agentReads.contract] ${READ_OPS.length} read operations; ${coverage.firstUse} cases run once on the company before the first-use lists, ` +
      `${coverage.cases} run in the groups (each as a read and as a dry run); ${Math.round((Date.now() - started) / 1000)} s with the seed`,
  );
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Every case label on a list, with the list it is on. */
const LISTED: ReadonlyArray<readonly [string, string]> = LEFT_OUT;
/** Cases the groups leave to their own list (WRITES runs in the groups too, after the first use). */
const SKIPPED = new Set(LISTED.map(([l]) => l));

describe('the lists of this file', () => {
  it('every list names real read operations, no case is on two lists, and KNOWN only gets shorter', () => {
    expect([...LISTED.map(([l]) => l), ...Object.keys(WRITES)].filter((l) => !opOfLabel(l))).toEqual([]);
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [l, list] of [...LISTED, ...Object.keys(WRITES).map((l): [string, string] => [l, 'WRITES'])]) {
      if (seen.has(l)) twice.push(`${l}: ${seen.get(l)} and ${list}`);
      seen.set(l, list);
    }
    expect(twice).toEqual([]);
    expect(Object.keys(KNOWN).length).toBeLessThanOrEqual(KNOWN_MAX);
  });

  it('a WRITES entry names one case: an operation of several kinds is listed by the kind that writes', () => {
    // An operation id would excuse every kind at once, so a write by another kind (or of another
    // table) would turn nothing red.
    expect(Object.keys(WRITES).filter((l) => (casesOfLabel(l).cases ?? []).length !== 1)).toEqual([]);
  });

  it('every read whose registry entry says it makes a default on first use is on WRITES or FIRST_USE', () => {
    expect(Object.keys(FIRST_USE).filter((l) => !opOfLabel(l))).toEqual([]);
    const onList = (list: Record<string, string>, id: string) => Object.keys(list).some((l) => opOfLabel(l)?.id === id);
    // A why that says a default has no read-only guard is a read that writes: it belongs on WRITES.
    const unguarded = READ_OPS.filter((o) => /ensureDefault\w+ has no read-only guard/.test(o.why ?? ''));
    expect(unguarded.map((o) => o.id).filter((id) => !onList(WRITES, id))).toEqual([]);
    // A why that says how an agent's read leaves the default unmade (classes/purchases.ts
    // READS_DEFAULT_SITE, classes/payroll.ts payroll items) is on FIRST_USE, so it runs here on a
    // company without one.
    const guarded = READ_OPS.filter((o) => /defaultSiteForRead|ensureDefaultPayrollItems/.test(o.why ?? ''));
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.map((o) => o.id).filter((id) => !onList(FIRST_USE, id))).toEqual([]);
  });

  it("the person-only reads are not offered to agents (decision: a person's own routes)", () => {
    for (const id of PERSON_ONLY) {
      const op = operationById(id);
      expect(op, id).toBeDefined();
      expect(op!.availability, id).not.toBe('agent');
      expect(READ_OPS.some((o) => o.id === id), id).toBe(false);
    }
  });
});

describe("reads whose route refuses every agent: a person's own are not offered, and FINDINGS where the registry still offers one", () => {
  // A person's own reads (PERSON_ONLY) are not offered to agents, and the bridge refuses them.
  for (const id of PERSON_ONLY) {
    it(`${id}: refused, with nothing answered and nothing written`, async () => {
      const op = operationById(id)!;
      const run = await runCase(op, { label: id, input: {} }, 'read');
      expect(run.threw).toBeNull();
      expect(run.wrote).toEqual([]);
      expect(run.r?.outcome).toBe('error');
      expect(run.r?.error?.code).toBe('NOT_AVAILABLE');
      expect(run.r?.result ?? null).toBeNull();
      expect(run.r?.file ?? null).toBeNull();
    });
  }

  // FINDINGS (NOT_FOR_AGENTS): offered to agents as reads, but the route refuses every agent.
  for (const [label, why] of Object.entries(NOT_FOR_AGENTS)) {
    it.fails(`${label}: ${why}`, async () => {
      const { op, cases } = casesOfLabel(label);
      // Not run at all is not the finding: returning makes this it.fails case red.
      if (!cases?.length) return;
      const problems: string[] = [];
      for (const c of cases) {
        const p = await problemOf(op, c);
        // A write would be another finding, not this one: say so by turning this case red.
        if (p && isWrite(p)) return;
        if (p) problems.push(p);
      }
      expect(problems).toEqual([]);
    }, 120_000);
  }
});

describe('reads refused to agents on purpose stay refused', () => {
  for (const [label, why] of Object.entries(REFUSED_BY_DESIGN)) {
    it(`${label}: ${why}`, async () => {
      const { op, cases } = casesOfLabel(label);
      expect(cases?.length, `${label} is not run at all`).toBeGreaterThan(0);
      for (const c of cases ?? []) {
        const run = await runCase(op, c, 'read');
        expect(run.threw).toBeNull();
        expect(run.wrote).toEqual([]);
        expect(run.r?.outcome).toBe('error');
        expect(run.r?.result ?? null).toBeNull();
        expect(run.r?.file ?? null).toBeNull();
      }
    }, 120_000);
  }
});

describe('FINDINGS: reads that write (on a company where nobody opened these lists yet)', () => {
  for (const [label, what] of Object.entries(WRITES)) {
    it.fails(`${label}: ${what}`, async () => {
      const { op, cases } = casesOfLabel(label);
      // Not run at all is not the finding: returning makes this it.fails case red.
      if (!cases?.length) return;
      const writes: string[] = [];
      for (const c of cases) {
        const p = await problemOf(op, c);
        if (p && isWrite(p)) writes.push(p);
      }
      expect(writes).toEqual([]);
    }, 120_000);
  }

  it("a read that makes a default on a person's first call makes none for an agent and answers as if none existed yet", async () => {
    const rowsIn = async (t: string) =>
      Number(
        ((await db.execute(sql.raw(`select count(*)::int as n from ${t} where company_id = '${fx.ctx.companyId}'`))) as unknown as { rows: Array<{ n: number }> })
          .rows[0].n,
      );
    // The premise: nobody made these yet, else a clean answer proves nothing.
    for (const t of FIRST_USE_TABLES) expect(await rowsIn(t), `${t} before the first use`).toBe(0);
    const problems: string[] = [];
    let ran = 0;
    for (const label of Object.keys(FIRST_USE)) {
      const { op, cases } = casesOfLabel(label);
      if (!cases?.length) {
        problems.push(`${label}: not run (the fixture has no case for it)`);
        continue;
      }
      for (const c of cases) {
        ran++;
        const p = await problemOf(op, c);
        if (p) problems.push(p);
      }
    }
    expect(problems).toEqual([]);
    // Every kind of the by-site reports ran, not only one.
    expect(ran).toBeGreaterThan(Object.keys(FIRST_USE).length);
    // The two lists answer with what is there: nothing yet.
    for (const id of ['inventory-sites.list', 'payroll-items.list']) {
      const r = await runOperation(agent.base, operationById(id)!, {}, 'read', agent.actor);
      expect(r.outcome, id).toBe('ok');
      expect(r.result, id).toEqual([]);
    }
    for (const t of FIRST_USE_TABLES) expect(await rowsIn(t), `${t} after the agent's reads`).toBe(0);
  }, 300_000);

  // A read that writes only the first time is seen only here: the groups below run after the
  // first-use records exist. So every case runs once now, as a read (a dry run of a read is a
  // read too), and a write that WRITES does not name by its own case label is a finding to add
  // there.
  it('a pass over every case before the first-use lists exist finds no write WRITES does not name', async () => {
    const unlisted: string[] = [];
    for (const op of READ_OPS) {
      for (const c of casesFor(op) ?? []) {
        coverage.firstUse++;
        const run = await runCase(op, c, 'read');
        const w = writeOf(c, run);
        if (w && !(c.label in WRITES)) unlisted.push(w);
      }
    }
    expect(coverage.firstUse).toBeGreaterThan(READ_OPS.length);
    expect(unlisted).toEqual([]);
  }, 900_000);
});

describe('every read runs on the read-only handle without an error and without writing', () => {
  beforeAll(async () => {
    await seedFirstUseRecords(fx);
  }, 120_000);

  it('the fixture seeded everything it means to', () => {
    expect(fx.seedErrors).toEqual([]);
  });

  for (let g = 0; g < GROUPS; g++) {
    const ops = READ_OPS.filter((o) => groupOf(o) === g && !SKIPPED.has(o.id));
    it(`group ${g + 1} of ${GROUPS} (${ops.length} operations)`, async () => {
      const problems: string[] = [];
      for (const op of ops) {
        const cases = casesFor(op);
        if (!cases) {
          problems.push(`${op.id}: the fixture cannot supply ${op.params.join(', ')} (seed one, or put it on KNOWN with why)`);
          continue;
        }
        for (const c of cases) {
          if (SKIPPED.has(c.label)) continue;
          coverage.cases++;
          const p = await problemOf(op, c);
          if (p) problems.push(p);
        }
      }
      expect(problems).toEqual([]);
    }, 900_000);
  }

  for (const [label, why] of Object.entries(KNOWN)) {
    it(`KNOWN, still cannot be run (take it off when it can): ${label}: ${why}`, async () => {
      const { op, cases } = casesOfLabel(label);
      const problems: string[] = [];
      for (const c of cases ?? []) {
        const p = await problemOf(op, c);
        if (p) problems.push(p);
      }
      // A KNOWN case that runs must still not write: that would be a finding, not a reason.
      expect(problems.filter(isWrite)).toEqual([]);
      expect(cases === null || cases.length === 0 || problems.length > 0, `${label} now reads cleanly: take it off KNOWN and lower KNOWN_MAX`).toBe(true);
    }, 120_000);
  }
});
