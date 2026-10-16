/**
 * Receipt capture: drop or photograph a receipt, read it on this machine, and turn it into an
 * expense, check, credit-card charge or bill with the receipt attached.
 *
 * Flow
 *  1. uploadReceipt — the file goes into the Doc Center inbox (lib/services/attachments.ts, an
 *     unfiled attachment) and a receipt_scans row tracks it. Files are checked by their bytes
 *     (lib/receipts/files.ts), never by the name or type the browser claims.
 *  2. extractReceipt — reads the text LOCALLY: PDFs through pdfjs-dist (scanned PDFs: their page
 *     images through OCR), photos through offline OCR (tesseract.js, bundled engine + language
 *     data, lib/receipts/ocr.ts). A company may instead pick a local vision model on its LAN /
 *     tailnet (an Ollama provider from AI & Automation); it is called through lib/ai/router.ts
 *     with cloud providers excluded, so a photo never leaves the local network — images cannot
 *     be redacted, so the cloud is never an option here. The text is parsed by
 *     lib/receipts/parse.ts. Nothing needs AI: with no OCR and no model the person types the
 *     fields in.
 *  3. receiptSuggestions — the vendor matched against the vendor list, the expense account from
 *     the vendor's history / learned categorizer (aiCategorizer.vendorPrefill), and the paying
 *     account from the card's last four digits.
 *  4. saveReceipt — creates the transaction through the normal expense / bill services (so the
 *     ledger guards, closing date and audit trail all apply), files the receipt to it and marks
 *     the scan saved, all in one database transaction. The scan's `version` is checked so two
 *     people can't turn the same receipt into two transactions.
 *
 * Phone upload: createUploadToken issues a random 256-bit token (only its SHA-256 is stored)
 * for ONE company, valid 15 minutes, for at most 20 uploads; uploadWithToken accepts files for
 * it without a session (the token is the credential), re-checking that the person who issued it
 * is still an active member allowed to add documents.
 *
 * Permissions: the inbox needs Lists (like the Doc Center inbox); saving needs Banking (expense,
 * check, card charge) or Vendors (bill) create, plus Vendors create for a new vendor.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '@/lib/db';
import {
  accounts,
  attachments,
  bankAccounts,
  companies,
  receiptScans,
  receiptUploadTokens,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { AiRouter } from '@/lib/ai/router';
import type { ChatMessage, StoredProviderConfig } from '@/lib/ai/types';
import { localityOf } from '@/lib/ai/providers';
import { can, legacyRoleFor } from '@/lib/permissions/model';
import {
  checkReceiptFile,
  isReadableKind,
  MOBILE_MAX_BYTES,
  RECEIPT_MAX_BYTES,
  ReceiptFileError,
  sniffReceiptKind,
  type ReceiptFileKind,
} from '@/lib/receipts/files';
import { parseReceiptText, receiptLines, type ParsedReceipt } from '@/lib/receipts/parse';
import { getOcrEngine } from '@/lib/receipts/ocr';
import { readPdfReceipt } from '@/lib/receipts/pdfText';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertWrite } from './rbac';
import { requirePermission, resolveAccess } from './access';
import { getAttachmentFile, saveAttachment, updateAttachment, deleteAttachment } from './attachments';
import { createExpense, type ExpenseMethod } from './expenses';
import { createBill } from './bills';
import { createVendor } from './vendors';
import { vendorPrefill } from './aiCategorizer';
import { buildProviders, loadSettings } from './aiSettings';
import { getFileLockStatus } from './fileLock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReceiptStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'saved';
export type ReceiptMethod = 'pdf-text' | 'ocr' | 'vision' | 'none';
export type ReceiptTxnKind = 'expense' | 'check' | 'credit_card' | 'bill';

export interface ReceiptView {
  id: string;
  attachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  source: 'desktop' | 'phone';
  status: ReceiptStatus;
  method: ReceiptMethod | null;
  message: string | null;
  vendorName: string | null;
  date: string | null;
  total: string | null;
  subtotal: string | null;
  tax: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  reference: string | null;
  confidence: Record<string, number> | null;
  rawText: string | null;
  txnType: string | null;
  txnId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A processing claim older than this is considered abandoned (server restarted mid-read). */
const STALE_PROCESSING_MS = 3 * 60 * 1000;
/** Text kept for the review screen. */
const MAX_RAW_TEXT = 20_000;

// ---------------------------------------------------------------------------
// Settings (companies.settings.receiptCapture)
// ---------------------------------------------------------------------------

export const RECEIPT_SETTINGS_KEY = 'receiptCapture';

export interface ReceiptSettings {
  /** Local vision model (an enabled Ollama provider on this machine / LAN / tailnet), or null. */
  visionProviderId: string | null;
  /** Read photos with the vision model first (offline OCR stays the fallback). */
  preferVision: boolean;
  /** Day/month order for numeric dates such as 03/04/2026. */
  dateOrder: 'mdy' | 'dmy';
}

const DEFAULT_SETTINGS: ReceiptSettings = { visionProviderId: null, preferVision: false, dateOrder: 'mdy' };

export const receiptSettingsSchema = z.object({
  visionProviderId: z.string().max(100).nullable().optional(),
  preferVision: z.boolean().optional(),
  dateOrder: z.enum(['mdy', 'dmy']).optional(),
});

function normalizeSettings(raw: unknown): ReceiptSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    visionProviderId: typeof r.visionProviderId === 'string' && r.visionProviderId ? r.visionProviderId : null,
    preferVision: r.preferVision === true,
    dateOrder: r.dateOrder === 'dmy' ? 'dmy' : 'mdy',
  };
}

export async function getReceiptSettings(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<ReceiptSettings> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  if (!row) return { ...DEFAULT_SETTINGS };
  return normalizeSettings((row.settings as Record<string, unknown> | null)?.[RECEIPT_SETTINGS_KEY]);
}

/** Local vision models the company could use: enabled Ollama providers that are not in the cloud. */
export function visionCandidates(providers: StoredProviderConfig[]): Array<{ id: string; label: string; model: string }> {
  return providers
    .filter((p) => p.enabled && p.kind === 'ollama' && localityOf(p) === 'local')
    .map((p) => ({ id: p.id, label: p.label, model: p.model }));
}

export interface ReceiptSettingsView extends ReceiptSettings {
  visionModels: Array<{ id: string; label: string; model: string }>;
  /** Whether the offline OCR engine and its language data are installed. */
  ocrAvailable: boolean;
}

export async function getReceiptSettingsView(ctx: ServiceContext): Promise<ReceiptSettingsView> {
  const [settings, ai, ocr] = await Promise.all([getReceiptSettings(ctx), loadSettings(ctx), getOcrEngine()]);
  return { ...settings, visionModels: visionCandidates(ai.providers), ocrAvailable: Boolean(ocr) };
}

export async function setReceiptSettings(ctx: ServiceContext, input: unknown): Promise<ReceiptSettingsView> {
  requirePermission(ctx, 'company', 'modify');
  const parsed = receiptSettingsSchema.safeParse(input);
  if (!parsed.success) throw validation('Invalid receipt settings.', parsed.error.flatten());
  const ai = await loadSettings(ctx);
  if (parsed.data.visionProviderId && !visionCandidates(ai.providers).some((p) => p.id === parsed.data.visionProviderId)) {
    throw validation('Pick a local AI model (an Ollama model on this computer, your network or your tailnet).');
  }
  await inTransaction(ctx, async (tx) => {
    const [row] = await tx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, tx.companyId));
    if (!row) throw notFound('Company');
    const settings = { ...((row.settings ?? {}) as Record<string, unknown>) };
    const before = normalizeSettings(settings[RECEIPT_SETTINGS_KEY]);
    const next: ReceiptSettings = {
      visionProviderId:
        parsed.data.visionProviderId === undefined ? before.visionProviderId : parsed.data.visionProviderId || null,
      preferVision: parsed.data.preferVision ?? before.preferVision,
      dateOrder: parsed.data.dateOrder ?? before.dateOrder,
    };
    settings[RECEIPT_SETTINGS_KEY] = next;
    await tx.db.update(companies).set({ settings, updatedAt: new Date() }).where(eq(companies.id, tx.companyId));
    await writeAudit(tx, { action: 'update', entityType: 'receipt_settings', entityId: tx.companyId, oldValues: before, newValues: next });
  });
  return getReceiptSettingsView(ctx);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const viewColumns = {
  scan: receiptScans,
  filename: attachments.filename,
  mimeType: attachments.mimeType,
  sizeBytes: attachments.sizeBytes,
};

/**
 * The status a receipt is shown with. A 'processing' claim older than STALE_PROCESSING_MS was
 * abandoned (the app closed or the server stopped mid-read): it is reported as 'pending', so the
 * inbox and the review page ask to read it again (extractReceipt reclaims stale claims) instead
 * of showing "being read" forever.
 */
export function effectiveReceiptStatus(
  scan: Pick<typeof receiptScans.$inferSelect, 'status' | 'processingStartedAt' | 'updatedAt'>,
  now: Date = new Date(),
): ReceiptStatus {
  const status = scan.status as ReceiptStatus;
  if (status !== 'processing') return status;
  const startedAt = scan.processingStartedAt ?? scan.updatedAt;
  return startedAt.getTime() < now.getTime() - STALE_PROCESSING_MS ? 'pending' : 'processing';
}

function toView(r: { scan: typeof receiptScans.$inferSelect; filename: string; mimeType: string | null; sizeBytes: number | null }): ReceiptView {
  const s = r.scan;
  return {
    id: s.id,
    attachmentId: s.attachmentId,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    source: s.source === 'phone' ? 'phone' : 'desktop',
    status: effectiveReceiptStatus(s),
    method: (s.method as ReceiptMethod | null) ?? null,
    message: s.message,
    vendorName: s.vendorName,
    date: s.receiptDate,
    total: s.total,
    subtotal: s.subtotal,
    tax: s.tax,
    cardLast4: s.cardLast4,
    cardBrand: s.cardBrand,
    reference: s.reference,
    confidence: s.confidence ?? null,
    rawText: s.rawText,
    txnType: s.txnType,
    txnId: s.txnId,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function loadView(ctx: Pick<ServiceContext, 'db' | 'companyId'>, id: string): Promise<ReceiptView> {
  if (!UUID_RE.test(id)) throw notFound('Receipt');
  const [row] = await ctx.db
    .select(viewColumns)
    .from(receiptScans)
    .innerJoin(attachments, eq(attachments.id, receiptScans.attachmentId))
    .where(and(eq(receiptScans.id, id), eq(receiptScans.companyId, ctx.companyId)));
  if (!row) throw notFound('Receipt');
  return toView(row);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Receipts in the inbox (not yet saved) first, then recently saved ones. */
export async function listReceipts(
  ctx: ServiceContext,
  opts: { status?: 'open' | 'saved' | 'all'; limit?: number } = {},
): Promise<ReceiptView[]> {
  requirePermission(ctx, 'lists', 'view');
  const status = opts.status ?? 'open';
  const conds = [eq(receiptScans.companyId, ctx.companyId)];
  if (status === 'open') {
    conds.push(inArray(receiptScans.status, ['pending', 'processing', 'ready', 'failed']));
    // Filed to a record from the Doc Center instead: no longer waiting in the receipts inbox.
    conds.push(isNull(attachments.entityId));
  }
  if (status === 'saved') conds.push(eq(receiptScans.status, 'saved'));
  const rows = await ctx.db
    .select(viewColumns)
    .from(receiptScans)
    .innerJoin(attachments, eq(attachments.id, receiptScans.attachmentId))
    .where(and(...conds))
    .orderBy(desc(receiptScans.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  return rows.map(toView);
}

export async function getReceipt(ctx: ServiceContext, id: string): Promise<ReceiptView> {
  requirePermission(ctx, 'lists', 'view');
  return loadView(ctx, id);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadReceiptInput {
  filename?: string | null;
  bytes: Uint8Array;
  source?: 'desktop' | 'phone';
  /** Size limit for this channel (phone uploads are smaller). */
  maxBytes?: number;
}

function fileError(err: unknown): never {
  if (err instanceof ReceiptFileError) throw validation(err.message);
  throw err;
}

/** Add a receipt to the inbox. The file is checked by its bytes; nothing is read yet. */
export async function uploadReceipt(ctx: ServiceContext, input: UploadReceiptInput): Promise<ReceiptView> {
  assertWrite(ctx);
  requirePermission(ctx, 'lists', 'create');
  let checked;
  try {
    checked = checkReceiptFile({ filename: input.filename, bytes: input.bytes }, { maxBytes: input.maxBytes ?? RECEIPT_MAX_BYTES });
  } catch (err) {
    fileError(err);
  }
  const source = input.source === 'phone' ? 'phone' : 'desktop';
  const id = await inTransaction(ctx, async (tx) => {
    const att = await saveAttachment(tx, {
      filename: checked.filename,
      mimeType: checked.mimeType,
      base64: Buffer.from(input.bytes).toString('base64'),
      description: source === 'phone' ? 'Receipt (sent from a phone)' : 'Receipt',
    });
    const [scan] = await tx.db
      .insert(receiptScans)
      .values({
        companyId: tx.companyId,
        attachmentId: att.id,
        source,
        status: isReadableKind(checked.kind) ? 'pending' : 'ready',
        method: isReadableKind(checked.kind) ? null : 'none',
        message: isReadableKind(checked.kind) ? null : HEIC_MESSAGE,
        createdBy: tx.userId,
      })
      .returning({ id: receiptScans.id });
    await writeAudit(tx, {
      action: 'create',
      entityType: 'receipt_scan',
      entityId: scan.id,
      newValues: { attachmentId: att.id, filename: checked.filename, source },
    });
    return scan.id;
  });
  return loadView(ctx, id);
}

const HEIC_MESSAGE =
  'This photo is in Apple HEIC format, which can be stored but not read automatically. Type the details below, or set the iPhone camera to "Most Compatible" (Settings → Camera → Formats) for future photos.';

/** Remove a receipt that has not been saved as a transaction (deletes the file too). */
export async function deleteReceipt(ctx: ServiceContext, id: string): Promise<void> {
  const view = await getReceipt(ctx, id);
  if (view.status === 'saved') {
    throw validation('This receipt is already saved as a transaction. Delete or void that transaction instead.');
  }
  // The scan row goes with its attachment (ON DELETE CASCADE); deleteAttachment audits it.
  await deleteAttachment(ctx, view.attachmentId);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ReadResult {
  text: string;
  method: ReceiptMethod;
  message: string | null;
}

/** Ask the company's local vision model to transcribe a receipt image (never a cloud model). */
async function readWithVision(ctx: ServiceContext, image: Buffer, settings: ReceiptSettings): Promise<string | null> {
  if (!settings.visionProviderId) return null;
  const ai = await loadSettings(ctx);
  const stored = ai.providers.filter((p) => p.id === settings.visionProviderId);
  if (!visionCandidates(stored).length) return null; // removed, disabled or not local any more
  const providers = buildProviders(stored, ctx).filter((p) => p.locality === 'local');
  if (!providers.length) return null;
  // A dedicated router: local providers only, cloud off — the image can't be redacted.
  const router = new AiRouter({
    providers,
    cloudEnabled: false,
    taskPolicies: { categorize: 'local-only' },
    retries: 0,
  });
  const message = {
    role: 'user',
    content:
      'This image is a receipt or bill. Transcribe all of its printed text exactly, line by line, top to bottom. ' +
      'Keep amounts, dates and card digits exactly as printed. Reply with the text only.',
    images: [image.toString('base64')],
  } as ChatMessage; // Ollama's chat API takes base64 images on the message.
  const res = await router.chat('categorize', [message], { temperature: 0, maxTokens: 1500 });
  return res.content;
}

/** Read a receipt's text on this machine (see the module comment for the order). */
export async function readReceiptText(
  ctx: ServiceContext,
  bytes: Buffer,
  kind: ReceiptFileKind,
  settings: ReceiptSettings,
): Promise<ReadResult> {
  const viaImages = async (images: Buffer[], pdf: boolean): Promise<ReadResult> => {
    const notes: string[] = [];
    const tryVision = async () => {
      try {
        const parts: string[] = [];
        for (const img of images) {
          const t = await readWithVision(ctx, img, settings);
          if (t === null) return null;
          parts.push(t);
        }
        return parts.join('\n');
      } catch (err) {
        notes.push(`The local AI model could not read it (${err instanceof Error ? err.message : String(err)}).`);
        return null;
      }
    };
    if (settings.preferVision && settings.visionProviderId) {
      const t = await tryVision();
      if (t && t.trim()) return { text: t, method: 'vision', message: null };
    }
    const ocr = await getOcrEngine();
    if (ocr) {
      try {
        const parts: string[] = [];
        for (const img of images) parts.push(await ocr.recognize(img));
        const text = parts.join('\n');
        if (text.trim()) return { text, method: 'ocr', message: null };
        notes.push('No text was found in the picture.');
      } catch (err) {
        notes.push(`The photo could not be read (${err instanceof Error ? err.message : String(err)}).`);
      }
    } else {
      notes.push('Offline text reading for photos is not installed on this computer.');
    }
    if (!settings.preferVision && settings.visionProviderId) {
      const t = await tryVision();
      if (t && t.trim()) return { text: t, method: 'vision', message: null };
    }
    return {
      text: '',
      method: 'none',
      message: `${pdf ? 'This PDF is a scanned picture. ' : ''}${notes.join(' ')} Type the details below.`.trim(),
    };
  };

  if (kind === 'pdf') {
    let content;
    try {
      content = await readPdfReceipt(bytes);
    } catch {
      return { text: '', method: 'none', message: 'This PDF could not be opened. Type the details below.' };
    }
    if (content.text.replace(/\s/g, '').length >= 20) return { text: content.text, method: 'pdf-text', message: null };
    if (!content.scans.length) {
      return { text: content.text, method: 'none', message: 'No text was found in this PDF. Type the details below.' };
    }
    return viaImages(content.scans, true);
  }
  if (kind === 'heic') return { text: '', method: 'none', message: HEIC_MESSAGE };
  return viaImages([bytes], false);
}

/**
 * Read a receipt and store what was found. Claims the row first (pending / failed, or a stale
 * claim), so two callers never read the same receipt at once; `force` re-reads a ready one
 * (it must name the version the person is looking at). Returns the current view either way.
 */
export async function extractReceipt(
  ctx: ServiceContext,
  id: string,
  opts: { force?: boolean; version?: number } = {},
): Promise<ReceiptView> {
  requirePermission(ctx, 'lists', 'create');
  const current = await loadView(ctx, id);
  if (current.status === 'saved') return current;
  if (opts.force && opts.version !== undefined && opts.version !== current.version) {
    throw new ServiceError('CONFLICT', 'This receipt was changed by someone else. Reload it and try again.', { stale: true });
  }
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimable = or(
    inArray(receiptScans.status, opts.force ? ['pending', 'failed', 'ready'] : ['pending', 'failed']),
    and(
      eq(receiptScans.status, 'processing'),
      or(
        lt(receiptScans.processingStartedAt, staleBefore),
        and(isNull(receiptScans.processingStartedAt), lt(receiptScans.updatedAt, staleBefore)),
      ),
    ),
  );
  const [claimed] = await ctx.db
    .update(receiptScans)
    .set({ status: 'processing', processingStartedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(receiptScans.id, id), eq(receiptScans.companyId, ctx.companyId), claimable))
    .returning({ id: receiptScans.id, attachmentId: receiptScans.attachmentId });
  if (!claimed) return loadView(ctx, id);

  let result: ReadResult;
  let parsed: ParsedReceipt | null = null;
  try {
    const file = await getAttachmentFile(ctx, claimed.attachmentId);
    const kind = sniffReceiptKind(file.buffer);
    const settings = await getReceiptSettings(ctx);
    result = kind
      ? await readReceiptText(ctx, file.buffer, kind, settings)
      : { text: '', method: 'none', message: 'This file is not a photo or PDF.' };
    parsed = result.text.trim() ? parseReceiptText(result.text, { dateOrder: settings.dateOrder }) : null;
  } catch (err) {
    result = { text: '', method: 'none', message: `The receipt could not be read (${err instanceof Error ? err.message : String(err)}). Type the details below.` };
  }
  const nothing = !parsed || (!parsed.total && !parsed.vendorName && !parsed.date);
  await ctx.db
    .update(receiptScans)
    .set({
      status: result.method === 'none' && !result.text.trim() ? 'failed' : 'ready',
      method: result.method,
      message: result.message ?? (nothing ? 'Nothing useful could be read from this receipt. Type the details below.' : null),
      vendorName: parsed?.vendorName?.slice(0, 255) ?? null,
      receiptDate: parsed?.date ?? null,
      total: parsed?.total ?? null,
      subtotal: parsed?.subtotal ?? null,
      tax: parsed?.tax ?? null,
      cardLast4: parsed?.cardLast4 ?? null,
      cardBrand: parsed?.cardBrand ?? null,
      reference: parsed?.reference?.slice(0, 60) ?? null,
      confidence: parsed?.confidence ?? null,
      rawText: result.text ? result.text.slice(0, MAX_RAW_TEXT) : null,
      processingStartedAt: null,
      version: sql`${receiptScans.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(receiptScans.id, id), eq(receiptScans.companyId, ctx.companyId), eq(receiptScans.status, 'processing')));
  return loadView(ctx, id);
}

// ---------------------------------------------------------------------------
// Suggestions (vendor match, account, paying account)
// ---------------------------------------------------------------------------

/** Lower-case words without punctuation and corporate suffixes ("The Home Depot, Inc." → "home depot"). */
export function normalizeVendorName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|inc|llc|ltd|co|corp|corporation|company|store|stores|#?\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 0-1 similarity between a name read from a receipt and a vendor's name. */
export function vendorNameScore(read: string, vendor: string): number {
  const a = normalizeVendorName(read);
  const b = normalizeVendorName(vendor);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const compactA = a.replace(/ /g, '');
  const compactB = b.replace(/ /g, '');
  if (compactA === compactB) return 0.97;
  if (compactB.length >= 4 && (compactA.includes(compactB) || compactB.includes(compactA))) return 0.85;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter === 0 ? 0 : (2 * inter) / (ta.size + tb.size) * 0.8;
}

export interface VendorMatch {
  vendorId: string;
  vendorName: string;
  score: number;
}

/** Best existing vendor for a receipt: by the name read, then by any vendor named near the top. */
export async function matchVendor(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  vendorName: string | null,
  rawText: string | null,
): Promise<VendorMatch | null> {
  const list = await ctx.db
    .select({ id: vendors.id, displayName: vendors.displayName, companyName: vendors.companyName })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.isActive, true)));
  const top = rawText ? receiptLines(rawText).slice(0, 12).map(normalizeVendorName).join(' | ') : '';
  let best: VendorMatch | null = null;
  for (const v of list) {
    let score = 0;
    for (const name of [v.displayName, v.companyName]) {
      if (!name) continue;
      if (vendorName) score = Math.max(score, vendorNameScore(vendorName, name));
      const n = normalizeVendorName(name);
      if (top && n.length >= 4 && new RegExp(`(^|[ |])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[ |])`).test(top)) {
        score = Math.max(score, 0.75);
      }
    }
    if (score >= 0.6 && (!best || score > best.score)) best = { vendorId: v.id, vendorName: v.displayName, score: Math.round(score * 100) / 100 };
  }
  return best;
}

export interface ReceiptSuggestions {
  vendor: VendorMatch | null;
  /** Expense account and where the suggestion came from. */
  accountId: string | null;
  accountSource: 'vendor-default' | 'last-used' | 'learned' | 'none';
  /** Bank / card account matching the card's last 4 digits. */
  paymentAccountId: string | null;
  /** The kind of transaction that fits best. */
  kind: ReceiptTxnKind;
}

/** Card/bank account whose number (or name) ends with the card's last 4 digits. */
async function matchPaymentAccount(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  last4: string | null,
): Promise<{ accountId: string; subtype: string } | null> {
  if (!last4 || !/^\d{4}$/.test(last4)) return null;
  const [byNumber] = await ctx.db
    .select({ accountId: accounts.id, subtype: accounts.subtype })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(accounts.isActive, true), sql`right(regexp_replace(${bankAccounts.accountNumber}, '[^0-9]', '', 'g'), 4) = ${last4}`))
    .limit(1);
  if (byNumber) return byNumber;
  const [byName] = await ctx.db
    .select({ accountId: accounts.id, subtype: accounts.subtype })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        eq(accounts.isActive, true),
        inArray(accounts.subtype, ['credit_card', 'checking', 'savings']),
        ilike(accounts.name, `%${last4}%`),
      ),
    )
    .limit(1);
  return byName ?? null;
}

export async function receiptSuggestions(ctx: ServiceContext, id: string): Promise<ReceiptSuggestions> {
  const view = await getReceipt(ctx, id);
  const vendor = await matchVendor(ctx, view.vendorName, view.rawText);
  let accountId: string | null = null;
  let accountSource: ReceiptSuggestions['accountSource'] = 'none';
  if (vendor || view.vendorName) {
    const prefill = await vendorPrefill(ctx, {
      vendorId: vendor?.vendorId ?? null,
      payee: vendor ? null : view.vendorName,
      amount: view.total,
    });
    if (prefill.lines[0]) {
      accountId = prefill.lines[0].accountId;
      accountSource = prefill.source;
    }
  }
  const pay = await matchPaymentAccount(ctx, view.cardLast4);
  let kind: ReceiptTxnKind = 'expense';
  if (pay?.subtype === 'credit_card') kind = 'credit_card';
  else if (!pay && view.cardBrand && view.cardBrand !== 'Debit') kind = 'credit_card';
  else if (!view.cardLast4 && /\b(invoice|balance\s*due|amount\s*due|due\s*date)\b/i.test(view.rawText ?? '')) kind = 'bill';
  return { vendor, accountId, accountSource, paymentAccountId: pay?.accountId ?? null, kind };
}

// ---------------------------------------------------------------------------
// Save as a transaction (attach-on-save)
// ---------------------------------------------------------------------------

const zMoneyStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), 'Enter an amount like 12.34');
const zId = z.string().regex(UUID_RE, 'Invalid id');

export const saveReceiptSchema = z
  .object({
    version: z.number().int().positive(),
    kind: z.enum(['expense', 'check', 'credit_card', 'bill']),
    vendorId: zId.nullish(),
    /** Free-text payee (expenses) when no vendor is picked. */
    payeeName: z.string().trim().max(255).nullish(),
    /** Create this vendor and use it. */
    newVendorName: z.string().trim().max(255).nullish(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date'),
    total: zMoneyStr,
    /** Sales tax recorded on its own line (needs taxAccountId). */
    tax: zMoneyStr.nullish(),
    taxAccountId: zId.nullish(),
    accountId: zId,
    /** Bank / card account (expense, check, card charge). */
    paymentAccountId: zId.nullish(),
    memo: z.string().max(1000).nullish(),
    /** Check number / card slip number / vendor's bill number. */
    reference: z.string().trim().max(60).nullish(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    classId: zId.nullish(),
    customerId: zId.nullish(),
    /** The person confirmed a duplicate check / bill number. */
    allowDuplicateNumber: z.boolean().optional(),
  })
  .refine((v) => v.kind === 'bill' || Boolean(v.paymentAccountId), {
    message: 'Pick the account the money came out of.',
    path: ['paymentAccountId'],
  })
  .refine((v) => Boolean(v.vendorId) || Boolean(v.newVendorName) || (v.kind !== 'bill' && Boolean(v.payeeName)), {
    message: 'Pick who you paid.',
    path: ['vendorId'],
  });
export type SaveReceiptInput = z.input<typeof saveReceiptSchema>;

export interface SaveReceiptResult {
  receipt: ReceiptView;
  txnType: 'expense' | 'bill';
  txnId: string;
}

const METHOD_FOR: Record<Exclude<ReceiptTxnKind, 'bill'>, ExpenseMethod> = {
  expense: 'cash',
  check: 'check',
  credit_card: 'credit_card',
};

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

export async function saveReceipt(ctx: ServiceContext, id: string, raw: unknown): Promise<SaveReceiptResult> {
  const parsed = saveReceiptSchema.safeParse(raw);
  if (!parsed.success) throw validation(parsed.error.issues[0]?.message ?? 'Invalid receipt.', parsed.error.flatten());
  const input = parsed.data;
  assertWrite(ctx);
  requirePermission(ctx, input.kind === 'bill' ? 'vendors' : 'banking', 'create');
  if (input.newVendorName && !input.vendorId) requirePermission(ctx, 'vendors', 'create');

  const total = Money.of(input.total);
  if (!total.gt(0)) throw validation('The total must be more than zero.');
  const tax = input.tax ? Money.of(input.tax) : Money.zero();
  if (tax.lt(0) || tax.gte(total)) throw validation('Sales tax must be less than the total.');
  if (tax.gt(0) && !input.taxAccountId) throw validation('Pick the account for the sales tax line, or leave the tax blank.');
  const lines = [
    { accountId: input.accountId, amount: toAmountString(total.minus(tax)), description: input.memo ?? null },
    ...(tax.gt(0) ? [{ accountId: input.taxAccountId!, amount: toAmountString(tax), description: 'Sales tax' }] : []),
  ];

  const result = await inTransaction(ctx, async (tx) => {
    // Record lock: the receipt row, at the version the person reviewed, not yet saved.
    const [scan] = await tx.db
      .select()
      .from(receiptScans)
      .where(and(eq(receiptScans.id, id), eq(receiptScans.companyId, tx.companyId)))
      .for('update');
    if (!scan) throw notFound('Receipt');
    if (scan.status === 'saved') {
      throw new ServiceError('CONFLICT', 'This receipt was already saved as a transaction.', { txnType: scan.txnType, txnId: scan.txnId });
    }
    if (scan.version !== input.version) {
      throw new ServiceError('CONFLICT', 'This receipt was changed by someone else. Reload it and try again.', { stale: true });
    }

    const [file] = await tx.db
      .select({ entityType: attachments.entityType, entityId: attachments.entityId })
      .from(attachments)
      .where(and(eq(attachments.id, scan.attachmentId), eq(attachments.companyId, tx.companyId)));
    if (file?.entityId) {
      throw validation('This receipt was already attached to another record in the Doc Center. Unfile it there first.');
    }

    let vendorId = input.vendorId ?? null;
    if (!vendorId && input.newVendorName) {
      const v = await createVendor(tx, { displayName: input.newVendorName });
      vendorId = v.id;
    }

    let txnType: 'expense' | 'bill';
    let txnId: string;
    if (input.kind === 'bill') {
      if (!vendorId) throw validation('A bill needs a vendor.');
      const bill = await createBill(tx, {
        vendorId,
        billNumber: input.reference || null,
        date: day(input.date),
        dueDate: input.dueDate ? day(input.dueDate) : null,
        memo: input.memo ?? null,
        checkDuplicateNumber: !input.allowDuplicateNumber,
        lines: lines.map((l) => ({ ...l, classId: input.classId ?? null, customerId: input.customerId ?? null })),
      });
      txnType = 'bill';
      txnId = bill.id;
    } else {
      const expense = await createExpense(tx, {
        vendorId,
        payeeName: vendorId ? null : input.payeeName ?? null,
        date: day(input.date),
        method: METHOD_FOR[input.kind],
        reference: input.reference || null,
        paymentAccountId: input.paymentAccountId!,
        memo: input.memo ?? null,
        checkDuplicateNumber: !input.allowDuplicateNumber,
        lines: lines.map((l) => ({ ...l, classId: input.classId ?? null, customerId: input.customerId ?? null })),
      });
      txnType = 'expense';
      txnId = expense.id;
    }

    // Attach-on-save: the receipt moves from the inbox onto the new transaction.
    await updateAttachment(tx, scan.attachmentId, { entityType: txnType, entityId: txnId });
    await tx.db
      .update(receiptScans)
      .set({ status: 'saved', txnType, txnId, version: scan.version + 1, updatedAt: new Date() })
      .where(and(eq(receiptScans.id, id), eq(receiptScans.companyId, tx.companyId)));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'receipt_scan',
      entityId: id,
      oldValues: { status: scan.status },
      newValues: { status: 'saved', txnType, txnId, kind: input.kind },
    });
    return { txnType, txnId };
  });
  return { receipt: await loadView(ctx, id), ...result };
}

// ---------------------------------------------------------------------------
// Phone upload links
// ---------------------------------------------------------------------------

export const UPLOAD_TOKEN_MINUTES = 15;
export const UPLOAD_TOKEN_MAX_UPLOADS = 20;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface UploadTokenView {
  id: string;
  expiresAt: Date;
  maxUploads: number;
  uploadCount: number;
  createdAt: Date;
}

/** Issue a phone upload link for THIS company. The token itself is returned once, never stored. */
export async function createUploadToken(
  ctx: ServiceContext,
  opts: { minutes?: number; maxUploads?: number; now?: Date } = {},
): Promise<UploadTokenView & { token: string }> {
  assertWrite(ctx);
  requirePermission(ctx, 'lists', 'create');
  const minutes = Math.min(Math.max(Math.trunc(opts.minutes ?? UPLOAD_TOKEN_MINUTES), 1), 60);
  const maxUploads = Math.min(Math.max(Math.trunc(opts.maxUploads ?? UPLOAD_TOKEN_MAX_UPLOADS), 1), 50);
  const token = randomBytes(32).toString('base64url');
  const now = opts.now ?? new Date();
  const row = await inTransaction(ctx, async (tx) => {
    const [r] = await tx.db
      .insert(receiptUploadTokens)
      .values({
        companyId: tx.companyId,
        tokenHash: hashUploadToken(token),
        createdBy: tx.userId,
        expiresAt: new Date(now.getTime() + minutes * 60_000),
        maxUploads,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'receipt_upload_link',
      entityId: r.id,
      newValues: { expiresAt: r.expiresAt, maxUploads },
    });
    return r;
  });
  return { id: row.id, token, expiresAt: row.expiresAt, maxUploads: row.maxUploads, uploadCount: row.uploadCount, createdAt: row.createdAt };
}

/** Links of this company that still work. */
export async function listUploadTokens(ctx: ServiceContext): Promise<UploadTokenView[]> {
  requirePermission(ctx, 'lists', 'view');
  const rows = await ctx.db
    .select()
    .from(receiptUploadTokens)
    .where(
      and(
        eq(receiptUploadTokens.companyId, ctx.companyId),
        isNull(receiptUploadTokens.revokedAt),
        gt(receiptUploadTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(receiptUploadTokens.createdAt));
  return rows
    .filter((r) => r.uploadCount < r.maxUploads)
    .map((r) => ({ id: r.id, expiresAt: r.expiresAt, maxUploads: r.maxUploads, uploadCount: r.uploadCount, createdAt: r.createdAt }));
}

export async function revokeUploadToken(ctx: ServiceContext, id: string): Promise<void> {
  assertWrite(ctx);
  requirePermission(ctx, 'lists', 'create');
  if (!UUID_RE.test(id)) throw notFound('Upload link');
  await inTransaction(ctx, async (tx) => {
    const [r] = await tx.db
      .update(receiptUploadTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(receiptUploadTokens.id, id), eq(receiptUploadTokens.companyId, tx.companyId), isNull(receiptUploadTokens.revokedAt)))
      .returning({ id: receiptUploadTokens.id });
    if (!r) throw notFound('Upload link');
    await writeAudit(tx, { action: 'update', entityType: 'receipt_upload_link', entityId: id, newValues: { revoked: true } });
  });
}

export type TokenProblem = 'invalid' | 'expired' | 'used_up' | 'revoked' | 'not_allowed' | 'locked';

export class UploadTokenError extends ServiceError {
  constructor(public readonly problem: TokenProblem) {
    super(problem === 'invalid' ? 'NOT_FOUND' : 'FORBIDDEN', TOKEN_MESSAGES[problem], { problem });
  }
}

const TOKEN_MESSAGES: Record<TokenProblem, string> = {
  invalid: 'This upload link is not valid. Make a new one on the Receipts page.',
  expired: 'This upload link has expired. Make a new one on the Receipts page.',
  used_up: 'This upload link has been used for as many receipts as it allows. Make a new one on the Receipts page.',
  revoked: 'This upload link was turned off. Make a new one on the Receipts page.',
  not_allowed: 'The person who made this link can no longer add receipts to this company.',
  locked: 'Open the company on your computer first, then make a new upload link on the Receipts page.',
};

/**
 * When this server process started. The company-file password (lib/services/fileLock.ts) has to
 * be entered again on every launch, and a phone link has no unlock cookie of its own — so with a
 * file password set, only links made since this launch (i.e. after the file was unlocked again)
 * work. A link made before a restart can't add files to a file that is locked again.
 */
let serverStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000));

/** Tests only: pretend the server started at `at` (undefined restores the real start time). */
export function setServerStartedAtForTests(at: Date | undefined): void {
  serverStartedAt = at ?? new Date(Date.now() - Math.floor(process.uptime() * 1000));
}

/** 'locked' when the file has a password and the link predates this launch. */
async function lockProblem(db: DB, row: TokenRow): Promise<TokenProblem | null> {
  if (row.createdAt.getTime() >= serverStartedAt.getTime()) return null;
  const lock = await getFileLockStatus(db);
  return lock.enabled ? 'locked' : null;
}

type TokenRow = typeof receiptUploadTokens.$inferSelect;

function problemOf(row: TokenRow | undefined, now: Date): TokenProblem | null {
  if (!row) return 'invalid';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.uploadCount >= row.maxUploads) return 'used_up';
  return null;
}

async function findToken(db: DB, token: string): Promise<TokenRow | undefined> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
  const [row] = await db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.tokenHash, hashUploadToken(token)));
  return row;
}

/**
 * The company context an upload link acts in: the issuing member, with their CURRENT
 * permissions (a member deactivated or stripped of document access since issuing the link
 * can't keep uploading through it).
 */
async function tokenContext(db: DB, row: TokenRow): Promise<ServiceContext> {
  if (!row.createdBy) throw new UploadTokenError('not_allowed');
  // An archived (soft-deleted) company takes no more uploads (lib/context isArchivedCompany).
  const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, row.companyId));
  const settings = company?.settings as { archived?: unknown } | null | undefined;
  if (!company || settings?.archived === true) throw new UploadTokenError('not_allowed');
  const resolved = await resolveAccess(db, row.companyId, row.createdBy);
  if (!resolved.active || !can(resolved.access, 'lists', 'create')) throw new UploadTokenError('not_allowed');
  return { db, companyId: row.companyId, userId: row.createdBy, access: resolved.access, role: legacyRoleFor(resolved.access, resolved.isOwner) };
}

export interface UploadLinkStatus {
  companyName: string;
  expiresAt: Date;
  remaining: number;
  maxBytes: number;
}

/** What the phone page shows: which company, how long, how many uploads are left. */
export async function uploadLinkStatus(db: DB, token: string, now: Date = new Date()): Promise<UploadLinkStatus> {
  const row = await findToken(db, token);
  const problem = problemOf(row, now) ?? (await lockProblem(db, row!));
  if (problem) throw new UploadTokenError(problem);
  await tokenContext(db, row!);
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, row!.companyId));
  return {
    companyName: company?.name ?? 'your company',
    expiresAt: row!.expiresAt,
    remaining: row!.maxUploads - row!.uploadCount,
    maxBytes: MOBILE_MAX_BYTES,
  };
}

/**
 * Upload one receipt through a phone link. The file is checked first (type by bytes, size), then
 * one upload slot is claimed atomically (expiry, revocation and the upload limit are re-checked
 * in the same statement, so parallel uploads can't exceed the limit), then the receipt lands in
 * the link's company inbox — never any other company's.
 */
export async function uploadWithToken(
  db: DB,
  token: string,
  file: { filename?: string | null; bytes: Uint8Array },
  now: Date = new Date(),
): Promise<{ receipt: ReceiptView; remaining: number; ctx: ServiceContext }> {
  const row = await findToken(db, token);
  const problem = problemOf(row, now) ?? (await lockProblem(db, row!));
  if (problem) throw new UploadTokenError(problem);
  try {
    checkReceiptFile(file, { maxBytes: MOBILE_MAX_BYTES });
  } catch (err) {
    fileError(err);
  }
  const ctx = await tokenContext(db, row!);
  const [slot] = await db
    .update(receiptUploadTokens)
    .set({ uploadCount: sql`${receiptUploadTokens.uploadCount} + 1`, lastUsedAt: now })
    .where(
      and(
        eq(receiptUploadTokens.id, row!.id),
        isNull(receiptUploadTokens.revokedAt),
        gt(receiptUploadTokens.expiresAt, now),
        lt(receiptUploadTokens.uploadCount, receiptUploadTokens.maxUploads),
      ),
    )
    .returning({ uploadCount: receiptUploadTokens.uploadCount, maxUploads: receiptUploadTokens.maxUploads });
  if (!slot) {
    const [again] = await db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.id, row!.id));
    throw new UploadTokenError(problemOf(again, now) ?? 'used_up');
  }
  const receipt = await uploadReceipt(ctx, { ...file, source: 'phone', maxBytes: MOBILE_MAX_BYTES });
  return { receipt, remaining: slot.maxUploads - slot.uploadCount, ctx };
}
