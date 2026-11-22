import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import type { OperationInput } from '@/lib/agent/contract';
import { describeRequest } from '@/lib/agent/describe';
import { allOperations } from '../registry';
import { operationKey, type Operation } from '../types';
import { CLASS_BUCKETS, CLASS_BUCKET_NAMES, bucketOfRoute, routeSegment, type ClassBucket } from './buckets';

describe('classification buckets', () => {
  it('put every API route in exactly one bucket', () => {
    const seen = new Map<string, string>();
    for (const name of CLASS_BUCKET_NAMES) {
      for (const seg of CLASS_BUCKETS[name]) {
        expect(seen.get(seg), `segment "${seg}" is in two buckets`).toBeUndefined();
        seen.set(seg, name);
      }
    }
    const homeless = Object.keys(API_ROUTE_PERMISSIONS).filter((p) => bucketOfRoute(p) === null);
    expect(homeless).toEqual([]);
    const used = new Set(Object.keys(API_ROUTE_PERMISSIONS).map(routeSegment));
    expect([...seen.keys()].filter((s) => !used.has(s))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The everyday buckets (banking, lists, payroll, planning, purchases, sales)
// ---------------------------------------------------------------------------

const EVERYDAY: readonly ClassBucket[] = ['banking', 'lists', 'payroll', 'planning', 'purchases', 'sales'];
const everyday = (): Operation[] =>
  allOperations().filter((o) => o.kind === 'route' && EVERYDAY.includes(bucketOfRoute(o.route) as ClassBucket));
const byKey = (key: string): Operation => {
  const found = allOperations().find((o) => operationKey(o.method, o.route) === key);
  if (!found) throw new Error(`no operation ${key}`);
  return found;
};

/**
 * The flags a 409 of these routes can name, as the bridge reads them (lib/agent/bridge.ts
 * namedFlags): a "do it anyway" fix that sets the flag, or a warning marker it maps to one. A
 * listed flag outside this set could never be asked for, so an agent would never confirm it.
 */
const FLAGS_THE_APP_ASKS = ['allowDuplicateNumber', 'overrideCreditLimit', 'allowOverBilling', 'allowReconciledEdit', 'removeFromDeposit'];

/**
 * A new record and its edit share one body schema, which carries the edit's flags. Only the edit
 * asks for them, so only the edit lists them (an agent can confirm a warning only where one comes).
 */
const EDIT_ONLY_FLAGS: ReadonlyArray<{ create: string; edits: string[]; flags: string[]; service: string }> = [
  { create: 'POST /api/bill-payments', edits: ['PATCH /api/bill-payments/[id]'], flags: ['allowReconciledEdit'], service: 'billPayments' },
  { create: 'POST /api/deposits', edits: ['PATCH /api/deposits/[id]'], flags: ['allowReconciledEdit'], service: 'deposits' },
  { create: 'POST /api/expenses', edits: ['PATCH /api/expenses/[id]'], flags: ['allowReconciledEdit'], service: 'expenses' },
  { create: 'POST /api/journal-entries', edits: ['PATCH /api/journal-entries/[id]'], flags: ['allowReconciledEdit'], service: 'journal' },
  { create: 'POST /api/payments', edits: ['PUT /api/payments/[id]', 'PATCH /api/payments/[id]'], flags: ['allowReconciledEdit', 'removeFromDeposit'], service: 'payments' },
  { create: 'POST /api/sales-receipts', edits: ['PUT /api/sales-receipts/[id]', 'PATCH /api/sales-receipts/[id]'], flags: ['allowReconciledEdit'], service: 'salesReceipts' },
  { create: 'POST /api/transfers', edits: ['PATCH /api/transfers/[id]'], flags: ['allowReconciledEdit'], service: 'transfers' },
  { create: 'POST /api/vendor-credits', edits: ['PATCH /api/vendor-credits/[id]'], flags: ['allowReconciledEdit'], service: 'vendorCredits' },
];

/** The function each line of `src` sits in, for every line that `needle` matches. */
function enclosingFunctions(src: string, needle: RegExp): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of src.split(/\r?\n/)) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (m) current = m[1];
    if (needle.test(line)) out.push(current);
  }
  return out;
}

describe('everyday buckets: confirmation flags', () => {
  it('list only flags a warning of the app can name', () => {
    const odd = everyday().flatMap((o) => o.confirmFlags.filter((f) => !FLAGS_THE_APP_ASKS.includes(f)).map((f) => `${o.id}: ${f}`));
    expect(odd).toEqual([]);
  });

  it('list an edit-only flag on the edit, never on the new record that shares its schema', () => {
    for (const { create, edits, flags } of EDIT_ONLY_FLAGS) {
      for (const f of flags) {
        expect(byKey(create).confirmFlags, `${create} ${f}`).not.toContain(f);
        for (const e of edits) expect(byKey(e).confirmFlags, `${e} ${f}`).toContain(f);
      }
    }
  });

  it('match the services: only an update function reads those flags (read off the source)', () => {
    // If a save of a new record starts asking for one, this fails: list the flag on that POST too.
    for (const { service, flags } of EDIT_ONLY_FLAGS) {
      const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'services', `${service}.ts`), 'utf8');
      const where = enclosingFunctions(src, new RegExp(String.raw`input\.(?:${flags.join('|')})\b`));
      expect(where.length, `${service}.ts reads ${flags.join(', ')}`).toBeGreaterThan(0);
      for (const fn of where) expect(fn, `${service}.ts: ${fn}`).toMatch(/^update/);
    }
  });
});

describe('everyday buckets: amounts', () => {
  it('never tell an agent that the ledger does not size a void (describe_operation sends the why as it is)', () => {
    // The bridge (lib/agent/bridge.ts factsFor) counts every entry a run voided, deleted or changed
    // in place, and adds up every entry of an operation with no amountField.
    const stale = /ledger preview (?:cannot|does not) size|before and after the dry run|entries made in the run|see only the largest single/i;
    expect(everyday().filter((o) => stale.test(o.why ?? '')).map((o) => o.id)).toEqual([]);
  });
});

/** A request that fills every placeholder but `missing` (path parameters always: a route has them). */
function inputWithout(operation: Operation, missing: ReadonlySet<string>): OperationInput {
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const [, name] of operation.describe.matchAll(/\{([A-Za-z0-9_.]+)\}/g)) {
    if (operation.params.includes(name)) {
      params[name] = 'v1';
      continue;
    }
    if (missing.has(name)) continue;
    query[name] = '12.00';
    let at = body;
    const parts = name.split('.');
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[parts[parts.length - 1]] = '12.00';
  }
  return { params, query, body };
}

describe('everyday buckets: approval lines', () => {
  it('read as a sentence in every form: all values, none, and each one missing or alone', () => {
    const bad: string[] = [];
    for (const o of everyday()) {
      const names = [...new Set([...o.describe.matchAll(/\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]))].filter((n) => !o.params.includes(n));
      if (names.length === 0) continue;
      const forms = [new Set<string>(), new Set(names), ...names.map((n) => new Set([n])), ...names.map((n) => new Set(names.filter((x) => x !== n)))];
      for (const missing of forms) {
        const line = describeRequest(o, inputWithout(o, missing));
        const problems = [
          // A small word, an article or a label left at the end.
          /(?:^|\s)(?:a|an|the|to|for|of|from|on|as|with|by|at|in|into|through|against|before|since|dated|named|their|and|or)$|[:,;(/]$/i.test(line),
          // Starts as a sentence does, not with a value or a title and a colon ("Purchase order v1: 12.00").
          !/^[A-Z]/.test(line) || /^[A-Z][a-z]+(?: [a-z]+)? v1:/.test(line),
          // "a" before a word that needs "an" ("Write a expense"), an empty aside, stray spaces or braces, "ai=" with no value.
          /\ba (?:expense|invoice|item|estimate|order|account|amount|entry|adjustment|employee)\b/i.test(line) ||
            /\(\s*\)|\s{2}|\s[,;:)]|[{}]|=\s|=$/.test(line),
          // Two values with nothing between them (a first and last name aside), or a "/" left first ("level / other name").
          (/\b12\.00 12\.00\b/.test(line) && !o.describe.includes('{firstName} {lastName}')) ||
            (/(?:^|\s)\/\s/.test(line) && !/Print Forms \/ Send Forms/.test(line)),
        ];
        if (problems.some(Boolean)) bad.push(`${o.id}: "${line}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
