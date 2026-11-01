/**
 * POST /api/auth/login — verify credentials, start a session, select the user's company.
 * Body: { email, password, totp?, filePassword? } — `email` is the user's login (an email or a
 * user name); `filePassword` is the company file's own open password when it has one.
 *
 * Per-company-file login: the file password (if set) must be entered first (/unlock), the user
 * must have an ACTIVE membership in a company of this file, and the issued session token is
 * bound to this company file (lib/auth companyFileId).
 *
 * A company file protected with passwords (lib/services/fileProtection.ts) is opened by this same
 * sign-in, once, the QuickBooks way: while the server is sealed (lib/db/sealed.ts) the user name
 * and password first unwrap the file key from the file's own key slot, the working copy is made
 * from the encrypted file, the database opens — and only then is the user signed in against the
 * users table as usual. A wrong password gets the usual answer; an unknown user name costs the
 * same work as a wrong password (no way to tell which user names exist). The file password, when
 * the file has one, is inside the encrypted file: it is asked on this same screen once the file
 * is open. Every successful sign-in also creates or refreshes the user's key slot, so teammates
 * who sign in to a hosted file can later open it themselves.
 *
 * Multi-user hosting: attempts are rate-limited per account, per client address and globally
 * (lib/net/rateLimit.ts), and every sign-in creates a server-side session (user_sessions) whose
 * id is bound into the signed cookie — that is what powers "Who is logged in", admin sign-out
 * and single-user mode.
 */
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, resolveDataDir, sealedMode, withDamagedFileAccess, withSealedAccess, type DB } from '@/lib/db';
import { users, userCompanies, companies } from '@/lib/db/schema';
import {
  createSessionToken,
  createUnlockToken,
  hasPreUnlockCookie,
  hasValidUnlockCookie,
  verifyPasswordTimed,
  SESSION_COOKIE,
  UNLOCK_COOKIE,
} from '@/lib/auth';
import { verifyTotp } from '@/lib/totp';
import { ARCHIVED_ONLY_MESSAGE, COMPANY_COOKIE, DEACTIVATED_MESSAGE, isArchivedCompany } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { getFileLockStatus, verifyFilePassword } from '@/lib/services/fileLock';
import { startSession } from '@/lib/services/sessions';
import { loginSchema } from '@/lib/validation/users';
import { passwordStatusAtSignIn } from '@/lib/services/passwordPolicy';
import { requireFileAdmin } from '@/lib/services/access';
import {
  FILE_PASSWORD_PROMPT,
  NO_SLOT_MESSAGE,
  companyFileForProtection,
  finishKeyUnseal,
  loadKeyFromPassword,
  protectionStatus,
  readProtection,
  refreshSlotAtSignIn,
  unlockFromFile,
  unsealCompanyFile,
  takeUnsealedConflictCopy,
} from '@/lib/services/fileProtection';
import { cookieSecure, originFromHeaders, type RequestOrigin } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';

// Signing in (and unlocking the file) must work even when the company file's ledger is damaged
// (lib/db/index.ts refuses it everywhere else): it is the only way to reach Back Up and Restore
// and replace the file with a good backup. Nothing here reads or writes the ledger.
export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

interface LockGate {
  response?: NextResponse;
  /** The file password was given and is right: set the unlock cookie with the answer. */
  unlocked?: boolean;
}

/**
 * The company-file password (QB order: before any user sign-in). `afterUnseal`: the file was
 * encrypted until this request, so its password is asked on the sign-in screen itself.
 */
async function fileLockGate(db: DB, filePassword: string | undefined, origin: RequestOrigin, afterUnseal = false): Promise<LockGate> {
  const lock = await getFileLockStatus(db);
  if (!lock.enabled || (await hasValidUnlockCookie())) return {};
  if (filePassword) {
    // Same limiter and keys as /api/unlock: the file password is one shared secret.
    const limiter = loginLimiter();
    const keys = attemptKeys('unlock', 'file', origin.addr);
    const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
    const gate = limiter.begin(keys, Date.now(), weights);
    if (!gate.allowed) {
      const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
      return { response: NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } }) };
    }
    try {
      if (await verifyFilePassword(db, filePassword)) {
        limiter.recordSuccess(keys.slice(0, -1));
        return { unlocked: true };
      }
      limiter.recordFailure(keys, Date.now(), weights);
    } finally {
      gate.release();
    }
    return {
      response: NextResponse.json(
        { error: 'The company file password is not correct.', code: 'FORBIDDEN', details: { filePasswordRequired: true } },
        { status: 401 },
      ),
    };
  }
  if (afterUnseal || (await hasPreUnlockCookie())) {
    return {
      response: NextResponse.json({ error: FILE_PASSWORD_PROMPT, code: 'FORBIDDEN', details: { filePasswordRequired: true } }, { status: 403 }),
    };
  }
  // Same message as getServerContext so lib/client.ts sends the browser to /unlock.
  return {
    response: NextResponse.json({ error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' }, { status: 403 }),
  };
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when the server's active database is the open single company file's working copy. */
function isOpenCompanyFile(): boolean {
  if (!companyFileForProtection()) return false;
  const st = process.env.BKA_COMPANY_STATE;
  return st ? samePath(path.join(path.dirname(st), 'data'), resolveDataDir()) : true;
}

async function handlePost(req: NextRequest) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Email and password are required.', code: 'VALIDATION' }, { status: 400 });
  }
  const { email, password, totp, filePassword } = parsed.data;
  const origin = originFromHeaders(req.headers);
  const sealed = sealedMode();

  // The company-file password gates the file BEFORE any user login (QB order) — whenever it can be
  // read: a protected file that still has to be decrypted asks for it after the sign-in below.
  let unlocked = false;
  if (sealed !== 'extract' && sealed !== 'conflict') {
    const db = sealed === 'key' ? await withSealedAccess(() => getDb()) : await getDb();
    const lockGate = await fileLockGate(db, filePassword || undefined, origin);
    if (lockGate.response) return lockGate.response;
    unlocked = Boolean(lockGate.unlocked);
  }

  const limiter = loginLimiter();
  const keys = attemptKeys('login', email, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  // Admitted BEFORE the slow password hash and released after it, so parallel guesses count.
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body, retryAfter } = tooManyAttempts(gate.retryAfterMs);
    return NextResponse.json(body, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  try {
    return await signIn();
  } catch (err) {
    if (err instanceof ServiceError) {
      // e.g. the 40-user seat limit (lib/services/sessions.assertSeatAvailable), a damaged file.
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'CONFLICT' ? 409 : 403 });
    }
    throw err;
  } finally {
    gate.release();
  }

  async function signIn(): Promise<NextResponse> {
    const fail = (message: string) => {
      limiter.recordFailure(keys, Date.now(), weights);
      return NextResponse.json({ error: message, code: 'FORBIDDEN' }, { status: 401 });
    };

    let db: DB;
    if (sealed === 'extract' || sealed === 'conflict') {
      // The file key from the user's own slot in the company file (an unknown user name costs
      // the same derivation as a wrong password), then the working copy from the encrypted file.
      const key = await unlockFromFile({ kind: 'password', login: email, secret: password });
      if (!key) return fail('Invalid email or password.');
      await unsealCompanyFile(key);
      db = await getDb();
      const lockGate = await fileLockGate(db, filePassword || undefined, origin, true);
      if (lockGate.response) return lockGate.response;
      unlocked = unlocked || Boolean(lockGate.unlocked);
    } else if (sealed === 'key') {
      db = await withSealedAccess(() => getDb());
    } else {
      db = await getDb();
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    // An unknown user name costs the same bcrypt work as a wrong password.
    if (!(await verifyPasswordTimed(password, user?.passwordHash)) || !user) {
      return fail('Invalid email or password.');
    }

    // Second factor (TOTP) when enabled.
    if (user.totpEnabled && user.totpSecret) {
      if (!totp) {
        return NextResponse.json({ requires2fa: true });
      }
      if (!verifyTotp(user.totpSecret, String(totp), Date.now())) {
        return fail('Invalid authentication code.');
      }
    }

    // A protected company file: this password must open it (its key slot) — the file key is then
    // known here for saving, and the user's slot is created or re-wrapped when it was missing or stale.
    const protection = await readProtection(db);
    if (protection) {
      const dataDir = resolveDataDir();
      const haveKey = await loadKeyFromPassword(db, dataDir, user.id, password);
      if (!haveKey && (sealed === 'key' || isOpenCompanyFile())) {
        // The password is right (checked above), but nothing here can unlock the file with it.
        return NextResponse.json({ error: NO_SLOT_MESSAGE, code: 'FORBIDDEN', details: { noKeySlot: true } }, { status: 403 });
      }
      if (haveKey && sealed === 'key') await finishKeyUnseal();
      if (haveKey) await refreshSlotAtSignIn(db, user, password);
    }
    limiter.recordSuccess(keys.slice(0, -1)); // keep the global counter

    // Find a company for this user (ACTIVE membership first, else owned).
    // Archived (soft-deleted) companies are never picked (same rule as getServerContext).
    const memberships = await db
      .select({
        companyId: userCompanies.companyId,
        isActive: userCompanies.isActive,
        settings: companies.settings,
      })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(eq(userCompanies.userId, user.id));
    const activeMemberships = memberships.filter((m) => m.isActive);
    let companyId = activeMemberships.find((m) => !isArchivedCompany(m.settings))?.companyId;
    if (!companyId && activeMemberships.length) {
      // Every company this user is active in has been archived — no session.
      return NextResponse.json({ error: ARCHIVED_ONLY_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
    }
    if (!companyId && memberships.length) {
      // Deactivated in every company of this file (Users & Roles) — no session.
      return NextResponse.json({ error: DEACTIVATED_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
    }
    if (!companyId) {
      const owned = await db
        .select({ id: companies.id, settings: companies.settings })
        .from(companies)
        .where(eq(companies.ownerId, user.id));
      companyId = owned.find((c) => !isArchivedCompany(c.settings))?.id;
    }

    // gapsb K: an old password still signs in; when it has expired (file password policy) or an
    // Admin asked for a new one, the session can only choose a new password (/change-password).
    const passwordChange = await passwordStatusAtSignIn(db, user);

    const session = await startSession(db, {
      userId: user.id,
      companyId: companyId ?? null,
      remoteAddr: origin.addr,
      userAgent: origin.userAgent,
      viaHost: origin.remote,
    });

    // filecrypto: an Admin signing in to a single company file without passwords is offered to
    // protect it; a protected file's user whose challenge answer can't open it yet is asked to
    // set the question again. (Only on this computer: a teammate on the network never manages it.)
    let offerProtection = false;
    let challengeSlotMissing = false;
    if (!origin.remote && isOpenCompanyFile()) {
      if (!protection) {
        try {
          await requireFileAdmin({ db, userId: user.id });
          offerProtection = true;
        } catch {
          offerProtection = false;
        }
      } else {
        const st = await protectionStatus({ db, userId: user.id }).catch(() => null);
        challengeSlotMissing = st?.self?.challenge === 'missing';
      }
    }
    const conflictCopy = origin.remote ? null : takeUnsealedConflictCopy();

    const res = NextResponse.json({
      id: user.id,
      name: user.name,
      email: user.email,
      companyId,
      ...(passwordChange ? { mustChangePassword: true, passwordChangeReason: passwordChange } : {}),
      // No challenge question yet: the sign-in screen offers to set one ("I forgot my password").
      ...(!user.challengeQuestion || !user.challengeAnswerHash ? { challengeMissing: true } : {}),
      ...(challengeSlotMissing ? { challengeSlotMissing: true } : {}),
      ...(offerProtection ? { offerProtection: true } : {}),
      ...(conflictCopy ? { conflictCopy } : {}),
    });
    const opts = { httpOnly: true, secure: cookieSecure(origin), sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 'user', session.id), opts);
    if (companyId) res.cookies.set(COMPANY_COOKIE, companyId, opts);
    if (unlocked) res.cookies.set(UNLOCK_COOKIE, createUnlockToken(), { ...opts, maxAge: 60 * 60 * 12 });
    return res;
  }
}
