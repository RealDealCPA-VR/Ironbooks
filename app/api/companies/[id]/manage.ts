/**
 * Company-file management helpers: rename, archive (soft delete), and last-opened stamping.
 *
 * Lives next to the [id] route (not in lib/services/company.ts, which is owned by another
 * workstream this wave) but follows the service conventions: ServiceError codes, audit rows,
 * companyId scoping. Unlike most services these take an explicit (db, userId, companyId)
 * because they operate on a company chosen in the URL, which may differ from the caller's
 * currently-active company.
 *
 * WHY SOFT DELETE: companies.settings.archived = true, filtered from listings, instead of a
 * hard DELETE. The schema declares FK references but PGlite/Drizzle has no ON DELETE CASCADE
 * configured, and ~80 child tables reference company_id (GL, documents, payroll, audit logs).
 * A hard delete would need a hand-maintained, dependency-ordered table list that silently
 * drifts as the schema evolves, and it would destroy the audit trail. Archiving preserves
 * books integrity and is reversible; true file deletion is deferred to the per-company
 * data-directory work in the desktop shell (deleting the PGlite dir removes everything at once).
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { companies, userCompanies } from '@/lib/db/schema';
import { ServiceError, notFound, validation, writeAudit } from '@/lib/services/_base';
import { permissionDenied, resolveAccess } from '@/lib/services/access';
import { can, type EffectiveAccess } from '@/lib/permissions/model';

export type CompanyRow = typeof companies.$inferSelect;
export type CompanySettings = Record<string, unknown>;

/** True when the company has been soft-deleted (settings.archived). */
export function isArchived(settings: CompanySettings | null | undefined): boolean {
  return Boolean(settings && (settings as { archived?: unknown }).archived === true);
}

/**
 * The caller's EFFECTIVE access in the given company (Enterprise roles — union of assigned
 * roles, lib/services/access.ts), never the legacy user_companies.role or companies.ownerId
 * alone: a creator demoted to View-Only, or a deactivated Admin, loses company management.
 * Non-members get NOT_FOUND (don't reveal other tenants' files); deactivated members FORBIDDEN.
 */
export async function getAccessInCompany(
  db: DB,
  userId: string,
  companyId: string,
): Promise<{ company: CompanyRow; access: EffectiveAccess }> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound('company');
  const resolved = await resolveAccess(db, companyId, userId);
  if (!resolved.member) throw notFound('company');
  if (!resolved.active) {
    throw new ServiceError(
      'FORBIDDEN',
      'Your user account has been deactivated for this company. Contact your administrator.',
    );
  }
  return { company, access: resolved.access };
}

/** Rename a company file. Needs Company & Preferences: modify in that company. */
export async function renameCompany(
  db: DB,
  userId: string,
  companyId: string,
  name: string,
): Promise<CompanyRow> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw validation('Company name is required.');
  if (trimmed.length > 255) throw validation('Company name must be 255 characters or fewer.');

  const { company, access } = await getAccessInCompany(db, userId, companyId);
  if (!can(access, 'company', 'modify')) throw permissionDenied('company', 'modify');
  // Archived files are hidden from the companies page and can't be opened; don't edit them either.
  if (isArchived(company.settings)) throw notFound('company');

  const [updated] = await db
    .update(companies)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(companies.id, companyId))
    .returning();

  await writeAudit(
    { db, companyId, userId },
    {
      action: 'update',
      entityType: 'company',
      entityId: companyId,
      oldValues: { name: company.name },
      newValues: { name: updated.name },
    },
  );
  return updated;
}

/**
 * Archive (soft-delete) a company file. Needs Company & Preferences: delete; requires the company name typed back
 * exactly (QB-style destructive confirm); refuses when it is the caller's only active company.
 */
export async function archiveCompany(
  db: DB,
  userId: string,
  companyId: string,
  confirmName: string,
): Promise<CompanyRow> {
  const { company, access } = await getAccessInCompany(db, userId, companyId);
  if (!can(access, 'company', 'delete')) throw permissionDenied('company', 'delete');
  if (isArchived(company.settings)) {
    throw new ServiceError('CONFLICT', 'This company is already archived.');
  }
  if ((confirmName ?? '').trim() !== company.name) {
    throw validation('Type the company name exactly to confirm archiving.');
  }

  // Guard: never leave the user without an active company file (active memberships only).
  const memberships = await db
    .select({ company: companies })
    .from(companies)
    .innerJoin(userCompanies, eq(userCompanies.companyId, companies.id))
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.isActive, true)));
  const activeOthers = memberships.filter(
    (m) => m.company.id !== companyId && !isArchived(m.company.settings),
  );
  if (activeOthers.length === 0) {
    throw new ServiceError(
      'CONFLICT',
      'You cannot archive your only company. Create another company first.',
    );
  }

  const settings: CompanySettings = {
    ...((company.settings ?? {}) as CompanySettings),
    archived: true,
    archivedAt: new Date().toISOString(),
  };
  const [updated] = await db
    .update(companies)
    .set({ settings, updatedAt: new Date() })
    .where(eq(companies.id, companyId))
    .returning();

  await writeAudit(
    { db, companyId, userId },
    {
      action: 'delete',
      entityType: 'company',
      entityId: companyId,
      oldValues: { archived: false },
      newValues: { archived: true, archivedAt: settings.archivedAt },
    },
  );
  return updated;
}

/**
 * Record settings.lastOpenedAt = now (ISO). Called by /api/companies/select so the companies
 * page can order files by recency. Best-effort merge; never throws on a missing row.
 */
export async function stampLastOpened(db: DB, companyId: string): Promise<void> {
  const [company] = await db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) return;
  const settings: CompanySettings = {
    ...((company.settings ?? {}) as CompanySettings),
    lastOpenedAt: new Date().toISOString(),
  };
  await db.update(companies).set({ settings }).where(eq(companies.id, companyId));
}
