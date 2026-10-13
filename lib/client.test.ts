/**
 * Unit tests for the typed fetch client (lib/client.ts), focused on the
 * closing-date override plumbing:
 *  - mutating calls pass an explicit closingPassword as x-closing-password
 *  - a PERIOD_CLOSED failure triggers the registered prompt and retries once
 *  - a cancelled prompt (null) rethrows the original ApiError
 *  - GET/POST happy paths and ApiError mapping still behave as before
 *  - isFileLockError recognizes the 403 file-lock message thrown by getServerContext
 *
 * global.fetch is stubbed with real Response objects (Node 18+). These tests run in the node
 * environment (no window), so the /unlock redirect side effect itself is not exercised here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  CLOSING_PASSWORD_HEADER,
  isAuthError,
  isClosingPasswordError,
  isStaleRecordError,
  setStaleRecordHandler,
  isFileLockError,
  MAX_CLOSING_PASSWORD_ATTEMPTS,
  setClosingPasswordPrompt,
} from '@/lib/client';
import { DEACTIVATED_MESSAGE } from '@/lib/context';

type FetchArgs = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Install a fetch stub returning the given responses in order; records calls. */
function stubFetch(...responses: Response[]): FetchArgs[] {
  const calls: FetchArgs[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const res = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return res.clone();
    }),
  );
  return calls;
}

function headerOf(call: FetchArgs, name: string): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.[name];
}

afterEach(() => {
  vi.unstubAllGlobals();
  setClosingPasswordPrompt(null);
});

describe('api client', () => {
  it('GET parses JSON and uses no-store', async () => {
    const calls = stubFetch(jsonResponse({ ok: 1 }));
    const out = await api.get<{ ok: number }>('/api/dashboard');
    expect(out.ok).toBe(1);
    expect(calls[0].url).toBe('/api/dashboard');
    expect((calls[0].init as RequestInit).cache).toBe('no-store');
  });

  it('POST sends a JSON body with content-type and returns the parsed result', async () => {
    const calls = stubFetch(jsonResponse({ id: 'abc' }));
    const out = await api.post<{ id: string }>('/api/invoices', { total: '10.00' });
    expect(out.id).toBe('abc');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerOf(calls[0], 'content-type')).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ total: '10.00' }));
  });

  it('throws ApiError with status/message/code on non-2xx', async () => {
    stubFetch(jsonResponse({ error: 'Invoice not found', code: 'NOT_FOUND' }, 404));
    const err = (await api.get('/api/invoices/x').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Invoice not found');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('sends an explicit closingPassword as the x-closing-password header', async () => {
    const calls = stubFetch(jsonResponse({ ok: true }));
    await api.post('/api/journal-entries', { memo: 'backdated' }, { closingPassword: 'sekret' });
    expect(headerOf(calls[0], CLOSING_PASSWORD_HEADER)).toBe('sekret');
  });

  it('on PERIOD_CLOSED, invokes the registered prompt and retries once with the password', async () => {
    const calls = stubFetch(
      jsonResponse({ error: 'Period is closed', code: 'PERIOD_CLOSED' }, 400),
      jsonResponse({ posted: true }),
    );
    const prompt = vi.fn(async () => 'override-pw');
    setClosingPasswordPrompt(prompt);

    const out = await api.post<{ posted: boolean }>('/api/journal-entries', { memo: 'x' });
    expect(out.posted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[0], CLOSING_PASSWORD_HEADER)).toBeUndefined();
    expect(headerOf(calls[1], CLOSING_PASSWORD_HEADER)).toBe('override-pw');
  });

  it('rethrows PERIOD_CLOSED when the prompt is cancelled (returns null)', async () => {
    const calls = stubFetch(jsonResponse({ error: 'Period is closed', code: 'PERIOD_CLOSED' }, 400));
    setClosingPasswordPrompt(() => null);

    const err = (await api.post('/api/journal-entries', {}).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('PERIOD_CLOSED');
    expect(calls).toHaveLength(1); // no retry without a password
  });

  it('does not re-prompt when an explicit (wrong) closingPassword was supplied', async () => {
    const calls = stubFetch(jsonResponse({ error: 'Period is closed', code: 'PERIOD_CLOSED' }, 400));
    const prompt = vi.fn(async () => 'whatever');
    setClosingPasswordPrompt(prompt);

    const err = (await api
      .patch('/api/invoices/1', {}, { closingPassword: 'wrong' })
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(prompt).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('falls back to the window-level prompt hook (__bkaClosingPasswordPrompt)', async () => {
    const calls = stubFetch(
      jsonResponse({ error: 'Period is closed', code: 'PERIOD_CLOSED' }, 400),
      jsonResponse({ ok: true }),
    );
    const windowPrompt = vi.fn(() => 'window-pw');
    vi.stubGlobal('window', { __bkaClosingPasswordPrompt: windowPrompt });

    const out = await api.del<{ ok: boolean }>('/api/payments/1');
    expect(out.ok).toBe(true);
    expect(windowPrompt).toHaveBeenCalledTimes(1);
    expect(headerOf(calls[1], CLOSING_PASSWORD_HEADER)).toBe('window-pw');
  });

  it('re-asks with a "wrong password" flag when the retried save is still refused', async () => {
    const closed = { error: 'The books are closed through 2026-01-31.', code: 'PERIOD_CLOSED' };
    const calls = stubFetch(jsonResponse(closed, 400), jsonResponse(closed, 400), jsonResponse({ ok: true }));
    const seen: Array<{ rejected: boolean; message: string } | undefined> = [];
    const answers = ['wrong', 'right'];
    setClosingPasswordPrompt((info) => {
      seen.push(info);
      return answers.shift() ?? null;
    });
    const out = await api.patch<{ ok: boolean }>('/api/expenses/1', { memo: 'x' });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(headerOf(calls[1], CLOSING_PASSWORD_HEADER)).toBe('wrong');
    expect(headerOf(calls[2], CLOSING_PASSWORD_HEADER)).toBe('right');
    expect(seen[0]?.rejected).toBe(false);
    expect(seen[0]?.message).toMatch(/closed through/);
    expect(seen[1]?.rejected).toBe(true);
  });

  it('gives up with a plain message after the maximum number of wrong passwords', async () => {
    const closed = { error: 'The books are closed through 2026-01-31.', code: 'PERIOD_CLOSED' };
    const calls = stubFetch(jsonResponse(closed, 400));
    const prompt = vi.fn(() => 'nope');
    setClosingPasswordPrompt(prompt);
    const err = (await api.post('/api/deposits', {}).catch((e) => e)) as ApiError;
    expect(err.code).toBe('PERIOD_CLOSED');
    expect(err.message).toMatch(/password is not correct/);
    expect(prompt).toHaveBeenCalledTimes(MAX_CLOSING_PASSWORD_ATTEMPTS);
    expect(calls).toHaveLength(1 + MAX_CLOSING_PASSWORD_ATTEMPTS);
  });

  it('does not prompt for a closed fiscal period (the password cannot unlock it)', async () => {
    const calls = stubFetch(
      jsonResponse(
        {
          error: 'The accounting period containing 2026-01-05 is closed. Reopen it under Fiscal Periods to post.',
          code: 'PERIOD_CLOSED',
        },
        400,
      ),
    );
    const prompt = vi.fn(() => 'pw');
    setClosingPasswordPrompt(prompt);
    const err = (await api.post('/api/journal-entries', {}).catch((e) => e)) as ApiError;
    expect(err.code).toBe('PERIOD_CLOSED');
    expect(prompt).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(isClosingPasswordError(err)).toBe(false);
  });

  it('DELETE sends no content-type/body but honors opts headers', async () => {
    const calls = stubFetch(jsonResponse({ ok: true }));
    await api.del('/api/bills/1', { headers: { 'x-test': 'yes' } });
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].init?.body).toBeUndefined();
    expect(headerOf(calls[0], 'content-type')).toBeUndefined();
    expect(headerOf(calls[0], 'x-test')).toBe('yes');
  });
});

describe('isFileLockError', () => {
  it('matches a 403 carrying the file-lock message from lib/context.ts', () => {
    expect(isFileLockError(403, 'This company file is locked. Unlock it to continue.')).toBe(true);
  });

  it('is false for a 403 with an unrelated message', () => {
    expect(isFileLockError(403, 'Authentication required.')).toBe(false);
  });

  it('is false for non-403 statuses even with a matching message', () => {
    expect(isFileLockError(200, 'This company file is locked. Unlock it to continue.')).toBe(false);
  });
});

describe('isAuthError', () => {
  it('matches the session-required and deactivated messages from lib/context.ts', () => {
    expect(isAuthError(403, 'Authentication required.')).toBe(true);
    expect(isAuthError(403, DEACTIVATED_MESSAGE)).toBe(true);
  });

  it('does not treat permission denials or the file lock as auth errors', () => {
    expect(isAuthError(403, 'You do not have permission to view Banking.')).toBe(false);
    expect(isAuthError(403, 'This company file is locked. Unlock it to continue.')).toBe(false);
    expect(isAuthError(500, 'Authentication required.')).toBe(false);
  });
});

describe('record locking in the client (P1: every transaction type)', () => {
  it('sends the loaded version for checks, deposits, paychecks …; accounts use editedAt', async () => {
    const calls = stubFetch(
      jsonResponse({ id: 'c1', updatedAt: '2026-01-01T00:00:00.001Z' }),
      jsonResponse({ id: 'a1', updatedAt: '2026-05-05T00:00:00.000Z', editedAt: '2026-01-02T00:00:00.002Z' }),
      jsonResponse({ ok: true }),
    );
    await api.get('/api/expenses/c1');
    await api.get('/api/accounts/a1');
    await api.patch('/api/expenses/c1', { memo: 'x' });
    await api.patch('/api/accounts/a1', { name: 'y' });
    expect(headerOf(calls[2], 'x-expected-updated-at')).toBe('2026-01-01T00:00:00.001Z');
    expect(headerOf(calls[3], 'x-expected-updated-at')).toBe('2026-01-02T00:00:00.002Z');
  });

  it('void / close / status / convert POST actions carry the version; other POSTs do not', async () => {
    const calls = stubFetch(
      jsonResponse({ id: 'po1', updatedAt: '2026-03-03T00:00:00.003Z' }),
      jsonResponse({ ok: true }),
      jsonResponse({ id: 'b9' }),
      jsonResponse({ id: 'po1', updatedAt: '2026-03-03T00:00:00.009Z' }),
      jsonResponse({ id: 'po1', updatedAt: '2026-03-04T00:00:00.000Z' }),
      jsonResponse({ id: 'po1', updatedAt: '2026-03-05T00:00:00.000Z' }),
    );
    await api.get('/api/purchase-orders/po1');
    await api.post('/api/purchase-orders/po1', { action: 'apply' });
    await api.post('/api/purchase-orders/po1', { action: 'convert' });
    expect(headerOf(calls[1], 'x-expected-updated-at')).toBeUndefined();
    // Convert consumes the record, so a stale tab must not convert it.
    expect(headerOf(calls[2], 'x-expected-updated-at')).toBe('2026-03-03T00:00:00.003Z');
    // Convert returns the new bill, not the order: the order's version is forgotten (no false 409)
    // until the page reloads it.
    await api.get('/api/purchase-orders/po1');
    await api.post('/api/purchase-orders/po1', { action: 'close' });
    await api.post('/api/purchase-orders/po1', { action: 'void' });
    expect(headerOf(calls[4], 'x-expected-updated-at')).toBe('2026-03-03T00:00:00.009Z');
    // The saved record's new version becomes the next expected one.
    expect(headerOf(calls[5], 'x-expected-updated-at')).toBe('2026-03-04T00:00:00.000Z');
  });

  it('a stale-version 409 notifies the record-changed dialog with who changed it', async () => {
    stubFetch(
      jsonResponse(
        {
          error: 'This record was changed by Dana at Jun 3, 2026, 2:14 PM. Reload to see the latest.',
          code: 'CONFLICT',
          details: { staleVersion: true, changedBy: 'Dana', changedAt: '2026-06-03T14:14:00.000Z' },
        },
        409,
      ),
    );
    const seen: unknown[] = [];
    setStaleRecordHandler((info) => seen.push(info));
    try {
      const err = await api.patch('/api/deposits/d1', {}).catch((e) => e);
      expect(isStaleRecordError(err)).toBe(true);
      expect(seen).toEqual([
        {
          message: 'This record was changed by Dana at Jun 3, 2026, 2:14 PM. Reload to see the latest.',
          changedBy: 'Dana',
          changedAt: '2026-06-03T14:14:00.000Z',
        },
      ]);
    } finally {
      setStaleRecordHandler(null);
    }
  });

  it('an ordinary 409 (e.g. already deposited) does not open the record-changed dialog', async () => {
    stubFetch(jsonResponse({ error: 'Already deposited', code: 'CONFLICT' }, 409));
    const handler = vi.fn();
    setStaleRecordHandler(handler);
    try {
      await api.patch('/api/payments/p1', {}).catch(() => undefined);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      setStaleRecordHandler(null);
    }
  });
});
