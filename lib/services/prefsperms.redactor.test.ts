/**
 * prefsperms (review 5 leftovers, approved P2): buildCompanyRedactor skipped the vendor's
 * "Print on check as" name (for a sole proprietor usually a PERSONAL name that differs from the
 * display name — and exactly what bank-feed check / ACH descriptions carry: "CHECK 1043 ROBERT J
 * SMITH" for vendor "Smith Plumbing"), customer resale numbers and job names. They are entities
 * now, so they never reach a cloud model unredacted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-redactor');
process.env.BKA_DATA_DIR = TEST_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { customers, jobs, users, vendors } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { createCompany } from './company';
import { buildCompanyRedactor } from './aiSettings';

let db: DB;
let companyId: string;
let userId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'red2-owner@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = u.id;
  companyId = (await createCompany(db, { name: 'Redact Two Co', ownerId: userId })).id;
  await db.insert(vendors).values({ companyId, displayName: 'Smith Plumbing', printOnCheckAs: 'Robert J Smith' });
  const [c] = await db.insert(customers).values({ companyId, displayName: 'Acme Stores', resaleNumber: 'SR-99887766' }).returning();
  await db.insert(jobs).values({ companyId, customerId: c.id, name: 'Kowalski Kitchen Remodel' });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('the AI redactor knows print-on-check names, resale numbers and job names', () => {
  it('redacts them (any letter case) and restores the text exactly', async () => {
    const red = await buildCompanyRedactor({ db, companyId, userId, access: fullAccess(), role: 'owner' });
    const text = [
      'CHECK 1043 ROBERT J SMITH 450.00',
      'ACH Robert J Smith plumbing invoice',
      'Resale certificate SR-99887766 on file',
      'Materials for Kowalski Kitchen Remodel',
    ].join('\n');
    const out = red.redact(text);
    for (const secret of ['ROBERT J SMITH', 'Robert J Smith', 'SR-99887766', '99887766', 'Kowalski']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('450.00');
    expect(red.restore(out)).toBe(text);
  });
});
