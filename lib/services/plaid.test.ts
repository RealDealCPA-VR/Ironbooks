/**
 * Unit tests for the Plaid service.
 *
 * These tests do NOT call the live Plaid API. They verify:
 *   - isConfigured() returns false when env vars are absent.
 *   - createLinkToken() throws a VALIDATION ServiceError when not configured.
 *   - exchangePublicToken() throws a VALIDATION ServiceError when not configured.
 *
 * For the network-path code (plaidPost, syncTransactions) a simple fetch mock
 * is used so nothing hits the wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceError } from './_base';
import { isConfigured, createLinkToken, exchangePublicToken } from './plaid';
import type { ServiceContext } from './_base';

// The network policy is enforced on every Plaid call (lib/net/guard.ts). These tests stub the
// company's policy so they never touch a database: tests below opt in to cloud bank feeds
// explicitly, and the 'blocked by default' test flips it back.
const policyState = vi.hoisted(() => ({ optIn: true }));
vi.mock('./networkPolicy', () => ({
  getNetworkPolicy: async () => ({
    mode: policyState.optIn ? 'allow-cloud' : 'tailnet-only',
    cloudOptIn: { ai: false, email: false, 'bank-feeds': policyState.optIn, updates: false },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers to temporarily set / clear env vars
// ---------------------------------------------------------------------------

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const restore = () => {
    for (const [k, orig] of Object.entries(saved)) {
      if (orig === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = orig;
      }
    }
  };
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(restore);
  }
  restore();
}

function clearPlaidEnv() {
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  delete process.env.PLAID_ENV;
}

// Minimal stub context — we never reach DB calls in these tests.
const stubCtx: ServiceContext = {
  db: {} as ServiceContext['db'],
  companyId: 'company-123',
  userId: 'user-456',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plaid service — isConfigured()', () => {
  beforeEach(() => clearPlaidEnv());
  afterEach(() => clearPlaidEnv());

  it('returns false when PLAID_CLIENT_ID and PLAID_SECRET are both absent', () => {
    expect(isConfigured()).toBe(false);
  });

  it('returns false when only PLAID_CLIENT_ID is set', () => {
    process.env.PLAID_CLIENT_ID = 'cid_test';
    expect(isConfigured()).toBe(false);
  });

  it('returns false when only PLAID_SECRET is set', () => {
    process.env.PLAID_SECRET = 'secret_test';
    expect(isConfigured()).toBe(false);
  });

  it('returns true when both PLAID_CLIENT_ID and PLAID_SECRET are set', () => {
    process.env.PLAID_CLIENT_ID = 'cid_test';
    process.env.PLAID_SECRET = 'secret_test';
    expect(isConfigured()).toBe(true);
  });
});

describe('Plaid service — createLinkToken() when not configured', () => {
  beforeEach(() => clearPlaidEnv());
  afterEach(() => clearPlaidEnv());

  it('throws a ServiceError with code VALIDATION when Plaid is not configured', async () => {
    await expect(createLinkToken(stubCtx)).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'VALIDATION',
    });
  });

  it('throws an instance of ServiceError', async () => {
    await expect(createLinkToken(stubCtx)).rejects.toBeInstanceOf(ServiceError);
  });

  it('error message mentions the required environment variables', async () => {
    await expect(createLinkToken(stubCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ServiceError &&
        e.message.includes('PLAID_CLIENT_ID') &&
        e.message.includes('PLAID_SECRET'),
    );
  });
});

describe('Plaid service — exchangePublicToken() when not configured', () => {
  beforeEach(() => clearPlaidEnv());
  afterEach(() => clearPlaidEnv());

  it('throws a ServiceError with code VALIDATION', async () => {
    await expect(exchangePublicToken(stubCtx, 'public-token-fake')).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'VALIDATION',
    });
  });
});

describe('Plaid service — createLinkToken() when configured (fetch mock)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearPlaidEnv();
    process.env.PLAID_CLIENT_ID = 'cid_mock';
    process.env.PLAID_SECRET = 'secret_mock';
    process.env.PLAID_ENV = 'sandbox';

    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    // @ts-ignore — intentional global mock
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    // @ts-ignore
    globalThis.fetch = originalFetch;
    clearPlaidEnv();
  });

  it('calls the correct Plaid endpoint and returns the link_token', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ link_token: 'link-sandbox-abc123' }),
    });

    const token = await createLinkToken(stubCtx);
    expect(token).toBe('link-sandbox-abc123');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.client_id).toBe('cid_mock');
    expect(body.secret).toBe('secret_mock');
    expect(body.user.client_user_id).toBe(stubCtx.companyId);
  });

  it('throws ServiceError INTERNAL when Plaid returns a non-OK response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_message: 'INVALID_REQUEST' }),
    });

    await expect(createLinkToken(stubCtx)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'INVALID_REQUEST',
    });
  });
});

describe('Plaid service — network policy', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearPlaidEnv();
    process.env.PLAID_CLIENT_ID = 'cid_mock';
    process.env.PLAID_SECRET = 'secret_mock';
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    // @ts-ignore — intentional global mock
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    // @ts-ignore
    globalThis.fetch = originalFetch;
    policyState.optIn = true;
    clearPlaidEnv();
  });

  it('blocks Plaid (no request leaves the machine) under the default tailnet-only policy', async () => {
    policyState.optIn = false;
    await expect(createLinkToken(stubCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
