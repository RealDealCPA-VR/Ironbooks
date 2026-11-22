import { describe, expect, it } from 'vitest';
import { amountOf } from '@/lib/agent/facts';
import { defaultSiteForRead } from '@/lib/services/inventorySites';
import { operationById } from '../registry';
import type { Operation } from '../types';
import { bucketProblems } from './check';
import { PURCHASES_CLASSES } from './purchases';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

describe('classification: purchases', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('purchases', PURCHASES_CLASSES)).toEqual([]);
  });

  it('judges a Pay Bills save by the credits it applies, not only the cash', () => {
    const pay = op('bill-payments.create');
    expect(pay.amountField).toBe('creditsApplied');
    // payBillsWithCredits answers { payment, creditsApplied }: a $1 check applying a $50,000 credit.
    const answer = { payment: { id: 'p1', amount: '1.00' }, creditsApplied: '50000.00' };
    expect(amountOf(pay, { body: { vendorId: 'v1', applications: [] } }, answer)).toBe('50000.00');
    // Credits only: no payment at all, still the credits.
    expect(amountOf(pay, { body: {} }, { payment: null, creditsApplied: '300.00' })).toBe('300.00');
    // Before the route has answered, nothing in the body gives the figure: unknown, over every limit.
    expect(amountOf(pay, { body: { vendorId: 'v1' } })).toBeNull();
  });

  it('keeps the inventory site lists and reports reads (an agent\'s read never makes the default site)', () => {
    for (const id of ['inventory-sites.list', 'inventory-sites.reorder-points', 'inventory-sites.reports']) {
      expect(op(id), id).toMatchObject({ class: 'read', method: 'GET', dryRun: 'none' });
      expect(op(id).why, id).toMatch(/read-only/);
    }
    // The list and the reports read through defaultSiteForRead, which makes the site for a person only.
    expect(typeof defaultSiteForRead).toBe('function');
    for (const id of ['inventory-sites.list', 'inventory-sites.reports']) {
      expect(op(id).why, id).toMatch(/defaultSiteForRead/);
      expect(op(id).why, id).not.toMatch(/has no read-only guard/);
    }
  });

  it('names the preview option of the bulk vendor save and the bill for received items', () => {
    expect(op('vendors.bulk.save')).toMatchObject({ dryRun: 'preview', countField: 'rows' });
    expect(op('vendors.bulk.save').why).toMatch(/dryRun: true/);
    expect(op('receiving.bill')).toMatchObject({ dryRun: 'preview', amountField: 'total' });
    expect(op('receiving.bill').why).toMatch(/preview: true/);
  });
});
