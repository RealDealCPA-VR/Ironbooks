/**
 * Fix round 3 (team users): per-company restore of a company whose Users & Roles were edited.
 * Audit rows point (entityId) at users / company_roles / the company itself — soft pointers that
 * must never be treated as hard foreign keys — and custom roles travel with the company.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, auditLogs, companyRoles, users } from '@/lib/db/schema';
import { createCompany, updateCompany } from './company';
import { createBankAccount } from './bankAccounts';
import { createCompanyBackup, restoreCompanyBackup } from './backup';
import { addUser, createRole } from './users';
import { requireAccessInCompany, resolveAccess } from './access';
import { ServiceError, type ServiceContext } from './_base';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-fix3');

let db: DB;
let ownerId: string;
let companyId: string;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'fix3@test.local', name: 'Fix3 Owner', passwordHash: 'x' })
    .returning();
  ownerId = u.id;
  companyId = (await createCompany(db, { name: 'Fix3 Co', ownerId })).id;
  ctx = { db, companyId, userId: ownerId };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('per-company restore after Users & Roles edits', () => {
  it('restores, keeps custom roles, and remaps company-pointing audit entityIds', async () => {
    const role = await createRole(ctx, { cloneFrom: 'bookkeeper', name: 'Night Bookkeeper' });
    const added = await addUser(ctx, {
      name: 'Stan',
      login: 'stan-fix3',
      password: 'stanpass123',
      roleKeys: ['bookkeeper', role.key],
    });
    await updateCompany(ctx, { name: 'Fix3 Co' });

    const { buffer } = await createCompanyBackup(db, companyId);
    const res = await restoreCompanyBackup(db, buffer, { ownerId, name: 'Fix3 Restored' });
    expect(res.tableCounts.companyRoles).toBe(1);

    const roles = await db.select().from(companyRoles).where(eq(companyRoles.companyId, res.companyId));
    expect(roles.map((r) => r.name)).toEqual(['Night Bookkeeper']);
    expect(roles[0].id).not.toBe(role.key);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.companyId, res.companyId));
    const ids = logs.map((l) => l.entityId);
    // The old company id never leaks into the new company's trail; a user pointer is kept as history.
    expect(ids).not.toContain(companyId);
    expect(ids).toContain(added.userId);
    // The custom role pointer follows the remapped role.
    expect(ids).toContain(roles[0].id);
  });
});

describe('masked account numbers and malformed company ids', () => {
  it('createBankAccount rejects a masked placeholder but accepts a real number', async () => {
    const [gl] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), eq(accounts.type, 'asset')));
    for (const masked of ['••••5544', '****5544']) {
      await expect(
        createBankAccount(ctx, { accountId: gl.id, bankName: 'B', accountNumber: masked }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(
      createBankAccount(ctx, { accountId: gl.id, bankName: 'B', accountNumber: '998877665544' }),
    ).resolves.toBeTruthy();
  });

  it('a malformed company id is FORBIDDEN, not a database error', async () => {
    const err = await requireAccessInCompany(ctx, "x' OR 1=1--", 'file_utilities', 'create').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('FORBIDDEN');
    const r = await resolveAccess(db, 'garbage', ownerId);
    expect(r.member).toBe(false);
  });
});
