/**
 * Tests for per-company backup/restore (lib/services/backup.ts).
 *
 * Boots one PGlite instance holding TWO companies, exports company A to a
 * per-company .bka, restores it as a brand-new company in the same database,
 * and asserts:
 *   - the restore creates a NEW company with fresh (remapped) ids
 *   - row counts, balances, and FK relationships are preserved
 *   - company B (the other tenant) is completely untouched
 *   - the full-restore path refuses a per-company archive (and vice versa)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  companies,
  customers,
  journalEntries,
  journalEntryLines,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { postJournalEntry } from './posting';
import {
  createCompanyBackup,
  exportCompanyData,
  readCompanyBackup,
  restoreBackup,
  restoreCompanyBackup,
} from './backup';
import { createVendor } from './vendors';
import { vendors } from '@/lib/db/schema';
import AdmZip from 'adm-zip';
import { builtinRole, unionRoles } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-backup-company');

let db: DB;
let userId: string;
let companyAId: string;
let companyBId: string;
let ctxA: ServiceContext;
let backupBuffer: Buffer;

/** Snapshot of company B's row counts, taken before the restore. */
let companyBAccountIds: string[] = [];

describe('per-company backup/restore', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'backup-co@test.local', name: 'BackupCo', passwordHash: 'x' })
      .returning();
    userId = user.id;

    const companyA = await createCompany(db, { name: 'Alpha Co', ownerId: userId });
    const companyB = await createCompany(db, { name: 'Beta Co', ownerId: userId });
    companyAId = companyA.id;
    companyBId = companyB.id;
    ctxA = { db, companyId: companyAId, userId };

    // Seed company A: a parent/child account pair, a customer, a posted entry.
    const parent = await createAccount(ctxA, {
      code: '6900',
      name: 'Marketing',
      type: 'expense' as never,
      subtype: 'operating_expenses',
    });
    await createAccount(ctxA, {
      code: '6910',
      name: 'Online Ads',
      type: 'expense' as never,
      subtype: 'operating_expenses',
      parentId: parent.id,
    });
    await createCustomer(ctxA, { displayName: 'Acme Corp', email: 'acme@example.com' });

    const [checking] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.companyId, companyAId))
      .then((rows) => rows.filter((r) => r.id !== parent.id));
    // Use the seeded CoA: find 1000 + 4000 by code.
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyAId));
    const acct1000 = all.find((a) => a.code === '1000')!;
    const acct4000 = all.find((a) => a.code === '4000')!;
    expect(checking).toBeTruthy();

    await postJournalEntry(ctxA, {
      date: new Date('2026-01-15'),
      description: 'Sale',
      lines: [
        { accountId: acct1000.id, debit: '750.00' },
        { accountId: acct4000.id, credit: '750.00' },
      ],
    });

    companyBAccountIds = (
      await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, companyBId))
    ).map((r) => r.id);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('exportCompanyData captures all of company A and nothing else', async () => {
    const data = await exportCompanyData(db, companyAId);
    expect(data.company.name).toBe('Alpha Co');

    const acctRows = await db.select().from(accounts).where(eq(accounts.companyId, companyAId));
    expect(data.tables.accounts).toHaveLength(acctRows.length);
    expect(data.tables.customers).toHaveLength(1);
    expect(data.tables.journalEntries).toHaveLength(1);
    expect(data.tables.journalEntryLines).toHaveLength(2);

    // No company-B ids leak into the export.
    const exportedIds = new Set(data.tables.accounts.map((r) => r.id as string));
    for (const bId of companyBAccountIds) expect(exportedIds.has(bId)).toBe(false);
  });

  it('createCompanyBackup produces a valid company .bka archive', async () => {
    const { buffer, filename } = await createCompanyBackup(db, companyAId);
    expect(filename).toMatch(/^bookkeeper-company-alpha-co-.*\.bka$/);
    backupBuffer = buffer;

    const roundTrip = readCompanyBackup(buffer);
    expect(roundTrip.company.name).toBe('Alpha Co');
    expect(roundTrip.tables.journalEntries).toHaveLength(1);
  });

  it('the FULL restore path rejects a per-company archive', async () => {
    await expect(restoreBackup(backupBuffer, TEST_DIR)).rejects.toThrowError(ServiceError);
    await expect(restoreBackup(backupBuffer, TEST_DIR)).rejects.toThrow(/single-company backup/i);
  });

  it('readCompanyBackup rejects junk bytes', () => {
    expect(() => readCompanyBackup(Buffer.from('not a zip at all'))).toThrowError(ServiceError);
  });

  it('restoreCompanyBackup creates a NEW company with remapped ids', async () => {
    const result = await restoreCompanyBackup(db, backupBuffer, { ownerId: userId });

    expect(result.companyId).not.toBe(companyAId);
    // Name collides with the live "Alpha Co", so it is suffixed.
    expect(result.name).toMatch(/^Alpha Co \(Restored/);

    // Row counts preserved.
    const srcAccounts = await db.select().from(accounts).where(eq(accounts.companyId, companyAId));
    const newAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.companyId, result.companyId));
    expect(newAccounts).toHaveLength(srcAccounts.length);

    // Ids are fresh — none of the source ids appear in the new company.
    const srcIds = new Set(srcAccounts.map((a) => a.id));
    for (const a of newAccounts) expect(srcIds.has(a.id)).toBe(false);

    // Balances preserved (e.g. 1000 Checking carries the 750.00 debit).
    const srcChecking = srcAccounts.find((a) => a.code === '1000')!;
    const newChecking = newAccounts.find((a) => a.code === '1000')!;
    expect(newChecking.balance).toBe(srcChecking.balance);

    // Parent/child hierarchy survives the remap.
    const newParent = newAccounts.find((a) => a.code === '6900')!;
    const newChild = newAccounts.find((a) => a.code === '6910')!;
    expect(newChild.parentId).toBe(newParent.id);

    // Journal entry + lines restored, and lines reference NEW-company accounts.
    const newEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, result.companyId));
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].createdBy).toBe(userId);
    const newLines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, newEntries[0].id));
    expect(newLines).toHaveLength(2);
    const newAccountIds = new Set(newAccounts.map((a) => a.id));
    for (const line of newLines) expect(newAccountIds.has(line.accountId)).toBe(true);

    // Customer restored.
    const newCustomers = await db
      .select()
      .from(customers)
      .where(eq(customers.companyId, result.companyId));
    expect(newCustomers).toHaveLength(1);
    expect(newCustomers[0].displayName).toBe('Acme Corp');

    // The restore itself is recorded in the new company's audit trail.
    const restoreAudit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.companyId, result.companyId));
    expect(restoreAudit.some((a) => a.entityType === 'company_restore')).toBe(true);
  });

  it('other tenants are untouched by the restore', async () => {
    const bAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.companyId, companyBId));
    expect(bAccounts.map((r) => r.id).sort()).toEqual([...companyBAccountIds].sort());

    // And company A itself is byte-for-byte where we left it (1 entry, 1 customer).
    const aEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, companyAId));
    expect(aEntries).toHaveLength(1);
  });

  it('restoring the same backup twice never collides (always-fresh ids)', async () => {
    const again = await restoreCompanyBackup(db, backupBuffer, {
      ownerId: userId,
      name: 'Alpha Restored Twice',
    });
    expect(again.name).toBe('Alpha Restored Twice');
    const rows = await db
      .select()
      .from(companies)
      .where(eq(companies.id, again.companyId));
    expect(rows).toHaveLength(1);
  });

  it('an export for a role without the sensitive flags is masked, and restores without fake TINs', async () => {
    await createVendor(ctxA, { displayName: 'Sole Prop Sam', taxId: '123-45-6789' });
    const access = unionRoles([builtinRole('external_accountant')!]);
    expect(access.flags.sensitivePayroll).toBe(false);

    const { buffer } = await createCompanyBackup(db, companyAId, { access });
    const zip = new AdmZip(buffer);
    const text = zip.getEntries().map((e) => zip.readAsText(e)).join('\n');
    expect(text).toContain('Sole Prop Sam');
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('***-**-6789');
    expect(JSON.parse(zip.readAsText('bookkeeper-manifest.json')).redacted).toBe(true);

    const restored = await restoreCompanyBackup(db, buffer, { ownerId: userId, name: 'Redacted Copy' });
    const [v] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.companyId, restored.companyId));
    expect(v.displayName).toBe('Sole Prop Sam');
    expect(v.taxId).toBeNull(); // the masked placeholder is never stored as a TIN

    // Admin (both flags) gets the full value and an unredacted manifest.
    const admin = unionRoles([builtinRole('admin')!]);
    const full = new AdmZip((await createCompanyBackup(db, companyAId, { access: admin })).buffer);
    expect(full.getEntries().map((e) => full.readAsText(e)).join('\n')).toContain('123-45-6789');
    expect(JSON.parse(full.readAsText('bookkeeper-manifest.json')).redacted).toBeUndefined();
  });
});
