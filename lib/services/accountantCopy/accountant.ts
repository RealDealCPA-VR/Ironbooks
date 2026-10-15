/**
 * Accountant's Copy — the ACCOUNTANT's side (PARITY I1).
 *
 *  - openAccountantCopyFile: restore a .ibac transfer file into a NEW company file (the Portable
 *    Company File restore, which verifies every table, the trial balance and the transaction
 *    log), then turn it into the accountant's working copy: the copy's row flips to side
 *    'accountant' and the version of every journal entry, check / expense, transfer, deposit,
 *    account and class is recorded as the baseline the changes are measured against.
 *  - accountantChanges: the delta made in the copy so far — derived from the audit trail /
 *    running transaction log (which entries were voided, replaced or added, and what replaced
 *    what) checked against the baseline versions. General Journal edits are void + re-post, so a
 *    chain "entry → its replacement → …" collapses into one change of the client's entry.
 *    Transfers post a source-less entry like a General Journal entry; those entries travel as
 *    the transfer, never as journal entries of their own.
 *    Format 3 adds the forms of docs.ts (sales / purchase forms, payments, inventory adjustments,
 *    estimates / orders), new and edited names and items, applications and reconciliations
 *    (extras.ts). A form whose version only moved because something was applied to it (its digest
 *    — digest.ts — is unchanged) is not reported as edited.
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
  deposits,
  expenses,
  journalEntries,
  journalEntryLines,
  transfers,
  users,
} from '@/lib/db/schema';
import { dataDirOf } from '@/lib/db/txHooks';
import { qbAccountTypeOf } from '@/lib/accountTypes';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, validation, writeAudit } from '../_base';
import { getExpense } from '../expenses';
import { defaultPortableRestoreDir, readPortableManifest, restorePortableCompanyFile } from '../portableFile';
import { readAllTransactionLog, entityLabel } from '../transactionLog';
import { depositPayloadOf, transferPayloadOf } from './client';
import {
  CHANGES_EXTENSION,
  CHANGES_FORMAT_VERSION,
  TRANSFER_ENTRY,
  type AccountChange,
  type AccountPayload,
  type ApplicationChange,
  type ChangesFileBody,
  type ClassChange,
  type DocChange,
  type DocType,
  type ExpensePayload,
  type JournalPayload,
  type NameChange,
  type NameType,
  type ReconciliationChange,
  type TransferManifest,
  type TxnChange,
  safeCompanyName,
  serializeChangesFile,
} from './format';
import { DIGEST_TYPES, baselineInsertSql, recordStates } from './digest';
import {
  DOC_LABEL,
  DOC_ORDER,
  NAME_LABEL,
  adjustmentEntriesSince,
  describeDoc,
  describeName,
  docPayload,
  namePayload,
  type Labels,
} from './docs';
import { applicationChanges, describeApplication, describeReconciliation, extrasBaselineSql, reconciliationChanges } from './extras';
import { addFileLabels, labelsOf, loadLabelMaps } from './labels';

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
        SELECT ${m.copyId}::uuid, 'transfer', id, updated_at FROM transfers WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'deposit', id, updated_at FROM deposits WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'account', id, edited_at FROM accounts WHERE company_id = ${m.companyId}::uuid
        UNION ALL
        SELECT ${m.copyId}::uuid, 'class', id, created_at FROM classes WHERE company_id = ${m.companyId}::uuid`);
      // Format 3: forms, names and items (version + substance digest + state), applications and
      // reconciliations.
      for (const type of DIGEST_TYPES) await tx.execute(baselineInsertSql(type, m.copyId, m.companyId));
      for (const q of extrasBaselineSql(m.copyId, m.companyId)) await tx.execute(q);
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

/**
 * Entity types that are business data but that the changes file can't carry (warned about). The
 * route gate and the services refuse most of these in the copy; this catches anything that got
 * through so nothing is silently lost.
 */
const NOT_CARRIED = new Set([
  'paycheck', 'pay_run', 'inventory_transfer', 'bank_transaction', 'time_entry', 'expense_report',
  'loan_payment', 'landed_cost_allocation', 'home_currency_adjustment', 'sales_tax_adjustment',
  'invoice_write_off', 'employee', 'job', 'location', 'sales_rep', 'bank_account',
  'payroll_item', 'tax_rate', 'tax_agency', 'price_level', 'fixed_asset', 'company', 'company_settings', 'fiscal_period',
]);

/** One line of the accountant's "changes so far" list. */
export interface ChangeSummaryRow {
  key: string;
  op: 'add' | 'edit' | 'void' | 'apply' | 'unapply' | 'reconcile' | 'undo';
  kind: string;
  title: string;
  date: string | null;
  amount: string | null;
}

export interface AccountantChanges {
  copy: { id: string; dividingDate: string; openedAt: string | null; exportedAt: string | null; exportCount: number; note: string | null };
  accounts: AccountChange[];
  classes: ClassChange[];
  transactions: TxnChange[];
  names: NameChange[];
  documents: DocChange[];
  applications: ApplicationChange[];
  reconciliations: ReconciliationChange[];
  warnings: string[];
  /** Every change in plain language (what the client will see in their review). */
  summary: ChangeSummaryRow[];
}

/** Sales / purchase orders: status changes a user makes (partial / closed by receiving count as open). */
const userState = (type: DocType, state: string) =>
  type === 'sales_order' || type === 'purchase_order' ? (state === 'void' ? 'void' : state === 'closed' ? 'closed' : 'open') : state;

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
    postedId: entry.id,
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
  const full = new Map<string, Map<string, (typeof baseRows)[number]>>();
  for (const r of baseRows) {
    if (!full.has(r.entityType)) full.set(r.entityType, new Map());
    full.get(r.entityType)!.set(r.entityId, r);
  }
  const fullOf = (t: string) => full.get(t) ?? new Map<string, (typeof baseRows)[number]>();

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
  // Entries a transfer posted (now or before an edit re-posted / a void reversed it) are carried
  // by the transfer itself.
  const transferEntryIds = new Set<string>();
  for (const t of await ctx.db
    .select({ id: transfers.postedEntryId })
    .from(transfers)
    .where(eq(transfers.companyId, ctx.companyId))) {
    if (t.id) transferEntryIds.add(t.id);
  }
  for (const r of await ctx.db
    .select({
      a: sql<string | null>`${auditLogs.oldValues}->>'postedEntryId'`,
      b: sql<string | null>`${auditLogs.newValues}->>'postedEntryId'`,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'transfer')))) {
    if (r.a) transferEntryIds.add(r.a);
    if (r.b) transferEntryIds.add(r.b);
  }
  const txns: TxnChange[] = [];
  const jeRows = (
    await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))
  ).filter((e) => isGeneralJournal(e.sourceRef) && !transferEntryIds.has(e.id));
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

  // ---- Transfers ----
  const baseTr = baseOf('transfer');
  const trRows = await ctx.db
    .select()
    .from(transfers)
    .where(eq(transfers.companyId, ctx.companyId))
    .orderBy(asc(transfers.date), asc(transfers.createdAt));
  for (const t of trRows) {
    if (baseTr.has(t.id)) {
      const v = baseTr.get(t.id) ?? null;
      if (sameVersion(t.updatedAt, v)) continue;
      if (t.voidedAt) txns.push({ op: 'void', type: 'transfer', id: t.id, baseVersion: iso(v) });
      else txns.push({ op: 'edit', type: 'transfer', id: t.id, baseVersion: iso(v), after: { ...transferPayloadOf(t), postedEntryId: t.postedEntryId } });
      continue;
    }
    if (!t.voidedAt) txns.push({ op: 'add', type: 'transfer', id: t.id, after: { ...transferPayloadOf(t), postedEntryId: t.postedEntryId } });
  }

  // ---- Deposits ----
  const baseDep = baseOf('deposit');
  const depRows = await ctx.db
    .select({ id: deposits.id, updatedAt: deposits.updatedAt, voidedAt: deposits.voidedAt })
    .from(deposits)
    .where(eq(deposits.companyId, ctx.companyId))
    .orderBy(asc(deposits.date), asc(deposits.createdAt));
  for (const x of depRows) {
    if (baseDep.has(x.id)) {
      const v = baseDep.get(x.id) ?? null;
      if (sameVersion(x.updatedAt, v)) continue;
      if (x.voidedAt) txns.push({ op: 'void', type: 'deposit', id: x.id, baseVersion: iso(v) });
      else txns.push({ op: 'edit', type: 'deposit', id: x.id, baseVersion: iso(v), after: await depositPayloadOf(ctx, x.id) });
      continue;
    }
    if (!x.voidedAt) txns.push({ op: 'add', type: 'deposit', id: x.id, after: await depositPayloadOf(ctx, x.id) });
  }

  const warnings: string[] = [];

  // ---- Names and items (new ones, parents first; edits of the fields a copy may change) ----
  const names: NameChange[] = [];
  for (const type of ['customer', 'vendor', 'other_name', 'item'] as NameType[]) {
    const b = fullOf(type);
    const states = await recordStates(ctx, type);
    const added: Array<{ id: string; after: Record<string, unknown> }> = [];
    for (const st of states.values()) {
      const row = b.get(st.id);
      if (!row) {
        added.push({ id: st.id, after: await namePayload(ctx, type, st.id) });
        continue;
      }
      if (row.digest !== null && st.digest === row.digest) continue;
      if (row.digest === null) continue; // baseline from an older copy: nothing to compare against
      names.push({ op: 'edit', type, id: st.id, baseVersion: iso(row.version), baseDigest: row.digest, after: await namePayload(ctx, type, st.id, true) });
    }
    // Sub-customers after their parent.
    const ids = new Set(added.map((a) => a.id));
    const placedNames = new Set<string>();
    while (placedNames.size < added.length) {
      const before = placedNames.size;
      for (const a of added) {
        if (placedNames.has(a.id)) continue;
        const parent = a.after.parentId as string | null | undefined;
        if (parent && ids.has(parent) && !placedNames.has(parent)) continue;
        names.push({ op: 'add', type, id: a.id, after: a.after });
        placedNames.add(a.id);
      }
      if (placedNames.size === before) break;
    }
  }

  // ---- Sales / purchase forms, payments, inventory adjustments ----
  const documents: DocChange[] = [];
  for (const type of DOC_ORDER) {
    if (type === 'inventory_adjustment') {
      if (copy.openedAt) {
        for (const entryId of await adjustmentEntriesSince(ctx, copy.openedAt)) {
          documents.push({ op: 'add', type, id: entryId, after: await docPayload(ctx, type, entryId) });
        }
      }
      continue;
    }
    const b = fullOf(type);
    const states = [...(await recordStates(ctx, type)).values()].sort((x, y) => (x.day ?? '').localeCompare(y.day ?? ''));
    for (const st of states) {
      const row = b.get(st.id);
      if (!row) {
        if (st.state !== 'void') documents.push({ op: 'add', type, id: st.id, after: await docPayload(ctx, type, st.id) });
        continue;
      }
      const was = userState(type, row.state ?? 'live');
      const now = userState(type, st.state);
      if (row.digest === st.digest && was === now) continue;
      if (was === 'void') continue; // a void record can't be changed back
      if (now === 'void') {
        documents.push({ op: 'void', type, id: st.id, baseVersion: iso(row.version), baseDigest: row.digest });
        continue;
      }
      documents.push({ op: 'edit', type, id: st.id, baseVersion: iso(row.version), baseDigest: row.digest, after: await docPayload(ctx, type, st.id) });
    }
  }

  // ---- Applications and reconciliations ----
  const applications = await applicationChanges(ctx, full, copy.openedAt);
  const recon = await reconciliationChanges(ctx, full);
  warnings.push(...recon.warnings);

  // ---- Anything in the transaction log the file can't carry ----
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

  const out: Omit<AccountantChanges, 'summary'> = {
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
    names,
    documents,
    applications,
    reconciliations: recon.changes,
    warnings,
  };
  const maps = await loadLabelMaps(ctx);
  addFileLabels(maps, out);
  return { ...out, summary: summarize(out, labelsOf(maps)) };
}

const TXN_KIND: Record<TxnChange['type'], string> = {
  journal_entry: 'Journal entry',
  expense: 'Check / expense',
  transfer: 'Transfer',
  deposit: 'Deposit',
};

/** The changes in plain language, in the order the client's import applies them. */
export function summarize(c: Omit<AccountantChanges, 'summary'>, L: Labels): ChangeSummaryRow[] {
  const rows: ChangeSummaryRow[] = [];
  for (const a of c.accounts) {
    rows.push({ key: `account:${a.id}`, op: a.op, kind: 'Account', title: `${a.op === 'add' ? 'New' : 'Changed'} account ${a.after.code} · ${a.after.name}`, date: null, amount: null });
  }
  for (const k of c.classes) rows.push({ key: `class:${k.id}`, op: 'add', kind: 'Class', title: `New class ${k.name}`, date: null, amount: null });
  for (const n of c.names) {
    const d = describeName(n.type, n.after, L);
    rows.push({ key: `${n.type}:${n.id}`, op: n.op, kind: NAME_LABEL[n.type], title: `${n.op === 'add' ? 'New' : 'Changed'} ${d.title.charAt(0).toLowerCase()}${d.title.slice(1)}`, date: null, amount: null });
  }
  for (const t of c.transactions) {
    const verb = t.op === 'add' ? 'New' : t.op === 'edit' ? 'Changed' : 'Voided';
    let title = `${verb} ${TXN_KIND[t.type].toLowerCase()}`;
    let amount: string | null = null;
    if (t.op !== 'void') {
      if (t.type === 'journal_entry') {
        title += `: ${t.after.description}`;
        amount = toAmountString(t.after.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0));
      } else if (t.type === 'expense') {
        title += ` to ${t.after.vendorId ? L.name(t.after.vendorId) : t.after.payeeName ?? 'payee'}`;
        amount = toAmountString(t.after.total.replace(/^-/, ''));
      } else if (t.type === 'transfer') {
        title += ` from ${L.account(t.after.fromAccountId)} to ${L.account(t.after.toAccountId)}`;
        amount = toAmountString(t.after.amount);
      } else {
        title += ` to ${L.account(t.after.depositAccountId)}`;
        amount = toAmountString(t.after.total);
      }
    }
    rows.push({ key: `${t.type}:${t.op}:${t.id}`, op: t.op, kind: TXN_KIND[t.type], title, date: t.op === 'void' ? null : ymd(new Date(t.after.date)), amount });
  }
  for (const d of c.documents) {
    if (d.op === 'void') {
      rows.push({ key: `${d.type}:void:${d.id}`, op: 'void', kind: DOC_LABEL[d.type], title: `Voided ${DOC_LABEL[d.type].toLowerCase()} (${L.doc(d.id)})`, date: null, amount: null });
      continue;
    }
    const x = describeDoc(d.type, d.after, L);
    rows.push({
      key: `${d.type}:${d.op}:${d.id}`,
      op: d.op,
      kind: DOC_LABEL[d.type],
      title: `${d.op === 'add' ? 'New' : 'Changed'}: ${x.title}`,
      date: ymd(new Date(String(d.after.date))),
      amount: x.amount,
    });
  }
  for (const a of c.applications) {
    const x = describeApplication(a, L);
    rows.push({ key: `application:${a.kind}:${a.op}:${a.id}`, op: a.op, kind: 'Application', title: x.title, date: ymd(new Date(a.date)), amount: toAmountString(a.amount) });
  }
  for (const r of c.reconciliations) {
    const x = describeReconciliation(r, L);
    rows.push({ key: `reconciliation:${r.op}:${r.id}`, op: r.op, kind: 'Reconciliation', title: x.title, date: ymd(new Date(r.statementDate)), amount: toAmountString(r.statementBalance) });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Export the changes file (.ibcx)
// ---------------------------------------------------------------------------

export interface ChangesFileResult {
  buffer: Buffer;
  filename: string;
  counts: {
    accounts: number;
    classes: number;
    transactions: number;
    names: number;
    documents: number;
    applications: number;
    reconciliations: number;
  };
}

export async function exportChangesFile(ctx: ServiceContext, input: { note?: string | null } = {}): Promise<ChangesFileResult> {
  const copy = await accountantSideCopy(ctx);
  const changes = await accountantChanges(ctx);
  const note = input.note?.trim() ? input.note.trim().slice(0, 20_000) : null;
  const total =
    changes.accounts.length +
    changes.classes.length +
    changes.transactions.length +
    changes.names.length +
    changes.documents.length +
    changes.applications.length +
    changes.reconciliations.length;
  if (!total && !note) {
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
    names: changes.names,
    documents: changes.documents,
    applications: changes.applications,
    reconciliations: changes.reconciliations,
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
          names: changes.names.length,
          documents: changes.documents.length,
          applications: changes.applications.length,
          reconciliations: changes.reconciliations.length,
        },
      },
    );
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    filename: `${safeCompanyName(body.companyName)} (Accountant Changes ${stamp}).${CHANGES_EXTENSION}`,
    counts: {
      accounts: changes.accounts.length,
      classes: changes.classes.length,
      transactions: changes.transactions.length,
      names: changes.names.length,
      documents: changes.documents.length,
      applications: changes.applications.length,
      reconciliations: changes.reconciliations.length,
    },
  };
}
