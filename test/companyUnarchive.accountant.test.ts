/**
 * Feature round (accountant) fix: restore an archived company file.
 * archive -> listed only with includeArchived -> unarchive (same right as archive, audited) ->
 * listed again and selectable (isArchivedCompany false).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { closeDb, getDb, type DB } from '@/lib/db';
import { auditLogs, companies, userCompanies, users } from '@/lib/db/schema';
import { isArchivedCompany } from '@/lib/context';
import { listCompaniesForUser } from '@/lib/services/company';
import { archiveCompany, isArchived, unarchiveCompany } from '@/app/api/companies/[id]/manage';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-company-unarchive');
let db: DB;
let ownerId: string;
let viewerId: string;
let a: string;

describe('Unarchive a company', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const mkUser = async (email: string) => (await db.insert(users).values({ email, name: email, passwordHash: 'x' }).returning())[0].id;
    ownerId = await mkUser('owner-ua@test.local');
    viewerId = await mkUser('viewer-ua@test.local');
    const mk = async (name: string) => {
      const [c] = await db.insert(companies).values({ name, ownerId, settings: { closingDate: '2025-12-31' } }).returning();
      await db.insert(userCompanies).values({ userId: ownerId, companyId: c.id, role: 'owner' });
      return c.id;
    };
    a = await mk('Archive Me LLC');
    await mk('Keep Me Inc');
    await db.insert(userCompanies).values({ userId: viewerId, companyId: a, role: 'viewer' });
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('archive -> unarchive -> listed and selectable again; other settings kept; audited', async () => {
    await archiveCompany(db, ownerId, a, 'Archive Me LLC');
    expect((await listCompaniesForUser(db, ownerId, { excludeArchived: true })).some((c) => c.id === a)).toBe(false);
    expect((await listCompaniesForUser(db, ownerId)).some((c) => c.id === a)).toBe(true);
    expect(isArchivedCompany((await db.select().from(companies).where(eq(companies.id, a)))[0].settings)).toBe(true);

    // A member without Company: delete cannot restore it.
    await expect(unarchiveCompany(db, viewerId, a)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const restored = await unarchiveCompany(db, ownerId, a);
    expect(isArchived(restored.settings as Record<string, unknown>)).toBe(false);
    expect((restored.settings as Record<string, unknown>).archivedAt).toBeUndefined();
    expect((restored.settings as Record<string, unknown>).closingDate).toBe('2025-12-31');
    expect((await listCompaniesForUser(db, ownerId, { excludeArchived: true })).some((c) => c.id === a)).toBe(true);
    expect(isArchivedCompany((await db.select().from(companies).where(eq(companies.id, a)))[0].settings)).toBe(false);

    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, a), eq(auditLogs.entityType, 'company')));
    expect(rows.some((r) => (r.newValues as { restored?: boolean } | null)?.restored === true)).toBe(true);

    // Not archived any more: a second restore is a conflict.
    await expect(unarchiveCompany(db, ownerId, a)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
