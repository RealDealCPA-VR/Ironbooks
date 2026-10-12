/**
 * Tiny typed fetch client for the React UI -> Next API routes.
 * All calls are same-origin (the app and API are served by the same Next server, in the browser
 * or inside the Electron renderer). Throws ApiError on non-2xx so callers can surface messages.
 *
 * Closing-date override (QB "Set Closing Date" parity): mutating calls accept an optional
 * `opts.closingPassword`, sent as the `x-closing-password` header that lib/context.ts verifies.
 * The app shell registers a modal prompt (components/ClosingPasswordProvider.tsx via
 * setClosingPasswordPrompt; window.__bkaClosingPasswordPrompt is a fallback). When a mutation
 * fails with PERIOD_CLOSED because of the closing date, the client asks for the password and
 * retries; a wrong password re-asks (up to MAX_CLOSING_PASSWORD_ATTEMPTS) with a plain message.
 * The server records each accepted override on the Closing Date Exception report.
 *
 * File-lock handling: a 403 "company file is locked" response (stale unlock cookie after an
 * app relaunch — see isFileLockError below) redirects the browser to /unlock before throwing.
 *
 * Multi-user optimistic concurrency: GET responses for invoices, bills, journal entries,
 * customers, vendors and items are scanned for each record's `updatedAt`; a later
 * PATCH/PUT/DELETE of that record automatically sends it as `x-expected-updated-at`, and the
 * server answers 409 ("This record was changed by … Reload to see the latest.") if someone
 * else saved in between. Pages need no changes; see lib/services/concurrency.ts.
 *
 * Friendly errors: ApiError.friendly (and toastError in components/ui.tsx) translate the
 * server's ServiceError code into plain language with a next step — see lib/friendlyErrors.ts.
 */
import { describeError, type FriendlyError } from '@/lib/friendlyErrors';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Plain-language version of this error (headline, what happened, what to do next), mapped
   * from the ServiceError code by lib/friendlyErrors.ts. `message` stays the raw server text
   * for callers that match on it; UI should prefer toastError(err) / this.friendly.
   */
  get friendly(): FriendlyError {
    return describeError(this);
  }
}

/** Header verified by getServerContext (lib/context.ts CLOSING_PASSWORD_HEADER). */
export const CLOSING_PASSWORD_HEADER = 'x-closing-password';

/** Options accepted by mutating calls (post/patch/del). */
export interface MutateOpts {
  /** Closing-date override password, sent as x-closing-password. */
  closingPassword?: string;
  /** Extra headers to merge into the request. */
  headers?: Record<string, string>;
}

/** What the closing-date password prompt is told about why it is being shown. */
export interface ClosingPasswordPromptInfo {
  /** The server's plain-language PERIOD_CLOSED message. */
  message: string;
  /** True when the password just tried was not accepted (wrong password, or no permission). */
  rejected: boolean;
}

/**
 * Returns a closing-date password (or null to cancel). May be async (e.g. open a modal).
 * Registered app-wide by components/ClosingPasswordProvider.tsx (mounted in app/layout.tsx);
 * window.__bkaClosingPasswordPrompt is still honored as a fallback.
 */
export type ClosingPasswordPrompt = (
  info?: ClosingPasswordPromptInfo,
) => string | null | Promise<string | null>;

/** Most password attempts the client makes for one save before giving up. */
export const MAX_CLOSING_PASSWORD_ATTEMPTS = 3;

/**
 * True when a PERIOD_CLOSED error can be overridden with the closing-date password. A closed
 * fiscal period (Fiscal Periods screen) can't — it must be reopened — so no prompt is shown.
 * Coupled to the messages thrown by assertPeriodOpen (lib/services/fiscalPeriods.ts).
 */
export function isClosingPasswordError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.code === 'PERIOD_CLOSED' &&
    !/accounting period containing .* is closed/i.test(err.message)
  );
}

let closingPasswordPrompt: ClosingPasswordPrompt | null = null;

/** Register (or clear, with null) the app-wide closing-date password prompt. */
export function setClosingPasswordPrompt(prompt: ClosingPasswordPrompt | null): void {
  closingPasswordPrompt = prompt;
}

function resolvePrompt(): ClosingPasswordPrompt | null {
  if (closingPasswordPrompt) return closingPasswordPrompt;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __bkaClosingPasswordPrompt?: ClosingPasswordPrompt };
    if (typeof w.__bkaClosingPasswordPrompt === 'function') return w.__bkaClosingPasswordPrompt;
  }
  return null;
}

/**
 * True when a failed response means the company file is locked. Coupled to the exact message
 * getServerContext throws in lib/context.ts ("This company file is locked. Unlock it to
 * continue.") — keep the two in sync.
 */
export function isFileLockError(status: number, message: string): boolean {
  return status === 403 && /company file is locked/i.test(message);
}

/**
 * True when a failed response means there is no valid session for THIS company file (expired,
 * minted by another company file, or the user was deactivated). Coupled to the messages thrown by
 * getServerContext in lib/context.ts ('Authentication required.' / DEACTIVATED_MESSAGE).
 */
export function isAuthError(status: number, message: string): boolean {
  return (
    (status === 401 || status === 403) &&
    (message === 'Authentication required.' || /account has been deactivated/i.test(message))
  );
}

const AUTH_PAGES = ['/login', '/signup', '/unlock', '/reset-password'];

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error || res.statusText;
    // Stale unlock cookie: after an app relaunch the 12h bka_unlock cookie is still present
    // (so middleware's presence-only check renders pages) but its token no longer matches the
    // fresh per-launch nonce, so EVERY API call 403s. Send the user back to /unlock to re-enter
    // the file password instead of soft-locking them behind failing toasts. Still throw so
    // callers' catch blocks run while the navigation proceeds.
    if (
      isFileLockError(res.status, message) &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/unlock'
    ) {
      window.location.assign(
        '/unlock?next=' + encodeURIComponent(window.location.pathname + window.location.search),
      );
    }
    // Session not valid for this company file (e.g. after switching files): back to sign-in.
    else if (
      isAuthError(res.status, message) &&
      typeof window !== 'undefined' &&
      !AUTH_PAGES.includes(window.location.pathname)
    ) {
      window.location.assign(
        '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search),
      );
    }
    throw new ApiError(res.status, message, data?.code);
  }
  return data as T;
}

// ---- optimistic-concurrency version cache ----

/** Header verified by lib/services/concurrency.ts (EXPECTED_VERSION_HEADER). */
export const EXPECTED_VERSION_HEADER = 'x-expected-updated-at';

const VERSIONED_PATH =
  /^\/api\/(invoices|bills|journal-entries|customers|vendors|items)(?:\/([^/]+))?\/?$/;
/** '/api/<resource>/<id>' → updatedAt (ISO) the user last loaded. */
const loadedVersions = new Map<string, string>();

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0];
  }
}

type Rec = { id?: unknown; updatedAt?: unknown };
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Remember record versions seen in a response from one of the versioned resources. */
export function rememberVersions(url: string, data: unknown): void {
  const m = VERSIONED_PATH.exec(pathOf(url));
  if (!m || !data || typeof data !== 'object') return;
  const base = `/api/${m[1]}`;
  const note = (r: unknown, onlyId?: string) => {
    if (!isRec(r) || typeof r.id !== 'string' || typeof r.updatedAt !== 'string') return false;
    if (onlyId && r.id !== onlyId) return false;
    loadedVersions.set(`${base}/${r.id}`, r.updatedAt);
    return true;
  };
  const values = Array.isArray(data) ? [data] : [data, ...Object.values(data as object)];
  if (m[2]) {
    // Detail: the record itself, or wrapped one level deep ({ entry }, { item }).
    if (!values.some((v) => note(v, m[2]))) loadedVersions.delete(`${base}/${m[2]}`);
  } else {
    // List: a bare array, or arrays one level deep ({ customers: [...] }).
    for (const v of values) if (Array.isArray(v)) v.forEach((r) => note(r));
  }
}

function versionFor(method: string, url: string): string | undefined {
  if (method === 'POST') return undefined;
  const path = pathOf(url).replace(/\/$/, '');
  const m = VERSIONED_PATH.exec(path);
  return m && m[2] ? loadedVersions.get(path) : undefined;
}

function mutateHeaders(opts?: MutateOpts, hasBody?: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...(opts?.headers || {}) };
  if (hasBody) headers['content-type'] = 'application/json';
  if (opts?.closingPassword !== undefined) headers[CLOSING_PASSWORD_HEADER] = opts.closingPassword;
  return headers;
}

/**
 * Run a mutating request; on PERIOD_CLOSED, ask the registered prompt for the closing-date
 * password and retry exactly once. Explicitly supplied passwords are never re-prompted.
 */
async function mutate<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  opts?: MutateOpts,
): Promise<T> {
  const hasBody = body !== undefined;
  const version = versionFor(method, url);
  const run = (o?: MutateOpts) => {
    const headers = mutateHeaders(o, hasBody);
    if (version && !headers[EXPECTED_VERSION_HEADER]) headers[EXPECTED_VERSION_HEADER] = version;
    return fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    })
      .then((r) => handle<T>(r))
      .then((data) => {
        // The saved record's new version (or forget it, so the next save isn't a false 409).
        if (version) rememberVersions(url, data);
        return data;
      });
  };

  try {
    return await run(opts);
  } catch (first) {
    // Explicitly supplied passwords are never re-prompted.
    if (!isClosingPasswordError(first) || opts?.closingPassword !== undefined) throw first;
    const prompt = resolvePrompt();
    if (!prompt) throw first;
    let err: ApiError = first;
    for (let attempt = 0; attempt < MAX_CLOSING_PASSWORD_ATTEMPTS; attempt++) {
      const password = await prompt({ message: err.message, rejected: attempt > 0 });
      if (password === null || password === undefined) throw err;
      try {
        return await run({ ...opts, closingPassword: password });
      } catch (retryErr) {
        // Still refused by the closing date: the password was wrong (or this user may not
        // change closed-period transactions). Ask again with a plain message.
        if (!isClosingPasswordError(retryErr)) throw retryErr;
        err = new ApiError(
          retryErr.status,
          'That closing date password is not correct, or your role is not allowed to change transactions on or before the closing date.',
          retryErr.code,
        );
      }
    }
    throw err;
  }
}

export const api = {
  get: <T = unknown>(url: string) =>
    fetch(url, { cache: 'no-store' })
      .then((r) => handle<T>(r))
      .then((data) => {
        rememberVersions(url, data);
        return data;
      }),
  post: <T = unknown>(url: string, body?: unknown, opts?: MutateOpts) =>
    mutate<T>('POST', url, body, opts),
  patch: <T = unknown>(url: string, body?: unknown, opts?: MutateOpts) =>
    mutate<T>('PATCH', url, body, opts),
  put: <T = unknown>(url: string, body?: unknown, opts?: MutateOpts) =>
    mutate<T>('PUT', url, body, opts),
  del: <T = unknown>(url: string, opts?: MutateOpts) => mutate<T>('DELETE', url, undefined, opts),
};
