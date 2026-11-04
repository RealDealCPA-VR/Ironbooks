// salesar: estimates, sales orders and purchase orders can be voided or deleted from the open form
// (Ctrl+D presses its Delete, QB's confirmation first) and from their row; estimates, sales orders
// and vendor credits can be memorized (Ctrl+M).
import * as React from 'react';
import EstimatesPage from '@/app/estimates/page';
import SalesOrdersPage from '@/app/sales-orders/page';
import PurchaseOrdersPage from '@/app/purchase-orders/page';
import VendorCreditsPage from '@/app/vendor-credits/page';
import KeyboardCommands from '@/components/KeyboardCommands';
import { Toaster } from '@/components/ui';
import { button, check, click, domTest, equal, mount, press, runDomTests, settle, stubFetch, textOf, until, unmount, type FetchCall } from './kit';

const sent = (calls: FetchCall[], method: string) => calls.filter((c) => c.method === method && !c.path.startsWith('/api/undo'));
const ASK_DELETE = 'Are you sure you want to delete this transaction?';
const ASK_VOID = 'Are you sure you want to void this transaction?';
const customers = [{ id: 'c1', displayName: 'Acme', isActive: true }];

const estimate = {
  id: 'e1',
  estimateNumber: 1001,
  refNumber: '1001',
  customerId: 'c1',
  date: '2026-03-01T00:00:00.000Z',
  expirationDate: null,
  taxRateId: null,
  memo: null,
  subtotal: '100.00',
  taxAmount: '0.00',
  total: '100.00',
  amountInvoiced: '0.00',
  status: 'accepted',
  convertedInvoiceId: null,
  customerMessageId: null,
};
const estimateDetail = {
  ...estimate,
  lines: [{ id: 'el1', itemId: null, description: 'Design', quantity: '1', rate: '100', amount: '100.00', taxable: false, classId: null, salesTaxCodeId: null }],
};

domTest('Estimate: Ctrl+D in the open form asks first and deletes; the row offers Void; Ctrl+M memorizes', async () => {
  let gone = false;
  const calls = stubFetch({
    'GET /api/estimates': () => (gone ? [] : [estimate]),
    'GET /api/estimates/e1': estimateDetail,
    'GET /api/customers': customers,
    'DELETE /api/estimates/e1': () => {
      gone = true;
      return { id: 'e1', deleted: true };
    },
    'POST /api/estimates/e1': { ...estimate, status: 'void' },
  });
  await mount(
    <>
      <EstimatesPage />
      <KeyboardCommands />
    </>,
  );
  await until(() => textOf().includes('1001'), 'the estimate is listed');
  check(button(/Void$/), 'the row offers Void');
  await click(await until(() => button('Edit estimate'), 'the row Edit button'), 'Edit estimate');
  await until(() => textOf().includes('Edit Estimate #'), 'the estimate form opens');
  await settle(150);

  // Ctrl+M: the Memorize Transaction window, with the form's contents.
  await press('m', { ctrl: true });
  await until(() => textOf().includes('Memorize Transaction'), 'Ctrl+M opens Memorize Transaction');
  await click(button('Cancel', document.querySelectorAll('[role="dialog"]')[1] ?? document), 'Cancel memorize');
  await until(() => !textOf().includes('Memorize Transaction'), 'the memorize window closes');

  await press('d', { ctrl: true });
  await until(() => textOf().includes(ASK_DELETE), 'Ctrl+D asks QB’s delete question');
  equal(sent(calls, 'DELETE').length, 0, 'nothing is deleted while the question is open');
  const dialogs = document.querySelectorAll('[role="dialog"]');
  await click(button('Delete', dialogs[dialogs.length - 1]), 'the confirmation’s Delete');
  await until(() => sent(calls, 'DELETE').length === 1, 'one DELETE is sent');
  equal(sent(calls, 'DELETE')[0].path, '/api/estimates/e1', 'the estimate is deleted');
  await until(() => !textOf().includes('Edit Estimate #'), 'the form closes after the delete');
  await unmount();
});

const order = {
  id: 's1',
  orderNumber: 7,
  refNumber: 'SO-7',
  customerId: 'c1',
  date: '2026-03-02T00:00:00.000Z',
  total: '50.00',
  taxRateId: null,
  status: 'open',
  convertedInvoiceId: null,
  customerMessageId: null,
};

domTest('Sales order: the form’s Void asks first and voids through the status route; Ctrl+M memorizes', async () => {
  const calls = stubFetch({
    'GET /api/sales-orders': [order],
    'GET /api/sales-orders/s1': {
      ...order,
      lines: [{ id: 'sl1', itemId: null, description: 'Widgets', quantity: '5', rate: '10', amount: '50.00', taxable: false, quantityInvoiced: '0', salesTaxCodeId: null }],
    },
    'GET /api/customers': customers,
    'POST /api/sales-orders/s1': { ...order, status: 'void' },
  });
  await mount(
    <>
      <SalesOrdersPage />
      <KeyboardCommands />
    </>,
  );
  await click(await until(() => button('Edit sales order'), 'the row Edit button'), 'Edit sales order');
  await until(() => textOf().includes('Edit Sales Order #'), 'the order form opens');
  await settle(150);
  await press('m', { ctrl: true });
  await until(() => textOf().includes('Memorize Transaction'), 'Ctrl+M opens Memorize Transaction');
  await click(button('Cancel', document.querySelectorAll('[role="dialog"]')[1] ?? document), 'Cancel memorize');
  await until(() => !textOf().includes('Memorize Transaction'), 'the memorize window closes');

  const form = document.querySelector('[role="dialog"]')!;
  await click(button(/^Void$/, form), 'the form’s Void');
  await until(() => textOf().includes(ASK_VOID), 'Void asks QB’s void question');
  equal(sent(calls, 'POST').length, 0, 'nothing is voided while the question is open');
  const dialogs = document.querySelectorAll('[role="dialog"]');
  await click(button('Void', dialogs[dialogs.length - 1]), 'the confirmation’s Void');
  await until(() => sent(calls, 'POST').length === 1, 'one void is sent');
  equal(JSON.stringify(sent(calls, 'POST')[0].body), JSON.stringify({ action: 'status', status: 'void' }), 'voided through the status action');
  await unmount();
});

domTest('Purchase order: a PO closed by hand with nothing billed offers Void and Delete; Delete asks first', async () => {
  const po = {
    id: 'p1',
    poNumber: 3,
    refNumber: 'PO-3',
    vendorId: 'v1',
    date: '2026-03-03T00:00:00.000Z',
    expectedDate: null,
    total: '40.00',
    status: 'closed',
    convertedBillId: null,
    memo: null,
  };
  let gone = false;
  const calls = stubFetch({
    'GET /api/purchase-orders': () => (gone ? [] : [po]),
    'GET /api/vendors': [{ id: 'v1', displayName: 'Supplier' }],
    'GET /api/accounts': [],
    'GET /api/items': { items: [] },
    'DELETE /api/purchase-orders/p1': () => {
      gone = true;
      return { id: 'p1', deleted: true };
    },
  });
  await mount(<PurchaseOrdersPage />);
  await until(() => textOf().includes('PO-3'), 'the PO is listed');
  check(button(/Void$/), 'the closed, unbilled PO offers Void');
  await click(await until(() => button(/Delete$/), 'the row Delete button'), 'Delete');
  await until(() => textOf().includes(ASK_DELETE), 'Delete asks QB’s delete question');
  const dialogs = document.querySelectorAll('[role="dialog"]');
  await click(button('Delete', dialogs[dialogs.length - 1]), 'the confirmation’s Delete');
  await until(() => sent(calls, 'DELETE').length === 1, 'one DELETE is sent');
  equal(sent(calls, 'DELETE')[0].path, '/api/purchase-orders/p1', 'the PO is deleted');
  await unmount();
});

domTest('Vendor credit: the form has Memorize (Ctrl+M asks for a vendor first)', async () => {
  stubFetch({ 'GET /api/vendor-credits': [], 'GET /api/vendors': [{ id: 'v1', displayName: 'Supplier' }] });
  await mount(
    <>
      <VendorCreditsPage />
      <Toaster />
    </>,
  );
  await click(await until(() => button(/New Vendor Credit|New Credit/), 'the New credit button'), 'New credit');
  await until(() => textOf().includes('New Vendor Credit'), 'the credit form opens');
  check(button(/Memorize/, document.querySelector('[role="dialog"]')!), 'the form has a Memorize button');
  await press('m', { ctrl: true });
  await until(() => textOf().includes('Pick a vendor before memorizing.'), 'Ctrl+M runs the form’s Memorize');
  await unmount();
});

void runDomTests();
