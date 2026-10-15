/**
 * Receipt text parsing against real-world layouts: big-box retail, gas stations, restaurants
 * with tips, grocery with savings lines, Canadian GST/PST, European VAT with comma decimals,
 * online order emails / PDF invoices, utility bills, parking, OCR noise.
 */
import { describe, expect, it } from 'vitest';
import { amountsInLine, parseReceiptText, receiptLines, tidyName } from './parse';

const today = new Date('2026-10-15T12:00:00Z');
const parse = (t: string, o: Parameters<typeof parseReceiptText>[1] = {}) => parseReceiptText(t, { today, ...o });

describe('amountsInLine', () => {
  it('reads common money formats with exactly two decimals', () => {
    expect(amountsInLine('TOTAL $1,234.56')).toEqual(['1234.56']);
    expect(amountsInLine('Total 22.79')).toEqual(['22.79']);
    expect(amountsInLine('Summe 1.234,56 €')).toEqual(['1234.56']);
    expect(amountsInLine('Total 22,79 EUR')).toEqual(['22.79']);
    expect(amountsInLine('REFUND (12.50)')).toEqual(['-12.50']);
    expect(amountsInLine('COUPON 1.00-')).toEqual(['-1.00']);
    expect(amountsInLine('2 @ 3.99   7.98')).toEqual(['3.99', '7.98']);
    expect(amountsInLine('Store #4521 Tel 555-1234')).toEqual([]);
    expect(amountsInLine('Qty 3')).toEqual([]);
  });
});

describe('parseReceiptText: retail', () => {
  it('big-box hardware store', () => {
    const r = parse(`HOME DEPOT #4521
123 MAIN ST
SPRINGFIELD IL 62701
03/14/2026  10:42 AM
LUMBER 2X4        12.97
SCREWS BOX         8.48
SUBTOTAL          21.45
SALES TAX 6.25%    1.34
TOTAL             22.79
VISA ************4417
AUTH CODE 0912AB
THANK YOU`);
    expect(r.vendorName).toBe('Home Depot');
    expect(r.date).toBe('2026-03-14');
    expect(r.total).toBe('22.79');
    expect(r.subtotal).toBe('21.45');
    expect(r.tax).toBe('1.34');
    expect(r.cardLast4).toBe('4417');
    expect(r.cardBrand).toBe('Visa');
    expect(r.confidence.total).toBeGreaterThan(0.95); // subtotal + tax = total
  });

  it('grocery with savings and item counts that must not be the total', () => {
    const r = parse(`Welcome to Kroger
Store 00412
1/5/26 6:01pm
BANANAS            1.29
MILK 2%            3.49
EGGS               4.19
TOTAL SAVINGS      2.00
**** BALANCE       8.97
TOTAL NUMBER OF ITEMS SOLD = 3
MASTERCARD         8.97
CARD # XXXXXXXXXXXX5521
CHANGE DUE         0.00`);
    expect(r.vendorName).toBe('Kroger');
    expect(r.date).toBe('2026-01-05');
    expect(r.total).toBe('8.97');
    expect(r.cardLast4).toBe('5521');
    expect(r.cardBrand).toBe('Mastercard');
  });

  it('cash sale: tendered and change are ignored', () => {
    const r = parse(`CORNER MARKET
Date: 2026-07-04
Soda   2.50
Chips  1.75
Tax    0.30
Total  4.55
Cash   20.00
Change 15.45`);
    expect(r.total).toBe('4.55');
    expect(r.tax).toBe('0.30');
    expect(r.cardLast4).toBeNull();
    expect(r.date).toBe('2026-07-04');
  });

  it('label on one line, amount on the next (common in PDF text)', () => {
    const r = parse(`Office Supply Co
Invoice Date
Sep 2, 2026
Subtotal
$100.00
Tax
$8.25
Total
$108.25`);
    expect(r.total).toBe('108.25');
    expect(r.tax).toBe('8.25');
    expect(r.subtotal).toBe('100.00');
    expect(r.date).toBe('2026-09-02');
  });
});

describe('parseReceiptText: fuel, restaurants, services', () => {
  it('gas station pump receipt', () => {
    const r = parse(`SHELL
4410 HIGHWAY 7
AUSTIN TX 78701
TEL (512) 555-0199
08/30/26 07:12
PUMP 04  UNLEADED
GALLONS 11.204 @ 3.299
FUEL SALE        $36.96
DEBIT ****8830`);
    expect(r.vendorName).toBe('Shell');
    expect(r.total).toBe('36.96');
    expect(r.date).toBe('2026-08-30');
    expect(r.cardLast4).toBe('8830');
  });

  it('restaurant with tip: the paid total includes the tip', () => {
    const r = parse(`The Blue Door Bistro
Server: Ana   Table 12
Guests: 2
Date: 10/02/2026
Subtotal     $54.00
Tax          $4.86
Total        $58.86
Tip          $10.00
Grand Total  $68.86
AMEX x1009
Tip suggestions: 15% 8.10  20% 10.80`);
    expect(r.vendorName).toBe('The Blue Door Bistro');
    expect(r.total).toBe('68.86');
    expect(r.tax).toBe('4.86');
    expect(r.cardLast4).toBe('1009');
    expect(r.cardBrand).toBe('American Express');
  });

  it('ride / parking receipt with "Amount charged"', () => {
    const r = parse(`Receipt
CityPark Garage
Entry 09/12/2026 08:00
Exit 09/12/2026 17:30
Amount charged: $24.00
Card ending in 3321`);
    expect(r.vendorName).toBe('CityPark Garage');
    expect(r.total).toBe('24.00');
    expect(r.cardLast4).toBe('3321');
    expect(r.date).toBe('2026-09-12');
  });

  it('utility bill: amount due, not the due date', () => {
    const r = parse(`City of Springfield Utilities
Account Number: 5501-2231
Statement Date: 09/20/2026
Due Date: 10/15/2026
Previous Balance  120.00
Payments Received (120.00)
Current Charges  98.41
Amount Due  $98.41`);
    expect(r.vendorName).toBe('City of Springfield Utilities');
    expect(r.date).toBe('2026-09-20');
    expect(r.total).toBe('98.41');
  });
});

describe('parseReceiptText: online orders and invoices', () => {
  it('online order confirmation (PDF)', () => {
    const r = parse(`Order Confirmation
Merchant: Acme Online Store
Order #: 112-5539921-0045
Order Date: August 3, 2026
Items Subtotal: $45.98
Shipping: $0.00
Estimated tax: $3.79
Order Total: $49.77
Payment: Visa ending in 9012`);
    expect(r.vendorName).toBe('Acme Online Store');
    expect(r.date).toBe('2026-08-03');
    expect(r.total).toBe('49.77');
    expect(r.tax).toBe('3.79');
    expect(r.cardLast4).toBe('9012');
    expect(r.reference).toBe('112-5539921-0045');
  });

  it('vendor invoice with balance due and a tax ID line', () => {
    const r = parse(`BRIGHT SIGNS LLC
Tax ID: 12-3456789
INVOICE
Invoice No: INV-20931
Date: 2026-06-30
Due: 2026-07-30
Design work        400.00
Vinyl banner       150.00
Subtotal           550.00
Sales Tax (8%)      44.00
Balance Due        594.00`);
    expect(r.vendorName).toBe('Bright Signs LLC');
    expect(r.total).toBe('594.00');
    expect(r.tax).toBe('44.00');
    expect(r.reference).toBe('INV-20931');
    expect(r.date).toBe('2026-06-30');
  });

  it('Canadian GST + PST are added together', () => {
    const r = parse(`MAPLE HARDWARE
Vancouver BC
2026/05/18
Subtotal 100.00
GST 5% 5.00
PST 7% 7.00
TOTAL 112.00
INTERAC ****7765`);
    expect(r.tax).toBe('12.00');
    expect(r.total).toBe('112.00');
    expect(r.cardLast4).toBe('7765');
    expect(r.date).toBe('2026-05-18');
  });

  it('European receipt: comma decimals, VAT and day-first dates', () => {
    const r = parse(
      `Café Lumière
Rue de Rivoli 10
Date: 14/03/2026
Croissant 2,50
Café 3,20
TVA 10% 0,57
TOTAL TTC 5,70 €
Carte **** 4242`,
      { dateOrder: 'dmy' },
    );
    expect(r.vendorName).toBe('Café Lumière');
    expect(r.total).toBe('5.70');
    expect(r.tax).toBe('0.57');
    expect(r.date).toBe('2026-03-14');
    expect(r.cardLast4).toBe('4242');
  });

  it('uses the day-first fallback when the day is above 12 even in US mode', () => {
    expect(parse('Shop\n25/12/2025\nTotal 5.00').date).toBe('2025-12-25');
  });

  it('two-digit years and month names', () => {
    expect(parse('Shop\n14-MAR-26\nTotal 5.00').date).toBe('2026-03-14');
    expect(parse('Shop\nMar 14th, 2026\nTotal 5.00').date).toBe('2026-03-14');
    expect(parse('Shop\n3 September 2026\nTotal 5.00').date).toBe('2026-09-03');
  });
});

describe('parseReceiptText: noise and edge cases', () => {
  it('ignores future dates, phone numbers and impossible dates', () => {
    const r = parse(`QUICK MART
Phone 555-123-4567
02/30/2026
12/01/2030
11/02/2026
10/01/2026
Total 3.00`);
    expect(r.date).toBe('2026-10-01');
    expect(parse('QUICK MART\n12/01/2030\nTotal 3.00').date).toBeNull();
  });

  it('falls back to subtotal + tax, then the largest amount, with low confidence', () => {
    const a = parse('Some Shop\nSubtotal 10.00\nTax 0.80');
    expect(a.total).toBe('10.80');
    expect(a.confidence.total).toBeLessThan(0.7);
    const b = parse('Some Shop\nWidget 3.00\nGadget 12.40\nCash 20.00');
    expect(b.total).toBe('12.40');
    expect(b.confidence.total).toBeLessThan(0.5);
  });

  it('returns nulls (not guesses) for empty or unreadable text', () => {
    const r = parse('   \n\n ~~~ \n');
    expect(r).toMatchObject({ vendorName: null, date: null, total: null, tax: null, cardLast4: null });
    expect(parse('').total).toBeNull();
  });

  it('skips headings, addresses and URLs when picking the vendor', () => {
    const r = parse(`SALES RECEIPT
www.example.com
(555) 201-4455
GREEN LEAF NURSERY
88 Garden Way
Total 15.00`);
    expect(r.vendorName).toBe('Green Leaf Nursery');
  });

  it('a tax larger than the total is treated as a misread', () => {
    const r = parse('Shop\nTax 50.00\nTotal 5.00');
    expect(r.tax).toBeNull();
    expect(r.total).toBe('5.00');
  });

  it('does not treat "Total tax" as the purchase total', () => {
    const r = parse('Shop\nItem 10.00\nTotal Tax 0.80\nTotal 10.80');
    expect(r.total).toBe('10.80');
    expect(r.tax).toBe('0.80');
  });

  it('OCR noise in the card number does not invent digits', () => {
    const r = parse('HOME DEPOT\nTOTAL 22.79\nVISA ***kkskkkk*gq77');
    expect(r.cardLast4).toBeNull();
    expect(r.total).toBe('22.79');
  });

  it('helpers: line splitting and name tidying', () => {
    expect(receiptLines('a\r\n\r\n b \fc')).toEqual(['a', 'b', 'c']);
    expect(tidyName('HOME DEPOT')).toBe('Home Depot');
    expect(tidyName('ACME TOOLS LLC')).toBe('Acme Tools LLC');
    expect(tidyName("JOE'S DINER")).toBe("Joe's Diner");
    expect(tidyName('iHerb')).toBe('iHerb');
  });
});
