/**
 * QA re-test (round 1) for the portable company file fixes:
 *  - the carried-file allow-list refuses everything but attachments/** and transactions.bktlg
 *    (secrets, PGlite internals, look-alike names, bare folder names) and leaves nothing on disk;
 *  - a legitimate extra attachment still restores (the allow-list is not over-strict);
 *  - a failed restore into a pre-existing EMPTY folder empties it but keeps the folder; a
 *    non-empty destination is refused without touching the user's files;
 *  - the restored copy carries the log anchor and verifies;
 *  - a file stripped of its transaction log cannot yield a copy whose log verifies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { postJournalEntry } from './posting';
import {
  createPortableCompanyFile,
  restorePortableCompanyFile,
  PORTABLE_CHECKSUMS_ENTRY,
  PORTABLE_MANIFEST_ENTRY,
  type PortableManifest,
} from './portableFile';
import { verifyTransactionLog, TRANSACTION_LOG_FILE } from './transactionLog';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-companyfile-retest');
const SRC = path.join(ROOT, 'source');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function reseal(buffer: Buffer, edit: (files: Map<string, Buffer>, m: PortableManifest) => void): Buffer {
  const src = new AdmZip(buffer);
  const files = new Map<string, Buffer>();
  for (const e of src.getEntries()) files.set(e.entryName, e.getData());
  const manifest = JSON.parse(files.get(PORTABLE_MANIFEST_ENTRY)!.toString('utf8')) as PortableManifest;
  edit(files, manifest);
  files.set(PORTABLE_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest)));
  const lines = [...files.entries()]
    .filter(([n]) => n !== PORTABLE_CHECKSUMS_ENTRY)
    .map(([n, d]) => `${sha(d)}  ${n}`);
  files.set(PORTABLE_CHECKSUMS_ENTRY, Buffer.from(lines.join('\n') + '\n'));
  const out = new AdmZip();
  for (const [n, d] of files) out.addFile(n, d);
  return out.toBuffer();
}

function withExtraFile(buffer: Buffer, rel: string, content = 'planted'): Buffer {
  return reseal(buffer, (files, m) => {
    const bytes = Buffer.from(content);
    files.set(`files/${rel}`, bytes);
    m.files[rel] = { bytes: bytes.length, sha256: sha(bytes) };
  });
}

let db: DB;
let ctx: ServiceContext;
let good: Buffer;

describe('portable company file — re-test', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(SRC);
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@cf-retest.test', name: 'Owner', passwordHash: 'hash' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'Retest Portable Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id, role: 'owner' };
    const a: Record<string, string> = {};
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['6000', 'Rent', 'expense', 'operating_expenses'],
    ] as const) {
      a[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
    await createCustomer(ctx, { displayName: 'Portable Customer' });
    await postJournalEntry(ctx, {
      date: new Date('2025-04-01'),
      description: 'Rent',
      lines: [
        { accountId: a['6000'], debit: '1234.56' },
        { accountId: a['1000'], credit: '1234.56' },
      ],
    });
    good = (await createPortableCompanyFile(ctx, { dataDir: SRC })).buffer;
  }, 120_000);

  afterAll(async () => {
    for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) await closeDb(path.join(ROOT, d)).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the allow-list refuses everything that is not an attachment or the log, leaving nothing on disk', async () => {
    const target = path.join(ROOT, 'allow-list');
    const refusedButRestored: string[] = [];
    for (const rel of [
      '.auth-secret',
      'PG_VERSION',
      'postgresql.auto.conf',
      'base/1/1259',
      'bookkeeper-company.json',
      'attachments',
      'attachments/',
      'attachments/./../.auth-secret',
      'attachments/sub/../../.auth-secret',
      'attachments\\..\\.auth-secret',
      'Transactions.BKTLG',
      'transactions.bktlg/../.auth-secret',
      'attachmentsX/evil.txt',
      '/etc/passwd',
      'C:/Windows/evil.txt',
    ]) {
      let bad: Buffer;
      try {
        bad = withExtraFile(good, rel);
      } catch {
        continue; // the zip library itself refused the name — nothing to restore
      }
      try {
        await restorePortableCompanyFile(bad, target);
        refusedButRestored.push(rel);
      } catch (err) {
        expect(err, rel).toMatchObject({ code: 'VALIDATION' });
      }
      if (fs.existsSync(target)) {
        if (!refusedButRestored.includes(rel)) refusedButRestored.push(`${rel} (left folder behind)`);
        await closeDb(target).catch(() => undefined);
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    expect(refusedButRestored).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, '.auth-secret'))).toBe(false);
  });

  it('a legitimate extra attachment still restores', async () => {
    const target = path.join(ROOT, 'extra-attachment');
    await restorePortableCompanyFile(withExtraFile(good, 'attachments/sub dir/receipt #1.txt', 'receipt'), target);
    expect(fs.readFileSync(path.join(target, 'attachments', 'sub dir', 'receipt #1.txt'), 'utf8')).toBe('receipt');
  }, 120_000);

  it('a failed restore into an existing empty folder empties it but keeps the folder', async () => {
    const target = path.join(ROOT, 'pre-existing-empty');
    fs.mkdirSync(target, { recursive: true });
    const bad = reseal(good, (_f, m) => {
      m.tables.customers.columns = [...m.tables.customers.columns, 'no_such_column'];
    });
    await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  }, 120_000);

  it('a non-empty destination is refused without touching its files', async () => {
    const target = path.join(ROOT, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'mine.txt'), 'keep me');
    await expect(restorePortableCompanyFile(good, target)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.readdirSync(target)).toEqual(['mine.txt']);
  });

  it('the restored copy carries the log anchor and its log verifies', async () => {
    const target = path.join(ROOT, 'copy');
    await restorePortableCompanyFile(good, target);
    const dbC = await getDb(target);
    const v = await verifyTransactionLog(dbC, target);
    expect(v.anchored).toBe(true);
    expect(v.chainIntact).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.postedEntries).toBe(1);
    expect(v.missingEntries).toEqual([]);
  }, 120_000);

  it('a file stripped of its transaction log cannot produce a copy whose log verifies', async () => {
    const target = path.join(ROOT, 'stripped-log');
    const bad = reseal(good, (files, m) => {
      files.delete(`files/${TRANSACTION_LOG_FILE}`);
      delete m.files[TRANSACTION_LOG_FILE];
      m.transactionLog = null;
    });
    let restored = false;
    try {
      await restorePortableCompanyFile(bad, target);
      restored = true;
    } catch (err) {
      expect(err).toMatchObject({ code: 'VALIDATION' });
      expect(fs.existsSync(target)).toBe(false);
    }
    if (restored) {
      const dbS = await getDb(target);
      expect((await verifyTransactionLog(dbS, target)).ok).toBe(false);
    }
  }, 120_000);
});
