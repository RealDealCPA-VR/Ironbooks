import { describe, expect, it } from 'vitest';
import { bucketProblems } from './check';
import { ADMIN_CLASSES } from './admin';
import { bucketOfRoute, type ClassBucket } from './buckets';
import { allOperations, operationById } from '../registry';
import { describeSchemas } from '../schemas';
import type { Operation } from '../types';
import type { OperationInput } from '@/lib/agent/contract';
import { describeRequest } from '@/lib/agent/describe';
import { guardInput } from '@/lib/agent/guards';

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

  it("does not offer a person's own reads of the company file to agents; the file's name is class file", () => {
    // 'self' routes answer from the signed-in user's session: every agent gets "not available".
    for (const id of ['companies.list', 'file-protection.status']) {
      expect(op(id), id).toMatchObject({ method: 'GET', rule: 'self', availability: 'person_only' });
      expect(op(id).why, id).toMatch(/getSessionGate/);
    }
    expect(op('company-file.info')).toMatchObject({ method: 'GET', class: 'file', availability: 'agent', dryRun: 'none' });
    // Every other GET of a person's own account ('self') is not offered either.
    for (const o of ops()) if (o.method === 'GET' && o.rule === 'self') expect(o.availability, o.id).not.toBe('agent');
    // The screen a person looks it up in is named as the menu has it (lib/nav.ts: Setup > Security (2FA)).
    expect(op('file-protection.status').why).toMatch(/Setup > Security \(2FA\)/);
    expect(op('file-protection.status').why).not.toMatch(/Company > Security/);
  });

  it("the company file's name: the why does not claim the class keeps a public answer from the agent", () => {
    const info = op('company-file.info');
    // The route is 'public' (the sign-in screen reads it before anyone signs in) and never asks for a
    // context, so the way-in check of an agent's own request never runs for it.
    expect(info.rule).toBe('public');
    expect(info.why).toMatch(/route is public/);
    expect(info.why).toMatch(/with or without an agent's token/);
    expect(info.why).toMatch(/without the folder/);
  });

  it('the practice-copy refusals say why in plain words and cite no plan section', () => {
    const refused = ops().filter((o) => o.route.startsWith('/api/sandbox') && o.availability === 'hard_floor');
    expect(refused.length).toBe(4);
    for (const o of refused) {
      expect(o.why, o.id).toMatch(/never work in a practice copy/);
      expect(o.why, o.id).not.toMatch(/\(plan [0-9.]+\)/);
    }
  });

  it('every restore is class file, needs the file Admin and is approved at the host only; a whole-file restore says it ends every agent', () => {
    // condense.archives.post restores the copy saved before a condense (its id is the rule's).
    const whole = ['backup.restore', 'backups.restore', 'condense.archives.post'];
    const asNew = ['backup.company.restore', 'portable.restore'];
    for (const id of [...whole, ...asNew]) {
      expect(op(id), id).toMatchObject({ method: 'POST', class: 'file', fileAdmin: true, hostOnly: true });
      expect(['none', 'preview'], id).toContain(op(id).dryRun);
    }
    for (const id of whole) expect(op(id).why, id).toMatch(/takes away every agent's access/);
    // The approver reads the line, not the why: it says so there too, whatever the backup is called.
    for (const id of whole) {
      for (const input of [{ body: { id: 'b1' } }, {}]) {
        expect(describeRequest(op(id), input), id).toMatch(/\(ends every agent's access, this one's included\)$/);
      }
    }
    // A restore as a new company or a new file leaves the open books' agents as they are.
    for (const id of asNew) expect(op(id).why, id).toMatch(/starts with no agent access/);
    // Every POST of File Utilities that the route map files as a delete (a restore) is among them.
    const restores = ops().filter((o) => o.method === 'POST' && o.area === 'file_utilities' && o.action === 'delete' && o.availability === 'agent');
    expect(restores.map((o) => o.id).filter((id) => !whole.includes(id) && !asNew.includes(id) && id !== 'condense')).toEqual([]);
  });

  it('adding a user: the approving Admin types the password and nothing is produced', () => {
    expect(op('users.create')).toMatchObject({ class: 'admin', needsSecret: ['new_user_password'], producesSecret: [] });
    expect(op('users.create').why).toMatch(/Nothing is produced/);
  });

  it("a role change names the role, and says no agent may change or delete a role any agent holds", () => {
    const line = describeRequest(op('roles.update'), { params: { id: 'r-1' }, body: { permissions: {} } }, { key: 'r-1', name: 'Month-end helper' });
    // No name in the body: nothing is renamed, so the line has no 'called … after the change' aside.
    expect(line).toBe('Change what role r-1 allows');
    // As the door words it: {id} by the role's name now (summaryNames), the answer's name after.
    expect(describeRequest(op('roles.update'), { params: { id: 'r-1' }, body: { permissions: {} } }, { key: 'r-1', name: 'Clerk' }, { 'r-1': 'Clerk' })).toBe(
      'Change what role Clerk allows',
    );
    expect(describeRequest(op('roles.update'), { params: { id: 'r-1' }, body: { name: 'Clerk helper' } }, { key: 'r-1', name: 'Clerk helper' }, { 'r-1': 'Clerk' })).toBe(
      'Change what role Clerk allows (called Clerk helper after the change)',
    );
    expect(describeRequest(op('roles.update'), { params: { id: 'r-1' } })).toBe('Change what role r-1 allows');
    for (const id of ['roles.update', 'roles.delete']) {
      expect(op(id).why, id).toMatch(/ANY agent holds/);
      expect(op(id).why, id).toMatch(/hard floor/);
      // The service's own backstop, as it is on disk.
      expect(op(id).why, id).toMatch(/refuseAgentOnAgentRole/);
      expect(op(id).why, id).not.toMatch(/never looks at agents/);
    }
  });

  it('the shareable ledger names its memos as protected', () => {
    expect(op('portable.shareable')).toMatchObject({ class: 'file', output: 'file', reveal: null });
    expect(op('portable.shareable').sensitiveFields).toContain('memo');
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

  it('condense: a dryRun that is not true or false is refused, and the line says "yes" only for a real true', () => {
    // The route runs the real, irreversible condense unless dryRun is the boolean true.
    const line = (body: Record<string, unknown>) => describeRequest(op('condense'), { params: {}, query: {}, body });
    for (const dryRun of ['yes', 'true', 1, null, {}, ['yes']]) {
      expect(line({ beforeDate: '2025-01-01', dryRun }), JSON.stringify(dryRun)).not.toMatch(/preview only: yes/);
      const g = guardInput(op('condense'), { body: { beforeDate: '2025-01-01', dryRun } });
      expect(g.refused, JSON.stringify(dryRun)).toMatch(/dryRun must be true or false/);
    }
    expect(line({ beforeDate: '2025-01-01', dryRun: 'yes' })).toMatch(/preview only: no/);
    for (const dryRun of [true, false, undefined]) {
      expect(guardInput(op('condense'), { body: { beforeDate: '2025-01-01', ...(dryRun === undefined ? {} : { dryRun }) } }).refused).toBeNull();
    }
  });

  it('no why a person reads cites a plan section or decision', () => {
    for (const o of ops()) expect(o.why ?? '', o.id).not.toMatch(/\(plan [0-9]|\bplan [0-9]+\.[0-9]|\bD[0-9]+\b/);
  });

  it('the whole-file copies the agent cannot read say so on the card: the line and the why', () => {
    for (const id of ['backup.download', 'portable']) {
      expect(op(id).describe, id).toMatch(/the agent cannot read it/);
      expect(op(id).why, id).toMatch(/agent cannot read the copy.*save_file/);
    }
    // The copy an agent asks for with POST is always sealed with the approver's password.
    expect(op('portable.post').why).toMatch(/an agent can never send protect/);
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
