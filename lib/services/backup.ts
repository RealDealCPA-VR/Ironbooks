/**
 * Backup/restore service for a company data directory.
 *
 * A BookKeeper backup (.bka) is a zip archive of the PGlite data directory plus a
 * `bookkeeper-manifest.json` entry identifying the archive as a BookKeeper backup.
 *
 * adm-zip operates entirely in memory, keeping the backup path simple and
 * portable across Electron / Next dev / CI.
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import { resolveDataDir, closeDb, type DB } from '@/lib/db';
import {
  accounts, assemblyComponents, attachments, auditLogs, bankAccounts, bankTransactions,
  billLines, billPaymentApplications, billPayments, bills, budgetLines, budgets, classes,
  companies, companyRoles, creditMemoLines, creditMemos, currencies, customerPrices, customers,
  depositLines, deposits, depreciationEntries, employees, errorCorrections, errorDetections,
  estimateLines, estimates, expenseLines, expenseReportLines, expenseReports, expenses,
  fileImports, fiscalPeriods, fixedAssets, inventoryLayers, invoiceLines, invoices, items,
  jobs, journalEntries, journalEntryLines, locations, memorizedReports, mileageLogs,
  paycheckLines, paychecks, paymentApplications, paymentsReceived, purchaseOrderLines,
  purchaseOrders, reconciliationItems, reconciliations, recurringTemplates, salesOrderLines,
  salesOrders, salesReceiptLines, salesReceipts, salesReps, taxAgencies, taxRateComponents,
  taxRates, timeEntries, transactionRules, transfers, userCompanies, vendorCreditLines,
  vendorCredits, vendors,
  // team inventory (Advanced Inventory)
  inventoryBins, inventoryLineDetails, inventoryLots, inventoryMovements, inventorySites,
  inventoryTransferLines, inventoryTransfers, itemReceiptLines, itemReceipts, itemSiteSettings,
  landedCostAllocationLines, landedCostAllocations, pendingBuilds,
  // wave2 payroll
  payrollStateSettings, workersCompCodes,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { allowLedgerRewrite } from './posting';
import { logTransaction, resetTransactionLogCache } from './transactionLog';
import type { EffectiveAccess } from '@/lib/permissions/model';
import { isMaskedValue, isSensitiveKey, maskSensitive } from '@/lib/permissions/mask';

/** Name of the manifest entry embedded at the root of every .bka archive. */
export const BACKUP_MANIFEST_ENTRY = 'bookkeeper-manifest.json';
/** Name of the JSON data entry inside a per-company .bka archive. */
export const COMPANY_DATA_ENTRY = 'company-data.json';
/** Bump when the backup layout changes incompatibly. */
export const BACKUP_FORMAT_VERSION = 1;

/** 'full' = zip of the whole PGlite data dir (all companies); 'company' = one company's rows as JSON. */
export type BackupKind = 'full' | 'company';

interface BackupManifest {
  app: string;
  formatVersion: number;
  /** Absent on legacy archives — treated as 'full'. */
  kind?: BackupKind;
  companyName: string | null;
  createdAt: string;
  /**
   * Per-company archives only: true when SSNs / tax IDs or account numbers were masked because
   * the exporting user lacked the sensitive-data flags. Those fields restore as empty.
   */
  redacted?: boolean;
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

/**
 * Files at the root of a company data dir that identify/secure THIS file location and must
 * never travel inside a backup: `.auth-secret` (HMAC key that signs session + unlock cookies)
 * and `.file-id` (the company-file id session tokens are bound to; lib/auth.ts). A restore
 * keeps the target directory's own copies, so sessions stay bound to the file they were
 * issued for.
 */
export const FILE_LOCAL_SECRETS = ['.auth-secret', '.file-id'];

export interface BackupResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Zip the entire company data directory into an in-memory Buffer.
 *
 * @param companyName  Optional name embedded in the filename for clarity.
 * @param dataDir      Optional path override; defaults to the active company
 *                     data dir via resolveDataDir().
 * @returns { buffer, filename } — filename is 'bookkeeper-backup-<slug>.bka'.
 */
export function createBackup(companyName?: string, dataDir?: string): BackupResult {
  const dir = resolveDataDir(dataDir);

  if (!fs.existsSync(dir)) {
    throw new Error(`Data directory not found: ${dir}`);
  }

  const zip = new AdmZip();
  // addLocalFolder adds all files/dirs recursively under dir into the root of
  // the zip, preserving the internal directory tree — EXCEPT the per-file
  // secrets (FILE_LOCAL_SECRETS): a backup may be downloaded by any role with
  // File Utilities, and the session signing secret would let them forge an
  // Admin session.
  zip.addLocalFolder(dir, '', (p: string) => !FILE_LOCAL_SECRETS.includes(p.replace(/\\/g, '/')));

  // Embed a manifest so restoreBackup can verify the archive is really a
  // BookKeeper backup (and reject backups from a newer, incompatible format).
  const manifest: BackupManifest = {
    app: 'bookkeeper-ai',
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: 'full',
    companyName: companyName ?? null,
    createdAt: new Date().toISOString(),
  };
  zip.addFile(BACKUP_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  return { buffer: zip.toBuffer(), filename: buildBackupFilename('bookkeeper-backup', companyName) };
}

/** Build a timestamped, slugged .bka filename. */
function buildBackupFilename(prefix: string, companyName?: string | null): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // e.g. 2026-06-06T12-00-00
  const slug = companyName
    ? `-${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    : '';
  return `${prefix}${slug}-${ts}.bka`;
}

// ---------------------------------------------------------------------------
// Pre-operation safety backups (backup-before-destructive)
// ---------------------------------------------------------------------------

/** How many pre-op .bka files to keep (oldest beyond this are pruned). */
export const PRE_OP_BACKUP_KEEP = 5;

/**
 * Directory where pre-op backups are written: a sibling of the company data
 * dir (NOT inside it, so backups never recursively include older backups).
 * e.g. `.bookkeeper-data/default` -> `.bookkeeper-data/pre-op-backups`.
 */
export function preOpBackupDir(dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  return path.join(path.dirname(dir), 'pre-op-backups');
}

export interface PreOpBackupResult {
  path: string;
  filename: string;
}

/** Monotonic suffix so two pre-op backups in the same millisecond never collide. */
let preOpSeq = 0;

/** Parse the sortable numeric key out of a pre-op filename (Date.now() + sequence). */
function preOpSortKey(filename: string): number {
  const m = filename.match(/-(\d{13})-(\d{1,6})\.bka$/);
  return m ? Number(m[1]) * 1_000_000 + Number(m[2]) : 0;
}

/**
 * Backup-before-destructive: write a rotating pre-op .bka snapshot of the
 * company data directory, keeping only the newest PRE_OP_BACKUP_KEEP files.
 *
 * Called at the start of every destructive operation (full restore, company
 * restore, condense; year-end close belongs to another module). Always-on —
 * there is no settings toggle.
 *
 * @param _ctx     ServiceContext when available (API paths); null for raw
 *                 file-level operations like restoreBackup. Currently unused
 *                 beyond the signature contract — the snapshot is file-level.
 * @param label    Operation label embedded in the filename (e.g. 'restore', 'condense').
 * @param dataDir  Optional data-dir override; defaults to the active dir.
 * @returns the written file's path/filename, or null when the data dir does
 *          not exist yet (nothing to protect — e.g. first run).
 */
export function ensurePreOpBackup(
  _ctx: Pick<ServiceContext, 'companyId'> | null,
  label: string,
  dataDir?: string,
): PreOpBackupResult | null {
  const dir = resolveDataDir(dataDir);
  if (!fs.existsSync(dir)) return null;

  const { buffer } = createBackup(undefined, dir);

  const outDir = preOpBackupDir(dataDir);
  fs.mkdirSync(outDir, { recursive: true });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'op';
  preOpSeq = (preOpSeq + 1) % 1_000_000;
  const filename = `preop-${slug}-${Date.now()}-${preOpSeq}.bka`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, buffer);

  // Rotate: keep only the newest PRE_OP_BACKUP_KEEP pre-op backups overall.
  try {
    const files = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith('preop-') && f.endsWith('.bka'))
      .sort((a, b) => preOpSortKey(b) - preOpSortKey(a));
    for (const stale of files.slice(PRE_OP_BACKUP_KEEP)) {
      fs.rmSync(path.join(outDir, stale), { force: true });
    }
  } catch {
    /* pruning is best-effort — a leftover file is harmless */
  }

  return { path: outPath, filename };
}

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

export interface RestoreResult {
  restored: true;
}

const notABackup = (detail: string) =>
  new ServiceError('VALIDATION', `Not a BookKeeper backup file (${detail}).`);

/**
 * Parse + validate a candidate .bka buffer WITHOUT touching the data dir.
 * Accepts archives with a valid manifest, or (for pre-manifest .bka files)
 * archives whose entry list looks like a PGlite data directory.
 */
function validateBackupZip(buffer: Buffer): AdmZip {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw notABackup('could not read zip archive');
  }

  let entryNames: string[];
  try {
    entryNames = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
  } catch {
    throw notABackup('could not read zip archive');
  }
  if (!entryNames.length) throw notABackup('archive is empty');

  const manifestEntry = zip.getEntry(BACKUP_MANIFEST_ENTRY);
  if (manifestEntry) {
    let manifest: Partial<BackupManifest>;
    try {
      manifest = JSON.parse(zip.readAsText(manifestEntry));
    } catch {
      throw notABackup('manifest is unreadable');
    }
    if (manifest.app !== 'bookkeeper-ai') {
      throw notABackup('manifest does not identify a BookKeeper backup');
    }
    if (
      typeof manifest.formatVersion !== 'number' ||
      manifest.formatVersion > BACKUP_FORMAT_VERSION
    ) {
      throw new ServiceError(
        'VALIDATION',
        'This backup was created by a newer version of BookKeeper. Update the app, then restore.',
      );
    }
    if (manifest.kind === 'company') {
      throw new ServiceError(
        'VALIDATION',
        'This is a single-company backup. Use "Restore Company" instead of the full restore.',
      );
    }
    return zip;
  }

  // Backward compat: pre-manifest .bka files are a bare PGlite data dir zip.
  const looksLikePglite =
    entryNames.includes('PG_VERSION') &&
    entryNames.some((n) => n.startsWith('base/') || n === 'global/pg_control');
  if (!looksLikePglite) {
    throw notABackup('archive does not contain a BookKeeper company file');
  }
  return zip;
}

/**
 * Restore a .bka backup into the target data directory.
 *
 * Safety properties:
 *  1. The archive is validated (manifest / PGlite markers) BEFORE the data dir is touched —
 *     a junk or wrong file fails with VALIDATION and leaves the company file intact.
 *  2. The zip is extracted to a sibling temp directory first, never merged over live files.
 *  3. The live PGlite handle for the target dir is closed (flushed + released) before the
 *     swap, so the open WASM instance cannot write stale state over the restored files.
 *  4. The swap is atomic-ish: the current dir is renamed aside, the restored dir is renamed
 *     into place, and on failure the original dir is rolled back. No stale files (e.g. old
 *     pg_wal segments) survive into the restored dir.
 *
 * After this resolves, the next getDb()/openDb() call reopens the directory and sees the
 * restored data — no process restart is required.
 *
 * @param buffer     The raw bytes of a .bka backup file.
 * @param targetDir  Optional path override; defaults to resolveDataDir().
 */
export async function restoreBackup(buffer: Buffer, targetDir?: string): Promise<RestoreResult> {
  const dir = resolveDataDir(targetDir);

  // (1) Validate before touching anything on disk.
  const zip = validateBackupZip(buffer);

  // (1b) Backup-before-destructive: snapshot the CURRENT data dir as a rotating
  // pre-op .bka so a bad restore is recoverable after the fact. Best-effort —
  // an unreadable live dir must not block restoring a known-good backup (the
  // rename-aside in step 4 still provides in-flight rollback).
  try {
    ensurePreOpBackup(null, 'restore', dir);
  } catch (err) {
    console.warn('[backup] pre-op backup before restore failed (continuing):', err);
  }

  // (2) Extract to a sibling temp dir.
  const tmpDir = `${dir}.restore-tmp-${Date.now()}`;
  try {
    zip.extractAllTo(tmpDir, /* overwrite */ true);

    // Verify extraction actually produced a PGlite data dir.
    if (!fs.existsSync(path.join(tmpDir, 'PG_VERSION'))) {
      throw notABackup('archive does not contain a BookKeeper company file');
    }
    // The manifest is archive metadata, not a database file — keep it out of the data dir.
    fs.rmSync(path.join(tmpDir, BACKUP_MANIFEST_ENTRY), { force: true });
    // Keep THIS file's signing secret + file id (FILE_LOCAL_SECRETS); never adopt ones from the
    // archive (older backups included them).
    for (const name of FILE_LOCAL_SECRETS) {
      const restored = path.join(tmpDir, name);
      const live = path.join(dir, name);
      fs.rmSync(restored, { force: true });
      if (fs.existsSync(live)) fs.copyFileSync(live, restored);
    }

    // (3) Flush + release the live handle so it cannot checkpoint over the restored files.
    await closeDb(dir);

    // (4) Swap: move the current dir aside (rollback point), move the restored dir in.
    let preRestoreDir: string | null = null;
    if (fs.existsSync(dir)) {
      preRestoreDir = `${dir}.pre-restore-${Date.now()}`;
      fs.renameSync(dir, preRestoreDir);
    }
    try {
      fs.renameSync(tmpDir, dir);
    } catch (err) {
      // Roll the original directory back into place before surfacing the error.
      if (preRestoreDir) fs.renameSync(preRestoreDir, dir);
      throw err;
    }
    // The running transaction log came back with the restored files — drop cached chain state.
    resetTransactionLogCache(dir);
    if (preRestoreDir) {
      // Best-effort cleanup of the safety copy; a leftover dir is harmless.
      try {
        fs.rmSync(preRestoreDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    return { restored: true };
  } finally {
    // Clean up the temp dir if it is still around (validation/swap failure).
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ===========================================================================
// PER-COMPANY backup / restore
//
// A per-company .bka contains a manifest (kind: 'company') plus a single
// `company-data.json` entry: every row belonging to one company across all
// tables (companyId-scoped tables, plus child rows reached through their
// parent's companyId). Restore creates a brand-new company — other tenants
// in the shared data dir are never touched. All ids are remapped to fresh
// UUIDs so a backup can be restored repeatedly without collisions.
// ===========================================================================

/**
 * Declarative registry of every table that carries company data.
 *
 * Order matters: tables are exported/inserted in this order, so a table's FK
 * targets must appear before it. `companyCol` is the column compared against
 * the company id; `joins` walks child → parent so child tables (no companyId)
 * can be scoped through their parent. `selfParentKey` marks self-referencing
 * hierarchies that must be topologically sorted before insert.
 */
interface CompanyTableSpec {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  joins: Array<{ table: any; on: [any, any] }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  companyCol: any;
  selfParentKey?: string;
}

const COMPANY_TABLES: CompanyTableSpec[] = [
  { name: 'accounts', table: accounts, joins: [], companyCol: accounts.companyId, selfParentKey: 'parentId' },
  { name: 'classes', table: classes, joins: [], companyCol: classes.companyId, selfParentKey: 'parentId' },
  { name: 'locations', table: locations, joins: [], companyCol: locations.companyId },
  { name: 'customers', table: customers, joins: [], companyCol: customers.companyId, selfParentKey: 'parentId' },
  { name: 'vendors', table: vendors, joins: [], companyCol: vendors.companyId },
  { name: 'employees', table: employees, joins: [], companyCol: employees.companyId },
  { name: 'salesReps', table: salesReps, joins: [], companyCol: salesReps.companyId },
  { name: 'currencies', table: currencies, joins: [], companyCol: currencies.companyId },
  { name: 'jobs', table: jobs, joins: [], companyCol: jobs.companyId },
  { name: 'taxAgencies', table: taxAgencies, joins: [], companyCol: taxAgencies.companyId },
  { name: 'taxRates', table: taxRates, joins: [], companyCol: taxRates.companyId },
  { name: 'taxRateComponents', table: taxRateComponents, joins: [], companyCol: taxRateComponents.companyId },
  { name: 'items', table: items, joins: [], companyCol: items.companyId },
  { name: 'assemblyComponents', table: assemblyComponents, joins: [], companyCol: assemblyComponents.companyId },
  { name: 'customerPrices', table: customerPrices, joins: [], companyCol: customerPrices.companyId },
  { name: 'inventoryLayers', table: inventoryLayers, joins: [], companyCol: inventoryLayers.companyId },
  { name: 'journalEntries', table: journalEntries, joins: [], companyCol: journalEntries.companyId },
  {
    name: 'journalEntryLines', table: journalEntryLines, companyCol: journalEntries.companyId,
    joins: [{ table: journalEntries, on: [journalEntryLines.journalEntryId, journalEntries.id] }],
  },
  { name: 'bankAccounts', table: bankAccounts, joins: [], companyCol: bankAccounts.companyId },
  { name: 'fileImports', table: fileImports, joins: [], companyCol: fileImports.companyId },
  { name: 'bankTransactions', table: bankTransactions, joins: [], companyCol: bankTransactions.companyId },
  { name: 'transactionRules', table: transactionRules, joins: [], companyCol: transactionRules.companyId },
  {
    name: 'reconciliations', table: reconciliations, companyCol: bankAccounts.companyId,
    joins: [{ table: bankAccounts, on: [reconciliations.bankAccountId, bankAccounts.id] }],
  },
  {
    name: 'reconciliationItems', table: reconciliationItems, companyCol: bankAccounts.companyId,
    joins: [
      { table: reconciliations, on: [reconciliationItems.reconciliationId, reconciliations.id] },
      { table: bankAccounts, on: [reconciliations.bankAccountId, bankAccounts.id] },
    ],
  },
  { name: 'estimates', table: estimates, joins: [], companyCol: estimates.companyId },
  {
    name: 'estimateLines', table: estimateLines, companyCol: estimates.companyId,
    joins: [{ table: estimates, on: [estimateLines.estimateId, estimates.id] }],
  },
  { name: 'invoices', table: invoices, joins: [], companyCol: invoices.companyId },
  {
    name: 'invoiceLines', table: invoiceLines, companyCol: invoices.companyId,
    joins: [{ table: invoices, on: [invoiceLines.invoiceId, invoices.id] }],
  },
  { name: 'paymentsReceived', table: paymentsReceived, joins: [], companyCol: paymentsReceived.companyId },
  {
    name: 'paymentApplications', table: paymentApplications, companyCol: paymentsReceived.companyId,
    joins: [{ table: paymentsReceived, on: [paymentApplications.paymentId, paymentsReceived.id] }],
  },
  { name: 'salesReceipts', table: salesReceipts, joins: [], companyCol: salesReceipts.companyId },
  {
    name: 'salesReceiptLines', table: salesReceiptLines, companyCol: salesReceipts.companyId,
    joins: [{ table: salesReceipts, on: [salesReceiptLines.salesReceiptId, salesReceipts.id] }],
  },
  { name: 'creditMemos', table: creditMemos, joins: [], companyCol: creditMemos.companyId },
  {
    name: 'creditMemoLines', table: creditMemoLines, companyCol: creditMemos.companyId,
    joins: [{ table: creditMemos, on: [creditMemoLines.creditMemoId, creditMemos.id] }],
  },
  { name: 'bills', table: bills, joins: [], companyCol: bills.companyId },
  {
    name: 'billLines', table: billLines, companyCol: bills.companyId,
    joins: [{ table: bills, on: [billLines.billId, bills.id] }],
  },
  { name: 'billPayments', table: billPayments, joins: [], companyCol: billPayments.companyId },
  {
    name: 'billPaymentApplications', table: billPaymentApplications, companyCol: billPayments.companyId,
    joins: [{ table: billPayments, on: [billPaymentApplications.billPaymentId, billPayments.id] }],
  },
  { name: 'vendorCredits', table: vendorCredits, joins: [], companyCol: vendorCredits.companyId },
  {
    name: 'vendorCreditLines', table: vendorCreditLines, companyCol: vendorCredits.companyId,
    joins: [{ table: vendorCredits, on: [vendorCreditLines.vendorCreditId, vendorCredits.id] }],
  },
  { name: 'purchaseOrders', table: purchaseOrders, joins: [], companyCol: purchaseOrders.companyId },
  {
    name: 'purchaseOrderLines', table: purchaseOrderLines, companyCol: purchaseOrders.companyId,
    joins: [{ table: purchaseOrders, on: [purchaseOrderLines.purchaseOrderId, purchaseOrders.id] }],
  },
  { name: 'expenses', table: expenses, joins: [], companyCol: expenses.companyId },
  {
    name: 'expenseLines', table: expenseLines, companyCol: expenses.companyId,
    joins: [{ table: expenses, on: [expenseLines.expenseId, expenses.id] }],
  },
  { name: 'transfers', table: transfers, joins: [], companyCol: transfers.companyId },
  { name: 'deposits', table: deposits, joins: [], companyCol: deposits.companyId },
  {
    name: 'depositLines', table: depositLines, companyCol: deposits.companyId,
    joins: [{ table: deposits, on: [depositLines.depositId, deposits.id] }],
  },
  // wave2 payroll: SUI/SDI settings and workers' comp class codes (employees.workersCompCodeId
  // is a soft pointer remapped through the global id map).
  { name: 'payrollStateSettings', table: payrollStateSettings, joins: [], companyCol: payrollStateSettings.companyId },
  { name: 'workersCompCodes', table: workersCompCodes, joins: [], companyCol: workersCompCodes.companyId },
  { name: 'paychecks', table: paychecks, joins: [], companyCol: paychecks.companyId },
  {
    name: 'paycheckLines', table: paycheckLines, companyCol: paychecks.companyId,
    joins: [{ table: paychecks, on: [paycheckLines.paycheckId, paychecks.id] }],
  },
  { name: 'budgets', table: budgets, joins: [], companyCol: budgets.companyId },
  {
    name: 'budgetLines', table: budgetLines, companyCol: budgets.companyId,
    joins: [{ table: budgets, on: [budgetLines.budgetId, budgets.id] }],
  },
  { name: 'recurringTemplates', table: recurringTemplates, joins: [], companyCol: recurringTemplates.companyId },
  { name: 'attachments', table: attachments, joins: [], companyCol: attachments.companyId },
  { name: 'fiscalPeriods', table: fiscalPeriods, joins: [], companyCol: fiscalPeriods.companyId },
  { name: 'salesOrders', table: salesOrders, joins: [], companyCol: salesOrders.companyId },
  {
    name: 'salesOrderLines', table: salesOrderLines, companyCol: salesOrders.companyId,
    joins: [{ table: salesOrders, on: [salesOrderLines.salesOrderId, salesOrders.id] }],
  },
  { name: 'expenseReports', table: expenseReports, joins: [], companyCol: expenseReports.companyId },
  {
    name: 'expenseReportLines', table: expenseReportLines, companyCol: expenseReports.companyId,
    joins: [{ table: expenseReports, on: [expenseReportLines.expenseReportId, expenseReports.id] }],
  },
  { name: 'mileageLogs', table: mileageLogs, joins: [], companyCol: mileageLogs.companyId },
  { name: 'timeEntries', table: timeEntries, joins: [], companyCol: timeEntries.companyId },
  { name: 'fixedAssets', table: fixedAssets, joins: [], companyCol: fixedAssets.companyId },
  { name: 'depreciationEntries', table: depreciationEntries, joins: [], companyCol: depreciationEntries.companyId },
  { name: 'memorizedReports', table: memorizedReports, joins: [], companyCol: memorizedReports.companyId },
  { name: 'errorDetections', table: errorDetections, joins: [], companyCol: errorDetections.companyId },
  {
    name: 'errorCorrections', table: errorCorrections, companyCol: errorDetections.companyId,
    joins: [{ table: errorDetections, on: [errorCorrections.errorDetectionId, errorDetections.id] }],
  },
  // Custom roles (Users & Roles) travel with the company; assignments do not, because users are
  // machine-local and the restoring user becomes the sole (Admin) member.
  { name: 'companyRoles', table: companyRoles, joins: [], companyCol: companyRoles.companyId },
  { name: 'auditLogs', table: auditLogs, joins: [], companyCol: auditLogs.companyId },
  // ---- team inventory: item receipts / pending builds + Advanced Inventory ----
  { name: 'itemReceipts', table: itemReceipts, joins: [], companyCol: itemReceipts.companyId },
  {
    name: 'itemReceiptLines', table: itemReceiptLines, companyCol: itemReceipts.companyId,
    joins: [{ table: itemReceipts, on: [itemReceiptLines.itemReceiptId, itemReceipts.id] }],
  },
  { name: 'pendingBuilds', table: pendingBuilds, joins: [], companyCol: pendingBuilds.companyId },
  { name: 'inventorySites', table: inventorySites, joins: [], companyCol: inventorySites.companyId },
  { name: 'inventoryBins', table: inventoryBins, joins: [], companyCol: inventoryBins.companyId },
  { name: 'inventoryLots', table: inventoryLots, joins: [], companyCol: inventoryLots.companyId },
  { name: 'itemSiteSettings', table: itemSiteSettings, joins: [], companyCol: itemSiteSettings.companyId },
  { name: 'inventoryTransfers', table: inventoryTransfers, joins: [], companyCol: inventoryTransfers.companyId },
  {
    name: 'inventoryTransferLines', table: inventoryTransferLines, companyCol: inventoryTransfers.companyId,
    joins: [{ table: inventoryTransfers, on: [inventoryTransferLines.transferId, inventoryTransfers.id] }],
  },
  { name: 'inventoryMovements', table: inventoryMovements, joins: [], companyCol: inventoryMovements.companyId },
  { name: 'inventoryLineDetails', table: inventoryLineDetails, joins: [], companyCol: inventoryLineDetails.companyId },
  { name: 'landedCostAllocations', table: landedCostAllocations, joins: [], companyCol: landedCostAllocations.companyId },
  {
    name: 'landedCostAllocationLines', table: landedCostAllocationLines, companyCol: landedCostAllocations.companyId,
    joins: [{ table: landedCostAllocations, on: [landedCostAllocationLines.allocationId, landedCostAllocations.id] }],
  },
];

/**
 * Opaque "soft pointer" columns: they may name rows that are not exported (users, the company
 * itself, deleted records), so they are remapped when possible and otherwise kept verbatim —
 * never treated as a hard foreign key.
 */
const SOFT_REF_KEYS: Record<string, Set<string>> = { auditLogs: new Set(['entityId']) };

/** Columns that reference users.id — users are NOT exported, so on restore these map to the restoring user. */
const USER_REF_KEYS = new Set([
  'createdBy', 'userId', 'uploadedBy', 'closedBy', 'approvedBy', 'reviewedBy', 'ownerId',
]);

export interface CompanyExportData {
  company: { id: string; name: string; settings: unknown };
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** Pull every row belonging to one company across all registered tables. */
export async function exportCompanyData(db: DB, companyId: string): Promise<CompanyExportData> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw new ServiceError('NOT_FOUND', 'Company not found');

  const tables: CompanyExportData['tables'] = {};
  for (const spec of COMPANY_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.select({ row: spec.table }).from(spec.table);
    for (const j of spec.joins) q = q.innerJoin(j.table, eq(j.on[0], j.on[1]));
    const rows: Array<{ row: Record<string, unknown> }> = await q.where(eq(spec.companyCol, companyId));
    tables[spec.name] = rows.map((r) => r.row);
  }
  return {
    company: { id: company.id, name: company.name, settings: company.settings ?? null },
    tables,
  };
}

/**
 * Zip a single company's rows into an in-memory per-company .bka buffer.
 *
 * `opts.access` is the exporting user's effective access in that company: sensitive fields are
 * masked for roles without "view sensitive payroll data" / "view full account numbers" (the
 * same rule as every API response). Omit it only for trusted/system callers.
 */
export async function createCompanyBackup(
  db: DB,
  companyId: string,
  opts: { access?: Pick<EffectiveAccess, 'flags'> | null } = {},
): Promise<BackupResult> {
  const raw = await exportCompanyData(db, companyId);
  const data = maskSensitive(raw, opts.access);
  const redacted = Boolean(
    opts.access && !(opts.access.flags.sensitivePayroll && opts.access.flags.fullAccountNumbers),
  );

  const zip = new AdmZip();
  const manifest: BackupManifest = {
    app: 'bookkeeper-ai',
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: 'company',
    companyName: data.company.name,
    createdAt: new Date().toISOString(),
    ...(redacted ? { redacted: true } : {}),
  };
  zip.addFile(BACKUP_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addFile(COMPANY_DATA_ENTRY, Buffer.from(JSON.stringify(data), 'utf8'));

  return {
    buffer: zip.toBuffer(),
    filename: buildBackupFilename('bookkeeper-company', data.company.name),
  };
}

/** Validate + parse a per-company .bka buffer. Throws VALIDATION for anything else. */
export function readCompanyBackup(buffer: Buffer): CompanyExportData {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw notABackup('could not read zip archive');
  }
  const manifestEntry = zip.getEntry(BACKUP_MANIFEST_ENTRY);
  if (!manifestEntry) throw notABackup('missing manifest — is this a full backup?');
  let manifest: Partial<BackupManifest>;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch {
    throw notABackup('manifest is unreadable');
  }
  if (manifest.app !== 'bookkeeper-ai') throw notABackup('manifest does not identify a BookKeeper backup');
  if (manifest.kind !== 'company') {
    throw new ServiceError(
      'VALIDATION',
      'This is a full data-directory backup. Use the full Restore instead of Restore Company.',
    );
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new ServiceError(
      'VALIDATION',
      'This backup was created by a newer version of BookKeeper. Update the app, then restore.',
    );
  }
  const dataEntry = zip.getEntry(COMPANY_DATA_ENTRY);
  if (!dataEntry) throw notABackup('archive does not contain company data');
  let data: CompanyExportData;
  try {
    data = JSON.parse(zip.readAsText(dataEntry));
  } catch {
    throw notABackup('company data is unreadable');
  }
  if (!data?.company?.name || typeof data.tables !== 'object') {
    throw notABackup('company data is incomplete');
  }
  return data;
}

/** Order rows so self-referencing parents come before their children. */
function topoSortByParent(
  rows: Array<Record<string, unknown>>,
  parentKey: string,
): Array<Record<string, unknown>> {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const sorted: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  const visit = (r: Record<string, unknown>) => {
    const id = r.id as string;
    if (visited.has(id)) return;
    visited.add(id);
    const p = r[parentKey] as string | null | undefined;
    if (p && byId.has(p)) visit(byId.get(p)!);
    sorted.push(r);
  };
  for (const r of rows) visit(r);
  return sorted;
}

/**
 * Convert one exported JSON row back into an insertable record:
 *  - timestamps: ISO strings → Date
 *  - companyId → the new company
 *  - user references → the restoring user (users are machine-local, not in the backup)
 *  - every other UUID → its remapped fresh id
 *  - masked sensitive values from a redacted export ("***-**-6789") → null (optional columns),
 *    never stored as if they were the real SSN / tax ID
 */
function reviveRow(
  spec: CompanyTableSpec,
  row: Record<string, unknown>,
  idMap: Map<string, string>,
  newCompanyId: string,
  ownerId: string,
  oldCompanyId?: string,
): Record<string, unknown> {
  const cols = getTableColumns(spec.table) as Record<
    string,
    { dataType: string; columnType: string; notNull: boolean }
  >;
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(cols)) {
    let v = row[key];
    if (v === undefined) continue;
    // A required column (bank account number) keeps the visible "••••6789" placeholder so the
    // restored record is obviously incomplete rather than failing the whole restore.
    if (isSensitiveKey(key) && isMaskedValue(v) && !col.notNull) v = null;
    if (v !== null) {
      if (col.dataType === 'date' && typeof v === 'string') {
        v = new Date(v);
      } else if (col.columnType === 'PgUUID' && typeof v === 'string') {
        if (key === 'companyId') v = newCompanyId;
        else if (USER_REF_KEYS.has(key)) v = ownerId;
        else if (idMap.has(v)) v = idMap.get(v)!;
        else if (SOFT_REF_KEYS[spec.name]?.has(key)) {
          // Audit trail entity pointer: the company itself → the new company; anything else
          // (a user, a deleted record) keeps its original id as historical information.
          if (oldCompanyId && v === oldCompanyId) v = newCompanyId;
        }
        else if (col.notNull) {
          // A required reference points outside this company's data — the backup
          // is corrupt (cross-company leak). Refuse rather than guess.
          throw new ServiceError(
            'VALIDATION',
            `Backup contains a dangling reference (${spec.name}.${key}) and cannot be restored.`,
          );
        } else {
          v = null; // optional dangling link (e.g. soft pointer) — drop it
        }
      }
    }
    out[key] = v;
  }
  return out;
}

export interface RestoreCompanyResult {
  companyId: string;
  name: string;
  tableCounts: Record<string, number>;
}

/**
 * Restore a per-company .bka into THIS data directory as a brand-new company.
 *
 * Safety properties:
 *  - Other companies' rows are never read or written — only inserts into a fresh company.
 *  - Every id is remapped to a fresh UUID, so restoring the same file twice (or restoring
 *    into the original source database) can never collide with existing rows.
 *  - The whole restore runs in one transaction: a bad archive leaves nothing behind.
 *
 * @param db       Database handle.
 * @param buffer   Raw bytes of a per-company .bka file.
 * @param opts     ownerId: the user who will own (and be the sole member of) the new
 *                 company; name: optional override for the new company's name.
 */
export async function restoreCompanyBackup(
  db: DB,
  buffer: Buffer,
  opts: { ownerId: string; name?: string },
): Promise<RestoreCompanyResult> {
  const data = readCompanyBackup(buffer);

  // Backup-before-destructive: company restore only inserts a brand-new company,
  // but it still mutates the shared data dir — snapshot it first (best-effort).
  try {
    ensurePreOpBackup(null, 'restore-company');
  } catch (err) {
    console.warn('[backup] pre-op backup before company restore failed (continuing):', err);
  }

  // Build the global id remap: one fresh UUID for every exported row id.
  const idMap = new Map<string, string>();
  for (const spec of COMPANY_TABLES) {
    for (const row of data.tables[spec.name] ?? []) {
      if (typeof row.id === 'string') idMap.set(row.id, randomUUID());
    }
  }

  // Pick the new company name: explicit override, else original (suffixed if taken).
  let name = opts.name?.trim() || data.company.name;
  const clash = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, name));
  if (clash.length) name = `${name} (Restored ${new Date().toISOString().slice(0, 10)})`;

  return db.transaction(async (tx) => {
    // Re-inserting a backup's posted ledger is a sanctioned rewrite (lines are added to
    // entries that were not created "now"). Every restored posted entry is still verified
    // balanced at COMMIT, so a corrupt archive cannot restore unbalanced books.
    await allowLedgerRewrite({ db: tx as unknown as DB }, 'restore');

    const [company] = await tx
      .insert(companies)
      .values({
        name,
        ownerId: opts.ownerId,
        settings: (data.company.settings ?? null) as never,
      })
      .returning();
    await tx
      .insert(userCompanies)
      .values({ userId: opts.ownerId, companyId: company.id, role: 'owner' });

    const tableCounts: Record<string, number> = {};
    for (const spec of COMPANY_TABLES) {
      let rows = data.tables[spec.name] ?? [];
      if (spec.selfParentKey) rows = topoSortByParent(rows, spec.selfParentKey);
      const revived = rows.map((r) => reviveRow(spec, r, idMap, company.id, opts.ownerId, data.company.id));
      // Cached balances are never restored verbatim: accounts start at zero and the DB
      // balance triggers rebuild them from the restored posted journal lines.
      if (spec.name === 'accounts') for (const r of revived) r.balance = '0.00';
      // Chunked inserts keep parameter counts well under PG limits.
      for (let i = 0; i < revived.length; i += 200) {
        await tx.insert(spec.table).values(revived.slice(i, i + 200) as never);
      }
      tableCounts[spec.name] = rows.length;
    }

    // Record the restore in the NEW company's audit trail.
    await tx.insert(auditLogs).values({
      companyId: company.id,
      userId: opts.ownerId,
      action: 'create',
      entityType: 'company_restore',
      entityId: company.id,
      newValues: { restoredFrom: data.company.name, tableCounts },
    });
    // Running transaction log: one bulk record covering every restored posted entry, so
    // verifyTransactionLog can account for them.
    const journalEntryIds = (data.tables.journalEntries ?? [])
      .filter((r) => r.status === 'posted' && typeof r.id === 'string')
      .map((r) => idMap.get(r.id as string)!)
      .filter(Boolean);
    await logTransaction(tx as unknown as DB, {
      companyId: company.id,
      userId: opts.ownerId,
      action: 'create',
      entityType: 'company_restore',
      entityId: company.id,
      summary: `Restored company "${name}" from a company backup of "${data.company.name}" (${journalEntryIds.length} posted journal entries)`,
      data: { new: { restoredFrom: data.company.name, tableCounts }, journalEntryIds },
    });

    return { companyId: company.id, name, tableCounts };
  });
}
