/**
 * POST /api/auth/recover — the way back in when every password is lost: the company file's
 * RECOVERY KEY (shown once when the file was protected with passwords, lib/services/fileProtection.ts)
 * sets a new password for one of the file's Admins.
 * Body: { recoveryKey, login, password, clearFilePassword? }
 *
 * The recovery key opens the file's recovery key slot: while the server is still sealed
 * (lib/db/sealed.ts) that decrypts the company file, exactly like a sign-in would. The chosen user
 * must be an Admin of every company in the file; their new password follows the file's password
 * policy, gets its own key slot, and two-factor sign-in is turned off for them (a lost phone is
 * another way to be locked out). `clearFilePassword` also removes a forgotten company file
 * password. Every other session of that user ends. Only on the computer that has the file open
 * (never for a teammate connected over the network), and rate-limited like every other secret.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { needsSignInToRecover, recoverSealedWorkingCopy } from '@/lib/services/workingCopyRecovery';
import { getDb, resolveDataDir, sealedMode, withDamagedFileAccess, withSealedAccess, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth';
import { ServiceError } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';
import { assertPasswordAllowed, storeUserPassword } from '@/lib/services/passwordPolicy';
import { endUserSessions } from '@/lib/services/sessions';
import { getFileLockStatus, removeFilePasswordWithRecoveryKey } from '@/lib/services/fileLock';
import { logTransaction } from '@/lib/services/transactionLog';
import {
  finishKeyUnseal,
  loadKeyFromRecovery,
  readProtection,
  unlockFromFile,
  unsealCompanyFile,
} from '@/lib/services/fileProtection';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, resetLimiter, tooManyResets } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';

const WRONG_KEY_MESSAGE = 'That recovery key does not open this company file. Check each group of four characters.';

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const recoveryKey = typeof body.recoveryKey === 'string' ? body.recoveryKey : '';
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!recoveryKey.trim() || !login || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `The recovery key, an Admin's user name and a new password (min ${MIN_PASSWORD_LENGTH} characters) are required.`, code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const origin = originFromHeaders(req.headers);
  if (origin.remote) {
    return NextResponse.json({ error: 'Use the recovery key on the computer that has the company file open.', code: 'FORBIDDEN' }, { status: 403 });
  }
  const limiter = resetLimiter();
  const keys = attemptKeys('recover', null, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body: tooMany, retryAfter } = tooManyResets(gate.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  const fail = () => {
    limiter.recordFailure(keys, Date.now(), weights);
    return NextResponse.json({ error: WRONG_KEY_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
  };
  try {
    let sealed = sealedMode();
    let db: DB | null = null;
    if (sealed === 'key') {
      try {
        db = await withSealedAccess(() => getDb());
      } catch (err) {
        if (!needsSignInToRecover(err)) throw err;
        // The working copy here will not start: the recovery key must open the company file itself
        // before anything is set aside (lib/services/workingCopyRecovery.ts), then the company
        // file's last save is decrypted with it, like opening it on a new computer.
        const key = await unlockFromFile({ kind: 'recovery', secret: recoveryKey });
        if (!key) return fail();
        sealed = await recoverSealedWorkingCopy(key);
        if (sealed === 'extract' || sealed === 'conflict') {
          await unsealCompanyFile(key);
          db = await getDb();
        } else {
          db = await withSealedAccess(() => getDb()); // it started after all
        }
      }
    }
    if (db && sealed !== 'key') {
      // Reopened from the company file above: the recovery key already opened it.
    } else if (sealed === 'extract' || sealed === 'conflict') {
      const key = await unlockFromFile({ kind: 'recovery', secret: recoveryKey });
      if (!key) return fail();
      await unsealCompanyFile(key);
      db = await getDb();
    } else {
      db = db ?? (sealed === 'key' ? await withSealedAccess(() => getDb()) : await getDb());
      if (!(await readProtection(db))) {
        return NextResponse.json(
          { error: 'This company file is not protected with passwords, so it has no recovery key. Ask an Admin to reset your password.', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      // Proves the key whether or not this server already holds the file key.
      if (!(await loadKeyFromRecovery(db, resolveDataDir(), recoveryKey))) return fail();
      await finishKeyUnseal(db);
    }
    limiter.recordSuccess(keys.slice(0, -1));

    const [user] = await db.select({ id: users.id, name: users.name, email: users.email, hash: users.passwordHash }).from(users).where(eq(users.email, login));
    try {
      if (!user || !user.hash || user.hash === 'dev') throw new ServiceError('FORBIDDEN', 'no such user');
      await requireFileAdmin({ db, userId: user.id });
    } catch {
      return NextResponse.json(
        { error: 'Enter the user name of an Admin of every company in this file (Users and Roles shows who that is).', code: 'FORBIDDEN', details: { recovered: true } },
        { status: 403 },
      );
    }
    try {
      await assertPasswordAllowed(db, password, { userId: user.id });
    } catch (err) {
      if (err instanceof ServiceError) return NextResponse.json({ error: err.message, code: err.code, details: { recovered: true } }, { status: 400 });
      throw err;
    }
    let twoFactorTurnedOff = false;
    let filePasswordRemoved = false;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      await storeUserPassword(tx, user.id, password, { mustChange: false });
      const off = await tx
        .update(users)
        .set({ totpEnabled: false, totpSecret: null, totpRecoveryCodes: null, updatedAt: new Date() })
        .where(and(eq(users.id, user.id), eq(users.totpEnabled, true)))
        .returning({ id: users.id });
      twoFactorTurnedOff = off.length > 0;
      if (body.clearFilePassword === true) filePasswordRemoved = await removeFilePasswordWithRecoveryKey(tx);
      await endUserSessions(tx, user.id, 'password_reset');
      await logTransaction(tx, {
        userId: user.id,
        action: 'update',
        entityType: 'user',
        entityId: user.id,
        summary: `Used the company file's recovery key to set a new password for "${user.name}"`,
        data: { new: { passwordChanged: true, viaRecoveryKey: true, ...(filePasswordRemoved ? { filePasswordRemoved: true } : {}) } },
      });
    });
    const lock = await getFileLockStatus(db);
    return NextResponse.json({ ok: true, login: user.email, twoFactorTurnedOff, filePasswordRemoved, filePassword: lock.enabled });
  } catch (err) {
    return routeError(err, 'POST /api/auth/recover');
  } finally {
    gate.release();
  }
}
