/**
 * Review round 5 (security): the cloud-AI redactor knows every name list.
 *
 * buildCompanyRedactor only read customers, vendors and employees (and not the employee phone
 * added in wave 2), so a cloud model saw Other Names (QuickBooks' list for owners and partners —
 * "Transfer to Jordan Pemberton" for an owner's draw), leads, sales reps, customer ship-to
 * addresses, the number the vendor knows us by and the company's own bank account numbers in
 * the clear whenever no pattern happened to match them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-redactor');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-redactor-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, customers, employees, leads, otherNames, salesReps, users, vendors } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { createCompany } from './company';
import { buildCompanyRedactor } from './aiSettings';

let db: DB;
let companyId: string;
let userId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'red-owner@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = u.id;
  companyId = (await createCompany(db, { name: 'Redact Co', ownerId: userId })).id;
  await db.insert(otherNames).values({
    companyId,
    name: 'Jordan Pemberton',
    email: 'jordan.p@owners.example',
    phone: '555-0177',
    address: { line1: '42 Wallaby Way' },
    accountNumber: 'OWN-731902',
  });
  await db.insert(employees).values({ companyId, firstName: 'Rae', lastName: 'Kowalczyk', phone: '555-0102' });
  await db.insert(vendors).values({ companyId, displayName: 'Paper Supply', accountNumber: 'CUST-778899' });
  await db.insert(customers).values({
    companyId,
    displayName: 'Harbor Cafe',
    shipToAddresses: [{ name: 'Harbor Cafe Pier Kitchen', line1: '9 Quayside Promenade', isDefault: true }],
  });
  await db.insert(leads).values({
    companyId,
    name: 'Morgan Ellery',
    email: 'morgan@prospect.example',
    contacts: [{ name: 'Priya Venkatesan', email: 'priya@prospect.example', phone: '555-0144' }],
  });
  await db.insert(salesReps).values({ companyId, name: 'Dana Whitlock', email: 'dana@sales.example' });
  const [checking] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.subtype, 'checking')));
  await db.insert(bankAccounts).values({ companyId, accountId: checking.id, bankName: 'First Bank', accountNumber: '4455667' });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('review5: buildCompanyRedactor covers every name list', () => {
  it('redacts Other Names, leads, sales reps, ship-to addresses, employee phones and account numbers', async () => {
    const red = await buildCompanyRedactor({ db, companyId, userId, access: fullAccess(), role: 'owner' });
    const text = [
      'Owner draw: transfer to Jordan Pemberton (jordan.p@owners.example, 555-0177), 42 Wallaby Way, ref OWN-731902.',
      'Call Rae Kowalczyk at 555-0102.',
      'Paper Supply knows us as CUST-778899.',
      'Ship to Harbor Cafe Pier Kitchen, 9 Quayside Promenade.',
      'Lead Morgan Ellery (morgan@prospect.example); contact Priya Venkatesan 555-0144 priya@prospect.example.',
      'Commission for Dana Whitlock dana@sales.example.',
      'Deposit to account 4455667 for 1,250.00 on 2026-03-04.',
    ].join('\n');
    const out = red.redact(text);
    for (const secret of [
      'Jordan Pemberton', 'jordan.p@owners.example', '555-0177', 'Wallaby', '731902',
      'Kowalczyk', '555-0102',
      '778899',
      'Pier Kitchen', 'Quayside',
      'Morgan Ellery', 'morgan@prospect.example', 'Priya Venkatesan', '555-0144', 'priya@prospect.example',
      'Dana Whitlock', 'dana@sales.example',
      '4455667',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    // Amounts and dates survive the round trip.
    expect(out).toContain('1,250.00');
    expect(out).toContain('2026-03-04');
    expect(red.restore(out)).toBe(text);
  });
});

describe('review5: assistant tools need the report area of their data', () => {
  it('the Banking role (Reports — Financial only) cannot read A/R or A/P aging through the assistant', async () => {
    const { runTool, ask } = await import('./aiAssistant');
    const { builtinRole, unionRoles } = await import('@/lib/permissions/model');
    const banking = { db, companyId, userId, access: unionRoles([builtinRole('banking')!]), role: 'accountant' as const };
    await expect(runTool(banking, 'ar_aging', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runTool(banking, 'ap_aging', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runTool(banking, 'profit_and_loss', {})).resolves.toBeTruthy();
    // No model configured: the offline answer runs the same tools.
    await expect(ask(banking, [], 'Who owes us money?')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const owner = { db, companyId, userId, access: fullAccess(), role: 'owner' as const };
    expect((await ask(owner, [], 'Who owes us money?')).answer).toMatch(/Customers owe/);
  });
});
