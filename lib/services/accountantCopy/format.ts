/**
 * Accountant's Copy file formats (PARITY I1).
 *
 *  - Transfer file `<Company> (Accountant's Copy YYYY-MM-DD).ibac` — client → accountant.
 *    A Portable Company File (.bkp container, every table checksummed, see portableFile.ts) with
 *    one extra entry, `accountant-copy.json`, flagging it as an Accountant's Copy (copy id,
 *    dividing date). The copy's own accountant_copies row travels inside the checksummed data, so
 *    the flag can't be edited without the file failing its integrity check on open.
 *  - Changes file `<Company> (Accountant Changes YYYY-MM-DD).ibcx` — accountant → client.
 *    JSON: the delta the accountant made (journal entries, checks / expenses, transfers,
 *    deposits, accounts, classes, a note), bound to the copy by copy id + the copy's random file token, with a SHA-256 of the
 *    body so a damaged or edited file is refused.
 */
import { createHash } from 'node:crypto';
import { ServiceError } from '../errors';

export const TRANSFER_EXTENSION = 'ibac';
export const CHANGES_EXTENSION = 'ibcx';
export const TRANSFER_ENTRY = 'accountant-copy.json';
/** 2: transfers and deposits travel too (an older app refuses the file as "made by a newer version"). */
export const CHANGES_FORMAT_VERSION = 2;

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.dividingDate ?? '')) throw notChanges('the dividing date is missing');
  if (!wellFormed(parsed)) throw notChanges('it is incomplete');
  return parsed;
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
  );
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
      optId(l.binId),
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
    optDec(a.homeAmount)
  );
}

function depositOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !isId(a.depositAccountId) || !optStr(a.memo) || !optDec(a.exchangeRate) || !isDec(a.total)) return false;
  if (!idList(a.paymentIds) || !idList(a.salesReceiptIds) || !Array.isArray(a.extraLines)) return false;
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

function wellFormed(f: ChangesFile): boolean {
  if (!isId(f.copyId) || !isId(f.companyId) || !isStr(f.fileToken) || !optStr(f.note) || !optStr(f.preparedBy)) return false;
  return (
    f.transactions.every(txnOk) &&
    f.accounts.every(accountOk) &&
    f.classes.every(classOk) &&
    f.warnings.every(isStr)
  );
}

/** Filesystem-safe base name for the company. */
export function safeCompanyName(name: string): string {
  return (name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim() || 'Company').slice(0, 100);
}
