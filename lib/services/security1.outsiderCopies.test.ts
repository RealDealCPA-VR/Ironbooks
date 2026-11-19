/**
 * Security plan 1.3, second half — copies made for someone outside the company.
 *
 * The Accountant's Copy (.ibac) and the Period Copy (.bkp for an auditor or lender) left out only
 * the file's vault secret. They still carried every user's password hash, two-factor secret and
 * recovery codes, challenge question and answer hash, reset token and lockout counters, employees'
 * portal password hashes, sign-in sessions, phone upload tokens, earlier password hashes and the
 * sealed AI / mail blobs. The recipient restores the copy as a new company file and signs in with a
 * user name and password from the client's file, so only active users' password hashes (and the
 * file / closing date passwords, which open and govern the copy) travel now.
 *
 * The accountant's changes (.ibcx) come back without any of it: importing them never touches the
 * client's real credential columns. The owner's own portable file is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-outsider-copies');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
delete process.env.BKA_DEVICE_VAULT;
process.env.BKA_DATA_DIR = CLIENT_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  aiSettings,
  companyEmailSettings,
  employees,
  journalEntries,
  passwordHistory,
  receiptUploadTokens,
  userCompanies,
  userSessions,
  users,
} from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { fullAccess } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createEmployee } from './payroll';
import { createManualEntry } from './journal';
import { updateSettings } from './aiSettings';
import { saveEmailSetup } from './emailSettings';
import { createPortableCompanyFile } from './portableFile';
import { createPeriodCopy } from './periodCopy';
import { createAccountantCopy, importChangesFile } from './accountantCopy/client';
import { exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';

const OWNER_PW = 'Owner-Pass-123';
const SECRETS = {
  totp: 'JBSWY3DPEHPK3PXPTOTPSECRETOWNER',
  recovery: 'recovery-code-hash-0001',
  challenge: '$2b$10$challengeAnswerHashOwnerXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  question: 'Name of the street you grew up on',
  reset: 'reset-token-fingerprint-owner-0001',
  portal: '$2b$10$portalPasswordHashEmployeeXXXXXXXXXXXXXXXXXXXXXXXXXX',
  gone: '$2b$10$deactivatedUserHashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  history: '$2b$10$earlierPasswordHashOwnerXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  uploadToken: 'f'.repeat(64),
  apiKey: 'sk-ant-client-outsider-key-000111',
  mailPw: 'Client-Mailbox-Pass-9',
};

let db: DB;
let ctx: ServiceContext;
let ownerId: string;
let goneId: string;
let employeeId: string;
const acct: Record<string, string> = {};

function rows(zipBuffer: Buffer, table: string): Array<Record<string, unknown>> {
  const text = new AdmZip(zipBuffer).getEntry(`data/${table}.jsonl`)?.getData().toString('utf8') ?? '';
  return text ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** The client's credential columns as they are now (must never change through a copy). */
async function clientCredentials() {
  return {
    users: await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        totpSecret: users.totpSecret,
        totpEnabled: users.totpEnabled,
        totpRecoveryCodes: users.totpRecoveryCodes,
        challengeQuestion: users.challengeQuestion,
        challengeAnswerHash: users.challengeAnswerHash,
        resetToken: users.resetToken,
        challengeFailedAttempts: users.challengeFailedAttempts,
        challengeLockouts: users.challengeLockouts,
      })
      .from(users)
      .orderBy(users.email),
    portal: await db.select({ h: employees.portalPasswordHash }).from(employees),
    sessions: (await db.select().from(userSessions)).length,
    uploads: (await db.select().from(receiptUploadTokens)).length,
    history: await db.select({ h: passwordHistory.passwordHash }).from(passwordHistory),
    ai: (await db.select({ p: aiSettings.providers }).from(aiSettings))[0]?.p,
    mail: (await db.select({ p: companyEmailSettings.passwordEnc }).from(companyEmailSettings))[0]?.p,
  };
}

function expectNoClientSecret(buffer: Buffer, what: string) {
  for (const [name, s] of Object.entries(SECRETS)) {
    expect(buffer.includes(Buffer.from(s)), `${what} carries ${name}`).toBe(false);
  }
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(CLIENT_DIR);
  const [owner] = await db
    .insert(users)
    .values({
      email: 'owner-outsider@test.local',
      name: 'Client Owner',
      passwordHash: await hashPassword(OWNER_PW),
      totpEnabled: true,
      totpSecret: SECRETS.totp,
      totpRecoveryCodes: [{ hash: SECRETS.recovery, usedAt: null }],
      totpLastStep: 123,
      challengeQuestion: SECRETS.question,
      challengeAnswerHash: SECRETS.challenge,
      resetToken: SECRETS.reset,
      resetExpires: new Date(Date.now() + 3600_000),
      challengeFailedAttempts: 2,
      challengeLockouts: 1,
      challengeLockedUntil: new Date(Date.now() + 3600_000),
    })
    .returning();
  ownerId = owner.id;
  const company = await createCompany(db, { name: 'Outsider Client Co', ownerId });
  ctx = { db, companyId: company.id, userId: ownerId, access: fullAccess(), role: 'owner' };
  const [gone] = await db.insert(users).values({ email: 'gone-outsider@test.local', name: 'Former Clerk', passwordHash: SECRETS.gone }).returning();
  goneId = gone.id;
  await db.insert(userCompanies).values({ userId: goneId, companyId: company.id, role: 'viewer', isActive: false });
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  const emp = await createEmployee(ctx, { firstName: 'Pat', lastName: 'Lee', payType: 'hourly' as never, payRate: '20.00' });
  employeeId = emp.id;
  await db.update(employees).set({ portalPasswordHash: SECRETS.portal }).where(eq(employees.id, employeeId));
  await db.insert(userSessions).values({ userId: ownerId, companyId: company.id });
  await db.insert(receiptUploadTokens).values({ companyId: company.id, tokenHash: SECRETS.uploadToken, expiresAt: new Date(Date.now() + 3600_000) });
  await db.insert(passwordHistory).values({ userId: ownerId, passwordHash: SECRETS.history });
  await updateSettings(ctx, { providers: [{ kind: 'anthropic', label: 'Claude', model: '', enabled: true, apiKey: SECRETS.apiKey }] });
  await saveEmailSetup(ctx, { host: '127.0.0.1', port: 2525, security: 'starttls', username: 'billing@client.test', password: SECRETS.mailPw, fromEmail: 'billing@client.test' });
  await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'Closing-Pass-1' });
  await createManualEntry(ctx, {
    date: new Date('2026-02-15T12:00:00.000Z'),
    description: 'Client entry',
    lines: [
      { accountId: acct['6300'], debit: '100.00' },
      { accountId: acct['1000'], credit: '100.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await closeDb(CLIENT_DIR).catch(() => undefined);
  await closeDb(ACCT_DIR).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the Accountant's Copy carries only what signing in to it needs", () => {
  let transfer: Buffer;
  let before: Awaited<ReturnType<typeof clientCredentials>>;

  it('blanks two-factor, challenge, reset, lockout, portal and sealed-key material; drops sessions, upload tokens and old hashes', async () => {
    before = await clientCredentials();
    transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    const u = rows(transfer, 'users');
    const owner = u.find((r) => r.email === 'owner-outsider@test.local')!;
    // Kept: the active user's password hash (the accountant signs in with it).
    expect(owner.password_hash).toBe(before.users.find((x) => x.id === ownerId)!.passwordHash);
    expect(owner).toMatchObject({
      totp_secret: null,
      totp_enabled: 'false',
      totp_recovery_codes: null,
      totp_last_step: null,
      challenge_question: null,
      challenge_answer_hash: null,
      reset_token: null,
      reset_expires: null,
      challenge_failed_attempts: '0',
      challenge_lockouts: '0',
      challenge_locked_until: null,
    });
    // A deactivated user can't sign in to the copy: no hash at all.
    expect(u.find((r) => r.email === 'gone-outsider@test.local')!.password_hash).toBe('');
    expect(rows(transfer, 'employees').every((r) => r.portal_password_hash === null)).toBe(true);
    for (const t of ['user_sessions', 'receipt_upload_tokens', 'password_history', 'file_secrets', 'file_key_slots']) expect(rows(transfer, t), t).toEqual([]);
    const providers = rows(transfer, 'ai_settings')[0].providers as Array<Record<string, unknown>>;
    expect(providers.length).toBe(1);
    expect(providers[0]).toMatchObject({ kind: 'anthropic', label: 'Claude', apiKeyEnc: null });
    expect(rows(transfer, 'company_email_settings')[0]).toMatchObject({ host: '127.0.0.1', password_enc: null });
    // The closing date password stays (the accountant needs it to change a closed period).
    const settings = rows(transfer, 'companies')[0].settings as Record<string, unknown>;
    expect(typeof settings.closingDatePasswordHash).toBe('string');
    // Nothing of it anywhere in the file (audit trail, transaction log included).
    expectNoClientSecret(transfer, 'the transfer file');
    expect(transfer.includes(Buffer.from(String(before.ai && (before.ai as Array<{ apiKeyEnc: string }>)[0].apiKeyEnc)))).toBe(false);
    expect(transfer.includes(Buffer.from(String(before.mail)))).toBe(false);
  });

  it('opens on the accountant side (verified like any portable file), and the accountant signs in with the user name and password', async () => {
    const opened = await openAccountantCopyFile(transfer, ACCT_DIR);
    const adb = await getDb(opened.dataDir);
    const [owner] = await adb.select().from(users).where(eq(users.id, ownerId));
    expect(await verifyPassword(OWNER_PW, owner.passwordHash)).toBe(true);
    expect(owner).toMatchObject({ totpEnabled: false, totpSecret: null, challengeAnswerHash: null, resetToken: null });
    const [gone] = await adb.select().from(users).where(eq(users.id, goneId));
    expect(await verifyPassword('anything', gone.passwordHash)).toBe(false);
  });

  it("the accountant's changes import into the client's file without touching its real credentials", async () => {
    const adb = await getDb(ACCT_DIR);
    const actx: ServiceContext = { db: adb, companyId: ctx.companyId, userId: ownerId, access: fullAccess(), role: 'owner' };
    await createManualEntry(actx, {
      date: new Date('2026-03-20T12:00:00.000Z'),
      description: 'Accountant adjustment',
      isAdjusting: true,
      lines: [
        { accountId: acct['6300'], debit: '25.00' },
        { accountId: acct['1000'], credit: '25.00' },
      ],
    });
    const changes = (await exportChangesFile(actx, { note: 'One adjustment.' })).buffer;
    expectNoClientSecret(changes, 'the changes file');
    await importChangesFile(ctx, changes);
    const imported = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, 'Accountant adjustment')));
    expect(imported).toHaveLength(1);
    expect(await clientCredentials()).toEqual(before);
  });
});

describe('the Period Copy too', () => {
  it('carries the same: only active users\' password hashes', async () => {
    const copy = (await createPeriodCopy(ctx, { from: '2026-02-01', to: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    const owner = rows(copy, 'users').find((r) => r.email === 'owner-outsider@test.local')!;
    expect(owner).toMatchObject({ totp_secret: null, totp_enabled: 'false', challenge_answer_hash: null, reset_token: null });
    expect(await verifyPassword(OWNER_PW, owner.password_hash as string)).toBe(true);
    for (const t of ['user_sessions', 'receipt_upload_tokens', 'password_history', 'file_secrets']) expect(rows(copy, t), t).toEqual([]);
    expectNoClientSecret(copy, 'the Period Copy');
  });
});

describe("the owner's own portable file is unchanged", () => {
  it('still carries everything (it restores the file itself)', async () => {
    const own = (await createPortableCompanyFile(ctx, { dataDir: CLIENT_DIR })).buffer;
    const owner = rows(own, 'users').find((r) => r.email === 'owner-outsider@test.local')!;
    expect(owner).toMatchObject({ totp_secret: SECRETS.totp, totp_enabled: 'true', challenge_answer_hash: SECRETS.challenge });
    expect(rows(own, 'user_sessions').length).toBeGreaterThan(0);
    expect(rows(own, 'password_history')).toHaveLength(1);
    expect(rows(own, 'file_secrets')).toHaveLength(1);
  });
});
