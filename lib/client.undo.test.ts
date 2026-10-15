/**
 * lib/client.ts runs the registered undo tracker around every write (ux/undo): `before` ahead of
 * the request, `after` with the response once it succeeded, never for `{ noUndo: true }`, and a
 * tracker failure never fails the save.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setUndoTracker, type UndoTracker } from '@/lib/client';

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => {
  setUndoTracker(null);
  vi.unstubAllGlobals();
});

describe('API client undo tracker', () => {
  it('calls before, then the request, then after with the saved data', async () => {
    const order: string[] = [];
    const calls = stubFetch({ id: 'x1' });
    const tracker: UndoTracker = {
      before: vi.fn(async () => {
        order.push(`before:${calls.length}`);
        return 'prep';
      }),
      after: vi.fn((_info, data, prepared) => order.push(`after:${(data as { id: string }).id}:${prepared}`)),
    };
    setUndoTracker(tracker);
    await api.post('/api/invoices', { customerId: 'c' });
    expect(order).toEqual(['before:0', 'after:x1:prep']);
    expect(calls).toEqual(['/api/invoices']);
  });

  it('skips the tracker for noUndo writes and for failed saves', async () => {
    const tracker: UndoTracker = { before: vi.fn(async () => 'p'), after: vi.fn() };
    setUndoTracker(tracker);
    stubFetch({ ok: true });
    await api.post('/api/undo/abc', undefined, { noUndo: true });
    expect(tracker.before).not.toHaveBeenCalled();
    stubFetch({ error: 'nope', code: 'VALIDATION' }, 400);
    await expect(api.put('/api/invoices/1', {})).rejects.toThrow('nope');
    expect(tracker.after).not.toHaveBeenCalled();
  });

  it('a tracker that throws never fails the save', async () => {
    setUndoTracker({
      before: async () => {
        throw new Error('prepare down');
      },
      after: () => {
        throw new Error('commit down');
      },
    });
    stubFetch({ id: 'ok' });
    await expect(api.del('/api/customers/1')).resolves.toEqual({ id: 'ok' });
  });
});
