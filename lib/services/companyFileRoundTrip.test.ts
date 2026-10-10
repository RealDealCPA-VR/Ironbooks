/**
 * Company-file fidelity round trips:
 *
 *  .bka (compressed physical backup): build a company with many document types → backup the
 *  LIVE data dir → restore into a fresh dir → every table's row count + content hash, every
 *  account balance, the trial balance and the transaction log are identical.
 *
 *  .bkp (portable company file): same guarantees through the logical export, plus integrity
 *  refusals — a corrupted entry, a forged ledger, a newer schema, a non-empty destination and
 *  a .bka passed as .bkp are all refused and leave nothing behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { getDb, closeDb, type DB } from '@/lib/db';
import { createBackup, restoreBackup } from './backup';
import {
  computeLedgerChecksums,
  computeTableDigests,
  createPortableCompanyFile,
  openPortableFile,
  restorePortableCompanyFile,
  PORTABLE_CHECKSUMS_ENTRY,
  PORTABLE_MANIFEST_ENTRY,
  type PortableManifest,
} from './portableFile';
import { transactionLogPath, verifyTransactionLog } from './transactionLog';
import { trialBalance } from './reports';
import { seedRichCompany, type RichCompany } from './companyFile.fixture';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-companyfile-roundtrip');
const SRC = path.join(ROOT, 'source');
const BKA_DIR = path.join(ROOT, 'from-bka');
const BKP_DIR = path.join(ROOT, 'from-bkp');

let db: DB;
let rich: RichCompany;
let digests: Awaited<ReturnType<typeof computeTableDigests>>;
let ledger: Awaited<ReturnType<typeof computeLedgerChecksums>>;
let tlogBytes: Buffer;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Rewrite a .bkp with edits applied, optionally re-sealing the checksum list. */
function rewritePortable(
  buffer: Buffer,
  edit: (files: Map<string, Buffer>) => void,
  reseal: boolean,
): Buffer {
  const src = new AdmZip(buffer);
  const files = new Map<string, Buffer>();
  for (const e of src.getEntries()) files.set(e.entryName, e.getData());
  edit(files);
  if (reseal) {
    const lines = [...files.entries()]
      .filter(([n]) => n !== PORTABLE_CHECKSUMS_ENTRY)
      .map(([n, d]) => `${sha(d)}  ${n}`);
    files.set(PORTABLE_CHECKSUMS_ENTRY, Buffer.from(lines.join('\n') + '\n'));
  }
  const out = new AdmZip();
  for (const [n, d] of files) out.addFile(n, d);
  return out.toBuffer();
}

async function expectIdenticalCopy(dir: string) {
  const copy = await getDb(dir);
  expect(await computeTableDigests(copy)).toEqual(digests);
  expect(await computeLedgerChecksums(copy)).toEqual(ledger);
  const tb = await trialBalance({ db: copy, companyId: rich.ctx.companyId, userId: null });
  expect(tb.balanced).toBe(true);
  expect(fs.readFileSync(transactionLogPath(dir))).toEqual(tlogBytes);
  const v = await verifyTransactionLog(copy, dir);
  expect(v.ok).toBe(true);
  const att = fs.readdirSync(path.join(SRC, 'attachments'));
  for (const f of att) {
    expect(fs.readFileSync(path.join(dir, 'attachments', f))).toEqual(fs.readFileSync(path.join(SRC, 'attachments', f)));
  }
}

describe('company file round trips (.bka + .bkp)', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(SRC);
    rich = await seedRichCompany(db, SRC);
    digests = await computeTableDigests(db);
    ledger = await computeLedgerChecksums(db);
    tlogBytes = fs.readFileSync(transactionLogPath(SRC));
  }, 180_000);

  afterAll(async () => {
    for (const d of [SRC, BKA_DIR, BKP_DIR]) await closeDb(d);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the source company is rich and its own log verifies', async () => {
    const counts = Object.fromEntries(Object.entries(digests).map(([k, v]) => [k, v.rows]));
    for (const t of [
      'users', 'companies', 'accounts', 'customers', 'vendors', 'items', 'classes', 'invoices',
      'invoice_lines', 'payments_received', 'sales_receipts', 'deposits', 'credit_memos', 'estimates',
      'bills', 'bill_payments', 'vendor_credits', 'expenses', 'transfers', 'journal_entries',
      'journal_entry_lines', 'audit_logs', 'attachments',
    ]) {
      expect(counts[t], t).toBeGreaterThan(0);
    }
    expect(Object.values(ledger)[0].balanced).toBe(true);
    expect((await verifyTransactionLog(db, SRC)).ok).toBe(true);
  });

  it('.bka backups are compressed (deflate) and restore 100%', async () => {
    const { buffer } = createBackup('Rich Test Co', SRC); // live data dir
    const zip = new AdmZip(buffer);
    const fileEntries = zip.getEntries().filter((e) => !e.isDirectory);
    const raw = fileEntries.reduce((n, e) => n + e.header.size, 0);
    expect(fileEntries.filter((e) => e.header.size > 0).every((e) => e.header.method === 8)).toBe(true);
    expect(buffer.length).toBeLessThan(raw / 3); // PGlite pages compress very well

    await restoreBackup(buffer, BKA_DIR);
    await expectIdenticalCopy(BKA_DIR);
  });

  it('.bkp portable file restores an exact copy into a new company dir', async () => {
    const { buffer, filename, manifest } = await createPortableCompanyFile(rich.ctx, { dataDir: SRC });
    expect(filename).toBe('Rich Test Co.bkp');
    expect(manifest.companyName).toBe('Rich Test Co');
    expect(manifest.rowCounts.users).toBe(1);
    expect(manifest.tables.users.sha256).toBe(digests.users.sha256);
    expect(manifest.ledger[rich.ctx.companyId].balanced).toBe(true);
    expect(manifest.transactionLog?.sha256).toBe(sha(tlogBytes));
    expect(manifest.files['attachments/' + fs.readdirSync(path.join(SRC, 'attachments'))[0]]).toBeTruthy();
    // The session-signing secret never travels.
    expect(Object.keys(manifest.files).some((f) => f.includes('auth-secret'))).toBe(false);
    // Compressed.
    const zip = new AdmZip(buffer);
    expect(zip.getEntries().filter((e) => e.header.size > 64).every((e) => e.header.method === 8)).toBe(true);

    const result = await restorePortableCompanyFile(buffer, BKP_DIR);
    expect(result.companyName).toBe('Rich Test Co');
    expect(result.verified.ledgersBalanced).toBe(true);
    expect(fs.existsSync(path.join(BKP_DIR, 'bookkeeper-company.json'))).toBe(true);
    await expectIdenticalCopy(BKP_DIR);
  });

  describe('integrity refusals', () => {
    let good: Buffer;
    const target = path.join(ROOT, 'refused');

    beforeAll(async () => {
      good = (await createPortableCompanyFile(rich.ctx, { dataDir: SRC })).buffer;
    });

    it('refuses a corrupted entry before writing anything', async () => {
      const bad = rewritePortable(
        good,
        (f) => f.set('data/journal_entry_lines.jsonl', Buffer.from(f.get('data/journal_entry_lines.jsonl')!.toString().replace('25000.00', '25001.00'))),
        false,
      );
      await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(fs.existsSync(target)).toBe(false);
    });

    it('refuses a re-sealed file whose ledger no longer matches (TB verification after restore)', async () => {
      const bad = rewritePortable(
        good,
        (f) => {
          // Change an amount AND fix the table hash in the manifest so only the ledger check can catch it.
          const text = f.get('data/journal_entry_lines.jsonl')!.toString().replace('"25000.00"', '"25100.00"');
          f.set('data/journal_entry_lines.jsonl', Buffer.from(text));
          const m = JSON.parse(f.get(PORTABLE_MANIFEST_ENTRY)!.toString()) as PortableManifest;
          m.tables.journal_entry_lines.sha256 = sha(text);
          f.set(PORTABLE_MANIFEST_ENTRY, Buffer.from(JSON.stringify(m)));
        },
        true,
      );
      expect(() => openPortableFile(bad)).not.toThrow();
      await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/trial balance/),
      });
      expect(fs.existsSync(target)).toBe(false);
    });

    it('refuses a file from a newer schema', async () => {
      const bad = rewritePortable(
        good,
        (f) => {
          const m = JSON.parse(f.get(PORTABLE_MANIFEST_ENTRY)!.toString()) as PortableManifest;
          m.schemaVersion.lastMigrationAt = 9_999_999_999_999;
          f.set(PORTABLE_MANIFEST_ENTRY, Buffer.from(JSON.stringify(m)));
        },
        true,
      );
      await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({
        message: expect.stringMatching(/newer version/),
      });
      expect(fs.existsSync(target)).toBe(false);
    });

    it('refuses a non-empty destination and a .bka passed as .bkp', async () => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'keep.txt'), 'existing');
      await expect(restorePortableCompanyFile(good, target)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('existing');
      fs.rmSync(target, { recursive: true, force: true });

      const bka = createBackup('x', SRC).buffer;
      await expect(restorePortableCompanyFile(bka, target)).rejects.toMatchObject({
        message: expect.stringMatching(/backup \(\.bka\)/),
      });
    });
  });
});
