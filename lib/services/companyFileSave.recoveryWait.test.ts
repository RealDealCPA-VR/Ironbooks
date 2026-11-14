/**
 * A recovery waits for a save only while that save is WRITING (it has taken its snapshot).
 * A save still on its way may be opening the database — and so waiting for that very recovery:
 * waiting on it would never end and would hold every request (lib/services/companyFileSave.ts
 * whenNoSaveWriting).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { whenNoSaveWriting } from './companyFileSave';

const g = globalThis as unknown as { __ironbooksCompanyFileSave?: Record<string, unknown> };
const saved = g.__ironbooksCompanyFileSave;
afterEach(() => {
  g.__ironbooksCompanyFileSave = saved;
});

const settles = (p: Promise<unknown>, ms = 200) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

describe('whenNoSaveWriting', () => {
  it('does not wait for a save that has not taken its snapshot (it may be waiting for this recovery)', async () => {
    g.__ironbooksCompanyFileSave = { inflight: new Promise(() => undefined), snapshotTaken: false };
    expect(await settles(whenNoSaveWriting())).toBe(true);
  });

  it('waits for a save that is writing its snapshot out', async () => {
    let finish!: () => void;
    const inflight = new Promise<void>((r) => (finish = r));
    const state: Record<string, unknown> = { inflight, snapshotTaken: true };
    g.__ironbooksCompanyFileSave = state;
    const wait = whenNoSaveWriting();
    expect(await settles(wait, 50)).toBe(false);
    state.inflight = null;
    finish();
    expect(await settles(wait)).toBe(true);
  });
});
