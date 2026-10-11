/**
 * Tiny typed fetch client for the React UI -> Next API routes.
 * All calls are same-origin (the app and API are served by the same Next server, in the browser
 * or inside the Electron renderer). Throws ApiError on non-2xx so callers can surface messages.
 *
 * Closing-date override (QB "Set Closing Date" parity): mutating calls accept an optional
 * `opts.closingPassword`, sent as the `x-closing-password` header that lib/context.ts verifies.
 * Pages can also register a window-level prompt (setClosingPasswordPrompt or
 * window.__bkaClosingPasswordPrompt); when a mutation fails with code PERIOD_CLOSED the client
 * invokes the prompt once and retries with the supplied password.
 *
 * File-lock handling: a 403 "company file is locked" response (stale unlock cookie after an
 * app relaunch — see isFileLockError below) redirects the browser to /unlock before throwing.
 *
 * Multi-user optimistic concurrency: GET responses for invoices, bills, journal entries,
 * customers, vendors and items are scanned for each record's `updatedAt`; a later
 * PATCH/PUT/DELETE of that record automatically sends it as `x-expected-updated-at`, and the
 * server answers 409 ("This record was changed by … Reload to see the latest.") if someone
 * else saved in between. Pages need no changes; see lib/services/concurrency.ts.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
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

/**
 * Returns a closing-date password (or null to cancel). May be async (e.g. open a modal).
 * Transaction pages can adopt this by calling setClosingPasswordPrompt(...) on mount, or by
 * assigning window.__bkaClosingPasswordPrompt.
 */
export type ClosingPasswordPrompt = () => string | null | Promise<string | null>;

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
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'PERIOD_CLOSED' &&
      opts?.closingPassword === undefined
    ) {
      const prompt = resolvePrompt();
      if (prompt) {
        const password = await prompt();
        if (password !== null && password !== undefined) {
          return run({ ...opts, closingPassword: password });
        }
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
