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
  return parsed;
}

/** Filesystem-safe base name for the company. */
export function safeCompanyName(name: string): string {
  return (name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim() || 'Company').slice(0, 100);
}
