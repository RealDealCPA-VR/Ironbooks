/**
 * Client half of Undo (ux/undo): which writes get an Undo toast, and the prepare -> save ->
 * commit sequence the API client runs around them.
 */
import { describe, it, expect, vi } from 'vitest';
import { announceUndo, classifyWrite, createUndoTracker, createdIdOf, onUndoArmed, UNDO_RESOURCES, type ArmedUndo } from './undoClient';
import { UNDOABLE_RESOURCES } from './services/undo';

const ID = '0a1b2c3d-1111-4222-8333-944455556666';

describe('classifyWrite', () => {
  it('maps creates, updates, voids and deletes', () => {
    expect(classifyWrite('POST', '/api/invoices', {})).toEqual({ resource: 'invoices', kind: 'create', id: null });
    expect(classifyWrite('PUT', `/api/invoices/${ID}`, {})).toEqual({ resource: 'invoices', kind: 'update', id: ID });
    expect(classifyWrite('PATCH', `/api/bills/${ID}`, {})).toEqual({ resource: 'bills', kind: 'update', id: ID });
    expect(classifyWrite('DELETE', `/api/bills/${ID}`, undefined)).toEqual({ resource: 'bills', kind: 'void', id: ID });
    expect(classifyWrite('DELETE', `/api/customers/${ID}`, undefined)).toEqual({ resource: 'customers', kind: 'delete', id: ID });
    expect(classifyWrite('POST', `/api/purchase-orders/${ID}`, { action: 'void' })).toEqual({
      resource: 'purchase-orders',
      kind: 'void',
      id: ID,
    });
  });

  it('ignores other actions and other resources', () => {
    expect(classifyWrite('POST', `/api/purchase-orders/${ID}`, { action: 'convert' })).toBeNull();
    expect(classifyWrite('POST', `/api/payments/${ID}`, { action: 'apply' })).toBeNull();
    expect(classifyWrite('POST', '/api/customers/bulk', {})).toBeNull();
    expect(classifyWrite('POST', '/api/undo/prepare', {})).toBeNull();
    expect(classifyWrite('POST', '/api/time-entries', {})).toBeNull();
    expect(classifyWrite('PATCH', '/api/invoices', {})).toBeNull();
  });

  it('covers exactly the resources the server can undo', () => {
    expect(Object.keys(UNDO_RESOURCES).sort()).toEqual([...UNDOABLE_RESOURCES].sort());
  });
});

describe('createdIdOf', () => {
  it('finds the new record id at the top or one level down', () => {
    expect(createdIdOf({ id: ID })).toBe(ID);
    expect(createdIdOf({ payment: { id: ID }, entry: null })).toBe(ID);
    expect(createdIdOf([{ id: ID }])).toBeNull();
    expect(createdIdOf(null)).toBeNull();
  });
});

describe('createUndoTracker', () => {
  function fakeFetch(responses: Record<string, unknown>) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const r = responses[url];
      return { ok: r !== undefined, json: async () => r };
    });
    return { fetcher, calls };
  }
  const armed = { token: 't-1', label: 'invoice 1001', kind: 'update', expiresAt: new Date(Date.now() + 30_000).toISOString(), message: 'Invoice 1001 changed.' };

  it('snapshots before an update and arms it after the save', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/undo/prepare': { token: 'p-1' }, '/api/undo/commit': armed });
    const seen: ArmedUndo[] = [];
    const off = onUndoArmed((u) => seen.push(u));
    const t = createUndoTracker(fetcher as never);
    const info = { method: 'PUT' as const, path: `/api/invoices/${ID}`, body: {} };
    const prep = await t.before(info);
    expect(calls[0]).toEqual({ url: '/api/undo/prepare', body: { resource: 'invoices', kind: 'update', id: ID } });
    t.after(info, { id: ID }, prep);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(calls[1]).toEqual({ url: '/api/undo/commit', body: { resource: 'invoices', kind: 'update', token: 'p-1', id: ID } });
    expect(seen[0]).toMatchObject({ token: 't-1', resource: 'invoices', message: 'Invoice 1001 changed.' });
    off();
  });

  it('needs no snapshot for a create and sends the new id', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/undo/commit': { ...armed, kind: 'create' } });
    const t = createUndoTracker(fetcher as never);
    const info = { method: 'POST' as const, path: '/api/customers', body: { displayName: 'X' } };
    const prep = await t.before(info);
    expect(calls).toHaveLength(0);
    t.after(info, { id: ID }, prep);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ resource: 'customers', kind: 'create', token: null, id: ID });
  });

  it('never blocks a save: a failed snapshot just means no Undo toast', async () => {
    const { fetcher, calls } = fakeFetch({});
    const t = createUndoTracker(fetcher as never);
    const info = { method: 'DELETE' as const, path: `/api/vendors/${ID}`, body: undefined };
    const prep = await t.before(info);
    expect(prep).toBeNull();
    t.after(info, {}, prep);
    expect(calls).toHaveLength(1); // only the failed prepare
  });

  it('a throwing listener does not stop the others', () => {
    const got: string[] = [];
    const a = onUndoArmed(() => {
      throw new Error('boom');
    });
    const b = onUndoArmed((u) => got.push(u.token));
    announceUndo({ ...armed, kind: 'update', resource: 'bills' } as ArmedUndo);
    expect(got).toEqual(['t-1']);
    a();
    b();
  });
});
