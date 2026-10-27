/**
 * Document attachments service.
 *
 * Stores uploaded files under <dataDir>/attachments/ and tracks metadata in the
 * `attachments` table. Files are named <uuid>-<original-filename> on disk, but
 * the DB row stores only the relative `storagePath` so the records remain portable
 * if the data directory is moved.
 *
 * Conventions: every public function is scoped to ctx.companyId — callers can
 * never touch another company's attachments.
 *
 * Permissions (P1 controls): a document takes the permission area of the record it is filed to
 * (RECORD_AREAS — employee and paycheck documents need Payroll, bills need Vendors, checks need
 * Banking, ...). Listing, searching, downloading, filing, unfiling and deleting all check that
 * area; unfiled documents (the Doc Center inbox) and free-form references use Lists. The API
 * routes are open to any member and rely on these checks. Trusted contexts (no ctx.access) pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { resolveDataDir } from '@/lib/db';
import {
  attachments,
  billPayments,
  bills,
  creditMemos,
  customers,
  employees,
  estimates,
  expenses,
  formTemplates,
  invoices,
  items,
  journalEntries,
  leads,
  paychecks,
  paymentsReceived,
  purchaseOrders,
  salesOrders,
  salesReceipts,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { assertWrite } from './rbac';
import { requirePermission } from './access';
import { can, type Action, type Area } from '@/lib/permissions/model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the attachments storage folder for the active data directory. */
function attachmentsDir(): string {
  const dataDir = resolveDataDir();
  return path.join(dataDir, 'attachments');
}

/**
 * Stored attachment paths are relative to the data directory and always use forward slashes, so a
 * company file moves between Windows and macOS/Linux. Rows written by older Windows builds hold
 * backslashes (`attachments\<file>`); both separators are accepted when reading.
 */
export function normalizeStoragePath(storagePath: string): string {
  return storagePath.split(/[\\/]+/).filter(Boolean).join('/');
}

/** Absolute on-disk path of a stored (relative) attachment path, on any platform. */
export function attachmentAbsolutePath(dataDir: string, storagePath: string): string {
  return path.join(dataDir, ...normalizeStoragePath(storagePath).split('/'));
}

/**
 * The absolute path of a stored attachment, or null when the stored path does not resolve to a
 * file inside `<dataDir>/attachments` (e.g. "../../secret" from a crafted backup). Every read,
 * delete and restore goes through this, so a row can never name a file outside the store.
 */
export function safeAttachmentPath(dataDir: string, storagePath: string): string | null {
  if (typeof storagePath !== 'string' || !storagePath.trim()) return null;
  const root = path.resolve(dataDir, 'attachments');
  const abs = path.resolve(attachmentAbsolutePath(dataDir, storagePath));
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Per-company restore: give a restored attachment row its OWN copy of the file under a fresh
 * disk name, so the restored company and the company it was backed up from (when both live in
 * the same data directory) never share — and never delete — each other's files.
 * Throws VALIDATION for a stored path outside `<dataDir>/attachments`. A file that is not on
 * this disk keeps its (normalized) path; `createdPath` is the new file to remove if the restore
 * is rolled back.
 */
export function cloneAttachmentFileForRestore(
  dataDir: string,
  storagePath: string,
): { storagePath: string; createdPath: string | null } {
  const abs = safeAttachmentPath(dataDir, storagePath);
  if (!abs) {
    throw validation('Backup contains an attachment stored outside the attachments folder and cannot be restored.');
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { storagePath: normalizeStoragePath(storagePath), createdPath: null };
  }
  const original = path
    .basename(abs)
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
  const diskName = `${randomUUID()}-${diskSafeName(original)}`;
  const dir = path.join(dataDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const createdPath = path.join(dir, diskName);
  fs.copyFileSync(abs, createdPath);
  return { storagePath: `attachments/${diskName}`, createdPath };
}

/** Ensure the storage folder exists (idempotent). */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Longest stored file-name part after the "<uuid>-" prefix (file systems allow 255 per name). */
const MAX_DISK_NAME = 120;

/**
 * The file-name part of a stored document: the original name reduced to safe characters and
 * shortened (keeping its extension) so "<uuid>-<name>" stays well inside the 255-character limit
 * of Windows / macOS / Linux file names. The full original name is kept in the database row.
 */
export function diskSafeName(original: string): string {
  const safe = (original || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  if (safe.length <= MAX_DISK_NAME) return safe;
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(safe)?.[0] ?? '';
  return safe.slice(0, MAX_DISK_NAME - ext.length) + ext;
}

/**
 * A MIME type that can be sent back as a Content-Type header ("type/subtype", optional simple
 * parameters), else null. Anything else (line breaks, quotes, non-ASCII — e.g. from a crafted
 * backup) is served as application/octet-stream.
 */
export function safeMimeType(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 100) return null;
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\s*;\s*[A-Za-z0-9_.+-]+=[A-Za-z0-9_.+-]+)*$/.test(v)
    ? v
    : null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachmentRow {
  id: string;
  companyId: string;
  /** Null for unfiled documents (Doc Center inbox). */
  entityType: string | null;
  entityId: string | null;
  filename: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  description?: string | null;
  createdAt: Date;
}

export interface SaveAttachmentParams {
  /** Omit BOTH entityType and entityId to drop the file into the Doc Center inbox (unfiled). */
  entityType?: string | null;
  entityId?: string | null;
  filename: string;
  mimeType: string;
  /** Base64-encoded file contents. */
  base64: string;
  description?: string | null;
}

/** Largest file the Doc Center accepts (kept local; this just protects the company file). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate an (entityType, entityId) link: both set (filed) or both empty (unfiled). */
function normalizeLink(
  entityType: string | null | undefined,
  entityId: string | null | undefined,
): { entityType: string | null; entityId: string | null } {
  const t = entityType?.trim() || null;
  const i = entityId?.trim() || null;
  if (!t && !i) return { entityType: null, entityId: null };
  if (!t || !i) throw validation('entityType and entityId go together: give both, or neither to leave the file unfiled.');
  if (!ENTITY_TYPE_RE.test(t)) throw validation('entityType is not valid.');
  if (!UUID_RE.test(i)) throw validation('entityId must be a valid id.');
  return { entityType: t, entityId: i };
}

/**
 * Record types a Doc Center document can be filed to (Doc Center "Attach to" and record panels).
 * Filing never trusts a client-supplied id: the record must exist in this company.
 */
const FILING_TABLES = {
  invoice: invoices,
  bill: bills,
  expense: expenses,
  journal_entry: journalEntries,
  customer: customers,
  vendor: vendors,
  employee: employees,
  paycheck: paychecks,
  estimate: estimates,
  sales_receipt: salesReceipts,
  sales_order: salesOrders,
  purchase_order: purchaseOrders,
  credit_memo: creditMemos,
  vendor_credit: vendorCredits,
  payment_received: paymentsReceived,
  bill_payment: billPayments,
  item: items,
  lead: leads,
  form_template: formTemplates,
} as const;

/**
 * Permission area of each filing record type. `null` = any member may VIEW (form-template logos
 * print on every form); changing those documents needs Company & Preferences.
 */
const RECORD_AREAS: Record<keyof typeof FILING_TABLES, Area | null> = {
  invoice: 'customers',
  bill: 'vendors',
  expense: 'banking',
  journal_entry: 'accounting',
  customer: 'customers',
  vendor: 'vendors',
  employee: 'payroll',
  paycheck: 'payroll',
  estimate: 'customers',
  sales_receipt: 'customers',
  sales_order: 'customers',
  purchase_order: 'vendors',
  credit_memo: 'customers',
  vendor_credit: 'vendors',
  payment_received: 'customers',
  bill_payment: 'vendors',
  item: 'lists',
  lead: 'customers',
  form_template: null,
};

function isFilingType(t: string): t is keyof typeof FILING_TABLES {
  return Object.prototype.hasOwnProperty.call(FILING_TABLES, t);
}

/** The area guarding a document filed to `entityType` (unfiled / free-form: Lists). */
export function attachmentArea(entityType: string | null | undefined, action: Action): Area | null {
  if (!entityType || !isFilingType(entityType)) return 'lists';
  const area = RECORD_AREAS[entityType];
  if (area === null) return action === 'view' ? null : 'company';
  return area;
}

/** Throw FORBIDDEN unless the caller may `action` documents filed to `entityType`. */
function requireDocAccess(ctx: ServiceContext, entityType: string | null | undefined, action: Action): void {
  const area = attachmentArea(entityType, action);
  if (area) requirePermission(ctx, area, action);
}

/**
 * A document the caller may not view is reported as not found (download / file / delete by id),
 * so payroll documents don't show up for someone without Payroll access.
 */
function assertCanSee(ctx: ServiceContext, entityType: string | null): void {
  const area = attachmentArea(entityType, 'view');
  if (area && ctx.access && !can(ctx.access, area, 'view')) throw notFound('Attachment');
}

/**
 * SQL condition limiting a document query to what the caller may view (null = everything).
 * Unfiled and free-form documents need Lists; filed ones the area of their record type.
 */
function viewableCondition(ctx: ServiceContext): SQL | null {
  if (!ctx.access) return null;
  const filing = Object.keys(FILING_TABLES) as Array<keyof typeof FILING_TABLES>;
  const allowed = filing.filter((t) => {
    const area = RECORD_AREAS[t];
    return area === null || can(ctx.access, area, 'view');
  });
  const parts: SQL[] = [];
  if (allowed.length) parts.push(inArray(attachments.entityType, allowed));
  if (can(ctx.access, 'lists', 'view')) {
    parts.push(isNull(attachments.entityType));
    parts.push(notInArray(attachments.entityType, filing));
  }
  if (!parts.length) return sql`false`;
  return or(...parts) ?? null;
}

/** A filed link must point at a known record type and a real record of this company. */
async function assertFilingTarget(ctx: ServiceContext, entityType: string, entityId: string): Promise<void> {
  const table = (FILING_TABLES as Record<string, (typeof FILING_TABLES)[keyof typeof FILING_TABLES]>)[entityType];
  if (!table) throw validation('Documents can only be filed to a known record type.');
  const [found] = await ctx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, entityId), eq(table.companyId, ctx.companyId)));
  if (!found) throw validation('That record was not found in this company.');
}

// ---------------------------------------------------------------------------
// saveAttachment
// ---------------------------------------------------------------------------

/**
 * Decode a base64 payload, write the file to disk, insert an `attachments` row,
 * and return the new row. The `storagePath` stored in the DB is relative to the
 * data directory so it survives directory moves.
 */
export async function saveAttachment(
  ctx: ServiceContext,
  params: SaveAttachmentParams,
): Promise<AttachmentRow> {
  assertWrite(ctx); // view-only members cannot add documents (checked before the file is written)
  const { filename, mimeType, base64 } = params;
  const { entityType, entityId } = normalizeLink(params.entityType, params.entityId);

  if (!filename) throw validation('filename is required');
  if (!base64) throw validation('base64 content is required');
  // Adding a document to a record changes that record: needs modify in its area (Lists for the inbox).
  requireDocAccess(ctx, entityType, entityType ? 'modify' : 'create');

  // Never trust a client-supplied id: a document uploaded straight to a known record type must point
  // at a real record of this company, checked before anything is written (no orphaned files).
  // Types outside FILING_TABLES (the Doc Center's free-form "Other" reference) are kept as given.
  if (entityType && entityId && Object.prototype.hasOwnProperty.call(FILING_TABLES, entityType)) {
    await assertFilingTarget(ctx, entityType, entityId);
  }

  // Decode
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw validation('base64 content is invalid');
  }
  if (buffer.length === 0) throw validation('The file is empty.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw validation('Files can be at most 25 MB.');
  }

  const dir = attachmentsDir();
  ensureDir(dir);

  // Build a safe on-disk name: <uuid>-<sanitized, shortened filename> (the row keeps the full name).
  const diskName = `${randomUUID()}-${diskSafeName(filename)}`;
  const absolutePath = path.join(dir, diskName);

  // Write file synchronously so any OS error is caught before the DB insert.
  fs.writeFileSync(absolutePath, buffer);

  // Store a relative path so the record doesn't break if BKA_DATA_DIR changes.
  const storagePath = `attachments/${diskName}`;

  const [row] = await ctx.db
    .insert(attachments)
    .values({
      companyId: ctx.companyId,
      entityType,
      entityId,
      filename,
      storagePath,
      mimeType: safeMimeType(mimeType),
      sizeBytes: buffer.length,
      description: params.description?.trim() || null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'attachment',
    entityId: row.id,
    newValues: { entityType, entityId, filename, sizeBytes: buffer.length },
  });

  return row as AttachmentRow;
}

// ---------------------------------------------------------------------------
// listAttachments
// ---------------------------------------------------------------------------

export interface ListAttachmentsParams {
  entityType: string;
  entityId: string;
}

/** Return all attachments for a given entity, scoped to the company. */
export async function listAttachments(
  ctx: ServiceContext,
  params: ListAttachmentsParams,
): Promise<AttachmentRow[]> {
  requireDocAccess(ctx, params.entityType, 'view');
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.companyId, ctx.companyId),
        eq(attachments.entityType, params.entityType),
        eq(attachments.entityId, params.entityId),
      ),
    );
  return rows as AttachmentRow[];
}

// ---------------------------------------------------------------------------
// Doc Center: inbox, search, file/unfile, describe
// ---------------------------------------------------------------------------

/** Unfiled documents (Doc Center inbox), newest first. */
export async function listUnfiledAttachments(ctx: ServiceContext): Promise<AttachmentRow[]> {
  requireDocAccess(ctx, null, 'view');
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.companyId, ctx.companyId), isNull(attachments.entityId)))
    .orderBy(desc(attachments.createdAt));
  return rows as AttachmentRow[];
}

/** Every document in the company file, optionally filtered by name/description text. */
export async function searchAttachments(
  ctx: ServiceContext,
  opts: { q?: string; limit?: number } = {},
): Promise<AttachmentRow[]> {
  const q = opts.q?.trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  // Only documents filed to records the caller may view (payroll documents need Payroll, ...).
  const visible = viewableCondition(ctx);
  const conds: SQL[] = [eq(attachments.companyId, ctx.companyId)];
  if (pattern) conds.push(or(ilike(attachments.filename, pattern), ilike(attachments.description, pattern))!);
  if (visible) conds.push(visible);
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(and(...conds))
    .orderBy(desc(attachments.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return rows as AttachmentRow[];
}

export interface UpdateAttachmentParams {
  /** File the document to a record (both set), or unfile it back to the inbox (both null). */
  entityType?: string | null;
  entityId?: string | null;
  description?: string | null;
}

/** Attach an inbox document to a record, move it, unfile it, or change its description. */
export async function updateAttachment(
  ctx: ServiceContext,
  id: string,
  params: UpdateAttachmentParams,
): Promise<AttachmentRow> {
  const [row] = await ctx.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, ctx.companyId)));
  if (!row) throw notFound('Attachment');
  assertCanSee(ctx, row.entityType);
  assertWrite(ctx); // view-only members cannot re-file or re-describe (checked before any change)
  const patch: Partial<typeof attachments.$inferInsert> = {};
  if (params.entityType !== undefined || params.entityId !== undefined) {
    const link = normalizeLink(params.entityType, params.entityId);
    // Moving it off its record (or unfiling it) changes that record; filing it changes the target.
    requireDocAccess(ctx, row.entityType, row.entityType ? 'modify' : 'create');
    requireDocAccess(ctx, link.entityType, link.entityType ? 'modify' : 'create');
    if (link.entityType && link.entityId) await assertFilingTarget(ctx, link.entityType, link.entityId);
    patch.entityType = link.entityType;
    patch.entityId = link.entityId;
  }
  if (params.description !== undefined) {
    requireDocAccess(ctx, row.entityType, row.entityType ? 'modify' : 'create');
    patch.description = params.description?.trim() || null;
  }
  if (Object.keys(patch).length === 0) return row as AttachmentRow;
  const [updated] = await ctx.db
    .update(attachments)
    .set(patch)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, ctx.companyId)))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'attachment',
    entityId: id,
    oldValues: { entityType: row.entityType, entityId: row.entityId, description: row.description },
    newValues: { entityType: updated.entityType, entityId: updated.entityId, description: updated.description },
  });
  return updated as AttachmentRow;
}

// ---------------------------------------------------------------------------
// getAttachmentFile
// ---------------------------------------------------------------------------

export interface AttachmentFile {
  filename: string;
  mimeType: string | null;
  buffer: Buffer;
}

/**
 * Look up an attachment by id (verifying company ownership), read the file from
 * disk, and return its contents as a Buffer together with metadata.
 */
export async function getAttachmentFile(
  ctx: ServiceContext,
  id: string,
): Promise<AttachmentFile> {
  const [row] = await ctx.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, ctx.companyId)));

  if (!row) throw notFound('Attachment');
  assertCanSee(ctx, row.entityType);

  const dataDir = resolveDataDir();
  const absolutePath = safeAttachmentPath(dataDir, row.storagePath);

  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw notFound('Attachment file on disk');
  }

  const buffer = fs.readFileSync(absolutePath);
  return { filename: row.filename, mimeType: safeMimeType(row.mimeType), buffer };
}

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

/**
 * Remove the DB row and the on-disk file.  Best-effort file deletion: if the
 * file is already gone we still succeed (idempotent cleanup).
 */
export async function deleteAttachment(ctx: ServiceContext, id: string): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, ctx.companyId)));

  if (!row) throw notFound('Attachment');
  assertCanSee(ctx, row.entityType);
  requireDocAccess(ctx, row.entityType, row.entityType ? 'modify' : 'delete');
  assertWrite(ctx); // view-only members cannot delete documents

  // Remove DB row first; if the file delete fails we still keep the DB clean.
  await ctx.db
    .delete(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, ctx.companyId)));

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'attachment',
    entityId: id,
    oldValues: { entityType: row.entityType, entityId: row.entityId, filename: row.filename },
  });

  // Best-effort file removal — only for a path inside the attachments store, and only when no
  // other attachment row (any company in this data dir, e.g. one restored from a company backup
  // by an older build) still names the same file.
  try {
    const dataDir = resolveDataDir();
    const absolutePath = safeAttachmentPath(dataDir, row.storagePath);
    const normalized = normalizeStoragePath(row.storagePath);
    const [shared] = absolutePath
      ? await ctx.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            sql`trim(both '/' from regexp_replace(${attachments.storagePath}, '[\\\\/]+', '/', 'g')) = ${normalized}`,
          )
          .limit(1)
      : [];
    if (absolutePath && !shared && fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  } catch {
    // Non-fatal: log but don't throw.
    console.warn(`[attachments] could not delete file for attachment ${id}`);
  }
}
