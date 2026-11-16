/**
 * A working copy BEHIND its company file (electron/companySession.js planOpen / workingCopyBehind).
 *
 * The company file is flushed to disk on every save; the working copy on this computer (PGlite and
 * its transaction log) is not. After a power cut the working copy can therefore have lost writes
 * the company file already holds: state.json still names the last save (S1), but the working
 * copy's transaction log ends before S1's. Recovering or reusing it would save the OLDER books over
 * S1. It is kept apart as an "unsaved changes" copy instead, and the company file opened as saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeStartableFolder } from '@/lib/db/damage.fixture';

const require = createRequire(import.meta.url);
const session = require('../electron/companySession.js');
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-behind-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const rec = (seq: number, hash = `h${seq}`) => JSON.stringify({ seq, hash, summary: `record ${seq} — café` }) + '\n';

describe('deciding what to open after an unclean stop', () => {
  const file = path.join('C:', 'Books', 'Acme.ironbooks');
  const state = (extra: Record<string, unknown> = {}) => ({
    companyFile: file,
    base: { saveId: 's1', fingerprint: 'log:5:h5' },
    unsavedSince: null,
    closedCleanly: false,
    ...extra,
  });
  const plan = (st: Record<string, unknown>, workingFingerprint: string | null, saveId = 's1') =>
    session.planOpen({ companyFile: file, state: st, manifest: { saveId }, dataExists: true, workingFingerprint });

  it('keeps a working copy whose log is behind the company file apart, never recovers it over the file', () => {
    expect(plan(state(), 'log:3:h3')).toBe('conflict');
    expect(plan(state({ unsavedSince: '2026-11-16T10:00:00Z' }), 'log:3:h3')).toBe('conflict');
    // Same position, other record: the two have split off.
    expect(plan(state(), 'log:5:other')).toBe('conflict');
    // The log is gone (or unreadable) while the company file has one.
    expect(plan(state(), null)).toBe('conflict');
    expect(plan(state(), 'log-size:120')).toBe('conflict');
  });

  it('still recovers a working copy that is ahead, and reuses one that matches', () => {
    expect(plan(state(), 'log:7:h7')).toBe('recover');
    expect(plan(state(), 'log:5:h5')).toBe('reuse');
    // A file saved before fingerprints were recorded, or with no log: nothing to compare (as before).
    expect(plan(state({ base: { saveId: 's1' } }), 'log:3:h3')).toBe('reuse');
    expect(plan(state({ base: { saveId: 's1', fingerprint: null } }), 'log:3:h3')).toBe('recover');
  });

  it('a clean close that is somehow behind is refreshed from the company file, not kept', () => {
    expect(plan(state({ closedCleanly: true }), 'log:3:h3')).toBe('extract');
    // Everything here already went into an "unsaved changes" copy: not kept a second time.
    expect(plan(state({ conflictFingerprint: 'log:3:h3' }), 'log:3:h3')).toBe('extract');
  });

  it('a log that is ahead must still hold the save it was opened from', () => {
    const dir = path.join(root, 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transactions.bktlg'), rec(1) + rec(2) + rec(3) + rec(4));
    const base = { saveId: 's1', fingerprint: 'log:3:h3' };
    expect(session.workingCopyBehind(base, 'log:4:h4', dir)).toBe(false);
    expect(session.workingCopyBehind({ ...base, fingerprint: 'log:3:other' }, 'log:4:h4', dir)).toBe(true);
    expect(session.workingCopyBehind(base, 'log:2:h2', dir)).toBe(true);
    expect(session.workingCopyBehind({ saveId: 's1' }, 'log:2:h2', dir)).toBe(false);
  });
});

describe('opening after a power cut lost the working copy\'s last writes', () => {
  it('opens the company file as saved and keeps the older working copy as a separate file', async () => {
    const src = path.join(root, 'src');
    await makeStartableFolder(src);
    fs.writeFileSync(path.join(src, 'base', 'rows'), 'saved S1');
    fs.writeFileSync(path.join(src, 'transactions.bktlg'), rec(1) + rec(2) + rec(3));
    const cf = path.join(root, 'Acme.ironbooks');
    const manifest = { formatVersion: 1, fileId: 'f-behind', companyName: 'Acme', saveId: 's1', savedAt: 'x', fingerprint: 'log:3:h3' };
    await format.writeCompanyFile(cf, { manifest, entries: format.snapshotDir(src) });
    const wr = path.join(root, 'Working');
    const first = await session.prepareWorkingCopy(cf, { root: wr });
    expect(first.plan).toBe('extract');
    expect(session.readState(first.workDir)).toMatchObject({ base: { saveId: 's1', fingerprint: 'log:3:h3' }, closedCleanly: false });

    // The power went: the working copy's last log record (and the books with it) never reached
    // the disk. state.json still says it was opened from S1, and it never closed.
    fs.writeFileSync(path.join(first.dataDir, 'transactions.bktlg'), rec(1) + rec(2));
    fs.writeFileSync(path.join(first.dataDir, 'base', 'rows'), 'older than S1');
    session.writeState(first.workDir, { unsavedSince: '2026-11-16T09:00:00Z' });

    const asked: string[] = [];
    const again = await session.prepareWorkingCopy(cf, {
      root: wr,
      onConflict: async ({ reason }: { reason: string }) => {
        asked.push(reason);
        return true;
      },
    });
    expect(again.plan).toBe('conflict');
    expect(asked).toEqual(['behind']);
    // The working copy is the company file as saved — nothing saved is lost or overwritten.
    expect(fs.readFileSync(path.join(again.dataDir, 'base', 'rows'), 'utf8')).toBe('saved S1');
    expect(session.readState(again.workDir)).toMatchObject({ base: { saveId: 's1', fingerprint: 'log:3:h3' }, unsavedSince: null });
    expect(format.readCompanyManifest(cf).saveId).toBe('s1');
    // The older copy is kept next to the file, never thrown away.
    expect(again.conflictCopy).toMatch(/unsaved changes from/);
    const kept = path.join(root, 'kept');
    await format.extractCompanyFile(again.conflictCopy, kept);
    expect(fs.readFileSync(path.join(kept, 'base', 'rows'), 'utf8')).toBe('older than S1');

    // Cancelling leaves everything as it was.
    fs.writeFileSync(path.join(again.dataDir, 'transactions.bktlg'), rec(1));
    const cancelled = await session.prepareWorkingCopy(cf, { root: wr, onConflict: async () => false });
    expect(cancelled.plan).toBe('cancelled');
    expect(fs.readFileSync(path.join(again.dataDir, 'transactions.bktlg'), 'utf8')).toBe(rec(1));
  }, 60_000);
});
