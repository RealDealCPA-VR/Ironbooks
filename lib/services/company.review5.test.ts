/**
 * Round-5 review regressions (company settings / closing date):
 *  A. The closing-date password hash never leaves the server: not in GET /api/company (any member
 *     can call it), not in the company list, not in the audit trail of a Preferences save.
 *  B. A Preferences save and a Set Closing Date running at the same time never lose each other's
 *     change (both used to read the whole settings object, then write it back).
 *  C. A closing date that is not a real calendar day is refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, desc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, userCompanies, auditLogs } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { fullAccess } from '@/lib/permissions/model';
import {
  getClosingDateSettings,
  getCompany,
  listCompanies,
  listCompaniesForUser,
  setClosingDate,
  updateCompany,
} from './company';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as companyGET, PATCH as companyPATCH } from '@/app/api/company/route';
import { GET as txLogGET } from '@/app/api/transaction-log/route';
import { writeAudit } from './_base';
import { getAuditLog } from './auditTrail';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-company');
let db: DB;
let userId: string;

const hasHash = (v: unknown) => JSON.stringify(v ?? null).includes('closingDatePasswordHash');

describe('company settings (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@company.test', name: 'Cora', passwordHash: 'x' }).returning();
    userId = user.id;
    const [company] = await db.insert(companies).values({ name: 'Review5 Co', ownerId: user.id, settings: {} }).returning();
    await db.insert(userCompanies).values({ userId: user.id, companyId: company.id, role: 'owner' });
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: the closing-date password hash is not returned by GET/PATCH /api/company, the company list or the audit trail', async () => {
    await setClosingDate(ctx, { closingDate: '2025-12-31', password: 'secret-pw' });
    // The hash is stored (the closing-date check needs it) ...
    const raw = await getCompany(ctx);
    expect(hasHash(raw?.settings)).toBe(true);

    // ... but never handed to the browser.
    const res = await companyGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(hasHash(body)).toBe(false);
    expect(body.settings.closingDate).toBe('2025-12-31');

    const patched = await companyPATCH(
      new NextRequest('http://localhost/api/company', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { legalName: 'Review Five LLC' } }),
      }),
    );
    expect(patched.status).toBe(200);
    expect(hasHash(await patched.json())).toBe(false);

    expect(hasHash(await listCompaniesForUser(db, userId))).toBe(false);
    expect(hasHash(await listCompanies(db))).toBe(false);

    // The Preferences save's audit row (Audit Trail, transaction log) does not carry it either.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(hasHash(audit.oldValues)).toBe(false);
    expect(hasHash(audit.newValues)).toBe(false);

    // The closing date itself still works.
    expect(await getClosingDateSettings(ctx)).toEqual({ closingDate: '2025-12-31', hasPassword: true });
  });

  it('B: a Preferences save at the same time as Set Closing Date keeps both changes', async () => {
    // A signed-in Admin (permissions already resolved by getServerContext, as for every request).
    const admin: ServiceContext = { ...ctx, access: fullAccess(), role: 'owner' };
    await setClosingDate(admin, { closingDate: null });
    await Promise.all([
      setClosingDate(admin, { closingDate: '2026-03-31', password: 'race-pw' }),
      updateCompany(admin, { settings: { phone: '(555) 010-2020' } }),
    ]);
    const settings = (await getCompany(ctx))!.settings as Record<string, unknown>;
    expect(settings.phone).toBe('(555) 010-2020');
    expect(settings.closingDate).toBe('2026-03-31');
    expect(await getClosingDateSettings(ctx)).toEqual({ closingDate: '2026-03-31', hasPassword: true });

    // And the other order of arrival.
    await Promise.all([
      updateCompany(admin, { settings: { phone: '(555) 010-3030' } }),
      setClosingDate(admin, { closingDate: '2026-04-30', password: 'race-pw-2' }),
    ]);
    const after = (await getCompany(ctx))!.settings as Record<string, unknown>;
    expect(after.phone).toBe('(555) 010-3030');
    expect(after.closingDate).toBe('2026-04-30');
  });

  it('A2: audit rows and transaction-log records written before the fix do not hand the hash out', async () => {
    // What an older build wrote for a Preferences save: the whole settings object, hash included.
    const legacy = { name: 'Review5 Co', settings: { phone: '1', closingDate: '2025-12-31', closingDatePasswordHash: '$2a$10$legacyhashlegacyhashlegacyha' } };
    await writeAudit(ctx, { action: 'update', entityType: 'company', entityId: ctx.companyId, oldValues: legacy, newValues: legacy });
    const [row] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    const detail = await getAuditLog(ctx, row.id);
    expect(hasHash(detail.oldValues)).toBe(false);
    expect(hasHash(detail.newValues)).toBe(false);
    expect((detail.newValues as typeof legacy).settings.closingDate).toBe('2025-12-31');

    const owner: ServiceContext = { ...ctx, role: 'owner' };
    const saved = ctx;
    ctx = owner;
    try {
      const res = await txLogGET(new NextRequest('http://localhost/api/transaction-log?entityType=company&limit=50'));
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page.rows.length).toBeGreaterThan(0);
      expect(hasHash(page.rows)).toBe(false);
    } finally {
      ctx = saved;
    }
  });

  it('C: a closing date that is not a real day is refused (400), not stored', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10']) {
      const err = await setClosingDate(ctx, { closingDate: bad }).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
    expect((await getClosingDateSettings(ctx)).closingDate).toBe('2026-04-30');
  });
});
