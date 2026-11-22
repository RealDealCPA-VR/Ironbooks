import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { amountOf } from '@/lib/agent/facts';
import { operationById } from '../registry';
import type { Operation } from '../types';
import { bucketProblems } from './check';
import { LISTS_CLASSES } from './lists';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

describe('classification: lists', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('lists', LISTS_CLASSES)).toEqual([]);
  });

  it('treats making a class or location inactive as a delete (nothing makes it active again)', () => {
    for (const id of ['classes.update', 'locations.update']) {
      expect(op(id), id).toMatchObject({ method: 'PATCH', class: 'remove', body: 'none' });
    }
  });

  it('says a class or location PATCH takes no body because its handler reads none (read off the route)', () => {
    // If one of these starts reading a body, this fails: give the entry its body kind and schema.
    for (const [id, service] of [['classes.update', 'deactivateClass'], ['locations.update', 'deactivateLocation']] as const) {
      const file = path.join(process.cwd(), 'app', ...op(id).route.split('/').filter(Boolean), 'route.ts');
      const src = fs.readFileSync(file, 'utf8');
      const patch = src.slice(src.indexOf('export async function PATCH'));
      expect(patch, id).toMatch(/\(\s*_req\b/);
      expect(patch, id).not.toMatch(/\breq\.(?:json|text|formData|body)\b|requireJsonObject|searchParams/);
      expect(patch, id).toMatch(new RegExp(String.raw`${service}\(ctx, id\)`));
    }
  });

  it('never tells an agent that the vendor reveal shows the account number (it shows the tax ID only)', () => {
    expect(op('vendors.get').reveal).toBe('ssn');
    const assign = op('type-lists.vendor-assign').why ?? '';
    expect(assign).toMatch(/shows the tax ID only/);
    expect(assign).not.toMatch(/tax ID or the account number[^.]*reveal/);
  });

  it('sizes a voided home currency adjustment by every account it revalued', () => {
    const voided = op('currencies.home-currency-adjustment.delete');
    expect(voided.amountField).toBe('detail.*.gainLoss');
    // The net total is 100.00; the revaluation moved 9,900.00.
    const answer = { id: 'h1', total: '100.00', detail: [{ gainLoss: '5000.00' }, { gainLoss: '-4900.00' }] };
    expect(amountOf(voided, {}, answer)).toBe('9900.00');
  });

  it('describes the vendor type answer as it is now: masked by the service', () => {
    const assign = op('type-lists.vendor-assign');
    expect(assign.why).not.toMatch(/leak/i);
    expect(assign.why).toMatch(/maskForContext/);
  });

  it('keeps the Clean Up preview a read, with the reason (it shows list entries, no file)', () => {
    expect(op('cleanup')).toMatchObject({ class: 'read', area: 'file_utilities' });
    expect(op('cleanup').why).toMatch(/never a file name, folder or backup/);
  });
});
