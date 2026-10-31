/**
 * Credentials that open a protected backup or copy made with another company file's key
 * (lib/services/sealedArchives.ts) — a user name + password from that file, or its recovery key —
 * travel in request HEADERS, never in a URL (upload routes carry the file itself as the body):
 *
 *   x-ironbooks-login         the user name
 *   x-ironbooks-password      the password, base64url of its UTF-8 bytes (any character survives)
 *   x-ironbooks-recovery-key  the recovery key
 *
 * Wrong credentials are rate-limited like sign-in (lib/net/rateLimit.ts): guessing passwords
 * through an upload is as slow as guessing them at the sign-in screen.
 */
import { ServiceError } from '@/lib/services/errors';
import type { ArchiveCredentials } from '@/lib/services/sealedArchives';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter } from './rateLimit';

export const LOGIN_HEADER = 'x-ironbooks-login';
export const PASSWORD_HEADER = 'x-ironbooks-password';
export const RECOVERY_KEY_HEADER = 'x-ironbooks-recovery-key';

function decodePassword(v: string | null): string | null {
  if (!v) return null;
  try {
    const s = Buffer.from(v, 'base64url').toString('utf8');
    return s || null;
  } catch {
    return null;
  }
}

/** The archive credentials a request carries (null when it carries none). */
export function archiveCredentialsFrom(headers: Headers): ArchiveCredentials | null {
  const login = headers.get(LOGIN_HEADER)?.trim() || null;
  const password = decodePassword(headers.get(PASSWORD_HEADER));
  const recoveryKey = headers.get(RECOVERY_KEY_HEADER)?.trim() || null;
  if (!recoveryKey && !(login && password)) return null;
  return { login, password, recoveryKey };
}

/**
 * Run `fn` (which may open a protected archive with `credentials`) under the sign-in rate limit:
 * refused while too many wrong attempts were made from this address; a wrong user name / password
 * / recovery key (ServiceError details.wrongCredentials) counts as one.
 */
export async function withArchiveCredentialLimit<T>(
  credentials: ArchiveCredentials | null,
  addr: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!credentials) return fn();
  const limiter = loginLimiter();
  const keys = attemptKeys('archive', credentials.login ?? null, addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    throw new ServiceError('FORBIDDEN', 'Too many wrong passwords. Wait a minute and try again.', {
      credentialsRequired: true,
      rateLimited: true,
      retryAfterMs: gate.retryAfterMs,
    });
  }
  try {
    const out = await fn();
    limiter.recordSuccess(keys.slice(0, -1));
    return out;
  } catch (err) {
    if (err instanceof ServiceError && (err.details as { wrongCredentials?: boolean } | undefined)?.wrongCredentials) {
      limiter.recordFailure(keys, Date.now(), weights);
    }
    throw err;
  } finally {
    gate.release();
  }
}

/**
 * The password of a portable company file (.bkp) or an Accountant's Copy transfer file (.ibac)
 * being opened (lib/services/portableFile.ts unlockPortableBuffer): the same header, base64url.
 */
export function filePasswordFrom(headers: Headers): string | null {
  return decodePassword(headers.get(PASSWORD_HEADER));
}

/**
 * Run `fn` (which may try `password` on a password-protected file) under the sign-in rate limit:
 * refused while too many wrong passwords were tried from this address; a wrong one
 * (ServiceError details.wrongPassword) counts as one attempt.
 */
export async function withFilePasswordLimit<T>(password: string | null, addr: string, fn: () => Promise<T>): Promise<T> {
  if (!password) return fn();
  const limiter = loginLimiter();
  const keys = attemptKeys('file-password', null, addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    throw new ServiceError('FORBIDDEN', 'Too many wrong passwords. Wait a minute and try again.', {
      passwordRequired: true,
      rateLimited: true,
      retryAfterMs: gate.retryAfterMs,
    });
  }
  try {
    const out = await fn();
    limiter.recordSuccess(keys.slice(0, -1));
    return out;
  } catch (err) {
    if (err instanceof ServiceError && (err.details as { wrongPassword?: boolean } | undefined)?.wrongPassword) {
      limiter.recordFailure(keys, Date.now(), weights);
    }
    throw err;
  } finally {
    gate.release();
  }
}
