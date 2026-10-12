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
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the attachments storage folder for the active data directory. */
function attachmentsDir(): string {
  const dataDir = resolveDataDir();
  return path.join(dataDir, 'attachments');
}

/** Ensure the storage folder exists (idempotent). */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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

  // Build a safe on-disk name: <uuid>-<sanitized-filename>
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const diskName = `${randomUUID()}-${safe}`;
  const absolutePath = path.join(dir, diskName);

  // Write file synchronously so any OS error is caught before the DB insert.
  fs.writeFileSync(absolutePath, buffer);

  // Store a relative path so the record doesn't break if BKA_DATA_DIR changes.
  const storagePath = path.join('attachments', diskName);

  const [row] = await ctx.db
    .insert(attachments)
    .values({
      companyId: ctx.companyId,
      entityType,
      entityId,
      filename,
      storagePath,
      mimeType: mimeType || null,
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
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(
      pattern
        ? and(
            eq(attachments.companyId, ctx.companyId),
            or(ilike(attachments.filename, pattern), ilike(attachments.description, pattern)),
          )
        : eq(attachments.companyId, ctx.companyId),
    )
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
  assertWrite(ctx); // view-only members cannot re-file or re-describe (checked before any change)
  const patch: Partial<typeof attachments.$inferInsert> = {};
  if (params.entityType !== undefined || params.entityId !== undefined) {
    const link = normalizeLink(params.entityType, params.entityId);
    if (link.entityType && link.entityId) await assertFilingTarget(ctx, link.entityType, link.entityId);
    patch.entityType = link.entityType;
    patch.entityId = link.entityId;
  }
  if (params.description !== undefined) patch.description = params.description?.trim() || null;
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

  const dataDir = resolveDataDir();
  const absolutePath = path.join(dataDir, row.storagePath);

  if (!fs.existsSync(absolutePath)) {
    throw notFound('Attachment file on disk');
  }

  const buffer = fs.readFileSync(absolutePath);
  return { filename: row.filename, mimeType: row.mimeType ?? null, buffer };
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

  // Best-effort file removal.
  try {
    const dataDir = resolveDataDir();
    const absolutePath = path.join(dataDir, row.storagePath);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  } catch {
    // Non-fatal: log but don't throw.
    console.warn(`[attachments] could not delete file for attachment ${id}`);
  }
}
