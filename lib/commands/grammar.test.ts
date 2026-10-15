/**
 * Command bar grammar (lib/commands/grammar.ts) + dates + name matching + prefill handoff.
 * Pure unit tests — `today` is fixed at 2026-10-15 (a Thursday, Q4).
 */
import { describe, it, expect } from 'vitest';
import { parseCommand, parseLine } from './grammar';
import { parseDateRange, parseSingleDate, parseExplicitDate } from './dates';
import { pickName, rankNames } from './match';
import { parseNumber } from './text';
import { commandIntentSchema, describeIntent, aiIntentReplySchema } from './intent';
import { stashPrefill, takePrefill, PREFILL_STORAGE_KEY, PREFILL_TTL_MS } from './prefill';
import { filterActions, visibleActions, canOpenHref } from './actions';
import { emptyPermissionSet, normalizeGrant } from '@/lib/permissions/model';

const TODAY = new Date(Date.UTC(2026, 9, 15, 15, 0, 0));
const p = (s: string) => parseCommand(s, TODAY);

describe('create commands', () => {
  it('invoice Acme 3 hours consulting', () => {
    expect(p('invoice Acme 3 hours consulting')).toEqual({
      kind: 'create',
      form: 'invoice',
      party: 'Acme',
      lines: [{ text: 'consulting', quantity: '3' }],
    });
  });

  it.each([
    ['Invoice Acme Corp for 3 hours of consulting at $150', 'Acme Corp', { text: 'consulting', quantity: '3', rate: '150' }],
    ['new invoice for Acme 2 x widgets @ 12.50', 'Acme', { text: 'widgets', quantity: '2', rate: '12.5' }],
    ['create an invoice to Acme $500 consulting', 'Acme', { text: 'consulting', amount: '500' }],
    ['invoice 3 hours consulting to Acme', 'Acme', { text: 'consulting', quantity: '3' }],
    ['charge Acme 10 widgets', 'Acme', { text: 'widgets', quantity: '10' }],
    ['invoice Acme 3 hours consulting for $450', 'Acme', { text: 'consulting', quantity: '3', amount: '450' }],
  ])('%s', (cmd, party, line) => {
    const r = p(cmd);
    expect(r).toMatchObject({ kind: 'create', form: 'invoice', party });
    expect(r && r.kind === 'create' && r.lines).toEqual([line]);
  });

  it('several lines', () => {
    const r = p('invoice Acme 3 hours consulting and 2 widgets at $10, 1 setup fee for $75');
    expect(r).toMatchObject({ kind: 'create', form: 'invoice', party: 'Acme' });
    expect(r && r.kind === 'create' && r.lines).toEqual([
      { text: 'consulting', quantity: '3' },
      { text: 'widgets', quantity: '2', rate: '10' },
      { text: 'setup fee', quantity: '1', amount: '75' },
    ]);
  });

  it('words before the first number are the customer (the executor narrows it down)', () => {
    expect(p('invoice Acme consulting 3 hours')).toEqual({
      kind: 'create',
      form: 'invoice',
      party: 'Acme consulting',
      lines: [{ quantity: '3' }],
    });
  });

  it('invoice with only a customer, or nothing at all', () => {
    expect(p('invoice Acme Corporation')).toEqual({ kind: 'create', form: 'invoice', party: 'Acme Corporation', lines: [] });
    expect(p('new invoice')).toEqual({ kind: 'create', form: 'invoice', lines: [] });
    expect(p('invoice Acme for consulting')).toEqual({ kind: 'create', form: 'invoice', party: 'Acme', lines: [{ text: 'consulting' }] });
  });

  it('bill from Staples 120 office supplies', () => {
    expect(p('bill from Staples 120 office supplies')).toEqual({
      kind: 'create',
      form: 'bill',
      party: 'Staples',
      lines: [{ text: 'office supplies', amount: '120' }],
    });
  });

  it.each([
    ['enter a bill from Staples for $120.50 office supplies', 'Staples', { text: 'office supplies', amount: '120.5' }],
    ['bill Staples $1,200 for printer paper', 'Staples', { text: 'printer paper', amount: '1200' }],
    ['got a bill from Comcast 89.99 internet', 'Comcast', { text: 'internet', amount: '89.99' }],
    ['vendor bill Staples 5 boxes paper at 30', 'Staples', { text: 'paper', quantity: '5', rate: '30' }],
    ['bill 120 office supplies from Staples', 'Staples', { text: 'office supplies', amount: '120' }],
  ])('%s', (cmd, party, line) => {
    const r = p(cmd);
    expect(r).toMatchObject({ kind: 'create', form: 'bill', party });
    expect(r && r.kind === 'create' && r.lines).toEqual([line]);
  });

  it('bill dated and with a memo', () => {
    expect(p('bill from Staples 120 office supplies on 10/3 memo toner reorder')).toEqual({
      kind: 'create',
      form: 'bill',
      party: 'Staples',
      date: '2026-10-03',
      memo: 'toner reorder',
      lines: [{ text: 'office supplies', amount: '120' }],
    });
    expect(p('bill from Staples 120 office supplies yesterday')).toMatchObject({ date: '2026-10-14' });
  });

  it.each([
    ['check to Shell $45.20 fuel', { party: 'Shell', lines: [{ text: 'fuel', amount: '45.2' }] }],
    ['write a check to Landlord Properties 2500 rent', { party: 'Landlord Properties', lines: [{ text: 'rent', amount: '2500' }] }],
    ['spent $45 on fuel at Shell', { party: 'Shell', lines: [{ text: 'fuel', amount: '45' }] }],
    ['paid Shell $45 for fuel', { party: 'Shell', lines: [{ text: 'fuel', amount: '45' }] }],
    ['bought fuel from Shell for $45', { party: 'Shell', lines: [{ text: 'fuel', amount: '45' }] }],
    ['expense Shell 45 fuel with Amex', { party: 'Shell', paymentAccount: 'Amex', lines: [{ text: 'fuel', amount: '45' }] }],
    ['check to Shell 45 fuel on the business card', { party: 'Shell', paymentAccount: 'business', lines: [{ text: 'fuel', amount: '45' }] }],
  ])('%s → check/expense', (cmd, expected) => {
    expect(p(cmd)).toMatchObject({ kind: 'create', form: 'expense', ...expected });
  });

  it('estimates and sales receipts', () => {
    expect(p('quote Acme 10 widgets at $12')).toEqual({
      kind: 'create',
      form: 'estimate',
      party: 'Acme',
      lines: [{ text: 'widgets', quantity: '10', rate: '12' }],
    });
    expect(p('estimate for Acme 40 hours design')).toMatchObject({ form: 'estimate', party: 'Acme', lines: [{ text: 'design', quantity: '40' }] });
    expect(p('sales receipt Acme $80 repair')).toMatchObject({ form: 'sales_receipt', party: 'Acme', lines: [{ text: 'repair', amount: '80' }] });
    expect(p('sold 2 widgets to Acme for $50')).toMatchObject({
      form: 'sales_receipt',
      party: 'Acme',
      lines: [{ text: 'widgets', quantity: '2', amount: '50' }],
    });
    expect(p('cash sale 3 widgets')).toMatchObject({ form: 'sales_receipt', lines: [{ text: 'widgets', quantity: '3' }] });
  });

  it('parseLine handles units, rates and money', () => {
    expect(parseLine('2.5 hrs bookkeeping @ $60/hr', 'invoice')).toEqual({ text: 'bookkeeping', quantity: '2.5', rate: '60' });
    expect(parseLine('$1.2k equipment', 'bill')).toEqual({ text: 'equipment', amount: '1200' });
    expect(parseLine('office supplies 120', 'bill')).toEqual({ text: 'office supplies', amount: '120' });
    expect(parseLine('10 widgets 4 each', 'invoice')).toEqual({ text: 'widgets', quantity: '10', rate: '4' });
  });
});

describe('reports', () => {
  it('show unpaid bills over 60 days', () => {
    expect(p('show unpaid bills over 60 days')).toEqual({ kind: 'report', report: 'unpaid_bills', overDays: 60 });
  });

  it.each([
    ['unpaid bills older than 30 days', { report: 'unpaid_bills', overDays: 30 }],
    ['list bills more than 90 days past due', { report: 'unpaid_bills', overDays: 90 }],
    ['bills 60+ days overdue', { report: 'unpaid_bills', overDays: 59 }],
    ['overdue bills', { report: 'unpaid_bills', overDays: 0 }],
    ['open bills from Staples', { report: 'unpaid_bills', party: 'Staples' }],
    ['unpaid bills', { report: 'unpaid_bills' }],
    ['what do we owe', { report: 'unpaid_bills' }],
    ['show me overdue invoices from Acme', { report: 'unpaid_invoices', overDays: 0, party: 'Acme' }],
    ['unpaid invoices over 45 days', { report: 'unpaid_invoices', overDays: 45 }],
    ['who owes us money', { report: 'unpaid_invoices' }],
    ['a/p aging', { report: 'ap_aging' }],
    ['AR aging', { report: 'ar_aging' }],
    ['p&l for last quarter', { report: 'profit_loss', from: '2026-07-01', to: '2026-09-30' }],
    ['profit and loss last month', { report: 'profit_loss', from: '2026-09-01', to: '2026-09-30' }],
  ])('%s', (cmd, expected) => {
    const r = p(cmd);
    expect(r).toMatchObject({ kind: 'report', ...expected });
    if (!('overDays' in expected)) expect(r).not.toHaveProperty('overDays');
    if (!('party' in expected)) expect(r).not.toHaveProperty('party');
  });

  it('report phrased as "go to"/"open"', () => {
    expect(p('open unpaid bills over 60 days')).toMatchObject({ kind: 'report', report: 'unpaid_bills', overDays: 60 });
  });
});

describe('questions', () => {
  it('what did we spend on fuel in Q3', () => {
    expect(p('what did we spend on fuel in Q3')).toEqual({
      kind: 'question',
      measure: 'spend',
      subject: 'fuel',
      from: '2026-07-01',
      to: '2026-09-30',
      rangeLabel: 'Q3 2026',
    });
  });

  it.each([
    ['How much did we spend at Staples last month?', 'spend', 'Staples', '2026-09-01', '2026-09-30'],
    ['how much have we spent on office supplies this year', 'spend', 'office supplies', '2026-01-01', '2026-12-31'],
    ['what was our fuel spending in Q1 2025', 'spend', 'fuel', '2025-01-01', '2025-03-31'],
    ['fuel expenses ytd', 'spend', 'fuel', '2026-01-01', '2026-10-15'],
    ['total spending on rent last year', 'spend', 'rent', '2025-01-01', '2025-12-31'],
    ['what did we pay Shell in September', 'spend', 'Shell', '2026-09-01', '2026-09-30'],
    ['how much did we make from Acme this year', 'income', 'Acme', '2026-01-01', '2026-12-31'],
    ['what were sales in the second quarter', 'income', undefined, '2026-04-01', '2026-06-30'],
    ['how much did we earn last quarter', 'income', undefined, '2026-07-01', '2026-09-30'],
    ['what did we spend on fuel from 2026-02-01 to 2026-02-28', 'spend', 'fuel', '2026-02-01', '2026-02-28'],
    ['how much did we spend on meals in the last 30 days', 'spend', 'meals', '2026-09-16', '2026-10-15'],
  ])('%s', (cmd, measure, subject, from, to) => {
    const r = p(cmd);
    expect(r).toMatchObject({ kind: 'question', measure, from, to });
    if (subject) expect(r).toMatchObject({ subject });
    else expect(r).not.toHaveProperty('subject');
  });

  it('a question without a period means year to date', () => {
    expect(p('how much did we spend on fuel')).toMatchObject({ from: '2026-01-01', to: '2026-10-15', subject: 'fuel' });
  });

  it('a bare page word still navigates (no period, no question)', () => {
    expect(p('expenses')).toBeNull();
    expect(p('show expenses')).toEqual({ kind: 'navigate', target: 'expenses' });
  });
});

describe('actions and navigation', () => {
  it.each([
    ['pay bills', { kind: 'action', action: 'pay_bills' }],
    ['pay my bills', { kind: 'action', action: 'pay_bills' }],
    ['reconcile checking', { kind: 'action', action: 'reconcile', target: 'checking' }],
    ['reconcile the Amex account', { kind: 'action', action: 'reconcile', target: 'Amex' }],
    ['reconcile', { kind: 'action', action: 'reconcile' }],
    ['record deposit', { kind: 'action', action: 'record_deposit' }],
    ['make a deposit', { kind: 'action', action: 'record_deposit' }],
    ['receive payment from Acme', { kind: 'action', action: 'receive_payment', target: 'Acme' }],
    ['got paid by Acme', { kind: 'action', action: 'receive_payment', target: 'Acme' }],
    ['transfer money', { kind: 'action', action: 'transfer_funds' }],
    ['new journal entry', { kind: 'action', action: 'journal_entry' }],
    ['run payroll', { kind: 'action', action: 'run_payroll' }],
    ['go to chart of accounts', { kind: 'navigate', target: 'chart of accounts' }],
    ['take me to the vendor center', { kind: 'navigate', target: 'vendor center' }],
  ])('%s', (cmd, expected) => {
    expect(p(cmd)).toEqual(expected);
  });

  it('unrecognized text returns null (falls back to search / AI)', () => {
    expect(p('the quick brown fox')).toBeNull();
    expect(p('')).toBeNull();
    expect(p('   ')).toBeNull();
    expect(p('Acme')).toBeNull();
  });

  it('every grammar result is a valid intent per the shared zod schema', () => {
    for (const cmd of [
      'invoice Acme 3 hours consulting',
      'bill from Staples 120 office supplies',
      'show unpaid bills over 60 days',
      'what did we spend on fuel in Q3',
      'reconcile checking',
      'go to payroll',
    ]) {
      const r = p(cmd)!;
      expect(commandIntentSchema.safeParse(r).success, cmd).toBe(true);
      expect(describeIntent(r).length).toBeGreaterThan(5);
    }
  });
});

describe('dates', () => {
  const r = (s: string) => parseDateRange(s, TODAY)?.range;
  it('quarters', () => {
    expect(r('in Q3')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(r('Q4')).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
    expect(r('q1 2025')).toMatchObject({ from: '2025-01-01', to: '2025-03-31' });
    expect(r("Q2 '24")).toMatchObject({ from: '2024-04-01', to: '2024-06-30' });
    expect(r('this quarter')).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
    expect(r('last quarter')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(r('QTD')).toMatchObject({ from: '2026-10-01', to: '2026-10-15' });
  });
  it('a future quarter or month without a year means last year', () => {
    const may = new Date(Date.UTC(2026, 4, 10));
    expect(parseDateRange('Q3', may)?.range).toMatchObject({ from: '2025-07-01', to: '2025-09-30' });
    expect(parseDateRange('in December', may)?.range).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    const jan = new Date(Date.UTC(2026, 0, 10));
    expect(parseDateRange('last month', jan)?.range).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(parseDateRange('last quarter', jan)?.range).toMatchObject({ from: '2025-10-01', to: '2025-12-31' });
  });
  it('months, years, YTD, rolling', () => {
    expect(r('last month')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(r('this month')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(r('MTD')).toMatchObject({ from: '2026-10-01', to: '2026-10-15' });
    expect(r('this year')).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(r('YTD')).toMatchObject({ from: '2026-01-01', to: '2026-10-15' });
    expect(r('year to date')).toMatchObject({ from: '2026-01-01', to: '2026-10-15' });
    expect(r('last year')).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    expect(r('in 2024')).toMatchObject({ from: '2024-01-01', to: '2024-12-31' });
    expect(r('in February')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(r('for sep 2025')).toMatchObject({ from: '2025-09-01', to: '2025-09-30' });
    expect(r('last 7 days')).toMatchObject({ from: '2026-10-09', to: '2026-10-15' });
    expect(r('past 3 months')).toMatchObject({ from: '2026-07-16', to: '2026-10-15' });
    expect(r('since March')).toMatchObject({ from: '2026-03-01', to: '2026-10-15' });
    expect(r('this week')).toMatchObject({ from: '2026-10-12', to: '2026-10-18' });
    expect(r('last week')).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
    expect(r('between 1/1/2026 and 3/31/2026')).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    expect(r('nothing here')).toBeUndefined();
  });
  it('"may" as a verb is not a month', () => {
    expect(parseDateRange('we may need it', TODAY)).toBeNull();
    expect(r('in May')).toMatchObject({ from: '2026-05-01', to: '2026-05-31' });
  });
  it('single dates and invalid dates', () => {
    expect(parseSingleDate('on Oct 3', TODAY)?.date).toBe('2026-10-03');
    expect(parseSingleDate('dated 2026-02-28', TODAY)?.date).toBe('2026-02-28');
    expect(parseSingleDate('today', TODAY)?.date).toBe('2026-10-15');
    expect(parseExplicitDate('2026-02-30', TODAY)).toBeNull();
    expect(parseExplicitDate('13/1/2026', TODAY)).toBeNull();
    expect(parseExplicitDate('3rd March 2025', TODAY)).toBe('2025-03-03');
  });
});

describe('numbers', () => {
  it('parses money tokens exactly (no floats)', () => {
    expect(parseNumber('$1,234.50')).toBe('1234.5');
    expect(parseNumber('0.10')).toBe('0.1');
    expect(parseNumber('1.2k')).toBe('1200');
    expect(parseNumber('2.5005k')).toBe('2500.5');
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('name matching (ambiguity → asks to choose)', () => {
  const names = [
    { id: '1', name: 'Acme Corporation' },
    { id: '2', name: 'Acme Industries' },
    { id: '3', name: 'Bayside Bakery', alt: ['Bayside Bakery LLC'] },
    { id: '4', name: 'Office Supplies' },
    { id: '5', name: 'Fuel' },
    { id: '6', name: 'Fuel Surcharges' },
  ];
  it('one clear match', () => {
    expect(pickName('bayside', names)).toMatchObject({ status: 'one', match: { id: '3' } });
    expect(pickName('acme corp', names)).toMatchObject({ status: 'one', match: { id: '1' } });
    expect(pickName('office supply', names)).toMatchObject({ status: 'one', match: { id: '4' } });
    expect(pickName('fuel', names)).toMatchObject({ status: 'one', match: { id: '5' } });
    expect(pickName('Bayside Bakery LLC', names)).toMatchObject({ status: 'one', match: { id: '3' } });
  });
  it('ambiguous names return every close candidate', () => {
    const r = pickName('Acme', names);
    expect(r.status).toBe('many');
    expect(r.status === 'many' && r.matches.map((m) => m.id).sort()).toEqual(['1', '2']);
  });
  it('no match', () => {
    expect(pickName('Zebra', names)).toEqual({ status: 'none' });
    expect(rankNames('', names)).toEqual([]);
  });
});

describe('AI reply schema', () => {
  it('accepts a structured intent with numeric amounts and normalizes them', () => {
    const r = aiIntentReplySchema.parse({
      intent: { kind: 'create', form: 'bill', party: 'Staples', lines: [{ text: 'paper', amount: 120.5 }] },
    });
    expect(r.intent).toMatchObject({ lines: [{ amount: '120.5' }] });
  });
  it('rejects anything that is not one of the known intents', () => {
    expect(aiIntentReplySchema.safeParse({ intent: { kind: 'post_journal', amount: 5 } }).success).toBe(false);
    expect(aiIntentReplySchema.safeParse({ intent: { kind: 'create', form: 'payroll' } }).success).toBe(false);
    expect(aiIntentReplySchema.safeParse({ intent: { kind: 'create', form: 'bill', lines: [{ amount: '-5' }] } }).success).toBe(false);
    expect(aiIntentReplySchema.parse({ intent: null }).intent).toBeNull();
  });
});

describe('prefill handoff (sessionStorage)', () => {
  function mem() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      raw: m,
    };
  }
  const prefill = {
    kind: 'invoice' as const,
    customerId: '11111111-1111-4111-8111-111111111111',
    lines: [{ description: 'Consulting', quantity: '3', rate: '150' }],
  };
  it('is single-use and only for its own form', () => {
    const s = mem();
    expect(stashPrefill(s, prefill, 1000)).toBe(true);
    expect(takePrefill(s, 'bill', 1000)).toBeNull();
    expect(takePrefill(s, 'invoice', 1000)).toMatchObject({ customerId: prefill.customerId, lines: prefill.lines });
    expect(takePrefill(s, 'invoice', 1000)).toBeNull();
  });
  it('expires', () => {
    const s = mem();
    stashPrefill(s, prefill, 1000);
    expect(takePrefill(s, 'invoice', 1000 + PREFILL_TTL_MS + 1)).toBeNull();
    expect(s.raw.has(PREFILL_STORAGE_KEY)).toBe(false);
  });
  it('rejects tampered or malformed entries', () => {
    const s = mem();
    s.setItem(PREFILL_STORAGE_KEY, '{not json');
    expect(takePrefill(s, 'invoice', 1000)).toBeNull();
    s.setItem(PREFILL_STORAGE_KEY, JSON.stringify({ at: 1000, prefill: { ...prefill, customerId: 'not-a-uuid' } }));
    expect(takePrefill(s, 'invoice', 1000)).toBeNull();
    expect(stashPrefill(s, { ...prefill, lines: [{ amount: '1e9' }] } as never, 1000)).toBe(false);
  });
});

describe('permission filtering of actions and pages', () => {
  const viewer = normalizeGrant({
    customers: ['view'],
    vendors: ['view'],
    reports_purchases: ['view'],
  });
  const salesClerk = normalizeGrant({ customers: ['view', 'create'] });

  it('null permissions (not loaded yet) show everything, like the sidebar', () => {
    expect(visibleActions(null).length).toBeGreaterThan(10);
  });
  it('a view-only role gets no create actions', () => {
    const keys = visibleActions(viewer).map((a) => a.key);
    expect(keys).not.toContain('new-invoice');
    expect(keys).not.toContain('enter-bill');
    expect(keys).toContain('unpaid-bills');
    expect(keys).not.toContain('reconcile');
  });
  it('a sales clerk sees sales actions only', () => {
    const keys = visibleActions(salesClerk).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(['new-invoice', 'new-estimate', 'receive-payment']));
    expect(keys).not.toContain('pay-bills');
    expect(keys).not.toContain('write-check');
    expect(keys).not.toContain('run-payroll');
  });
  it('filterActions matches words and respects feature switches', () => {
    expect(filterActions('invoice', salesClerk).map((a) => a.key)).toContain('new-invoice');
    expect(filterActions('estimate', salesClerk, new Set(['/estimates']))).toEqual([]);
    expect(filterActions('pay bills', emptyPermissionSet())).toEqual([]);
  });
  it('pages need view of their area', () => {
    expect(canOpenHref('/reconcile', salesClerk)).toBe(false);
    expect(canOpenHref('/invoices?new=1', salesClerk)).toBe(true);
    expect(canOpenHref('/help', salesClerk)).toBe(true);
  });
});
