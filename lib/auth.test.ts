import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  companyFileId,
  createSessionToken,
  verifySessionToken,
  createUnlockToken,
  verifyUnlockToken,
  hashPassword,
  verifyPassword,
} from './auth';

beforeAll(() => {
  process.env.BKA_AUTH_SECRET = 'test-secret-fixed';
});

describe('auth sessions', () => {
  it('round-trips a valid session token', () => {
    const token = createSessionToken('user-123');
    expect(verifySessionToken(token)).toEqual({ userId: 'user-123' });
  });

  it('rejects a tampered token', () => {
    const token = createSessionToken('user-123');
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySessionToken(tampered)).toBeNull();
  });

  it('rejects garbage / empty', () => {
    expect(verifySessionToken('')).toBeNull();
    expect(verifySessionToken('not-a-token')).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
  });
});

describe('session tokens are bound to the company file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-auth-'));
  const dirA = path.join(root, 'Company A.bookkeeper');
  const dirB = path.join(root, 'Company B.bookkeeper');

  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gives each company file its own persistent id', () => {
    vi.stubEnv('BKA_DATA_DIR', dirA);
    const a = companyFileId();
    expect(fs.readFileSync(path.join(dirA, '.file-id'), 'utf8')).toBe(a);
    vi.stubEnv('BKA_DATA_DIR', dirB);
    expect(companyFileId()).not.toBe(a);
  });

  it('rejects a session minted for company A when company B is open (same secret)', () => {
    vi.stubEnv('BKA_DATA_DIR', dirA);
    const token = createSessionToken('user-1');
    expect(verifySessionToken(token)).toEqual({ userId: 'user-1' });
    vi.stubEnv('BKA_DATA_DIR', dirB);
    expect(verifySessionToken(token)).toBeNull();
    vi.stubEnv('BKA_DATA_DIR', dirA);
    expect(verifySessionToken(token)).toEqual({ userId: 'user-1' });
  });

  it('binds portal tokens too', () => {
    vi.stubEnv('BKA_DATA_DIR', dirA);
    const token = createSessionToken('emp-1', 'portal');
    vi.stubEnv('BKA_DATA_DIR', dirB);
    expect(verifySessionToken(token, 'portal')).toBeNull();
  });

  it('rejects legacy (unbound) tokens even with a valid signature', () => {
    vi.stubEnv('BKA_DATA_DIR', dirA);
    const body = Buffer.from(
      JSON.stringify({ userId: 'user-1', kind: 'user', exp: Date.now() + 60_000 }),
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', 'test-secret-fixed').update(body).digest('base64url');
    expect(verifySessionToken(`${body}.${sig}`)).toBeNull();
  });
});

describe('unlock tokens', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('round-trips a valid unlock token', () => {
    vi.stubEnv('BKA_INTERNAL_TOKEN', 'launch-a');
    expect(verifyUnlockToken(createUnlockToken())).toBe(true);
  });

  it('rejects a token minted under a different launch nonce (relaunch invalidation)', () => {
    vi.stubEnv('BKA_INTERNAL_TOKEN', 'launch-a');
    const token = createUnlockToken();
    vi.stubEnv('BKA_INTERNAL_TOKEN', 'launch-b');
    expect(verifyUnlockToken(token)).toBe(false);
  });

  it('rejects a token minted for a different company data directory', () => {
    vi.stubEnv('BKA_DATA_DIR', '/tmp/company-a');
    const token = createUnlockToken();
    vi.stubEnv('BKA_DATA_DIR', '/tmp/company-b');
    expect(verifyUnlockToken(token)).toBe(false);
  });

  it('expires after 12 hours', () => {
    vi.useFakeTimers();
    const token = createUnlockToken();
    expect(verifyUnlockToken(token)).toBe(true);
    vi.setSystemTime(Date.now() + 1000 * 60 * 60 * 12 + 1000);
    expect(verifyUnlockToken(token)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = createUnlockToken();
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifyUnlockToken(tampered)).toBe(false);
  });

  it('rejects garbage / empty', () => {
    expect(verifyUnlockToken('')).toBe(false);
    expect(verifyUnlockToken('not-a-token')).toBe(false);
    expect(verifyUnlockToken(undefined)).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('hunter2!');
    expect(hash).not.toBe('hunter2!');
    expect(await verifyPassword('hunter2!', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('never accepts the seed/demo passwordHash', async () => {
    expect(await verifyPassword('dev', 'dev')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});
