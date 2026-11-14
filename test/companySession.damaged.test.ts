/**
 * Damaged copies of books kept in a working folder (electron/companySession.js keepDamagedCopy):
 *  - protected books are kept encrypted when their key is known, and a plain-text copy (no key was
 *    known yet) is encrypted once it is (sealDamagedCopies) or removed after DAMAGED_PLAIN_MAX_AGE_MS;
 *  - a leftover of a recovery that did not finish (data.recover-<time>) is cache, removed with it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const session = require('../electron/companySession.js');
const format = require('../electron/companyFileFormat.js');
const fileCrypto = require('../electron/fileCrypto.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-damaged-'));
const DAY = 24 * 3600 * 1000;

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

async function protectedBooks(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.exec("create table secret_probe (note text); insert into secret_probe values ('Zebulon Quarterfield');");
  await pg.close();
  fs.writeFileSync(path.join(dir, session.PROTECTED_MARKER), '{}\n');
}

function protection() {
  const fileKey = fileCrypto.generateFileKey();
  return { fileKey, keyCheck: fileCrypto.keyCheckOf(fileKey), lookupSalt: fileCrypto.newLookupSalt(), slots: [] };
}

describe('damaged copies kept in a working folder', () => {
  it('protected books with a known key are kept as an encrypted company file, nothing in plain text', async () => {
    const work = path.join(ROOT, 'enc');
    const data = path.join(work, 'data');
    await protectedBooks(data);
    const kept = await session.keepDamagedCopy(work, data, { protection: protection(), companyName: 'Marigold Bakery' });
    expect(kept).toMatch(/damaged copy .*\.ironbooks$/);
    expect(format.isSealedManifest(format.readCompanyManifest(kept))).toBe(true);
    expect(fs.readFileSync(kept).includes(Buffer.from('Zebulon'))).toBe(false);
    expect(fs.existsSync(data)).toBe(false);
  }, 60_000);

  it('a plain-text copy (no key yet) is encrypted once the key is known', async () => {
    const work = path.join(ROOT, 'later');
    const data = path.join(work, 'data');
    await protectedBooks(data);
    const kept = await session.keepDamagedCopy(work, data);
    expect(fs.existsSync(path.join(kept, 'PG_VERSION'))).toBe(true);
    expect(session.readState(work).damagedPlain).toHaveLength(1);
    const done = await session.sealDamagedCopies(work, protection(), { companyName: 'Marigold Bakery' });
    expect(done).toHaveLength(1);
    expect(fs.existsSync(kept)).toBe(false);
    expect(format.isSealedManifest(format.readCompanyManifest(done[0].to))).toBe(true);
    expect(session.readState(work).damagedPlain ?? null).toBeNull();
  }, 60_000);

  it('a plain-text copy nobody could encrypt is removed after its time, a newer one stays', () => {
    const root = path.join(ROOT, 'prune');
    const work = path.join(root, 'marigold-1234');
    const old = path.join(work, 'damaged copy 2026-10-01 0900');
    const recent = path.join(work, 'damaged copy 2026-11-13 0900');
    for (const d of [old, recent]) fs.mkdirSync(d, { recursive: true });
    const now = Date.now();
    session.writeState(work, {
      lastUsedAt: new Date(now).toISOString(),
      damagedPlain: [
        { path: old, at: new Date(now - session.DAMAGED_PLAIN_MAX_AGE_MS - DAY).toISOString() },
        { path: recent, at: new Date(now - DAY).toISOString() },
      ],
    });
    session.pruneWorkingCopies(root, [], now);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(session.readState(work).damagedPlain).toEqual([{ path: recent, at: expect.any(String) }]);
  });

  it('a leftover of an unfinished recovery is cache: an old working folder holding one is removed', () => {
    const root = path.join(ROOT, 'leftover');
    const work = path.join(root, 'acme-5678');
    fs.mkdirSync(path.join(work, 'data'), { recursive: true });
    fs.mkdirSync(path.join(work, `data.recover-${Date.now()}`), { recursive: true });
    session.writeState(work, { lastUsedAt: new Date(Date.now() - 60 * DAY).toISOString() });
    expect(session.pruneWorkingCopies(root, [], Date.now())).toEqual([work]);
    expect(fs.existsSync(work)).toBe(false);
  });

  it('a plain-text folder left behind after the encrypted copy was written is recorded, so it is removed in time', async () => {
    const work = path.join(ROOT, 'busy');
    const data = path.join(work, 'data');
    await protectedBooks(data);
    const realRm = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === data) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return realRm(p, o);
    }) as typeof fs.rmSync);
    let kept: string;
    try {
      kept = await session.keepDamagedCopy(work, data, { protection: protection() });
    } finally {
      spy.mockRestore();
    }
    expect(kept).toMatch(/\.ironbooks$/);
    expect(fs.existsSync(data)).toBe(true); // still there for now
    expect(session.readState(work).damagedPlain).toEqual([{ path: data, at: expect.any(String) }]);
  }, 60_000);

  it('the plain-text copies of the very file being opened expire too', () => {
    const root = path.join(ROOT, 'prune-open');
    const work = path.join(root, 'marigold-5678');
    const old = path.join(work, 'damaged copy 2026-10-01 0900');
    fs.mkdirSync(old, { recursive: true });
    const now = Date.now();
    session.writeState(work, {
      lastUsedAt: new Date(now).toISOString(),
      damagedPlain: [{ path: old, at: new Date(now - session.DAMAGED_PLAIN_MAX_AGE_MS - DAY).toISOString() }],
    });
    session.pruneWorkingCopies(root, [work], now); // `work` is the file being opened: kept, but not its old plain text
    expect(fs.existsSync(work)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });
});
