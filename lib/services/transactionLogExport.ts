/**
 * Transaction Log downloads (QB keeps its .TLG beside the company file; Ironbooks lets the owner
 * take the log itself):
 *
 *  - The RAW log (`transactions.bktlg`, the hash-chained JSON Lines file) streamed byte for byte,
 *    so anyone can re-check the chain outside the app, plus a verification report for exactly
 *    those bytes (size, SHA-256, record count, head hash and the app's own verification result:
 *    chain intact, every posted journal entry present). The log is append-only, so a log
 *    downloaded later still starts with the bytes a report describes.
 *    The log file is shared by every company in the company file and cannot be filtered without
 *    breaking its chain: the raw download is for someone who manages every company it records
 *    (owner / admin / accountant of each), like a full copy of the file.
 *  - A CSV of the filtered, plain-language log with NO row cap, streamed in batches (the page
 *    shows the newest 5,000; the export used to stop there too).
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { companies, userCompanies } from '@/lib/db/schema';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { csvQuoted } from '@/lib/csv';
import { ServiceError, notFound, type ServiceContext } from './_base';
import {
  entityLabel,
  queryTransactionLog,
  readAllTransactionLog,
  transactionLogPath,
  verifyTransactionLog,
  type TransactionLogFilter,
  type TransactionLogVerification,
} from './transactionLog';

const MANAGER_ROLES = new Set(['owner', 'admin', 'accountant']);

function requireLogRole(ctx: ServiceContext): void {
  if (ctx.role && !MANAGER_ROLES.has(ctx.role)) {
    throw new ServiceError('FORBIDDEN', 'Only the owner, an admin or the accountant can download the transaction log.');
  }
}

function logDir(ctx: ServiceContext): string {
  return dataDirOf(ctx.db) ?? resolveDataDir();
}

/**
 * The raw log may be taken only by someone who manages every company it records: the caller's
 * role in each other company must be owner / admin / accountant (or they own it).
 */
async function requireAllCompanies(ctx: ServiceContext, dir: string): Promise<void> {
  const others = new Set<string>();
  for (const r of readAllTransactionLog(dir).records) if (r.companyId && r.companyId !== ctx.companyId) others.add(r.companyId);
  if (!others.size) return;
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Sign in to download the transaction log.');
  const ids = [...others];
  const owned = new Set(
    (await ctx.db.select({ id: companies.id }).from(companies).where(and(inArray(companies.id, ids), eq(companies.ownerId, ctx.userId)))).map((c) => c.id),
  );
  const managed = new Set(
    (
      await ctx.db
        .select({ companyId: userCompanies.companyId, role: userCompanies.role, isActive: userCompanies.isActive })
        .from(userCompanies)
        .where(and(eq(userCompanies.userId, ctx.userId), inArray(userCompanies.companyId, ids)))
    )
      .filter((m) => m.isActive !== false && MANAGER_ROLES.has(m.role))
      .map((m) => m.companyId),
  );
  // A company deleted since keeps its records; only an existing company can be someone else's.
  const existing = new Set((await ctx.db.select({ id: companies.id }).from(companies).where(inArray(companies.id, ids))).map((c) => c.id));
  const blocked = ids.filter((id) => existing.has(id) && !owned.has(id) && !managed.has(id));
  if (blocked.length) {
    throw new ServiceError(
      'FORBIDDEN',
      'This company file’s transaction log also records another company you do not manage, and the log cannot be split without breaking its fingerprints. Ask that company’s owner, or export the log as CSV instead.',
    );
  }
}

/** SHA-256 (hex) of the first `bytes` bytes of a file, read in chunks. */
export function sha256OfPrefix(file: string, bytes: number): string {
  const h = createHash('sha256');
  if (bytes <= 0) return h.digest('hex');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(1 << 20, bytes));
    let pos = 0;
    while (pos < bytes) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, bytes - pos), pos);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** A file name from the company name ("Acme Ltd transactions.bktlg"). */
async function baseName(ctx: ServiceContext): Promise<string> {
  const [c] = await ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  const safe = (c?.name ?? 'Company').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 80) || 'Company';
  return `${safe} transactions`;
}

export interface RawLogDownload {
  file: string;
  filename: string;
  /** Bytes of the log at the moment of the request (the download stops there). */
  bytes: number;
}

/** Checks and the file for the raw .bktlg download. */
export async function prepareRawLogDownload(ctx: ServiceContext): Promise<RawLogDownload> {
  requireLogRole(ctx);
  const dir = logDir(ctx);
  const file = transactionLogPath(dir);
  let bytes: number;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    throw notFound('Transaction log');
  }
  await requireAllCompanies(ctx, dir);
  return { file, filename: `${await baseName(ctx)}.bktlg`, bytes };
}

/** The first `bytes` bytes of a file as a web stream (1 MB chunks). */
export function streamFilePrefix(file: string, bytes: number): ReadableStream<Uint8Array> {
  let fd: number | null = null;
  let pos = 0;
  const close = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      fd = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start() {
      fd = fs.openSync(file, 'r');
    },
    pull(controller) {
      if (fd === null || pos >= bytes) {
        close();
        controller.close();
        return;
      }
      const buf = Buffer.alloc(Math.min(1 << 20, bytes - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) {
        close();
        controller.close();
        return;
      }
      pos += n;
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, n));
    },
    cancel() {
      close();
    },
  });
}

export interface LogVerificationReport {
  format: 'ironbooks-transaction-log-verification';
  version: 1;
  company: string;
  file: string;
  /** The report describes the first `bytes` bytes of the log. */
  bytes: number;
  sha256: string;
  generatedAt: string;
  howToCheck: string;
  verification: TransactionLogVerification;
}

/** The verification report that goes with a raw download (same checks as the page's banner). */
export async function transactionLogVerificationReport(ctx: ServiceContext): Promise<{ filename: string; report: LogVerificationReport }> {
  const raw = await prepareRawLogDownload(ctx);
  const verification = await verifyTransactionLog(ctx.db, logDir(ctx));
  const [c] = await ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  return {
    filename: `${raw.filename}.verification.json`,
    report: {
      format: 'ironbooks-transaction-log-verification',
      version: 1,
      company: c?.name ?? '',
      file: raw.filename,
      bytes: raw.bytes,
      sha256: sha256OfPrefix(raw.file, raw.bytes),
      generatedAt: new Date().toISOString(),
      howToCheck:
        'The log is JSON Lines: each record\'s "hash" is the SHA-256 of its own JSON text without the "hash" field, and each "prevHash" is the hash of the record before it (the first is 64 zeros). The SHA-256 above covers the first "bytes" bytes of the downloaded file; the log only grows, so a later download starts with the same bytes.',
      verification,
    },
  };
}

/** Filters of the CSV export (the page's filters). */
export type LogExportFilter = Omit<TransactionLogFilter, 'companyId' | 'limit' | 'offset'>;

const CSV_HEADER = ['#', 'Date/Time (UTC)', 'User', 'Action', 'Type', 'Details', 'Record id'];
const BATCH = 2000;

/**
 * The filtered log as CSV (newest first), every matching record — streamed in batches, so a log
 * of any size exports without a row cap. Other companies' records are left out, like the page.
 */
export function streamTransactionLogCsv(ctx: ServiceContext, filter: LogExportFilter): ReadableStream<Uint8Array> {
  requireLogRole(ctx);
  const dir = logDir(ctx);
  const enc = new TextEncoder();
  let offset = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode('﻿' + CSV_HEADER.map(csvQuoted).join(',') + '\r\n'));
        return;
      }
      const page = queryTransactionLog(dir, { ...filter, companyId: ctx.companyId, limit: BATCH, offset });
      if (!page.rows.length) {
        controller.close();
        return;
      }
      offset += page.rows.length;
      const text = page.rows
        .map((r) =>
          [r.seq, r.ts, r.userName ?? (r.userId ? 'Unknown user' : 'System'), r.action, entityLabel(r.entityType), r.summary, r.entityId ?? '']
            .map((v) => csvQuoted(v))
            .join(','),
        )
        .join('\r\n');
      controller.enqueue(enc.encode(text + '\r\n'));
      if (offset >= page.total) controller.close();
    },
  });
}
