/**
 * Accountant's Copy — the CLIENT's side (PARITY I1).
 *
 *  - createAccountantCopy: record that an Accountant's Copy is outstanding (dividing date) and
 *    build the .ibac transfer file. From then on transactions dated on or before the dividing
 *    date are locked in this file and list entries can't be deleted or merged (guard.ts).
 *  - reviewChangesFile: read the accountant's .ibcx and list every change (added / changed /
 *    voided transactions, account and class changes, the accountant's note) next to what this
 *    file has now, flagging anything that can't be applied.
 *  - importChangesFile: apply the changes through the normal services (createManualEntry,
 *    updateEntry, createExpense, createTransfer, createDeposit, updateAccount, ...) in ONE transaction — the closing date,
 *    reconciliation, record-locking (version) and ledger-balance guards all stay on; only this
 *    copy's dividing-date lock is lifted for the import, and only for changes to records dated on
 *    or before the dividing date (an edit / void naming a later record refuses the whole file).
 *    Then the restriction is removed.
 *  - cancelAccountantCopy: remove the restriction without importing; that copy's changes file is
 *    refused from then on.
 */
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accountantCopies,
  accounts,
  bankAccounts,
  classes,
  companies,
  creditApplications,
  customers,
  deposits,
  employees,
  expenses,
  inventoryLayers,
  items as itemsTable,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  otherNames,
  paymentsReceived,
  reconciliations,
  salesReceipts,
  transfers,
  users,
  vendors,
} from '@/lib/db/schema';
import { formatCurrency, Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, validation, writeAudit } from '../_base';
import { createAccount, updateAccount } from '../accounts';
import { createClass } from '../dimensions';
import { createExpense, getExpense, updateExpense, voidExpense, type CreateExpenseInput, type ExpenseMethod } from '../expenses';
import { createManualEntry, updateEntry, voidEntry } from '../journal';
import { createTransfer, updateTransfer, voidTransfer, type CreateTransferInput } from '../transfers';
import { createDeposit, updateDeposit, voidDeposit, getDeposit, CASHBACK_LINE_PREFIX, RECEIPT_LINE_PREFIX, type CreateDepositInput } from '../deposits';
import type { PostingLine } from '../posting';
import { currentVersion, withVersionCheck, type VersionedEntity } from '../concurrency';
import { createPortableCompanyFile } from '../portableFile';
import { trialBalance } from '../reports';
import { getClosingDateSettings } from '../company';
import {
  DOC_SHAPES,
  NAME_SHAPES,
  TRANSFER_ENTRY,
  TRANSFER_EXTENSION,
  type AccountChange,
  type ChangesFile,
  type DepositPayload,
  type DocChange,
  type DocType,
  type ExpensePayload,
  type JournalPayload,
  type LineRef,
  type NameChange,
  type NameType,
  type TransferManifest,
  type TransferPayload,
  type TxnChange,
  type TxnType,
  parseChangesFile,
  safeCompanyName,
} from './format';
import { formatDividingDate, runAccountantImport } from './guard';
import { withAccountantCosts } from './inventoryCost';
import { NAME_COLUMNS, changedNameFields, recordStates } from './digest';
import {
  DOC_LABEL,
  DOC_ORDER,
  accountantCostsOf,
  NAME_LABEL,
  createDoc,
  createName,
  decodePayload,
  describeDoc,
  mapEstimateLines,
  describeName,
  docPayload,
  nameEditSummary,
  namePayload,
  otherNameVersion,
  updateDoc,
  updateName,
  voidDoc,
} from './docs';
import { applicationTargets, applyApplication, applyReconciliation, describeApplication, describeReconciliation, reconciliationBlocker } from './extras';
import { addFileLabels, labelsOf, loadLabelMaps } from './labels';
import { applicationKey, clientWorkConflicts } from './clientWork';
import { resolveLineRef, type IdMap, type LineMap } from './lineRefs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getClosingDate(ctx: ServiceContext): Promise<string | null> {
  return (await getClosingDateSettings(ctx)).closingDate;
}

function assertOwnerOrAdmin(ctx: ServiceContext, what: string): void {
  if (ctx.role && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', `Only the company owner or an admin can ${what}.`);
  }
}

export type AccountantCopyRow = typeof accountantCopies.$inferSelect;

/** Public view of a copy row (the file token never leaves the server). */
export function publicCopy(row: AccountantCopyRow) {
  const { fileToken: _token, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface AccountantCopyStatus {
  /** 'client': an Accountant's Copy is out; 'accountant': this file IS the accountant's copy. */
  mode: 'none' | 'client' | 'accountant';
  current: ReturnType<typeof publicCopy> | null;
  history: Array<ReturnType<typeof publicCopy>>;
  closingDate: string | null;
}

export async function accountantCopyStatus(ctx: ServiceContext): Promise<AccountantCopyStatus> {
  const rows = await ctx.db
    .select()
    .from(accountantCopies)
    .where(eq(accountantCopies.companyId, ctx.companyId))
    .orderBy(desc(accountantCopies.createdAt))
    .limit(25);
  const acct = rows.find((r) => r.side === 'accountant');
  const out = rows.find((r) => r.side === 'client' && r.status === 'outstanding');
  const closingDate = await getClosingDate(ctx);
  if (acct) return { mode: 'accountant', current: publicCopy(acct), history: [], closingDate };
  return {
    mode: out ? 'client' : 'none',
    current: out ? publicCopy(out) : null,
    history: rows.filter((r) => r.side === 'client' && r.id !== out?.id).map(publicCopy),
    closingDate,
  };
}

// ---------------------------------------------------------------------------
// Create the transfer file (.ibac)
// ---------------------------------------------------------------------------

export interface TransferFileResult {
  buffer: Buffer;
  filename: string;
  copy: ReturnType<typeof publicCopy>;
}

export async function createAccountantCopy(
  ctx: ServiceContext,
  input: { dividingDate: string; dataDir?: string },
): Promise<TransferFileResult> {
  assertOwnerOrAdmin(ctx, "create an Accountant's Copy (it contains every user and password of the file)");
  const dividingDate = String(input.dividingDate ?? '').trim();
  if (!DATE_RE.test(dividingDate) || isNaN(new Date(`${dividingDate}T00:00:00.000Z`).getTime())) {
    throw validation('Enter the dividing date as a date (YYYY-MM-DD).');
  }
  const status = await accountantCopyStatus(ctx);
  if (status.mode === 'accountant') {
    throw new ServiceError('CONFLICT', "This file is itself an Accountant's Copy. Only your client's original file can create one.");
  }
  if (status.mode === 'client') {
    throw new ServiceError(
      'CONFLICT',
      `An Accountant's Copy (dividing date ${formatDividingDate(status.current!.dividingDate)}) is already out. Import its changes or cancel it before creating another.`,
    );
  }
  const [co] = await ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  if (!co) throw new ServiceError('NOT_FOUND', 'Company not found');
  const [me] = ctx.userId ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)) : [];

  const row = await inTransaction(ctx, async (tx) => {
    const [created] = await tx.db
      .insert(accountantCopies)
      .values({
        companyId: tx.companyId,
        side: 'client',
        status: 'outstanding',
        dividingDate,
        fileToken: randomBytes(24).toString('hex'),
        createdBy: tx.userId,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'accountant_copy',
      entityId: created.id,
      newValues: { dividingDate, status: 'outstanding' },
    });
    return created;
  });

  try {
    const portable = await createPortableCompanyFile(ctx, { dataDir: input.dataDir });
    const zip = new AdmZip(portable.buffer);
    const manifest: TransferManifest = {
      app: 'ironbooks',
      kind: 'accountant-copy',
      formatVersion: 1,
      copyId: row.id,
      companyId: ctx.companyId,
      companyName: co.name,
      dividingDate,
      createdAt: row.createdAt.toISOString(),
      createdBy: me?.name ?? null,
    };
    zip.addFile(TRANSFER_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    return {
      buffer: zip.toBuffer(),
      filename: `${safeCompanyName(co.name)} (Accountant's Copy ${dividingDate}).${TRANSFER_EXTENSION}`,
      copy: publicCopy(row),
    };
  } catch (err) {
    // The file could not be built: nothing went out, so the restriction is lifted again.
    await ctx.db
      .update(accountantCopies)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, result: { error: 'transfer file could not be created' }, updatedAt: new Date() })
      .where(eq(accountantCopies.id, row.id));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelAccountantCopy(ctx: ServiceContext) {
  assertOwnerOrAdmin(ctx, "cancel an Accountant's Copy");
  const status = await accountantCopyStatus(ctx);
  if (status.mode === 'accountant') {
    throw new ServiceError('CONFLICT', "An Accountant's Copy can only be cancelled in your client's original file.");
  }
  if (status.mode !== 'client' || !status.current) {
    throw new ServiceError('NOT_FOUND', "There is no Accountant's Copy to cancel.");
  }
  const id = status.current.id;
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(accountantCopies)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: tx.userId, updatedAt: new Date() })
      .where(and(eq(accountantCopies.id, id), eq(accountantCopies.status, 'outstanding')))
      .returning();
    if (!row) throw new ServiceError('CONFLICT', "This Accountant's Copy was already imported or cancelled.");
    await writeAudit(tx, {
      action: 'update',
      entityType: 'accountant_copy',
      entityId: id,
      oldValues: { status: 'outstanding' },
      newValues: { status: 'cancelled' },
    });
    return publicCopy(row);
  });
}

// ---------------------------------------------------------------------------
// Match a changes file to this file's outstanding copy
// ---------------------------------------------------------------------------

async function matchCopy(ctx: ServiceContext, file: ChangesFile): Promise<AccountantCopyRow> {
  const otherFile = () =>
    new ServiceError(
      'VALIDATION',
      "This changes file was made from a different company file. Import it into the file that created the Accountant's Copy.",
    );
  if (file.companyId !== ctx.companyId) throw otherFile();
  const [row] = await ctx.db
    .select()
    .from(accountantCopies)
    .where(and(eq(accountantCopies.id, file.copyId), eq(accountantCopies.companyId, ctx.companyId)));
  if (!row) throw otherFile();
  if (row.side !== 'client') {
    throw new ServiceError(
      'VALIDATION',
      "This file is the accountant's working copy. Changes are imported into your client's original file.",
    );
  }
  if (row.fileToken !== file.fileToken || row.dividingDate !== file.dividingDate) throw otherFile();
  if (row.status === 'cancelled') {
    throw new ServiceError(
      'CONFLICT',
      `This changes file belongs to an Accountant's Copy that was cancelled${row.cancelledAt ? ` on ${row.cancelledAt.toLocaleDateString('en-US')}` : ''}, so it can't be imported. ` +
        "Ask your accountant to make the changes again in a new Accountant's Copy, or enter them yourself.",
    );
  }
  if (row.status === 'imported') {
    throw new ServiceError(
      'CONFLICT',
      `These changes were already imported${row.importedAt ? ` on ${row.importedAt.toLocaleDateString('en-US')}` : ''}.`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewItem {
  key: string;
  group: 'account' | 'class' | 'name' | 'transaction' | 'application' | 'reconciliation';
  op: 'add' | 'edit' | 'void' | 'apply' | 'unapply' | 'reconcile' | 'undo';
  kind: string;
  date: string | null;
  title: string;
  amount: string | null;
  /** What this file has now (edits / voids). */
  before: string[] | null;
  /** What the accountant's version says (adds / edits). */
  after: string[] | null;
  problem: string | null;
  /** Something worth knowing that does not stop the import (e.g. a document number used twice). */
  note?: string | null;
  /**
   * A name / item both sides changed: the import can still go ahead if you keep your version of
   * the fields you both changed (the accountant's other changes to it are applied).
   */
  keepable?: boolean;
  /** The fields you both changed (empty when the file can't tell which fields the accountant changed). */
  conflictFields?: string[];
}

export interface ChangesReview {
  companyName: string;
  dividingDate: string;
  preparedBy: string | null;
  createdAt: string;
  note: string | null;
  warnings: string[];
  items: ReviewItem[];
  counts: { added: number; changed: number; voided: number; lists: number; applications: number; reconciliations: number };
  canImport: boolean;
  /** Every problem is a name / item both sides changed: importing while keeping your version of those is possible. */
  canImportKeepingMine: boolean;
  closingDate: string | null;
  /** True when some change is dated on/before the closing date (the closing-date password is needed). */
  needsClosingPassword: boolean;
  /** Format of the changes file (2: journal entries, checks, transfers, deposits, accounts, classes). */
  formatVersion: number;
}

type NameMaps = {
  accounts: Map<string, { code: string; name: string }>;
  classes: Map<string, string>;
  names: Map<string, string>;
  /** Payments / sales receipts a deposit holds, as "Payment #ref — $x (Customer)". */
  docs: Map<string, string>;
};

async function nameMaps(ctx: ServiceContext, file: ChangesFile): Promise<NameMaps> {
  const accts = new Map<string, { code: string; name: string }>();
  for (const a of await ctx.db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(eq(accounts.companyId, ctx.companyId))) {
    accts.set(a.id, { code: a.code, name: a.name });
  }
  for (const a of file.accounts) if (a.op === 'add') accts.set(a.id, { code: a.after.code, name: a.after.name });
  const cls = new Map<string, string>();
  for (const c of await ctx.db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.companyId, ctx.companyId))) cls.set(c.id, c.name);
  for (const c of file.classes) cls.set(c.id, c.name);
  const names = new Map<string, string>();
  const ids = new Set<string>();
  const payIds = new Set<string>();
  const srIds = new Set<string>();
  for (const t of file.transactions) {
    if (t.op === 'void') continue;
    if (t.type === 'journal_entry') for (const l of t.after.lines) if (l.entityId) ids.add(l.entityId);
    if (t.type === 'expense' && t.after.vendorId) ids.add(t.after.vendorId);
    if (t.type === 'deposit') {
      for (const id of t.after.paymentIds) payIds.add(id);
      for (const id of t.after.salesReceiptIds) srIds.add(id);
    }
  }
  const fileDocs = (file.documents ?? []).filter((d) => d.op === 'add' && (d.type === 'payment_received' || d.type === 'sales_receipt'));
  for (const d of fileDocs) if (d.op === 'add' && typeof d.after.customerId === 'string') ids.add(d.after.customerId);
  const docs = new Map<string, string>();
  const docCustomers: Array<[string, string | null, string]> = [];
  if (payIds.size) {
    for (const r of await ctx.db
      .select({ id: paymentsReceived.id, customerId: paymentsReceived.customerId, reference: paymentsReceived.reference, amount: paymentsReceived.amount })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.id, [...payIds])))) {
      docCustomers.push([r.id, r.customerId, `Payment${r.reference ? ` #${r.reference}` : ''} — ${formatCurrency(r.amount)}`]);
      ids.add(r.customerId);
    }
  }
  if (srIds.size) {
    for (const r of await ctx.db
      .select({ id: salesReceipts.id, customerId: salesReceipts.customerId, n: salesReceipts.receiptNumber, ref: salesReceipts.refNumber, total: salesReceipts.total })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, ctx.companyId), inArray(salesReceipts.id, [...srIds])))) {
      docCustomers.push([r.id, r.customerId, `Sales receipt #${r.ref ?? r.n} — ${formatCurrency(r.total)}`]);
      if (r.customerId) ids.add(r.customerId);
    }
  }
  if (ids.size) {
    const list = [...ids];
    for (const r of await ctx.db.select({ id: customers.id, n: customers.displayName }).from(customers).where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, list)))) names.set(r.id, r.n);
    for (const r of await ctx.db.select({ id: vendors.id, n: vendors.displayName }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), inArray(vendors.id, list)))) names.set(r.id, r.n);
    for (const r of await ctx.db.select({ id: employees.id, f: employees.firstName, l: employees.lastName }).from(employees).where(and(eq(employees.companyId, ctx.companyId), inArray(employees.id, list)))) names.set(r.id, `${r.f} ${r.l}`.trim());
    for (const r of await ctx.db.select({ id: otherNames.id, n: otherNames.name }).from(otherNames).where(and(eq(otherNames.companyId, ctx.companyId), inArray(otherNames.id, list)))) names.set(r.id, r.n);
  }
  // Names, payments and sales receipts the accountant added (they arrive with this file).
  for (const n of file.names ?? []) if (n.op === 'add' && n.type !== 'item') names.set(n.id, String(n.after.displayName ?? n.after.name ?? ''));
  for (const [id, customerId, text] of docCustomers) {
    docs.set(id, `${text}${customerId && names.has(customerId) ? ` (${names.get(customerId)})` : ''}`);
  }
  for (const d of fileDocs) {
    if (d.op !== 'add') continue;
    const who = typeof d.after.customerId === 'string' && names.has(d.after.customerId) ? ` (${names.get(d.after.customerId)})` : '';
    docs.set(
      d.id,
      d.type === 'payment_received'
        ? `New payment${d.after.reference ? ` #${d.after.reference}` : ''} — ${formatCurrency(String(d.after.amount))}${who} (in these changes)`
        : `New sales receipt${d.after.refNumber ? ` #${d.after.refNumber}` : ''} — ${formatCurrency(String(d.after.total))}${who} (in these changes)`,
    );
  }
  return { accounts: accts, classes: cls, names, docs };
}

const day = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);
const acctLabel = (m: NameMaps, id: string | null) => {
  if (!id) return '(no account)';
  const a = m.accounts.get(id);
  return a ? `${a.code} · ${a.name}` : '(unknown account)';
};

function journalLines(m: NameMaps, p: { lines: JournalPayload['lines'] }): string[] {
  return p.lines.map((l) => {
    const side = l.debit ? `debit ${formatCurrency(l.debit)}` : `credit ${formatCurrency(l.credit ?? 0)}`;
    const extras = [
      l.entityId ? m.names.get(l.entityId) ?? 'a name' : null,
      l.classId ? `class ${m.classes.get(l.classId) ?? '?'}` : null,
      l.memo || null,
    ].filter(Boolean);
    return `${acctLabel(m, l.accountId)} — ${side}${extras.length ? ` (${extras.join(', ')})` : ''}`;
  });
}

function journalTotal(p: { lines: Array<{ debit: string | null }> }): string {
  return toAmountString(Money.add(...p.lines.map((l) => l.debit ?? 0)));
}

function expenseLines(m: NameMaps, p: ExpensePayload): string[] {
  const head = `${p.method === 'credit_card' ? (p.isRefund ? 'Card credit' : 'Card charge') : p.method === 'cash' ? 'Cash expense' : 'Check'}${p.reference ? ` #${p.reference}` : ''} from ${acctLabel(m, p.paymentAccountId)} to ${p.vendorId ? m.names.get(p.vendorId) ?? 'vendor' : p.payeeName ?? 'payee'}`;
  return [
    head,
    ...p.lines.map((l) => `${l.itemId ? 'Item line' : acctLabel(m, l.accountId)} — ${formatCurrency(l.amount)}${l.description ? ` (${l.description})` : ''}${l.classId ? ` [class ${m.classes.get(l.classId) ?? '?'}]` : ''}`),
    ...(p.memo ? [`Memo: ${p.memo}`] : []),
  ];
}

async function currentJournal(ctx: ServiceContext, m: NameMaps, id: string) {
  const [e] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, ctx.companyId)));
  if (!e) return null;
  const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, id));
  const p = { lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo, classId: l.classId, entityType: null, entityId: l.entityId })) };
  return {
    row: e,
    text: [`#${e.entryNumber} ${day(e.date)} — ${e.description}${e.status === 'void' ? ' (void)' : ''}`, ...journalLines(m, p)],
    total: journalTotal(p),
  };
}

async function currentExpense(ctx: ServiceContext, m: NameMaps, id: string) {
  const [x] = await ctx.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!x) return null;
  const e = await getExpense(ctx, id);
  const p: ExpensePayload = {
    vendorId: e.vendorId,
    payeeName: e.payeeName,
    date: e.date.toISOString(),
    method: e.method,
    reference: e.reference,
    paymentAccountId: e.paymentAccountId,
    memo: e.memo,
    toPrint: e.toPrint,
    isRefund: String(e.total).startsWith('-'),
    currency: e.currency,
    exchangeRate: e.exchangeRate,
    total: String(e.total),
    lines: e.lines.map((l) => ({ accountId: l.itemId ? null : l.accountId, itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, description: l.description, amount: String(l.amount), classId: l.classId, customerId: l.customerId, jobId: l.jobId })),
  };
  if (p.vendorId && !m.names.has(p.vendorId)) {
    const [v] = await ctx.db.select({ n: vendors.displayName }).from(vendors).where(eq(vendors.id, p.vendorId));
    if (v) m.names.set(p.vendorId, v.n);
  }
  return { row: x, text: [`${day(x.date)}${x.voidedAt ? ' (void)' : ''}`, ...expenseLines(m, p)] };
}

function transferText(m: NameMaps, p: TransferPayload): string[] {
  return [
    `Transfer ${formatCurrency(p.amount)} from ${acctLabel(m, p.fromAccountId)} to ${acctLabel(m, p.toAccountId)}`,
    ...(p.toAmount ? [`Arrived: ${formatCurrency(p.toAmount)}`] : []),
    ...(p.memo ? [`Memo: ${p.memo}`] : []),
  ];
}

function depositText(m: NameMaps, p: DepositPayload): string[] {
  return [
    `Deposit to ${acctLabel(m, p.depositAccountId)}`,
    ...[...p.paymentIds, ...p.salesReceiptIds].map((id) => m.docs.get(id) ?? 'A payment that is not in your file'),
    ...p.extraLines.map((l) => `${acctLabel(m, l.accountId)} — ${formatCurrency(l.amount)}${l.description ? ` (${l.description})` : ''}`),
    ...(p.cashBack ? [`Cash back to ${acctLabel(m, p.cashBack.accountId)} — ${formatCurrency(p.cashBack.amount)}`] : []),
    ...(p.memo ? [`Memo: ${p.memo}`] : []),
  ];
}

/** The payload of a saved transfer (what the accountant's side sends; also the review's "before"). */
export function transferPayloadOf(t: typeof transfers.$inferSelect): TransferPayload {
  const fx = Boolean(t.currency || t.toCurrency);
  return {
    date: new Date(t.date).toISOString(),
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amount: toAmountString(t.amount),
    memo: t.memo,
    toAmount: fx && t.toAmount != null ? toAmountString(t.toAmount) : null,
    homeAmount: fx && t.homeAmount != null ? toAmountString(t.homeAmount) : null,
  };
}

/** The payload of a saved deposit, rebuilt from its lines (the cash-back memo from its entry line). */
export async function depositPayloadOf(ctx: ServiceContext, id: string): Promise<DepositPayload> {
  const dep = await getDeposit(ctx, id);
  const paymentIds: string[] = [];
  const salesReceiptIds: string[] = [];
  const extraLines: DepositPayload['extraLines'] = [];
  let cashBack: DepositPayload['cashBack'] = null;
  for (const l of dep.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) paymentIds.push(l.paymentId);
    else if (desc.startsWith(RECEIPT_LINE_PREFIX)) salesReceiptIds.push(desc.slice(RECEIPT_LINE_PREFIX.length));
    else if (desc.startsWith(CASHBACK_LINE_PREFIX)) {
      cashBack = { accountId: desc.slice(CASHBACK_LINE_PREFIX.length), amount: toAmountString(Money.abs(l.amount)), memo: null };
    } else if (l.accountId) {
      extraLines.push({ accountId: l.accountId, amount: toAmountString(l.amount), description: l.description });
    }
  }
  if (cashBack && dep.postedEntryId) {
    const [gl] = await ctx.db
      .select({ memo: journalEntryLines.memo })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, dep.postedEntryId), eq(journalEntryLines.accountId, cashBack.accountId)));
    const prefix = 'Cash back — ';
    if (gl?.memo?.startsWith(prefix)) cashBack.memo = gl.memo.slice(prefix.length);
  }
  return {
    date: new Date(dep.date).toISOString(),
    depositAccountId: dep.depositAccountId,
    memo: dep.memo,
    exchangeRate: dep.currency && dep.exchangeRate != null ? String(dep.exchangeRate) : null,
    total: toAmountString(dep.total),
    paymentIds,
    salesReceiptIds,
    extraLines,
    cashBack,
  };
}

async function currentTransfer(ctx: ServiceContext, m: NameMaps, id: string) {
  const [t] = await ctx.db.select().from(transfers).where(and(eq(transfers.id, id), eq(transfers.companyId, ctx.companyId)));
  if (!t) return null;
  return { row: t, text: [`${day(t.date)}${t.voidedAt ? ' (void)' : ''}`, ...transferText(m, transferPayloadOf(t))] };
}

async function currentDeposit(ctx: ServiceContext, m: NameMaps, id: string) {
  const [x] = await ctx.db.select().from(deposits).where(and(eq(deposits.id, id), eq(deposits.companyId, ctx.companyId)));
  if (!x) return null;
  const p = await depositPayloadOf(ctx, id);
  if ([...p.paymentIds, ...p.salesReceiptIds].some((d) => !m.docs.has(d))) {
    // Label the payments this deposit holds now (the file only names those of the accountant's version).
    const now = await nameMaps(ctx, { accounts: [], classes: [], transactions: [{ op: 'add', type: 'deposit', id, after: p }] } as unknown as ChangesFile);
    for (const [k, v] of now.docs) m.docs.set(k, v);
  }
  return { row: x, text: [`${day(x.date)}${x.voidedAt ? ' (void)' : ''}`, ...depositText(m, p)] };
}

/** Date ('YYYY-MM-DD') of a record an edit / void / application names, company-scoped (null when it isn't in this file). */
async function currentRecordDay(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  type: TxnType | DocType | 'reconciliation',
  id: string,
): Promise<string | null> {
  if (type === 'journal_entry' || type === 'expense' || type === 'transfer' || type === 'deposit') {
    const table = { journal_entry: journalEntries, expense: expenses, transfer: transfers, deposit: deposits }[type];
    const [row] = await ctx.db
      .select({ date: table.date })
      .from(table)
      .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)));
    return row ? day(row.date) : null;
  }
  if (type === 'reconciliation') {
    const [row] = await ctx.db
      .select({ date: reconciliations.statementDate })
      .from(reconciliations)
      .innerJoin(bankAccounts, eq(bankAccounts.id, reconciliations.bankAccountId))
      .where(and(eq(reconciliations.id, id), eq(bankAccounts.companyId, ctx.companyId)));
    return row ? day(row.date) : null;
  }
  if (type === 'inventory_adjustment') {
    const [row] = await ctx.db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, ctx.companyId)));
    return row ? day(row.date) : null;
  }
  return (await recordStates(ctx, type, [id])).get(id)?.day ?? null;
}

const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

const withArticle = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

const DAY_TYPES = new Set<string>(['journal_entry', 'expense', 'transfer', 'deposit', ...Object.keys(DOC_LABEL)]);

/** Ids of the client's forms a payment / bill payment payload applies to (dividing-date check). */
function paymentTargets(p: Record<string, unknown>): Array<{ type: DocType; id: string }> {
  const out: Array<{ type: DocType; id: string }> = [];
  const arr = (k: string) => (Array.isArray(p[k]) ? (p[k] as Array<Record<string, unknown>>) : []);
  for (const a of [...arr('applications'), ...arr('journalCredits')]) {
    if (typeof a.invoiceId === 'string') out.push({ type: 'invoice', id: a.invoiceId });
    if (typeof a.billId === 'string') out.push({ type: 'bill', id: a.billId });
  }
  for (const c of arr('credits')) {
    if (typeof c.creditMemoId === 'string') out.push({ type: 'credit_memo', id: c.creditMemoId });
    if (typeof c.invoiceId === 'string') out.push({ type: 'invoice', id: c.invoiceId });
  }
  return out;
}

/** General Journal lines a payment / bill payment payload pays, applies or offsets. */
function paymentLineRefs(p: Record<string, unknown>): LineRef[] {
  const out: LineRef[] = [];
  for (const k of ['journalItems', 'journalCredits', 'journalOffsets']) {
    if (!Array.isArray(p[k])) continue;
    for (const x of p[k] as Array<{ line?: LineRef; chargeLine?: LineRef }>) {
      if (x.line) out.push(x.line);
      if (x.chargeLine) out.push(x.chargeLine);
    }
  }
  return out;
}

/** Date of the client's entry holding a journal line (company-scoped; null when it isn't in this file). */
async function journalLineDay(ctx: Pick<ServiceContext, 'db' | 'companyId'>, lineId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ date: journalEntries.date })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(and(eq(journalEntryLines.id, lineId), eq(journalEntries.companyId, ctx.companyId)));
  return row ? day(row.date) : null;
}

/**
 * The latest date a journal line reference can land on in the client's file: the line itself when
 * the client has it, the record that owns it when the client has that, and the date the reference
 * carries (the import only matches lines of entries on that date).
 */
async function lineRefDay(ctx: Pick<ServiceContext, 'db' | 'companyId'>, ref: LineRef): Promise<string> {
  const days = [day(ref.date)];
  const own = await journalLineDay(ctx, ref.lineId);
  if (own) days.push(own);
  if (ref.owner && DAY_TYPES.has(ref.owner.type)) {
    const cur = await currentRecordDay(ctx, ref.owner.type as TxnType | DocType, ref.owner.id);
    if (cur) days.push(cur);
  }
  return days.sort().at(-1)!;
}

/**
 * Latest date a journal entry credit application the file removes touches in the client's file:
 * the application itself (and its pair), the entries of its lines and the invoice / bill it pays.
 */
async function journalApplicationDay(ctx: Pick<ServiceContext, 'db' | 'companyId'>, id: string): Promise<string | null> {
  const [row] = await ctx.db
    .select()
    .from(journalItemApplications)
    .where(and(eq(journalItemApplications.id, id), eq(journalItemApplications.companyId, ctx.companyId)));
  if (!row) return null;
  const rows = row.pairId
    ? await ctx.db
        .select()
        .from(journalItemApplications)
        .where(and(eq(journalItemApplications.companyId, ctx.companyId), eq(journalItemApplications.pairId, row.pairId)))
    : [row];
  const days: string[] = [];
  for (const r of rows.some((x) => x.id === row.id) ? rows : [...rows, row]) {
    days.push(day(r.date));
    const lineDay = await journalLineDay(ctx, r.journalLineId);
    if (lineDay) days.push(lineDay);
    if (r.invoiceId) days.push((await currentRecordDay(ctx, 'invoice', r.invoiceId)) ?? '');
    if (r.billId) days.push((await currentRecordDay(ctx, 'bill', r.billId)) ?? '');
  }
  return days.sort().at(-1) ?? null;
}

const KIND_LABEL: Record<TxnType, string> = {
  journal_entry: 'journal entry',
  expense: 'check / expense',
  transfer: 'transfer',
  deposit: 'deposit',
};

/**
 * The import lifts the dividing-date lock, so this is what keeps a changes file from changing the
 * client's own work dated AFTER the dividing date (an export never produces that; a hand-made file
 * could, since the checksum only proves the file is intact): edits / voids of transactions and
 * forms, credits applied to / taken off invoices and bills, undone reconciliations.
 */
async function assertChangesWithinDividingDate(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  file: ChangesFile,
  copy: AccountantCopyRow,
): Promise<void> {
  const refuse = (what: string, when: string) =>
    validation(
      `The changes file would ${what} of yours dated ${when}, which is dated after the dividing date (${formatDividingDate(copy.dividingDate)}). ` +
        "An accountant's changes can only touch transactions dated on or before the dividing date, so this file can't be used. Nothing was imported.",
    );
  for (const t of file.transactions) {
    if (t.op === 'add') continue;
    const cur = await currentRecordDay(ctx, t.type, t.id);
    if (cur && cur > copy.dividingDate) throw refuse(`${t.op === 'void' ? 'void' : 'change'} a ${KIND_LABEL[t.type]}`, cur);
  }
  for (const d of file.documents) {
    if (d.op === 'add') continue;
    const cur = await currentRecordDay(ctx, d.type, d.id);
    if (cur && cur > copy.dividingDate) throw refuse(`${d.op === 'void' ? 'void' : 'change'} a ${DOC_LABEL[d.type].toLowerCase()}`, cur);
  }
  // Payments and bill payments name the invoices / bills / credits / General Journal lines they
  // apply to inside their own payload: every one must be a record dated on or before the dividing date.
  for (const d of file.documents) {
    if (d.op === 'void' || (d.type !== 'payment_received' && d.type !== 'bill_payment')) continue;
    const label = DOC_LABEL[d.type].toLowerCase();
    for (const t of paymentTargets(d.after as Record<string, unknown>)) {
      const cur = await currentRecordDay(ctx, t.type, t.id);
      if (cur && cur > copy.dividingDate) throw refuse(`apply a ${label} to ${withArticle(DOC_LABEL[t.type].toLowerCase())}`, cur);
    }
    for (const ref of paymentLineRefs(d.after as Record<string, unknown>)) {
      const cur = await lineRefDay(ctx, ref);
      if (cur > copy.dividingDate) throw refuse(`apply a ${label} to a journal entry line`, cur);
    }
  }
  for (const a of file.applications) {
    for (const t of applicationTargets(a)) {
      const cur = await currentRecordDay(ctx, t.type, t.id);
      if (cur && cur > copy.dividingDate) throw refuse(`apply a credit to or remove one from a ${DOC_LABEL[t.type].toLowerCase()}`, cur);
    }
    if (a.kind === 'journal' && a.op === 'apply') {
      for (const ref of [a.line, ...(a.chargeLine ? [a.chargeLine] : [])]) {
        const cur = await lineRefDay(ctx, ref);
        if (cur > copy.dividingDate) throw refuse('apply a journal entry credit to or from a journal entry line', cur);
      }
    }
    if (a.kind === 'journal' && a.op === 'unapply') {
      const cur = await journalApplicationDay(ctx, a.id);
      if (cur && cur > copy.dividingDate) throw refuse('remove a journal entry credit application', cur);
    }
  }
  for (const r of file.reconciliations) {
    if (r.op !== 'undo') continue;
    const cur = await currentRecordDay(ctx, 'reconciliation', r.id);
    if (cur && cur > copy.dividingDate) throw refuse('undo a reconciliation', cur);
  }
}

const sameVersion = (a: Date | null | undefined, b: string | null) =>
  !b || (a ? a.getTime() : null) === new Date(b).getTime();

const changedElsewhere = 'This record was changed in your file after the Accountant\'s Copy was made, so the accountant\'s version can\'t replace it safely.';

/**
 * Record locking for forms, names and items: the client's record still has the version it had
 * when the copy was made — or, when only a derived value moved that version (a payment applied to
 * the invoice after the dividing date, stock sold, a balance), the same substance digest.
 */
async function recordUnchanged(
  ctx: ServiceContext,
  type: DocType | NameType,
  id: string,
  baseVersion: string | null,
  baseDigest: string | null,
): Promise<'ok' | 'missing' | 'changed'> {
  const version =
    type === 'other_name' ? await otherNameVersion(ctx, id) : type === 'inventory_adjustment' ? null : await currentVersion(ctx, type, id);
  if (!version) return 'missing';
  if (!baseVersion || version.getTime() === new Date(baseVersion).getTime()) return 'ok';
  if (baseDigest && type !== 'inventory_adjustment') {
    const st = (await recordStates(ctx, type, [id])).get(id);
    if (st && st.digest === baseDigest) return 'ok';
  }
  return 'changed';
}

type NameEdit = Extract<NameChange, { op: 'edit' }>;

/** "phone, email" from payload keys. */
const fieldWords = (keys: string[]) => keys.map((k) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ');

/**
 * Record locking for a name / item edit, per field: it only conflicts when the client changed one
 * of the fields the accountant changed (the client editing the email does not block the
 * accountant's phone change). The field values the copy started from travel in the file (the
 * name's baseDigest), so this also catches a client change that did not move the record's
 * version (custom field values). Files without them compare the record's version / digest.
 */
async function nameEditCheck(ctx: ServiceContext, n: NameEdit): Promise<{ state: 'ok' | 'missing' | 'changed'; conflicts: string[] }> {
  const ok = { state: 'ok' as const, conflicts: [] };
  const version = n.type === 'other_name' ? await otherNameVersion(ctx, n.id) : await currentVersion(ctx, n.type, n.id);
  if (!version) return { state: 'missing', conflicts: [] };
  const st = (await recordStates(ctx, n.type, [n.id])).get(n.id);
  const clientChanged = changedNameFields(n.type, n.baseDigest, st?.digest);
  if (clientChanged) {
    if (!n.fields) return clientChanged.length ? { state: 'changed', conflicts: [] } : ok;
    const conflicts = n.fields.filter((k) => clientChanged.includes(k));
    return conflicts.length ? { state: 'changed', conflicts } : ok;
  }
  if (!n.baseVersion || version.getTime() === new Date(n.baseVersion).getTime()) return ok;
  if (st && n.baseDigest && st.digest === n.baseDigest) return ok;
  return { state: 'changed', conflicts: [] };
}

function nameConflictText(n: NameEdit, conflicts: string[]): string {
  const what = NAME_LABEL[n.type].toLowerCase();
  return conflicts.length
    ? `You also changed this ${what}'s ${fieldWords(conflicts)} in your file after the Accountant's Copy was made. Tick "Keep mine" to keep your version of ${conflicts.length === 1 ? 'that field' : 'those fields'} (the accountant's other changes to it are still applied), or ask your accountant.`
    : `${changedElsewhere} Tick "Keep mine" to keep your version of this ${what} (the accountant's change to it is skipped), or ask your accountant.`;
}

/** The part of a name edit the import applies: the accountant's changed fields (less the ones you keep). */
function nameEditPayload(n: NameEdit, keep: Set<string> | 'all' | undefined): Record<string, unknown> | null {
  if (keep === 'all') return null;
  if (!n.fields) return n.after;
  const keys = n.fields.filter((k) => !keep?.has(k));
  if (!keys.length) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in n.after) out[k] = n.after[k];
  return out;
}

/** A list record of that type and name already exists (names are unique per list). */
async function nameTaken(ctx: ServiceContext, type: NameType, name: string): Promise<boolean> {
  const { table } = NAME_COLUMNS[type];
  const col = type === 'customer' || type === 'vendor' ? 'display_name' : 'name';
  const res = await ctx.db.execute(
    sql`SELECT 1 FROM ${sql.raw(table)} WHERE company_id = ${ctx.companyId}::uuid AND lower(${sql.raw(col)}) = lower(${name.trim()}) LIMIT 1`,
  );
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}

/** Document numbers the client already uses (a reused number is imported, but pointed out). */
/**
 * What the client's file would cost a form's inventory lines at now, against what the accountant's
 * file costed them (the changes file's line `cost` / a removal's `total`). Average-cost lines and
 * restocks are imported at the accountant's cost (inventoryCost.ts) — the note says what the
 * client's current average would have made it. FIFO sales and removals take the oldest stock left
 * in the client's file, so a difference there is what the client's books will show.
 */
export async function inventoryCostNote(ctx: ServiceContext, type: DocType, p: Record<string, unknown>): Promise<string | null> {
  type Ln = { itemId: string; qty: ReturnType<typeof Money.of>; cost: ReturnType<typeof Money.of>; consume: boolean };
  const lines: Ln[] = [];
  if (type === 'inventory_adjustment') {
    const q = Money.of(String(p.quantityChange ?? '0'));
    if (q.isNegative() && p.total != null) lines.push({ itemId: String(p.itemId), qty: q.abs(), cost: Money.of(String(p.total)), consume: true });
  } else if (type === 'invoice' || type === 'sales_receipt' || type === 'credit_memo') {
    for (const l of (p.lines as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!l.itemId || l.cost == null) continue;
      lines.push({ itemId: String(l.itemId), qty: Money.of(String(l.quantity ?? '1')), cost: Money.of(String(l.cost)), consume: type !== 'credit_memo' });
    }
  }
  if (!lines.length) return null;
  let keptTheirs = Money.zero();
  let keptOurs = Money.zero();
  let fifoTheirs = Money.zero();
  let fifoOurs = Money.zero();
  for (const l of lines) {
    const [item] = await ctx.db
      .select({ avg: itemsTable.averageCost })
      .from(itemsTable)
      .where(and(eq(itemsTable.companyId, ctx.companyId), eq(itemsTable.id, l.itemId)));
    if (!item) continue; // an item the accountant added: it has no history in this file yet
    const layers = (
      await ctx.db
        .select({ qty: inventoryLayers.quantityRemaining, unitCost: inventoryLayers.unitCost })
        .from(inventoryLayers)
        .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, l.itemId)))
        .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt))
    ).filter((x) => Money.of(x.qty).greaterThan(0));
    const fifo = layers.length > 0;
    if (fifo && l.consume) {
      let left = l.qty;
      let ours = Money.zero();
      for (const x of layers) {
        if (left.lessThanOrEqualTo(0)) break;
        const take = Money.of(x.qty).lessThan(left) ? Money.of(x.qty) : left;
        ours = ours.plus(Money.round2(take.times(Money.of(x.unitCost))));
        left = left.minus(take);
      }
      if (left.greaterThan(0)) continue; // not enough stock: the import itself will say so
      fifoTheirs = fifoTheirs.plus(l.cost);
      fifoOurs = fifoOurs.plus(ours);
    } else {
      const unit = fifo
        ? layers.reduce((v, x) => v.plus(Money.of(x.qty).times(Money.of(x.unitCost))), Money.zero()).dividedBy(
            layers.reduce((q, x) => q.plus(Money.of(x.qty)), Money.zero()),
          )
        : Money.of(item.avg ?? '0');
      keptTheirs = keptTheirs.plus(l.cost);
      keptOurs = keptOurs.plus(Money.round2(l.qty.times(unit)));
    }
  }
  const out: string[] = [];
  if (!keptTheirs.equals(keptOurs)) {
    out.push(
      `Inventory cost ${formatCurrency(toAmountString(keptTheirs))} is kept from your accountant's file (your current average cost would make it ${formatCurrency(toAmountString(keptOurs))}).`,
    );
  }
  if (!fifoTheirs.equals(fifoOurs)) {
    out.push(
      `Inventory cost will be ${formatCurrency(toAmountString(fifoOurs))} in your file vs ${formatCurrency(toAmountString(fifoTheirs))} in your accountant's: FIFO items are taken from the oldest stock left in your file.`,
    );
  }
  return out.length ? out.join(' ') : null;
}

async function numberTaken(ctx: ServiceContext, type: DocType, p: Record<string, unknown>): Promise<boolean> {
  const spec: Partial<Record<DocType, [string, string, string]>> = {
    invoice: ['invoices', 'ref_number', 'refNumber'],
    sales_receipt: ['sales_receipts', 'ref_number', 'refNumber'],
    credit_memo: ['credit_memos', 'ref_number', 'refNumber'],
    estimate: ['estimates', 'ref_number', 'refNumber'],
    sales_order: ['sales_orders', 'ref_number', 'refNumber'],
    purchase_order: ['purchase_orders', 'ref_number', 'refNumber'],
  };
  const s = spec[type];
  const v = s ? p[s[2]] : null;
  if (!s || typeof v !== 'string' || !v) return false;
  const res = await ctx.db.execute(
    sql`SELECT 1 FROM ${sql.raw(s[0])} WHERE company_id = ${ctx.companyId}::uuid AND ${sql.raw(s[1])} = ${v} LIMIT 1`,
  );
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}

/** Build the plain-language review of a changes file (nothing is changed). */
export async function reviewChangesFile(ctx: ServiceContext, buffer: Buffer): Promise<ChangesReview> {
  const file = parseChangesFile(buffer);
  const copy = await matchCopy(ctx, file);
  await assertChangesWithinDividingDate(ctx, file, copy);
  const m = await nameMaps(ctx, file);
  const labelMaps = await loadLabelMaps(ctx);
  addFileLabels(labelMaps, file);
  const L = labelsOf(labelMaps);
  const closingDate = await getClosingDate(ctx);
  const items: ReviewItem[] = [];
  const counts = { added: 0, changed: 0, voided: 0, lists: 0, applications: 0, reconciliations: 0 };
  let needsClosingPassword = false;
  const touchesClosed = (d: string | null | undefined) => {
    if (d && closingDate && day(d) <= closingDate) needsClosingPassword = true;
  };
  const afterDividing = 'This change is dated after the dividing date and will not be imported.';

  const existingCodes = new Set([...(await ctx.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.companyId, ctx.companyId)))].map((r) => r.code));
  for (const a of file.accounts) {
    counts.lists++;
    if (a.op === 'add') {
      items.push({
        key: `account:${a.id}`,
        group: 'account',
        op: 'add',
        kind: 'Account',
        date: null,
        title: `New account ${a.after.code} · ${a.after.name}`,
        amount: null,
        before: null,
        after: [`${a.after.code} · ${a.after.name}`, `Type: ${a.after.qbType.replace(/_/g, ' ')}`, ...(a.after.description ? [a.after.description] : [])],
        problem: existingCodes.has(a.after.code) ? `Your file already has an account numbered ${a.after.code}.` : null,
      });
    } else {
      const [cur] = await ctx.db.select().from(accounts).where(and(eq(accounts.id, a.id), eq(accounts.companyId, ctx.companyId)));
      const before = cur ? [`${cur.code} · ${cur.name}`, `Active: ${cur.isActive ? 'yes' : 'no'}`, ...(cur.description ? [cur.description] : [])] : null;
      items.push({
        key: `account:${a.id}`,
        group: 'account',
        op: 'edit',
        kind: 'Account',
        date: null,
        title: `Changed account ${a.after.code} · ${a.after.name}`,
        amount: null,
        before,
        after: [`${a.after.code} · ${a.after.name}`, `Active: ${a.after.isActive ? 'yes' : 'no'}`, ...(a.after.description ? [a.after.description] : [])],
        problem: !cur ? 'This account no longer exists in your file.' : !sameVersion(cur.editedAt, a.baseVersion) ? changedElsewhere : null,
      });
    }
  }
  for (const c of file.classes) {
    counts.lists++;
    items.push({ key: `class:${c.id}`, group: 'class', op: 'add', kind: 'Class', date: null, title: `New class ${c.name}`, amount: null, before: null, after: [c.name], problem: null });
  }

  // ---- Customers, vendors, items, other names ----
  for (const n of file.names) {
    counts.lists++;
    const d = describeName(n.type, n.after, L);
    if (n.op === 'add') {
      const label = String(n.after.displayName ?? n.after.name ?? '');
      items.push({
        key: `${n.type}:add:${n.id}`,
        group: 'name',
        op: 'add',
        kind: NAME_LABEL[n.type],
        date: null,
        title: `New ${d.title.charAt(0).toLowerCase()}${d.title.slice(1)}`,
        amount: null,
        before: null,
        after: d.lines,
        problem: (await nameTaken(ctx, n.type, label)) ? `Your file already has a ${NAME_LABEL[n.type].toLowerCase()} named "${label}".` : null,
      });
      continue;
    }
    const chk = await nameEditCheck(ctx, n);
    const before = chk.state === 'missing' ? null : await namePayload(ctx, n.type, n.id, true);
    const shown = nameEditPayload(n, undefined) ?? n.after;
    items.push({
      key: `${n.type}:edit:${n.id}`,
      group: 'name',
      op: 'edit',
      kind: NAME_LABEL[n.type],
      date: null,
      title: `Changed ${d.title.charAt(0).toLowerCase()}${d.title.slice(1)}`,
      amount: null,
      before: before ? describeName(n.type, before, L).lines : null,
      after: before ? nameEditSummary(before, shown) : d.lines,
      problem:
        chk.state === 'missing'
          ? `This ${NAME_LABEL[n.type].toLowerCase()} no longer exists in your file.`
          : chk.state === 'changed'
            ? nameConflictText(n, chk.conflicts)
            : null,
      ...(chk.state === 'changed' ? { keepable: true, conflictFields: chk.conflicts } : {}),
    });
  }

  for (const t of file.transactions) {
    const key = `${t.type}:${t.op}:${t.id}`;
    if (t.op === 'add') counts.added++;
    else if (t.op === 'edit') counts.changed++;
    else counts.voided++;
    const afterDate = t.op === 'void' ? null : t.after.date;
    let problem: string | null = null;
    if (afterDate && day(afterDate) > copy.dividingDate) problem = afterDividing;
    touchesClosed(afterDate);
    if (t.type === 'journal_entry') {
      const cur = t.op === 'add' ? null : await currentJournal(ctx, m, t.id);
      if (t.op !== 'add') {
        if (!cur) problem = 'This journal entry no longer exists in your file.';
        else if (cur.row.status !== 'posted') problem = 'This journal entry is already void in your file.';
        else if (!sameVersion(cur.row.updatedAt, t.baseVersion)) problem = changedElsewhere;
        if (cur) touchesClosed(cur.row.date.toISOString());
      }
      const kindTitle = t.op === 'add' ? 'New journal entry' : t.op === 'edit' ? 'Changed journal entry' : 'Voided journal entry';
      items.push({
        key,
        group: 'transaction',
        op: t.op,
        kind: 'Journal entry',
        date: afterDate ? day(afterDate) : cur ? day(cur.row.date) : null,
        title: `${kindTitle}${cur ? ` #${cur.row.entryNumber}` : ''}: ${t.op === 'void' ? cur?.row.description ?? '' : t.after.description}`,
        amount: t.op === 'void' ? cur?.total ?? null : journalTotal(t.after),
        before: cur?.text ?? null,
        after: t.op === 'void' ? null : [`${day(t.after.date)} — ${t.after.description}${t.after.isAdjusting ? ' (adjusting)' : ''}`, ...journalLines(m, t.after)],
        problem,
      });
    } else if (t.type === 'transfer') {
      const cur = t.op === 'add' ? null : await currentTransfer(ctx, m, t.id);
      if (t.op !== 'add') {
        if (!cur) problem = 'This transfer no longer exists in your file.';
        else if (cur.row.voidedAt) problem = 'This transfer is already void in your file.';
        else if (!sameVersion(cur.row.updatedAt, t.baseVersion)) problem = changedElsewhere;
        if (cur) touchesClosed(cur.row.date.toISOString());
      }
      const kindTitle = t.op === 'add' ? 'New transfer' : t.op === 'edit' ? 'Changed transfer' : 'Voided transfer';
      items.push({
        key,
        group: 'transaction',
        op: t.op,
        kind: 'Transfer',
        date: afterDate ? day(afterDate) : cur ? day(cur.row.date) : null,
        title: kindTitle,
        amount: t.op === 'void' ? (cur ? toAmountString(cur.row.amount) : null) : toAmountString(t.after.amount),
        before: cur?.text ?? null,
        after: t.op === 'void' ? null : [day(t.after.date), ...transferText(m, t.after)],
        problem,
      });
    } else if (t.type === 'deposit') {
      const cur = t.op === 'add' ? null : await currentDeposit(ctx, m, t.id);
      if (t.op !== 'add') {
        if (!cur) problem = 'This deposit no longer exists in your file.';
        else if (cur.row.voidedAt) problem = 'This deposit is already void in your file.';
        else if (!sameVersion(cur.row.updatedAt, t.baseVersion)) problem = changedElsewhere;
        if (cur) touchesClosed(cur.row.date.toISOString());
      }
      if (!problem && t.op !== 'void' && [...t.after.paymentIds, ...t.after.salesReceiptIds].some((x) => !m.docs.has(x))) {
        problem = 'This deposit holds a payment or sales receipt that is not in your file.';
      }
      const kindTitle = t.op === 'add' ? 'New deposit' : t.op === 'edit' ? 'Changed deposit' : 'Voided deposit';
      items.push({
        key,
        group: 'transaction',
        op: t.op,
        kind: 'Deposit',
        date: afterDate ? day(afterDate) : cur ? day(cur.row.date) : null,
        title: kindTitle,
        amount: t.op === 'void' ? (cur ? toAmountString(cur.row.total) : null) : toAmountString(t.after.total),
        before: cur?.text ?? null,
        after: t.op === 'void' ? null : [day(t.after.date), ...depositText(m, t.after)],
        problem,
      });
    } else {
      const cur = t.op === 'add' ? null : await currentExpense(ctx, m, t.id);
      if (t.op !== 'add') {
        if (!cur) problem = 'This check / expense no longer exists in your file.';
        else if (cur.row.voidedAt) problem = 'This check / expense is already void in your file.';
        else if (!sameVersion(cur.row.updatedAt, t.baseVersion)) problem = changedElsewhere;
        if (cur) touchesClosed(cur.row.date.toISOString());
      }
      const kindTitle = t.op === 'add' ? 'New check / expense' : t.op === 'edit' ? 'Changed check / expense' : 'Voided check / expense';
      items.push({
        key,
        group: 'transaction',
        op: t.op,
        kind: 'Check / expense',
        date: afterDate ? day(afterDate) : cur ? day(cur.row.date) : null,
        title: `${kindTitle}${t.op === 'void' ? '' : ` to ${t.after.vendorId ? m.names.get(t.after.vendorId) ?? L.name(t.after.vendorId) : t.after.payeeName ?? 'payee'}`}`,
        amount: t.op === 'void' ? (cur ? toAmountString(Money.abs(cur.row.total)) : null) : toAmountString(Money.abs(t.after.total)),
        before: cur?.text ?? null,
        after: t.op === 'void' ? null : [day(t.after.date), ...expenseLines(m, t.after)],
        problem,
      });
    }
  }

  // ---- Sales / purchase forms, payments, inventory adjustments ----
  for (const d of file.documents) {
    const label = DOC_LABEL[d.type];
    if (d.op === 'add') counts.added++;
    else if (d.op === 'edit') counts.changed++;
    else counts.voided++;
    let problem: string | null = null;
    let note: string | null = null;
    let before: string[] | null = null;
    let beforeAmount: string | null = null;
    let curDay: string | null = null;
    if (d.op !== 'add') {
      const state = await recordUnchanged(ctx, d.type, d.id, d.baseVersion, d.baseDigest);
      const st = d.type === 'inventory_adjustment' ? null : (await recordStates(ctx, d.type, [d.id])).get(d.id);
      if (state === 'missing') problem = `This ${label.toLowerCase()} no longer exists in your file.`;
      else if (st?.state === 'void') problem = `This ${label.toLowerCase()} is already void in your file.`;
      else if (state === 'changed') problem = changedElsewhere;
      if (state !== 'missing') {
        try {
          const x = describeDoc(d.type, await docPayload(ctx, d.type, d.id), L);
          before = x.lines;
          beforeAmount = x.amount;
        } catch {
          before = null;
        }
        curDay = st?.day ?? null;
        touchesClosed(curDay);
      }
    }
    const x = d.op === 'void' ? null : describeDoc(d.type, d.after, L);
    const afterDay = d.op === 'void' ? null : day(String(d.after.date));
    if (afterDay && afterDay > copy.dividingDate) problem = afterDividing;
    touchesClosed(afterDay);
    if (d.op === 'add' && (await numberTaken(ctx, d.type, d.after))) {
      note = `Your file already has a ${label.toLowerCase()} numbered ${String(d.after.refNumber)}; this one keeps the accountant's number.`;
    }
    const costNote = d.op === 'void' ? null : await inventoryCostNote(ctx, d.type, d.after);
    if (costNote) note = note ? `${note} ${costNote}` : costNote;
    const verb = d.op === 'add' ? 'New' : d.op === 'edit' ? 'Changed' : 'Voided';
    items.push({
      key: `${d.type}:${d.op}:${d.id}`,
      group: 'transaction',
      op: d.op,
      kind: label,
      date: afterDay ?? curDay,
      title: d.op === 'void' ? `${verb} ${label.toLowerCase()}: ${L.doc(d.id)}` : `${verb}: ${x!.title}`,
      amount: x?.amount ?? beforeAmount,
      before,
      after: x?.lines ?? null,
      problem,
      note,
    });
  }

  // ---- Applications ----
  for (const a of file.applications) {
    counts.applications++;
    const x = describeApplication(a, L);
    let problem: string | null = null;
    if (a.op === 'unapply' && a.kind === 'credit_memo') {
      const [row] = await ctx.db
        .select()
        .from(creditApplications)
        .where(and(eq(creditApplications.id, a.id), eq(creditApplications.companyId, ctx.companyId)));
      if (!row || !Money.of(row.amount).equals(Money.of(a.amount))) problem = 'That credit is no longer applied the same way in your file.';
    } else if (a.op === 'unapply' && a.kind === 'journal') {
      const [row] = await ctx.db
        .select({ id: journalItemApplications.id })
        .from(journalItemApplications)
        .where(and(eq(journalItemApplications.id, a.id), eq(journalItemApplications.companyId, ctx.companyId)));
      if (!row) problem = 'That journal entry credit is no longer applied in your file.';
    }
    items.push({
      key: applicationKey(a),
      group: 'application',
      op: a.op,
      kind: 'Application',
      date: day(a.date),
      title: x.title,
      amount: toAmountString(a.amount),
      before: null,
      after: x.lines,
      problem,
    });
  }

  // ---- Reconciliations ----
  const undoneInFile = new Set<string>();
  for (const r of file.reconciliations) {
    counts.reconciliations++;
    const x = describeReconciliation(r, L);
    let problem: string | null = null;
    if (day(r.statementDate) > copy.dividingDate) problem = afterDividing;
    // The client's own later reconciliations (after the dividing date) that sit on top of it.
    problem ??= await reconciliationBlocker(ctx, r, { mapId: (id) => id, undoneInFile, accountLabel: L.account(r.accountId) });
    if (r.op === 'undo') {
      const [latest] = await ctx.db
        .select({ id: reconciliations.id })
        .from(reconciliations)
        .innerJoin(bankAccounts, eq(bankAccounts.id, reconciliations.bankAccountId))
        .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.accountId, r.accountId), eq(reconciliations.status, 'completed')))
        .orderBy(desc(reconciliations.completedAt))
        .limit(1);
      if (!latest || latest.id !== r.id) {
        // An earlier undo in the same file may make it the last one; only a missing statement is a problem.
        const [exists] = await ctx.db
          .select({ id: reconciliations.id, status: reconciliations.status })
          .from(reconciliations)
          .where(eq(reconciliations.id, r.id));
        if (!exists || exists.status !== 'completed') problem = 'That reconciliation is no longer in your file (it was undone or changed).';
      }
      undoneInFile.add(r.id);
    }
    items.push({
      key: `reconciliation:${r.op}:${r.id}`,
      group: 'reconciliation',
      op: r.op,
      kind: 'Reconciliation',
      date: day(r.statementDate),
      title: x.title,
      amount: toAmountString(r.statementBalance),
      before: null,
      after: x.lines,
      problem,
    });
  }

  // The client's own work after the dividing date that the import would refuse to undo
  // (reconciled lines, later payments / credits / deposits, balances already used).
  const conflicts = await clientWorkConflicts(ctx, file, copy, L);
  for (const it of items) {
    if (!it.problem && conflicts.has(it.key)) it.problem = conflicts.get(it.key)!;
  }

  return {
    companyName: file.companyName,
    dividingDate: file.dividingDate,
    preparedBy: file.preparedBy,
    createdAt: file.createdAt,
    note: file.note,
    warnings: file.warnings,
    items,
    counts,
    canImport: items.every((i) => !i.problem),
    canImportKeepingMine: items.every((i) => !i.problem || i.keepable),
    closingDate,
    needsClosingPassword,
    formatVersion: file.formatVersion,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  copy: ReturnType<typeof publicCopy>;
  applied: {
    accounts: number;
    classes: number;
    names: number;
    added: number;
    changed: number;
    voided: number;
    applications: number;
    reconciliations: number;
  };
  note: string | null;
  /** Name / item changes where you kept your version (all of it, or the fields you both changed). */
  keptYours: string[];
  trialBalance: { totalDebit: string; totalCredit: string; balanced: boolean };
}

export interface ImportOptions {
  /**
   * Review keys (`customer:edit:<id>`, ...) of names / items both sides changed where you keep your
   * version: of the fields you both changed when the file says which ones, else of the record.
   */
  keepMine?: string[];
}

const toDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00.000Z` : iso);
  if (isNaN(d.getTime())) throw validation(`The changes file has an invalid date (${iso}).`);
  return d;
};

function describeTxn(t: TxnChange): string {
  const what = KIND_LABEL[t.type];
  const verb = t.op === 'add' ? 'new' : t.op === 'edit' ? 'changed' : 'voided';
  const date = t.op === 'void' ? '' : ` dated ${day(t.after.date)}`;
  return `${verb} ${what}${date}`;
}

/**
 * An accountant's inventory cost may only value an inventory item's stock (parseChangesFile has
 * already refused negative costs and costs on lines that neither sell nor restock).
 */
async function assertInventoryCostItems(ctx: ServiceContext, costs: Array<{ itemId: string }>): Promise<void> {
  const ids = [...new Set(costs.map((c) => c.itemId))];
  if (!ids.length) return;
  const rows = await ctx.db
    .select({ id: itemsTable.id, name: itemsTable.name, type: itemsTable.type })
    .from(itemsTable)
    .where(and(eq(itemsTable.companyId, ctx.companyId), inArray(itemsTable.id, ids)));
  for (const id of ids) {
    const it = rows.find((r) => r.id === id);
    if (!it) throw validation('A line carries an inventory cost for an item that is not in your file.');
    if (it.type !== 'inventory') {
      throw validation(`A line carries an inventory cost for "${it.name}", which is not an inventory item.`);
    }
  }
}

/** One unit of the import: applied in its own savepoint so a refused step leaves nothing behind. */
interface Step {
  label: string;
  /** 'skipped': nothing to apply (you kept your version), not counted. */
  run: (c: ServiceContext) => Promise<void | 'skipped'>;
  count: keyof ImportResult['applied'];
}

/** Apply the accountant's changes, then lift the Accountant's Copy restriction. */
export async function importChangesFile(ctx: ServiceContext, buffer: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
  const keepMine = new Set(opts.keepMine ?? []);
  assertOwnerOrAdmin(ctx, "import an accountant's changes");
  const file = parseChangesFile(buffer);
  const copy = await matchCopy(ctx, file);
  const late = (what: string) =>
    validation(`The changes file contains a ${what}, after the dividing date (${formatDividingDate(copy.dividingDate)}). Nothing was imported.`);
  for (const t of file.transactions) {
    if (t.op !== 'void' && day(t.after.date) > copy.dividingDate) throw late(describeTxn(t));
  }
  for (const d of file.documents) {
    if (d.op !== 'void' && day(String(d.after.date)) > copy.dividingDate) {
      throw late(`${d.op === 'add' ? 'new' : 'changed'} ${DOC_LABEL[d.type].toLowerCase()} dated ${day(String(d.after.date))}`);
    }
  }
  for (const r of file.reconciliations) {
    if (day(r.statementDate) > copy.dividingDate) throw late(`reconciliation of a statement dated ${day(r.statementDate)}`);
  }

  await assertChangesWithinDividingDate(ctx, file, copy);

  return runAccountantImport(copy.id, () =>
    inTransaction(ctx, async (tx) => {
      // Again inside the import's transaction, where the dividing-date lock is lifted.
      await assertChangesWithinDividingDate(tx, file, copy);
      const idMap: IdMap = new Map<string, string>();
      const mapId = <T extends string | null | undefined>(id: T): T => (id ? ((idMap.get(id) ?? id) as T) : id);
      const lineMap: LineMap = new Map<string, string>();
      const applied: ImportResult['applied'] = { accounts: 0, classes: 0, names: 0, added: 0, changed: 0, voided: 0, applications: 0, reconciliations: 0 };
      const labelMaps = await loadLabelMaps(tx);
      addFileLabels(labelMaps, file);
      const L = labelsOf(labelMaps);
      const helpers = (c: ServiceContext) => ({
        mapId: (id: string) => idMap.get(id) ?? id,
        toDate,
        line: async (ref: LineRef) => {
          const id = await resolveLineRef(c, ref, idMap, lineMap);
          // Backstop for the dividing-date check: never land on a line of the client's later work.
          const lineDay = await journalLineDay(c, id);
          if (lineDay && lineDay > copy.dividingDate) {
            throw new ServiceError(
              'CONFLICT',
              `The journal line it refers to is in a transaction of yours dated ${lineDay}, after the dividing date (${formatDividingDate(copy.dividingDate)}).`,
            );
          }
          return id;
        },
      });

      const wrap = (label: string, thrown: unknown): unknown => {
        if (!(thrown instanceof ServiceError)) return thrown;
        let err: ServiceError = thrown;
        // Name payments / sales receipts by label, never by id.
        const used = (err.details as { alreadyDeposited?: unknown } | undefined)?.alreadyDeposited;
        if (Array.isArray(used) && used.length) {
          const names = used.map((id) => L.doc(id));
          const one = names.length === 1;
          err = new ServiceError(
            err.code,
            `Your ${joinWords(names)} ${one ? 'is' : 'are'} already in one of your deposits, so this deposit can't hold ${one ? 'it' : 'them'} too. ` +
              `Remove ${one ? 'it' : 'them'} from your deposit (or void that deposit), then import again — or ask your accountant to take ${one ? 'it' : 'them'} out of this deposit.`,
          );
        }
        // A record-locking conflict is explained in the message; drop its details so the app's
        // "record changed - reload" dialog does not appear for a whole-file import.
        const stale = Boolean((err.details as { staleVersion?: unknown } | undefined)?.staleVersion);
        return new ServiceError(err.code, `Could not import the ${label}: ${err.message} Nothing was imported.`, stale ? { accountantCopyImport: true } : err.details);
      };

      // 0. Record locking, before anything is applied: every form, name and item the file edits or
      //    voids must still be what the accountant started from (same version, or — when only a
      //    derived value such as an applied payment moved it — the same substance).
      //    Names / items are checked per field; where both sides changed the same field you may
      //    keep yours (opts.keepMine).
      const nameKeep = new Map<string, Set<string> | 'all'>();
      const keptYours: string[] = [];
      for (const n of file.names) {
        if (n.op !== 'edit') continue;
        const chk = await nameEditCheck(tx, n);
        if (chk.state === 'ok') continue;
        const label = `change to ${NAME_LABEL[n.type].toLowerCase()} ${String(n.after.displayName ?? n.after.name ?? '')}`;
        if (chk.state === 'changed' && keepMine.has(`${n.type}:edit:${n.id}`)) {
          const partial = chk.conflicts.length > 0 && Boolean(n.fields);
          nameKeep.set(n.id, partial ? new Set(chk.conflicts) : 'all');
          keptYours.push(`${NAME_LABEL[n.type]} ${String(n.after.displayName ?? n.after.name ?? '')}: kept your ${partial ? fieldWords(chk.conflicts) : 'version'}`);
          continue;
        }
        throw wrap(
          label,
          new ServiceError(
            chk.state === 'missing' ? 'NOT_FOUND' : 'CONFLICT',
            chk.state === 'missing' ? 'It no longer exists in your file.' : nameConflictText(n, chk.conflicts),
          ),
        );
      }
      for (const d of file.documents) {
        if (d.op === 'add') continue;
        const state = await recordUnchanged(tx, d.type, d.id, d.baseVersion, d.baseDigest);
        if (state !== 'ok') {
          const label = `${d.op === 'void' ? 'void of' : 'change to'} ${L.doc(d.id) === '(a form not in this file)' ? DOC_LABEL[d.type].toLowerCase() : L.doc(d.id)}`;
          throw wrap(label, new ServiceError(state === 'missing' ? 'NOT_FOUND' : 'CONFLICT', state === 'missing' ? 'It no longer exists in your file.' : changedElsewhere));
        }
      }
      /** Run `fn` under the record-locking version check while the record still has its base version. */
      const locked = async (c: ServiceContext, entity: VersionedEntity, id: string, baseVersion: string | null, fn: (c: ServiceContext) => Promise<unknown>) => {
        const v = await currentVersion(c, entity, id);
        if (baseVersion && v && v.getTime() === new Date(baseVersion).getTime()) {
          await withVersionCheck(c, entity, id, baseVersion, fn);
        } else {
          await fn(c);
        }
      };

      const steps: Step[] = [];

      // 1. Chart of accounts (new accounts first, parents before children), then classes.
      const accountsOrdered: AccountChange[] = [...file.accounts.filter((a) => a.op === 'add'), ...file.accounts.filter((a) => a.op === 'edit')];
      for (const a of accountsOrdered) {
        if (a.op === 'add') {
          steps.push({
            label: `new account ${a.after.code} · ${a.after.name}`,
            count: 'accounts',
            run: async (c) => {
              const created = await createAccount(c, {
                code: a.after.code,
                name: a.after.name,
                qbType: a.after.qbType,
                subtype: a.after.subtype,
                parentId: mapId(a.after.parentId),
                description: a.after.description,
                taxLine: a.after.taxLine,
              });
              idMap.set(a.id, created.id);
              if (!a.after.isActive) await updateAccount(c, created.id, { isActive: false });
            },
          });
        } else {
          steps.push({
            label: `change to account ${a.after.code} · ${a.after.name}`,
            count: 'accounts',
            run: async (c) => {
              await withVersionCheck(c, 'account', a.id, a.baseVersion, (cc) =>
                updateAccount(cc, a.id, {
                  name: a.after.name,
                  qbType: a.after.qbType,
                  subtype: a.after.subtype,
                  parentId: mapId(a.after.parentId),
                  description: a.after.description,
                  taxLine: a.after.taxLine,
                  isActive: a.after.isActive,
                }),
              );
            },
          });
        }
      }
      for (const k of file.classes) {
        steps.push({
          label: `new class ${k.name}`,
          count: 'classes',
          run: async (c) => {
            const row = await createClass(c, { name: k.name, parentId: mapId(k.parentId) });
            idMap.set(k.id, row.id);
          },
        });
      }

      // 2. Customers, vendors, other names, items: new ones (parents first), then edits.
      for (const n of [...file.names.filter((x) => x.op === 'add'), ...file.names.filter((x) => x.op === 'edit')]) {
        const label = String(n.after.displayName ?? n.after.name ?? '');
        steps.push({
          label: `${n.op === 'add' ? 'new' : 'change to'} ${NAME_LABEL[n.type].toLowerCase()} ${label}`,
          count: 'names',
          run: async (c) => {
            if (n.op === 'add') {
              const created = await decodePayload(n.after, NAME_SHAPES[n.type], helpers(c));
              idMap.set(n.id, await createName(c, n.type, created));
              return;
            }
            // Only the fields the accountant changed (less the ones you keep).
            const part = nameEditPayload(n, nameKeep.get(n.id));
            if (!part) return 'skipped';
            const input = await decodePayload(part, NAME_SHAPES[n.type], helpers(c));
            if (n.type === 'other_name') {
              await updateName(c, n.type, n.id, input);
              return;
            }
            await locked(c, n.type, n.id, n.baseVersion, (cc) => updateName(cc, n.type as NameType, n.id, input));
          },
        });
      }

      // 3. Undo Last Reconciliation (before the transactions it cleared are changed).
      for (const r of file.reconciliations.filter((x) => x.op === 'undo')) {
        const x = describeReconciliation(r, L);
        steps.push({ label: x.title.charAt(0).toLowerCase() + x.title.slice(1), count: 'reconciliations', run: (c) => applyReconciliation(c, r, helpers(c)) });
      }

      // 4. Removals: credits taken off, then voids (deposits before the payments they hold, payments
      //    before the forms they pay).
      for (const a of file.applications.filter((x) => x.op === 'unapply')) {
        const x = describeApplication(a, L);
        steps.push({ label: `application "${x.title}"`, count: 'applications', run: (c) => applyApplication(c, a, helpers(c)) });
      }
      const docLabel = (d: DocChange) => {
        if (d.op === 'void') return `void of ${L.doc(d.id) === '(a form not in this file)' ? DOC_LABEL[d.type].toLowerCase() : L.doc(d.id)}`;
        const x = describeDoc(d.type, d.after, L);
        return `${d.op === 'add' ? 'new' : 'changed'} ${x.title.charAt(0).toLowerCase()}${x.title.slice(1)}`;
      };
      const txnVoids = file.transactions.filter((t) => t.op === 'void');
      const voidRank = (t: string) => (t === 'deposit' ? 0 : t === 'payment_received' || t === 'bill_payment' ? 1 : 2);
      const removals: Array<{ rank: number; step: Step }> = [];
      for (const t of txnVoids) removals.push({ rank: voidRank(t.type), step: txnStep(t) });
      for (const d of file.documents.filter((x) => x.op === 'void')) {
        removals.push({
          rank: voidRank(d.type),
          step: {
            label: docLabel(d),
            count: 'voided',
            run: async (c) => {
              if (d.type === 'inventory_adjustment') throw validation('An inventory adjustment can only be added.');
              await locked(c, d.type, d.id, d.baseVersion, (cc) => voidDoc(cc, d.type, d.id));
            },
          },
        });
      }
      removals.sort((a, b) => a.rank - b.rank);
      steps.push(...removals.map((r) => r.step));

      // 5. Forms: edits, then new ones (orders before the forms that use them), oldest first; the
      //    General Journal entries, checks and transfers with them.
      const docRank = (t: DocType) => DOC_ORDER.indexOf(t);
      const byDate = <T extends { after: object }>(a: T, b: T) =>
        String((a.after as { date?: unknown }).date).localeCompare(String((b.after as { date?: unknown }).date));
      const editsAndAdds = (op: 'edit' | 'add', payments: boolean) =>
        file.documents
          .filter((d): d is Extract<DocChange, { op: 'edit' | 'add' }> => d.op === op && (d.type === 'payment_received' || d.type === 'bill_payment') === payments)
          .sort((a, b) => docRank(a.type) - docRank(b.type) || byDate(a, b));
      const docStep = (d: Extract<DocChange, { op: 'edit' | 'add' }>): Step => ({
        label: docLabel(d),
        count: d.op === 'add' ? 'added' : 'changed',
        run: async (c) => {
          const input = await decodePayload(d.after, DOC_SHAPES[d.type], helpers(c));
          // Inventory lines are costed as the accountant's file costed them (inventoryCost.ts).
          const costs = accountantCostsOf(d.type, input);
          await assertInventoryCostItems(c, costs);
          await withAccountantCosts(costs, async () => {
            if (d.op === 'add') {
              idMap.set(d.id, await createDoc(c, d.type, input));
            } else {
              await locked(c, d.type as VersionedEntity, d.id, d.baseVersion, (cc) => updateDoc(cc, d.type, d.id, input));
            }
            // Estimate lines made in the copy → the client's new lines (an invoice may bill them).
            if (d.type === 'estimate') await mapEstimateLines(c, mapId(d.id), (d.after.lines as Array<Record<string, unknown>>) ?? [], idMap);
          });
        },
      });
      const txnOf = (op: 'edit' | 'add', types: TxnType[]) =>
        file.transactions
          .filter((t): t is Extract<TxnChange, { op: 'edit' | 'add' }> => t.op === op && types.includes(t.type))
          .sort(byDate);
      // New estimates / sales orders / purchase orders first (they post nothing, and a changed
      // invoice may bill a line of an estimate made in the copy).
      const nonPosting = (d: DocChange) => d.type === 'estimate' || d.type === 'sales_order' || d.type === 'purchase_order';
      for (const d of editsAndAdds('add', false).filter(nonPosting)) steps.push(docStep(d));
      for (const d of editsAndAdds('edit', false)) steps.push(docStep(d));
      for (const t of txnOf('edit', ['journal_entry', 'expense', 'transfer'])) steps.push(txnStep(t));
      for (const d of editsAndAdds('add', false).filter((d) => !nonPosting(d))) steps.push(docStep(d));
      for (const t of txnOf('add', ['journal_entry', 'expense', 'transfer'])) steps.push(txnStep(t));

      // 6. Payments (received / bill payments) — they apply to the forms above.
      for (const d of editsAndAdds('edit', true)) steps.push(docStep(d));
      for (const d of editsAndAdds('add', true)) steps.push(docStep(d));

      // 7. Credits applied outside a payment.
      for (const a of file.applications.filter((x) => x.op === 'apply')) {
        const x = describeApplication(a, L);
        steps.push({ label: `application "${x.title}"`, count: 'applications', run: (c) => applyApplication(c, a, helpers(c)) });
      }

      // 8. Deposits (they hold the payments above).
      for (const t of [...txnOf('edit', ['deposit']), ...txnOf('add', ['deposit'])]) steps.push(txnStep(t));

      // 9. Reconciliations (the cleared transactions all exist now).
      for (const r of file.reconciliations.filter((x) => x.op === 'reconcile')) {
        const x = describeReconciliation(r, L);
        steps.push({ label: x.title.charAt(0).toLowerCase() + x.title.slice(1), count: 'reconciliations', run: (c) => applyReconciliation(c, r, helpers(c)) });
      }

      function txnStep(t: TxnChange): Step {
        return {
          label: describeTxn(t),
          count: t.op === 'add' ? 'added' : t.op === 'edit' ? 'changed' : 'voided',
          run: async (c) => {
            if (t.type === 'journal_entry') {
              if (t.op === 'add') {
                const e = await createManualEntry(c, journalInput(t.after));
                idMap.set(t.id, e.id);
                if (t.after.postedId) idMap.set(t.after.postedId, e.id);
              } else if (t.op === 'edit') {
                const after = t.after;
                const e = await withVersionCheck(c, 'journal_entry', t.id, t.baseVersion, (cc) => updateEntry(cc, t.id, journalInput(after)));
                if (after.postedId && e?.id) idMap.set(after.postedId, e.id);
              } else await withVersionCheck(c, 'journal_entry', t.id, t.baseVersion, (cc) => voidEntry(cc, t.id));
            } else if (t.type === 'transfer') {
              if (t.op === 'add') {
                const row = await createTransfer(c, transferInput(t.after));
                idMap.set(t.id, row.id);
                if (t.after.postedEntryId && row.postedEntryId) idMap.set(t.after.postedEntryId, row.postedEntryId);
              } else if (t.op === 'edit') {
                const after = t.after;
                const row = await withVersionCheck(c, 'transfer', t.id, t.baseVersion, (cc) => updateTransfer(cc, t.id, transferInput(after)));
                if (after.postedEntryId && row?.postedEntryId) idMap.set(after.postedEntryId, row.postedEntryId);
              } else await withVersionCheck(c, 'transfer', t.id, t.baseVersion, (cc) => voidTransfer(cc, t.id));
            } else if (t.type === 'deposit') {
              if (t.op === 'add') idMap.set(t.id, (await createDeposit(c, depositInput(t.after))).id);
              else if (t.op === 'edit') {
                const after = t.after;
                await withVersionCheck(c, 'deposit', t.id, t.baseVersion, (cc) => updateDeposit(cc, t.id, depositInput(after)));
              } else await withVersionCheck(c, 'deposit', t.id, t.baseVersion, (cc) => voidDeposit(cc, t.id));
            } else {
              if (t.op === 'add') idMap.set(t.id, (await createExpense(c, expenseInput(t.after))).id);
              else if (t.op === 'edit') {
                const after = t.after;
                await withVersionCheck(c, 'expense', t.id, t.baseVersion, (cc) => updateExpense(cc, t.id, expenseInput(after)));
              } else await withVersionCheck(c, 'expense', t.id, t.baseVersion, (cc) => voidExpense(cc, t.id));
            }
          },
        };
      }

      function journalInput(p: JournalPayload) {
        return {
          date: toDate(p.date),
          description: p.description,
          reference: p.reference,
          isAdjusting: p.isAdjusting,
          lines: p.lines.map(
            (l): PostingLine => ({
              accountId: mapId(l.accountId),
              debit: l.debit,
              credit: l.credit,
              memo: l.memo,
              classId: mapId(l.classId),
              entityType: l.entityType,
              entityId: mapId(l.entityId),
            }),
          ),
        };
      }
      function expenseInput(p: ExpensePayload): CreateExpenseInput {
        return {
          vendorId: mapId(p.vendorId),
          payeeName: p.payeeName,
          date: toDate(p.date),
          method: p.method as ExpenseMethod,
          reference: p.reference,
          paymentAccountId: mapId(p.paymentAccountId),
          memo: p.memo,
          toPrint: p.toPrint,
          isRefund: p.isRefund,
          currency: p.currency,
          exchangeRate: p.exchangeRate,
          lines: p.lines.map((l) => ({
            accountId: mapId(l.accountId),
            itemId: mapId(l.itemId),
            quantity: l.quantity,
            unitCost: l.unitCost,
            description: l.description,
            amount: l.amount,
            classId: mapId(l.classId),
            customerId: mapId(l.customerId),
            jobId: l.jobId,
            ...(l.siteId !== undefined ? { siteId: l.siteId } : {}),
            ...(l.binId !== undefined ? { binId: l.binId } : {}),
            ...(l.serialNumbers !== undefined ? { serialNumbers: l.serialNumbers } : {}),
            ...(l.lotNumber !== undefined ? { lotNumber: l.lotNumber } : {}),
            ...(l.lotExpiration !== undefined ? { lotExpiration: l.lotExpiration ? toDate(l.lotExpiration) : null } : {}),
          })),
        };
      }
      function transferInput(p: TransferPayload): CreateTransferInput {
        return {
          date: toDate(p.date),
          fromAccountId: mapId(p.fromAccountId),
          toAccountId: mapId(p.toAccountId),
          amount: p.amount,
          memo: p.memo,
          toAmount: p.toAmount,
          homeAmount: p.homeAmount,
        };
      }
      function depositInput(p: DepositPayload): CreateDepositInput {
        return {
          date: toDate(p.date),
          depositAccountId: mapId(p.depositAccountId),
          memo: p.memo,
          exchangeRate: p.exchangeRate,
          paymentIds: p.paymentIds.map((x) => mapId(x)),
          salesReceiptIds: p.salesReceiptIds.map((x) => mapId(x)),
          extraLines: p.extraLines.map((l) => ({ accountId: mapId(l.accountId), amount: l.amount, description: l.description })),
          cashBack: p.cashBack ? { accountId: mapId(p.cashBack.accountId), amount: p.cashBack.amount, memo: p.cashBack.memo } : null,
        };
      }

      // The client's own work after the dividing date the steps would run into: refuse up front, in
      // the review's words (the client's record and the way out), before anything is applied.
      const conflicts = await clientWorkConflicts(tx, file, copy, L);
      if (conflicts.size) {
        const stepLabel = new Map<string, string>();
        for (const t of file.transactions) stepLabel.set(`${t.type}:${t.op}:${t.id}`, describeTxn(t));
        for (const d of file.documents) stepLabel.set(`${d.type}:${d.op}:${d.id}`, docLabel(d));
        for (const a of file.applications) stepLabel.set(applicationKey(a), `application "${describeApplication(a, L).title}"`);
        const [key, text] = [...conflicts][0];
        throw wrap(stepLabel.get(key) ?? 'change', new ServiceError('CONFLICT', text));
      }

      // Run the steps in that order. A step refused because something it depends on comes later in
      // the file (a form voided only after the credit taken off it, …) is retried after the others;
      // when a pass makes no progress, the first refused step's error names the change.
      let pending = steps;
      const lastError = new Map<Step, unknown>();
      while (pending.length) {
        const refused: Step[] = [];
        for (const st of pending) {
          const lines = new Map(lineMap);
          const ids = new Map(idMap);
          try {
            const r = await inTransaction(tx, (sp) => st.run(sp));
            if (r !== 'skipped') applied[st.count]++;
          } catch (err) {
            lineMap.clear();
            for (const [k, v] of lines) lineMap.set(k, v);
            idMap.clear();
            for (const [k, v] of ids) idMap.set(k, v);
            refused.push(st);
            lastError.set(st, err);
          }
        }
        if (refused.length === pending.length) {
          const first = refused[0];
          throw wrap(first.label, lastError.get(first));
        }
        pending = refused;
      }

      // 10. The books must still balance (the database guards also check every entry at COMMIT).
      const tb = await trialBalance(tx);
      if (!tb.balanced) {
        throw new ServiceError('UNBALANCED', "The accountant's changes would leave the books out of balance. Nothing was imported.");
      }

      // 11. Lift the restriction.
      const [done] = await tx.db
        .update(accountantCopies)
        .set({
          status: 'imported',
          importedAt: new Date(),
          importedBy: tx.userId,
          accountantNote: file.note,
          result: { applied, preparedBy: file.preparedBy, fileCreatedAt: file.createdAt, warnings: file.warnings, keptYours },
          updatedAt: new Date(),
        })
        .where(and(eq(accountantCopies.id, copy.id), eq(accountantCopies.status, 'outstanding')))
        .returning();
      if (!done) throw new ServiceError('CONFLICT', "This Accountant's Copy was already imported or cancelled.");
      await writeAudit(tx, {
        action: 'update',
        entityType: 'accountant_copy',
        entityId: copy.id,
        oldValues: { status: 'outstanding' },
        newValues: { status: 'imported', applied, note: file.note, ...(keptYours.length ? { keptYours } : {}) },
      });
      return {
        copy: publicCopy(done),
        applied,
        note: file.note,
        keptYours,
        trialBalance: { totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, balanced: tb.balanced },
      };
    }),
  );
}
