/**
 * p1 ux QA (tester): migration 0039 on a REAL pre-0039 company file.
 *
 * The doer's test re-runs 0039 on a database that already has it. This one builds a database
 * migrated only up to 0037 (the state of every customer's file before this round), fills both
 * old To Do stores and My Preferences the way the old app wrote them, then lets the normal
 * migrator apply 0039 — exactly what happens when a user upgrades. Checks: no row lost, every
 * field carried over, two companies stay apart, existing members keep the full menu while their
 * other preferences survive, the declared foreign key is really enforced, and the opened file
 * passes the ledger health / FK checks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@/lib/db/schema';
import { foreignKeyGaps, ensureLedgerGuards } from '@/lib/db/ledgerGuards';
import type { ServiceContext } from './_base';
import { listTodos, getTodo, updateTodo } from './todos';
import { getMyPreferences } from './preferences';
import { getReminders } from './reminders';

const REAL = path.resolve(process.cwd(), 'drizzle');
let oldDir: string;
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T_OPEN = '10000000-0000-4000-8000-000000000001';
const T_DONE = '10000000-0000-4000-8000-000000000002';
const T_INACT = '10000000-0000-4000-8000-000000000003';
const T_WEIRD = '10000000-0000-4000-8000-000000000004';
const T_C2 = '10000000-0000-4000-8000-000000000005';
const T_NOBODY = '10000000-0000-4000-8000-000000000006';
const CAL_DONE = '20000000-0000-4000-8000-000000000001';
const CAL_OPEN = '20000000-0000-4000-8000-000000000002';

/** A copy of the migrations folder whose journal stops before idx 39 (the pre-upgrade app). */
function preUpgradeFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-pre0039-'));
  fs.mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 39);
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries as Array<{ tag: string }>) {
    fs.copyFileSync(path.join(REAL, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

async function q<T = Record<string, unknown>>(text: string): Promise<T[]> {
  return (await client.query<T>(text)).rows;
}

beforeAll(async () => {
  oldDir = preUpgradeFolder();
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: oldDir });

  // Pre-0039 there is no status column on todos.
  const cols = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'todos'`,
  );
  expect(cols.map((c) => c.column_name)).not.toContain('status');

  await client.exec(`
    INSERT INTO users (id, email, name, password_hash) VALUES
      ('${U1}', 'u1@up.test', 'Owner One', 'x'),
      ('${U2}', 'u2@up.test', 'Clerk Two', 'x'),
      ('${U3}', 'u3@up.test', 'Owner Three', 'x');
    INSERT INTO companies (id, name, owner_id) VALUES ('${C1}', 'Upgrade One', '${U1}'), ('${C2}', 'Upgrade Two', '${U3}');
    INSERT INTO user_companies (user_id, company_id, role) VALUES
      ('${U1}', '${C1}', 'owner'), ('${U2}', '${C1}', 'admin'), ('${U3}', '${C2}', 'owner');
    -- U1 already saved some My Preferences (must survive); U2 never opened Preferences.
    INSERT INTO user_preferences (company_id, user_id, prefs)
      VALUES ('${C1}', '${U1}', '{"showHomeWorkflow": false, "startWithPayee": false}'::jsonb);
    -- U3 had explicitly chosen Simple somehow (must not be overwritten).
    INSERT INTO user_preferences (company_id, user_id, prefs) VALUES ('${C2}', '${U3}', '{"navMode": "simple"}'::jsonb);
    INSERT INTO customers (id, company_id, display_name) VALUES ('${CUST}', '${C1}', 'Upgrade Customer');

    -- Old Lists > To Do rows.
    INSERT INTO todo_items (id, company_id, title, details, type, priority, status, due_date, entity_type, entity_id, assigned_user_id, created_by, completed_at, created_at, updated_at)
    VALUES
      ('${T_OPEN}', '${C1}', 'Call Upgrade Customer', 'about the invoice', 'call', 'high', 'open',
        '2026-06-10 00:00:00', 'customer', '${CUST}', '${U2}', '${U1}', NULL, '2026-01-02 03:04:05', '2026-01-03 03:04:05'),
      ('${T_DONE}', '${C1}', 'Meet banker', NULL, 'meeting', 'low', 'done',
        '2026-05-01 09:05:59', NULL, NULL, NULL, '${U1}', '2026-05-01 10:00:00', '2026-01-02 00:00:00', '2026-01-02 00:00:00'),
      ('${T_INACT}', '${C1}', 'Shelved idea', NULL, 'task', 'medium', 'inactive', NULL, NULL, NULL, NULL, '${U2}', NULL, '2026-01-02 00:00:00', '2026-01-02 00:00:00'),
      ('${T_WEIRD}', '${C1}', 'Odd status', NULL, 'email', 'medium', 'someday', '2026-06-12 23:59:00', NULL, NULL, NULL, '${U1}', NULL, '2026-01-02 00:00:00', '2026-01-02 00:00:00'),
      ('${T_NOBODY}', '${C1}', 'Created by nobody', NULL, 'fax', 'medium', 'open', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-02 00:00:00', '2026-01-02 00:00:00'),
      ('${T_C2}', '${C2}', 'Other company to-do', NULL, 'task', 'medium', 'open', '2026-06-11 00:00:00', NULL, NULL, NULL, '${U3}', NULL, '2026-01-02 00:00:00', '2026-01-02 00:00:00');

    -- Old Calendar / Lead Center rows.
    INSERT INTO todos (id, company_id, user_id, title, kind, priority, due_date, due_time, done, done_at)
    VALUES
      ('${CAL_DONE}', '${C1}', '${U1}', 'Finished calendar task', 'task', 'medium', '2026-04-01', NULL, true, '2026-04-01 12:00:00'),
      ('${CAL_OPEN}', '${C1}', '${U2}', 'Calendar call', 'call', 'high', '2026-06-15', '14:00', false, NULL);
  `);

  // The upgrade: the normal migrator applies only what is new (0039).
  await migrate(db, { migrationsFolder: REAL });
});

afterAll(async () => {
  await client?.close();
  try {
    fs.rmSync(oldDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const c1: () => ServiceContext = () => ({ db: db as never, companyId: C1, userId: U1 });
const c2: () => ServiceContext = () => ({ db: db as never, companyId: C2, userId: U3 });

describe('migration 0039 on an upgraded (pre-0039) company file', () => {
  it('loses no to-do: every row of both old stores is in the one store, with the same ids', async () => {
    const legacy = await q<{ id: string }>(`SELECT id FROM todo_items`);
    const merged = await q<{ id: string }>(`SELECT id FROM todos`);
    expect(legacy.length).toBe(6); // the legacy table is kept (no data loss)
    expect(merged.length).toBe(6 + 2);
    const ids = new Set(merged.map((r) => r.id));
    for (const id of [T_OPEN, T_DONE, T_INACT, T_WEIRD, T_C2, T_NOBODY, CAL_DONE, CAL_OPEN]) expect(ids.has(id)).toBe(true);
  });

  it('carries every field over (type, priority, details, due day + time, status, link, assignee, creator, dates)', async () => {
    const open = await getTodo(c1(), T_OPEN);
    expect(open).toMatchObject({
      title: 'Call Upgrade Customer',
      notes: 'about the invoice',
      details: 'about the invoice',
      kind: 'call',
      type: 'call',
      priority: 'high',
      status: 'open',
      done: false,
      dueDate: '2026-06-10',
      dueTime: null,
      entityType: 'customer',
      entityId: CUST,
      entityName: 'Upgrade Customer',
      assignedUserId: U2,
      userId: U1,
      remindOn: null,
    });
    expect(new Date(open.createdAt).toISOString()).toBe('2026-01-02T03:04:05.000Z');

    const done = await getTodo(c1(), T_DONE);
    expect(done).toMatchObject({ status: 'done', done: true, dueDate: '2026-05-01', dueTime: '09:05', kind: 'meeting', priority: 'low' });
    expect(new Date(done.doneAt!).toISOString()).toBe('2026-05-01T10:00:00.000Z');

    expect(await getTodo(c1(), T_INACT)).toMatchObject({ status: 'inactive', done: false, dueDate: null, userId: U2 });
    // An unknown legacy status becomes open (never silently "done").
    expect(await getTodo(c1(), T_WEIRD)).toMatchObject({ status: 'open', done: false, dueDate: '2026-06-12', dueTime: '23:59' });
    expect(await getTodo(c1(), T_NOBODY)).toMatchObject({ userId: null, kind: 'fax' });
  });

  it('old Calendar rows get a status in step with done', async () => {
    expect(await getTodo(c1(), CAL_DONE)).toMatchObject({ status: 'done', done: true });
    expect(await getTodo(c1(), CAL_OPEN)).toMatchObject({ status: 'open', done: false, dueTime: '14:00' });
  });

  it('keeps the two companies apart after the merge', async () => {
    const one = (await listTodos(c1(), { status: 'all' })).map((r) => r.id);
    const two = (await listTodos(c2(), { status: 'all' })).map((r) => r.id);
    expect(two).toEqual([T_C2]);
    expect(one).not.toContain(T_C2);
    expect(one.length).toBe(7);
    await expect(getTodo(c2(), T_OPEN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateTodo(c2(), T_OPEN, { done: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('existing members keep the full menu; their other saved preferences survive; an explicit choice is kept', async () => {
    const u1 = await getMyPreferences(c1());
    expect(u1.navMode).toBe('advanced');
    expect(u1.showHomeWorkflow).toBe(false);
    expect(u1.startWithPayee).toBe(false);
    const u2 = await getMyPreferences({ db: db as never, companyId: C1, userId: U2 });
    expect(u2.navMode).toBe('advanced');
    const u3 = await getMyPreferences(c2());
    expect(u3.navMode).toBe('simple');
  });

  it('migrated to-dos show in Reminders (due within the window) and the Calendar status filter', async () => {
    const r = await getReminders(c1(), { today: '2026-06-12' });
    const labels = r.sections.find((s) => s.key === 'toDoNotes')?.items.map((i) => i.label) ?? [];
    expect(labels).toContain('Call Upgrade Customer (Upgrade Customer)'); // overdue, open
    expect(labels).toContain('Odd status'); // due today
    expect(labels).not.toContain('Meet banker'); // done
    expect(labels).not.toContain('Shelved idea'); // inactive
    expect(labels).not.toContain('Finished calendar task'); // done (old calendar)
    expect(labels).not.toContain('Calendar call'); // due after today
    expect(labels).not.toContain('Other company to-do');
  });

  it('the new assigned-user foreign key is enforced and declared (ledger FK check passes on open)', async () => {
    await expect(
      client.query(`UPDATE todos SET assigned_user_id = '99999999-9999-4999-8999-999999999999' WHERE id = '${T_OPEN}'`),
    ).rejects.toThrow();
    await ensureLedgerGuards(client, REAL);
    const gaps = await foreignKeyGaps(async (text) => (await client.query(text)).rows as never, REAL);
    expect(gaps.filter((g) => JSON.stringify(g).includes('todos'))).toEqual([]);
  });

  it('applying 0039 again (e.g. restored older backup re-migrated) duplicates nothing', async () => {
    const before = (await q(`SELECT id FROM todos`)).length;
    const text = fs.readFileSync(path.join(REAL, '0039_p1_ux.sql'), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      const body = stmt
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (body) await client.exec(body);
    }
    expect((await q(`SELECT id FROM todos`)).length).toBe(before);
    expect((await getMyPreferences(c2())).navMode).toBe('simple');
  });
});
