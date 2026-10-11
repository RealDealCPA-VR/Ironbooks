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

export class ServiceError extends Error {
  constructor(
    public code: ServiceErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
