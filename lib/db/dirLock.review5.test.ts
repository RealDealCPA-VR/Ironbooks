/**
 * Round-5 review regression (company file lock): a lock this process held that has DISAPPEARED
 * counts as lost. The way it disappears while we still hold the file open is another computer
 * taking it over (our heartbeat stopped: sleep, a long pause), using the file and closing it
 * again, which deletes its lock. This process used to find no lock file, write its own again and
 * carry on committing over a folder the other computer had changed underneath its in-memory
 * database — silently losing or corrupting that computer's work. Now the next commit is refused
 * (CompanyFileInUseError) and the handle's onLost runs, exactly as when the other computer's
 * lock is still there; the heartbeat does the same.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanyFileInUseError, HEARTBEAT_MS, LOCK_FILE, acquireDirLock, assertDirLockHeld, holdsDirLock, releaseDirLock } from './dirLock';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-dirlock-r5-'));
const dirOf = (name: string) => {
  const d = path.resolve(path.join(ROOT, name));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('company file lock (review round 5)', () => {
  it('a commit after our lock vanished is refused and the handle is told it lost the file', () => {
    const dir = dirOf('vanished');
    const onLost = vi.fn();
    acquireDirLock(dir, onLost);
    expect(holdsDirLock(dir)).toBe(true);
    // Another computer took the file over and closed it again: its lock (and ours) is gone.
    fs.unlinkSync(path.join(dir, LOCK_FILE));
    expect(() => assertDirLockHeld(dir)).toThrow(CompanyFileInUseError);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(holdsDirLock(dir)).toBe(false);
    // We never re-create a lock we no longer own.
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('the heartbeat notices a vanished lock too, instead of writing a new one', () => {
    vi.useFakeTimers();
    try {
      const dir = dirOf('heartbeat');
      const onLost = vi.fn();
      acquireDirLock(dir, onLost);
      fs.unlinkSync(path.join(dir, LOCK_FILE));
      vi.advanceTimersByTime(HEARTBEAT_MS + 10);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
      expect(holdsDirLock(dir)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lock that is still ours keeps working (heartbeat rewrites it, commits pass)', () => {
    vi.useFakeTimers();
    try {
      const dir = dirOf('healthy');
      const onLost = vi.fn();
      acquireDirLock(dir, onLost);
      vi.advanceTimersByTime(HEARTBEAT_MS * 2 + 10);
      expect(() => assertDirLockHeld(dir)).not.toThrow();
      expect(onLost).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid).toBe(process.pid);
      releaseDirLock(dir);
      expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
