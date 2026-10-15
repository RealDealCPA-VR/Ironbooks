/**
 * ServiceError — the typed error every service throws and every API route maps to an HTTP
 * status. Dependency-free so the database layer (lib/db/pgErrors.ts) can raise it too; re-exported
 * by lib/services/_base.ts, which is where services import it from.
 */
export type ServiceErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'UNBALANCED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PERIOD_CLOSED'
  | 'INTERNAL';

/**
 * Optional machine-readable fix suggestions (lib/errorFixes.ts ErrorFix), serialized by the API
 * routes as `fixes` next to `error`/`code`/`details`. Typed structurally here so this module stays
 * dependency-free.
 */
export interface ServiceErrorFix {
  id: string;
  label: string;
  kind: 'patch' | 'navigate' | 'retry';
  patch?: Array<{ op: 'set' | 'add' | 'remove' | 'pull'; path: string; value?: unknown; amount?: string }>;
  href?: string;
  needs?: 'closingPassword';
  hint?: string;
}

export class ServiceError extends Error {
  /** "Fix errors where they happen": concrete fixes the UI offers as buttons. */
  public fixes?: ServiceErrorFix[];

  constructor(
    public code: ServiceErrorCode,
    message: string,
    public details?: unknown,
    fixes?: ServiceErrorFix[],
  ) {
    super(message);
    this.name = 'ServiceError';
    if (fixes && fixes.length) this.fixes = fixes;
  }

  /** Attach (more) fixes and return this error, for `throw err.withFixes(...)`. */
  withFixes(fixes: ServiceErrorFix[] | null | undefined): this {
    if (fixes && fixes.length) this.fixes = [...(this.fixes ?? []), ...fixes];
    return this;
  }
}
