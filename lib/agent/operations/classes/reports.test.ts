import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { REPORTS_CLASSES } from './reports';
import { bucketOfRoute, type ClassBucket } from './buckets';
import { allOperations, operationById } from '../registry';
import { describeSchemas } from '../schemas';
import type { Operation } from '../types';
import type { OperationInput } from '@/lib/agent/contract';
import { DESCRIBE_LINE_MAX, describeRequest } from '@/lib/agent/describe';

const BUCKET: ClassBucket = 'reports';
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

const REPORT_ID = '0f3c2b1a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const RECIPIENTS = 'ceo@acme.com, cfo@acme.com, x@outside.example';
const HELD = 'held until a person saves its recipients';

describe('classification: reports', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('reports', REPORTS_CLASSES)).toEqual([]);
  });

  it('classes the File Utilities reads file: the schedule list (it names the export folder) and list exports', () => {
    expect(op('report-schedules.list')).toMatchObject({ method: 'GET', area: 'file_utilities', class: 'file', dryRun: 'none' });
    expect(op('report-schedules.list').why).toMatch(/^Decided 'file'/);
    expect(op('export.get')).toMatchObject({ method: 'GET', area: 'file_utilities', class: 'file', output: 'file', dryRun: 'none' });
    for (const o of ops()) if (o.method === 'GET' && o.area === 'file_utilities') expect(o.class, o.id).toBe('file');
  });

  it('never dry runs a GET classed above read: a dry run would hand the agent the answer before anyone approved it', () => {
    for (const o of ops()) {
      if (o.method === 'GET' && o.class !== 'read' && o.class !== 'read_sensitive') expect(o.dryRun, o.id).toBe('none');
    }
  });

  it('says that a schedule an agent made or changed waits until a person saves its recipients', () => {
    for (const id of ['report-schedules.create', 'report-schedules.update']) {
      expect(op(id).describe, id).toContain(HELD);
      expect(op(id).why, id).toMatch(/until a person (?:checks it under Scheduled Reports and )?saves its recipients/);
    }
    // The old clause is gone: such a schedule no longer runs as the file owner with nothing masked.
    for (const o of ops()) expect(o.describe, o.id).not.toMatch(/no approver/);
  });

  it('keeps what runs, the format, the recipients and the folder on the line, with a long name', () => {
    const line = describeRequest(op('report-schedules.create'), {
      body: { name: 'N'.repeat(60), frequency: 'monthly', format: 'xlsx', memorizedReportId: REPORT_ID, emailTo: RECIPIENTS, folder: 'Month end' },
    });
    expect(line.length).toBeLessThanOrEqual(DESCRIBE_LINE_MAX);
    expect(line).toBe(`Schedule monthly xlsx files, ${HELD} (report: ${REPORT_ID}) (email to: ${RECIPIENTS}) (folder: Month end)`);
    // A group schedule names the group.
    expect(describeRequest(op('report-schedules.create'), { body: { name: 'x', frequency: 'weekly', groupId: REPORT_ID } })).toBe(
      `Schedule weekly files, ${HELD} (group: ${REPORT_ID})`,
    );
  });

  it('shows the new recipients and the on/off value of a schedule change', () => {
    const line = (body: Record<string, unknown>) => describeRequest(op('report-schedules.update'), { params: { id: REPORT_ID }, body });
    expect(line({ emailTo: RECIPIENTS, isActive: true })).toBe(
      `Change report schedule ${REPORT_ID}, ${HELD} (email to: ${RECIPIENTS}) (turned on: yes)`,
    );
    expect(line({ isActive: false, name: 'N'.repeat(60) })).toBe(`Change report schedule ${REPORT_ID}, ${HELD} (turned on: no)`);
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
