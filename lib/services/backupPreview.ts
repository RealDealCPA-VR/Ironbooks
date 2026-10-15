/**
 * Restore preview: look inside a .bka backup BEFORE it replaces the company file.
 *
 * The archive is validated exactly like a restore (validateBackupZip), extracted into a private
 * temporary folder under the OS temp dir, opened there as its own PGlite database, and read:
 * the companies in it, how many transactions each has and the date of the latest one, trial
 * balance totals (debits = credits), plus the backup's date and the Ironbooks version that made
 * it. The same "would this restore be accepted?" check the restore runs (verifyRestoredBooks)
 * is run on the copy, so a damaged backup is flagged before the person confirms.
 *
 * The live company file is never opened, closed or written by a preview, and the temporary
 * folder is always deleted afterwards (plus any left behind by a crash, on the next preview).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, count, eq, isNull, max } from 'drizzle-orm';
import { closeDb, getDb, withDamagedFileAccess } from '@/lib/db';
import { bills, companies, invoices, journalEntries } from '@/lib/db/schema';
import { BACKUP_MANIFEST_ENTRY, FILE_LOCAL_FILES, validateBackupZip, verifyRestoredBooks } from './backup';
import { trialBalance } from './reports';
import { ServiceError } from './errors';
import { Money } from '@/lib/money';

/** Prefix of every preview temp folder (so stale ones can be found and removed). */
export const PREVIEW_DIR_PREFIX = 'ironbooks-preview-';
/** Preview folders older than this are leftovers from a crash and are removed. */
const STALE_PREVIEW_MS = 60 * 60 * 1000;

export interface PreviewCompany {
  name: string;
  /** Posted (not voided) transactions. */
  transactions: number;
  invoices: number;
  bills: number;
  /** Date (YYYY-MM-DD) of the latest posted transaction; null when there are none. */
  lastTransactionDate: string | null;
  trialBalance: { totalDebit: string; totalCredit: string; balanced: boolean } | null;
}

export interface BackupPreview {
  /** When the backup was made (manifest; or the newest file in a pre-manifest archive). */
  backupDate: string | null;
  /** Ironbooks version that made it; null for backups made before versions were stamped. */
  appVersion: string | null;
  /** Company name stamped into the backup when it was made. */
  label: string | null;
  sizeBytes: number;
  companies: PreviewCompany[];
  /** Every company's trial balance has debits = credits. */
  balanced: boolean;
  /** Problems that would make the restore refuse this backup (empty = it would be accepted). */
  problems: string[];
}

export function previewTempRoot(): string {
  return os.tmpdir();
}

/** Remove preview folders left behind by a crash (best-effort). */
export function cleanupStalePreviewDirs(now: number = Date.now(), root: string = previewTempRoot()): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(PREVIEW_DIR_PREFIX)) continue;
      const full = path.join(root, name);
      try {
        if (now - fs.statSync(full).mtimeMs < STALE_PREVIEW_MS) continue;
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed++;
      } catch {
        /* in use or already gone */
      }
    }
  } catch {
    /* temp dir unreadable — nothing to clean */
  }
  return removed;
}

const ymd = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Read the manifest fields shown in the preview (tolerates legacy archives without one). */
function manifestInfo(zip: ReturnType<typeof validateBackupZip>): Pick<BackupPreview, 'backupDate' | 'appVersion' | 'label'> {
  const entry = zip.getEntry(BACKUP_MANIFEST_ENTRY);
  if (entry) {
    try {
      const m = JSON.parse(zip.readAsText(entry)) as { createdAt?: unknown; appVersion?: unknown; companyName?: unknown };
      return {
        backupDate: typeof m.createdAt === 'string' ? m.createdAt : null,
        appVersion: typeof m.appVersion === 'string' ? m.appVersion : null,
        label: typeof m.companyName === 'string' ? m.companyName : null,
      };
    } catch {
      /* validateBackupZip already accepted it; fall through to entry times */
    }
  }
  let newest = 0;
  for (const e of zip.getEntries()) {
    const t = e.header?.time instanceof Date ? e.header.time.getTime() : 0;
    if (t > newest) newest = t;
  }
  return { backupDate: newest ? new Date(newest).toISOString() : null, appVersion: null, label: null };
}

/**
 * Open a backup read-only in a temporary data dir and summarise it. Throws VALIDATION for a file
 * that is not an Ironbooks full backup (same messages as the restore).
 */
export async function previewBackup(buffer: Buffer): Promise<BackupPreview> {
  const zip = validateBackupZip(buffer);
  const info = manifestInfo(zip);

  cleanupStalePreviewDirs();
  const tmpRoot = fs.mkdtempSync(path.join(previewTempRoot(), PREVIEW_DIR_PREFIX));
  const dataDir = path.join(tmpRoot, 'data');
  try {
    zip.extractAllTo(dataDir, /* overwrite */ true);
    if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
      throw new ServiceError('VALIDATION', 'Not an Ironbooks backup file (archive does not contain an Ironbooks company file).');
    }
    fs.rmSync(path.join(dataDir, BACKUP_MANIFEST_ENTRY), { force: true });
    for (const name of FILE_LOCAL_FILES) fs.rmSync(path.join(dataDir, name), { force: true });

    // The same acceptance check a restore runs (ledger guards + every company's books).
    let problems: string[];
    try {
      problems = await verifyRestoredBooks(dataDir);
    } catch (err) {
      console.warn('[backup] preview could not open the backup:', err);
      throw new ServiceError(
        'VALIDATION',
        'The company file inside this backup could not be opened, so it cannot be restored. Try an earlier backup.',
      );
    }

    const db = await withDamagedFileAccess(() => getDb(dataDir));
    const rows = await db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(companies.name);
    const out: PreviewCompany[] = [];
    for (const c of rows) {
      const postedLive = and(eq(journalEntries.companyId, c.id), eq(journalEntries.status, 'posted'), isNull(journalEntries.voidedAt));
      const [je] = await db.select({ n: count(), last: max(journalEntries.date) }).from(journalEntries).where(postedLive);
      const [inv] = await db.select({ n: count() }).from(invoices).where(eq(invoices.companyId, c.id));
      const [bill] = await db.select({ n: count() }).from(bills).where(eq(bills.companyId, c.id));
      let tb: PreviewCompany['trialBalance'] = null;
      try {
        const t = await trialBalance({ db, companyId: c.id, userId: null });
        tb = {
          totalDebit: t.totalDebit,
          totalCredit: t.totalCredit,
          balanced: t.balanced && Money.of(t.totalDebit).equals(Money.of(t.totalCredit)),
        };
      } catch (err) {
        console.warn('[backup] preview trial balance failed:', err);
      }
      out.push({
        name: c.name,
        transactions: Number(je?.n ?? 0),
        invoices: Number(inv?.n ?? 0),
        bills: Number(bill?.n ?? 0),
        lastTransactionDate: ymd(je?.last ?? null),
        trialBalance: tb,
      });
    }

    return {
      ...info,
      sizeBytes: buffer.byteLength,
      companies: out,
      balanced: out.length > 0 && out.every((c) => c.trialBalance?.balanced === true),
      problems,
    };
  } finally {
    await closeDb(dataDir).catch(() => undefined);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* removed by cleanupStalePreviewDirs next time */
    }
  }
}
