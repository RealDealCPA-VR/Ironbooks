/**
 * Security 2.5 — a per-company backup carried password hashes (lib/services/backup.ts).
 *
 * The export (Accountant-level "create backup" right) wrote company.settings whole — the
 * closing-date password hash and the file-password hash — and employees' portal password hashes.
 * A bcrypt hash can be cracked offline, and the closing-date password exists to stop exactly the
 * roles that can make this backup. They are now left out (stripSecrets, the rule for every API
 * answer). Restoring always creates a NEW company, so no existing password is replaced or
 * cleared: the source company keeps everything; the restored one keeps its closing date, and its
 * closing-date and portal passwords are set again there. An older backup that still carries them
 * restores them as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, employees, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, getClosingDateSettings, setClosingDate } from './company';
import { createEmployee } from './payroll';
import { getFileLockStatus, setFilePassword } from './fileLock';
import { createCompanyBackup, exportCompanyData, restoreCompanyBackup } from './backup';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-company-backup-secrets');

let db: DB;
let userId: string;
let ctx: ServiceContext;
let employeeId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  process.env.BKA_DATA_DIR = TEST_DIR;
  const [user] = await db.insert(users).values({ email: 'secrets@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = user.id;
  const company = await createCompany(db, { name: 'Secret Co', ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close-pw' });
  await setFilePassword(db, 'file-password');
  const emp = await createEmployee(ctx, { firstName: 'Pat', lastName: 'Lee', payType: 'hourly' as never, payRate: '20.00' });
  employeeId = emp.id;
  await db.update(employees).set({ portalPasswordHash: '$2b$10$abcdefghijklmnopqrstuuJ0hX2nV8b3s9m3kQe6m6P0B0e5m6P0B' }).where(eq(employees.id, employeeId));
}, 180_000);

afterAll(async () => {
  delete process.env.BKA_DATA_DIR;
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

const dataOf = (buffer: Buffer) => new AdmZip(buffer).getEntry('company-data.json')!.getData().toString('utf8');

describe('per-company backup without password hashes', () => {
  it('the backup carries no hash: closing-date, file password, portal passwords (also not inside audit values)', async () => {
    const [src] = await db.select().from(companies).where(eq(companies.id, ctx.companyId));
    const settings = src.settings as Record<string, any>;
    expect(typeof settings.closingDatePasswordHash).toBe('string');
    expect(typeof settings.fileLock?.hash).toBe('string');

    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const text = dataOf(buffer);
    expect(text).not.toContain('closingDatePasswordHash');
    expect(text).not.toContain('portalPasswordHash');
    expect(text).not.toContain(settings.closingDatePasswordHash);
    expect(text).not.toContain(settings.fileLock.hash);
    expect(text).not.toMatch(/\$2[aby]\$\d\d\$/); // no bcrypt hash anywhere
    const data = JSON.parse(text);
    // What is not a secret still travels: the closing date, and that a portal password exists.
    expect(data.company.settings.closingDate).toBe('2026-01-31');
    expect(data.company.settings.fileLock).toEqual({ enabled: true });
    expect(data.tables.employees.find((e: { id: string }) => e.id === employeeId).hasPortalPassword).toBe(true);
    // The export used by any other caller is stripped as well.
    expect(JSON.stringify(await exportCompanyData(db, ctx.companyId))).not.toMatch(/\$2[aby]\$\d\d\$/);
  });

  it('restoring it creates a new company with its closing date and no passwords; the source keeps all of its own', async () => {
    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const res = await restoreCompanyBackup(db, buffer, { ownerId: userId, name: 'Secret Co Restored', dataDir: TEST_DIR });
    const restoredCtx = { db, companyId: res.companyId, userId };
    expect(await getClosingDateSettings(restoredCtx)).toMatchObject({ closingDate: '2026-01-31', hasPassword: false });
    const [emp] = await db.select().from(employees).where(eq(employees.companyId, res.companyId));
    expect(emp.firstName).toBe('Pat');
    expect(emp.portalPasswordHash).toBeNull();
    // The company it was made from is untouched, and the file is still locked by its password.
    expect(await getClosingDateSettings(ctx)).toMatchObject({ closingDate: '2026-01-31', hasPassword: true });
    const [srcEmp] = await db.select().from(employees).where(eq(employees.id, employeeId));
    expect(srcEmp.portalPasswordHash).toMatch(/^\$2b\$/);
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });

  it('an older backup that still carries the hashes restores them as before', async () => {
    const [src] = await db.select().from(companies).where(eq(companies.id, ctx.companyId));
    const hash = (src.settings as Record<string, string>).closingDatePasswordHash;
    const zip = new AdmZip((await createCompanyBackup(db, ctx.companyId)).buffer);
    const data = JSON.parse(zip.getEntry('company-data.json')!.getData().toString('utf8'));
    data.company.settings.closingDatePasswordHash = hash;
    for (const e of data.tables.employees) e.portalPasswordHash = '$2b$10$olderbackupolderbackupolderbackupolderbackupolderbac';
    zip.updateFile('company-data.json', Buffer.from(JSON.stringify(data), 'utf8'));
    const res = await restoreCompanyBackup(db, zip.toBuffer(), { ownerId: userId, name: 'Old Backup Restored', dataDir: TEST_DIR });
    expect(await getClosingDateSettings({ db, companyId: res.companyId, userId })).toMatchObject({ closingDate: '2026-01-31', hasPassword: true });
    const [emp] = await db.select().from(employees).where(eq(employees.companyId, res.companyId));
    expect(emp.portalPasswordHash).toMatch(/^\$2b\$10\$olderbackup/);
  });
});
