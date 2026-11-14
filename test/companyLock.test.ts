/**
 * The "in use" lock next to a single-file company file (electron/companyLock.js) and the working
 * copy decisions (electron/companySession.js): one holder at a time, stale holders reported,
 * takeover only of the lock that was judged stale, access requests answered once, and a working
 * copy that is reused, recovered, refreshed or kept apart exactly when it should be.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeStartableFolder } from '@/lib/db/damage.fixture';

const require = createRequire(import.meta.url);
const lock = require('../electron/companyLock.js');
const session = require('../electron/companySession.js');
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-lock-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function companyFile(name: string) {
  const file = path.join(root, `${name}.ironbooks`);
  fs.writeFileSync(file, 'x');
  return file;
}

/** Pretend owner.json was last written `ms` ago (as the file server sees it). */
function age(file: string, ms: number) {
  const owner = path.join(lock.lockDirFor(file), 'owner.json');
  const t = new Date(Date.now() - ms);
  fs.utimesSync(owner, t, t);
}

describe('company file lock', () => {
  it('lets exactly one workstation in and tells the next one who has it', () => {
    const file = companyFile('One');
    const a = lock.acquire(file, { appUser: 'Mary' });
    expect(a.ok).toBe(true);
    const b = lock.acquire(file);
    expect(b.ok).toBe(false);
    expect(b.holder.owner.appUser).toBe('Mary');
    expect(b.holder.stale).toBe(false);
    expect(lock.describeOwner(b.holder.owner)).toBe(`Mary on ${os.hostname()}`);
    lock.release(a.lock);
    expect(lock.readHolder(file)).toBeNull();
    expect(lock.acquire(file).ok).toBe(true);
  });

  it('reports a holder whose heartbeat stopped as stale and lets the next person take over', () => {
    const file = companyFile('Stale');
    const a = lock.acquire(file, { computer: 'FRONT-DESK', pid: 999999 });
    age(file, lock.STALE_MS + 5_000);
    const b = lock.acquire(file);
    expect(b.ok).toBe(false);
    expect(b.holder.stale).toBe(true);
    const c = lock.takeOver(file, b.holder, { appUser: 'Bob' });
    expect(c.ok).toBe(true);
    // The old holder finds out at its next heartbeat and its save check.
    expect(lock.heartbeat(a.lock).lost).toBe(true);
    expect(lock.checkHeld(a.lock).held).toBe(false);
    expect(lock.checkHeld(c.lock).held).toBe(true);
  });

  it('a dead process on this computer is stale right away', () => {
    const file = companyFile('Crashed');
    const a = lock.acquire(file, { pid: 2 ** 30 }); // no such process
    expect(a.ok).toBe(true);
    const b = lock.acquire(file);
    expect(b.ok).toBe(false);
    expect(b.holder.sameComputer).toBe(true);
    expect(b.holder.stale).toBe(true);
  });

  it('does not take over a holder that came back meanwhile', () => {
    const file = companyFile('Back');
    const a = lock.acquire(file);
    age(file, lock.STALE_MS + 5_000);
    const judged = lock.acquire(file).holder;
    expect(judged.stale).toBe(true);
    lock.heartbeat(a.lock); // the holder woke up
    const c = lock.takeOver(file, judged);
    expect(c.ok).toBe(false);
    expect(lock.checkHeld(a.lock).held).toBe(true);
  });

  it('two computers taking over the same stale lock at the same instant: only one gets it', () => {
    // Review round 5 leftover: both judged the lock stale within milliseconds. Computer A takes
    // it over right after B has checked it (B's afterCheck hook) — B must not then remove A's
    // fresh lock and take it too.
    const file = companyFile('Race');
    lock.acquire(file, { computer: 'GONE-PC' });
    age(file, lock.STALE_MS + 5_000);
    const judged = lock.acquire(file).holder;
    expect(judged.stale).toBe(true);
    let a: { ok: boolean; lock?: { token: string } } | null = null;
    const b = lock.takeOver(file, judged, { appUser: 'B' }, {
      afterCheck: () => {
        a = lock.takeOver(file, judged, { appUser: 'A' });
      },
    });
    expect(a).not.toBeNull();
    expect(a!.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(lock.checkHeld(a!.lock).held).toBe(true);
    expect(lock.readHolder(file).owner.appUser).toBe('A');
    // Nothing left lying around next to the company file.
    expect(fs.readdirSync(root).filter((n) => n.includes('Race') && n.includes('takeover'))).toEqual([]);
  });

  it('heartbeats keep owner details and recreate a deleted lock folder', () => {
    const file = companyFile('Beat');
    const a = lock.acquire(file);
    lock.heartbeat(a.lock, { appUser: 'Mary', unsavedSince: 'x' });
    expect(lock.readHolder(file).owner).toMatchObject({ appUser: 'Mary', unsavedSince: 'x', token: a.lock.token });
    fs.rmSync(lock.lockDirFor(file), { recursive: true, force: true });
    expect(lock.heartbeat(a.lock).lost).toBe(false);
    expect(lock.readHolder(file).owner.token).toBe(a.lock.token);
  });

  it('passes access requests to the holder and answers each once', () => {
    const file = companyFile('Requests');
    const a = lock.acquire(file, { appUser: 'Mary' });
    const id = lock.requestAccess(file, { appUser: 'Bob', computer: 'BACK-OFFICE' });
    const pending = lock.pendingRequests(a.lock);
    expect(pending.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(pending[0]).toMatchObject({ appUser: 'Bob', computer: 'BACK-OFFICE' });
    expect(lock.readResponse(file, id)).toBeNull();
    lock.respond(a.lock, id, { decision: 'multi', host: { urls: ['https://10.0.0.5:47800'], fingerprint: 'sha256/x' } });
    expect(lock.pendingRequests(a.lock)).toEqual([]);
    expect(lock.readResponse(file, id)).toMatchObject({ decision: 'multi', by: { appUser: 'Mary' } });
    lock.cancelRequest(file, id);
    expect(lock.readResponse(file, id)).toBeNull();
    // Ids from another computer can't point outside the lock folder.
    expect(lock.readResponse(file, '../../owner')).toBeNull();
  });

  it('drops requests nobody answered in time', () => {
    const file = companyFile('Expired');
    const a = lock.acquire(file);
    const id = lock.requestAccess(file, { computer: 'X' });
    const req = path.join(lock.lockDirFor(file), 'requests', `${id}.json`);
    const t = new Date(Date.now() - lock.REQUEST_TTL_MS - 10_000);
    fs.utimesSync(req, t, t);
    expect(lock.pendingRequests(a.lock)).toEqual([]);
    expect(fs.existsSync(req)).toBe(false);
  });
});

describe('working copy decisions', () => {
  const file = path.join('C:', 'Books', 'Acme.ironbooks');
  const base = { companyFile: file, base: { saveId: 's1' }, unsavedSince: null };

  it('extracts when there is no usable working copy', () => {
    expect(session.planOpen({ companyFile: file, state: null, manifest: { saveId: 's1' }, dataExists: true })).toBe('extract');
    expect(session.planOpen({ companyFile: file, state: base, manifest: { saveId: 's1' }, dataExists: false })).toBe('extract');
    expect(
      session.planOpen({ companyFile: file, state: { ...base, companyFile: 'D:/Other.ironbooks' }, manifest: { saveId: 's1' }, dataExists: true }),
    ).toBe('extract');
  });

  it('reuses a clean copy of the same save, refreshes one that is out of date', () => {
    expect(session.planOpen({ companyFile: file, state: base, manifest: { saveId: 's1' }, dataExists: true })).toBe('reuse');
    expect(session.planOpen({ companyFile: file, state: base, manifest: { saveId: 's2' }, dataExists: true })).toBe('extract');
  });

  it('recovers unsaved changes, or keeps them apart when the file moved on', () => {
    const dirty = { ...base, unsavedSince: '2026-10-24T10:00:00Z' };
    expect(session.planOpen({ companyFile: file, state: dirty, manifest: { saveId: 's1' }, dataExists: true })).toBe('recover');
    expect(session.planOpen({ companyFile: file, state: dirty, manifest: { saveId: 's2' }, dataExists: true })).toBe('conflict');
  });

  it('names working copies per company file path, case-insensitively on Windows', () => {
    const r = path.join(root, 'Working');
    const a = session.workingDirFor('C:\\Books\\Acme.ironbooks', r);
    expect(path.basename(a)).toMatch(/^acme-[0-9a-f]{12}$/);
    if (process.platform === 'win32') expect(session.workingDirFor('c:\\books\\ACME.ironbooks', r)).toBe(a);
    expect(session.workingDirFor('C:\\Other\\Acme.ironbooks', r)).not.toBe(a);
  });

  it('prepares, reuses, recovers and keeps conflicting changes as a separate copy', async () => {
    const src = path.join(root, 'prep-src');
    await makeStartableFolder(src);
    fs.writeFileSync(path.join(src, 'base', 'rows'), 'v1');
    const cf = path.join(root, 'Prep.ironbooks');
    await format.writeCompanyFile(cf, {
      manifest: { formatVersion: 1, fileId: 'fid', companyName: 'Prep Co', saveId: 's1', savedAt: 'x' },
      entries: format.snapshotDir(src),
    });
    const wr = path.join(root, 'Working');

    const first = await session.prepareWorkingCopy(cf, { root: wr });
    expect(first.plan).toBe('extract');
    expect(fs.readFileSync(path.join(first.dataDir, 'base', 'rows'), 'utf8')).toBe('v1');

    // Work happened and was saved: next open reuses the copy.
    fs.writeFileSync(path.join(first.dataDir, 'base', 'rows'), 'v1+local');
    const again = await session.prepareWorkingCopy(cf, { root: wr });
    expect(again.plan).toBe('reuse');
    expect(fs.readFileSync(path.join(again.dataDir, 'base', 'rows'), 'utf8')).toBe('v1+local');

    // The app stopped with unsaved changes; the file is unchanged: recover them.
    session.writeState(again.workDir, { unsavedSince: '2026-10-24T10:00:00Z' });
    const rec = await session.prepareWorkingCopy(cf, { root: wr });
    expect(rec.plan).toBe('recover');
    expect(session.readState(rec.workDir).unsavedSince).toBe('2026-10-24T10:00:00Z');

    // Meanwhile someone else saved the file: keep ours apart, open theirs.
    fs.writeFileSync(path.join(src, 'base', 'rows'), 'v2-theirs');
    await format.writeCompanyFile(cf, {
      manifest: { formatVersion: 1, fileId: 'fid', companyName: 'Prep Co', saveId: 's2', savedAt: 'y' },
      entries: format.snapshotDir(src),
    });
    const conf = await session.prepareWorkingCopy(cf, { root: wr, onConflict: async () => true });
    expect(conf.plan).toBe('conflict');
    expect(fs.readFileSync(path.join(conf.dataDir, 'base', 'rows'), 'utf8')).toBe('v2-theirs');
    expect(conf.conflictCopy).toMatch(/unsaved changes from/);
    const kept = path.join(root, 'kept');
    await format.extractCompanyFile(conf.conflictCopy, kept);
    expect(fs.readFileSync(path.join(kept, 'base', 'rows'), 'utf8')).toBe('v1+local');
    expect(session.readState(conf.workDir)).toMatchObject({ unsavedSince: null, base: { saveId: 's2' } });
  });

  it('unsaved work left in the working copy of ANOTHER path to the same file (mapped drive vs UNC) is kept as a copy at open', async () => {
    // Review round 5 leftover: working copies are keyed by path, so unsaved work made through
    // S:\Books\X.ironbooks stayed invisible when the file was opened as \\SERVER\Books\X.ironbooks.
    const src = path.join(root, 'two-src');
    await makeStartableFolder(src);
    fs.writeFileSync(path.join(src, 'base', 'rows'), 'v1');
    const share = path.join(root, 'two-share');
    fs.mkdirSync(share, { recursive: true });
    const viaUnc = path.join(share, 'Two Paths.ironbooks');
    await format.writeCompanyFile(viaUnc, {
      manifest: { formatVersion: 1, fileId: 'fid-two', companyName: 'Two Paths', saveId: 's1', savedAt: 'x' },
      entries: format.snapshotDir(src),
    });
    // A second path to the very same file (a hard link stands in for the mapped drive letter).
    const mapped = path.join(root, 'two-mapped', 'Two Paths.ironbooks');
    fs.mkdirSync(path.dirname(mapped), { recursive: true });
    fs.linkSync(viaUnc, mapped);
    const wr = path.join(root, 'TwoWorking');
    const viaMapped = await session.prepareWorkingCopy(mapped, { root: wr });
    fs.writeFileSync(path.join(viaMapped.dataDir, 'base', 'rows'), 'v1+unsaved via S:');
    session.writeState(viaMapped.workDir, { unsavedSince: '2026-10-24T10:00:00Z', closedCleanly: false });

    const opened = await session.prepareWorkingCopy(viaUnc, { root: wr });
    expect(opened.plan).toBe('extract');
    expect(opened.otherPathCopies).toHaveLength(1);
    const kept = path.join(root, 'two-kept');
    await format.extractCompanyFile(opened.otherPathCopies[0], kept);
    expect(fs.readFileSync(path.join(kept, 'base', 'rows'), 'utf8')).toBe('v1+unsaved via S:');
    expect(path.dirname(opened.otherPathCopies[0])).toBe(share);
    // Kept once: the other working copy no longer counts as unsaved (and is refreshed when used).
    expect(session.readState(viaMapped.workDir)).toMatchObject({ unsavedSince: null, base: null });
    expect((await session.prepareWorkingCopy(viaUnc, { root: wr })).otherPathCopies ?? []).toHaveLength(0);
  });

  it('never prunes a working copy that holds unsaved changes', () => {
    const wr = path.join(root, 'Prune');
    const old = path.join(wr, 'old-aaaaaaaaaaaa');
    const dirty = path.join(wr, 'dirty-bbbbbbbbbbbb');
    session.writeState(old, { lastUsedAt: '2020-01-01T00:00:00Z', unsavedSince: null });
    session.writeState(dirty, { lastUsedAt: '2020-01-01T00:00:00Z', unsavedSince: '2020-01-01T00:00:00Z' });
    const removed = session.pruneWorkingCopies(wr);
    expect(removed).toEqual([old]);
    expect(fs.existsSync(dirty)).toBe(true);
  });
});
