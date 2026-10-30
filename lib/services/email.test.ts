/**
 * Tests for lib/services/email.ts — the configuration guards.
 *
 * prefsperms: the mail server is set up in the company file (Preferences > Send Forms,
 * lib/services/emailSettings.ts); this computer's SMTP_* environment variables are the fallback.
 * We verify:
 *   1. isConfigured(ctx) is false with neither, true with the environment variables.
 *   2. sendMail() throws VALIDATION (pointing at Preferences > Send Forms) when not configured.
 *   3. emailInvoice() throws VALIDATION when not configured, before loading the invoice.
 *
 * No real mail is sent; nodemailer is never given valid credentials.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ServiceError, type ServiceContext } from './_base';
import { closeDb, getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createCompany } from './company';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-email-guards');

// Save and restore env around each test so we don't bleed state.
const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

function clearSmtpEnv() {
  for (const k of SMTP_KEYS) {
    delete process.env[k];
  }
}

function setSmtpEnv() {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'user@example.com';
  process.env.SMTP_PASS = 'secret';
  process.env.SMTP_FROM = '"Test" <noreply@example.com>';
}

let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'guards@test.local', name: 'Guard', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Guards Co', ownerId: u.id });
  ctx = { db, companyId: company.id, userId: u.id };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows */
  }
});

describe('email service — configuration guards', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of SMTP_KEYS) savedEnv[k] = process.env[k];
    clearSmtpEnv();
  });

  afterEach(() => {
    for (const k of SMTP_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  it('isConfigured() returns false with no mail server in the file and no SMTP env vars', async () => {
    const { isConfigured } = await import('./email');
    expect(await isConfigured(ctx)).toBe(false);
  });

  it('isConfigured() returns true when all SMTP env vars are set', async () => {
    setSmtpEnv();
    const { isConfigured } = await import('./email');
    expect(await isConfigured(ctx)).toBe(true);
  });

  it('sendMail throws VALIDATION ServiceError when not configured', async () => {
    const { sendMail } = await import('./email');
    await expect(sendMail({ to: 'test@example.com', subject: 'Hi', text: 'body' }, ctx)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ServiceError && err.code === 'VALIDATION' && err.message.includes('Preferences > Send Forms');
    });
  });

  it('emailInvoice throws VALIDATION ServiceError when not configured', async () => {
    const { emailInvoice } = await import('./email');
    // It short-circuits before loading the invoice (the id does not exist).
    await expect(emailInvoice(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toSatisfy((err: unknown) => {
      return err instanceof ServiceError && err.code === 'VALIDATION' && err.message.includes('Email is not set up');
    });
  });
});
