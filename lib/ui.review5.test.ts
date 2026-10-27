/**
 * Review round 5 (team uia): client-side defects in the transaction forms, centers and registers.
 *
 *  - Amount fields (components/ui.tsx AmountInput → lib/shortcuts.ts committedAmountText):
 *    QuickMath was float math ("8.03*1.5" kept 12.04, the server rounds 12.045 to 12.05), and an
 *    amount typed as "1,250.00" stayed in the field: the forms add with Number() (NaN), so a
 *    payment applied as "1,250.00" was silently dropped and the API refuses commas.
 *  - Invoice form totals (lib/invoiceLineMath.ts invoiceFormTotals): header discount, tax, total,
 *    retainage and billables shown in floats — a 15% discount of $10.10 showed $1.51 and saved
 *    $1.52; the Balance Due ignored retainage. With retainage and a payment line, "Due now" showed
 *    the balance net of the payment, then took the payment off again (it is total − retainage).
 *  - Enter Bills / Create Purchase Orders / Create Item Receipts / Receive & Bill
 *    (lib/purchaseLineMath.ts): float qty × cost with no per-line rounding — 3 × 1.335 showed
 *    $4.00 where the bill saves $4.01. lib/services/formTotals.review5.test.ts saves the same
 *    documents through the services and compares.
 *  - Invoice billables: a cleared markup field sent no markup, so the server applied the
 *    Preferences default markup the user had removed.
 *  - Sales receipts / credit memos / estimates / sales orders (lib/salesLineMath.ts): lines and
 *    tax unrounded (1.5 × 4.35 showed 6.52, saved 6.53).
 *  - lib/client.ts: a non-JSON answer (proxy / crash page) surfaced as "Unexpected token '<'".
 *  - Register entry row: Enter saved the account picked BEFORE the field was retyped.
 *  - Register page: the grid (and the entry row) unmounted on every reload; the row hid while the
 *    search box was being typed into.
 *  - Pay Bills: a new payment date or filter cleared every ticked bill; a journal-credit-only
 *    application could not be saved.
 *  - Make Deposits: editing a foreign-currency deposit hid its own payments; "Deposit To" listed
 *    A/R, inventory and fixed assets (a deposit already saved to such an account keeps it listed).
 *  - Enter Bill for Received Items: a late preview answer replaced the current one
 *    (lib/latestRequest.ts). Assess Finance Charges: assessed for the date typed after the
 *    preview (app/finance-charges/assessDate.ts).
 *  - lib/client.ts keeps the version a record was loaded at across unversioned actions (apply /
 *    refund / unapply), so another user's change in between still gets the 409.
 *  - Reconcile: Finish enabled (and shown green) at a 0.01 difference the server refuses; a line
 *    clicked again before its answer ended unticked while the server had it cleared.
 *  - Statement import review: balances typed "2500" tied out on screen but the import refused them;
 *    "1,234.56" counted as missing; removing a row kept "Import anyway"; the review imported into
 *    whatever account was picked after the file was read.
 *  - Previous / Next: check 1000 came before check 999 on the same day.
 *  - Invoices list: no Edit on a partly or fully paid invoice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { committedAmountText, evaluateAmountExpression, formatAmountResult } from './shortcuts';
import { billableCostTotal, invoiceFormTotals, type LiveLineInput } from './invoiceLineMath';
import { previewSalesTotals } from './salesLineMath';
import { billItemLineAmount, poLineAmount, sumLineAmounts, typedLineAmount } from './purchaseLineMath';
import { api, ApiError, UNREADABLE_RESPONSE_MESSAGE } from './client';
import { choiceForTypedText, type TypeaheadChoice } from './typeahead';
import { carryAmounts, carryRows, payBillsHasWork, sumApplied } from './paymentApply';
import { amountMessage } from './fieldValidation';
import { tieOut } from './statements/parse';
import { registerBody, showEntryRow } from '../app/registers/[accountId]/registerView';
import { depositToAccounts, depositToEdit, type Deposit } from './depositEdit';
import { applyClearedAnswer } from '../app/reconcile/reconcileMath';
import { canFinishReconciliation } from './reconcileRules';
import { canEditInvoice } from '../app/invoices/listActions';
import { transferAccounts } from '../app/transfers/transferAccounts';
import { creditItems, rowsOf } from '../app/vendor-credits/lists';
import { checkNumberSeries, nextCheckNumber } from '../app/print-checks/checkNumbers';
import { emptyPayForm } from '../app/pay-liabilities/payForm';
import { docNumberPayload } from '../components/sales/DocNumberField';
import { estimateLineNumbers } from '../app/estimates/estimateLines';
import { runFix } from './errorFixFlow';
import { createLatestGate } from './latestRequest';
import { assessBody, previewForDate } from '../app/finance-charges/assessDate';
import type { ErrorFix } from './errorFixes';
import { invFromLine } from '../components/inventory/AdvancedInventory';
import { compareDocNumbers } from '../components/TransactionNav';
import { importableRows, reviewedPayload, statementAmount } from '../components/StatementReview';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Amount fields
// ---------------------------------------------------------------------------

describe('AmountInput commit (lib/shortcuts.ts committedAmountText)', () => {
  it('QuickMath rounds the exact result half-up to cents, like the server', () => {
    // 8.03 × 1.5 = 12.045 exactly; the float product is 12.04499… and the old field kept 12.04.
    expect(committedAmountText('8.03*1.5')).toBe('12.05');
    // 20000.01 / 2 = 10000.005; the float quotient 10000.00499… was kept as 10000.
    expect(committedAmountText('20000.01/2')).toBe('10000.01');
    // Float evaluation loses the half cent before any rounding sees it (12.04499…):
    expect(formatAmountResult(8.03 * 1.5)).toBe('12.04');
    // Cases the float version already happened to get right stay right.
    expect(committedAmountText('4.35*1.5')).toBe('6.53');
    expect(committedAmountText('20.01/2')).toBe('10.01'); // 10.005
    expect(committedAmountText('0.1+0.2')).toBe('0.3');
    expect(committedAmountText('12.5*3+10')).toBe('47.5');
    expect(committedAmountText('-2.555*1')).toBe('-2.56'); // half-up away from zero (Decimal ROUND_HALF_UP)
    expect(committedAmountText('10/0')).toBeNull(); // invalid: left as typed
    // The numeric API still answers numbers.
    expect(evaluateAmountExpression('12.5*3+10')).toBe(47.5);
    expect(evaluateAmountExpression('(2+3)*4')).toBe(20);
  });

  it('an amount typed with thousands separators or a $ sign becomes the bare number', () => {
    expect(committedAmountText('1,250.00')).toBe('1250.00');
    expect(committedAmountText('$1,250.50')).toBe('1250.50');
    expect(committedAmountText('$ 75')).toBe('75');
    expect(committedAmountText('-1,000')).toBe('-1000');
    expect(committedAmountText(' 12.50 ')).toBe('12.50');
    // Nothing to change / not an amount: left for validation.
    expect(committedAmountText('12.50')).toBeNull();
    expect(committedAmountText('')).toBeNull();
    expect(committedAmountText('12,50')).toBeNull(); // a decimal comma is not a thousands group
    expect(committedAmountText('1,25,000')).toBeNull();
    expect(committedAmountText('abc')).toBeNull();
  });

  it('what the field holds after the commit is what the forms can add up and the API accepts', () => {
    // Inline validation accepts "1,250.00" ...
    expect(amountMessage('1,250.00', { label: 'Amount', required: true })).toBeNull();
    // ... but the Receive Payments page reads it with Number() and drops the application:
    expect(Number('1,250.00') > 0).toBe(false);
    expect(sumApplied({ inv1: '1,250.00' })).toBe('0.00');
    // After the field commits, it is a plain amount.
    const committed = committedAmountText('1,250.00')!;
    expect(Number(committed)).toBe(1250);
    expect(sumApplied({ inv1: committed })).toBe('1250.00');
    expect(/^-?\d+(\.\d{1,2})?$/.test(committed)).toBe(true); // lib/validation zMoney
  });

  it('AmountInput commits through committedAmountText', () => {
    const src = read('components/ui.tsx');
    expect(src).toContain('committedAmountText(raw)');
    expect(src).not.toMatch(/formatAmountResult\(result\)/);
  });
});

// ---------------------------------------------------------------------------
// Invoice form totals
// ---------------------------------------------------------------------------

const inc = (quantity: string, rate: string, taxable = true): LiveLineInput => ({ kind: 'income', quantity, rate, taxable });

describe('invoice form totals (lib/invoiceLineMath.ts invoiceFormTotals)', () => {
  it('a 15% header discount of $10.10 is $1.52, as saved (the float math showed $1.51)', () => {
    const t = invoiceFormTotals({ lines: [inc('1', '10.10', false)], discount: '15', discountType: 'percent', taxRate: '' });
    expect(t.discount.toFixed(2)).toBe('1.52');
    expect(t.total.toFixed(2)).toBe('8.58');
    // The old display: (10.10 * 0.15).toFixed(2)
    expect((10.1 * (15 / 100)).toFixed(2)).toBe('1.51');
  });

  it('tax is round2(taxable base × rate) plus manual tax lines; the total is round2 of the parts', () => {
    const t = invoiceFormTotals({
      lines: [inc('1', '10.10'), inc('1', '5.00', false), { kind: 'sales_tax', quantity: '1', rate: '0.25', taxable: false }],
      discount: '',
      discountType: 'amount',
      taxRate: '0.15',
    });
    expect(t.tax.toFixed(2)).toBe('1.77'); // round2(1.515) + 0.25
    expect(t.total.toFixed(2)).toBe('16.87');
    // The old float tax: 10.10 × 0.15 + 0.25 = 1.7649999… → shown $1.76.
    expect((10.1 * 0.15 + 0.25).toFixed(2)).toBe('1.76');
  });

  it('billables: each cost plus its own rounded markup line, time as round2(hours × rate)', () => {
    expect(billableCostTotal('10.05', '15').toFixed(2)).toBe('11.56'); // 10.05 + round2(1.5075)
    const t = invoiceFormTotals({
      lines: [],
      discount: '',
      discountType: 'amount',
      taxRate: '0.1',
      billables: { costs: [{ amount: '10.05' }, { amount: '10.05' }], time: [{ hours: '1.5', rate: '4.35' }], markupPercent: '15' },
    });
    expect(t.billables.toFixed(2)).toBe('29.65'); // 11.56 + 11.56 + 6.53
    expect(t.tax.toFixed(2)).toBe('0.00'); // billable lines are not taxable
    // The old float preview: 10.05 × 1.15 × 2 + 1.5 × 4.35
    expect((10.05 * 1.15 * 2 + 1.5 * 4.35).toFixed(2)).toBe('29.64');
  });

  it('retainage is round2(total × %) and the balance due is net of retainage and payment lines', () => {
    const t = invoiceFormTotals({
      lines: [inc('1', '1000.05', false), { kind: 'payment', quantity: '1', rate: '100', taxable: false }],
      discount: '',
      discountType: 'amount',
      taxRate: '',
      retainagePercent: '10',
    });
    expect(t.total.toFixed(2)).toBe('1000.05');
    expect(t.retainage.toFixed(2)).toBe('100.01'); // round2(100.005)
    expect(t.balanceDue.toFixed(2)).toBe('800.04'); // the server's dueNow − payments
  });

  it('"Due now" is the total less retainage (the server dueNow); payment lines come off after it', () => {
    // The form showed Due now 800.04, then "Less payments received −100.00", then Balance Due
    // 800.04 — the payment taken off twice on screen. lib/services/invoices.ts: dueNow =
    // round2(total − retainage) = 900.04, balance = dueNow − payments = 800.04.
    const t = invoiceFormTotals({
      lines: [inc('1', '1000.05', false), { kind: 'payment', quantity: '1', rate: '100', taxable: false }],
      discount: '',
      discountType: 'amount',
      taxRate: '',
      retainagePercent: '10',
    });
    expect(t.dueNow.toFixed(2)).toBe('900.04');
    expect(t.dueNow.minus(t.payments).toFixed(2)).toBe(t.balanceDue.toFixed(2));
    // No retainage: due now is the total.
    const plain = invoiceFormTotals({ lines: [inc('2', '10.005', false)], discount: '', discountType: 'amount', taxRate: '' });
    expect(plain.dueNow.toFixed(2)).toBe(plain.total.toFixed(2));
    // The form's "Due now" row shows it (and "Balance Due" the amount net of payment lines).
    const src = read('app/invoices/page.tsx');
    const dueNowRow = /Due now<\/span>[\s\S]{0,200}?formatCurrency\(([^)]*)\)/.exec(src)?.[1] ?? '';
    expect(dueNowRow).toContain('totals.dueNow');
    const balanceRow = /Balance Due<\/span>[\s\S]{0,200}?formatCurrency\(([^)]*)\)/.exec(src)?.[1] ?? '';
    expect(balanceRow).toContain('totals.balanceDue');
  });

  it('the invoice form uses it, and sends the markup shown (a cleared field is 0, not the default)', () => {
    const src = read('app/invoices/page.tsx');
    expect(src).toContain('invoiceFormTotals(');
    expect(src).not.toContain('markupPercent: markupPercent || undefined');
    expect(src).toContain("markupPercent: markupPercent.trim() || '0'");
    // The server applies the Preferences default when the markup is missing:
    expect(read('lib/services/billables.ts')).toContain('selection.markupPercent ?? route.defaultMarkupPercent');
  });
});

describe('sales form previews (lib/salesLineMath.ts previewSalesTotals)', () => {
  it('each line is round2(qty × rate) and the tax round2(base × rate), as the services save', () => {
    const t = previewSalesTotals([{ quantity: '1.5', rate: '4.35', taxable: true }], 0.1);
    expect(t.amounts[0]).toBe(6.53);
    expect(t.subtotal).toBe(6.53);
    expect(t.tax).toBe(0.65); // round2(0.653)
    expect(t.total).toBe(7.18);
  });

  it('three lines of 1 × 1.005 are 3.03 (each line rounds), with a taxable discount and a tax line', () => {
    const t = previewSalesTotals(
      [
        { quantity: '1', rate: '1.005', taxable: true },
        { quantity: '1', rate: '1.005', taxable: true },
        { quantity: '1', rate: '1.005', taxable: true },
        { quantity: '1', rate: '0.505', taxable: true, itemType: 'discount' },
        { quantity: '1', rate: '0.10', taxable: false, itemType: 'sales_tax' },
      ],
      '0.05',
    );
    expect(t.subtotal).toBe(2.52); // 3.03 − 0.51
    expect(t.tax).toBe(0.23); // round2(2.52 × 0.05 = 0.126) + 0.10
    expect(t.total).toBe(2.75);
  });
});

// ---------------------------------------------------------------------------
// Purchase form totals
// ---------------------------------------------------------------------------

describe('bill and purchase order line totals (lib/purchaseLineMath.ts), as the services save them', () => {
  it('a bill item line of 3 × 1.335 is $4.01 and two of them $8.02 (the float math showed 4.00 / 8.01)', () => {
    expect(billItemLineAmount('3', '1.335').toFixed(2)).toBe('4.01'); // lib/services/bills.ts round2(qty × cost)
    expect(sumLineAmounts([billItemLineAmount('3', '1.335'), billItemLineAmount('3', '1.335')]).toFixed(2)).toBe('8.02');
    // The old display: (Number(qty) || 0) * (Number(unitCost) || 0), summed unrounded.
    expect((3 * 1.335).toFixed(2)).toBe('4.00');
    expect((3 * 1.335 + 3 * 1.335).toFixed(2)).toBe('8.01');
    // Blank / partial input while typing.
    expect(billItemLineAmount('', '5').toFixed(2)).toBe('0.00');
    expect(billItemLineAmount('2', 'abc').toFixed(2)).toBe('0.00');
    expect(typedLineAmount('10.005').toFixed(2)).toBe('10.01');
    expect(typedLineAmount('').toFixed(2)).toBe('0.00');
  });

  it('a purchase order line keeps quantity and rate at 4 places, then rounds to cents', () => {
    expect(poLineAmount('3', '1.335').toFixed(2)).toBe('4.01');
    // lib/services/purchaseOrders.ts stores the rate at 4 places first: 1.00004 → 1.0000, so
    // 1000 of them are 1000.00 (not the exact 1000.04).
    expect(poLineAmount('1000', '1.00004').toFixed(2)).toBe('1000.00');
    expect(poLineAmount('', '').toFixed(2)).toBe('0.00');
  });

  it('Enter Bills and Create Purchase Orders show those amounts', () => {
    const bills = read('app/bills/page.tsx');
    expect(bills).toMatch(/billItemLineAmount\(line\.quantity, line\.unitCost\)/);
    expect(bills).not.toMatch(/\(Number\(line\.quantity\) \|\| 0\) \* \(Number\(line\.unitCost\) \|\| 0\)/);
    expect(bills).toMatch(/sumLineAmounts\(/);
    const po = read('app/purchase-orders/page.tsx');
    expect(po).toMatch(/poLineAmount\(line\.quantity, line\.rate\)/);
    expect(po).toMatch(/sumLineAmounts\(/);
    expect(po).not.toMatch(/return qty \* rate;/);
    // Receive & Bill: the bill convertToBill creates, round2(qty × rate) per line.
    expect(po).toMatch(/billItemLineAmount\(qtyInputs\[l\.id\] \?\? '', l\.rate\)/);
    expect(po).not.toMatch(/sum \+ qty \* \(parseFloat\(l\.rate\)/);
    // Create Item Receipts: same rounding (lib/services/itemReceipts.ts round2(qty × unit cost)),
    // and a line that rounds to 0.00 is refused before it is sent.
    const ir = read('app/item-receipts/page.tsx');
    expect(ir).toMatch(/billItemLineAmount\(l\.quantity, l\.unitCost\)/);
    expect(ir).toMatch(/billItemLineAmount\(line\.quantity, line\.unitCost\)/);
    expect(ir).not.toMatch(/\(parseFloat\(l\.quantity\) \|\| 0\) \* \(parseFloat\(l\.unitCost\) \|\| 0\)/);
    expect(billItemLineAmount('1', '0.004').greaterThan(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

describe('lib/client.ts: answers that are not JSON', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a gateway / crash page is an ApiError with a plain message, not "Unexpected token"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })));
    const err = await api.post('/api/invoices', { a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe('Bad Gateway');
    expect((err as ApiError).message).not.toMatch(/Unexpected token|JSON/);
  });

  it('an error page with no status text still says what failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const err = await api.get('/api/bills').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('The request failed (error 500).');
  });

  it('a 2xx that is not JSON says the save may not have happened', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>portal</html>', { status: 200 })));
    const err = await api.post('/api/payments', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(UNREADABLE_RESPONSE_MESSAGE);
    expect((err as ApiError).code).toBe('BAD_RESPONSE');
  });

  it('JSON answers behave as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Nope', code: 'VALIDATION' }), { status: 400 })));
    const err = await api.post('/api/x', {}).catch((e) => e);
    expect((err as ApiError).message).toBe('Nope');
    expect((err as ApiError).code).toBe('VALIDATION');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.del('/api/x/1')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Account register
// ---------------------------------------------------------------------------

const ACCOUNTS: TypeaheadChoice[] = [
  { id: 'rent', label: '6100 · Rent', terms: ['6100', 'Rent'] },
  { id: 'util', label: '6200 · Utilities', terms: ['6200', 'Utilities'] },
];

describe('register entry row: the account saved is the one the field shows', () => {
  it('text retyped after a pick no longer stands for the picked account', () => {
    // Picked Rent, then typed over it with a name that is not in the chart, then Enter:
    expect(choiceForTypedText(ACCOUNTS, 'Rent deposit', 'rent')).toBeNull(); // ask to add it
    // Typed over it with another account's number or name:
    expect(choiceForTypedText(ACCOUNTS, '6200', 'rent')).toBe('util');
    expect(choiceForTypedText(ACCOUNTS, 'utilities', 'rent')).toBe('util');
    // Untouched / blank:
    expect(choiceForTypedText(ACCOUNTS, '6100 · Rent', 'rent')).toBe('rent');
    expect(choiceForTypedText(ACCOUNTS, '  ', 'rent')).toBe('');
  });

  it('RegisterEntryRow resolves the typed account before it saves', () => {
    const src = read('components/RegisterEntryRow.tsx');
    expect(src).toContain('choiceForTypedText(accountChoices, account.current.text, account.current.id)');
    expect(src).toMatch(/const accountId = account\.current\.id;/);
  });
});

describe('register page: the grid stays while it reloads', () => {
  it('spinner on the first load only; a reload keeps the grid (and the entry row with the cursor)', () => {
    expect(registerBody(true, false)).toBe('spinner');
    expect(registerBody(true, true)).toBe('grid'); // reloading after Enter: still the grid
    expect(registerBody(false, false)).toBe('unavailable');
    expect(registerBody(false, true)).toBe('grid');
  });

  it('the entry row follows the applied search, not the search box being typed into', () => {
    expect(showEntryRow('')).toBe(true);
    expect(showEntryRow('acme')).toBe(false);
    const src = read('app/registers/[accountId]/page.tsx');
    expect(src).not.toContain('!loading && result &&');
    expect(src).toContain('showEntryRow(resultSearch)');
    expect(src).toContain('onSaved={() => load(resultFrom, resultTo, resultSearch)}');
  });
});

// ---------------------------------------------------------------------------
// Pay Bills
// ---------------------------------------------------------------------------

describe('Pay Bills keeps the batch when the date or a filter changes', () => {
  const empty = () => ({ checked: false, payAmount: '' });
  const prev = { b1: { checked: true, payAmount: '40.00' }, b2: { checked: true, payAmount: '10.00' } };

  it('a reload for the same vendor keeps each listed bill as ticked and typed', () => {
    expect(carryRows(prev, ['b1', 'b3'], empty, true)).toEqual({ b1: { checked: true, payAmount: '40.00' }, b3: empty() });
    expect(carryAmounts({ j1: '5.00', j2: '1.00' }, ['j1'], true)).toEqual({ j1: '5.00' });
  });

  it('another vendor, or a saved payment, starts fresh', () => {
    expect(carryRows(prev, ['b1', 'b2'], empty, false)).toEqual({ b1: empty(), b2: empty() });
    expect(carryAmounts({ j1: '5.00' }, ['j1'], false)).toEqual({});
  });

  it('the page reloads with keep for the vendor already shown, and ignores a superseded load', () => {
    const src = read('app/pay-bills/page.tsx');
    expect(src).not.toContain('setRows(Object.fromEntries(open.map((b) => [b.id, emptyRow()])))');
    expect(src).toContain('loadVendorData(vendorId, loadedVendor.current === vendorId)');
    expect(src).toContain('if (mine !== loadSeq.current) return;');
  });

  it('a General Journal credit applied to a General Journal amount owed can be saved on its own', () => {
    expect(payBillsHasWork({ billsSelected: 0, journalPaid: 0, journalCreditOnJournal: 25 })).toBe(true);
    expect(payBillsHasWork({ billsSelected: 0, journalPaid: 0, journalCreditOnJournal: '0' })).toBe(false);
    expect(payBillsHasWork({ billsSelected: 1, journalPaid: 0, journalCreditOnJournal: 0 })).toBe(true);
    expect(read('app/pay-bills/page.tsx')).not.toContain(
      'disabled={(selected.length === 0 && journalItems.length === 0) || rowErrors.length > 0 || journalOverpaid}',
    );
  });
});

// ---------------------------------------------------------------------------
// Make Deposits
// ---------------------------------------------------------------------------

describe('Make Deposits', () => {
  const eurDeposit: Deposit = {
    id: 'd1',
    depositAccountId: 'eur-bank',
    accountName: 'Euro account',
    accountCode: '1020',
    date: '2026-06-09T00:00:00.000Z',
    total: '300.00',
    memo: null,
    voidedAt: null,
    createdAt: '2026-06-09T10:00:00.000Z',
    currency: 'EUR',
    lines: [
      { id: 'l1', depositId: 'd1', paymentId: 'p1', description: null, amount: '200.00' },
      { id: 'l2', depositId: 'd1', paymentId: null, description: 'salesReceipt:sr1', amount: '100.00' },
    ],
  };

  it('editing a foreign-currency deposit keeps its own payments in the list (their currency is the deposit’s)', () => {
    const edit = depositToEdit(eurDeposit);
    expect(edit.items.map((i) => [i.id, i.kind, i.currency])).toEqual([
      ['p1', 'payment', 'EUR'],
      ['sr1', 'sales_receipt', 'EUR'],
    ]);
    // The modal lists items whose currency is the bank account's ('EUR'):
    const depCur = 'EUR';
    expect(edit.items.filter((p) => (p.currency || null) === depCur)).toHaveLength(2);
    // A home-currency deposit's items stay home-currency (null).
    expect(depositToEdit({ ...eurDeposit, currency: null }).items.every((i) => i.currency === null)).toBe(true);
  });

  it('"Deposit To" offers banks and other current assets, never A/R, inventory, fixed assets or UF', () => {
    const accounts = [
      { id: 'chk', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
      { id: 'sav', code: '1010', name: 'Savings', type: 'asset', subtype: 'savings' },
      { id: 'uf', code: '1050', name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
      { id: 'ar', code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { id: 'inv', code: '1300', name: 'Inventory Asset', type: 'asset', subtype: 'inventory' },
      { id: 'pc', code: '1400', name: 'Petty Cash', type: 'asset', subtype: 'other_current_asset' },
      { id: 'fa', code: '1500', name: 'Truck', type: 'asset', subtype: 'fixed_assets' },
    ];
    expect(depositToAccounts(accounts).map((a) => a.id)).toEqual(['chk', 'sav', 'pc']);
    expect(read('app/deposits/page.tsx')).not.toContain("accounts.filter((a) => a.type === 'asset' && a.code !== '1050')");
  });

  it('editing a deposit saved to an account no longer offered keeps that account in "Deposit To"', () => {
    // A deposit saved earlier into a fixed asset: without it in the list the select showed its
    // placeholder while the form still held the hidden id, and the deposit's currency was looked
    // up against an account missing from the list.
    const accounts = [
      { id: 'chk', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
      { id: 'fa', code: '1500', name: 'Truck', type: 'asset', subtype: 'fixed_assets', currency: 'CAD' },
      { id: 'ar', code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
    ];
    expect(depositToAccounts(accounts, ['fa']).map((a) => a.id)).toEqual(['chk', 'fa']);
    expect(depositToAccounts(accounts, [null, undefined]).map((a) => a.id)).toEqual(['chk']);
    // A new deposit (nothing to keep) still offers banks / other current assets only.
    expect(depositToAccounts(accounts).map((a) => a.id)).toEqual(['chk']);
    expect(read('app/deposits/page.tsx')).toMatch(/depositToAccounts\(accounts, \[editing\?\.depositAccountId\]\)/);
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('Reconcile', () => {
  it('Finish needs a difference of exactly 0.00, what the service accepts', () => {
    expect(canFinishReconciliation('0.00')).toBe(true);
    expect(canFinishReconciliation('-0.00')).toBe(true);
    expect(canFinishReconciliation('0.01')).toBe(false); // was enabled and shown green
    expect(canFinishReconciliation('-0.01')).toBe(false);
    expect(canFinishReconciliation('garbage')).toBe(false);
  });

  it('a toggle answer sets the state it asked for (two quick clicks no longer end unticked)', () => {
    const lines = [{ journalEntryLineId: 'a', isCleared: false }, { journalEntryLineId: 'b', isCleared: false }];
    // Click A (asks for cleared), click B, click A again before A answered: the second request for
    // A still asked for cleared (the line showed unticked), so both answers mean "cleared".
    let shown = applyClearedAnswer(lines, 'a', true);
    shown = applyClearedAnswer(shown, 'a', true);
    expect(shown.find((l) => l.journalEntryLineId === 'a')!.isCleared).toBe(true);
    // The old update flipped whatever was shown, twice:
    const flip = (ls: typeof lines) => ls.map((l) => (l.journalEntryLineId === 'a' ? { ...l, isCleared: !l.isCleared } : l));
    expect(flip(flip(lines)).find((l) => l.journalEntryLineId === 'a')!.isCleared).toBe(false);
    const src = read('app/reconcile/page.tsx');
    expect(src).not.toContain("lessThanOrEqualTo('0.01')");
    expect(src).toContain('applyClearedAnswer(prev, id, want)');
  });
});

// ---------------------------------------------------------------------------
// Statement import review
// ---------------------------------------------------------------------------

describe('statement import review', () => {
  const rows = [
    { date: '2026-06-02', description: 'Deposit', payee: '', amount: '1,000.00' },
    { date: '2026-06-05', description: 'Check 101', payee: '', amount: '(250.00)' },
  ];

  it('amounts are read as statements print them and sent to the cent', () => {
    expect(statementAmount('2500')).toBe('2500.00');
    expect(statementAmount('2500.5')).toBe('2500.50');
    expect(statementAmount('$1,234.56')).toBe('1234.56');
    expect(statementAmount('(45.00)')).toBe('-45.00');
    expect(statementAmount('-$12')).toBe('-12.00');
    expect(statementAmount('12.345')).toBeNull();
    expect(statementAmount('1,23')).toBeNull();
    expect(statementAmount('')).toBeNull();
    expect(importableRows(rows)).toHaveLength(2); // "1,000.00" used to make the row invalid
  });

  it('balances typed without cents tie out on the server too (they were refused as "missing")', () => {
    const payload = reviewedPayload(rows, '1000', '1750', 'bank', false);
    expect(payload.openingBalance).toBe('1000.00');
    expect(payload.closingBalance).toBe('1750.00');
    expect(payload.rows.map((r) => r.amount)).toEqual(['1000.00', '-250.00']);
    expect(payload.acknowledgeDifference).toBe(false);
    // The import route ties out with exactly what was sent (app/api/import/route.ts):
    expect(tieOut(payload.rows, payload.openingBalance, payload.closingBalance, 'bank').ok).toBe(true);
    // What the screen used to send for those balances:
    expect(tieOut(payload.rows, '1000', '1750', 'bank').ok).toBe(false);
  });

  it('removing or adding a row clears "Import anyway"; the import goes to the account the file was read for', () => {
    const review = read('components/StatementReview.tsx');
    expect(review.match(/setAck\(false\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(review).toContain('reviewedPayload(rows, opening, closing, extract.statementKind, ack)');
    const banking = read('app/banking/page.tsx');
    expect(banking).toContain('bankAccountId: statementAccountId');
    expect(banking).toMatch(/setImportBankAccountId\(e\.target\.value\);\s*\/\/[^\n]*\n[^\n]*\n\s*setStatementExtract\(null\);/);
    expect(banking).toContain('if (BINARY_KINDS.includes(importFileType)) return;');
  });
});

// ---------------------------------------------------------------------------
// Previous / Next and the Invoices list
// ---------------------------------------------------------------------------

describe('Previous / Next order of document numbers', () => {
  it('check 999 comes before check 1000 on the same day', () => {
    const refs = ['1000', '999', '1001', null, 'INV-100', 'INV-99'];
    expect([...refs].sort(compareDocNumbers)).toEqual([null, '999', '1000', '1001', 'INV-99', 'INV-100']);
    expect(['1000', '999'].sort((a, b) => a.localeCompare(b))).toEqual(['1000', '999']); // the old order
    expect(read('app/bills/page.tsx')).toContain('compareDocNumbers(a.billNumber, b.billNumber)');
    expect(read('app/expenses/page.tsx')).toContain('compareDocNumbers(a.reference, b.reference)');
  });
});

describe('Invoices list', () => {
  it('offers Edit on partly and fully paid invoices (the service keeps their payments applied)', () => {
    expect(canEditInvoice('partial')).toBe(true);
    expect(canEditInvoice('paid')).toBe(true);
    expect(canEditInvoice('open')).toBe(true);
    expect(canEditInvoice('draft')).toBe(true);
    expect(canEditInvoice('void')).toBe(false);
    expect(read('app/invoices/page.tsx')).toContain('canEditInvoice(inv.status) &&');
  });
});

// ---------------------------------------------------------------------------
// Record locking after an action on the open record
// ---------------------------------------------------------------------------

describe('lib/client.ts: an unversioned action on the open record does not refresh its version', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (answers: unknown[], sent: Array<string | undefined>) => {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push((init?.headers as Record<string, string> | undefined)?.['x-expected-updated-at']);
        return new Response(JSON.stringify(answers[i++]), { status: 200 });
      }),
    );
  };

  it('the answer of an unapply / apply / refund is not taken as the version the form was loaded at', async () => {
    // Apply / refund / unapply are not checked against the loaded version on the server, so the
    // record they answer with may carry another user's change made since the form opened. Taking
    // its version would let the next Save overwrite that change instead of getting the 409.
    const sent: Array<string | undefined> = [];
    stubFetch(
      [
        { id: 'cm1', updatedAt: '2026-06-09T10:00:00.000Z', lines: [] }, // GET (edit opens)
        { id: 'cm1', updatedAt: '2026-06-09T10:05:00.000Z', unapplied: '50.00' }, // POST unapply
        { id: 'cm1', updatedAt: '2026-06-09T10:06:00.000Z' }, // PATCH save
      ],
      sent,
    );
    await api.get('/api/credit-memos/cm1');
    await api.post('/api/credit-memos/cm1', { action: 'unapply', applicationId: 'a1' }, { noUndo: true });
    await api.patch('/api/credit-memos/cm1', { memo: 'x' }, { noUndo: true });
    expect(sent[1]).toBeUndefined(); // the unapply itself is not versioned
    expect(sent[2]).toBe('2026-06-09T10:00:00.000Z');
    expect(read('lib/client.ts')).not.toMatch(/refreshVersionFrom/);
  });

  it('the credit memo page reloads its list after Unapply, which is what refreshes the version', async () => {
    const sent: Array<string | undefined> = [];
    stubFetch(
      [
        { id: 'cm2', updatedAt: '2026-06-09T10:00:00.000Z', lines: [] }, // GET (edit opens)
        { id: 'cm2', updatedAt: '2026-06-09T10:05:00.000Z' }, // POST unapply
        [{ id: 'cm2', updatedAt: '2026-06-09T10:05:00.000Z' }], // GET list (onCreated = fetchData)
        { id: 'cm2', updatedAt: '2026-06-09T10:06:00.000Z' }, // PATCH save
      ],
      sent,
    );
    await api.get('/api/credit-memos/cm2');
    await api.post('/api/credit-memos/cm2', { action: 'unapply', applicationId: 'a1' }, { noUndo: true });
    await api.get('/api/credit-memos');
    await api.patch('/api/credit-memos/cm2', { memo: 'x' }, { noUndo: true });
    expect(sent[3]).toBe('2026-06-09T10:05:00.000Z');
    const page = read('app/credit-memos/page.tsx');
    expect(page).toMatch(/action: 'unapply', applicationId \}\);[\s\S]{0,300}onCreated\(\)/);
    expect(page).toMatch(/onCreated=\{fetchData\}/);
  });
});

// ---------------------------------------------------------------------------
// Transfer Funds
// ---------------------------------------------------------------------------

describe('Transfer Funds account lists', () => {
  it('balance-sheet accounts only: never A/R, A/P, Undeposited Funds, Inventory, income or expense', () => {
    const accounts = [
      { id: 'chk', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
      { id: 'uf', code: '1050', name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
      { id: 'ar', code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { id: 'inv', code: '1300', name: 'Inventory Asset', type: 'asset', subtype: 'inventory' },
      { id: 'pc', code: '1400', name: 'Petty Cash', type: 'asset', subtype: 'other_current_asset' },
      { id: 'ap', code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable' },
      { id: 'cc', code: '2100', name: 'Visa', type: 'liability', subtype: 'credit_card' },
      { id: 'loan', code: '2700', name: 'Truck loan', type: 'liability', subtype: 'long_term_liability' },
      { id: 'eq', code: '3000', name: 'Owner draws', type: 'equity', subtype: 'equity' },
      { id: 'sales', code: '4000', name: 'Sales', type: 'revenue', subtype: 'income' },
      { id: 'rent', code: '6100', name: 'Rent', type: 'expense', subtype: 'expense' },
      { id: 'np', code: '9000', name: 'Estimates', type: 'asset', subtype: 'non_posting' },
      { id: 'old', code: '1020', name: 'Old bank', type: 'asset', subtype: 'checking', isActive: false },
    ];
    expect(transferAccounts(accounts).map((a) => a.id)).toEqual(['chk', 'pc', 'cc', 'loan', 'eq']);
    // A saved transfer being edited keeps the accounts it already uses.
    expect(transferAccounts(accounts, ['old']).map((a) => a.id)).toContain('old');
    expect(read('app/transfers/page.tsx')).toContain('transferAccounts(allAccounts, [editing?.fromAccountId, editing?.toAccountId])');
  });
});

// ---------------------------------------------------------------------------
// Vendor credits, Print Checks, Pay Sales Tax, Pay Liabilities, Enter Bill for Received Items
// ---------------------------------------------------------------------------

describe('Vendor credit Items tab', () => {
  it('lists the items GET /api/items answers ({ items: [...] }), without discount / tax / group items', () => {
    const answer = {
      items: [
        { id: 'w', name: 'Widget', type: 'inventory' },
        { id: 's', name: 'Install', type: 'service' },
        { id: 'd', name: 'Disc', type: 'discount' },
        { id: 'g', name: 'Kit', type: 'group' },
      ],
    };
    expect(creditItems<{ id: string; type?: string }>(answer).map((i) => i.id)).toEqual(['w', 's']);
    // Bare lists (classes, customers, jobs) are read too.
    expect(rowsOf<{ id: string }>([{ id: 'c1' }], 'classes')).toEqual([{ id: 'c1' }]);
    expect(rowsOf(null, 'items')).toEqual([]);
    // What the form did with that answer: not an array, so no items at all.
    expect(Array.isArray(answer)).toBe(false);
    expect(read('app/vendor-credits/page.tsx')).toContain('setItemList(creditItems<Named>(it))');
  });
});

describe('Print Checks numbering', () => {
  it('a run steps the number at its end and keeps padding and prefix', () => {
    expect(checkNumberSeries('1001', 3)).toEqual(['1001', '1002', '1003']);
    expect(checkNumberSeries('001099', 2)).toEqual(['001099', '001100']); // was refused for a batch
    expect(checkNumberSeries('CHK-99', 2)).toEqual(['CHK-99', 'CHK-100']);
    expect(checkNumberSeries('ABC', 2)).toBeNull();
    expect(checkNumberSeries('ABC', 1)).toEqual(['ABC']);
    expect(nextCheckNumber('001001')).toBe('001002'); // a single check used to leave it unchanged
    expect(nextCheckNumber('ABC')).toBeNull();
  });

  it('a single check whose number was recorded leaves the queue and moves the number on even if the PDF fails', () => {
    const src = read('app/print-checks/page.tsx');
    const single = src.slice(src.indexOf('async function handlePrintQueued'), src.indexOf('// ── Print the selected checks'));
    // The number advances and the check leaves the queue BEFORE the PDF is opened.
    expect(single.indexOf('setNextNumber(next)')).toBeGreaterThan(-1);
    expect(single.indexOf('setNextNumber(next)')).toBeLessThan(single.indexOf('await openCheckPdf('));
    expect(single.indexOf('setQueue(')).toBeLessThan(single.indexOf('await openCheckPdf('));
  });
});

describe('Pay Sales Tax', () => {
  it('looks the next check number up again after checks are written or voided', () => {
    const src = read('app/sales-tax/page.tsx');
    expect(src).toContain('}, [payFrom, toPrint, numberTick]);');
    expect(src.match(/setNumberTick\(\(n\) => n \+ 1\)/g)?.length).toBe(2);
  });
});

describe('Pay Liabilities', () => {
  afterEach(() => vi.useRealTimers());

  it('a new payment is dated the day the form opens, not the day the page was loaded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 23, 30)); // June 9, 11:30 pm local
    expect(emptyPayForm().date).toBe('2026-06-09');
    vi.setSystemTime(new Date(2026, 5, 10, 8, 0)); // the app stayed open overnight
    expect(emptyPayForm().date).toBe('2026-06-10');
    expect(read('app/pay-liabilities/page.tsx')).not.toMatch(/const EMPTY_FORM: PayForm = \{/);
  });
});

describe('Enter Bill for Received Items', () => {
  it('a late preview answer for earlier quantities never replaces the current one', async () => {
    // The page's preview effect, as it runs: each change starts a request; answers land out of order.
    const gate = createLatestGate();
    const shown: string[] = [];
    const resolvers: Array<() => void> = [];
    const request = (answer: string) => {
      const isLatest = gate.begin();
      return new Promise<void>((done) => {
        resolvers.push(() => {
          if (isLatest()) shown.push(answer);
          done();
        });
      });
    };
    const first = request('qty 5'); // the user typed 5 ...
    const second = request('qty 50'); // ... then 50 before the first answer came back
    resolvers[1](); // the answer for 50 arrives first
    resolvers[0](); // the slow answer for 5 arrives late
    await Promise.all([first, second]);
    expect(shown).toEqual(['qty 50']);
    // Cancelled (e.g. the lines were cleared): nothing pending lands.
    const third = request('qty 7');
    gate.cancel();
    resolvers[2]();
    await third;
    expect(shown).toEqual(['qty 50']);

    const src = read('app/receive-bill/page.tsx');
    expect(src).toContain('const isLatest = previewGate.current.begin();');
    expect(src.match(/if \(!isLatest\(\)\) return;/g)?.length).toBe(2); // the answer and the error
  });
});

// ---------------------------------------------------------------------------
// Document numbers with two people entering at once
// ---------------------------------------------------------------------------

describe('document numbers: an untouched suggested number is allocated by the server', () => {
  it('the number suggested when the form opened is not sent; a typed one is', () => {
    expect(docNumberPayload('INV-1005', 'INV-1005')).toBeUndefined(); // server allocates under its lock
    expect(docNumberPayload(' INV-1005 ', 'INV-1005')).toBeUndefined();
    expect(docNumberPayload('INV-2000', 'INV-1005')).toBe('INV-2000');
    expect(docNumberPayload('', 'INV-1005')).toBeUndefined();
    expect(docNumberPayload('1042', null)).toBe('1042'); // editing: the saved number is kept
    // The server's own allocation (no number given) runs inside the save under an advisory lock:
    expect(read('lib/services/docNumbers.ts')).toContain('pg_advisory_xact_lock');
    // The invoice form sends only a typed number.
    const src = read('app/invoices/page.tsx');
    expect(src).not.toContain('if (refNumber.trim()) payload.refNumber = refNumber.trim();');
    expect(src).toContain('if (invNumber.payload) payload.refNumber = invNumber.payload;');
  });
});

describe('estimate lines are saved as typed', () => {
  it('a quantity of 0 or text is refused, never saved as 1; a blank quantity is 1', () => {
    expect(estimateLineNumbers({ quantity: '0', rate: '50', itemId: '' }, 2)).toEqual({ error: 'Line 2: the quantity must be a number more than zero.' });
    expect(estimateLineNumbers({ quantity: 'abc', rate: '50', itemId: '' }, 1)).toHaveProperty('error');
    expect(estimateLineNumbers({ quantity: '', rate: '50', itemId: '' }, 1)).toEqual({ quantity: '1', rate: '50' });
    expect(estimateLineNumbers({ quantity: '.5', rate: '12.', itemId: '' }, 1)).toEqual({ quantity: '0.5', rate: '12' });
    expect(estimateLineNumbers({ quantity: '2', rate: '12abc', itemId: '' }, 1)).toHaveProperty('error');
    expect(estimateLineNumbers({ quantity: '2', rate: '', itemId: 'item-1' }, 1)).toEqual({ quantity: '2', rate: null });
    expect(estimateLineNumbers({ quantity: '1', rate: '-5', itemId: 'disc' }, 1)).toEqual({ quantity: '1', rate: '-5' });
    // What the form used to send for a quantity of 0:
    expect(parseFloat('0') || 1).toBe(1);
    expect(read('app/estimates/page.tsx')).not.toContain('quantity: parseFloat(l.quantity) || 1');
  });
});

// ---------------------------------------------------------------------------
// Fix buttons after the form was changed
// ---------------------------------------------------------------------------

describe('Fix buttons never save an older version of the form', () => {
  const fix: ErrorFix = {
    id: 'docnum-keep',
    kind: 'patch',
    label: 'Keep it anyway',
    patch: [{ op: 'set', path: 'allowDuplicateNumber', value: true }],
  };
  const payload = { refNumber: 'INV-1', lines: [{ quantity: '1', rate: '100' }] };

  it('a fix is not run when the form changed since the error; nothing is sent', async () => {
    const resubmit = vi.fn().mockResolvedValue(undefined);
    const applyToForm = vi.fn();
    const onStale = vi.fn();
    const deps = { navigate: vi.fn(), setBusy: vi.fn(), onSaved: vi.fn(), onError: vi.fn(), onStale };
    // The user changed line 1 to 250 after "Number already used" appeared, then clicked the fix:
    const out = await runFix(fix, { payload, resubmit, applyToForm, isStale: () => true }, deps);
    expect(out).toBe('stale');
    expect(resubmit).not.toHaveBeenCalled(); // the old body (rate 100) would have been saved
    expect(applyToForm).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('an unchanged form runs the fix as before', async () => {
    const resubmit = vi.fn().mockResolvedValue(undefined);
    const deps = { navigate: vi.fn(), setBusy: vi.fn(), onSaved: vi.fn(), onError: vi.fn() };
    expect(await runFix(fix, { payload, resubmit, isStale: () => false }, deps)).toBe('saved');
    expect(resubmit).toHaveBeenCalledTimes(1);
  });

  it('the fix panel compares the form with how it was when the error was shown', () => {
    const src = read('components/ErrorFixPanel.tsx');
    expect(src).toContain('runFix(fix, { ...cur.ctx, isStale }');
    expect(src).toContain('fieldSnapshot(fixScope(panelEl.current))');
  });
});

// ---------------------------------------------------------------------------
// Advanced Inventory detail kept through an edit
// ---------------------------------------------------------------------------

describe('editing a sales receipt or credit memo keeps each line’s site / bin / serials / lot', () => {
  it('the saved detail is loaded into the line and sent back with the edit', () => {
    // The services re-post the document from what the edit sends (no carry-forward), so a line
    // without its detail was relieved from / restocked into the default site, serials dropped.
    expect(read('lib/services/salesReceipts.ts')).not.toMatch(/sourceType: 'sales_receipt',[\s\S]{0,200}carryForward/);
    for (const page of ['app/sales-receipts/page.tsx', 'app/credit-memos/page.tsx']) {
      const src = read(page);
      expect(src).toContain('inv: invFromLine(l),');
      expect(src).toContain('inventoryLinePayload(l.inv)');
    }
    expect(invFromLine({ siteId: 'east', binId: null, serialNumbers: ['SN1'], lotNumber: null })).toEqual(
      expect.objectContaining({ siteId: 'east', serialNumbers: ['SN1'] }),
    );
  });
});

describe('Assess Finance Charges', () => {
  it('assesses for the date the charges on screen were worked out for; a new date needs a new preview', () => {
    const june = { asOf: '2026-06-30', customers: [{ customerId: 'c1' }] };
    // Shown (and assessable) only while the field holds the preview's date.
    expect(previewForDate(june, '2026-06-30')).toBe(june);
    expect(previewForDate(june, '2026-07-31')).toBeNull(); // the date was changed after the preview
    expect(previewForDate(null, '2026-06-30')).toBeNull();
    // A preview for June answering after the date became July is not shown either.
    expect(previewForDate({ asOf: '2026-06-30' }, '2026-07-31')).toBeNull();
    // The assessment is for the preview's own date and the ticked customers.
    expect(assessBody(june, new Set(['c1', 'c2']))).toEqual({ asOf: '2026-06-30', customerIds: ['c1', 'c2'] });

    const src = read('app/finance-charges/page.tsx');
    expect(src).toContain('const preview = previewForDate(loadedPreview, asOf);');
    expect(src).toContain("api.post<AssessResult>('/api/finance-charges', assessBody(preview, selected))");
    // A cleared date is refused before the preview (the route would silently use today).
    expect(src).toMatch(/if \(!asOf\) \{\s*toast\('Enter the assessment date first\.', 'danger'\);/);
  });
});
