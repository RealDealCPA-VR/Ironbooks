/**
 * Restoring a per-company backup ("Back up this company") into an open company file that this
 * computer has approved for internet services (lib/net/fileTrust.ts) brought the backup's own
 * network policy and its emailing report schedules in with it, past that approval. Now the export
 * carries a proof of the computer that made it (company-data.json `madeOn`), and a restore:
 *  - of a backup made on this computer, with these very settings: restores them as they are;
 *  - of any other (another computer's, none, a proof moved onto other settings, or a proof but no
 *    device secret here): narrows the network policy to the default and pauses the schedules that
 *    email, and says so in one sentence;
 *  - with no device secret and no proof (tests, dev): exactly as before.
 * Two "computers" are simulated by switching BKA_DEVICE_VAULT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, reportSchedules, users } from '@/lib/db/schema';
import { DEVICE_VAULT_ENV, deviceKeyId } from '@/lib/ai/keyVault';
import { BACKUP_OUTSIDE_SETTINGS_NOTICE, companyBackupMadeHere, policyNoWiderThanDefault } from '@/lib/net/fileTrust';
import { DEFAULT_NETWORK_POLICY, normalizePolicy } from '@/lib/net/policy';
import { createCompany } from './company';
import { createCompanyBackup, readCompanyBackup, restoreCompanyBackup } from './backup';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security4-company-backup-origin');
const PC_A = 'a1'.repeat(32);
const PC_B = 'b2'.repeat(32);

/** The settings of a company that reaches out: cloud AI, email and vendor lookup on, update checks off. */
const OPEN_POLICY = {
  mode: 'allow-cloud',
  cloudOptIn: { ai: true, email: true, 'vendor-lookup': true, updates: false },
  vendorLookupUrl: 'https://searx.example.com',
  rev: 2,
};

let db: DB;
let ownerId: string;
let openCompanyId: string;
let quietCompanyId: string;
let restores = 0;

function onComputer<T>(secret: string | null, fn: () => Promise<T>): Promise<T> {
  const before = process.env[DEVICE_VAULT_ENV];
  if (secret) process.env[DEVICE_VAULT_ENV] = secret;
  else delete process.env[DEVICE_VAULT_ENV];
  return fn().finally(() => {
    if (before === undefined) delete process.env[DEVICE_VAULT_ENV];
    else process.env[DEVICE_VAULT_ENV] = before;
  });
}

async function addSchedule(companyId: string, name: string, emailTo: string | null) {
  await db.insert(reportSchedules).values({ companyId, name, frequency: 'monthly', nextRunAt: new Date('2026-12-01T00:00:00Z'), emailTo, createdBy: ownerId });
}

async function backupOf(companyId: string, secret: string | null): Promise<Buffer> {
  return onComputer(secret, async () => (await createCompanyBackup(db, companyId)).buffer);
}

/** Restore on a "computer", then what the restored company has. */
async function restoreOn(secret: string | null, buffer: Buffer) {
  const result = await onComputer(secret, () => restoreCompanyBackup(db, buffer, { ownerId, name: `Restored ${++restores}` }));
  const [company] = await db.select().from(companies).where(eq(companies.id, result.companyId));
  const schedules = await db.select().from(reportSchedules).where(eq(reportSchedules.companyId, result.companyId));
  const byName = Object.fromEntries(schedules.map((s) => [s.name, s]));
  return { result, policy: (company.settings as Record<string, unknown> | null)?.networkPolicy, byName };
}

/** The company data inside a backup, changed by `edit`, packed again (a hand-edited .bka). */
function edited(buffer: Buffer, edit: (data: Record<string, any>) => void): Buffer {
  const zip = new AdmZip(buffer);
  const data = JSON.parse(zip.getEntry('company-data.json')!.getData().toString('utf8'));
  edit(data);
  zip.updateFile('company-data.json', Buffer.from(JSON.stringify(data), 'utf8'));
  return zip.toBuffer();
}

function expectAsMade(r: Awaited<ReturnType<typeof restoreOn>>) {
  expect(r.result.notices).toBeUndefined();
  expect(r.policy).toEqual(OPEN_POLICY);
  expect(r.byName['Monthly to the boss']).toMatchObject({ isActive: true, emailTo: 'boss@example.com' });
  expect(r.byName['Files only']).toMatchObject({ isActive: true, emailTo: null });
}

function expectHeld(r: Awaited<ReturnType<typeof restoreOn>>) {
  expect(r.result.notices).toEqual([BACKUP_OUTSIDE_SETTINGS_NOTICE]);
  // No wider than the default: no cloud, no vendor lookup; the update-check choice (off) is kept.
  expect(r.policy).toEqual({ mode: 'tailnet-only', cloudOptIn: { ai: false, email: false, 'vendor-lookup': false, updates: false }, vendorLookupUrl: null, rev: 2 });
  // The emailing schedule is paused, recipients kept so it can be turned back on; files-only runs.
  expect(r.byName['Monthly to the boss']).toMatchObject({ isActive: false, emailTo: 'boss@example.com' });
  expect(r.byName['Files only']).toMatchObject({ isActive: true, emailTo: null });
}

beforeAll(async () => {
  delete process.env[DEVICE_VAULT_ENV];
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  process.env.BKA_DATA_DIR = TEST_DIR;
  const [user] = await db.insert(users).values({ email: 'origin@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  ownerId = user.id;
  const open = await createCompany(db, { name: 'Open Co', ownerId });
  openCompanyId = open.id;
  const [row] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, openCompanyId));
  await db.update(companies).set({ settings: { ...((row.settings as object) ?? {}), networkPolicy: OPEN_POLICY } as never }).where(eq(companies.id, openCompanyId));
  await addSchedule(openCompanyId, 'Monthly to the boss', 'boss@example.com');
  await addSchedule(openCompanyId, 'Files only', null);
  const quiet = await createCompany(db, { name: 'Quiet Co', ownerId });
  quietCompanyId = quiet.id;
  await addSchedule(quietCompanyId, 'Files only', null);
}, 180_000);

afterAll(async () => {
  delete process.env[DEVICE_VAULT_ENV];
  delete process.env.BKA_DATA_DIR;
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

describe('per-company backup restore: outside settings come back only on the computer that made it', () => {
  it('no device secret at either end (tests, dev): exactly as before, and the backup carries no proof', async () => {
    const buffer = await backupOf(openCompanyId, null);
    expect(readCompanyBackup(buffer).madeOn).toBeUndefined();
    expectAsMade(await restoreOn(null, buffer));
  });

  it('made on this computer: restored as it is', async () => {
    const buffer = await backupOf(openCompanyId, PC_A);
    const data = readCompanyBackup(buffer);
    expect(data.madeOn).toMatchObject({ v: 1, keyId: deviceKeyId(PC_A) });
    expect(JSON.stringify(data.madeOn)).not.toContain(PC_A); // the secret never travels
    expectAsMade(await restoreOn(PC_A, buffer));
  });

  it('made on another computer: policy narrowed, emailing schedules paused, and the restore says so', async () => {
    const r = await restoreOn(PC_B, await backupOf(openCompanyId, PC_A));
    expectHeld(r);
    expect(normalizePolicy(r.policy).mode).toBe(DEFAULT_NETWORK_POLICY.mode);
  });

  it('no proof at all (a crafted backup, or one made before this version) on a computer with a device secret: held', async () => {
    expectHeld(await restoreOn(PC_A, await backupOf(openCompanyId, null)));
  });

  it('a proof, but no device secret where it is restored: held', async () => {
    expectHeld(await restoreOn(null, await backupOf(openCompanyId, PC_A)));
  });

  it("this computer's proof moved onto other settings: held", async () => {
    const genuine = await backupOf(openCompanyId, PC_A);
    const sendElsewhere = edited(genuine, (d) => {
      d.tables.reportSchedules.find((s: { name: string }) => s.name === 'Monthly to the boss').emailTo = 'boss@example.com, thief@evil.example';
    });
    const r = await restoreOn(PC_A, sendElsewhere);
    expect(r.result.notices).toEqual([BACKUP_OUTSIDE_SETTINGS_NOTICE]);
    expect(r.byName['Monthly to the boss']).toMatchObject({ isActive: false });
    // A changed network policy (another lookup address) or a made-up proof is caught the same way.
    const otherPolicy = edited(genuine, (d) => {
      d.company.settings.networkPolicy.vendorLookupUrl = 'https://other.example.com';
    });
    const forged = edited(genuine, (d) => {
      d.madeOn.mac = 'f'.repeat(64);
    });
    expect(companyBackupMadeHere(readCompanyBackup(genuine))).toBe(false); // a proof, but no secret here now
    await onComputer(PC_A, async () => {
      expect(companyBackupMadeHere(readCompanyBackup(genuine))).toBe(true);
      expect(companyBackupMadeHere(readCompanyBackup(otherPolicy))).toBe(false);
      expect(companyBackupMadeHere(readCompanyBackup(forged))).toBe(false);
    });
    await onComputer(PC_B, async () => {
      expect(companyBackupMadeHere(readCompanyBackup(genuine))).toBe(false);
    });
    expect(companyBackupMadeHere(readCompanyBackup(await backupOf(openCompanyId, null)))).toBeNull(); // feature off
  });

  it('a company with nothing that reaches out: nothing changed, nothing said', async () => {
    const r = await restoreOn(PC_A, await backupOf(quietCompanyId, null));
    expect(r.result.notices).toBeUndefined();
    expect(r.byName['Files only']).toMatchObject({ isActive: true });
  });
});

describe('policyNoWiderThanDefault', () => {
  it('never widens: Offline stays Offline, every cloud opt-in off, no lookup address', () => {
    expect(policyNoWiderThanDefault({ mode: 'offline', cloudOptIn: { ai: true }, vendorLookupUrl: 'http://10.0.0.5' })).toEqual({
      mode: 'offline',
      cloudOptIn: { ai: false, email: false, 'vendor-lookup': false },
      vendorLookupUrl: null,
    });
    const narrowed = normalizePolicy(policyNoWiderThanDefault(OPEN_POLICY));
    expect(narrowed).toEqual({ ...DEFAULT_NETWORK_POLICY, cloudOptIn: { ...DEFAULT_NETWORK_POLICY.cloudOptIn, updates: false } });
    expect(normalizePolicy(policyNoWiderThanDefault(undefined))).toEqual(normalizePolicy(DEFAULT_NETWORK_POLICY));
  });
});
