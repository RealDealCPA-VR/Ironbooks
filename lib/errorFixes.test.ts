/**
 * "Fix errors where they happen" — pure helpers (lib/errorFixes.ts): patch application,
 * parsing of untrusted `fixes`, and every fix builder with exact (Decimal) amounts.
 */
import { describe, expect, it } from 'vitest';
import {
  appliedExceedsPaymentFixes,
  applyFixPatch,
  balanceFixes,
  balanceSummary,
  closedPeriodFixes,
  creditLimitFixes,
  depositMismatchFixes,
  duplicateNumberFixes,
  friendlyDate,
  getPath,
  missingAccountFixes,
  missingClassFixes,
  negativeStockFixes,
  negativeStockMessage,
  nextDay,
  overAppliedFixes,
  parseFixes,
  parseLinePath,
  removeTaxFixes,
  retryPayloads,
  stickyFlags,
  type ErrorFix,
} from './errorFixes';

describe('applyFixPatch (pure)', () => {
  const body = {
    date: '2026-01-15',
    lines: [
      { accountId: 'a', debit: '100.00', credit: undefined },
      { accountId: 'b', debit: undefined, credit: '60.00' },
    ],
    paymentIds: ['p1', 'p2', 'p3'],
  };

  it('never mutates the input', () => {
    const before = JSON.stringify(body);
    applyFixPatch(body, [
      { op: 'set', path: 'date', value: '2026-02-01' },
      { op: 'add', path: 'lines.1.credit', amount: '40.00' },
      { op: 'pull', path: 'paymentIds', value: 'p2' },
      { op: 'remove', path: 'lines.0' },
    ]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it('set replaces values and creates missing parents', () => {
    const out = applyFixPatch(body, [
      { op: 'set', path: 'date', value: '2026-02-01' },
      { op: 'set', path: 'cashBack.amount', value: '5.00' },
      { op: 'set', path: 'allowDuplicateNumber', value: true },
    ]);
    expect(out.date).toBe('2026-02-01');
    expect(getPath(out, 'cashBack.amount')).toBe('5.00');
    expect(getPath(out, 'allowDuplicateNumber')).toBe(true);
  });

  it('add is Decimal-exact (0.1 + 0.2 = 0.30) and works on blank / numeric / comma values', () => {
    const out = applyFixPatch(
      { a: '0.1', b: undefined, c: 12.5, d: '1,250.10', e: 'abc' },
      [
        { op: 'add', path: 'a', amount: '0.2' },
        { op: 'add', path: 'b', amount: '40.00' },
        { op: 'add', path: 'c', amount: '-2.25' },
        { op: 'add', path: 'd', amount: '0.90' },
        { op: 'add', path: 'e', amount: '1' },
      ],
    );
    expect(out).toEqual({ a: '0.30', b: '40.00', c: '10.25', d: '1251.00', e: '1.00' });
  });

  it('adds into array elements by index', () => {
    const out = applyFixPatch(body, [{ op: 'add', path: 'lines.1.credit', amount: '40.00' }]);
    expect(out.lines[1].credit).toBe('100.00');
    expect(out.lines[0]).toBe(body.lines[0]); // untouched branches are shared
  });

  it('pull removes matching array elements; remove deletes props and elements', () => {
    const out = applyFixPatch(body, [
      { op: 'pull', path: 'paymentIds', value: 'p2' },
      { op: 'remove', path: 'lines.0' },
      { op: 'remove', path: 'date' },
      { op: 'remove', path: 'missing.path' },
    ]);
    expect(out.paymentIds).toEqual(['p1', 'p3']);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].accountId).toBe('b');
    expect('date' in out).toBe(false);
    expect('missing' in out).toBe(false);
  });

  it('no patch returns the same object', () => {
    expect(applyFixPatch(body, undefined)).toBe(body);
    expect(applyFixPatch(body, [])).toBe(body);
  });
});

describe('parseFixes (untrusted input)', () => {
  it('keeps well-formed fixes and drops malformed ones', () => {
    const fixes = parseFixes([
      { id: 'a', label: 'Add', kind: 'patch', patch: [{ op: 'add', path: 'x', amount: '1.00' }] },
      { id: 'b', label: 'Go', kind: 'navigate', href: '/fiscal-periods' },
      { id: 'c', label: 'Retry', kind: 'retry', needs: 'closingPassword', hint: 'h' },
      { id: 'd', label: 'Evil', kind: 'navigate', href: 'https://evil.example' }, // external link
      { id: 'e', label: 'Empty patch', kind: 'patch', patch: [] },
      { id: 'f', label: 'Bad op', kind: 'patch', patch: [{ op: 'add', path: 'x', amount: 'NaN' }] },
      { id: 'g', label: 'Bad kind', kind: 'explode' },
      null,
      'nope',
    ]);
    expect(fixes.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(fixes[2]).toEqual({ id: 'c', label: 'Retry', kind: 'retry', needs: 'closingPassword', hint: 'h' });
    expect(parseFixes(undefined)).toEqual([]);
    expect(parseFixes({})).toEqual([]);
  });
});

describe('path helpers', () => {
  it('parseLinePath', () => {
    expect(parseLinePath('lines.3.credit')).toEqual({ collection: 'lines', index: 3, field: 'credit' });
    expect(parseLinePath('applications.0.amountApplied')).toEqual({ collection: 'applications', index: 0, field: 'amountApplied' });
    expect(parseLinePath('date')).toBeNull();
  });
  it('dates', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2024-02-28')).toBe('2024-02-29');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(friendlyDate('2026-02-01')).toBe('Feb 1, 2026');
  });
});

describe('balance fixes (journal entry / split out of balance)', () => {
  it('debits $40.00 more: add $40.00 to the last credit line (line 3)', () => {
    const lines = [
      { debit: '100.00', credit: '' },
      { debit: '', credit: '30.00' },
      { debit: '', credit: '30.00' },
    ];
    expect(balanceSummary(lines)).toEqual({
      totalDebit: '100.00',
      totalCredit: '60.00',
      difference: '40.00',
      message: 'Debits are $40.00 more than credits.',
    });
    const fixes = balanceFixes(lines);
    expect(fixes[0]).toEqual({
      id: 'balance-add',
      kind: 'patch',
      label: "Add $40.00 to line 3's credit",
      patch: [{ op: 'add', path: 'lines.2.credit', amount: '40.00' }],
    });
    // Alternative: lower the debit on line 1 (100 → 60).
    expect(fixes[1]).toEqual({
      id: 'balance-lower',
      kind: 'patch',
      label: "Lower line 1's debit by $40.00",
      patch: [{ op: 'add', path: 'lines.0.debit', amount: '-40.00' }],
    });
    // Applying the primary fix balances the entry exactly.
    const fixed = applyFixPatch({ lines }, fixes[0].patch).lines;
    expect(balanceSummary(fixed).difference).toBe('0.00');
    expect(fixed[2].credit).toBe('70.00');
  });

  it('credits more: adds the gap to the debit side; Decimal-exact with cents', () => {
    const lines = [
      { debit: '0.10', credit: null },
      { debit: '0.20', credit: null },
      { debit: null, credit: '1000.33' },
    ];
    const s = balanceSummary(lines);
    expect(s.difference).toBe('-1000.03');
    expect(s.message).toBe('Credits are $1,000.03 more than debits.');
    const [add] = balanceFixes(lines);
    expect(add.patch).toEqual([{ op: 'add', path: 'lines.1.debit', amount: '1000.03' }]);
    expect(balanceSummary(applyFixPatch({ lines }, add.patch).lines).difference).toBe('0.00');
  });

  it('honours a chosen line, falls back to an empty line, and returns nothing when balanced', () => {
    const lines = [
      { debit: '50.00', credit: '' },
      { debit: '', credit: '' },
      { debit: '', credit: '20.00' },
    ];
    expect(balanceFixes(lines, { lineIndex: 1 })[0].patch).toEqual([{ op: 'add', path: 'lines.1.credit', amount: '30.00' }]);
    expect(balanceFixes([{ debit: '50', credit: '' }, { debit: '', credit: '' }])[0].patch).toEqual([
      { op: 'add', path: 'lines.1.credit', amount: '50.00' },
    ]);
    expect(balanceFixes([{ debit: '5', credit: '' }, { debit: '', credit: '5.00' }])).toEqual([]);
  });

  it('custom path and line numbers in labels', () => {
    const [fix] = balanceFixes([{ debit: '10' }, { credit: '4' }], { path: 'splits', lineNumbers: [7, 9] });
    expect(fix.label).toBe("Add $6.00 to line 9's credit");
    expect(fix.patch?.[0].path).toBe('splits.1.credit');
  });
});

describe('closed period fixes', () => {
  it('closing date: move to the first open date, or enter the password', () => {
    const fixes = closedPeriodFixes({ reason: 'closingDate', firstOpenDate: '2026-02-01' });
    expect(fixes).toEqual([
      {
        id: 'period-move-date',
        kind: 'patch',
        label: 'Move the date to Feb 1, 2026 (first open date)',
        patch: [{ op: 'set', path: 'date', value: '2026-02-01' }],
      },
      expect.objectContaining({ id: 'period-password', kind: 'retry', needs: 'closingPassword' }),
    ]);
  });
  it('closed fiscal period: reopen it instead of a password', () => {
    const fixes = closedPeriodFixes({ reason: 'fiscalPeriod', firstOpenDate: null, dateField: 'txnDate' });
    expect(fixes).toEqual([{ id: 'period-reopen', kind: 'navigate', label: 'Reopen the period (Fiscal Periods)', href: '/fiscal-periods' }]);
  });
});

describe('other builders', () => {
  it('duplicate number: next free number + keep anyway', () => {
    const fixes = duplicateNumberFixes({
      number: '1042',
      nextNumber: '1043',
      field: 'refNumber',
      overrideFlag: { path: 'allowDuplicateNumber', value: true },
      label: 'invoice number',
    });
    expect(fixes.map((f) => [f.id, f.kind, f.label])).toEqual([
      ['docnum-next', 'patch', 'Use the next free invoice number, 1043'],
      ['docnum-keep', 'retry', 'Keep 1042 anyway'],
    ]);
    expect(applyFixPatch({ refNumber: '1042' }, fixes[0].patch)).toEqual({ refNumber: '1043' });
    expect(applyFixPatch({}, fixes[1].patch)).toEqual({ allowDuplicateNumber: true });
    // No next number (vendor reference) → only "keep".
    expect(duplicateNumberFixes({ number: 'A1', nextNumber: null, field: 'billNumber', overrideFlag: { path: 'allowDuplicateNumber', value: true } }).map((f) => f.id)).toEqual(['docnum-keep']);
  });

  it('credit limit: save anyway via the existing override flag', () => {
    const [save, review] = creditLimitFixes({ customerId: 'c-1' });
    expect(save).toMatchObject({ id: 'credit-limit-override', kind: 'retry', label: 'Save anyway' });
    expect(applyFixPatch({}, save.patch)).toEqual({ overrideCreditLimit: true });
    expect(review).toMatchObject({ kind: 'navigate', href: '/customers?focus=c-1' });
    expect(creditLimitFixes()).toHaveLength(1);
  });

  it('missing account / class: pick the default', () => {
    const [acct] = missingAccountFixes({
      paths: ['lines.1.accountId'],
      account: { id: 'acc-6300', name: 'Office Supplies', code: '6300' },
      lineNumbers: [2],
    });
    expect(acct.label).toBe('Use 6300 Office Supplies on line 2');
    expect(acct.patch).toEqual([{ op: 'set', path: 'lines.1.accountId', value: 'acc-6300' }]);
    expect(missingAccountFixes({ paths: ['a'], account: null })).toEqual([]);
    const cls = missingClassFixes({ paths: ['classId'], suggested: { id: 'k1', name: 'East' } });
    expect(cls.map((f) => f.id)).toEqual(['class-default', 'class-skip']);
    expect(applyFixPatch({ classId: null }, cls[0].patch)).toEqual({ classId: 'k1' });
    expect(missingClassFixes({ paths: ['classId'], suggested: null }).map((f) => f.id)).toEqual(['class-skip']);
  });

  it('negative inventory: continue, sell only what is on hand, or adjust', () => {
    const short = [{ itemId: 'i1', name: 'Widget', need: '5', have: '2', lineIndexes: [1] }];
    const fixes = negativeStockFixes(short, { continuePatch: [{ op: 'set', path: 'checkStock', value: false }] });
    expect(fixes.map((f) => f.id)).toEqual(['stock-continue', 'stock-reduce', 'stock-adjust']);
    expect(fixes[1].label).toBe('Sell only the 2 on hand');
    expect(applyFixPatch({ lines: [{}, { quantity: '5' }] }, fixes[1].patch).lines[1].quantity).toBe('2');
    expect(applyFixPatch({ checkStock: true }, fixes[0].patch)).toEqual({ checkStock: false });
    expect(negativeStockMessage(short)).toContain('Widget: selling 5, only 2 on hand');
    // Nothing on hand, or the item on two lines → no "reduce" fix.
    expect(negativeStockFixes([{ ...short[0], have: '0' }]).map((f) => f.id)).toEqual(['stock-continue', 'stock-adjust']);
    expect(negativeStockFixes([{ ...short[0], lineIndexes: [0, 1] }]).map((f) => f.id)).not.toContain('stock-reduce');
  });

  it('sales tax off: remove the header and line tax', () => {
    const [remove, turnOn] = removeTaxFixes({ headerTax: true, linePaths: ['lines.2.taxRateId'] });
    expect(applyFixPatch({ taxRateId: 't', lines: [{}, {}, { taxRateId: 't2' }] }, remove.patch)).toEqual({
      taxRateId: null,
      lines: [{}, {}, { taxRateId: null }],
    });
    expect(turnOn.kind).toBe('navigate');
  });

  it('over-applied payment: apply exactly the balance (after discount + credits)', () => {
    const [fix] = overAppliedFixes({ path: 'applications.0.amountApplied', balanceDue: '100.10', otherApplied: '10.05', label: 'invoice #7' });
    expect(fix.label).toBe('Apply exactly $90.05 to invoice #7 (the balance due)');
    expect(fix.patch).toEqual([{ op: 'set', path: 'applications.0.amountApplied', value: '90.05' }]);
    expect(overAppliedFixes({ path: 'x', balanceDue: '5', otherApplied: '6', label: 'y' })).toEqual([]);
    expect(overAppliedFixes({ path: 'x', balanceDue: '5', otherApplied: '5', label: 'y', allowZero: false })).toEqual([]);
    // Discount + several credits passed as parts: summed with Decimal (0.1 + 0.2 is exactly 0.30).
    const [parts] = overAppliedFixes({ path: 'applications.1.amountApplied', balanceDue: '100.00', otherApplied: ['0.10', '0.20', null as unknown as string, ''], label: 'invoice #8' });
    expect(parts.patch).toEqual([{ op: 'set', path: 'applications.1.amountApplied', value: '99.70' }]);
  });

  it('applications exceed the payment: raise the amount, or trim the last application', () => {
    const fixes = appliedExceedsPaymentFixes({
      paymentAmount: '150.00',
      applications: [
        { path: 'applications.0.amountApplied', amount: '100.00', label: 'invoice #1' },
        { path: 'applications.1.amountApplied', amount: '75.55', label: 'invoice #2' },
      ],
    });
    expect(fixes).toEqual([
      { id: 'payment-raise', kind: 'patch', label: 'Change the amount received to $175.55', patch: [{ op: 'set', path: 'amount', value: '175.55' }] },
      { id: 'payment-trim', kind: 'patch', label: 'Apply $25.55 less to invoice #2', patch: [{ op: 'set', path: 'applications.1.amountApplied', value: '50.00' }] },
    ]);
    expect(appliedExceedsPaymentFixes({ paymentAmount: '10', applications: [{ path: 'p', amount: '10', label: 'l' }] })).toEqual([]);
  });

  it('deposit / undeposited mismatch: take the items off the deposit', () => {
    const fixes: ErrorFix[] = depositMismatchFixes({ paymentIds: ['p1'], salesReceiptIds: ['s1'], reason: 'already_deposited' });
    expect(fixes[0].label).toBe('Take these 2 off this deposit (already deposited)');
    expect(applyFixPatch({ paymentIds: ['p1', 'p2'], salesReceiptIds: ['s1'] }, fixes[0].patch)).toEqual({
      paymentIds: ['p2'],
      salesReceiptIds: [],
    });
    expect(depositMismatchFixes({ reason: 'voided' })).toEqual([]);
  });
});

describe('retrying a fix (pure)', () => {
  type Body = { amount: string; applications: { invoiceId: string; amountApplied: string }[] };
  const clean = (b: Body): Body => ({ ...b, applications: b.applications.filter((a) => Number(a.amountApplied) > 0) });

  it('a second error is reported against the body the server saw (zero applications dropped)', () => {
    const payload: Body = {
      amount: '50.00',
      applications: [
        { invoiceId: 'A', amountApplied: '10.00' },
        { invoiceId: 'B', amountApplied: '30.00' },
        { invoiceId: 'C', amountApplied: '20.00' },
      ],
    };
    // Fix 1 sets invoice A to 0.00: the form keeps the row (patched), the server never sees it (sent).
    const first = retryPayloads(payload, [{ op: 'set', path: 'applications.0.amountApplied', value: '0.00' }], clean);
    expect(first.patched.applications.map((a) => a.invoiceId)).toEqual(['A', 'B', 'C']);
    expect(first.sent.applications.map((a) => a.invoiceId)).toEqual(['B', 'C']);
    // The server's next fix indexes the sent body: applications.1 is invoice C, not B.
    const second = retryPayloads(first.sent, [{ op: 'set', path: 'applications.1.amountApplied', value: '15.00' }], clean);
    expect(second.patched.applications).toEqual([
      { invoiceId: 'B', amountApplied: '30.00' },
      { invoiceId: 'C', amountApplied: '15.00' },
    ]);
  });

  it('without prepare the sent body is the patched body', () => {
    const body = { date: '2026-01-10' };
    const r = retryPayloads(body, [{ op: 'set', path: 'date', value: '2026-02-01' }]);
    expect(r.sent).toBe(r.patched);
    expect(r.sent.date).toBe('2026-02-01');
  });

  it('stickyFlags keeps the request flags a fix set (Save anyway / Sell anyway)', () => {
    const fix: Pick<ErrorFix, 'patch'> = {
      patch: [
        { op: 'set', path: 'checkStock', value: false },
        { op: 'set', path: 'lines.0.quantity', value: 2 },
      ],
    };
    expect(stickyFlags(fix, ['overrideCreditLimit', 'checkStock'])).toEqual({ checkStock: false });
    expect(stickyFlags({ patch: [{ op: 'set', path: 'overrideCreditLimit', value: true }] }, ['overrideCreditLimit'])).toEqual({
      overrideCreditLimit: true,
    });
    expect(stickyFlags({}, ['checkStock'])).toEqual({});
  });
});
