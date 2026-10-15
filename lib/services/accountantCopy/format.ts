/**
 * Accountant's Copy file formats (PARITY I1).
 *
 *  - Transfer file `<Company> (Accountant's Copy YYYY-MM-DD).ibac` — client → accountant.
 *    A Portable Company File (.bkp container, every table checksummed, see portableFile.ts) with
 *    one extra entry, `accountant-copy.json`, flagging it as an Accountant's Copy (copy id,
 *    dividing date). The copy's own accountant_copies row travels inside the checksummed data, so
 *    the flag can't be edited without the file failing its integrity check on open.
 *  - Changes file `<Company> (Accountant Changes YYYY-MM-DD).ibcx` — accountant → client.
 *    JSON: the delta the accountant made (journal entries, checks / expenses, accounts, classes,
 *    a note), bound to the copy by copy id + the copy's random file token, with a SHA-256 of the
 *    body so a damaged or edited file is refused.
 */
import { createHash } from 'node:crypto';
import { ServiceError } from '../errors';

export const TRANSFER_EXTENSION = 'ibac';
export const CHANGES_EXTENSION = 'ibcx';
export const TRANSFER_ENTRY = 'accountant-copy.json';
export const CHANGES_FORMAT_VERSION = 1;

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

export type TxnChange =
  | { op: 'add'; type: 'journal_entry'; id: string; after: JournalPayload }
  | { op: 'edit'; type: 'journal_entry'; id: string; baseVersion: string | null; after: JournalPayload }
  | { op: 'void'; type: 'journal_entry'; id: string; baseVersion: string | null }
  | { op: 'add'; type: 'expense'; id: string; after: ExpensePayload }
  | { op: 'edit'; type: 'expense'; id: string; baseVersion: string | null; after: ExpensePayload }
  | { op: 'void'; type: 'expense'; id: string; baseVersion: string | null };

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
const isDate = (v: unknown) => isStr(v) && /^\d{4}-\d{2}-\d{2}/.test(v);
const isVersion = (v: unknown) => v === null || isStr(v);

function journalOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !optStr(a.description) || !optStr(a.reference) || !Array.isArray(a.lines)) return false;
  return a.lines.every(
    (l) =>
      isObj(l) &&
      isStr(l.accountId) &&
      optStr(l.debit) &&
      optStr(l.credit) &&
      optStr(l.memo) &&
      optStr(l.classId) &&
      optStr(l.entityType) &&
      optStr(l.entityId),
  );
}

function expenseOk(a: unknown): boolean {
  if (!isObj(a) || !isDate(a.date) || !isStr(a.method) || !isStr(a.paymentAccountId) || !optStr(a.vendorId)) return false;
  if (!optStr(a.payeeName) || !optStr(a.reference) || !optStr(a.memo) || !Array.isArray(a.lines)) return false;
  return a.lines.every(
    (l) => isObj(l) && isStr(l.amount) && optStr(l.accountId) && optStr(l.itemId) && optStr(l.description) && optStr(l.classId),
  );
}

function txnOk(t: unknown): boolean {
  if (!isObj(t) || !isStr(t.id)) return false;
  if (t.type !== 'journal_entry' && t.type !== 'expense') return false;
  if (t.op === 'void') return isVersion(t.baseVersion);
  if (t.op !== 'add' && t.op !== 'edit') return false;
  if (t.op === 'edit' && !isVersion(t.baseVersion)) return false;
  return t.type === 'journal_entry' ? journalOk(t.after) : expenseOk(t.after);
}

function accountOk(a: unknown): boolean {
  if (!isObj(a) || !isStr(a.id) || (a.op !== 'add' && a.op !== 'edit')) return false;
  if (a.op === 'edit' && !isVersion(a.baseVersion)) return false;
  const p = a.after;
  return (
    isObj(p) &&
    isStr(p.code) &&
    isStr(p.name) &&
    isStr(p.qbType) &&
    isStr(p.subtype) &&
    optStr(p.parentId) &&
    optStr(p.description) &&
    optStr(p.taxLine) &&
    typeof p.isActive === 'boolean'
  );
}

const classOk = (c: unknown) => isObj(c) && c.op === 'add' && isStr(c.id) && isStr(c.name) && optStr(c.parentId);

function wellFormed(f: ChangesFile): boolean {
  if (!isStr(f.copyId) || !isStr(f.companyId) || !isStr(f.fileToken) || !optStr(f.note)) return false;
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
