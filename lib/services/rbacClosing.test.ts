/**
 * rbac-closing package tests:
 *  - RBAC enforcement: viewer contexts are read-only app-wide (central choke-point in
 *    _base.ts writeAudit/inTransaction + assertWrite), member listing/role changes.
 *  - Closing date + password: assertPeriodOpen blocks postings/voids dated on/before
 *    companies.settings.closingDate unless ctx.closingDateOverride is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, userCompanies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { assertWrite, listMembers, setMemberRole, getRole } from './rbac';
import {
  getClosingDateSettings,
  setClosingDate,
  verifyClosingDatePassword,
} from './company';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { listPeriods, closePeriod } from './fiscalPeriods';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-rbac-closing');
let db: DB;
let companyId: string;
let ownerCtx: ServiceContext;
let accountantCtx: ServiceContext;
let viewerCtx: ServiceContext;
let member2Id: string;
const acct: Record<string, string> = {};

function entry(date: string) {
  return {
    date: new Date(date),
    description: `Test entry ${date}`,
    lines: [
      { accountId: acct['1000'], debit: '100.00' },
      { accountId: acct['4000'], credit: '100.00' },
    ],
  };
}

describe('RBAC enforcement + closing date', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@rc.local', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [acc] = await db
      .insert(users)
      .values({ email: 'acc@rc.local', name: 'Accountant', passwordHash: 'x' })
      .returning();
    const [viewer] = await db
      .insert(users)
      .values({ email: 'viewer@rc.local', name: 'Viewer', passwordHash: 'x' })
      .returning();
    const [member2] = await db
      .insert(users)
      .values({ email: 'member2@rc.local', name: 'Member Two', passwordHash: 'x' })
      .returning();
    member2Id = member2.id;
    const [co] = await db
      .insert(companies)
      .values({ name: 'RBAC Closing Co', ownerId: owner.id })
      .returning();
    companyId = co.id;
    await db.insert(userCompanies).values([
      { userId: owner.id, companyId, role: 'owner' },
      { userId: acc.id, companyId, role: 'accountant' },
      { userId: viewer.id, companyId, role: 'viewer' },
      { userId: member2.id, companyId, role: 'viewer' },
    ]);

    // Contexts shaped exactly like getServerContext produces (role pre-loaded).
    ownerCtx = { db, companyId, userId: owner.id, role: 'owner' };
    accountantCtx = { db, companyId, userId: acc.id, role: 'accountant' };
    viewerCtx = { db, companyId, userId: viewer.id, role: 'viewer' };

    acct['1000'] = (
      await createAccount(ownerCtx, { code: '1000', name: 'Cash', type: 'asset', subtype: 'checking' })
    ).id;
    acct['4000'] = (
      await createAccount(ownerCtx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' })
    ).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('assertWrite', () => {
    it('passes for writer roles and trusted (role-less) contexts', () => {
      expect(() => assertWrite(ownerCtx)).not.toThrow();
      expect(() => assertWrite(accountantCtx)).not.toThrow();
      expect(() => assertWrite({ db, companyId, userId: null })).not.toThrow();
    });

    it('throws FORBIDDEN for viewers', () => {
      expect(() => assertWrite(viewerCtx)).toThrow(/view-only/);
      try {
        assertWrite(viewerCtx);
      } catch (e) {
        expect(e).toMatchObject({ code: 'FORBIDDEN' });
      }
    });
  });

  describe('viewer is read-only app-wide', () => {
    it('lets a viewer read (reports/lists)', async () => {
      await expect(listPeriods(viewerCtx)).resolves.toEqual([]);
      const members = await listMembers(viewerCtx);
      expect(members.length).toBe(4);
    });

    it('blocks a viewer from posting a journal entry (central choke-point)', async () => {
      await expect(postJournalEntry(viewerCtx, entry('2026-01-15'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('blocks a viewer from closing a fiscal period', async () => {
      await expect(
        closePeriod(viewerCtx, {
          periodStart: new Date('2025-01-01'),
          periodEnd: new Date('2025-01-31'),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await listPeriods(ownerCtx)).length).toBe(0); // nothing slipped through
    });

    it('allows an accountant to post', async () => {
      await expect(postJournalEntry(accountantCtx, entry('2026-01-16'))).resolves.toBeTruthy();
    });
  });

  describe('member management', () => {
    it('lists members with the owner flagged', async () => {
      const members = await listMembers(ownerCtx);
      const owner = members.find((m) => m.email === 'owner@rc.local');
      expect(owner).toMatchObject({ role: 'owner', isOwner: true });
      expect(members.find((m) => m.email === 'member2@rc.local')).toMatchObject({
        role: 'viewer',
        isOwner: false,
      });
    });

    it('lets an admin/owner change a member role', async () => {
      const updated = await setMemberRole(ownerCtx, member2Id, 'accountant');
      expect(updated.role).toBe('accountant');
      expect(await getRole({ db, companyId, userId: member2Id })).toBe('accountant');
    });

    it('blocks viewers and accountants from changing roles', async () => {
      await expect(setMemberRole(viewerCtx, member2Id, 'admin')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(setMemberRole(accountantCtx, member2Id, 'admin')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it("never changes the company owner's role", async () => {
      const members = await listMembers(ownerCtx);
      const owner = members.find((m) => m.isOwner)!;
      await expect(setMemberRole(ownerCtx, owner.userId, 'viewer')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('closing date + password', () => {
    it('sets a closing date with a password (roles with Closing Date: modify only)', async () => {
      await expect(
        setClosingDate(viewerCtx, { closingDate: '2026-03-31', password: 'lock123' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const result = await setClosingDate(ownerCtx, {
        closingDate: '2026-03-31',
        password: 'lock123',
      });
      expect(result).toEqual({ closingDate: '2026-03-31', hasPassword: true });
      expect(await getClosingDateSettings(ownerCtx)).toEqual({
        closingDate: '2026-03-31',
        hasPassword: true,
      });
    });

    it('rejects a malformed closing date', async () => {
      await expect(
        setClosingDate(ownerCtx, { closingDate: '03/31/2026' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('blocks posting dated on/before the closing date', async () => {
      await expect(postJournalEntry(ownerCtx, entry('2026-02-15'))).rejects.toMatchObject({
        code: 'PERIOD_CLOSED',
      });
      await expect(postJournalEntry(ownerCtx, entry('2026-03-31'))).rejects.toMatchObject({
        code: 'PERIOD_CLOSED',
      });
    });

    it('allows posting after the closing date', async () => {
      await expect(postJournalEntry(ownerCtx, entry('2026-04-01'))).resolves.toBeTruthy();
    });

    it('blocks voiding an entry dated before the closing date', async () => {
      // The accountant's 2026-01-16 entry predates the 2026-03-31 closing date.
      const posted = await postJournalEntry(
        { ...ownerCtx, closingDateOverride: true },
        entry('2026-02-20'),
      );
      await expect(voidJournalEntry(ownerCtx, posted.id)).rejects.toMatchObject({
        code: 'PERIOD_CLOSED',
      });
    });

    it('allows posting before the closing date with the override (verified password)', async () => {
      const overrideCtx: ServiceContext = { ...ownerCtx, closingDateOverride: true };
      await expect(postJournalEntry(overrideCtx, entry('2026-02-16'))).resolves.toBeTruthy();
    });

    it('verifies the closing-date password against the stored hash', async () => {
      expect(await verifyClosingDatePassword(db, companyId, 'lock123')).toBe(true);
      expect(await verifyClosingDatePassword(db, companyId, 'wrong')).toBe(false);
    });

    it('a viewer with the password override still cannot write', async () => {
      const sneaky: ServiceContext = { ...viewerCtx, closingDateOverride: true };
      await expect(postJournalEntry(sneaky, entry('2026-02-17'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('clears the closing date (and password) and reopens the books', async () => {
      const cleared = await setClosingDate(ownerCtx, { closingDate: null });
      expect(cleared).toEqual({ closingDate: null, hasPassword: false });
      await expect(postJournalEntry(ownerCtx, entry('2026-02-18'))).resolves.toBeTruthy();
      // With no password configured, an explicit override attempt is accepted (warn-and-continue).
      expect(await verifyClosingDatePassword(db, companyId, 'anything')).toBe(true);
    });
  });
});
