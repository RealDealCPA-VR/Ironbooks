/**
 * POST /api/portable/restore — open/restore a Portable Company File (.bkp, raw bytes in the
 * request body) into a NEW company data directory. The active company file is never touched.
 *
 * Query:
 *   inspect=1   only validate the file (checksums) and return a summary of its manifest
 *   target=…    absolute destination folder — honored ONLY for the desktop shell, which
 *               authenticates with its per-launch internal token (x-bka-internal) after the
 *               user picked the folder in a native Save dialog. Browser/session callers always
 *               restore into a fresh sibling folder of the active company file.
 *   packAs=…    (desktop shell only, with target) the single company file (.ironbooks) to write
 *               from the restored folder — written by this server, so the books of a protected
 *               file are written encrypted with the key that travelled inside the portable file.
 *
 * A portable file protected with a PASSWORD (filecrypto) needs it: header x-ironbooks-password
 * (base64url of its UTF-8 bytes — lib/net/archiveCredentials.ts), never in the URL. Without it
 * (or with a wrong one) the answer is 403 with details.passwordRequired (details.wrongPassword);
 * wrong passwords are rate-limited like sign-in.
 *
 * Response 201: { dataDir, companyName, companies, rowCounts, verified, protected?, packed? }.
 * The restore verifies every table hash, the trial balance of every company, attachments and
 * the transaction log against the file's manifest, and refuses (400) on any mismatch.
 *
 * Browser restores while a single company file is open (a desktop host's file, used through
 * multi-user hosting or a browser): the restored books are packed as a new single company file
 * NEXT TO the open company file (where people look for it), not beside its hidden working copy.
 *
 * SECURITY: middleware excludes /api from the session check — this handler fails closed via
 * getServerContext() (owner/admin only) unless the internal token is valid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { closeDb, resolveDataDir, withDamagedFileAccess } from '@/lib/db';
import {
  defaultPortableRestoreDir,
  readPortableManifest,
  restorePortableCompanyFile,
  unlockPortableBuffer,
  type PortableRestoreResult,
} from '@/lib/services/portableFile';
import { protectionForDir } from '@/lib/services/fileProtection';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { filePasswordFrom, withFilePasswordLimit } from '@/lib/net/archiveCredentials';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { APP_VERSION } from '@/lib/appVersion';
import session from '@/electron/companySession';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[portable/restore] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Constant-time check of the x-bka-internal header against BKA_INTERNAL_TOKEN. */
function isInternal(req: NextRequest): boolean {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "<folder of the open company file>/<Company> (restored 2026-10-10 1405).ironbooks", unused. */
function restoredFileNextTo(companyFile: string, companyName: string): string {
  const parent = path.dirname(path.resolve(companyFile));
  const safe = companyName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').trim() || 'Company';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  let candidate = path.join(parent, `${safe} (restored ${stamp}).ironbooks`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(parent, `${safe} (restored ${stamp} ${i}).ironbooks`);
  return candidate;
}

/**
 * Write the restored folder out as one company file: encrypted with its own key and slots when the
 * restored books are protected (the key travelled inside the password-protected portable file).
 */
async function packAsCompanyFile(result: PortableRestoreResult, target: string): Promise<void> {
  const protection = result.protected ? await protectionForDir(result.dataDir) : null;
  await closeDb(result.dataDir).catch(() => undefined);
  await session.writeWorkingCopyAs(path.dirname(result.dataDir), target, {
    companyName: result.companyName,
    appVersion: APP_VERSION,
    dataDir: result.dataDir,
    protection,
  });
}

export async function POST(req: NextRequest) {
  try {
    const internal = isInternal(req);
    if (!internal) {
      // The active company file is only used to check who is asking: opening a portable file
      // into a NEW folder never touches it, so it stays possible when the active file is damaged
      // (a damaged file is refused everywhere else; lib/db/index.ts).
      const ctx = await withDamagedFileAccess(() => getServerContext());
      // Same rule as creating a portable file: only the owner/admin may open one.
      if (ctx.role !== 'owner' && ctx.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', 'Only the company owner or an admin can open a portable company file.');
      }
    }

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.', code: 'VALIDATION' }, { status: 400 });
    }
    const password = filePasswordFrom(req.headers);
    const origin = originFromHeaders(req.headers);
    const buffer = await withFilePasswordLimit(password, origin.addr, () => unlockPortableBuffer(Buffer.from(arrayBuffer), password));
    const params = req.nextUrl.searchParams;

    if (params.get('inspect') === '1') {
      const m = readPortableManifest(buffer);
      return NextResponse.json({
        companyName: m.companyName,
        createdAt: m.createdAt,
        appVersion: m.appVersion,
        companies: m.companies,
        rowCounts: m.rowCounts,
        transactionLogRecords: m.transactionLog?.records ?? 0,
        files: Object.keys(m.files ?? {}).length,
        passwordProtected: Boolean(password),
      });
    }

    let target: string;
    let packAs: string | null = null;
    let scratch = false;
    const requested = params.get('target');
    if (internal && requested) {
      if (!path.isAbsolute(requested)) {
        throw new ServiceError('VALIDATION', 'The destination folder must be an absolute path.');
      }
      target = requested;
      const pack = params.get('packAs');
      if (pack) {
        if (!path.isAbsolute(pack) || !/\.ironbooks$/i.test(pack)) throw new ServiceError('VALIDATION', 'The company file must be an absolute path ending in .ironbooks.');
        if (fs.existsSync(pack)) throw new ServiceError('CONFLICT', `${path.basename(pack)} already exists there. Choose a new name.`);
        packAs = pack;
      }
    } else if (process.env.BKA_COMPANY_FILE) {
      // A single company file is open: restore into a scratch folder beside its working copy, then
      // pack a new single company file next to the company file itself.
      const companyName = readPortableManifest(buffer).companyName;
      target = path.join(path.dirname(resolveDataDir()), `restore-${randomBytes(6).toString('hex')}`, 'data');
      packAs = restoredFileNextTo(process.env.BKA_COMPANY_FILE, companyName);
      scratch = true;
    } else {
      target = defaultPortableRestoreDir(readPortableManifest(buffer).companyName);
    }

    const result = await restorePortableCompanyFile(buffer, target);
    if (!packAs) return NextResponse.json(result, { status: 201 });
    try {
      await packAsCompanyFile(result, packAs);
    } finally {
      if (scratch) fs.rmSync(path.dirname(target), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return NextResponse.json({ ...result, ...(scratch ? { dataDir: null } : {}), packed: packAs }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
