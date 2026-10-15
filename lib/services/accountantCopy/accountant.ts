/**
 * Accountant's Copy — the ACCOUNTANT's side (PARITY I1).
 *
 *  - openAccountantCopyFile: restore a .ibac transfer file into a NEW company file (the Portable
 *    Company File restore, which verifies every table, the trial balance and the transaction
 *    log), then turn it into the accountant's working copy: the copy's row flips to side
 *    'accountant' and the version of every journal entry, check / expense, account and class is
 *    recorded as the baseline the changes are measured against.
 *  - accountantChanges: the delta made in the copy so far — derived from the audit trail /
 *    running transaction log (which entries were voided, replaced or added, and what replaced
 *    what) checked against the baseline versions. General Journal edits are void + re-post, so a
 *    chain "entry → its replacement → …" collapses into one change of the client's entry.
 *  - exportChangesFile: the .ibcx the client imports.
 */
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db';
import {
  accountantCopies,
  accountantCopyBaseline,
  accounts,
  auditLogs,
  classes,
  companies,
  expenses,
  journalEntries,
  journalEntryLines,
  users,
} from '@/lib/db/schema';
import { dataDirOf } from '@/lib/db/txHooks';
import { qbAccountTypeOf } from '@/lib/accountTypes';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, validation, writeAudit } from '../_base';
import { getExpense } from '../expenses';
import { defaultPortableRestoreDir, readPortableManifest, restorePortableCompanyFile } from '../portableFile';
import { readAllTransactionLog, entityLabel } from '../transactionLog';
import {
  CHANGES_EXTENSION,
  CHANGES_FORMAT_VERSION,
  TRANSFER_ENTRY,
  type AccountChange,
  type AccountPayload,
  type ChangesFileBody,
  type ClassChange,
  type ExpensePayload,
  type JournalPayload,
  type TransferManifest,
  type TxnChange,
  safeCompanyName,
  serializeChangesFile,
} from './format';

// ---------------------------------------------------------------------------
// Open the transfer file (.ibac)
// ---------------------------------------------------------------------------

/** Read + check the Accountant's Copy flag of a transfer file (no restore). */
export function readTransferManifest(buffer: Buffer): TransferManifest {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ServiceError('VALIDATION', "This is not an Accountant's Copy transfer file (.ibac): it could not be read.");
  }
  const entry = zip.getEntry(TRANSFER_ENTRY);
  if (!entry) {
    throw new ServiceError(
      'VALIDATION',
      "This is not an Accountant's Copy transfer file (.ibac). To open an ordinary portable company file (.bkp), use Company File > Open Portable File.",
    );
  }
  let m: TransferManifest;
  try {
    m = JSON.parse(zip.readAsText(entry)) as TransferManifest;
  } catch {
    throw new ServiceError('VALIDATION', "The Accountant's Copy transfer file is damaged (its manifest can't be read).");
  }
  if (m?.app !== 'ironbooks' || m.kind !== 'accountant-copy' || !m.copyId || !/^\d{4}-\d{2}-\d{2}$/.test(m.dividingDate ?? '')) {
    throw new ServiceError('VALIDATION', "The Accountant's Copy transfer file is damaged (its manifest is incomplete).");
  }
  // Also runs the portable integrity check (every checksummed entry).
  readPortableManifest(buffer);
  return m;
}

/** Summary for the "open this Accountant's Copy?" confirmation. */
export function inspectTransferFile(buffer: Buffer) {
  const m = readTransferManifest(buffer);
  const p = readPortableManifest(buffer);
  return {
    companyName: m.companyName,
    dividingDate: m.dividingDate,
    createdAt: m.createdAt,
    createdBy: m.createdBy,
    appVersion: p.appVersion,
    journalEntries: p.rowCounts.journal_entries ?? 0,
    users: p.rowCounts.users ?? 0,
  };
}

/** Default folder for the accountant's working copy: a new sibling of the active company file. */
export function defaultAccountantCopyDir(companyName: string, activeDataDir?: string): string {
  return defaultPortableRestoreDir(`${safeCompanyName(companyName)} - Accountant's Copy`, activeDataDir);
}

export interface OpenAccountantCopyResult {
  dataDir: string;
  companyName: string;
  dividingDate: string;
  copyId: string;
  verified: { tables: number; rows: number; files: number; transactionLogRecords: number };
}

/**
 * Restore a .ibac into `targetDir` (must be new/empty) and make it the accountant's working copy.
 * Any failure removes the new folder.
 */
export async function openAccountantCopyFile(buffer: Buffer, targetDir: string): Promise<OpenAccountantCopyResult> {
  const m = readTransferManifest(buffer);
  const restored = await restorePortableCompanyFile(buffer, targetDir);
  const dir = restored.dataDir;
  try {
    const db = await getDb(dir);
    const [row] = await db
      .select()
      .from(accountantCopies)
      .where(eq(accountantCopies.id, m.copyId));
    if (!row || row.side !== 'client' || row.status !== 'outstanding' || row.dividingDate !== m.dividingDate || row.companyId !== m.companyId) {
      throw new ServiceError('VALIDATION', "The Accountant's Copy transfer file is damaged (its copy record does not match).");
    }
    await db.transaction(async (tx) => {
      await tx
        .update(accountantCopies)
        .set({ side: 'accountant', status: 'open', openedAt: new Date(), updatedAt: new Date() })
        .where(eq(accountantCopies.id, m.copyId));
      // Baseline versions of everything the changes file can carry back.
      await tx.execute(sql`
        INSERT INTO accountant_copy_baseline (copy_id, entity_type, entity_id, version)
        SELECT ${m.copyId}::uuid, 'journal_entry', id, updated_at FROM journal_entries WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'expense', id, updated_at FROM expenses WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'account', id, edited_at FROM accounts WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'class', id, created_at FROM classes WHERE company_id = ${m.companyId}::uuid`);
      await writeAudit(
        { db: tx as never, companyId: m.companyId, userId: null },
        {
          action: 'update',
          entityType: 'accountant_copy',
          entityId: m.copyId,
          oldValues: { side: 'client', status: 'outstanding' },
          newValues: { side: 'accountant', status: 'open', dividingDate: m.dividingDate },
        },
      );
    });
    // Everything logged after this point is the accountant's work.
    const records = readAllTransactionLog(dir).records;
    const seq = records.length ? records[records.length - 1].seq : 0;
    await db.update(accountantCopies).set({ baselineLogSeq: seq }).where(eq(accountantCopies.id, m.copyId));
    await closeDb(dir);
  } catch (err) {
    await closeDb(dir).catch(() => undefined);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
  return {
    dataDir: dir,
    companyName: restored.companyName,
    dividingDate: m.dividingDate,
    copyId: m.copyId,
    verified: {
      tables: restored.verified.tables,
      rows: restored.verified.rows,
      files: restored.verified.files,
      transactionLogRecords: restored.verified.transactionLogRecords,
    },
  };
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

/** The accountant-side copy row of this company file, or VALIDATION. */
export async function accountantSideCopy(ctx: ServiceContext) {
  const [row] = await ctx.db
    .select()
    .from(accountantCopies)
    .where(and(eq(accountantCopies.companyId, ctx.companyId), eq(accountantCopies.side, 'accountant')))
    .orderBy(asc(accountantCopies.createdAt))
    .limit(1);
  if (!row) throw validation("This company file is not an Accountant's Copy.");
  return row;
}

const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);
const sameVersion = (a: Date | null, b: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function isGeneralJournal(sourceRef: string | null): boolean {
  return sourceRef === null || sourceRef === 'manual' || sourceRef.startsWith('reversal:');
}

/** Entity types that are business data but that the changes file can't carry (warned about). */
const NOT_CARRIED = new Set([
  'invoice', 'bill', 'payment_received', 'bill_payment', 'sales_receipt', 'credit_memo', 'vendor_credit',
  'deposit', 'transfer', 'paycheck', 'pay_run', 'item_receipt', 'purchase_order', 'sales_order', 'estimate',
  'inventory_transfer', 'inventory_layer', 'reconciliation', 'bank_transaction', 'time_entry', 'expense_report',
  'loan_payment', 'landed_cost_allocation', 'home_currency_adjustment', 'sales_tax_adjustment',
  'invoice_write_off', 'customer', 'vendor', 'item', 'employee', 'other_name', 'job', 'location', 'sales_rep',
  'payroll_item', 'tax_rate', 'tax_agency', 'price_level', 'fixed_asset', 'company', 'company_settings', 'fiscal_period',
]);

export interface AccountantChanges {
  copy: { id: string; dividingDate: string; openedAt: string | null; exportedAt: string | null; exportCount: number; note: string | null };
  accounts: AccountChange[];
  classes: ClassChange[];
  transactions: TxnChange[];
  warnings: string[];
}

async function journalPayload(ctx: ServiceContext, entry: typeof journalEntries.$inferSelect): Promise<JournalPayload> {
  const lines = await ctx.db
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entry.id))
    .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
  return {
    date: new Date(entry.date).toISOString(),
    description: entry.description,
    reference: entry.reference,
    isAdjusting: entry.isAdjusting,
    entryNumber: entry.entryNumber,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit != null && Number(l.debit) !== 0 ? toAmountString(l.debit) : null,
      credit: l.credit != null && Number(l.credit) !== 0 ? toAmountString(l.credit) : null,
      memo: l.memo,
      classId: l.classId,
      entityType: (l.entityType as JournalPayload['lines'][number]['entityType']) ?? null,
      entityId: l.entityId,
    })),
  };
}

async function expensePayload(ctx: ServiceContext, id: string): Promise<ExpensePayload> {
  const e = await getExpense(ctx, id);
  const total = String(e.total);
  return {
    vendorId: e.vendorId,
    payeeName: e.vendorId ? null : e.payeeName,
    date: new Date(e.date).toISOString(),
    method: e.method,
    reference: e.reference,
    paymentAccountId: e.paymentAccountId,
    memo: e.memo,
    toPrint: e.toPrint,
    isRefund: total.startsWith('-'),
    currency: e.currency,
    exchangeRate: e.exchangeRate,
    total,
    lines: e.lines.map((l) => {
      const d = l as typeof l & {
        siteId?: string | null;
        binId?: string | null;
        serialNumbers?: string[] | null;
        lotNumber?: string | null;
        lotExpiration?: Date | null;
      };
      return {
        accountId: l.itemId ? null : l.accountId,
        itemId: l.itemId,
        quantity: l.quantity,
        unitCost: l.unitCost,
        description: l.description,
        amount: toAmountString(l.amount),
        classId: l.classId,
        customerId: l.customerId,
        jobId: l.jobId,
        ...(d.siteId !== undefined ? { siteId: d.siteId } : {}),
        ...(d.binId !== undefined ? { binId: d.binId } : {}),
        ...(d.serialNumbers !== undefined ? { serialNumbers: d.serialNumbers } : {}),
        ...(d.lotNumber !== undefined ? { lotNumber: d.lotNumber } : {}),
        ...(d.lotExpiration !== undefined ? { lotExpiration: d.lotExpiration ? ymd(d.lotExpiration) : null } : {}),
      };
    }),
  };
}

function accountPayload(a: typeof accounts.$inferSelect): AccountPayload {
  return {
    code: a.code,
    name: a.name,
    qbType: qbAccountTypeOf(a),
    subtype: a.subtype,
    parentId: a.parentId,
    description: a.description,
    taxLine: a.taxLine,
    isActive: a.isActive,
  };
}

/** Everything the accountant changed in this copy so far (what the changes file will carry). */
export async function accountantChanges(ctx: ServiceContext): Promise<AccountantChanges> {
  const copy = await accountantSideCopy(ctx);
  const baseRows = await ctx.db
    .select()
    .from(accountantCopyBaseline)
    .where(eq(accountantCopyBaseline.copyId, copy.id));
  const base = new Map<string, Map<string, Date | null>>();
  for (const r of baseRows) {
    if (!base.has(r.entityType)) base.set(r.entityType, new Map());
    base.get(r.entityType)!.set(r.entityId, r.version);
  }
  const baseOf = (t: string) => base.get(t) ?? new Map<string, Date | null>();

  // ---- Accounts (parents first) ----
  const accountChanges: AccountChange[] = [];
  const acctRows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId)).orderBy(asc(accounts.code));
  const baseAccts = baseOf('account');
  const added = acctRows.filter((a) => !baseAccts.has(a.id));
  const placed = new Set<string>();
  while (placed.size < added.length) {
    const before = placed.size;
    for (const a of added) {
      if (placed.has(a.id)) continue;
      if (a.parentId && added.some((p) => p.id === a.parentId) && !placed.has(a.parentId)) continue;
      accountChanges.push({ op: 'add', id: a.id, after: accountPayload(a) });
      placed.add(a.id);
    }
    if (placed.size === before) break; // cycle guard (parents can't form cycles)
  }
  for (const a of acctRows) {
    if (!baseAccts.has(a.id)) continue;
    const v = baseAccts.get(a.id) ?? null;
    if (sameVersion(a.editedAt, v)) continue;
    accountChanges.push({ op: 'edit', id: a.id, baseVersion: iso(v), after: accountPayload(a) });
  }

  // ---- Classes ----
  const classChanges: ClassChange[] = [];
  const baseClasses = baseOf('class');
  const clsRows = await ctx.db.select().from(classes).where(eq(classes.companyId, ctx.companyId)).orderBy(asc(classes.createdAt));
  const newCls = clsRows.filter((c) => !baseClasses.has(c.id));
  const placedCls = new Set<string>();
  while (placedCls.size < newCls.length) {
    const before = placedCls.size;
    for (const c of newCls) {
      if (placedCls.has(c.id)) continue;
      if (c.parentId && newCls.some((p) => p.id === c.parentId) && !placedCls.has(c.parentId)) continue;
      classChanges.push({ op: 'add', id: c.id, name: c.name, parentId: c.parentId });
      placedCls.add(c.id);
    }
    if (placedCls.size === before) break;
  }

  // ---- General Journal entries ----
  const txns: TxnChange[] = [];
  const jeRows = (
    await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))
  ).filter((e) => isGeneralJournal(e.sourceRef));
  const jeById = new Map(jeRows.map((e) => [e.id, e]));
  // Edits are void + re-post; the audit trail links each voided entry to its replacement.
  const repl = await ctx.db
    .select({ id: auditLogs.entityId, replacedBy: sql<string>`${auditLogs.newValues}->>'replacedBy'` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'journal_entry'),
        eq(auditLogs.action, 'update'),
        isNotNull(sql`${auditLogs.newValues}->>'replacedBy'`),
      ),
    );
  const replacedBy = new Map<string, string>();
  for (const r of repl) if (r.replacedBy) replacedBy.set(r.id, r.replacedBy);
  const replacementTargets = new Set(replacedBy.values());
  const finalOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 10_000 && replacedBy.has(cur); i++) cur = replacedBy.get(cur)!;
    return cur;
  };
  const baseJe = baseOf('journal_entry');
  for (const e of [...jeRows].sort((a, b) => a.date.getTime() - b.date.getTime() || a.entryNumber - b.entryNumber)) {
    if (baseJe.has(e.id)) {
      const v = baseJe.get(e.id) ?? null;
      if (sameVersion(e.updatedAt, v)) continue;
      const fin = jeById.get(finalOf(e.id));
      if (fin && fin.id !== e.id && fin.status === 'posted') {
        txns.push({ op: 'edit', type: 'journal_entry', id: e.id, baseVersion: iso(v), after: await journalPayload(ctx, fin) });
      } else if (e.status === 'void' || (fin && fin.status === 'void')) {
        txns.push({ op: 'void', type: 'journal_entry', id: e.id, baseVersion: iso(v) });
      }
      continue;
    }
    if (replacementTargets.has(e.id)) continue; // part of an edit chain, carried by its root
    const fin = jeById.get(finalOf(e.id));
    if (fin && fin.status === 'posted') {
      txns.push({ op: 'add', type: 'journal_entry', id: e.id, after: await journalPayload(ctx, fin) });
    }
  }

  // ---- Checks / expenses ----
  const baseExp = baseOf('expense');
  const expRows = await ctx.db
    .select({ id: expenses.id, updatedAt: expenses.updatedAt, voidedAt: expenses.voidedAt, date: expenses.date })
    .from(expenses)
    .where(eq(expenses.companyId, ctx.companyId))
    .orderBy(asc(expenses.date), asc(expenses.createdAt));
  for (const x of expRows) {
    if (baseExp.has(x.id)) {
      const v = baseExp.get(x.id) ?? null;
      if (sameVersion(x.updatedAt, v)) continue;
      if (x.voidedAt) txns.push({ op: 'void', type: 'expense', id: x.id, baseVersion: iso(v) });
      else txns.push({ op: 'edit', type: 'expense', id: x.id, baseVersion: iso(v), after: await expensePayload(ctx, x.id) });
      continue;
    }
    if (!x.voidedAt) txns.push({ op: 'add', type: 'expense', id: x.id, after: await expensePayload(ctx, x.id) });
  }

  // ---- Anything in the transaction log the file can't carry ----
  const warnings: string[] = [];
  const dir = dataDirOf(ctx.db);
  if (dir && copy.baselineLogSeq != null) {
    const seen = new Map<string, number>();
    for (const r of readAllTransactionLog(dir).records) {
      if (r.seq <= copy.baselineLogSeq || r.companyId !== ctx.companyId) continue;
      if (!NOT_CARRIED.has(r.entityType)) continue;
      seen.set(r.entityType, (seen.get(r.entityType) ?? 0) + 1);
    }
    for (const [t, n] of seen) {
      warnings.push(`${n} change(s) to ${entityLabel(t)} records were made in this copy and can't be sent back. Tell your client what to change.`);
    }
  }

  return {
    copy: {
      id: copy.id,
      dividingDate: copy.dividingDate,
      openedAt: iso(copy.openedAt),
      exportedAt: iso(copy.exportedAt),
      exportCount: copy.exportCount,
      note: copy.accountantNote,
    },
    accounts: accountChanges,
    classes: classChanges,
    transactions: txns,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Export the changes file (.ibcx)
// ---------------------------------------------------------------------------

export interface ChangesFileResult {
  buffer: Buffer;
  filename: string;
  counts: { accounts: number; classes: number; transactions: number };
}

export async function exportChangesFile(ctx: ServiceContext, input: { note?: string | null } = {}): Promise<ChangesFileResult> {
  const copy = await accountantSideCopy(ctx);
  const changes = await accountantChanges(ctx);
  const note = input.note?.trim() ? input.note.trim().slice(0, 20_000) : null;
  if (!changes.accounts.length && !changes.classes.length && !changes.transactions.length && !note) {
    throw validation('There are no changes to send yet. Make your journal entries or other changes first, or add a note for your client.');
  }
  const [co] = await ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  const [me] = ctx.userId
    ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId))
    : [];
  const body: ChangesFileBody = {
    app: 'ironbooks',
    kind: 'accountant-changes',
    formatVersion: CHANGES_FORMAT_VERSION,
    copyId: copy.id,
    companyId: ctx.companyId,
    companyName: co?.name ?? 'Company',
    fileToken: copy.fileToken,
    dividingDate: copy.dividingDate,
    createdAt: new Date().toISOString(),
    preparedBy: me?.name ?? null,
    note,
    accounts: changes.accounts,
    classes: changes.classes,
    transactions: changes.transactions,
    warnings: changes.warnings,
  };
  const buffer = serializeChangesFile(body);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(accountantCopies)
      .set({
        exportedAt: new Date(),
        exportCount: sql`${accountantCopies.exportCount} + 1`,
        accountantNote: note,
        updatedAt: new Date(),
      })
      .where(eq(accountantCopies.id, copy.id));
    await writeAudit(
      { ...ctx, db: tx as never },
      {
        action: 'update',
        entityType: 'accountant_copy',
        entityId: copy.id,
        newValues: {
          exported: true,
          accounts: changes.accounts.length,
          classes: changes.classes.length,
          transactions: changes.transactions.length,
        },
      },
    );
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    filename: `${safeCompanyName(body.companyName)} (Accountant Changes ${stamp}).${CHANGES_EXTENSION}`,
    counts: { accounts: changes.accounts.length, classes: changes.classes.length, transactions: changes.transactions.length },
  };
}
