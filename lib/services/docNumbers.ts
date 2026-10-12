/**
 * Alphanumeric document numbers (QuickBooks "Invoice #", "P.O. No." ...).
 *
 * Every numbered sales / purchase document carries a text `ref_number` (e.g. "INV-1001") next
 * to its legacy integer column. drizzle/0025 back-filled ref_number from the integers and a
 * BEFORE INSERT/UPDATE trigger copies the integer into ref_number whenever a writer leaves it
 * blank, so services that predate this module keep working unchanged.
 *
 * QB behaviour implemented here:
 *  - the next number is the LAST number used with its trailing digits incremented, keeping
 *    leading zeros and any prefix ("INV-0999" → "INV-1000", "2026-17" → "2026-18");
 *  - the user can type any number instead (override);
 *  - a starting number can be set per document type (Preferences); it is used until taken;
 *  - re-using a number of the same document type is refused (CONFLICT) unless the caller
 *    explicitly allows the duplicate after warning the user.
 *
 * Sales / purchases services: call `allocateDocNumber(ctx, docType, input.refNumber)` inside
 * the create transaction and store BOTH returned values (refNumber + the integer `number`).
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  companies,
  creditMemos,
  estimates,
  invoices,
  purchaseOrders,
  salesOrders,
  salesReceipts,
} from '@/lib/db/schema';
import { type ServiceContext, ServiceError, validation, writeAudit } from './_base';
import { resolveCompanyPreferences } from '@/lib/preferences';

export const DOC_TYPES = [
  'invoice',
  'estimate',
  'sales_order',
  'sales_receipt',
  'credit_memo',
  'purchase_order',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  sales_order: 'Sales Order',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  purchase_order: 'Purchase Order',
};

/**
 * The number the user sees for a document: its typed ref number ("JOB-ALPHA", "INV-1001"),
 * falling back to the legacy integer for rows written before ref numbers existed.
 */
export function docRef(refNumber: string | null | undefined, legacyNumber: number | string | null | undefined): string {
  const typed = refNumber?.trim();
  if (typed) return typed;
  return legacyNumber === null || legacyNumber === undefined ? '' : String(legacyNumber);
}

/** Longest document number accepted (column is varchar(50)). */
export const MAX_DOC_NUMBER_LENGTH = 50;

/* eslint-disable @typescript-eslint/no-explicit-any */
function docTable(docType: DocType): { table: any; id: any; companyId: any; num: any; ref: any; createdAt: any } {
  switch (docType) {
    case 'invoice':
      return { table: invoices, id: invoices.id, companyId: invoices.companyId, num: invoices.invoiceNumber, ref: invoices.refNumber, createdAt: invoices.createdAt };
    case 'estimate':
      return { table: estimates, id: estimates.id, companyId: estimates.companyId, num: estimates.estimateNumber, ref: estimates.refNumber, createdAt: estimates.createdAt };
    case 'sales_order':
      return { table: salesOrders, id: salesOrders.id, companyId: salesOrders.companyId, num: salesOrders.orderNumber, ref: salesOrders.refNumber, createdAt: salesOrders.createdAt };
    case 'sales_receipt':
      return { table: salesReceipts, id: salesReceipts.id, companyId: salesReceipts.companyId, num: salesReceipts.receiptNumber, ref: salesReceipts.refNumber, createdAt: salesReceipts.createdAt };
    case 'credit_memo':
      return { table: creditMemos, id: creditMemos.id, companyId: creditMemos.companyId, num: creditMemos.memoNumber, ref: creditMemos.refNumber, createdAt: creditMemos.createdAt };
    case 'purchase_order':
      return { table: purchaseOrders, id: purchaseOrders.id, companyId: purchaseOrders.companyId, num: purchaseOrders.poNumber, ref: purchaseOrders.refNumber, createdAt: purchaseOrders.createdAt };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v);
}

/**
 * QuickBooks auto-increment: add one to the trailing run of digits, keeping its width (leading
 * zeros) and everything before it. A number with no trailing digits gets "1" appended
 * ("ABC" → "ABC1"); a blank number starts at "1".
 */
export function incrementAlnum(ref: string): string {
  const s = (ref ?? '').trim();
  if (!s) return '1';
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return `${s}1`;
  const [, prefix, digits] = m;
  const next = (BigInt(digits) + BigInt(1)).toString();
  return prefix + next.padStart(digits.length, '0');
}

/** Integer value of a number's trailing digits when it fits the legacy int column, else null. */
export function docNumberToInt(ref: string): number | null {
  const m = /(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

/** Normalize + validate a user-typed number ('' / null → null). */
export function normalizeDocNumber(ref: string | null | undefined): string | null {
  const s = (ref ?? '').trim();
  if (!s) return null;
  if (s.length > MAX_DOC_NUMBER_LENGTH) {
    throw validation(`Document numbers can be at most ${MAX_DOC_NUMBER_LENGTH} characters.`);
  }
  if ([...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    throw validation('Document numbers cannot contain control characters.');
  }
  return s;
}

/** Is `ref` already used by another document of this type in the company? (case-insensitive) */
export async function isDocNumberTaken(
  ctx: ServiceContext,
  docType: DocType,
  ref: string,
  excludeId?: string,
): Promise<boolean> {
  const t = docTable(docType);
  const conds = [eq(t.companyId, ctx.companyId), sql`lower(${t.ref}) = lower(${ref})`];
  if (excludeId) conds.push(ne(t.id, excludeId));
  const rows = await ctx.db.select({ id: t.id }).from(t.table).where(and(...conds)).limit(1);
  return rows.length > 0;
}

/**
 * Refuse a duplicate number for this document type (QB warns "This number has already been
 * used"). Pass `allowDuplicate` once the user confirmed the warning; the result still says
 * whether it was a duplicate so the caller can audit it.
 */
export async function assertUniqueDocNumber(
  ctx: ServiceContext,
  docType: DocType,
  ref: string,
  opts: { excludeId?: string; allowDuplicate?: boolean } = {},
): Promise<{ duplicate: boolean }> {
  const duplicate = await isDocNumberTaken(ctx, docType, ref, opts.excludeId);
  if (duplicate && !opts.allowDuplicate && (await warnsOnDuplicate(ctx, docType))) {
    throw new ServiceError(
      'CONFLICT',
      `${DOC_TYPE_LABELS[docType]} number ${ref} is already used. Use a different number, or confirm to keep the duplicate.`,
      { duplicateDocNumber: true, docType, refNumber: ref },
    );
  }
  return { duplicate };
}

/**
 * QB Preferences 'Warn about duplicate invoice / estimate / purchase order numbers'. With the
 * warning off QB accepts the duplicate silently; document types without such a preference
 * always warn.
 */
const DUPLICATE_WARNING_PREF: Partial<Record<DocType, 'warnDuplicateInvoiceNumbers' | 'warnDuplicateEstimateNumbers' | 'warnDuplicatePoNumbers'>> = {
  invoice: 'warnDuplicateInvoiceNumbers',
  estimate: 'warnDuplicateEstimateNumbers',
  purchase_order: 'warnDuplicatePoNumbers',
};

async function warnsOnDuplicate(ctx: ServiceContext, docType: DocType): Promise<boolean> {
  const key = DUPLICATE_WARNING_PREF[docType];
  if (!key) return true;
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  return resolveCompanyPreferences(row?.settings ?? {})[key];
}

/** Starting numbers per document type (companies.settings.docNumbers). */
async function startingNumbers(ctx: ServiceContext): Promise<Partial<Record<DocType, string>>> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const raw = (row?.settings as Record<string, unknown> | null)?.docNumbers;
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<DocType, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isDocType(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** The number most recently given to a document of this type (null when none yet). */
async function lastUsedNumber(ctx: ServiceContext, docType: DocType): Promise<string | null> {
  const t = docTable(docType);
  const [row] = await ctx.db
    .select({ ref: t.ref, num: t.num })
    .from(t.table)
    .where(eq(t.companyId, ctx.companyId))
    .orderBy(desc(t.createdAt), desc(t.num))
    .limit(1);
  if (!row) return null;
  return (row.ref as string | null) ?? String(row.num);
}

/**
 * Suggested next number for a new document (what the form pre-fills). Uses the starting number
 * from the settings while it is unused, otherwise the last used number + 1; skips numbers that
 * are already taken.
 */
export async function nextDocNumber(ctx: ServiceContext, docType: DocType): Promise<string> {
  const start = (await startingNumbers(ctx))[docType];
  let candidate: string;
  if (start && !(await isDocNumberTaken(ctx, docType, start))) {
    return start;
  }
  const last = await lastUsedNumber(ctx, docType);
  candidate = last ? incrementAlnum(last) : (start ? incrementAlnum(start) : '1');
  for (let i = 0; i < 10_000 && (await isDocNumberTaken(ctx, docType, candidate)); i++) {
    candidate = incrementAlnum(candidate);
  }
  return candidate.length > MAX_DOC_NUMBER_LENGTH ? candidate.slice(-MAX_DOC_NUMBER_LENGTH) : candidate;
}

/**
 * Allocate the number for a document being created: the user's number when given (validated +
 * duplicate-checked), otherwise `nextDocNumber`. Returns the text number and the value to store
 * in the legacy integer column (trailing digits, or MAX+1 when the number has none).
 */
export async function allocateDocNumber(
  ctx: ServiceContext,
  docType: DocType,
  userRef?: string | null,
  opts: { allowDuplicate?: boolean; excludeId?: string } = {},
): Promise<{ refNumber: string; number: number; duplicate: boolean }> {
  const typed = normalizeDocNumber(userRef);
  // Serialize number allocation per company + document type for the rest of the caller's
  // transaction, so two concurrent saves cannot both pass the duplicate check with the same
  // number (call this inside the create transaction, as the sales/purchase services do).
  await ctx.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`docnum:${ctx.companyId}:${docType}`}))`,
  );
  const refNumber = typed ?? (await nextDocNumber(ctx, docType));
  const { duplicate } = await assertUniqueDocNumber(ctx, docType, refNumber, opts);
  let number = docNumberToInt(refNumber);
  if (number === null) {
    const t = docTable(docType);
    const [row] = await ctx.db
      .select({ max: sql<number>`COALESCE(MAX(${t.num}), 0)` })
      .from(t.table)
      .where(eq(t.companyId, ctx.companyId));
    number = Number(row?.max ?? 0) + 1;
  }
  return { refNumber, number, duplicate };
}

export interface DocNumberSetting {
  docType: DocType;
  label: string;
  /** Starting number saved in the company settings (null = continue from the last one). */
  startingNumber: string | null;
  /** What the next new document will get. */
  nextNumber: string;
}

export async function getDocNumberSettings(ctx: ServiceContext): Promise<DocNumberSetting[]> {
  const starts = await startingNumbers(ctx);
  const out: DocNumberSetting[] = [];
  for (const docType of DOC_TYPES) {
    out.push({
      docType,
      label: DOC_TYPE_LABELS[docType],
      startingNumber: starts[docType] ?? null,
      nextNumber: await nextDocNumber(ctx, docType),
    });
  }
  return out;
}

/**
 * Set (or clear with null) the starting number for a document type. Refuses a number that is
 * already used (the next document would otherwise collide).
 */
export async function setStartingDocNumber(
  ctx: ServiceContext,
  docType: DocType,
  start: string | null,
): Promise<DocNumberSetting> {
  if (!isDocType(docType)) throw validation(`Unknown document type "${docType}".`);
  const value = normalizeDocNumber(start);
  if (value && (await isDocNumberTaken(ctx, docType, value))) {
    throw new ServiceError(
      'CONFLICT',
      `${DOC_TYPE_LABELS[docType]} number ${value} is already used. Pick a number that has not been used yet.`,
    );
  }
  const before = (await startingNumbers(ctx))[docType] ?? null;
  await ctx.db
    .update(companies)
    .set({
      settings: value
        ? sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('docNumbers', coalesce(${companies.settings} -> 'docNumbers', '{}'::jsonb) || jsonb_build_object(${docType}::text, ${value}::text))`
        : sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('docNumbers', coalesce(${companies.settings} -> 'docNumbers', '{}'::jsonb) - ${docType}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, ctx.companyId));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { docNumbers: { [docType]: before } },
    newValues: { docNumbers: { [docType]: value } },
  });
  return {
    docType,
    label: DOC_TYPE_LABELS[docType],
    startingNumber: value,
    nextNumber: await nextDocNumber(ctx, docType),
  };
}
