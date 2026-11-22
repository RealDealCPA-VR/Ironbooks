import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { COMPANY_CLASSES } from './company';
import { bucketOfRoute, type ClassBucket } from './buckets';
import { allOperations, operationById } from '../registry';
import { describeSchemas } from '../schemas';
import type { Operation } from '../types';
import type { OperationInput } from '@/lib/agent/contract';
import { describeRequest } from '@/lib/agent/describe';

const BUCKET: ClassBucket = 'company';
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

describe('classification: company', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('company', COMPANY_CLASSES)).toEqual([]);
  });

  it('saving the network policy has no dry run: its answer looks the *.ts.net names up, as the GET does', () => {
    for (const id of ['network-policy', 'network-policy.replace', 'network-policy.update']) {
      expect(op(id).dryRun, id).toBe('none');
    }
    expect(op('network-policy.replace')).toMatchObject({ class: 'settings', hostOnly: true });
    expect(op('network-policy.update')).toMatchObject({ class: 'settings', hostOnly: true });
  });

  it('never dry runs a GET classed above read: a dry run would hand the agent the answer before anyone approved it', () => {
    for (const o of ops()) {
      if (o.method === 'GET' && o.class !== 'read' && o.class !== 'read_sensitive') expect(o.dryRun, o.id).toBe('none');
    }
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

  it("opening an Accountant's Copy is a restore: file Admin, approved at the host only, and the new file starts with no agent access", () => {
    // The same restore as a portable company file (classes/admin.ts portable.restore), so the same needs.
    const open = op('accountant-copy.open');
    expect(open).toMatchObject({ method: 'POST', class: 'file', fileAdmin: true, hostOnly: true, dryRun: 'preview', effects: ['file'] });
    expect(open).toMatchObject({ fileAdmin: op('portable.restore').fileAdmin, hostOnly: op('portable.restore').hostOnly });
    expect(open.why).toMatch(/starts with no agent access/);
    expect(open.why).toMatch(/restorePortableCompanyFile/);
  });

  it('says void first when a batch names no action', () => {
    const line = (body: Record<string, unknown>) => describeRequest(op('accountant.batch-void.apply'), { body: { keys: ['invoice:x'], ...body } });
    expect(line({})).toBe('Batch void the selected transactions, or delete them with action delete');
    expect(line({ action: 'delete' })).toMatch(/\(action: delete\)$/);
  });
});
