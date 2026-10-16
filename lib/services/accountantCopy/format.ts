/**
 * Accountant's Copy file formats (PARITY I1).
 *
 *  - Transfer file `<Company> (Accountant's Copy YYYY-MM-DD).ibac` — client → accountant.
 *    A Portable Company File (.bkp container, every table checksummed, see portableFile.ts) with
 *    one extra entry, `accountant-copy.json`, flagging it as an Accountant's Copy (copy id,
 *    dividing date). The copy's own accountant_copies row travels inside the checksummed data, so
 *    the flag can't be edited without the file failing its integrity check on open.
 *  - Changes file `<Company> (Accountant Changes YYYY-MM-DD).ibcx` — accountant → client.
 *    JSON: the delta the accountant made, bound to the copy by copy id + the copy's random file
 *    token, with a SHA-256 of the body so a damaged or edited file is refused:
 *      format 2: journal entries, checks / expenses, transfers, deposits, accounts, classes, note;
 *      format 3: also new / edited customers, vendors, items and other names (`names`), sales and
 *      purchase forms, payments and inventory adjustments (`documents`), credit / journal
 *      applications (`applications`) and bank reconciliations (`reconciliations`).
 *    Format 2 files still import (the new arrays are simply empty).
 *    Every payload is checked against a declared shape (PAYLOAD_SHAPES) before any query runs:
 *    the same shape tells the import which fields are record ids (mapped to the ids of records the
 *    import creates), which are dates and which are General Journal line references.
 */
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { ServiceError } from '../errors';
import { NAME_COLUMNS } from './digest';

export const TRANSFER_EXTENSION = 'ibac';
export const CHANGES_EXTENSION = 'ibcx';
export const TRANSFER_ENTRY = 'accountant-copy.json';
/**
 * 2: transfers and deposits travel too (an older app refuses the file as "made by a newer version").
 * 3: names, sales / purchase forms, payments, applications, reconciliations (format 2 still reads).
 */
export const CHANGES_FORMAT_VERSION = 3;

export interface TransferManifest {
  app: 'ironbooks';
  kind: 'accountant-copy';
  formatVersion: number;
  copyId: string;
  companyId: string;
  companyName: string;
  dividingDate: string;
  createdAt: string;
  createdBy: string | null;
}

/** A General Journal line as carried in the changes file (ids are the accountant file's). */
export interface JournalLinePayload {
  accountId: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  classId: string | null;
  entityType: 'customer' | 'vendor' | 'employee' | 'other' | null;
  entityId: string | null;
}

export interface JournalPayload {
  /** 'YYYY-MM-DD' */
  date: string;
  description: string;
  reference: string | null;
  isAdjusting: boolean;
  lines: JournalLinePayload[];
  /** Accountant-file entry number (shown in the review only). */
  entryNumber: number;
  /** Format 3: the accountant-file id of the posted entry (maps General Journal line references). */
  postedId?: string | null;
}

export interface ExpenseLinePayload {
  accountId: string | null;
  itemId: string | null;
  quantity: string | null;
  unitCost: string | null;
  description: string | null;
  amount: string;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
  siteId?: string | null;
  binId?: string | null;
  serialNumbers?: string[] | null;
  lotNumber?: string | null;
  lotExpiration?: string | null;
}

export interface ExpensePayload {
  vendorId: string | null;
  payeeName: string | null;
  date: string;
  method: string;
  reference: string | null;
  paymentAccountId: string;
  memo: string | null;
  toPrint: boolean;
  isRefund: boolean;
  currency: string | null;
  exchangeRate: string | null;
  total: string;
  lines: ExpenseLinePayload[];
}

/** A transfer between accounts (Transfer Funds). Amounts as stored, so foreign transfers re-post the same. */
export interface TransferPayload {
  date: string;
  fromAccountId: string;
  toAccountId: string;
  /** In the FROM account's currency. */
  amount: string;
  memo: string | null;
  /** Cross-currency: what arrived in the TO account (null for home-currency transfers). */
  toAmount: string | null;
  /** Foreign transfers: the home-currency value both ledger lines carry. */
  homeAmount: string | null;
  /** Format 3: the accountant-file id of the transfer's posted entry (maps line references). */
  postedEntryId?: string | null;
}

/** A bank deposit (Make Deposits). Payment / sales-receipt ids are the same records in both files. */
export interface DepositPayload {
  date: string;
  depositAccountId: string;
  memo: string | null;
  /** Foreign bank account: home units per 1 unit. */
  exchangeRate: string | null;
  /** Net amount that reached the bank (review display; recomputed on import). */
  total: string;
  paymentIds: string[];
  salesReceiptIds: string[];
  /**
   * Invoices whose payment-item lines (money recorded on the invoice itself, in Undeposited
   * Funds) the deposit holds. Optional: older files have none, and it is left out when empty.
   */
  invoicePaymentIds?: string[];
  extraLines: Array<{ accountId: string; amount: string; description: string | null }>;
  cashBack: { accountId: string; amount: string; memo: string | null } | null;
}

type TxnPayloads = { journal_entry: JournalPayload; expense: ExpensePayload; transfer: TransferPayload; deposit: DepositPayload };
export type TxnType = keyof TxnPayloads;

type TxnChangeOf<T extends TxnType> =
  | { op: 'add'; type: T; id: string; after: TxnPayloads[T] }
  | { op: 'edit'; type: T; id: string; baseVersion: string | null; after: TxnPayloads[T] }
  | { op: 'void'; type: T; id: string; baseVersion: string | null };

export type TxnChange = TxnChangeOf<'journal_entry'> | TxnChangeOf<'expense'> | TxnChangeOf<'transfer'> | TxnChangeOf<'deposit'>;

export interface AccountPayload {
  code: string;
  name: string;
  qbType: string;
  subtype: string;
  parentId: string | null;
  description: string | null;
  taxLine: string | null;
  isActive: boolean;
}

export type AccountChange =
  | { op: 'add'; id: string; after: AccountPayload }
  | { op: 'edit'; id: string; baseVersion: string | null; after: AccountPayload };

export interface ClassChange {
  op: 'add';
  id: string;
  name: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// Format 3: names, documents, applications, reconciliations
// ---------------------------------------------------------------------------

/**
 * A General Journal line as the accountant's file knows it. Lines of records that existed when the
 * copy was made keep their id in the client's file; lines of entries the accountant posted (or
 * re-posted) are found on import from the record that owns the entry (mapped to the record the
 * import created) and the line's account / amount / name.
 */
export interface LineRef {
  lineId: string;
  entryId: string;
  sourceRef: string | null;
  /** 'YYYY-MM-DD…' of the entry. */
  date: string;
  accountId: string;
  debit: string | null;
  credit: string | null;
  entityId: string | null;
  /** The record whose posting this is ('journal_entry', 'transfer', 'invoice', 'payment_received', …). */
  owner: { type: string; id: string } | null;
}

export type NameType = 'customer' | 'vendor' | 'item' | 'other_name';
export type NameChange =
  | { op: 'add'; type: NameType; id: string; after: Record<string, unknown> }
  | {
      op: 'edit';
      type: NameType;
      id: string;
      baseVersion: string | null;
      baseDigest: string | null;
      after: Record<string, unknown>;
      /**
       * The fields the accountant changed (NAME_COLUMNS keys). Only these are applied, and the
       * client's own edits of OTHER fields of the same record are not a conflict. Absent in files
       * from copies made before it existed: the whole record is compared then.
       */
      fields?: string[];
    };

export type DocType =
  | 'invoice'
  | 'sales_receipt'
  | 'credit_memo'
  | 'payment_received'
  | 'bill'
  | 'bill_payment'
  | 'vendor_credit'
  | 'item_receipt'
  | 'estimate'
  | 'sales_order'
  | 'purchase_order'
  | 'inventory_adjustment';

export type DocChange =
  | { op: 'add'; type: DocType; id: string; after: Record<string, unknown> }
  | { op: 'edit'; type: DocType; id: string; baseVersion: string | null; baseDigest: string | null; after: Record<string, unknown> }
  | { op: 'void'; type: DocType; id: string; baseVersion: string | null; baseDigest: string | null };

export type ApplicationChange =
  /** A credit memo applied to an invoice outside Receive Payments (id: the application). */
  | { op: 'apply'; kind: 'credit_memo'; id: string; creditMemoId: string; invoiceId: string; amount: string; date: string }
  /** id: the client's application (it existed when the copy was made). */
  | { op: 'unapply'; kind: 'credit_memo'; id: string; creditMemoId: string; invoiceId: string; amount: string; date: string }
  /** Net vendor credit applied to / taken off a bill (id: the vendor credit). */
  | { op: 'apply' | 'unapply'; kind: 'vendor_credit'; id: string; vendorCreditId: string; billId: string; amount: string; date: string }
  /** A General Journal credit applied to an invoice, a bill or a General Journal charge (id: the application). */
  | {
      op: 'apply';
      kind: 'journal';
      id: string;
      line: LineRef;
      invoiceId: string | null;
      billId: string | null;
      chargeLine: LineRef | null;
      amount: string;
      date: string;
    }
  /** id: the client's application. */
  | { op: 'unapply'; kind: 'journal'; id: string; amount: string; date: string };

export type ReconciliationChange =
  | {
      op: 'reconcile';
      /** The accountant-file reconciliation. */
      id: string;
      /** GL account of the bank / credit card account. */
      accountId: string;
      statementDate: string;
      statementBalance: string;
      cleared: LineRef[];
      serviceCharge: { amount: string; accountId: string } | null;
      interestEarned: { amount: string; accountId: string } | null;
    }
  /** Undo Last Reconciliation of a reconciliation that existed when the copy was made. */
  | { op: 'undo'; id: string; accountId: string; statementDate: string; statementBalance: string };

export interface ChangesFileBody {
  app: 'ironbooks';
  kind: 'accountant-changes';
  formatVersion: number;
  copyId: string;
  companyId: string;
  companyName: string;
  fileToken: string;
  dividingDate: string;
  createdAt: string;
  preparedBy: string | null;
  note: string | null;
  accounts: AccountChange[];
  classes: ClassChange[];
  transactions: TxnChange[];
  /** Format 3 (absent in format 2 files; read as []). */
  names: NameChange[];
  documents: DocChange[];
  applications: ApplicationChange[];
  reconciliations: ReconciliationChange[];
  /** Changes made in the copy that the file can't carry (shown to the client in the review). */
  warnings: string[];
}

export interface ChangesFile extends ChangesFileBody {
  sha256: string;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function serializeChangesFile(body: ChangesFileBody): Buffer {
  const text = JSON.stringify(body);
  const file: ChangesFile = { ...body, sha256: sha256(text) };
  return Buffer.from(JSON.stringify(file, null, 2), 'utf8');
}

const notChanges = (detail: string) =>
  new ServiceError('VALIDATION', `This is not an Ironbooks accountant's changes file (.${CHANGES_EXTENSION}): ${detail}.`);

/** Parse + integrity-check a changes file. */
export function parseChangesFile(buffer: Buffer): ChangesFile {
  let parsed: ChangesFile;
  try {
    parsed = JSON.parse(buffer.toString('utf8')) as ChangesFile;
  } catch {
    throw notChanges('it could not be read');
  }
  if (!parsed || parsed.app !== 'ironbooks' || parsed.kind !== 'accountant-changes') {
    throw notChanges('it does not identify itself as one');
  }
  if (typeof parsed.formatVersion !== 'number' || parsed.formatVersion > CHANGES_FORMAT_VERSION) {
    throw new ServiceError(
      'VALIDATION',
      "This changes file was made by a newer version of Ironbooks. Update the app, then import it.",
    );
  }
  const { sha256: claimed, ...body } = parsed;
  // Re-serialize in the original key order (JSON.stringify of the parsed body keeps it).
  if (typeof claimed !== 'string' || sha256(JSON.stringify(body)) !== claimed) {
    throw new ServiceError(
      'VALIDATION',
      'The changes file failed its integrity check (it was damaged or edited after your accountant saved it). Ask your accountant to send it again.',
    );
  }
  for (const k of ['accounts', 'classes', 'transactions', 'warnings'] as const) {
    if (!Array.isArray(parsed[k])) throw notChanges(`"${k}" is missing`);
  }
  for (const k of ['names', 'documents', 'applications', 'reconciliations'] as const) {
    // Format 2 files have none of these (they were made before the file could carry them).
    if (parsed.formatVersion < 3 && parsed[k] === undefined) parsed[k] = [];
    if (!Array.isArray(parsed[k])) throw notChanges(`"${k}" is missing`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.dividingDate ?? '')) throw notChanges('the dividing date is missing');
  if (!wellFormed(parsed)) throw notChanges('it is incomplete');
  const costError = inventoryCostProblem(parsed.documents);
  if (costError) {
    throw new ServiceError('VALIDATION', `The changes file can't be imported: ${costError}. Nothing was imported.`);
  }
  return parsed;
}

const COST_DOC_NAME: Partial<Record<DocType, string>> = {
  invoice: 'invoice',
  sales_receipt: 'sales receipt',
  credit_memo: 'credit memo',
  inventory_adjustment: 'inventory adjustment',
};

/**
 * The accountant's inventory costs (a line's `cost`, a removal's `total`) are amounts the import
 * values stock with, so they must make sense before anything is applied: never negative, and only
 * on a line that sells an item (invoice, sales receipt) or restocks one (credit memo, restock
 * ticked). Returns the failing change, described, or null.
 */
export function inventoryCostProblem(documents: DocChange[]): string | null {
  for (const d of documents) {
    if (d.op === 'void') continue;
    const name = COST_DOC_NAME[d.type];
    const ref = d.after.refNumber ? ` #${String(d.after.refNumber)}` : '';
    const what = `the ${d.op === 'add' ? 'new' : 'changed'} ${name ?? d.type.replace(/_/g, ' ')}${ref} dated ${String(d.after.date).slice(0, 10)}`;
    if (d.type === 'inventory_adjustment') {
      if (isDec(d.after.total) && new Decimal(d.after.total).isNegative()) return `${what} has a negative value (${d.after.total})`;
      continue;
    }
    const lines = Array.isArray(d.after.lines) ? (d.after.lines as Rec[]) : [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.cost === undefined || l.cost === null) continue;
      const at = `line ${i + 1} of ${what}`;
      if (!name) return `${at} carries an inventory cost, which only a sale or a credit memo restock can`;
      if (!isId(l.itemId)) return `${at} carries an inventory cost but no item`;
      if (d.type === 'credit_memo' && l.restock !== true) return `${at} carries an inventory cost but does not restock the item`;
      if (isDec(l.cost) && new Decimal(l.cost).isNegative()) return `${at} has a negative inventory cost (${l.cost})`;
    }
  }
  return null;
}

// ---- Structural checks (a file can pass its checksum and still be malformed) ----

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const isDate = (v: unknown) => isStr(v) && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(new Date(v).getTime());
const isVersion = (v: unknown) => v === null || (isStr(v) && !isNaN(new Date(v).getTime()));
/** Record ids are UUIDs (anything else would reach a uuid query and crash it). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const optId = (v: unknown) => v === undefined || v === null || isId(v);
/** Money / quantity as a plain decimal string ("12.34", "-5", "0.0001"). */
const DEC_RE = /^-?\d{1,13}(\.\d{1,8})?$/;
const isDec = (v: unknown): v is string => isStr(v) && DEC_RE.test(v);
const optDec = (v: unknown) => v === undefined || v === null || isDec(v);
const idList = (v: unknown) => Array.isArray(v) && v.every(isId);

function journalOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !optStr(a.description) || !optStr(a.reference) || !Array.isArray(a.lines)) return false;
  return a.lines.every(
    (l) =>
      isObj(l) &&
      isId(l.accountId) &&
      optDec(l.debit) &&
      optDec(l.credit) &&
      optStr(l.memo) &&
      optId(l.classId) &&
      optStr(l.entityType) &&
      optId(l.entityId),
  ) && optId(a.postedId);
}

function expenseOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !isStr(a.method) || !isId(a.paymentAccountId) || !optId(a.vendorId)) return false;
  if (!optStr(a.payeeName) || !optStr(a.reference) || !optStr(a.memo) || !isDec(a.total) || !optDec(a.exchangeRate)) return false;
  if (!Array.isArray(a.lines)) return false;
  return a.lines.every(
    (l) =>
      isObj(l) &&
      isDec(l.amount) &&
      optId(l.accountId) &&
      optId(l.itemId) &&
      optDec(l.quantity) &&
      optDec(l.unitCost) &&
      optStr(l.description) &&
      optId(l.classId) &&
      optId(l.customerId) &&
      optId(l.jobId) &&
      optId(l.siteId) &&
      optId(l.binId) &&
      (l.serialNumbers === undefined || l.serialNumbers === null || (Array.isArray(l.serialNumbers) && l.serialNumbers.every(isStr))) &&
      optStr(l.lotNumber) &&
      (l.lotExpiration === undefined || l.lotExpiration === null || isDate(l.lotExpiration)),
  );
}

function transferOk(a: unknown): boolean {
  return (
    isObj(a) &&
    isDate(a.date) &&
    isId(a.fromAccountId) &&
    isId(a.toAccountId) &&
    isDec(a.amount) &&
    optStr(a.memo) &&
    optDec(a.toAmount) &&
    optDec(a.homeAmount) &&
    optId(a.postedEntryId)
  );
}

function depositOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !isId(a.depositAccountId) || !optStr(a.memo) || !optDec(a.exchangeRate) || !isDec(a.total)) return false;
  if (!idList(a.paymentIds) || !idList(a.salesReceiptIds) || !Array.isArray(a.extraLines)) return false;
  if (a.invoicePaymentIds !== undefined && !idList(a.invoicePaymentIds)) return false;
  if (!a.extraLines.every((l) => isObj(l) && isId(l.accountId) && isDec(l.amount) && optStr(l.description))) return false;
  const cb = a.cashBack;
  return cb === null || cb === undefined || (isObj(cb) && isId(cb.accountId) && isDec(cb.amount) && optStr(cb.memo));
}

const PAYLOAD_OK: Record<TxnType, (a: unknown) => boolean> = {
  journal_entry: journalOk,
  expense: expenseOk,
  transfer: transferOk,
  deposit: depositOk,
};

function txnOk(t: unknown): boolean {
  if (!isObj(t) || !isId(t.id)) return false;
  if (!isStr(t.type) || !Object.prototype.hasOwnProperty.call(PAYLOAD_OK, t.type)) return false;
  if (t.op === 'void') return isVersion(t.baseVersion);
  if (t.op !== 'add' && t.op !== 'edit') return false;
  if (t.op === 'edit' && !isVersion(t.baseVersion)) return false;
  return PAYLOAD_OK[t.type as TxnType](t.after);
}

function accountOk(a: unknown): boolean {
  if (!isObj(a) || !isId(a.id) || (a.op !== 'add' && a.op !== 'edit')) return false;
  if (a.op === 'edit' && !isVersion(a.baseVersion)) return false;
  const p = a.after;
  return (
    isObj(p) &&
    isStr(p.code) &&
    isStr(p.name) &&
    isStr(p.qbType) &&
    isStr(p.subtype) &&
    optId(p.parentId) &&
    optStr(p.description) &&
    optStr(p.taxLine) &&
    typeof p.isActive === 'boolean'
  );
}

const classOk = (c: unknown) => isObj(c) && c.op === 'add' && isId(c.id) && isStr(c.name) && optId(c.parentId);

// ---------------------------------------------------------------------------
// Declared payload shapes (format 3)
// ---------------------------------------------------------------------------

/**
 * One field of a payload: 'id' (record id, mapped on import), 'dec' (decimal string), 'date'
 * (ISO date, a Date on import), 'str', 'bool', 'strmap' (an address / custom fields object of
 * strings), 'strs' (list of strings), 'ids' (list of record ids), 'lineRef' (a General Journal line,
 * resolved on import); a trailing '?' allows null / missing. { arr } is a list of objects,
 * { obj } one object (optional with opt: true).
 */
export type FieldSpec =
  | 'id' | 'id?' | 'dec' | 'dec?' | 'date' | 'date?' | 'str' | 'str?' | 'bool' | 'bool?'
  | 'strmap?' | 'strs?' | 'ids?' | 'lineRef' | 'lineRef?'
  | { arr: Shape; opt?: boolean }
  | { obj: Shape; opt?: boolean };
export type Shape = { readonly [key: string]: FieldSpec };

const isStrMap = (v: unknown) => isObj(v) && Object.values(v).every((x) => typeof x === 'string' || typeof x === 'boolean' || x === null);

export const LINE_REF_SHAPE: Shape = {
  lineId: 'id',
  entryId: 'id',
  sourceRef: 'str?',
  date: 'date',
  accountId: 'id',
  debit: 'dec?',
  credit: 'dec?',
  entityId: 'id?',
  owner: { obj: { type: 'str', id: 'id' }, opt: true },
};

/** True when `v` matches `shape` exactly (no unknown keys, every field of the right kind). */
export function matchesShape(v: unknown, shape: Shape): boolean {
  if (!isObj(v)) return false;
  for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(shape, k)) return false;
  for (const [k, spec] of Object.entries(shape)) {
    if (!fieldOk(v[k], spec)) return false;
  }
  return true;
}

function fieldOk(v: unknown, spec: FieldSpec): boolean {
  if (typeof spec === 'object') {
    if ('arr' in spec) {
      if (spec.opt && (v === undefined || v === null)) return true;
      return Array.isArray(v) && v.every((x) => matchesShape(x, spec.arr));
    }
    if (spec.opt && (v === undefined || v === null)) return true;
    return matchesShape(v, spec.obj);
  }
  const optional = spec.endsWith('?');
  if (optional && (v === undefined || v === null)) return true;
  switch (spec.replace('?', '')) {
    case 'id':
      return isId(v);
    case 'dec':
      return isDec(v);
    case 'date':
      return isDate(v);
    case 'str':
      return isStr(v);
    case 'bool':
      return typeof v === 'boolean';
    case 'strmap':
      return isStrMap(v);
    case 'strs':
      return Array.isArray(v) && v.every(isStr);
    case 'ids':
      return idList(v);
    case 'lineRef':
      return matchesShape(v, LINE_REF_SHAPE);
    default:
      return false;
  }
}

/** Inventory site / bin / serial / lot of a document line (InventoryLineDetail). */
const INV: Shape = { siteId: 'id?', binId: 'id?', serialNumbers: 'strs?', lotNumber: 'str?', lotExpiration: 'date?' };
const JOURNAL_ITEM: Shape = { line: 'lineRef', amount: 'dec' };
const JOURNAL_OFFSET: Shape = { line: 'lineRef', chargeLine: 'lineRef', amount: 'dec' };

/**
 * Sales lines (invoice, sales receipt) and restocked credit memo lines of inventory items carry
 * `cost`: what the accountant's file posted for the line (COGS / restock value). The import costs
 * the line at that amount (inventoryCost.ts), not at the client's current average cost. A quantity
 * removal (inventory adjustment) is likewise taken out at its `total`.
 */
export const DOC_SHAPES: Record<DocType, Shape> = {
  invoice: {
    refNumber: 'str?', customerId: 'id', date: 'date', dueDate: 'date?', terms: 'str?', taxRateId: 'id?', classId: 'id?',
    jobId: 'id?', salesRepId: 'id?', discount: 'dec?', discountType: 'str?', retainagePercent: 'dec?', memo: 'str?',
    currency: 'str?', exchangeRate: 'dec?', status: 'str', customFields: 'strmap?', shipDate: 'date?', shipVia: 'str?',
    fob: 'str?', trackingNumber: 'str?', shipTo: 'strmap?', poNumber: 'str?', toBePrinted: 'bool?', toBeEmailed: 'bool?',
    isStatementCharge: 'bool?', total: 'dec',
    lines: {
      arr: {
        itemId: 'id?', accountId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec?', taxable: 'bool?',
        taxRateId: 'id?', classId: 'id?', jobId: 'id?', estimateLineId: 'id?', cost: 'dec?', ...INV,
      },
    },
  },
  sales_receipt: {
    refNumber: 'str?', customerId: 'id?', date: 'date', taxRateId: 'id?', depositAccountId: 'id?', method: 'str?',
    reference: 'str?', memo: 'str?', classId: 'id?', shipDate: 'date?', shipVia: 'str?', fob: 'str?',
    trackingNumber: 'str?', shipTo: 'strmap?', poNumber: 'str?', toBePrinted: 'bool?', toBeEmailed: 'bool?', total: 'dec',
    lines: {
      arr: { itemId: 'id?', accountId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec?', taxable: 'bool?', taxRateId: 'id?', cost: 'dec?', ...INV },
    },
  },
  credit_memo: {
    refNumber: 'str?', customerId: 'id', date: 'date', taxRateId: 'id?', memo: 'str?', toBePrinted: 'bool?',
    toBeEmailed: 'bool?', total: 'dec',
    lines: {
      arr: { itemId: 'id?', accountId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec?', taxable: 'bool?', restock: 'bool?', cost: 'dec?', ...INV },
    },
  },
  payment_received: {
    customerId: 'id', date: 'date', method: 'str', reference: 'str?', amount: 'dec', depositAccountId: 'id?',
    discountAccountId: 'id?', memo: 'str?', currency: 'str?', exchangeRate: 'dec?',
    applications: { arr: { invoiceId: 'id', amountApplied: 'dec', discountAmount: 'dec?' } },
    credits: { arr: { creditMemoId: 'id', invoiceId: 'id', amount: 'dec' } },
    journalItems: { arr: JOURNAL_ITEM },
    journalCredits: { arr: { line: 'lineRef', invoiceId: 'id', amount: 'dec' } },
    journalOffsets: { arr: JOURNAL_OFFSET },
  },
  bill: {
    vendorId: 'id', billNumber: 'str?', date: 'date', dueDate: 'date?', terms: 'str?', memo: 'str?', classId: 'id?',
    currency: 'str?', exchangeRate: 'dec?', total: 'dec',
    lines: {
      arr: {
        accountId: 'id?', itemId: 'id?', description: 'str?', quantity: 'dec?', unitCost: 'dec?', amount: 'dec?',
        classId: 'id?', customerId: 'id?', jobId: 'id?', ...INV,
      },
    },
  },
  bill_payment: {
    vendorId: 'id', date: 'date', method: 'str', reference: 'str?', paymentAccountId: 'id', discountAccountId: 'id?',
    toPrint: 'bool?', exchangeRate: 'dec?', amount: 'dec',
    applications: { arr: { billId: 'id', amountApplied: 'dec', discountTaken: 'dec?' } },
    journalItems: { arr: JOURNAL_ITEM },
    journalCredits: { arr: { line: 'lineRef', billId: 'id', amount: 'dec' } },
    journalOffsets: { arr: JOURNAL_OFFSET },
  },
  vendor_credit: {
    vendorId: 'id', date: 'date', memo: 'str?', refNumber: 'str?', currency: 'str?', exchangeRate: 'dec?', total: 'dec',
    lines: {
      arr: {
        accountId: 'id?', itemId: 'id?', quantity: 'dec?', unitCost: 'dec?', description: 'str?', amount: 'dec?',
        classId: 'id?', customerId: 'id?', jobId: 'id?',
      },
    },
  },
  item_receipt: {
    vendorId: 'id', date: 'date', reference: 'str?', memo: 'str?', purchaseOrderId: 'id?', total: 'dec',
    lines: { arr: { itemId: 'id', description: 'str?', quantity: 'dec', unitCost: 'dec', ...INV } },
  },
  estimate: {
    refNumber: 'str?', customerId: 'id', date: 'date', expirationDate: 'date?', taxRateId: 'id?', memo: 'str?',
    shipTo: 'strmap?', toBePrinted: 'bool?', toBeEmailed: 'bool?', status: 'str', total: 'dec',
    // Line ids (the accountant file's): an invoice line made in the copy may bill an estimate line
    // made there; the import maps them to the client's new lines by position.
    lines: { arr: { id: 'id?', itemId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec?', taxable: 'bool?', classId: 'id?' } },
  },
  sales_order: {
    refNumber: 'str?', customerId: 'id', date: 'date', memo: 'str?', taxRateId: 'id?', shipDate: 'date?', shipVia: 'str?',
    fob: 'str?', trackingNumber: 'str?', shipTo: 'strmap?', poNumber: 'str?', toBePrinted: 'bool?', toBeEmailed: 'bool?',
    status: 'str', total: 'dec',
    lines: { arr: { id: 'id?', itemId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec?', taxable: 'bool?' } },
  },
  purchase_order: {
    refNumber: 'str?', vendorId: 'id', date: 'date', expectedDate: 'date?', memo: 'str?', status: 'str', total: 'dec',
    lines: { arr: { id: 'id?', itemId: 'id?', accountId: 'id?', description: 'str?', quantity: 'dec', rate: 'dec' } },
  },
  inventory_adjustment: {
    itemId: 'id', quantityChange: 'dec', unitCost: 'dec?', date: 'date', memo: 'str?', adjustmentAccountId: 'id?',
    classId: 'id?', customerId: 'id?', jobId: 'id?', total: 'dec', ...INV,
  },
};

/** One of a customer's ship-to addresses (lib/shipTo.ts). */
const SHIP_TO: Shape = {
  name: 'str', line1: 'str?', line2: 'str?', city: 'str?', state: 'str?', zip: 'str?', country: 'str?', isDefault: 'bool?',
};

export const NAME_SHAPES: Record<NameType, Shape> = {
  customer: {
    displayName: 'str', companyName: 'str?', email: 'str?', phone: 'str?', billingAddress: 'strmap?',
    shippingAddress: 'strmap?', terms: 'str?', termsId: 'id?', creditLimit: 'dec?', taxable: 'bool?', taxRateId: 'id?',
    salesTaxCodeId: 'id?', resaleNumber: 'str?', taxExemptionReason: 'str?', notes: 'str?',
    customFields: 'strmap?', customerTypeId: 'id?',
    // New customers only (a job's place in the customer list, its price level and ship-to list are
    // structural: guard.ts refuses changing them in the copy).
    parentId: 'id?', priceLevelId: 'id?', shipToAddresses: { arr: SHIP_TO, opt: true },
  },
  vendor: {
    displayName: 'str', companyName: 'str?', email: 'str?', phone: 'str?', address: 'strmap?', terms: 'str?',
    termsId: 'id?', is1099: 'bool?', defaultExpenseAccountId: 'id?', notes: 'str?', printOnCheckAs: 'str?',
    accountNumber: 'str?', prefillAccountIds: 'ids?', customFields: 'strmap?',
    // New vendors only.
    currency: 'str?',
  },
  item: {
    name: 'str', sku: 'str?', description: 'str?', salesPrice: 'dec?', purchaseCost: 'dec?', taxable: 'bool?',
    salesTaxCodeId: 'id?', unitOfMeasure: 'str?', barcode: 'str?', weight: 'dec?', preferredVendorId: 'id?',
    reorderPoint: 'dec?', customFields: 'strmap?',
    // New items only (type, accounts and tracking are structural).
    type: 'str?', incomeAccountId: 'id?', expenseAccountId: 'id?', assetAccountId: 'id?', trackingMode: 'str?', uomSetId: 'id?',
  },
  other_name: {
    name: 'str', companyName: 'str?', email: 'str?', phone: 'str?', address: 'strmap?', accountNumber: 'str?', notes: 'str?',
  },
};

/** Fields a new name / item may carry but an edit may not (QB: hierarchy, type, accounts, currency). */
export const NAME_ADD_ONLY: Record<NameType, readonly string[]> = {
  customer: ['parentId', 'priceLevelId', 'shipToAddresses'],
  vendor: ['currency'],
  item: ['type', 'incomeAccountId', 'expenseAccountId', 'assetAccountId', 'trackingMode', 'uomSetId'],
  other_name: [],
};

const isBaseDigest = (v: unknown) => v === null || isStr(v);

function nameOk(n: unknown): boolean {
  if (!isObj(n) || !isId(n.id) || !isStr(n.type) || !Object.prototype.hasOwnProperty.call(NAME_SHAPES, n.type)) return false;
  const type = n.type as NameType;
  if (n.op === 'edit') {
    if (!isVersion(n.baseVersion) || !isBaseDigest(n.baseDigest)) return false;
    if (isObj(n.after) && NAME_ADD_ONLY[type].some((k) => (n.after as Rec)[k] !== undefined)) return false;
    if (n.fields !== undefined) {
      const cols = NAME_COLUMNS[type].cols;
      if (!Array.isArray(n.fields) || !n.fields.every((k) => isStr(k) && Object.prototype.hasOwnProperty.call(cols, k))) return false;
    }
  } else if (n.op !== 'add') return false;
  return matchesShape(n.after, NAME_SHAPES[type]);
}

function docOk(d: unknown): boolean {
  if (!isObj(d) || !isId(d.id) || !isStr(d.type) || !Object.prototype.hasOwnProperty.call(DOC_SHAPES, d.type)) return false;
  if (d.op === 'void') return isVersion(d.baseVersion) && isBaseDigest(d.baseDigest) && d.after === undefined;
  if (d.op === 'edit') {
    if (!isVersion(d.baseVersion) || !isBaseDigest(d.baseDigest)) return false;
  } else if (d.op !== 'add') return false;
  return matchesShape(d.after, DOC_SHAPES[d.type as DocType]);
}

const APPLICATION_SHAPES: Record<string, Shape> = {
  credit_memo: { op: 'str', kind: 'str', id: 'id', creditMemoId: 'id', invoiceId: 'id', amount: 'dec', date: 'date' },
  vendor_credit: { op: 'str', kind: 'str', id: 'id', vendorCreditId: 'id', billId: 'id', amount: 'dec', date: 'date' },
  journal_apply: {
    op: 'str', kind: 'str', id: 'id', line: 'lineRef', invoiceId: 'id?', billId: 'id?', chargeLine: 'lineRef?', amount: 'dec', date: 'date',
  },
  journal_unapply: { op: 'str', kind: 'str', id: 'id', amount: 'dec', date: 'date' },
};

function applicationOk(a: unknown): boolean {
  if (!isObj(a) || (a.op !== 'apply' && a.op !== 'unapply')) return false;
  if (a.kind === 'credit_memo' || a.kind === 'vendor_credit') return matchesShape(a, APPLICATION_SHAPES[a.kind]);
  if (a.kind !== 'journal') return false;
  if (a.op === 'unapply') return matchesShape(a, APPLICATION_SHAPES.journal_unapply);
  if (!matchesShape(a, APPLICATION_SHAPES.journal_apply)) return false;
  // Exactly one target: an invoice, a bill or a General Journal charge.
  return [a.invoiceId, a.billId, a.chargeLine].filter((x) => x !== null && x !== undefined).length === 1;
}

const ADJUSTMENT: FieldSpec = { obj: { amount: 'dec', accountId: 'id' }, opt: true };
const RECONCILE_SHAPE: Shape = {
  op: 'str', id: 'id', accountId: 'id', statementDate: 'date', statementBalance: 'dec',
  cleared: { arr: LINE_REF_SHAPE }, serviceCharge: ADJUSTMENT, interestEarned: ADJUSTMENT,
};
const UNDO_SHAPE: Shape = { op: 'str', id: 'id', accountId: 'id', statementDate: 'date', statementBalance: 'dec' };

function reconciliationOk(r: unknown): boolean {
  if (!isObj(r)) return false;
  if (r.op === 'reconcile') return matchesShape(r, RECONCILE_SHAPE);
  if (r.op === 'undo') return matchesShape(r, UNDO_SHAPE);
  return false;
}

function wellFormed(f: ChangesFile): boolean {
  if (!isId(f.copyId) || !isId(f.companyId) || !isStr(f.fileToken) || !optStr(f.note) || !optStr(f.preparedBy)) return false;
  return (
    f.transactions.every(txnOk) &&
    f.accounts.every(accountOk) &&
    f.classes.every(classOk) &&
    f.names.every(nameOk) &&
    f.documents.every(docOk) &&
    f.applications.every(applicationOk) &&
    f.reconciliations.every(reconciliationOk) &&
    f.warnings.every(isStr)
  );
}

/** Filesystem-safe base name for the company. */
export function safeCompanyName(name: string): string {
  return (name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim() || 'Company').slice(0, 100);
}
