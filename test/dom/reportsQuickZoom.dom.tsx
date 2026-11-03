// QuickZoom from a report line to a bill payment (/pay-bills?open=<id>): the payment opens in the
// Edit Bill Payment window with its own vendor loaded, so Save sends that vendor (it sent '' and
// the server refused it). A payment that took an early-payment discount can't be edited here: it
// opens read-only with that explanation instead of an error toast that opened nothing.
import * as React from 'react';
import PayBillsPage from '@/app/pay-bills/page';
import { Toaster } from '@/components/ui';
import { $, $$, button, check, click, domTest, equal, mount, runDomTests, stubFetch, textOf, until, type FetchAnswer } from './kit';

const PAY = '11111111-1111-4111-8111-111111111111';
const VENDOR = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
const BANK = '44444444-4444-4444-8444-444444444444';

function payment(extra: Record<string, unknown> = {}) {
  return {
    id: PAY,
    vendorId: VENDOR,
    date: '2026-03-10T00:00:00.000Z',
    method: 'check',
    reference: '1042',
    amount: '75.00',
    paymentAccountId: BANK,
    toPrint: false,
    voidedAt: null,
    currency: null,
    exchangeRate: null,
    applications: [{ billId: BILL, amountApplied: '75.00' }],
    journalApplications: [],
    discountTotal: '0.00',
    ...extra,
  };
}

function routes(detail: unknown): Record<string, FetchAnswer> {
  return {
    'GET /api/vendors': [{ id: VENDOR, displayName: 'Parts Inc' }],
    'GET /api/accounts': [{ id: BANK, code: '1000', name: 'Checking', type: 'asset', subtype: 'bank' }],
    'GET /api/preferences': { company: {}, my: {} },
    [`GET /api/bill-payments/${PAY}`]: detail,
    [`GET /api/bills/${BILL}`]: { billNumber: 'B-7', balanceDue: '0.00' },
    'GET /api/bills/to-pay': { bills: [] },
    'GET /api/vendor-credits': [],
    'GET /api/bill-payments': { payments: [] },
    'GET /api/bill-payments/journal-items': { charges: [], credits: [] },
    [`PATCH /api/bill-payments/${PAY}`]: { id: PAY },
  };
}

const dialog = () => $$('[role="dialog"]').find((d) => textOf(d).includes('Bill Payment')) ?? null;

domTest('a bill payment opened from a report is saved with its own vendor', async () => {
  window.history.replaceState(null, '', `?open=${PAY}`);
  const calls = stubFetch(routes(payment()));
  await mount(
    <>
      <PayBillsPage />
      <Toaster />
    </>,
  );
  const dlg = await until(dialog, 'the Edit Bill Payment window opens');
  check(textOf(dlg).includes('Bill B-7'), `the bill it paid is listed: ${textOf(dlg)}`);
  // The page shows that payment's vendor (its bills, credits and payments are loaded).
  await until(() => calls.some((c) => c.method === 'GET' && c.path.startsWith(`/api/bills/to-pay?vendorId=${VENDOR}`)), "the vendor's bills load");
  equal(($('#pb-vendor') as HTMLSelectElement | null)?.value, VENDOR, 'the vendor picker shows the payment’s vendor');

  await click(button('Save Changes', dlg), 'Save Changes');
  const patch = await until(() => calls.find((c) => c.method === 'PATCH'), 'the payment is saved');
  equal((patch.body as { vendorId?: string }).vendorId, VENDOR, 'Save sends the payment’s vendor');
  check(!$$('[role="status"], [role="alert"]').some((t) => /failed|invalid/i.test(textOf(t))), 'no error is shown');
});

domTest('a payment that took an early-payment discount opens read-only with the reason', async () => {
  window.history.replaceState(null, '', `?open=${PAY}`);
  const calls = stubFetch(routes(payment({ discountTotal: '1.50' })));
  await mount(
    <>
      <PayBillsPage />
      <Toaster />
    </>,
  );
  const dlg = await until(dialog, 'the payment opens');
  check(/early-payment discount/i.test(textOf(dlg)), `it says why it can't be changed: ${textOf(dlg)}`);
  check(textOf(dlg).includes('Bill B-7'), 'the bill it paid is listed');
  check(!button('Save Changes', dlg), 'there is nothing to save');
  check($$('input', dlg).every((i) => (i as HTMLInputElement).disabled || (i as HTMLInputElement).readOnly), 'the fields are read-only');
  check(!calls.some((c) => c.method === 'PATCH'), 'nothing was sent');
});

runDomTests();
