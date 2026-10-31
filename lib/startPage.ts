/**
 * Preferences > Desktop View "When I open a company file" (prefsperms A2; QB "Show Home page when
 * opening a company file" / "Save the desktop"). Ironbooks is one window, so "the desktop" is the
 * page you were on: with 'last', opening the company file (signing in, or switching to it) goes
 * back there instead of Home.
 *
 * The last page is remembered on this computer per person and company file (localStorage); the
 * "already opened in this sign-in" flag lives in sessionStorage and is cleared at sign-in, so the
 * jump happens once per opening and the Home button still goes Home afterwards.
 */

const LAST_PREFIX = 'ironbooks:lastPage:';
const STARTED_PREFIX = 'ironbooks:started:';

/** Pages never restored: sign-in and set-up screens, and anything outside the app. */
const NOT_RESTORED = ['/login', '/signup', '/onboarding', '/reset-password', '/portal', '/unlock', '/m', '/change-password', '/companies', '/company-file', '/damaged-file', '/forbidden'];

/** May this path (with its query) be remembered and reopened? */
export function isRestorablePath(path: string | null | undefined): path is string {
  if (!path || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const bare = path.split(/[?#]/)[0];
  if (bare === '/' || bare.startsWith('/api')) return false;
  return !NOT_RESTORED.some((p) => bare === p || bare.startsWith(p + '/'));
}

/** Where opening the company file should land: the remembered page, or null for Home. */
export function startPageTarget(pref: 'home' | 'last', currentPath: string, lastPage: string | null): string | null {
  if (pref !== 'last' || currentPath !== '/dashboard') return null;
  if (!isRestorablePath(lastPage) || lastPage === currentPath) return null;
  return lastPage;
}

export function lastPageKey(userId: string, companyId: string): string {
  return `${LAST_PREFIX}${userId}:${companyId}`;
}

export function startedKey(userId: string, companyId: string): string {
  return `${STARTED_PREFIX}${userId}:${companyId}`;
}

/** Called at sign-in: the next opening of each company file may restore the last page again. */
export function clearStartedFlags(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(STARTED_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}
