/**
 * Tests for lib/services/email.ts
 *
 * Strategy: no DB seeding needed for the guard tests.
 * We only verify:
 *   1. isConfigured() returns false when SMTP env vars are absent.
 *   2. sendMail() throws VALIDATION when isConfigured() is false.
 *   3. emailInvoice() throws VALIDATION when isConfigured() is false.
 *
 * No real mail is sent; nodemailer is never given valid credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceError } from './_base';

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

describe('email service — configuration guards', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of SMTP_KEYS) savedEnv[k] = process.env[k];
    clearSmtpEnv();
    // Force module re-evaluation isn't needed here because isConfigured()
    // reads process.env at call time (no module-level caching).
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

  it('isConfigured() returns false when SMTP env vars are absent', async () => {
    const { isConfigured } = await import('./email');
    expect(isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when all SMTP env vars are set', async () => {
    setSmtpEnv();
    const { isConfigured } = await import('./email');
    expect(isConfigured()).toBe(true);
  });

  it('sendMail throws VALIDATION ServiceError when not configured', async () => {
    const { sendMail } = await import('./email');
    await expect(
      sendMail({ to: 'test@example.com', subject: 'Hi', text: 'body' }, { db: {} as never, companyId: 'c', userId: null }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ServiceError &&
        err.code === 'VALIDATION' &&
        err.message.includes('Email not configured')
      );
    });
  });

  it('emailInvoice throws VALIDATION ServiceError when not configured', async () => {
    const { emailInvoice } = await import('./email');
    // Provide a minimal fake ctx — it should short-circuit before touching the DB.
    const fakeCtx = {
      db: {} as never,
      companyId: 'test-company-id',
      userId: null,
    };
    await expect(emailInvoice(fakeCtx, 'any-invoice-id')).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof ServiceError &&
          err.code === 'VALIDATION' &&
          err.message.includes('Email not configured')
        );
      },
    );
  });
});
