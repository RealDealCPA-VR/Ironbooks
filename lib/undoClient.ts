/**
 * Client half of "Undo for everything" (ux/undo).
 *
 * Every form saves through lib/client.ts, so the undo wiring lives there instead of in each page:
 * components/UndoToast.tsx registers `createUndoTracker()` with setUndoTracker, and from then on
 *
 *   - before an update / void / delete of an undoable record the tracker asks the server to
 *     snapshot it (POST /api/undo/prepare), and
 *   - after ANY successful create / update / void / delete of one it arms the undo
 *     (POST /api/undo/commit) and announces it, so the toast shows "Undo" for 30 seconds.
 *
 * Pages need no code. A write sent with `{ noUndo: true }` is left alone.
 */
import type { UndoTracker, WriteInfo } from '@/lib/client';

/** API resources with Undo (must match the adapters in lib/services/undo.ts). */
export const UNDO_RESOURCES = {
  invoices: { list: false },
  bills: { list: false },
  expenses: { list: false },
  deposits: { list: false },
  payments: { list: false },
  'bill-payments': { list: false },
  'journal-entries': { list: false },
  estimates: { list: false },
  'sales-receipts': { list: false },
  'credit-memos': { list: false },
  'purchase-orders': { list: false },
  transfers: { list: false },
  'vendor-credits': { list: false },
  customers: { list: true },
  vendors: { list: true },
  items: { list: true },
  accounts: { list: true },
} as const;

export type UndoResource = keyof typeof UNDO_RESOURCES;
export type UndoKind = 'create' | 'update' | 'void' | 'delete';

export interface ClassifiedWrite {
  resource: UndoResource;
  kind: UndoKind;
  /** The record id for update / void / delete (null for a create). */
  id: string | null;
}

const PATH_RE = /^\/api\/([a-z-]+)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\/?$/i;

/** Which undoable action (if any) a write is. */
export function classifyWrite(method: string, path: string, body: unknown): ClassifiedWrite | null {
  const m = PATH_RE.exec(path);
  if (!m) return null;
  const resource = m[1] as UndoResource;
  if (!(resource in UNDO_RESOURCES)) return null;
  const id = m[2] ?? null;
  const list = UNDO_RESOURCES[resource].list;
  if (method === 'POST' && !id) return { resource, kind: 'create', id: null };
  if (!id) return null;
  if (method === 'PUT' || method === 'PATCH') return { resource, kind: 'update', id };
  if (method === 'DELETE') return { resource, kind: list ? 'delete' : 'void', id };
  // Purchase orders are voided with POST { action: 'void' } (status change, no posting).
  const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined;
  if (method === 'POST' && resource === 'purchase-orders' && action === 'void') return { resource, kind: 'void', id };
  return null;
}

/** Id of the record a create returned: `{ id }`, or one level down (`{ payment: { id } }`). */
export function createdIdOf(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.id === 'string') return r.id;
  for (const v of Object.values(r)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { id?: unknown }).id === 'string') {
      return (v as { id: string }).id;
    }
  }
  return null;
}

/** An armed undo, as announced to the toast. */
export interface ArmedUndo {
  token: string;
  label: string;
  kind: UndoKind;
  /** Server deadline (ISO). */
  expiresAt: string;
  message: string;
  resource: UndoResource;
}

type Listener = (u: ArmedUndo) => void;
const listeners = new Set<Listener>();

/** Subscribe to newly armed undos (the toast). Returns the unsubscribe function. */
export function onUndoArmed(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Announce an armed undo to every listener (exported for tests). */
export function announceUndo(u: ArmedUndo): void {
  for (const fn of listeners) {
    try {
      fn(u);
    } catch {
      /* one bad listener must not stop the others */
    }
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

async function postJson(fetcher: FetchLike, url: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface Prepared {
  write: ClassifiedWrite;
  token: string | null;
}

/**
 * The tracker lib/client.ts calls around each write. `fetcher` defaults to window.fetch; it goes
 * straight to the network (not through lib/client.ts), so undo bookkeeping never re-enters the
 * tracker, the closing-date prompt or the record-version cache.
 */
export function createUndoTracker(fetcher?: FetchLike): UndoTracker {
  const doFetch: FetchLike =
    fetcher ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  return {
    async before(info: WriteInfo): Promise<Prepared | null> {
      const write = classifyWrite(info.method, info.path, info.body);
      if (!write) return null;
      if (write.kind === 'create') return { write, token: null };
      const out = (await postJson(doFetch, '/api/undo/prepare', { resource: write.resource, kind: write.kind, id: write.id })) as
        | { token?: unknown }
        | null;
      const token = out && typeof out.token === 'string' ? out.token : null;
      return token ? { write, token } : null;
    },
    after(_info: WriteInfo, data: unknown, prepared: unknown): void {
      const p = prepared as Prepared | null;
      if (!p) return;
      const id = p.write.kind === 'create' ? createdIdOf(data) : p.write.id;
      void postJson(doFetch, '/api/undo/commit', {
        resource: p.write.resource,
        kind: p.write.kind,
        token: p.token,
        id,
      }).then((armed) => {
        const a = armed as Partial<ArmedUndo> | null;
        if (!a || typeof a.token !== 'string' || typeof a.expiresAt !== 'string') return;
        announceUndo({
          token: a.token,
          label: String(a.label ?? ''),
          kind: (a.kind ?? p.write.kind) as UndoKind,
          expiresAt: a.expiresAt,
          message: String(a.message ?? 'Saved.'),
          resource: p.write.resource,
        });
      });
    },
  };
}
