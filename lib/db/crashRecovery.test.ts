/**
 * A company database that was killed or abandoned while open must open again.
 *
 *  - Killed: a process writing to the database is killed hard (Task Manager, a crash). Postgres
 *    replays its write-ahead log on the next open and every committed row is there.
 *  - Abandoned by a second copy of lib/db: Next.js can load lib/db more than once in one server
 *    process (`next dev` builds every route on its own). The second copy must reuse the open
 *    database, never start a second Postgres on the same folder: two instances writing one folder
 *    leave it unable to start ("could not locate a valid checkpoint record").
 *  - The quick start check (electron/pgDataCheck.js) recognises that damage, which really does
 *    stop Postgres from starting.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, isDbOpen } from '@/lib/db';
import { LOCK_FILE } from '@/lib/db/dirLock';
import { damageCheckpoint } from './damage.fixture';

const require = createRequire(import.meta.url);
const pgData = require('../../electron/pgDataCheck.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-crash-'));

afterAll(async () => {
  for (const d of fs.readdirSync(ROOT)) await closeDb(path.join(ROOT, d)).catch(() => undefined);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

/** A separate Node process that writes rows into `dir` until it is killed; resolves once `rows` are committed. */
function writerProcess(dir: string, rows: number) {
  const script = `
    const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths: [process.argv[1]] }));
    (async () => {
      const pg = new PGlite(process.argv[2]);
      await pg.exec('create table if not exists crash_probe (id serial primary key, note text)');
      let n = 0;
      for (;;) {
        await pg.query("insert into crash_probe (note) select repeat('x', 400) from generate_series(1, 50)");
        n += 50;
        if (n % 1000 === 0) await pg.exec('checkpoint');
        process.stdout.write(n + '\\n');
      }
    })();`;
  const child = spawn(process.execPath, ['-e', script, process.cwd(), dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const committed = new Promise<number>((resolve, reject) => {
    let last = 0;
    child.stdout.on('data', (b: Buffer) => {
      for (const line of b.toString().split('\n')) if (line.trim()) last = Number(line);
      if (last >= rows) resolve(last);
    });
    child.on('exit', (code) => reject(new Error(`writer exited early (${code})`)));
  });
  return { child, committed };
}

describe('a database killed while open', () => {
  it('opens again with every row it had committed when the process was killed hard', async () => {
    const dir = path.join(ROOT, 'killed');
    // A real company database (migrated), closed, then written by another process that is killed.
    await getDb(dir);
    await closeDb(dir);
    const w = writerProcess(dir, 2500);
    const committed = await w.committed;
    const exited = new Promise((r) => w.child.once('exit', r));
    w.child.kill('SIGKILL'); // TerminateProcess on Windows: no clean shutdown at all
    await exited;

    expect(pgData.checkDataDir(dir)).toMatchObject({ ok: true });
    const db = await getDb(dir);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from crash_probe`)).rows as Array<{ n: number }>;
    expect(n).toBeGreaterThanOrEqual(committed);
    await closeDb(dir);
  }, 180_000);
});

describe('one database per folder per process', () => {
  it('a second copy of lib/db in the same process reuses the open database instead of starting another', async () => {
    const dir = path.join(ROOT, 'twice');
    const first = await import('@/lib/db');
    const a = await first.getDb(dir);
    await a.execute(sql`create table twice_probe (id int primary key)`);

    vi.resetModules(); // what `next dev` does when it builds another route
    const second = await import('@/lib/db');
    expect(second).not.toBe(first);
    const b = await second.getDb(dir);
    expect(b).toBe(a);
    await b.execute(sql`insert into twice_probe values (1)`);

    // Either copy closes it, and the folder lock goes with it.
    await second.closeDb(dir);
    expect(first.isDbOpen(dir)).toBe(false);
    expect(isDbOpen(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);

    // Closed cleanly once, so it opens again with the row.
    expect(pgData.checkDataDir(dir)).toMatchObject({ ok: true });
    const pg = new PGlite(dir);
    expect((await pg.query<{ id: number }>('select id from twice_probe')).rows).toEqual([{ id: 1 }]);
    await pg.close();
  }, 180_000);
});

describe('the quick start check', () => {
  it('passes a healthy folder and its snapshot, and flags a folder whose checkpoint is gone — which Postgres then refuses to start', async () => {
    const format = require('../../electron/companyFileFormat.js');
    const dir = path.join(ROOT, 'check');
    const pg = new PGlite(dir);
    // Enough writes for the log to span several segments, like a company file in use.
    await pg.exec("create table t (id int, note text); insert into t select g, repeat('x', 1000) from generate_series(1, 30000) g; checkpoint;");
    await pg.exec("insert into t select g, repeat('y', 1000) from generate_series(1, 5000) g;");
    await pg.close();
    expect(pgData.checkDataDir(dir)).toEqual({ ok: true, reason: null });
    expect(pgData.checkSnapshot(format.snapshotDir(dir))).toEqual({ ok: true, reason: null });

    damageCheckpoint(dir);
    const result = pgData.checkDataDir(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/log segment holding its last checkpoint .* is missing/);
    expect(pgData.checkSnapshot(format.snapshotDir(dir)).ok).toBe(false);

    const broken = new PGlite(dir);
    await expect(broken.waitReady).rejects.toThrow(/Aborted/);
  }, 120_000);

  it('flags a folder with no write-ahead log at all', async () => {
    const dir = path.join(ROOT, 'nolog');
    const pg = new PGlite(dir);
    await pg.exec('create table t (id int); insert into t values (1);');
    await pg.close();
    for (const n of fs.readdirSync(path.join(dir, 'pg_wal'))) if (/^[0-9A-F]{24}$/.test(n)) fs.rmSync(path.join(dir, 'pg_wal', n));
    expect(pgData.checkDataDir(dir)).toMatchObject({ ok: false, reason: 'its write-ahead log is missing' });
  }, 60_000);

  it('flags a folder whose checkpoint is there but whose redo point lies in a segment that is gone', async () => {
    const dir = path.join(ROOT, 'redo');
    const pg = new PGlite(dir);
    await pg.exec('create table t (id int); insert into t values (1); checkpoint;');
    await pg.close();
    expect(pgData.checkDataDir(dir).ok).toBe(true);
    // Crash recovery starts at the redo point: put it one segment before the oldest one kept
    // (what a recycled segment leaves). The checkpoint record itself is untouched.
    const control = path.join(dir, 'global', 'pg_control');
    const buf = fs.readFileSync(control);
    const segs = fs.readdirSync(path.join(dir, 'pg_wal')).filter((n) => /^[0-9A-F]{24}$/.test(n)).sort();
    const segSize = BigInt(fs.statSync(path.join(dir, 'pg_wal', segs[0])).size);
    const oldest = BigInt(parseInt(segs[0].slice(16), 16));
    buf.writeBigUInt64LE((oldest - BigInt(1)) * segSize + BigInt(0x28), 40);
    fs.writeFileSync(control, buf);
    const result = pgData.checkDataDir(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/redo point of its last checkpoint .* is missing/);
  }, 60_000);

  it('flags nothing at all, and a database missing PG_VERSION or its control file', async () => {
    const empty = path.join(ROOT, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(pgData.checkDataDir(empty)).toMatchObject({ ok: false, reason: 'there is nothing in it' });
    expect(pgData.checkSnapshot([]).ok).toBe(false);

    const dir = path.join(ROOT, 'partial');
    const pg = new PGlite(dir);
    await pg.exec('create table t (id int);');
    await pg.close();
    const format = require('../../electron/companyFileFormat.js');
    const snap = format.snapshotDir(dir) as Array<{ name: string }>;
    expect(pgData.checkSnapshot(snap.filter((e) => e.name !== 'PG_VERSION'))).toMatchObject({ ok: false, reason: expect.stringMatching(/PG_VERSION is missing/) });
    expect(pgData.checkSnapshot(snap.filter((e) => e.name !== 'global/pg_control'))).toMatchObject({ ok: false, reason: expect.stringMatching(/control file is missing/) });
  }, 60_000);

  it('answers "unknown" for a company that has no database yet', () => {
    // A brand-new company file: its listing and file id, no books yet.
    expect(pgData.checkSnapshot([{ name: 'bookkeeper-company.json', data: Buffer.from('{}') }, { name: '.file-id', data: Buffer.from('x') }]).ok).toBeNull();
  });
});
