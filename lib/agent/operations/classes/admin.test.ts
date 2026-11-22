import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { ADMIN_CLASSES } from './admin';
import { bucketOfRoute, type ClassBucket } from './buckets';
import { allOperations, operationById } from '../registry';
import { describeSchemas } from '../schemas';
import type { Operation } from '../types';
import type { OperationInput } from '@/lib/agent/contract';
import { describeRequest } from '@/lib/agent/describe';

const BUCKET: ClassBucket = 'admin';
const ops = (): Operation[] => allOperations().filter((o) => o.kind === 'route' && bucketOfRoute(o.route) === BUCKET);
const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

/** A request that fills every placeholder of the template except `missing`, wherever the route reads it. */
function inputWithout(operation: Operation, missing: ReadonlySet<string>): OperationInput {
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const [, name] of operation.describe.matchAll(/\{([A-Za-z0-9_.]+)\}/g)) {
    if (missing.has(name)) continue;
    if (operation.params.includes(name)) params[name] = 'v1';
    query[name] = '12.00';
    let at = body;
    const parts = name.split('.');
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[parts[parts.length - 1]] = '12.00';
  }
  return { params, query, body };
}

/**
 * The forms of an operation's line that do not read as a sentence: every value, none, and each one
 * missing. A line with no value at all is the template itself, and may end as English does ("…save to").
 */
function unreadableLines(operation: Operation): string[] {
  const names = [...operation.describe.matchAll(/\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]);
  if (names.length === 0) return [];
  const forms = [new Set<string>(), new Set(names), ...names.map((n) => new Set([n]))];
  const out: string[] = [];
  for (const missing of forms) {
    const line = describeRequest(operation, inputWithout(operation, missing));
    // A small word left at the end, unless it belongs to its verb ("sign in", "turn on").
    const dangling =
      /(?:^|\s)(?:a|an|the|to|for|of|from|on|as|with|by|at|in|into|through|against|before|since|dated|and|or)$|[:,;(]$/i.test(line) &&
      !/(?:sign|log|turn|switch|check)\s+(?:in|on|off)$/i.test(line);
    if (dangling || /\(\s*\)|\s{2}|\s[,;:)]|[{}]/.test(line)) out.push(`${operation.id}: "${line}"`);
  }
  return out;
}

describe('classification: admin', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('admin', ADMIN_CLASSES)).toEqual([]);
  });

  it('classes every read of Users & Roles admin, the agents tab too (plan 4.2)', () => {
    for (const id of ['users.list', 'users.get', 'users.password-policy', 'users.permissions-report', 'roles.list', 'roles.get']) {
      expect(op(id), id).toMatchObject({ method: 'GET', area: 'users', class: 'admin', availability: 'agent', dryRun: 'none' });
    }
    for (const id of ['agents.list', 'agents.get', 'agents.grants', 'agents.activity']) {
      expect(op(id), id).toMatchObject({ method: 'GET', class: 'admin', availability: 'hard_floor' });
    }
    // No GET of the area is left a plain read.
    for (const o of ops()) if (o.method === 'GET' && o.area === 'users') expect(o.class, o.id).toBe('admin');
  });

  it('classes the File Utilities reads that show the files on disk file; the pure checks of the books stay read, saying why', () => {
    for (const id of ['backups', 'backups.status', 'condense.archives', 'portable.shareable', 'sandbox']) {
      expect(op(id), id).toMatchObject({ method: 'GET', area: 'file_utilities', class: 'file', dryRun: 'none' });
    }
    for (const id of ['integrity', 'integrity.books-in-balance']) {
      expect(op(id), id).toMatchObject({ class: 'read', area: 'file_utilities' });
      expect(op(id).why, id).toMatch(/pure check of the books/);
    }
    const reads = ops().filter((o) => o.method === 'GET' && o.area === 'file_utilities' && o.class === 'read').map((o) => o.id);
    expect(reads.sort()).toEqual(['integrity', 'integrity.books-in-balance']);
  });

  it('never dry runs a GET classed above read: a dry run would hand the agent the answer before anyone approved it', () => {
    for (const o of ops()) {
      if (o.method === 'GET' && o.class !== 'read' && o.class !== 'read_sensitive') expect(o.dryRun, o.id).toBe('none');
    }
  });

  it('condense has no dry run: its service opens the company folder itself and writes files the bridge cannot roll back', () => {
    expect(op('condense')).toMatchObject({ class: 'remove', dryRun: 'none' });
    // With no preview on the card, the line itself tells the route's read-only preview from the real thing.
    const line = (body: Record<string, unknown>) => describeRequest(op('condense'), { params: {}, query: {}, body });
    expect(line({ beforeDate: '2025-01-01', dryRun: true })).toMatch(/2025-01-01.*preview only: yes/);
    expect(line({ beforeDate: '2025-01-01', dryRun: false })).toMatch(/preview only: no/);
    expect(line({ beforeDate: '2025-01-01' })).not.toMatch(/preview/);
  });

  it('takes from an agent every "yes, I am sure" flag its body schema has', async () => {
    // The check itself: an operation that does not list its flags gets the note looked for.
    const control = await describeSchemas({ ...op('qb-import.gl.run'), confirmFlags: [] });
    expect((control.body as { description?: string }).description).toMatch(/acceptVariance.*confirmation/);
    const untaken: string[] = [];
    for (const o of ops()) {
      const { body } = await describeSchemas(o);
      const note = body && typeof body === 'object' ? (body as { description?: unknown }).description : undefined;
      if (typeof note === 'string' && /confirmation/.test(note)) untaken.push(`${o.id}: ${note}`);
    }
    expect(untaken).toEqual([]);
  });

  it('reads as a sentence with any value missing', () => {
    const bad = ops()
      .filter((o) => o.availability === 'agent')
      .flatMap(unreadableLines);
    expect(bad).toEqual([]);
  });
});
