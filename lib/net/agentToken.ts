/**
 * The access token an agent presents (AGENT_ACCESS.md): `Authorization: Bearer ibka_<tag>_<secret>`.
 *
 * Edge-safe (no Node imports): middleware.ts, lib/net/requestInfo.ts and lib/agentContext.ts all
 * read the header through this one parser, so they can never disagree about what counts as an
 * agent request.
 *
 * The app's own window and the desktop shell never send an Authorization header (people sign in
 * with a cookie; the shell uses x-bka-internal). So ANY Authorization header marks a request as
 * "not the app": it is held to the agent rules or refused, and never falls back to a cookie that
 * came along with it. The header can only lower what a request may do.
 *
 *  - `<tag>`: 8 hex characters naming the company file the token belongs to (not a secret; the
 *    connector uses it to find the running app, lib/agent/endpointFile.ts).
 *  - `<secret>`: 32 random bytes, base64url (43 characters). Only a digest is stored
 *    (lib/services/agents.ts).
 */

export const AGENT_TOKEN_PREFIX = 'ibka_';
export const AGENT_TOKEN_RE = /^ibka_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

type HeaderSource = { get(name: string): string | null };

/** True when the request carries an Authorization header of any kind. */
export function hasAuthorization(h: HeaderSource): boolean {
  const v = h.get('authorization');
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The well-formed agent token in the Authorization header, or null (no header, another scheme, or
 * a value that is not shaped like an agent token).
 */
export function bearerAgentToken(h: HeaderSource): string | null {
  const v = h.get('authorization');
  if (typeof v !== 'string') return null;
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(v);
  if (!m) return null;
  return AGENT_TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** The company-file tag inside a well-formed token, or null. */
export function tokenFileTag(token: string): string | null {
  return AGENT_TOKEN_RE.exec(token)?.[1] ?? null;
}

/** The one route through which an agent asks for a change, a dry run, or a guarded read. */
export const AGENT_ACTION_ROUTE = '/api/agent/actions';

/** True for the one non-read request an agent may make: POST to the action route. */
export function isAgentActionRequest(path: string | null | undefined, method: string | null | undefined): boolean {
  return path === AGENT_ACTION_ROUTE && typeof method === 'string' && method.toUpperCase() === 'POST';
}
