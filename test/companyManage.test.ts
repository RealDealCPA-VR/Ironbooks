/**
 * Integration tests for company-file management (app/api/companies/[id]/manage.ts):
 *  - access: EFFECTIVE permissions (Enterprise roles), not the legacy role / ownerId.
 *  - rename: Company & Preferences modify (owner/admin/accountant); non-member NOT_FOUND.
 *  - archive (soft delete): Company & Preferences delete, typed-name confirm, only-company guard,
 *    already-archived conflict, audit rows written.
 *  - stampLastOpened: merges settings.lastOpenedAt without clobbering other keys.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, companies, userCompanies, users } from '@/lib/db/schema';
import { ServiceError } from '@/lib/services/_base';
import {
  archiveCompany,
  getAccessInCompany,
  isArchived,
  renameCompany,
  stampLastOpened,
} from '@/app/api/companies/[id]/manage';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-company-manage');
let db: DB;
let ownerId: string;
let adminId: string;
let accountantId: string;
let outsiderId: string;
let companyA: string;
let companyB: string;

async function expectServiceError(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected ServiceError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
  }
}

describe('Company management (integration)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const mkUser = async (email: string) => {
      const [u] = await db
        .insert(users)
        .values({ email, name: email.split('@')[0], passwordHash: 'x' })
        .returning();
      return u.id;
    };
    ownerId = await mkUser('owner@test.local');
    adminId = await mkUser('admin@test.local');
    accountantId = await mkUser('accountant@test.local');
    outsiderId = await mkUser('outsider@test.local');

    const mkCompany = async (name: string) => {
      const [c] = await db.insert(companies).values({ name, ownerId }).returning();
      await db.insert(userCompanies).values({ userId: ownerId, companyId: c.id, role: 'owner' });
      return c.id;
    };
    companyA = await mkCompany('Alpha Books LLC');
    companyB = await mkCompany('Beta Holdings');

    await db.insert(userCompanies).values({ userId: adminId, companyId: companyA, role: 'admin' });
    await db
      .insert(userCompanies)
      .values({ userId: accountantId, companyId: companyA, role: 'accountant' });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('getAccessInCompany', () => {
    it('resolves effective access (legacy memberships map to built-in roles)', async () => {
      expect((await getAccessInCompany(db, ownerId, companyA)).access.isAdmin).toBe(true);
      expect((await getAccessInCompany(db, adminId, companyA)).access.isAdmin).toBe(true);
      const acc = (await getAccessInCompany(db, accountantId, companyA)).access;
      expect(acc.isAdmin).toBe(false);
      expect(acc.permissions.company).toContain('modify');
      expect(acc.permissions.company).not.toContain('delete');
      await expectServiceError(getAccessInCompany(db, outsiderId, companyA), 'NOT_FOUND');
    });
  });

  describe('renameCompany', () => {
    it('owner can rename and an audit row is written', async () => {
      const updated = await renameCompany(db, ownerId, companyA, '  Alpha Books, Inc.  ');
      expect(updated.name).toBe('Alpha Books, Inc.');
      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, companyA), eq(auditLogs.entityType, 'company')));
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((l) => l.action === 'update')).toBe(true);
    });

    it('admin can rename', async () => {
      const updated = await renameCompany(db, adminId, companyA, 'Alpha Books LLC');
      expect(updated.name).toBe('Alpha Books LLC');
    });

    it('accountant (Company & Preferences: modify) can rename', async () => {
      const updated = await renameCompany(db, accountantId, companyA, 'Alpha Books LLC');
      expect(updated.name).toBe('Alpha Books LLC');
    });

    it('non-member gets NOT_FOUND (no existence leak)', async () => {
      await expectServiceError(renameCompany(db, outsiderId, companyA, 'Nope'), 'NOT_FOUND');
    });

    it('rejects empty names', async () => {
      await expectServiceError(renameCompany(db, ownerId, companyA, '   '), 'VALIDATION');
    });
  });

  describe('archiveCompany (soft delete)', () => {
    it('accountant (no Company & Preferences: delete) cannot archive', async () => {
      await expectServiceError(
        archiveCompany(db, accountantId, companyA, 'Alpha Books LLC'),
        'FORBIDDEN',
      );
    });

    it('requires the exact company name typed back', async () => {
      await expectServiceError(archiveCompany(db, ownerId, companyB, 'beta holdings'), 'VALIDATION');
    });

    it('owner archives with correct confirm name; settings flag set', async () => {
      const updated = await archiveCompany(db, ownerId, companyB, 'Beta Holdings');
      expect(isArchived(updated.settings)).toBe(true);
      expect(typeof (updated.settings as Record<string, unknown>).archivedAt).toBe('string');
      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, companyB), eq(auditLogs.action, 'delete')));
      expect(logs.length).toBe(1);
    });

    it('archiving an already-archived company conflicts', async () => {
      await expectServiceError(archiveCompany(db, ownerId, companyB, 'Beta Holdings'), 'CONFLICT');
    });

    it('refuses to archive the only remaining active company', async () => {
      await expectServiceError(
        archiveCompany(db, ownerId, companyA, 'Alpha Books LLC'),
        'CONFLICT',
      );
    });
  });

  describe('stampLastOpened', () => {
    it('sets settings.lastOpenedAt without clobbering existing keys', async () => {
      await db
        .update(companies)
        .set({ settings: { currency: 'USD' } })
        .where(eq(companies.id, companyA));
      await stampLastOpened(db, companyA);
      const [row] = await db.select().from(companies).where(eq(companies.id, companyA));
      const s = row.settings as Record<string, unknown>;
      expect(s.currency).toBe('USD');
      expect(typeof s.lastOpenedAt).toBe('string');
      expect(Number.isNaN(Date.parse(s.lastOpenedAt as string))).toBe(false);
    });

    it('is a no-op for unknown companies', async () => {
      await expect(
        stampLastOpened(db, '00000000-0000-0000-0000-000000000000'),
      ).resolves.toBeUndefined();
    });
  });

  describe('isArchived', () => {
    it('only true for settings.archived === true', () => {
      expect(isArchived(null)).toBe(false);
      expect(isArchived(undefined)).toBe(false);
      expect(isArchived({})).toBe(false);
      expect(isArchived({ archived: 'yes' })).toBe(false);
      expect(isArchived({ archived: true })).toBe(true);
    });
  });
});
