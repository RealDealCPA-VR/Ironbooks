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
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  accountantCopies,
  accounts,
  classes,
  companies,
  customers,
  deposits,
  employees,
  expenses,
  journalEntries,
  journalEntryLines,
  otherNames,
  paymentsReceived,
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
import { withVersionCheck } from '../concurrency';
import { createPortableCompanyFile } from '../portableFile';
import { trialBalance } from '../reports';
import { getClosingDateSettings } from '../company';
import {
  TRANSFER_ENTRY,
  TRANSFER_EXTENSION,
  type AccountChange,
  type ChangesFile,
  type DepositPayload,
  type ExpensePayload,
  type JournalPayload,
  type TransferManifest,
  type TransferPayload,
  type TxnChange,
  type TxnType,
  parseChangesFile,
  safeCompanyName,
} from './format';
import { formatDividingDate, runAccountantImport } from './guard';

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
  group: 'account' | 'class' | 'transaction';
  op: 'add' | 'edit' | 'void';
  kind: string;
  date: string | null;
  title: string;
  amount: string | null;
  /** What this file has now (edits / voids). */
  before: string[] | null;
  /** What the accountant's version says (adds / edits). */
  after: string[] | null;
  problem: string | null;
}

export interface ChangesReview {
  companyName: string;
  dividingDate: string;
  preparedBy: string | null;
  createdAt: string;
  note: string | null;
  warnings: string[];
  items: ReviewItem[];
  counts: { added: number; changed: number; voided: number; lists: number };
  canImport: boolean;
  closingDate: string | null;
  /** True when some change is dated on/before the closing date (the closing-date password is needed). */
  needsClosingPassword: boolean;
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
  for (const [id, customerId, text] of docCustomers) {
    docs.set(id, `${text}${customerId && names.has(customerId) ? ` (${names.get(customerId)})` : ''}`);
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
  const head = `${p.method === 'credit_card' ? 'Card charge' : p.method === 'cash' ? 'Cash expense' : 'Check'}${p.reference ? ` #${p.reference}` : ''} from ${acctLabel(m, p.paymentAccountId)} to ${p.vendorId ? m.names.get(p.vendorId) ?? 'vendor' : p.payeeName ?? 'payee'}`;
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

/** Date of the record an edit / void names, company-scoped (null when it isn't in this file). */
async function currentRecordDate(ctx: Pick<ServiceContext, 'db' | 'companyId'>, type: TxnType, id: string): Promise<Date | null> {
  const table = { journal_entry: journalEntries, expense: expenses, transfer: transfers, deposit: deposits }[type];
  const [row] = await ctx.db
    .select({ date: table.date })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)));
  return row ? row.date : null;
}

const KIND_LABEL: Record<TxnType, string> = {
  journal_entry: 'journal entry',
  expense: 'check / expense',
  transfer: 'transfer',
  deposit: 'deposit',
};

/**
 * The import lifts the dividing-date lock, so this is what keeps a changes file from editing or
 * voiding the client's own work dated AFTER the dividing date (an export never produces that; a
 * hand-made file could, since the checksum only proves the file is intact).
 */
async function assertChangesWithinDividingDate(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  file: ChangesFile,
  copy: AccountantCopyRow,
): Promise<void> {
  for (const t of file.transactions) {
    if (t.op === 'add') continue;
    const cur = await currentRecordDate(ctx, t.type, t.id);
    if (cur && day(cur) > copy.dividingDate) {
      throw validation(
        `The changes file would ${t.op === 'void' ? 'void' : 'change'} a ${KIND_LABEL[t.type]} of yours dated ${day(cur)}, which is dated after the dividing date (${formatDividingDate(copy.dividingDate)}). ` +
          "An accountant's changes can only touch transactions dated on or before the dividing date, so this file can't be used. Nothing was imported.",
      );
    }
  }
}

const sameVersion = (a: Date | null | undefined, b: string | null) =>
  !b || (a ? a.getTime() : null) === new Date(b).getTime();

const changedElsewhere = 'This record was changed in your file after the Accountant\'s Copy was made, so the accountant\'s version can\'t replace it safely.';

/** Build the plain-language review of a changes file (nothing is changed). */
export async function reviewChangesFile(ctx: ServiceContext, buffer: Buffer): Promise<ChangesReview> {
  const file = parseChangesFile(buffer);
  const copy = await matchCopy(ctx, file);
  await assertChangesWithinDividingDate(ctx, file, copy);
  const m = await nameMaps(ctx, file);
  const closingDate = await getClosingDate(ctx);
  const items: ReviewItem[] = [];
  const counts = { added: 0, changed: 0, voided: 0, lists: 0 };
  let needsClosingPassword = false;
  const touchesClosed = (d: string | null | undefined) => {
    if (d && closingDate && day(d) <= closingDate) needsClosingPassword = true;
  };

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

  for (const t of file.transactions) {
    const key = `${t.type}:${t.op}:${t.id}`;
    if (t.op === 'add') counts.added++;
    else if (t.op === 'edit') counts.changed++;
    else counts.voided++;
    const afterDate = t.op === 'void' ? null : t.after.date;
    let problem: string | null = null;
    if (afterDate && day(afterDate) > copy.dividingDate) problem = 'This change is dated after the dividing date and will not be imported.';
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
        title: `${kindTitle}${t.op === 'void' ? '' : ` to ${t.after.vendorId ? m.names.get(t.after.vendorId) ?? 'vendor' : t.after.payeeName ?? 'payee'}`}`,
        amount: t.op === 'void' ? (cur ? toAmountString(Money.abs(cur.row.total)) : null) : toAmountString(Money.abs(t.after.total)),
        before: cur?.text ?? null,
        after: t.op === 'void' ? null : [day(t.after.date), ...expenseLines(m, t.after)],
        problem,
      });
    }
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
    closingDate,
    needsClosingPassword,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  copy: ReturnType<typeof publicCopy>;
  applied: { accounts: number; classes: number; added: number; changed: number; voided: number };
  note: string | null;
  trialBalance: { totalDebit: string; totalCredit: string; balanced: boolean };
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

/** Apply the accountant's changes, then lift the Accountant's Copy restriction. */
export async function importChangesFile(ctx: ServiceContext, buffer: Buffer): Promise<ImportResult> {
  assertOwnerOrAdmin(ctx, "import an accountant's changes");
  const file = parseChangesFile(buffer);
  const copy = await matchCopy(ctx, file);
  for (const t of file.transactions) {
    if (t.op !== 'void' && day(t.after.date) > copy.dividingDate) {
      throw validation(
        `The changes file contains a ${describeTxn(t)}, after the dividing date (${formatDividingDate(copy.dividingDate)}). Nothing was imported.`,
      );
    }
  }

  await assertChangesWithinDividingDate(ctx, file, copy);

  return runAccountantImport(copy.id, () =>
    inTransaction(ctx, async (tx) => {
      // Again inside the import's transaction, where the dividing-date lock is lifted.
      await assertChangesWithinDividingDate(tx, file, copy);
      const idMap = new Map<string, string>();
      const mapId = <T extends string | null | undefined>(id: T): T => (id ? ((idMap.get(id) ?? id) as T) : id);
      const applied = { accounts: 0, classes: 0, added: 0, changed: 0, voided: 0 };

      const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof ServiceError) {
            // A record-locking conflict is explained in the message; drop its details so the app's
            // "record changed - reload" dialog does not appear for a whole-file import.
            const stale = Boolean((err.details as { staleVersion?: unknown } | undefined)?.staleVersion);
            throw new ServiceError(
              err.code,
              `Could not import the ${label}: ${err.message} Nothing was imported.`,
              stale ? { accountantCopyImport: true } : err.details,
            );
          }
          throw err;
        }
      };

      // 1. Chart of accounts (new accounts first, parents before children), then classes.
      const accountsOrdered: AccountChange[] = [...file.accounts.filter((a) => a.op === 'add'), ...file.accounts.filter((a) => a.op === 'edit')];
      for (const a of accountsOrdered) {
        if (a.op === 'add') {
          await step(`new account ${a.after.code} · ${a.after.name}`, async () => {
            const created = await createAccount(tx, {
              code: a.after.code,
              name: a.after.name,
              qbType: a.after.qbType,
              subtype: a.after.subtype,
              parentId: mapId(a.after.parentId),
              description: a.after.description,
              taxLine: a.after.taxLine,
            });
            idMap.set(a.id, created.id);
            if (!a.after.isActive) await updateAccount(tx, created.id, { isActive: false });
          });
        } else {
          await step(`change to account ${a.after.code} · ${a.after.name}`, () =>
            withVersionCheck(tx, 'account', a.id, a.baseVersion, (c) =>
              updateAccount(c, a.id, {
                name: a.after.name,
                qbType: a.after.qbType,
                subtype: a.after.subtype,
                parentId: mapId(a.after.parentId),
                description: a.after.description,
                taxLine: a.after.taxLine,
                isActive: a.after.isActive,
              }),
            ),
          );
        }
        applied.accounts++;
      }
      for (const c of file.classes) {
        await step(`new class ${c.name}`, async () => {
          const row = await createClass(tx, { name: c.name, parentId: mapId(c.parentId) });
          idMap.set(c.id, row.id);
        });
        applied.classes++;
      }

      // 2. Transactions: voids, then edits, then additions (oldest first).
      const order = { void: 0, edit: 1, add: 2 } as const;
      const txns = [...file.transactions].sort((a, b) => {
        if (order[a.op] !== order[b.op]) return order[a.op] - order[b.op];
        const da = a.op === 'void' ? '' : a.after.date;
        const db = b.op === 'void' ? '' : b.after.date;
        return da.localeCompare(db);
      });
      const journalInput = (p: JournalPayload) => ({
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
            entityId: l.entityId,
          }),
        ),
      });
      const expenseInput = (p: ExpensePayload): CreateExpenseInput => ({
        vendorId: p.vendorId,
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
          itemId: l.itemId,
          quantity: l.quantity,
          unitCost: l.unitCost,
          description: l.description,
          amount: l.amount,
          classId: mapId(l.classId),
          customerId: l.customerId,
          jobId: l.jobId,
          ...(l.siteId !== undefined ? { siteId: l.siteId } : {}),
          ...(l.binId !== undefined ? { binId: l.binId } : {}),
          ...(l.serialNumbers !== undefined ? { serialNumbers: l.serialNumbers } : {}),
          ...(l.lotNumber !== undefined ? { lotNumber: l.lotNumber } : {}),
          ...(l.lotExpiration !== undefined ? { lotExpiration: l.lotExpiration ? toDate(l.lotExpiration) : null } : {}),
        })),
      });

      const transferInput = (p: TransferPayload): CreateTransferInput => ({
        date: toDate(p.date),
        fromAccountId: mapId(p.fromAccountId),
        toAccountId: mapId(p.toAccountId),
        amount: p.amount,
        memo: p.memo,
        toAmount: p.toAmount,
        homeAmount: p.homeAmount,
      });
      const depositInput = (p: DepositPayload): CreateDepositInput => ({
        date: toDate(p.date),
        depositAccountId: mapId(p.depositAccountId),
        memo: p.memo,
        exchangeRate: p.exchangeRate,
        paymentIds: p.paymentIds,
        salesReceiptIds: p.salesReceiptIds,
        extraLines: p.extraLines.map((l) => ({ accountId: mapId(l.accountId), amount: l.amount, description: l.description })),
        cashBack: p.cashBack ? { accountId: mapId(p.cashBack.accountId), amount: p.cashBack.amount, memo: p.cashBack.memo } : null,
      });

      for (const t of txns) {
        await step(describeTxn(t), async () => {
          if (t.type === 'journal_entry') {
            if (t.op === 'add') await createManualEntry(tx, journalInput(t.after));
            else if (t.op === 'edit') await withVersionCheck(tx, 'journal_entry', t.id, t.baseVersion, (c) => updateEntry(c, t.id, journalInput(t.after)));
            else await withVersionCheck(tx, 'journal_entry', t.id, t.baseVersion, (c) => voidEntry(c, t.id));
          } else if (t.type === 'transfer') {
            if (t.op === 'add') await createTransfer(tx, transferInput(t.after));
            else if (t.op === 'edit') await withVersionCheck(tx, 'transfer', t.id, t.baseVersion, (c) => updateTransfer(c, t.id, transferInput(t.after)));
            else await withVersionCheck(tx, 'transfer', t.id, t.baseVersion, (c) => voidTransfer(c, t.id));
          } else if (t.type === 'deposit') {
            if (t.op === 'add') await createDeposit(tx, depositInput(t.after));
            else if (t.op === 'edit') await withVersionCheck(tx, 'deposit', t.id, t.baseVersion, (c) => updateDeposit(c, t.id, depositInput(t.after)));
            else await withVersionCheck(tx, 'deposit', t.id, t.baseVersion, (c) => voidDeposit(c, t.id));
          } else {
            if (t.op === 'add') await createExpense(tx, expenseInput(t.after));
            else if (t.op === 'edit') await withVersionCheck(tx, 'expense', t.id, t.baseVersion, (c) => updateExpense(c, t.id, expenseInput(t.after)));
            else await withVersionCheck(tx, 'expense', t.id, t.baseVersion, (c) => voidExpense(c, t.id));
          }
        });
        if (t.op === 'add') applied.added++;
        else if (t.op === 'edit') applied.changed++;
        else applied.voided++;
      }

      // 3. The books must still balance (the database guards also check every entry at COMMIT).
      const tb = await trialBalance(tx);
      if (!tb.balanced) {
        throw new ServiceError('UNBALANCED', "The accountant's changes would leave the books out of balance. Nothing was imported.");
      }

      // 4. Lift the restriction.
      const [done] = await tx.db
        .update(accountantCopies)
        .set({
          status: 'imported',
          importedAt: new Date(),
          importedBy: tx.userId,
          accountantNote: file.note,
          result: { applied, preparedBy: file.preparedBy, fileCreatedAt: file.createdAt, warnings: file.warnings },
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
        newValues: { status: 'imported', applied, note: file.note },
      });
      return {
        copy: publicCopy(done),
        applied,
        note: file.note,
        trialBalance: { totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, balanced: tb.balanced },
      };
    }),
  );
}
