/**
 * Security 1.4 / 1.5 — archives from someone else (electron/companyFileFormat.js, backup.ts,
 * accountantCopy/accountant.ts, sealedArchives.ts).
 *
 *  A. Size guards. The per-company backup and the Accountant's Copy readers inflated every entry
 *     without the size check the other readers make, and a company file declaring 64 GB of zeros
 *     (about 60 MB on disk) was within the caps and really unpacked to 64 GB. Now every reader
 *     checks sizes first, and above 4 GiB a file may not unpack to more than 100 times what it
 *     stores (real company files stay far below 20 to 1).
 *  B. Blocked names. ".Auth-Secret", "IRONBOOKS.LOCK" or ".auth-secret." in a crafted file landed
 *     on this computer's own files on Windows (names were compared exactly). Names are now compared
 *     as Windows resolves them, and names with ':' (alternate data streams), device names and
 *     trailing spaces are never written.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import fmt from '@/electron/companyFileFormat';
import { makeStartableFolder } from '@/lib/db/damage.fixture';
import { diskSafeName } from './attachments';
import { openBackupBuffer, openCompanyBackup, readCompanyBackup, validateBackupZip } from './backup';
import { readTransferManifest } from './accountantCopy/accountant';
import { TRANSFER_ENTRY } from './accountantCopy/format';
import { writeUnsealedEntries } from './sealedArchives';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-security1-archives-'));
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

const GiB = 1024 * 1024 * 1024;

/** Patch the declared uncompressed size of the zip entry `name` (local and central headers). */
function patchDeclaredSize(buf: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(buf);
  const nameBuf = Buffer.from(name, 'utf8');
  let patched = 0;
  for (let i = out.indexOf(nameBuf); i !== -1; i = out.indexOf(nameBuf, i + 1)) {
    if (i >= 30 && out.readUInt32LE(i - 30) === 0x04034b50) {
      out.writeUInt32LE(size, i - 30 + 22);
      patched++;
    } else if (i >= 46 && out.readUInt32LE(i - 46) === 0x02014b50) {
      out.writeUInt32LE(size, i - 46 + 24);
      patched++;
    }
  }
  expect(patched).toBeGreaterThanOrEqual(2);
  return out;
}

/** Rename an entry in place (local and central headers): the new name has the same byte length. */
function renameEntry(buf: Buffer, from: string, to: string): Buffer {
  const a = Buffer.from(from, 'utf8');
  const b = Buffer.from(to, 'utf8');
  expect(b.length).toBe(a.length);
  const out = Buffer.from(buf);
  let n = 0;
  for (let i = out.indexOf(a); i !== -1; i = out.indexOf(a, i + 1)) {
    b.copy(out, i);
    n++;
  }
  expect(n).toBeGreaterThanOrEqual(2);
  return out;
}

const manifest = (id: string) => ({ formatVersion: 1, fileId: id, companyName: id, saveId: 's', savedAt: new Date().toISOString() });

describe('A. size guards', () => {
  it('checkSizes refuses an archive that unpacks to far more than it stores, above 4 GiB only', () => {
    const entry = (size: number, csize: number) => ({ name: 'base/1/1', size, csize });
    // 4 x 1.2 GiB from 4 MB stored: refused.
    expect(() => fmt.checkSizes([1, 2, 3, 4].map(() => entry(1.2 * GiB, 1024 * 1024)))).toThrow(/larger than any company file can be/);
    // The same sizes from 100 MB each (12 to 1, like real table data): fine.
    expect(fmt.checkSizes([1, 2, 3, 4].map(() => entry(1.2 * GiB, 100 * 1024 * 1024)))).toBeGreaterThan(4 * GiB);
    // Under 4 GiB any ratio is fine (empty log segments pack about 1000 to 1).
    expect(fmt.checkSizes([entry(1.2 * GiB, 16)])).toBe(1.2 * GiB);
    // Without stored sizes nothing changes.
    expect(fmt.checkSizes([1, 2, 3, 4].map(() => ({ name: 'x', size: 1.2 * GiB })))).toBeGreaterThan(4 * GiB);
  });

  it('a company file declaring 4.8 GB of zeros is refused before anything is written', async () => {
    const file = path.join(ROOT, 'zeros.ironbooks');
    const names = ['base/1/11', 'base/1/12', 'base/1/13', 'base/1/14'];
    await fmt.writeCompanyFile(file, { manifest: manifest('zeros'), entries: names.map((name) => ({ name, data: Buffer.alloc(1024 * 1024) })) });
    let bytes: Buffer = fs.readFileSync(file);
    for (const n of names) bytes = patchDeclaredSize(bytes, n, Math.floor(1.2 * GiB));
    fs.writeFileSync(file, bytes);
    const out = path.join(ROOT, 'zeros-out');
    await expect(fmt.extractCompanyFile(file, out)).rejects.toThrow(/larger than any company file can be/);
    expect(fs.existsSync(path.join(out, 'base'))).toBe(false);
  });

  it('a per-company backup with an entry declaring 3 GB is refused before it is inflated', async () => {
    const zip = new AdmZip();
    zip.addFile('bookkeeper-manifest.json', Buffer.from(JSON.stringify({ app: 'bookkeeper-ai', formatVersion: 1, kind: 'company', companyName: 'X' })));
    zip.addFile('company-data.json', Buffer.from(JSON.stringify({ company: { id: 'c', name: 'X', settings: null }, tables: {} })));
    zip.addFile('files/attachments/a-receipt.pdf', Buffer.alloc(1024 * 1024));
    const good = zip.toBuffer();
    expect(readCompanyBackup(good).company.name).toBe('X');
    const crafted = patchDeclaredSize(good, 'files/attachments/a-receipt.pdf', 3 * GiB);
    expect(() => readCompanyBackup(crafted)).toThrow(expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/more than any company file can hold/) }));
    await expect(openCompanyBackup(crafted)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("an Accountant's Copy transfer file with an entry declaring 3 GB is refused before it is inflated", () => {
    const zip = new AdmZip();
    zip.addFile(TRANSFER_ENTRY, Buffer.from(JSON.stringify({ app: 'ironbooks', kind: 'accountant-copy', copyId: 'x', dividingDate: '2026-01-31' }) + ' '.repeat(4096)));
    // Its own manifest is the first thing it inflates.
    const crafted = patchDeclaredSize(zip.toBuffer(), TRANSFER_ENTRY, 3 * GiB);
    expect(() => readTransferManifest(crafted)).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: "The Accountant's Copy transfer file is damaged (it unpacks to more than any company file can hold)." }),
    );
  });
});

describe('B. names a crafted file must never write', () => {
  it('blocked names are recognised whatever their case, trailing dots or spaces', () => {
    for (const n of ['.Auth-Secret', '.AUTH-SECRET', '.auth-secret.', '.auth-secret .', '.auth-secret:x', 'Ironbooks.Lock', '.IRONBOOKS-SANDBOX.json', '.Ironbooks-Protected', 'POSTMASTER.PID', 'PG_STAT_TMP/x', '.IRONBOOKS-CLOCK-1', 'IRONBOOKS.LOCK.TAKEOVER-1']) {
      expect(fmt.isExcludedPath(n), n).toBe(true);
    }
    for (const n of ['PG_VERSION', 'base/1/1259', 'transactions.bktlg', '.backup-history.json', 'attachments/x-.auth-secret']) {
      expect(fmt.isExcludedPath(n), n).toBe(false);
    }
  });

  it('names with ":", Windows device names and trailing spaces are not safe entry names', () => {
    for (const n of ['x.txt:evil', 'base/1:2', 'CON', 'con.txt', 'attachments/NUL', 'aux.tar.gz', 'COM1', 'lpt9.log', 'nul .txt', 'CONIN$', 'trail ', 'dir /x']) {
      expect(fmt.safeEntryName(n), n).toBeNull();
    }
    for (const n of ['console', 'COM10', 'auxiliary.txt', 'base/1/1259_fsm', 'attachments/uuid-receipt.', '.auth-secret']) {
      expect(fmt.safeEntryName(n), n).toBe(n);
    }
  });

  it('every name the app writes still passes: a real PGlite folder, attachments, root files', async () => {
    const dir = path.join(ROOT, 'real-folder');
    await makeStartableFolder(dir);
    const names: string[] = [];
    const walk = (abs: string, rel: string) => {
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          names.push(`${r}/`);
          walk(path.join(abs, d.name), r);
        } else names.push(r);
      }
    };
    walk(dir, '');
    expect(names.length).toBeGreaterThan(100);
    const uuid = '0b8e3b9a-6d2c-4f0e-9a7b-2c1d3e4f5a6b';
    for (const original of ['my receipt (1).pdf', 'a:b.txt', 'con.txt', 'trailing. ', 'scan..', 'Ünïcødé.png', 'nul']) {
      names.push(`attachments/${uuid}-${diskSafeName(original)}`);
    }
    names.push('transactions.bktlg', '.backup-history.json', '.backup-settings.json', '.file-id');
    const refused = names.filter((n) => !fmt.safeEntryName(n));
    expect(refused).toEqual([]);
  });

  it('a company file carrying case variants of this computer\'s own files never writes them', async () => {
    const file = path.join(ROOT, 'names.ironbooks');
    const crafted = ['.Auth-Secret', 'IRONBOOKS.LOCK', '.auth-secret.', '.IRONBOOKS-SANDBOX.json', '.Ironbooks-Protected'];
    // Written under placeholder names of the same length, then renamed in the bytes.
    const placeholder = (n: string) => 'q'.repeat(Buffer.byteLength(n));
    await fmt.writeCompanyFile(file, {
      manifest: manifest('names'),
      entries: [{ name: 'base/1/1', data: Buffer.from('table') }, ...crafted.map((n, i) => ({ name: placeholder(n).slice(0, -1) + String(i), data: Buffer.from('planted') }))],
    });
    let bytes: Buffer = fs.readFileSync(file);
    crafted.forEach((n, i) => {
      bytes = renameEntry(bytes, placeholder(n).slice(0, -1) + String(i), n);
    });
    fs.writeFileSync(file, bytes);
    const out = path.join(ROOT, 'names-out');
    await fmt.extractCompanyFile(file, out);
    expect(fs.readdirSync(out).sort()).toEqual(['base']);
    expect(fs.readFileSync(path.join(out, 'base', '1', '1'), 'utf8')).toBe('table');
  });

  it('a company file carrying ":" streams, device names or trailing spaces never writes them', async () => {
    const file = path.join(ROOT, 'streams.ironbooks');
    const crafted = ['x.txt:evil', 'aux.txt', 'CON', 'trail '];
    const placeholder = (n: string, i: number) => 'q'.repeat(Buffer.byteLength(n) - 1) + String(i);
    await fmt.writeCompanyFile(file, {
      manifest: manifest('streams'),
      entries: [{ name: 'base/1/1', data: Buffer.from('table') }, ...crafted.map((n, i) => ({ name: placeholder(n, i), data: Buffer.from('planted') }))],
    });
    let bytes: Buffer = fs.readFileSync(file);
    crafted.forEach((n, i) => {
      bytes = renameEntry(bytes, placeholder(n, i), n);
    });
    fs.writeFileSync(file, bytes);
    const out = path.join(ROOT, 'streams-out');
    await fmt.extractCompanyFile(file, out);
    expect(fs.readdirSync(out).sort()).toEqual(['base']);
  });

  it('an unsealed backup written to disk leaves out the same names (and its manifests, in any case)', () => {
    const out = path.join(ROOT, 'unsealed-out');
    const e = (name: string) => ({ name, data: Buffer.from('x') });
    writeUnsealedEntries(
      [e('PG_VERSION'), e('.Auth-Secret'), e('IRONBOOKS.LOCK'), e('.FILE-ID'), e('Bookkeeper-Manifest.json'), e('x.txt:evil'), e('nul.txt')],
      out,
      ['.file-id'],
    );
    expect(fs.readdirSync(out)).toEqual(['PG_VERSION']);
  });

  it('a plain full backup with such names still validates, and they are left out when it is unpacked', async () => {
    const zip = new AdmZip();
    zip.addFile('PG_VERSION', Buffer.from('17\n'));
    zip.addFile('global/pg_control', Buffer.from('x'));
    zip.addFile('qqqqqqqqqq', Buffer.from('planted'));
    const crafted = renameEntry(zip.toBuffer(), 'qqqqqqqqqq', 'x.txt:evi1');
    // Accepted as before (no app-made backup has such a name; nothing else about it changes)…
    expect(() => validateBackupZip(crafted)).not.toThrow();
    // …but the entry is not written ("x.txt:evi1" would create x.txt with a hidden stream).
    const out = path.join(ROOT, 'plain-out');
    (await openBackupBuffer(crafted)).extractTo(out);
    expect(fs.readdirSync(out).sort()).toEqual(['PG_VERSION', 'global']);
  });
});
