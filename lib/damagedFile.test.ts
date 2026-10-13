/**
 * P1 controls — a damaged company file shows a plain "restore a backup" screen, not the generic
 * error page: server pages (getPageContext) redirect to /damaged-file, client pages are sent
 * there by lib/client.ts, and app/error.tsx recognizes the message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const redirected: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...orig,
    getDb: async () => {
      throw new orig.LedgerDamagedError([
        { kind: 'unbalanced_entry', detail: 'Entry 12 is out of balance.' } as never,
      ]);
    },
  };
});

import { getPageContext } from '@/lib/context';
import { api, isDamagedFileError, isDamagedFileMessage } from '@/lib/client';

afterEach(() => {
  vi.unstubAllGlobals();
  redirected.length = 0;
});

describe('damaged company file', () => {
  it('server-rendered pages redirect to the damaged-file screen', async () => {
    const err = await getPageContext('/dashboard').catch((e) => e);
    expect(String(err.message)).toMatch(/NEXT_REDIRECT/);
    expect(redirected).toEqual(['/damaged-file']);
  });

  it('recognizes the refusal message (error page + client)', () => {
    const msg =
      'This company file is damaged, so BookKeeper will not open it: Entry 12 is out of balance. Restore your most recent backup.';
    expect(isDamagedFileMessage(msg)).toBe(true);
    expect(isDamagedFileMessage('Something else')).toBe(false);
    expect(isDamagedFileError(409, msg)).toBe(true);
    expect(isDamagedFileError(409, 'This record was changed by Dana')).toBe(false);
  });

  it('client pages are sent to /damaged-file when an API call is refused', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/invoices', search: '', assign } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'This company file is damaged, so BookKeeper will not open it.', code: 'CONFLICT' }), {
          status: 409,
        }),
      ),
    );
    await api.get('/api/invoices').catch(() => undefined);
    expect(assign).toHaveBeenCalledWith('/damaged-file');
  });

  it('…but not from the backup page, where the file can still be backed up and restored', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/backup', search: '', assign } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'This company file is damaged.', code: 'CONFLICT' }), { status: 409 })),
    );
    await api.get('/api/dashboard').catch(() => undefined);
    expect(assign).not.toHaveBeenCalled();
  });
});
