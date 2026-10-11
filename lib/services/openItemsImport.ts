/**
 * Open A/R and A/P conversion (QuickBooks cutover).
 *
 * Brings each customer's open invoices / credits and each vendor's unpaid bills / credits in as
 * REAL documents, so Receive Payments, Pay Bills, statements and the aging reports work after
 * the move. Sources:
 *   - QuickBooks "Open Invoices" / "A/R Aging Detail" and "Unpaid Bills Detail" /
 *     "A/P Aging Detail" reports exported to Excel (.xlsx) or CSV — read with the same grid
 *     readers the General Ledger import uses (qbGlFiles.loadGrid);
 *   - IIF INVOICE / BILL transactions (importIIF with `openItems.asDocuments`);
 *   - balances typed in by hand (customer / vendor opening balances).
 *
 * Each document carries ONE line for its open balance, posted against a conversion account
 * instead of income/expense (the income/expense already lives in the General Ledger history):
 *
 *   invoice        Dr A/R (1200)          Cr <conversion account>
 *   credit memo    Dr <conversion>        Cr A/R
 *   bill           Dr <conversion>        Cr A/P (2000)
 *   vendor credit  Dr A/P                 Cr <conversion>
 *
 * Double counting is impossible by construction:
 *   alreadyInGl = true (a GL import already holds the A/R and A/P balances): the conversion
 *     account is "QB Conversion Clearing" and every document gets a mirror journal entry on the
 *     same date (Dr clearing / Cr the A/R account holding the imported balance for an invoice,
 *     and so on). The control accounts and clearing net to exactly what the GL import posted —
 *     the documents only add the per-customer / per-vendor detail.
 *   alreadyInGl = false (fresh books): the conversion account is Opening Balance Equity, as in
 *     QuickBooks' own opening-balance invoices.
 *
 * `arApReconciliation` proves the result: A/R control == A/R aging and A/P control == A/P
 * aging (the import response includes it).
 *
 * Re-running the same file is safe: every document's memo carries a stable [qbopen:…] tag and
 * documents already present are skipped. IIF documents carry a [qbdoc:…] tag instead, built from
 * the QuickBooks document itself (type, name, number, date, total — not its open balance), so a
 * re-import of a newer export with more payments in it does not bring the invoice or bill in a
 * second time: the tagged total already in the books is compared with what the new file says is
 * still open, and only the difference is added (a credit for new payments, a charge when more is
 * owed). Re-importing the identical file adds nothing.
 */
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, eq, like, ne, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  bills,
  creditMemos,
  customers as customersTable,
  invoices,
  journalEntries,
  journalEntryLines,
  vendorCredits,
  vendors as vendorsTable,
} from '@/lib/db/schema';
import { MAX_LEDGER_AMOUNT, Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { createAccount } from './accounts';
import { createBill } from './bills';
import { createCreditMemo } from './creditMemos';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { postJournalEntry } from './posting';
import { apAging, arAging } from './reportsExtra';
import { createVendor } from './vendors';
import { createVendorCredit } from './vendorCredits';
import { type GridRow, loadGrid } from './qbGlFiles';
import { parseAmount, parseQbDate } from './qbGlParse';
import type { IIFTransaction, ImportIssue } from './qbImport';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenItemKind = 'invoice' | 'credit_memo' | 'bill' | 'vendor_credit';
export type LedgerSide = 'ar' | 'ap';

export interface OpenItem {
  kind: OpenItemKind;
  /** Customer or vendor full name ("Customer:Job" allowed). */
  name: string;
  /** YYYY-MM-DD */
  date: string;
  dueDate?: string | null;
  number?: string | null;
  /** QuickBooks transaction type as printed (Invoice, Credit Memo, Payment, Bill …). */
  qbType?: string | null;
  terms?: string | null;
  memo?: string | null;
  /** Always positive — the kind carries the direction. */
  openBalance: string;
  /**
   * Stable identity of the QuickBooks source document (IIF imports). Items sharing a key are one
   * document; on re-import only the change against what the books already hold is brought in.
   */
  docKey?: string | null;
}

export interface ParsedOpenItems {
  side: LedgerSide;
  items: OpenItem[];
  warnings: string[];
}

export interface OpenItemsFile {
  name: string;
  /** base64 bytes */
  data: string;
}

export interface OpenItemsInput {
  /** A QB report export, or `items` typed by hand (opening balances). */
  file?: OpenItemsFile | null;
  items?: OpenItem[] | null;
  /** Force A/R or A/P (otherwise detected from the report). */
  side?: LedgerSide | null;
  /** A General Ledger import already brought the A/R / A/P balances (default: true when a GL import exists). */
  alreadyInGl?: boolean;
  /** A/R account holding the imported A/R balance (default: detected). */
  arAccountId?: string | null;
  /** A/P account holding the imported A/P balance (default: detected). */
  apAccountId?: string | null;
  /** Create customers / vendors that are not in the books yet (default true). */
  createMissingNames?: boolean;
}

export interface OpenItemsPreview {
  side: LedgerSide;
  items: Array<OpenItem & { exists: boolean; nameFound: boolean }>;
  totals: { documents: string; credits: string; net: string };
  missingNames: string[];
  warnings: string[];
  /** Suggested account holding the imported A/R or A/P balance. */
  controlAccount: { id: string; code: string; name: string; balance: string } | null;
  controlAccounts: Array<{ id: string; code: string; name: string; balance: string }>;
  alreadyInGlSuggested: boolean;
}

export interface ReconciliationSide {
  /** Sum of the control accounts (debit-positive for A/R, credit-positive for A/P). */
  control: string;
  /** Aging total (open documents net of unapplied credits). */
  aging: string;
  difference: string;
  inBalance: boolean;
  accounts: Array<{ code: string; name: string; balance: string }>;
}

export interface OpenItemsResult {
  side: LedgerSide;
  invoices: number;
  bills: number;
  credits: number;
  skipped: number;
  issues: ImportIssue[];
  reconciliation: { ar: ReconciliationSide; ap: ReconciliationSide };
}

export const QB_CONVERSION_CLEARING = { code: 'QB-CONV', name: 'QB Conversion Clearing' } as const;
const OPENING_BALANCE_EQUITY = 'Opening Balance Equity';

// ---------------------------------------------------------------------------
// Report parsing (pure)
// ---------------------------------------------------------------------------

const HEADER_KEYS = {
  type: ['type', 'transaction type', 'txn type'],
  date: ['date', 'txn date', 'transaction date'],
  num: ['num', 'no.', 'number', 'ref no.', 'invoice #', 'bill #', 'doc num'],
  due: ['due date', 'due'],
  terms: ['terms'],
  memo: ['memo', 'memo/description', 'description'],
  open: ['open balance', 'open bal', 'balance', 'amount due', 'open amount'],
  amount: ['amount', 'original amount', 'orig. amount'],
  name: ['name', 'customer', 'vendor', 'customer:job', 'source name'],
} as const;

function findCol(cells: string[], keys: readonly string[]): number {
  const norm = cells.map((c) => c.trim().toLowerCase().replace(/\s+/g, ' '));
  for (const k of keys) {
    const i = norm.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

const AP_TYPES = /bill|item receipt|vendor|check/i;
const AR_TYPES = /invoice|statement charge|sales|credit memo|payment/i;

/**
 * Parse a QuickBooks Open Invoices / Unpaid Bills (or aging detail) report grid. Group header
 * rows ("Acme Corp", then indented "Job 1") build the customer / vendor name; "Total …" rows
 * close a group; transaction rows carry Type / Date / Num / Due Date / Open Balance.
 */
export function parseOpenItemsGrid(rows: GridRow[], forceSide?: LedgerSide | null): ParsedOpenItems {
  const warnings: string[] = [];
  const hi = rows.findIndex((r) => findCol(r.cells, HEADER_KEYS.type) >= 0 && (findCol(r.cells, HEADER_KEYS.open) >= 0 || findCol(r.cells, HEADER_KEYS.amount) >= 0));
  if (hi < 0) {
    throw validation(
      'This does not look like a QuickBooks Open Invoices or Unpaid Bills report. Export it with the Type, Date, Num and Open Balance columns.',
    );
  }
  const header = rows[hi].cells;
  const col = {
    type: findCol(header, HEADER_KEYS.type),
    date: findCol(header, HEADER_KEYS.date),
    num: findCol(header, HEADER_KEYS.num),
    due: findCol(header, HEADER_KEYS.due),
    terms: findCol(header, HEADER_KEYS.terms),
    memo: findCol(header, HEADER_KEYS.memo),
    open: findCol(header, HEADER_KEYS.open),
    amount: findCol(header, HEADER_KEYS.amount),
    name: findCol(header, HEADER_KEYS.name),
  };
  const amountCol = col.open >= 0 ? col.open : col.amount;
  if (col.open < 0) warnings.push('The report has no "Open Balance" column — the full amount of each document is used.');

  // Side: explicit, else from the title block, else from the transaction types.
  const titleText = rows.slice(0, hi).map((r) => r.cells.join(' ')).join(' ').toLowerCase();
  let side: LedgerSide | null = forceSide ?? null;
  if (!side) {
    if (/unpaid bills|a\/p aging|accounts payable|vendor balance/.test(titleText)) side = 'ap';
    else if (/open invoices|a\/r aging|accounts receivable|customer balance|collections/.test(titleText)) side = 'ar';
  }

  const stack: Array<{ level: number; name: string }> = [];
  const items: OpenItem[] = [];
  let apHits = 0;
  let arHits = 0;
  for (const r of rows.slice(hi + 1)) {
    const cells = r.cells;
    const typeCell = (cells[col.type] ?? '').trim();
    const firstIdx = cells.findIndex((c) => c.trim() !== '');
    if (firstIdx < 0) continue;
    const label = cells[firstIdx].trim();
    if (!typeCell) {
      if (firstIdx < col.type || (col.type === 0 && firstIdx === 0)) {
        if (/^total\b/i.test(label)) {
          const closed = label.replace(/^total\s+/i, '').trim().toLowerCase();
          const at = stack.map((s) => s.name.toLowerCase()).lastIndexOf(closed);
          if (at >= 0) stack.length = at;
          else stack.pop();
          continue;
        }
        if (/^total$/i.test(label)) continue;
        // Group header: level = column + indentation (PDF x / leading spaces).
        const lead = cells[firstIdx].length - cells[firstIdx].trimStart().length;
        const level = r.indent ?? firstIdx * 100 + lead;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, name: label.replace(/:$/, '') });
      }
      continue;
    }
    if (/^total\b/i.test(typeCell)) continue;
    const amt = parseAmount(cells[amountCol]);
    if (amt === null || amt.isZero()) continue;
    const date = parseQbDate(cells[col.date]);
    if (!date) {
      warnings.push(`Skipped a ${typeCell} row without a readable date.`);
      continue;
    }
    // A name column (e.g. aging detail exports) wins over the group headers.
    const nameFromCol = col.name >= 0 ? (cells[col.name] ?? '').trim() : '';
    let name = nameFromCol;
    if (!name) {
      // Group headers that are "Customer" then "Job" become "Customer:Job".
      name = stack.map((s) => s.name).join(':');
    }
    if (!name) {
      warnings.push(`Skipped ${typeCell} ${cells[col.num] ?? ''} — no customer or vendor name above it.`);
      continue;
    }
    if (AP_TYPES.test(typeCell)) apHits++;
    if (AR_TYPES.test(typeCell)) arHits++;
    // Documents print positive, credits / unapplied payments negative (both report kinds).
    items.push({
      kind: amt.isNegative() ? 'credit_memo' : 'invoice', // mapped to bill / vendor credit below for A/P
      name,
      date,
      dueDate: col.due >= 0 ? parseQbDate(cells[col.due]) : null,
      number: col.num >= 0 ? (cells[col.num] ?? '').trim() || null : null,
      qbType: typeCell,
      terms: col.terms >= 0 ? (cells[col.terms] ?? '').trim() || null : null,
      memo: col.memo >= 0 ? (cells[col.memo] ?? '').trim() || null : null,
      openBalance: toAmountString(amt.abs()),
    });
  }
  side ??= apHits > arHits ? 'ap' : 'ar';
  if (side === 'ap') {
    for (const it of items) it.kind = it.kind === 'credit_memo' ? 'vendor_credit' : 'bill';
  }
  return { side, items, warnings };
}

function decodeFile(f: OpenItemsFile): Uint8Array {
  if (!f || typeof f.data !== 'string' || !f.data) throw validation('The file is empty.');
  const buf = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw validation('The file is empty.');
  if (buf.length > 60 * 1024 * 1024) throw validation('The file is larger than 60 MB.');
  return new Uint8Array(buf);
}

/** Read the open items from the uploaded report (xlsx / csv / pdf) or the typed-in list. */
export async function loadOpenItems(input: Pick<OpenItemsInput, 'file' | 'items' | 'side'>): Promise<ParsedOpenItems> {
  if (input.items && input.items.length) {
    const side: LedgerSide = input.side ?? (input.items.every((i) => i.kind === 'bill' || i.kind === 'vendor_credit') ? 'ap' : 'ar');
    for (const it of input.items) {
      if (!it.name?.trim()) throw validation('Every balance needs a customer or vendor name.');
      if (!parseQbDate(it.date)) throw validation(`"${it.date}" is not a valid date.`);
      let a;
      try {
        a = Money.of(it.openBalance);
      } catch {
        throw validation(`"${it.openBalance}" is not a valid amount.`);
      }
      // Validate the value that will actually be stored (rounded to cents): 0.001 rounds to 0.00.
      // Decimal(0).isPositive() is true in decimal.js — compare explicitly.
      if (!a.isFinite() || !Money.round2(a).greaterThan(0)) throw validation('Amounts must be at least 0.01.');
      if (Money.round2(a).greaterThan(MAX_LEDGER_AMOUNT)) throw validation(`"${it.openBalance}" is larger than the books can hold.`);
      const okKind = side === 'ar' ? ['invoice', 'credit_memo'] : ['bill', 'vendor_credit'];
      if (!okKind.includes(it.kind)) throw validation('Mixing customer and vendor balances in one import is not allowed.');
    }
    return {
      side,
      items: input.items.map((i) => ({ ...i, date: parseQbDate(i.date)!, openBalance: toAmountString(i.openBalance), dueDate: i.dueDate ? parseQbDate(i.dueDate) : null })),
      warnings: [],
    };
  }
  if (!input.file) throw validation('Choose a report file or enter the balances.');
  const bytes = decodeFile(input.file);
  const loaded = await loadGrid(bytes, input.file.name, (cells) => findCol(cells, HEADER_KEYS.type) >= 0 && findCol(cells, HEADER_KEYS.open) >= 0);
  if (loaded.kind === 'iif') {
    throw validation('For IIF files use the Lists step and turn on "Bring in open invoices and bills as documents".');
  }
  let lastErr: unknown = null;
  for (const sheet of loaded.sheets) {
    try {
      return parseOpenItemsGrid(sheet.rows, input.side);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? validation('No worksheet in this file looks like an open-balance report.');
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

async function accountByCode(ctx: ServiceContext, code: string) {
  const [row] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return row ?? null;
}

/** Posted balance per account (debit − credit) for the given subtype. */
async function balancesBySubtype(ctx: ServiceContext, subtype: 'accounts_receivable' | 'accounts_payable') {
  const accts = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, subtype)));
  const sums = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      dr: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      cr: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')))
    .groupBy(journalEntryLines.accountId);
  const net = new Map(sums.map((s) => [s.accountId, Money.of(s.dr).minus(Money.of(s.cr))]));
  return accts.map((a) => ({ ...a, debitBalance: net.get(a.id) ?? Money.zero() }));
}

/** The control account holding the imported balance (largest balance), default 1200 / 2000. */
async function detectControlAccount(ctx: ServiceContext, side: LedgerSide) {
  const rows = await balancesBySubtype(ctx, side === 'ar' ? 'accounts_receivable' : 'accounts_payable');
  // Retainage receivable is not part of the open-invoice aging.
  const candidates = rows.filter((r) => r.code !== '1250');
  const signed = candidates.map((r) => ({ ...r, natural: side === 'ar' ? r.debitBalance : r.debitBalance.negated() }));
  signed.sort((a, b) => b.natural.comparedTo(a.natural));
  const fallbackCode = side === 'ar' ? '1200' : '2000';
  const best = signed.find((r) => r.natural.greaterThan(0)) ?? signed.find((r) => r.code === fallbackCode) ?? null;
  return {
    best: best ? { id: best.id, code: best.code, name: best.name, balance: toAmountString(best.natural) } : null,
    all: signed.map((r) => ({ id: r.id, code: r.code, name: r.name, balance: toAmountString(r.natural) })),
  };
}

/** The account open-item documents post against (clearing with a GL import, else Opening Balance Equity). */
export async function ensureConversionAccount(ctx: ServiceContext, alreadyInGl: boolean): Promise<string> {
  if (alreadyInGl) {
    const existing = await accountByCode(ctx, QB_CONVERSION_CLEARING.code);
    if (existing) return existing.id;
    const row = await createAccount(ctx, {
      code: QB_CONVERSION_CLEARING.code,
      name: QB_CONVERSION_CLEARING.name,
      type: 'equity',
      subtype: 'owners_equity',
      description:
        'Offsets the open invoices and bills brought in from QuickBooks against the General Ledger import. It should always total zero.',
    });
    return row.id;
  }
  const [obe] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, OPENING_BALANCE_EQUITY)));
  if (obe) return obe.id;
  const taken = new Set(
    (await ctx.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.companyId, ctx.companyId))).map((r) => r.code),
  );
  let code = 3900;
  while (taken.has(String(code))) code++;
  const row = await createAccount(ctx, {
    code: String(code),
    name: OPENING_BALANCE_EQUITY,
    type: 'equity',
    subtype: 'owners_equity',
    description: 'Offsets opening balances entered when the company file was set up.',
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

async function nameIndex(ctx: ServiceContext, side: LedgerSide) {
  if (side === 'ar') {
    const rows = await ctx.db
      .select({ id: customersTable.id, name: customersTable.displayName })
      .from(customersTable)
      .where(eq(customersTable.companyId, ctx.companyId));
    return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  }
  const rows = await ctx.db
    .select({ id: vendorsTable.id, name: vendorsTable.displayName })
    .from(vendorsTable)
    .where(eq(vendorsTable.companyId, ctx.companyId));
  return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
}

const canonicalName = (n: string) => n.split(':').map((s) => s.trim()).filter(Boolean).join(':');

async function ensureName(ctx: ServiceContext, side: LedgerSide, index: Map<string, string>, name: string): Promise<string> {
  const full = canonicalName(name);
  const hit = index.get(full.toLowerCase());
  if (hit) return hit;
  if (side === 'ap') {
    const v = await createVendor(ctx, { displayName: full });
    index.set(full.toLowerCase(), v.id);
    return v.id;
  }
  const segs = full.split(':');
  let parentId: string | null = null;
  for (let i = 1; i <= segs.length; i++) {
    const n = segs.slice(0, i).join(':');
    let id = index.get(n.toLowerCase());
    if (!id) {
      const c = await createCustomer(ctx, { displayName: n, parentId });
      id = c.id;
      index.set(n.toLowerCase(), id);
    }
    parentId = id;
  }
  return parentId!;
}

// ---------------------------------------------------------------------------
// Duplicate tags
// ---------------------------------------------------------------------------

function itemTag(side: LedgerSide, it: OpenItem): string {
  const key = [side, it.kind, canonicalName(it.name).toLowerCase(), it.number ?? '', it.date, toAmountString(it.openBalance)].join('|');
  return `qbopen:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

async function tagExists(ctx: ServiceContext, kind: OpenItemKind, tag: string): Promise<boolean> {
  const pattern = `%[${tag}]%`;
  const table =
    kind === 'invoice' ? invoices : kind === 'bill' ? bills : kind === 'credit_memo' ? creditMemos : vendorCredits;
  const [row] = await ctx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, ctx.companyId), like(table.memo, pattern)))
    .limit(1);
  return !!row;
}

function docTag(side: LedgerSide, docKey: string): string {
  return `qbdoc:${createHash('sha256').update(`${side}|${docKey}`).digest('hex').slice(0, 16)}`;
}

/** What an item adds to what the customer / vendor owes (credits negative). */
const signedOwed = (it: OpenItem) =>
  it.kind === 'invoice' || it.kind === 'bill' ? Money.of(it.openBalance) : Money.of(it.openBalance).negated();

/** Signed total (owed > 0) of the non-void documents already carrying a [qbdoc:…] tag. */
async function existingDocOwed(ctx: ServiceContext, tag: string): Promise<{ count: number; owed: Decimal }> {
  const pattern = `%[${tag}]%`;
  let count = 0;
  let owed = Money.zero();
  for (const [table, sign] of [
    [invoices, 1],
    [bills, 1],
    [creditMemos, -1],
    [vendorCredits, -1],
  ] as const) {
    const rows = await ctx.db
      .select({ total: table.total })
      .from(table)
      .where(and(eq(table.companyId, ctx.companyId), like(table.memo, pattern), ne(table.status, 'void')));
    for (const r of rows) {
      count++;
      owed = sign === 1 ? owed.plus(Money.of(r.total)) : owed.minus(Money.of(r.total));
    }
  }
  return { count, owed };
}

/**
 * A QuickBooks document an import handled without creating anything (fully paid, PAID=Y, open
 * balance 0) is recorded in the audit trail, so a later import knows its payments were already
 * accounted for. The audit row's entity id is derived from the document tag.
 */
const OPEN_ITEM_MARKER = 'qb_open_item_document';
function markerEntityId(ctx: ServiceContext, tag: string): string {
  const h = createHash('sha256').update(`${ctx.companyId}|${tag}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
async function openItemMarkerExists(ctx: ServiceContext, tag: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, OPEN_ITEM_MARKER),
        eq(auditLogs.entityId, markerEntityId(ctx, tag)),
      ),
    )
    .limit(1);
  return !!row;
}

interface PlannedItem {
  item: OpenItem;
  /** [qbdoc:…] tag for IIF documents; null → the [qbopen:…] amount tag. */
  docTag: string | null;
}

/**
 * Decide what to create. Items without a docKey are skipped when their [qbopen:…] tag exists.
 * Items with a docKey are grouped per QuickBooks document; when the books already hold that
 * document, only the difference between the file's open amount and the tagged total is added.
 */
async function planConversion(
  ctx: ServiceContext,
  side: LedgerSide,
  items: OpenItem[],
): Promise<{ plan: PlannedItem[]; duplicates: OpenItem[]; markers: Array<{ tag: string; item: OpenItem }> }> {
  const plan: PlannedItem[] = [];
  const duplicates: OpenItem[] = [];
  const markers: Array<{ tag: string; item: OpenItem }> = [];
  const groups = new Map<string, OpenItem[]>();
  for (const it of items) {
    if (!it.docKey) {
      if (!Money.round2(it.openBalance).greaterThan(0)) continue;
      if (await tagExists(ctx, it.kind, itemTag(side, it))) duplicates.push(it);
      else plan.push({ item: it, docTag: null });
      continue;
    }
    const g = groups.get(it.docKey);
    if (g) g.push(it);
    else groups.set(it.docKey, [it]);
  }
  for (const [key, group] of groups) {
    const tag = docTag(side, key);
    const live = group.filter((it) => Money.round2(it.openBalance).greaterThan(0));
    const existing = await existingDocOwed(ctx, tag);
    if (existing.count === 0) {
      for (const it of live) plan.push({ item: it, docTag: tag });
      if (!live.length && !(await openItemMarkerExists(ctx, tag))) markers.push({ tag, item: group[0] });
      continue;
    }
    const target = group.reduce((s, it) => s.plus(signedOwed(it)), Money.zero());
    const diff = Money.round2(target.minus(existing.owed));
    const first = live[0] ?? group[0];
    if (diff.isZero()) {
      duplicates.push(first);
      continue;
    }
    const ar = side === 'ar';
    const more = diff.isPositive();
    plan.push({
      docTag: tag,
      item: {
        kind: more ? (ar ? 'invoice' : 'bill') : ar ? 'credit_memo' : 'vendor_credit',
        name: first.name,
        date: group.reduce((d, it) => (it.date > d ? it.date : d), first.date),
        number: null,
        qbType: more ? 'Change since the earlier import (more owed)' : 'Change since the earlier import (payments / credits)',
        memo:
          `${first.qbType ?? KIND_LABEL[first.kind]}${first.number ? ` #${first.number}` : ''} was brought in by an earlier import; ` +
          `the newer QuickBooks file shows ${toAmountString(target.abs())} ${target.isNegative() ? 'credit' : 'open'}.`,
        openBalance: toAmountString(diff.abs()),
        docKey: key,
      },
    });
  }
  return { plan, duplicates, markers };
}

const KIND_LABEL: Record<OpenItemKind, string> = {
  invoice: 'Invoice',
  credit_memo: 'Credit',
  bill: 'Bill',
  vendor_credit: 'Vendor credit',
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** True when a General Ledger import (qbgl:* entries) has posted anything. */
async function hasGlImport(ctx: ServiceContext): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'qbgl:%'), ne(journalEntries.status, 'void')))
    .limit(1);
  return !!row;
}

export async function previewOpenItems(ctx: ServiceContext, input: OpenItemsInput): Promise<OpenItemsPreview> {
  const parsed = await loadOpenItems(input);
  const index = await nameIndex(ctx, parsed.side);
  let docs = Money.zero();
  let credits = Money.zero();
  const missing = new Set<string>();
  const items: OpenItemsPreview['items'] = [];
  for (const it of parsed.items) {
    const nameFound = index.has(canonicalName(it.name).toLowerCase());
    if (!nameFound) missing.add(canonicalName(it.name));
    const exists = await tagExists(ctx, it.kind, itemTag(parsed.side, it));
    items.push({ ...it, exists, nameFound });
    if (it.kind === 'invoice' || it.kind === 'bill') docs = docs.plus(Money.of(it.openBalance));
    else credits = credits.plus(Money.of(it.openBalance));
  }
  const control = await detectControlAccount(ctx, parsed.side);
  return {
    side: parsed.side,
    items,
    totals: { documents: toAmountString(docs), credits: toAmountString(credits), net: toAmountString(docs.minus(credits)) },
    missingNames: [...missing].sort(),
    warnings: parsed.warnings,
    controlAccount: control.best,
    controlAccounts: control.all,
    alreadyInGlSuggested: await hasGlImport(ctx),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ConvertEnv {
  side: LedgerSide;
  alreadyInGl: boolean;
  conversionId: string;
  controlId: string;
  createMissingNames: boolean;
  index: Map<string, string>;
}

async function convertOne(ctx: ServiceContext, env: ConvertEnv, it: OpenItem, qbdoc: string | null): Promise<'created' | 'duplicate'> {
  const tag = qbdoc ?? itemTag(env.side, it);
  if (!qbdoc && (await tagExists(ctx, it.kind, tag))) return 'duplicate';
  const full = canonicalName(it.name);
  let nameId = env.index.get(full.toLowerCase());
  if (!nameId) {
    if (!env.createMissingNames) throw notFound(`${env.side === 'ar' ? 'Customer' : 'Vendor'} "${full}"`);
    nameId = await ensureName(ctx, env.side, env.index, full);
  }
  const date = new Date(`${it.date}T00:00:00.000Z`);
  const due = it.dueDate ? new Date(`${it.dueDate}T00:00:00.000Z`) : null;
  const amount = toAmountString(it.openBalance);
  const desc = `Open balance from QuickBooks: ${it.qbType ?? KIND_LABEL[it.kind]}${it.number ? ` #${it.number}` : ''} dated ${it.date}`;
  const memo = `${desc}${it.memo ? ` — ${it.memo}` : ''}${it.terms ? ` (terms ${it.terms})` : ''} [${tag}]`;

  return inTransaction(ctx, async (tx) => {
    // 1) The real document, posted against the conversion account.
    if (it.kind === 'invoice') {
      await createInvoice(tx, {
        customerId: nameId!,
        date,
        dueDate: due,
        memo,
        lines: [{ accountId: env.conversionId, description: desc, quantity: 1, rate: amount, taxable: false }],
      });
    } else if (it.kind === 'credit_memo') {
      await createCreditMemo(tx, {
        customerId: nameId!,
        date,
        memo,
        lines: [{ accountId: env.conversionId, description: desc, quantity: 1, rate: amount, taxable: false }],
      });
    } else if (it.kind === 'bill') {
      await createBill(tx, {
        vendorId: nameId!,
        billNumber: it.number ?? null,
        date,
        dueDate: due,
        memo,
        lines: [{ accountId: env.conversionId, description: desc, amount }],
      });
    } else {
      await createVendorCredit(tx, {
        vendorId: nameId!,
        date,
        memo,
        lines: [{ accountId: env.conversionId, description: desc, amount }],
      });
    }

    // 2) Mirror entry: the GL import already holds this balance in the control account.
    if (env.alreadyInGl) {
      const controlDebit = it.kind === 'credit_memo' || it.kind === 'bill';
      await postJournalEntry(tx, {
        date,
        description: `QuickBooks conversion offset — ${desc}`,
        reference: it.number ?? null,
        sourceRef: `qbopen-offset:${tag}`,
        lines: controlDebit
          ? [
              { accountId: env.controlId, debit: amount, memo: `Already in the General Ledger import — ${full}` },
              { accountId: env.conversionId, credit: amount, memo: 'QB conversion clearing' },
            ]
          : [
              { accountId: env.conversionId, debit: amount, memo: 'QB conversion clearing' },
              { accountId: env.controlId, credit: amount, memo: `Already in the General Ledger import — ${full}` },
            ],
      });
    }
    return 'created' as const;
  });
}

async function runConversion(ctx: ServiceContext, side: LedgerSide, items: OpenItem[], input: OpenItemsInput): Promise<OpenItemsResult> {
  const alreadyInGl = input.alreadyInGl ?? (await hasGlImport(ctx));
  const { plan, duplicates, markers } = await planConversion(ctx, side, items);

  // Guard against double counting the other way: with alreadyInGl the documents only add
  // detail to a balance that must ALREADY be in the control accounts. If these items add up to
  // more than the part of the balance that has no documents yet, refuse (nothing is written).
  if (alreadyInGl) {
    let newNet = Money.zero();
    for (const p of plan) newNet = newNet.plus(signedOwed(p.item));
    const rec = (await arApReconciliation(ctx))[side];
    const room = Money.of(rec.control).minus(Money.of(rec.aging));
    if (newNet.minus(room).greaterThan('0.005')) {
      const what = side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable';
      throw validation(
        `Your books show ${toAmountString(room)} of ${what} without invoice or bill detail, but these open items add up to ${toAmountString(newNet)}. ` +
          'Import the General Ledger history first — or, if you are starting fresh without it, turn off "already in my General Ledger".',
      );
    }
  }

  const conversionId = await ensureConversionAccount(ctx, alreadyInGl);
  let controlId: string | null = side === 'ar' ? input.arAccountId ?? null : input.apAccountId ?? null;
  if (controlId) {
    const [row] = await ctx.db
      .select({ id: accounts.id, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, controlId)));
    const want = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
    if (!row) throw notFound('Control account');
    if (row.subtype !== want) throw validation(`Choose an ${side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'} account.`);
  } else {
    const detected = await detectControlAccount(ctx, side);
    controlId = detected.best?.id ?? null;
  }
  if (alreadyInGl && !controlId) {
    throw validation(`No ${side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'} account was found to offset against.`);
  }
  const env: ConvertEnv = {
    side,
    alreadyInGl,
    conversionId,
    controlId: controlId ?? '',
    createMissingNames: input.createMissingNames ?? true,
    index: await nameIndex(ctx, side),
  };

  const result: OpenItemsResult = {
    side,
    invoices: 0,
    bills: 0,
    credits: 0,
    skipped: 0,
    issues: [],
    reconciliation: undefined as never,
  };
  const labelOf = (it: OpenItem) => `${KIND_LABEL[it.kind]}${it.number ? ` #${it.number}` : ''} — ${it.name}`;
  for (const it of duplicates) {
    result.skipped++;
    result.issues.push({ entity: side === 'ar' ? 'invoice' : 'bill', name: labelOf(it), reason: 'duplicate', message: 'Already brought in by an earlier import.' });
  }
  for (const { item: it, docTag: qbdoc } of plan) {
    const label = labelOf(it);
    try {
      const r = await convertOne(ctx, env, it, qbdoc);
      if (r === 'duplicate') {
        result.skipped++;
        result.issues.push({ entity: side === 'ar' ? 'invoice' : 'bill', name: label, reason: 'duplicate', message: 'Already brought in by an earlier import.' });
        continue;
      }
      if (it.kind === 'invoice') result.invoices++;
      else if (it.kind === 'bill') result.bills++;
      else result.credits++;
    } catch (err) {
      if (err instanceof ServiceError) {
        result.skipped++;
        result.issues.push({ entity: side === 'ar' ? 'invoice' : 'bill', name: label, reason: 'validation', message: err.message });
        continue;
      }
      throw err;
    }
  }
  for (const m of markers) {
    await writeAudit(ctx, {
      action: 'create',
      entityType: OPEN_ITEM_MARKER,
      entityId: markerEntityId(ctx, m.tag),
      newValues: {
        tag: m.tag,
        side,
        name: m.item.name,
        number: m.item.number ?? null,
        date: m.item.date,
        note: 'QuickBooks document with nothing left open — recorded so a later import does not apply its payments again.',
      },
    });
  }
  result.reconciliation = await arApReconciliation(ctx);
  return result;
}

/** Bring a report's (or typed-in) open items into the books as documents. */
export async function importOpenItems(ctx: ServiceContext, input: OpenItemsInput): Promise<OpenItemsResult> {
  const parsed = await loadOpenItems(input);
  if (!parsed.items.length) throw validation('No open balances were found in this file.');
  const result = await runConversion(ctx, parsed.side, parsed.items, input);
  for (const w of parsed.warnings) result.issues.push({ entity: parsed.side === 'ar' ? 'invoice' : 'bill', name: 'Report', reason: 'note', message: w });
  return result;
}

/** A named A/R or A/P row from a non-document IIF transaction (payment, refund, journal ...). */
export interface IifControlRow {
  side: LedgerSide;
  name: string;
  /** Signed IIF amount (positive = debit). */
  amount: string;
  /** YYYY-MM-DD */
  date: string | null;
  /**
   * Source reference the transaction posts under (`iif:…`). With `posted` true an earlier import
   * already posted it — the ledger skips it as a duplicate, so it was applied back then and must
   * not move the name's open documents again.
   */
  ref?: string | null;
  posted?: boolean;
}

interface Residual {
  side: LedgerSide;
  name: string;
  /** QuickBooks balance minus what the open documents carry (positive = owed). */
  amount: Decimal;
  /** Total of the documents QuickBooks marked PAID (they only absorb payments, see below). */
  paid: Decimal;
  date: string | null;
  /** Source refs of the new control rows behind this residual (identity of its credit / charge). */
  refs: string[];
}

/**
 * Make one name's open items add up to its QuickBooks balance. A negative residual (payments or
 * credits the open documents do not reflect yet) reduces that name's open invoices / bills,
 * oldest first; anything left becomes an unapplied credit. A positive residual reduces its open
 * credits first; anything left becomes an open balance. Returns the amount of the added item.
 */
function applyResidual(list: OpenItem[], r: Residual): Decimal {
  const key = r.name.toLowerCase();
  const credit = r.amount.isNegative();
  const reduceKinds: OpenItemKind[] = credit ? ['invoice', 'bill'] : ['credit_memo', 'vendor_credit'];
  let rest = Money.round2(r.amount.abs());
  const targets = list
    .filter((it) => canonicalName(it.name).toLowerCase() === key && reduceKinds.includes(it.kind))
    .sort((a, b) => (a.date === b.date ? (a.number ?? '').localeCompare(b.number ?? '') : a.date < b.date ? -1 : 1));
  for (const it of targets) {
    if (!rest.greaterThan(0)) break;
    const bal = Money.of(it.openBalance);
    const take = Decimal.min(bal, rest);
    it.openBalance = toAmountString(bal.minus(take));
    rest = rest.minus(take);
  }
  // Zero-balance IIF documents stay in the list: planConversion needs them to see that a document
  // an earlier import brought in is now fully paid.
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].docKey && Money.round2(list[i].openBalance).isZero()) list.splice(i, 1);
  if (!rest.greaterThan(0)) return Money.zero();
  const ar = r.side === 'ar';
  const batch = createHash('sha256').update([...r.refs].sort().join('\n')).digest('hex').slice(0, 16);
  list.push({
    kind: credit ? (ar ? 'credit_memo' : 'vendor_credit') : ar ? 'invoice' : 'bill',
    name: r.name,
    date: r.date ?? new Date().toISOString().slice(0, 10),
    number: null,
    qbType: credit ? 'Unapplied payment / credit' : 'Balance from QuickBooks transactions',
    memo: credit
      ? 'Payments or credits in the QuickBooks file that are more than the open documents.'
      : 'Charges in the QuickBooks file that have no open document.',
    openBalance: toAmountString(rest),
    // Identified by the transactions behind it: those post once, so this item is created once.
    docKey: `residual|${key}|${batch}`,
  });
  return rest;
}

/**
 * IIF INVOICE / BILL (and credit) transactions → open items. A transaction QuickBooks marked
 * PAID=Y is not open and is skipped; when the export carries an open balance column it is used,
 * otherwise the document total.
 *
 * Re-import (the same file again, or a newer export that repeats earlier transactions): payments
 * and other rows an earlier import already posted are left out (they were applied back then), and
 * a document the books already hold is not brought in again — it stands in at the amount the
 * books carry for it, so only NEW payments reduce it (the reduction comes in as a credit tagged
 * to that document).
 */
export async function importOpenItemsFromIif(
  ctx: ServiceContext,
  txns: IIFTransaction[],
  opts: {
    alreadyInGl: boolean;
    /**
     * Named A/R and A/P rows of the OTHER transactions in the same file (payments, bill
     * payments, refunds, journals). Their total per customer / vendor is applied to that
     * name's open documents, so each name's aging equals its real QuickBooks balance.
     */
    controlRows?: IifControlRow[];
  },
): Promise<{ invoices: number; bills: number; credits: number; skipped: number; issues: ImportIssue[] }> {
  const ar: OpenItem[] = [];
  const ap: OpenItem[] = [];
  const issues: ImportIssue[] = [];
  let skipped = 0;
  // Per side + customer / vendor: what QuickBooks says is owed (every document at its full
  // amount plus every other A/R / A/P row) minus what the open documents below carry.
  const residual = new Map<string, Residual>();
  const touch = (side: LedgerSide, name: string, date: string | null, owed: Decimal, paid = false, ref?: string | null) => {
    const key = `${side}|${canonicalName(name).toLowerCase()}`;
    let r = residual.get(key);
    if (!r) residual.set(key, (r = { side, name: canonicalName(name), amount: Money.zero(), paid: Money.zero(), date: null, refs: [] }));
    if (paid) r.paid = r.paid.plus(owed);
    else r.amount = r.amount.plus(owed);
    if (ref) r.refs.push(ref);
    if (date && (!r.date || date > r.date)) r.date = date;
  };
  for (const row of opts.controlRows ?? []) {
    if (!row.name?.trim() || row.posted) continue;
    const a = parseAmount(row.amount);
    if (!a) continue;
    // A/R: a debit (positive IIF amount) adds to what the customer owes. A/P: a credit does.
    touch(row.side, row.name, row.date, row.side === 'ar' ? a : a.negated(), false, row.ref ?? `${row.date}|${row.amount}`);
  }
  const kindOf = (type: string, total: Decimal): OpenItemKind => {
    if (type === 'INVOICE') return total.isNegative() ? 'credit_memo' : 'invoice';
    if (type === 'CREDIT MEMO' || type === 'CREDITMEMO') return 'credit_memo';
    if (type === 'BILL') return total.isPositive() ? 'vendor_credit' : 'bill';
    return 'vendor_credit';
  };
  // Identity of the QuickBooks document — never its open balance or PAID flag, which change
  // between exports as payments come in.
  const keyOf = (t: IIFTransaction, type: string, name: string, date: string, total: Decimal) =>
    ['doc', type, canonicalName(name).toLowerCase(), (t.num ?? '').trim(), date, toAmountString(total)].join('|');
  // Documents an earlier import already handled: they stand in once, at what the books carry.
  const seenKeys = new Set<string>();
  const earlier = async (side: LedgerSide, docKey: string) => {
    const tag = docTag(side, docKey);
    const ex = await existingDocOwed(ctx, tag);
    if (ex.count > 0 || (await openItemMarkerExists(ctx, tag))) return ex;
    return null;
  };
  const standIn = (side: LedgerSide, base: Omit<OpenItem, 'kind' | 'openBalance'>, fallbackKind: OpenItemKind, owed: Decimal) => {
    if (seenKeys.has(base.docKey!)) return;
    seenKeys.add(base.docKey!);
    const isAr = side === 'ar';
    const kind: OpenItemKind = owed.isPositive() ? (isAr ? 'invoice' : 'bill') : owed.isNegative() ? (isAr ? 'credit_memo' : 'vendor_credit') : fallbackKind;
    (isAr ? ar : ap).push({ ...base, kind, openBalance: toAmountString(owed.abs()) });
  };
  for (const t of txns) {
    const type = t.type.trim().toUpperCase();
    const label = `${t.type}${t.num ? ` #${t.num}` : ''}`;
    const docSide: LedgerSide = type === 'BILL' || type === 'BILLCRED' || type === 'BILL REFUND' ? 'ap' : 'ar';
    const date = parseQbDate(t.date);
    const total = parseAmount(t.lines[0]?.amount);
    const name = t.name ?? t.lines[0]?.name;
    const docKey = date && total && name ? keyOf(t, type, name, date, total) : null;
    const before = docKey ? await earlier(docSide, docKey) : null;
    if (before && docKey && date && total && name) {
      // Already brought in (or settled) by an earlier import: no new document, and its payments
      // from back then are not applied again. New payments in this file still reduce it.
      standIn(docSide, { name, date, number: t.num ?? null, qbType: t.type, docKey }, kindOf(type, total), before.owed);
      skipped++;
      issues.push({ entity: docSide === 'ap' ? 'bill' : 'invoice', name: label, reason: 'duplicate', message: 'Already brought in by an earlier import.' });
      continue;
    }
    if (t.paid) {
      // Not open, but its full amount still counts toward the name's balance, so the payment
      // that settled it (in controlRows) nets to zero instead of becoming a credit.
      if (total && name) touch(docSide, name, date, docSide === 'ar' ? total : total.negated(), true);
      // Zero-balance placeholder: marks the document as handled, so a later import does not
      // apply its payment again.
      if (docKey && date && total && name) {
        (docSide === 'ar' ? ar : ap).push({ kind: kindOf(type, total), name, date, number: t.num ?? null, qbType: t.type, openBalance: '0.00', docKey });
      }
      skipped++;
      issues.push({ entity: docSide === 'ap' ? 'bill' : 'invoice', name: label, reason: 'note', message: 'Marked paid in QuickBooks — not an open item, so it was not brought in.' });
      continue;
    }
    if (!date || !total || !name || !docKey) {
      skipped++;
      issues.push({ entity: 'transaction', name: label, reason: 'validation', message: 'Missing date, amount or name.' });
      continue;
    }
    const open = t.openBalance ? parseAmount(t.openBalance) : null;
    const amount = (open ?? total).abs();
    // The document counts toward the name's QuickBooks balance (owed > 0 for invoices and
    // bills, < 0 for credits); the open part is subtracted once the item exists. When the
    // export carries an open balance, only that part is owed: the rest (total - open) was
    // already applied in QuickBooks. It is counted like a PAID document — it absorbs the
    // same-file payments that settled it, but never adds a balance when they are not here.
    const owedTotal = docSide === 'ar' ? total : total.negated();
    const owedOpen = owedTotal.isNegative() ? amount.negated() : amount;
    touch(docSide, name, date, owedOpen);
    const applied = owedTotal.minus(owedOpen);
    if (!applied.isZero()) touch(docSide, name, null, applied, true);
    const kind = kindOf(type, total);
    if (amount.isZero()) {
      (docSide === 'ar' ? ar : ap).push({ kind, name, date, number: t.num ?? null, qbType: t.type, openBalance: '0.00', docKey });
      continue;
    }
    const detail = t.lines
      .slice(1)
      .map((l) => [l.item, l.memo].filter(Boolean).join(' '))
      .filter(Boolean)
      .slice(0, 5)
      .join('; ');
    (docSide === 'ar' ? ar : ap).push({
      kind,
      name,
      date,
      dueDate: t.dueDate ? parseQbDate(t.dueDate) : null,
      number: t.num ?? null,
      qbType: t.type,
      terms: t.terms ?? null,
      memo: [t.memo, detail].filter(Boolean).join(' — ') || null,
      openBalance: toAmountString(amount),
      docKey,
    });
    const isDoc = kind === 'invoice' || kind === 'bill';
    touch(docSide, name, null, isDoc ? amount.negated() : amount);
  }
  // Apply payments / credits / charges that are not part of an open document's balance.
  for (const r of residual.values()) {
    // PAID documents are settled in QuickBooks: they absorb the payments that settled them, but
    // never add a balance of their own (the payment may simply not be in this export).
    if (r.amount.isNegative() && r.paid.isPositive()) r.amount = Decimal.min(0, r.amount.plus(r.paid));
    else if (r.amount.isPositive() && r.paid.isNegative()) r.amount = Decimal.max(0, r.amount.plus(r.paid));
    if (Money.round2(r.amount).isZero()) continue;
    const added = applyResidual(r.side === 'ar' ? ar : ap, r);
    const docs = r.side === 'ar' ? 'invoices' : 'bills';
    issues.push({
      entity: r.side === 'ar' ? 'invoice' : 'bill',
      name: r.name,
      reason: 'note',
      message: r.amount.isNegative()
        ? `${toAmountString(r.amount.abs())} of payments or credits in this file was applied to the open ${docs} of ${r.name}` +
          (added.isZero() ? '.' : `; ${toAmountString(added)} more than those ${docs} was brought in as an unapplied credit.`)
        : `${toAmountString(r.amount)} of charges in this file without an open document was applied to the open credits of ${r.name}` +
          (added.isZero() ? '.' : `; ${toAmountString(added)} was brought in as an open balance.`),
    });
  }
  const out = { invoices: 0, bills: 0, credits: 0, skipped, issues };
  for (const [side, list] of [['ar', ar], ['ap', ap]] as const) {
    if (!list.length) continue;
    const r = await runConversion(ctx, side, list, { alreadyInGl: opts.alreadyInGl });
    out.invoices += r.invoices;
    out.bills += r.bills;
    out.credits += r.credits;
    // Stand-ins of documents already reported above are not counted or reported twice.
    const dups = r.issues.filter((i) => i.reason === 'duplicate').length;
    out.skipped += r.skipped - dups;
    out.issues.push(...r.issues.filter((i) => i.reason !== 'duplicate'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proof: control accounts vs aging
// ---------------------------------------------------------------------------

/**
 * A/R and A/P control accounts vs the aging reports. A/R control excludes Retainage
 * Receivable (1250), which the open-invoice aging also leaves out.
 */
export async function arApReconciliation(ctx: ServiceContext, asOf?: Date): Promise<{ ar: ReconciliationSide; ap: ReconciliationSide }> {
  const cutoff = asOf ?? new Date(Date.UTC(9999, 0, 1));
  const [arRows, apRows, arAge, apAge] = await Promise.all([
    balancesBySubtype(ctx, 'accounts_receivable'),
    balancesBySubtype(ctx, 'accounts_payable'),
    arAging(ctx, cutoff),
    apAging(ctx, cutoff),
  ]);
  const side = (rows: typeof arRows, sign: 1 | -1, agingTotal: string): ReconciliationSide => {
    const list = rows.filter((r) => r.code !== '1250').map((r) => ({ code: r.code, name: r.name, bal: sign === 1 ? r.debitBalance : r.debitBalance.negated() }));
    const control = list.reduce((s, r) => s.plus(r.bal), Money.zero());
    const aging = Money.of(agingTotal);
    const diff = control.minus(aging);
    return {
      control: toAmountString(control),
      aging: toAmountString(aging),
      difference: toAmountString(diff),
      inBalance: diff.isZero(),
      accounts: list.filter((r) => !r.bal.isZero()).map((r) => ({ code: r.code, name: r.name, balance: toAmountString(r.bal) })),
    };
  };
  return {
    ar: side(arRows, 1, arAge.totals.total),
    ap: side(apRows, -1, apAge.totals.total),
  };
}
