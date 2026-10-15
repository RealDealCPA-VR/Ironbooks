/**
 * parseSmartDefaultsQuery: the per-route form allow-list and uuid checks behind
 * /api/smart-defaults/{bills,expenses,sales}. Every rejection is a VALIDATION error, which the
 * routes turn into a 400 through routeError.
 */
import { describe, expect, it } from 'vitest';
import { routeError } from '@/lib/routeErrors';
import { parseSmartDefaultsQuery } from './smartDefaultsRoute';

const VENDOR = '3f1c2b9e-8d4a-4c1e-9f0b-2a7d6e5c4b3a';
const BANK = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const CUSTOMER = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

const q = (s: string) => new URLSearchParams(s);

/** Expect a VALIDATION error that routeError answers with 400. */
async function expect400(fn: () => unknown, message: RegExp) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toMatchObject({ code: 'VALIDATION' });
  expect((caught as Error).message).toMatch(message);
  const res = routeError(caught, 'test');
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'VALIDATION' });
}

describe('parseSmartDefaultsQuery', () => {
  it('accepts an allowed form with valid ids (blank ids become null)', () => {
    expect(
      parseSmartDefaultsQuery(q(`form=check&vendorId=${VENDOR}&paymentAccountId=${BANK}&customerId=`), [
        'check',
        'expense',
        'credit_card',
      ]),
    ).toEqual({ form: 'check', vendorId: VENDOR, customerId: null, paymentAccountId: BANK });
    expect(parseSmartDefaultsQuery(q(`form=invoice&customerId=${CUSTOMER}`), ['invoice', 'sales_receipt'])).toEqual({
      form: 'invoice',
      vendorId: null,
      customerId: CUSTOMER,
      paymentAccountId: null,
    });
  });

  it('rejects a form that is not allowed on this route (400)', async () => {
    // A real smart form, but the bills route only serves bills: no cross-area reads.
    await expect400(() => parseSmartDefaultsQuery(q(`form=invoice&customerId=${CUSTOMER}`), ['bill']), /form must be one of: bill/);
    await expect400(() => parseSmartDefaultsQuery(q(`form=bill&vendorId=${VENDOR}`), ['invoice', 'sales_receipt']), /form must be one of/);
    // Not a smart form at all.
    await expect400(() => parseSmartDefaultsQuery(q('form=journal'), ['bill']), /form must be one of/);
  });

  it('rejects a missing or blank form (400)', async () => {
    await expect400(() => parseSmartDefaultsQuery(q(`vendorId=${VENDOR}`), ['bill']), /form must be one of/);
    await expect400(() => parseSmartDefaultsQuery(q('form='), ['bill']), /form must be one of/);
  });

  it('rejects a non-uuid vendorId, customerId or paymentAccountId (400)', async () => {
    await expect400(() => parseSmartDefaultsQuery(q('form=bill&vendorId=not-a-uuid'), ['bill']), /vendorId must be a uuid/);
    await expect400(
      () => parseSmartDefaultsQuery(q(`form=check&vendorId=${VENDOR}&paymentAccountId=1'%20OR%201=1`), ['check']),
      /paymentAccountId must be a uuid/,
    );
    await expect400(
      () => parseSmartDefaultsQuery(q(`form=invoice&customerId=${CUSTOMER}x`), ['invoice']),
      /customerId must be a uuid/,
    );
  });
});
