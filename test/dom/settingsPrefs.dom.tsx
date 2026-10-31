// Preferences > Sales & Customers: "Next Invoice Number" is what the numbering service
// (GET /api/doc-numbers?docType=invoice) will hand out, never a guess made by downloading every
// invoice (the old "#<largest integer + 1>", which said "#100" after INV-0099).
import * as React from 'react';
import SettingsPage from '@/app/settings/page';
import { $$, button, check, click, domTest, equal, mount, reply, runDomTests, settle, stubFetch, until, type FetchCall } from './kit';

/** Every route the Preferences page loads; the invoice list is there to be (not) downloaded. */
function routes(nextNumber: unknown) {
  return {
    'GET /api/company': { id: 'co1', name: 'Acme Plumbing', settings: {} },
    'GET /api/custom-fields': {},
    'GET /api/company/closing-date': { closingDate: null, hasPassword: false },
    'GET /api/users': [],
    'GET /api/accounts': [],
    'GET /api/preferences': { company: {}, my: {} },
    'GET /api/doc-numbers?docType=invoice': nextNumber,
    'GET /api/invoices': [
      { id: 'i1', invoiceNumber: 'INV-0098' },
      { id: 'i2', invoiceNumber: 'INV-0099' },
    ],
  };
}

async function openSalesPane() {
  await mount(<SettingsPage />);
  const tab = await until(() => button('Sales & Customers'), 'the Preferences tabs (the page finished loading)', 4000);
  await click(tab, 'the Sales & Customers tab');
}

/** The read-only "Next Invoice Number" box. */
function nextInvoiceBox(): HTMLInputElement | null {
  const label = $$('label').find((l) => l.textContent?.trim() === 'Next Invoice Number');
  return label?.parentElement?.querySelector<HTMLInputElement>('input') ?? null;
}

const invoiceListCalls = (calls: FetchCall[]) => calls.filter((c) => c.path.startsWith('/api/invoices'));

domTest('shows the number the numbering service hands out next (INV-0100 after INV-0099)', async () => {
  const calls = stubFetch(routes({ nextNumber: 'INV-0100' }));
  await openSalesPane();
  const box = await until(() => (nextInvoiceBox()?.value === 'INV-0100' ? nextInvoiceBox() : null), `Next Invoice Number to read INV-0100 (it reads ${JSON.stringify(nextInvoiceBox()?.value)})`);
  check(box.readOnly && box.disabled, 'the number is assigned automatically (read-only)');
  equal(calls.filter((c) => c.method === 'GET' && c.path === '/api/doc-numbers?docType=invoice').length, 1, 'the numbering service is asked once');
  equal(invoiceListCalls(calls).length, 0, 'the invoice list is never downloaded');
});

domTest('a starting number set in Document Numbers is shown as is, whatever the invoices say', async () => {
  // The invoices go up to INV-0099, but Document Numbers starts the next one at INV-2000.
  const calls = stubFetch(routes({ nextNumber: 'INV-2000' }));
  await openSalesPane();
  await until(() => nextInvoiceBox()?.value === 'INV-2000', `Next Invoice Number to read INV-2000 (it reads ${JSON.stringify(nextInvoiceBox()?.value)})`);
  equal(invoiceListCalls(calls).length, 0, 'the invoice list is never downloaded');
});

domTest('when the numbering service cannot answer, the box says N/A rather than guessing', async () => {
  const calls = stubFetch(routes(reply(500, { error: 'down' })));
  await openSalesPane();
  await until(() => calls.some((c) => c.path === '/api/doc-numbers?docType=invoice'), 'the numbering service to be asked');
  await until(() => nextInvoiceBox(), 'the Next Invoice Number box');
  await settle(150); // the failed answer has been handled
  equal(nextInvoiceBox()!.value, 'N/A', 'no number is made up');
  equal(invoiceListCalls(calls).length, 0, 'the invoice list is not downloaded as a fallback');
});

void runDomTests();
