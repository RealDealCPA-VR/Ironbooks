// Everyday transaction forms, driven in a real browser window (test/everydayForms.dom.test.ts):
//  - Create Invoices: a new invoice date moves a due date worked out from the terms (also on an
//    edit); an Item typed that is not on the Item List is refused instead of saving a line with
//    no item (which posted to the default income account);
//  - Enter Bills / Make Deposits: the blank line Enter adds on the last line is left out instead
//    of blocking the save;
//  - Credit memos: Class and Customer:Job are on the form and sent; a Subtotal item saves;
//  - Sales receipts: a Subtotal item saves.
import * as React from 'react';
import InvoicesPage from '@/app/invoices/page';
import BillsPage from '@/app/bills/page';
import DepositsPage from '@/app/deposits/page';
import CreditMemosPage from '@/app/credit-memos/page';
import SalesReceiptsPage from '@/app/sales-receipts/page';
import { Toaster } from '@/components/ui';
import { $, button, check, click, domTest, equal, mount, press, runDomTests, settle, stubFetch, textOf, unmount, until, type FetchCall } from './kit';
import { atLocalTime } from './clock';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = id(1);
const JOB = id(2);
const ITEM = id(3);
const SUBTOTAL = id(4);
const CLASS_A = id(5);
const CLASS_B = id(6);
const INV = id(7);
const BILL = id(8);
const VENDOR = id(9);
const BANK = id(10);
const RENT = id(11);
const EQUITY = id(12);
const DEP = id(13);
const CM = id(14);
const SR = id(15);

const sent = (calls: FetchCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const body = (c: FetchCall | undefined) => (c?.body ?? {}) as Record<string, unknown>;

/** Set a field's value the way typing / picking does (React's onChange runs). */
async function setField(el: Element | null, value: string, what: string) {
  check(el, `missing ${what}`);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

const field = (label: string) => $<HTMLInputElement>(`[aria-label="${label}"]`);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

/** Terms list lookups (GET /api/terms/compute): Net 30 = the date + 30 days. */
function termsCompute(call: FetchCall) {
  const q = new URLSearchParams(call.path.split('?')[1] ?? '');
  const d = new Date(`${q.get('date')}T12:00:00`);
  d.setDate(d.getDate() + 30);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { dueDate: iso };
}

const items = [
  { id: ITEM, name: 'Consulting', type: 'service', salesPrice: '100', taxable: false, isActive: true },
  { id: SUBTOTAL, name: 'Subtotal', type: 'subtotal', salesPrice: null, taxable: false, isActive: true },
];
const customers = [{ id: CUST, displayName: 'Acme', isActive: true }];
const jobs = [{ id: JOB, name: 'Kitchen', customerId: CUST }];
const classes = [
  { id: CLASS_A, name: 'East', isActive: true },
  { id: CLASS_B, name: 'West', isActive: true },
];

// ---------------------------------------------------------------------------
// Create Invoices
// ---------------------------------------------------------------------------

domTest('Invoice: a new date moves the terms due date; an Item not on the list is refused', async () => {
  await atLocalTime([2026, 11, 16], async () => {
    const invoice = {
      id: INV,
      invoiceNumber: 1001,
      refNumber: '1001',
      customerId: CUST,
      date: '2026-11-16T00:00:00.000Z',
      dueDate: '2026-12-16T00:00:00.000Z',
      terms: 'Net 30',
      total: '100.00',
      balanceDue: '100.00',
      status: 'open',
    };
    const calls = stubFetch({
      'GET /api/invoices': [invoice],
      [`GET /api/invoices/${INV}`]: {
        ...invoice,
        taxRateId: null,
        classId: null,
        discount: '0',
        discountType: null,
        currency: null,
        exchangeRate: null,
        memo: null,
        customFields: null,
        lines: [
          {
            id: id(100),
            itemId: ITEM,
            itemName: 'Consulting',
            itemType: 'service',
            unitOfMeasure: null,
            description: 'Consulting',
            quantity: '1',
            rate: '100',
            taxable: false,
            jobId: null,
          },
        ],
      },
      [`PATCH /api/invoices/${INV}`]: invoice,
      'GET /api/customers': customers,
      'GET /api/email/status': { configured: false },
      'GET /api/items': { items },
      'GET /api/tax-rates': [],
      'GET /api/classes': [],
      'GET /api/jobs': [],
      'GET /api/terms/compute': termsCompute,
      'GET /api/preferences': { company: {}, my: {} },
    });
    await mount(
      <>
        <InvoicesPage />
        <Toaster />
      </>,
    );
    await click(await until(() => button(/Edit/, document.querySelector('table') ?? document), 'the row Edit button'), 'Edit invoice');
    await until(() => textOf().includes('Edit Invoice #1001'), 'the invoice opens');
    const due = () => $<HTMLInputElement>('#inv-due')!.value;
    equal(due(), '2026-12-16', 'the saved due date');
    await settle(200); // the saved due date is checked against the terms

    // October invoice entered in November: Net 30 from 10/31.
    await setField($('#inv-date'), '2026-10-31', 'the invoice date');
    await until(() => due() === '2026-11-30', `the due date follows the new date (got ${due()})`);

    // A due date typed by hand stays when the date changes again.
    await setField($('#inv-due'), '2026-12-24', 'the due date');
    await setField($('#inv-date'), '2026-10-30', 'the invoice date');
    await settle(200);
    equal(due(), '2026-12-24', 'a typed due date is kept');
    await setField($('#inv-due'), '2026-11-30', 'the due date');
    await setField($('#inv-date'), '2026-10-31', 'the invoice date');

    // A typo in the Item box: refused, nothing saved.
    await setField(field('Line 1 item'), 'Consultng', 'the line item');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    await until(
      () => textOf().includes("Item 'Consultng' isn't on the Item List. Pick it from the list or clear the Item box."),
      'the unknown item is refused',
    );
    equal(sent(calls, 'PATCH', `/api/invoices/${INV}`).length, 0, 'nothing is saved');

    // Picked from the list: saved with the item, the moved date and the due date.
    await setField(field('Line 1 item'), 'Consulting', 'the line item');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    const patch = await until(() => sent(calls, 'PATCH', `/api/invoices/${INV}`)[0], 'the invoice is saved');
    const b = body(patch);
    equal(b.date, '2026-10-31', 'date sent');
    equal(b.dueDate, '2026-11-30', 'due date sent');
    equal((b.lines as Array<{ itemId: string }>)[0].itemId, ITEM, 'the line keeps its item');
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Enter Bills
// ---------------------------------------------------------------------------

domTest('Bill: Enter on the last line adds a blank line, and the bill still saves without it', async () => {
  await atLocalTime([2026, 11, 16], async () => {
    const bill = {
      id: BILL,
      vendorId: VENDOR,
      billNumber: 'B-1',
      date: '2026-11-10T00:00:00.000Z',
      dueDate: null,
      total: '1200.00',
      amountPaid: '0',
      amountCredited: '0',
      balanceDue: '1200.00',
      status: 'open',
      memo: null,
      terms: null,
      classId: null,
    };
    const calls = stubFetch({
      'GET /api/bills': [bill],
      [`GET /api/bills/${BILL}`]: {
        ...bill,
        lines: [{ id: id(200), accountId: RENT, itemId: null, description: 'November rent', quantity: '1', amount: '1200.00', classId: null, customerId: null, jobId: null }],
      },
      [`PATCH /api/bills/${BILL}`]: bill,
      'GET /api/vendors': [{ id: VENDOR, displayName: 'Landlord LLC', isActive: true }],
      'GET /api/accounts': [
        { id: BANK, code: '1000', name: 'Checking', type: 'asset', subtype: 'checking', isActive: true },
        { id: RENT, code: '6100', name: 'Rent', type: 'expense', subtype: 'operating_expenses', isActive: true },
      ],
      'GET /api/items': { items: [] },
      'GET /api/classes': [],
      'GET /api/preferences': { company: {}, my: {} },
    });
    await mount(
      <>
        <BillsPage />
        <Toaster />
      </>,
    );
    await click(await until(() => document.querySelector('[title="Edit this bill (re-posts the GL entry)"]'), 'the row Edit button'), 'Edit bill');
    await until(() => textOf().includes('Edit Bill'), 'the bill opens');
    await settle(150);
    const amount = field('Line 1 amount');
    check(amount, 'line 1 amount');
    amount.focus();
    await press('Enter');
    await until(() => field('Line 2 amount'), 'Enter adds line 2');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    const patch = await until(() => sent(calls, 'PATCH', `/api/bills/${BILL}`)[0], 'the bill is saved');
    check(!textOf().includes('Line 2 amount'), 'no message about the blank line');
    equal((body(patch).lines as unknown[]).length, 1, 'the blank line is not sent');
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Make Deposits
// ---------------------------------------------------------------------------

domTest('Deposit: a blank additional line is left out instead of blocking the save', async () => {
  await atLocalTime([2026, 11, 16], async () => {
    const dep = {
      id: DEP,
      depositAccountId: BANK,
      accountName: 'Checking',
      accountCode: '1000',
      date: '2026-11-12',
      total: '500.00',
      memo: null,
      voidedAt: null,
      createdAt: '2026-11-12T00:00:00.000Z',
      lines: [{ id: id(300), depositId: DEP, paymentId: null, description: 'Owner money', amount: '500.00', accountId: EQUITY }],
    };
    const calls = stubFetch({
      'GET /api/deposits': [dep],
      [`GET /api/deposits/${DEP}`]: dep,
      [`PATCH /api/deposits/${DEP}`]: dep,
      'GET /api/deposits/undeposited': [],
      'GET /api/accounts': [
        { id: BANK, code: '1000', name: 'Checking', type: 'asset', subtype: 'checking', isActive: true },
        { id: EQUITY, code: '3000', name: "Owner's Equity", type: 'equity', subtype: 'owners_equity', isActive: true },
      ],
      'GET /api/preferences': { company: {}, my: {} },
    });
    await mount(
      <>
        <DepositsPage />
        <Toaster />
      </>,
    );
    await click(await until(() => button(/Edit/, document.querySelector('table') ?? document), 'the row Edit button'), 'Edit deposit');
    await until(() => field('Extra line 1 amount'), 'the deposit opens with its line');
    await settle(150);
    field('Extra line 1 amount')!.focus();
    await press('Enter');
    await until(() => field('Extra line 2 amount'), 'Enter adds line 2');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    const patch = await until(() => sent(calls, 'PATCH', `/api/deposits/${DEP}`)[0], 'the deposit is saved');
    equal((body(patch).extraLines as unknown[]).length, 1, 'the blank line is not sent');
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Credit memos
// ---------------------------------------------------------------------------

domTest('Credit memo: Class and Customer:Job load and are sent; a Subtotal item saves', async () => {
  await atLocalTime([2026, 11, 16], async () => {
    const memo = {
      id: CM,
      memoNumber: 5,
      refNumber: 'CM-5',
      customerId: CUST,
      date: '2026-11-14T00:00:00.000Z',
      status: 'open',
      total: '100.00',
      unapplied: '100.00',
      refundedAmount: '0',
      memo: null,
    };
    const calls = stubFetch({
      'GET /api/credit-memos': [memo],
      [`GET /api/credit-memos/${CM}`]: {
        ...memo,
        taxRateId: null,
        classId: CLASS_A,
        jobId: JOB,
        lines: [{ itemId: ITEM, description: 'Consulting', quantity: '1', rate: '100', taxable: false, classId: CLASS_A, jobId: JOB, restock: true }],
        applications: [],
      },
      [`PATCH /api/credit-memos/${CM}`]: memo,
      'GET /api/customers': customers,
      'GET /api/accounts': [],
      'GET /api/items': { items },
      'GET /api/tax-rates': [],
      'GET /api/classes': classes,
      'GET /api/jobs': jobs,
      'GET /api/preferences': { company: { classTrackingEnabled: true }, my: {} },
    });
    await mount(
      <>
        <CreditMemosPage />
        <Toaster />
      </>,
    );
    await click(await until(() => document.querySelector('[aria-label="Edit credit memo"]'), 'the row Edit button'), 'Edit credit memo');
    await until(() => textOf().includes('Edit Credit Memo #CM-5'), 'the memo opens');
    await until(() => $<HTMLSelectElement>('#cm-class')?.value === CLASS_A, 'the saved class shows');
    await until(() => ($<HTMLInputElement>('#cm-customer')?.value ?? '').includes('Acme:Kitchen'), 'the saved Customer:Job shows');

    await setField($('#cm-class'), CLASS_B, 'the class');
    // A second line with the Subtotal item (no quantity or price of its own).
    await click(button('Add line', dialog() ?? document), 'Add line');
    await setField(field('Line 2 item'), SUBTOTAL, 'line 2 item');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    const patch = await until(() => sent(calls, 'PATCH', `/api/credit-memos/${CM}`)[0], 'the memo is saved (the Subtotal line did not block it)');
    const b = body(patch);
    equal(b.classId, CLASS_B, 'class sent');
    equal(b.jobId, JOB, 'Customer:Job sent');
    const lines = b.lines as Array<Record<string, unknown>>;
    equal(lines.length, 2, 'both lines');
    equal(lines[0].classId, undefined, 'the line on the memo class follows the header');
    equal(lines[1].itemId, SUBTOTAL, 'the subtotal line');
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Sales receipts
// ---------------------------------------------------------------------------

domTest('Sales receipt: a Subtotal item saves (it has no price)', async () => {
  await atLocalTime([2026, 11, 16], async () => {
    const receipt = {
      id: SR,
      receiptNumber: 9,
      refNumber: 'SR-9',
      customerId: CUST,
      date: '2026-11-14T00:00:00.000Z',
      paymentMethod: 'cash',
      depositAccountId: null,
      reference: null,
      taxRateId: null,
      classId: null,
      memo: null,
      subtotal: '100.00',
      taxAmount: '0.00',
      total: '100.00',
      status: 'paid',
    };
    const calls = stubFetch({
      'GET /api/sales-receipts': [receipt],
      [`GET /api/sales-receipts/${SR}`]: {
        ...receipt,
        lines: [{ itemId: ITEM, description: 'Consulting', quantity: '1', rate: '100', taxable: false }],
      },
      [`PATCH /api/sales-receipts/${SR}`]: receipt,
      'GET /api/customers': customers,
      'GET /api/items': { items },
      'GET /api/accounts': [],
      'GET /api/tax-rates': [],
      'GET /api/preferences': { company: {}, my: {} },
    });
    await mount(
      <>
        <SalesReceiptsPage />
        <Toaster />
      </>,
    );
    await click(await until(() => document.querySelector('[aria-label="Edit sales receipt"]'), 'the row Edit button'), 'Edit sales receipt');
    await until(() => textOf().includes('Edit Sales Receipt #SR-9'), 'the receipt opens');
    await settle(150);
    await click(button('Add line', dialog() ?? document), 'Add line');
    const itemSelect = await until(
      () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] [data-grid-row]'))[1]?.querySelector('select'),
      'line 2 item',
    );
    await setField(itemSelect, SUBTOTAL, 'line 2 item');
    await click(button('Save & Close', dialog() ?? document), 'Save & Close');
    const patch = await until(() => sent(calls, 'PATCH', `/api/sales-receipts/${SR}`)[0], 'the receipt is saved (the Subtotal line did not block it)');
    const lines = body(patch).lines as Array<Record<string, unknown>>;
    equal(lines.length, 2, 'both lines');
    equal(lines[1].itemId, SUBTOTAL, 'the subtotal line');
    await unmount();
  });
});

runDomTests();
