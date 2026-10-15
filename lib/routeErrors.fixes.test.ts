/**
 * Fix suggestions travel from ServiceError to the HTTP body (routeError, the sales route error
 * mapper, the zod 400 helper) and back into ApiError.fixes on the client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '@/lib/services/_base';
import { routeError, serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { api, ApiError, errorFixes } from '@/lib/client';
import { creditLimitFixes, type ErrorFix } from '@/lib/errorFixes';
import { describeError } from '@/lib/friendlyErrors';

const fix: ErrorFix = {
  id: 'balance-add',
  label: "Add $40.00 to line 3's credit",
  kind: 'patch',
  patch: [{ op: 'add', path: 'lines.2.credit', amount: '40.00' }],
};

describe('routeError serialization', () => {
  it('includes fixes next to error/code/details', async () => {
    const res = routeError(new ServiceError('UNBALANCED', 'Debits are $40.00 more than credits.', { difference: '40.00' }, [fix]), 't');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Debits are $40.00 more than credits.',
      code: 'UNBALANCED',
      details: { difference: '40.00' },
      fixes: [fix],
    });
  });

  it('omits fixes when there are none (unchanged body shape)', async () => {
    const body = await routeError(new ServiceError('NOT_FOUND', 'Invoice not found'), 't').json();
    expect(body).toEqual({ error: 'Invoice not found', code: 'NOT_FOUND' });
    expect('fixes' in body).toBe(false);
  });

  it('withFixes appends and keeps the error chainable', () => {
    const err = new ServiceError('PERIOD_CLOSED', 'closed').withFixes([fix]).withFixes(null).withFixes([]);
    expect(err.fixes).toEqual([fix]);
    expect(serviceErrorBody(err).fixes).toEqual([fix]);
    expect(serviceErrorStatus('PERIOD_CLOSED')).toBe(400);
    expect(serviceErrorStatus('CONFLICT')).toBe(409);
    expect(serviceErrorStatus('INTERNAL')).toBe(500);
  });

  it('sales mapper: soft warnings carry their fixes with the warning code', async () => {
    const credit = routeErrorWithWarnings(
      new ServiceError('VALIDATION', 'Credit limit exceeded', { warning: 'CREDIT_LIMIT' }, creditLimitFixes()),
      't',
    );
    expect(credit.status).toBe(409);
    const body = await credit.json();
    expect(body.code).toBe('CREDIT_LIMIT');
    expect(body.fixes[0]).toMatchObject({ id: 'credit-limit-override', kind: 'retry' });

    const stock = routeErrorWithWarnings(
      new ServiceError('VALIDATION', 'Not enough inventory', { warning: 'NEGATIVE_STOCK' }, [fix]),
      't',
    );
    expect(stock.status).toBe(409);
    expect((await stock.json()).code).toBe('NEGATIVE_STOCK');

    // Plain errors go through routeError with fixes too.
    const dup = routeErrorWithWarnings(new ServiceError('CONFLICT', 'Invoice number 7 is already used.', undefined, [fix]), 't');
    expect(dup.status).toBe(409);
    expect((await dup.json()).fixes).toEqual([fix]);
  });
});

describe('client: ApiError.fixes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses fixes from a failed response and drops malformed ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: 'Debits are $40.00 more than credits.',
            code: 'UNBALANCED',
            fixes: [fix, { id: 'x', label: 'bad', kind: 'navigate', href: 'https://evil.example' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const err = await api.post('/api/journal-entries', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.fixes).toEqual([fix]);
    expect(errorFixes(err)).toEqual([fix]);
    expect(errorFixes(new Error('x'))).toEqual([]);
  });

  it('no fixes → empty list; soft warnings get a plain headline', () => {
    expect(new ApiError(400, 'x', 'VALIDATION').fixes).toEqual([]);
    const f = describeError(new ApiError(409, 'Not enough inventory (Widget …)', 'NEGATIVE_STOCK'));
    expect(f.title).toBe('Not enough inventory');
    expect(describeError(new ApiError(409, 'Credit limit exceeded', 'CREDIT_LIMIT')).title).toBe('Over the customer’s credit limit');
  });
});
