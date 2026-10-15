/**
 * "Has anything changed since the last backup?" — a cheap, synchronous fingerprint of a company
 * file's books, taken from the head of its running transaction log (transactionLog.ts). Every
 * committed business change (postings, documents, list and user changes) appends a hash-chained
 * record there AFTER its commit, so the head record's seq + hash changes exactly when the books
 * do — while sign-ins, session heartbeats and other housekeeping writes (which would change the
 * raw database files) do not count as changes.
 *
 * Returns null when the file has no transaction log yet; callers treat null as "unknown" and
 * never skip a backup because of it.
 *
 * Coverage: writes reach the log through writeAudit / logTransaction. Writes that do not call it
 * themselves are covered when they run inside an audited operation: billable-cost stamps
 * (billables.addBillablesToInvoice, inside the audited invoice create) and FX relief rows
 * (fxSubledger.recordPaymentFxRelief, inside the audited payment). Bank-feed downloads
 * (plaid.syncTransactions) write their own audit record. Remaining gap: a raw write that bypasses
 * writeAudit entirely (e.g. a future service that forgets to audit) would not count as a change,
 * so a scheduled or quit-time backup could be skipped until the next audited change.
 * "Back up now" always backs up.
 */
import fs from 'node:fs';
import { resolveDataDir } from '@/lib/db';
import { transactionLogPath } from './transactionLog';

const TAIL_BYTES = 256 * 1024;

export function currentFingerprint(dataDir?: string): string | null {
  const file = transactionLogPath(resolveDataDir(dataDir));
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(file);
    if (size === 0) return null;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    // The newest complete record (a half-written final line is ignored).
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as { seq?: unknown; hash?: unknown };
        if (typeof rec.seq === 'number' && typeof rec.hash === 'string') return `log:${rec.seq}:${rec.hash}`;
      } catch {
        /* partial line at the start of the tail window or mid-append — try the previous one */
      }
    }
    return `log-size:${size}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
