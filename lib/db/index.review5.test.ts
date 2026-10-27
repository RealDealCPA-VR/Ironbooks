/**
 * Round-5 review regression (opening a company file): an open that FAILS (the folder was briefly
 * unreachable on the file server, a damaged PG_VERSION, a migration that threw) used to leave its
 * broken handle cached for the rest of the process. Every later request answered the same error
 * even once the folder was fine again, and the company file lock stayed held — its heartbeat kept
 * renewing it — so no other computer could open the file either until this app was restarted.
 * Now a failed open forgets its handle and releases the lock; the next request opens afresh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeDb, isDbOpen } from './index';
import { holdsDirLock, LOCK_FILE } from './dirLock';
import { users } from './schema';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-open-r5-'));

afterAll(async () => {
  await closeDb(path.join(ROOT, 'file')).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('opening a company file (review round 5)', () => {
  it('a failed open is not cached: the lock is released and the next open starts afresh', async () => {
    const dir = path.resolve(path.join(ROOT, 'file'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PG_VERSION'), 'garbage\n');

    await expect(getDb(dir)).rejects.toThrow();
    // Nothing of the failed attempt is kept: no cached handle, no lock blocking other computers.
    expect(isDbOpen(dir)).toBe(false);
    expect(holdsDirLock(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);

    // The folder is fine again (here: emptied, so a new file is created): the next open works.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const db = await getDb(dir);
    const [row] = await db.insert(users).values({ email: 'retry@test.local', name: 'Retry', passwordHash: 'x' }).returning();
    expect(row.id).toBeTruthy();
    expect(holdsDirLock(dir)).toBe(true);
  });
});
