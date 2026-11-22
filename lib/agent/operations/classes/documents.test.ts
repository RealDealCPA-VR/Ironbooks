import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { DOCUMENTS_CLASSES } from './documents';
import { bucketOfRoute, type ClassBucket } from './buckets';
import { allOperations, operationById } from '../registry';
import { describeSchemas } from '../schemas';
import { NEVER_ALLOW_CLASSES, type Operation, type RequestFacts } from '../types';
import type { OperationInput } from '@/lib/agent/contract';
import { describeRequest } from '@/lib/agent/describe';
import { approvalNeeds } from '@/lib/agent/policy';
import { redactAnswer } from '@/lib/agent/guards';

const BUCKET: ClassBucket = 'documents';
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

const PLAIN: RequestFacts = { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false };

describe('classification: documents', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('documents', DOCUMENTS_CLASSES)).toEqual([]);
  });

  it('a document download is protected data: never Allow, and whoever approves holds both View flags', () => {
    const download = op('attachments.get');
    expect(download).toMatchObject({ method: 'GET', class: 'read_sensitive', reveal: 'ssn', output: 'file', dryRun: 'none' });
    expect(NEVER_ALLOW_CLASSES).toContain(download.class);
    const needs = approvalNeeds(download, download.class, PLAIN, { twoPersonOver: null });
    expect(needs.flags ?? []).toEqual(expect.arrayContaining(['sensitivePayroll', 'fullAccountNumbers']));
    expect(needs.grantable).toBe('no');
  });

  it('the text read off a receipt is hidden in what the door answers; revealing it takes an Admin', () => {
    // A W-9 dropped into the receipt inbox through a phone link: its text holds a full SSN.
    const text = 'Form W-9 Request for Taxpayer Identification Number SSN 123-45-6789 Acme Supply';
    const receipt = { id: 'r1', vendorName: 'Acme Supply', total: '12.00', cardLast4: '4242', rawText: text };
    const list = redactAnswer(op('receipts.list'), { receipts: [receipt, { ...receipt, id: 'r2' }] }, { reveal: false }).answer;
    const one = redactAnswer(op('receipts.get'), { receipt, suggestions: null }, { reveal: false }).answer;
    for (const answer of [list, one]) {
      expect(JSON.stringify(answer)).not.toContain('123-45');
      expect(JSON.stringify(answer)).toContain('Acme Supply');
      expect(JSON.stringify(answer)).toContain('4242');
    }
    // The receipt inbox itself stays everyday work: a plain read and a prepare.
    expect(op('receipts.list').class).toBe('read');
    expect(op('receipts.get').class).toBe('prepare');
    for (const id of ['receipts.list', 'receipts.get']) {
      expect(approvalNeeds(op(id), 'read_sensitive', { ...PLAIN, reveal: true }, { twoPersonOver: null }).admin, id).toBe(true);
    }
  });

  it('classes the File Utilities reads of the QuickBooks conversion and Rebuild Data file', () => {
    for (const id of ['import.rebuild', 'qb-import.gl', 'qb-import.open-items']) {
      expect(op(id), id).toMatchObject({ method: 'GET', area: 'file_utilities', class: 'file', dryRun: 'none' });
    }
    for (const o of ops()) if (o.method === 'GET' && o.area === 'file_utilities') expect(o.class, o.id).toBe('file');
  });

  it('never dry runs a GET classed above read: a dry run would hand the agent the answer before anyone approved it', () => {
    for (const o of ops()) {
      if (o.method === 'GET' && o.class !== 'read' && o.class !== 'read_sensitive') expect(o.dryRun, o.id).toBe('none');
    }
  });

  it('a dry run of a settings save never looks a name up: the saves that do have none', () => {
    for (const id of ['ai.settings.update', 'receipts.settings.update', 'email.settings.update']) {
      expect(op(id), id).toMatchObject({ class: 'settings', dryRun: 'none' });
      expect(op(id).why, id).toMatch(/No dry run/);
    }
  });

  it('a mail test names the server the typed password is sent to, once', () => {
    const test = op('email.test');
    expect(test.describe).toContain('{draft.host}');
    const line = describeRequest(test, { body: { to: 'me@acme.com', draft: { host: 'smtp.attacker.example' } } });
    expect(line).toBe('Send a test email to me@acme.com through smtp.attacker.example');
    expect(describeRequest(test, { body: { to: 'me@acme.com' } })).toBe('Send a test email to me@acme.com');
  });

  it('the memorize line says whether the template enters itself, and never reads as if it would when not asked', () => {
    const memorize = op('ai.recurring.memorize');
    const line = (autoEnter?: boolean) =>
      describeRequest(memorize, { body: { docType: 'bill', sourceDocId: 'b1', frequency: 'monthly', nextRunDate: '2026-12-01', ...(autoEnter === undefined ? {} : { autoEnter }) } });
    expect(line()).toBe('Memorize bill b1 as a recurring transaction (monthly, from 2026-12-01)');
    expect(line(false)).toMatch(/\(enters itself with nobody reviewing it: no\)$/);
    expect(line(true)).toMatch(/\(enters itself with nobody reviewing it: yes\)$/);
    expect(line()).not.toMatch(/enters itself|true/);
  });

  it('an AI server test never reads "allow cloud AI": that choice is a person\'s, taken out of an agent\'s input', () => {
    const line = describeRequest(op('ai.test'), { body: { baseUrl: 'http://127.0.0.1:11434', kind: 'ollama' } });
    expect(line).toBe('Test AI server http://127.0.0.1:11434 (ollama)');
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
    expect(op('qb-import.gl.run').confirmFlags).toEqual(['acceptVariance', 'acceptExistingEntries']);
  });

  it('reads as a sentence with any value missing', () => {
    const bad = ops()
      .filter((o) => o.availability === 'agent')
      .flatMap(unreadableLines);
    expect(bad).toEqual([]);
  });
});
