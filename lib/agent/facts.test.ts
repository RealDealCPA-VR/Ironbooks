/**
 * The facts of one request (lib/agent/facts.ts): what the policy and grant matching read. Every
 * case also checks the fail-closed side: an amount too small, a count of 0 for "unknown", or a name
 * or date that was missed would let a request run under Allow or under a grant it should not.
 */
import { describe, expect, it } from 'vitest';
import type { OperationInput } from './contract';
import { UNREADABLE_ID, amountOf, amountShown, factsOf } from './facts';
import type { Operation } from './operations/types';

function op(over: Partial<Operation> = {}): Operation {
  return {
    id: 'invoices.create',
    kind: 'route',
    route: '/api/invoices',
    method: 'POST',
    params: [],
    rule: { area: 'customers', action: 'create' },
    area: 'customers',
    action: 'create',
    activity: null,
    classified: true,
    class: 'enter',
    describe: 'Enter an invoice',
    availability: 'agent',
    why: null,
    dryRun: 'transaction',
    body: 'json',
    output: 'json',
    confirmFlags: [],
    sensitiveFields: [],
    reveal: null,
    hostOnly: false,
    fileAdmin: false,
    needsSecret: [],
    producesSecret: [],
    effects: [],
    countField: null,
    amountField: null,
    alwaysAsk: false,
    bodySchema: null,
    ...over,
  };
}

const facts = (o: Operation, input: OperationInput, closingDate: string | null = null, answer?: unknown) =>
  factsOf(o, input, answer === undefined ? { closingDate } : { closingDate, answer });

describe('factsOf: confirm and reveal', () => {
  const flagged = op({ confirmFlags: ['allowDuplicateNumber', 'statement.acknowledgeDifference'] });

  it.each([
    [{ confirm: ['allowDuplicateNumber'] }, ['allowDuplicateNumber']],
    [{ body: { allowDuplicateNumber: true } }, ['allowDuplicateNumber']],
    [{ body: { statement: { acknowledgeDifference: true } } }, ['statement.acknowledgeDifference']],
    [{ body: { allowDuplicateNumber: false } }, []],
    // Kept even when unlisted: a flag the policy sees can only make it stricter.
    [{ confirm: ['allowLedgerRewrite', 'allowLedgerRewrite', 7] as never }, ['allowLedgerRewrite']],
    [{}, []],
  ])('%j confirms %j', (input, confirm) => {
    expect(facts(flagged, input as OperationInput).confirm).toEqual(confirm);
  });

  it.each([
    [{ reveal: true }, true],
    [{ reveal: 'yes' as never }, false],
    [{}, false],
  ])('%j reveals: %s', (input, reveal) => {
    expect(facts(op(), input).reveal).toBe(reveal);
  });
});

describe('factsOf: amount', () => {
  const total = op({ amountField: 'total' });

  it.each([
    ['body only', { total: '1042.50' }, undefined, '1042.50'],
    ['a number in the body', { total: 99 }, undefined, '99.00'],
    ['answer only', {}, { total: '250.00' }, '250.00'],
    // The agent's "total": 1 in a body the route ignores never makes it look small.
    ['the larger of body and answer', { total: '1' }, { total: '1000000.00' }, '1000000.00'],
    ['the larger by size, a refund included', { total: '-5000' }, { total: '10' }, '-5000.00'],
    ['decimal text without floating point', { total: '0.30000000000000000001' }, { total: '0.3' }, '0.30000000000000000001'],
    ['nothing in either', {}, { other: 1 }, null],
    ['text that is not an amount', { total: '1,000' }, undefined, null],
    ['an answer that is not an amount', { total: '5' }, { total: { value: 5 } }, null],
    ['an empty value', { total: '' }, undefined, null],
  ])('%s', (_label, bodyIn, answer, amount) => {
    expect(facts(total, { body: bodyIn }, null, answer).amount).toBe(amount);
  });

  it('reads a dotted path', () => {
    expect(facts(op({ amountField: 'payment.amount' }), { body: { payment: { amount: '12.5' } } }).amount).toBe('12.50');
  });

  it('adds up the sizes of one amount per line when the path has *', () => {
    expect(facts(op({ amountField: 'applied.*.glAmount' }), { body: {} }, null, { applied: [{ glAmount: '10' }, { glAmount: '-2.5' }] }).amount).toBe('12.50');
  });

  it('has no amount when the operation names none', () => {
    expect(facts(op(), { body: { total: '5' } }).amount).toBeNull();
    expect(amountOf(op(), { body: { total: '5' } })).toBeNull();
    expect(amountShown(op(), { body: { total: '5' } })).toBeNull();
  });
});

describe('amountShown: the amount a person reads on the card', () => {
  const total = op({ amountField: 'total' });

  it.each([
    ['as amountOf when both can be read', { total: '1' }, { total: '9000.00' }, '9000.00'],
    // amountOf is null here (the policy treats it as over every limit); the card still shows the figure.
    ['junk in the body, the real figure in the answer', { total: 'n/a' }, { total: '9000.00' }, '9000.00'],
    ['junk in the body, a negative figure in the answer', { total: 'n/a', other: 1 }, { total: '-75' }, '-75.00'],
    // The route's answer beats the body: the body's figure is one the route did not use.
    ['junk in the answer, a figure in the body', { total: '12' }, { total: { value: 5 } }, 'unreadable'],
    ['junk in the answer, none in the body', {}, { total: 'n/a' }, 'unreadable'],
    ['junk and nothing else', { total: 'n/a' }, undefined, 'unreadable'],
    ['junk in the body, an answer without a figure', { total: 'n/a' }, { id: 'x' }, 'unreadable'],
    // No figure at all is not a figure of 0: the policy reads it as over every limit, and the card says it is not known.
    ['nothing at all', {}, undefined, 'unreadable'],
    ['nothing in the body or the answer', {}, { id: 'x' }, 'unreadable'],
    ['a figure in the body, an answer without one', { total: '12' }, { id: 'x' }, '12.00'],
  ])('%s', (_label, bodyIn, answer, shown) => {
    expect(amountShown(total, { body: bodyIn }, answer)).toBe(shown);
  });

  it('never changes what the policy reads', () => {
    expect(facts(total, { body: { total: 'n/a' } }, null, { total: '9000.00' }).amount).toBeNull();
    expect(facts(total, { body: { total: '12' } }, null, { total: { value: 5 } }).amount).toBeNull();
    expect(facts(total, { body: {} }).amount).toBeNull();
  });
});

describe('factsOf: count', () => {
  const bulk = op({ class: 'bulk', countField: 'ids' });

  it.each([
    ['the length of the list', { ids: ['a', 'b', 'c'] }, undefined, 3],
    ['no list: unknown, never 0', {}, undefined, null],
    // Some routes read an empty selection as "every line".
    ['an empty list: unknown, never 0', { ids: [] }, undefined, null],
    ['not a list', { ids: 'all' }, undefined, null],
    ['what the answer says it did', {}, { ids: 12 }, 12],
    ['the larger of body and answer', { ids: ['a'] }, { ids: ['a', 'b', 'c', 'd'] }, 4],
    ['an answer of 0 stays unknown', {}, { ids: 0 }, null],
  ])('%s', (_label, bodyIn, answer, count) => {
    expect(facts(bulk, { body: bodyIn }, null, answer).count).toBe(count);
  });
});

describe('factsOf: names and accounts', () => {
  it('gathers names from the top level, the lines, lists of names, and the answer', () => {
    const f = facts(
      op(),
      { body: { customerId: 'c1', lines: [{ accountId: 'a1', entityId: 'v9' }, { accountId: 'a2', customerId: 'c1' }], employeeIds: ['e1', 'e2'], vendorTypeId: 'not-a-name' } },
      null,
      { id: 'inv1', customerId: 'c1', shipToCustomerId: 'c3' },
    );
    expect(f.entityIds.sort()).toEqual(['c1', 'c3', 'e1', 'e2', 'v9']);
    expect(f.accountIds.sort()).toEqual(['a1', 'a2']);
  });

  it.each([
    ['accountId'],
    ['bankAccountId'],
    ['fromAccountId'],
    ['toAccountId'],
    ['paymentAccountId'],
    ['depositAccountId'],
  ])('reads %s as an account', (key) => {
    expect(facts(op(), { body: { [key]: 'acct-1' } }).accountIds).toEqual(['acct-1']);
  });

  it.each([
    ['/api/customers/[id]', 'PATCH', ['cust-7']],
    ['/api/vendors/[id]', 'DELETE', ['cust-7']],
    ['/api/customers/[id]/notes', 'POST', ['cust-7']],
    ['/api/invoices/[id]', 'PATCH', []],
  ] as const)('%s takes [id] as a name: %j', (route, method, ids) => {
    const f = facts(op({ route, method, params: ['id'] }), { params: { id: 'cust-7' } });
    expect(f.entityIds).toEqual(ids);
  });

  it('counts an id that is not text as its text, and empty ones as nothing', () => {
    expect(facts(op(), { body: { customerId: 42, vendorId: '  ', accountId: null, toAccountId: '' } })).toMatchObject({ entityIds: ['42'], accountIds: [] });
  });

  it('lists an id it cannot read as UNREADABLE_ID, which no grant can name', () => {
    const f = facts(op(), { body: { customerId: { id: 'c1' }, lines: [{ accountId: ['a1', { nested: true }] }] } });
    expect(f.entityIds).toContain(UNREADABLE_ID);
    expect(f.accountIds.sort()).toEqual([UNREADABLE_ID, 'a1'].sort());
  });

  it('counts a job as a name (a job is a customer\'s)', () => {
    expect(facts(op(), { body: { lines: [{ jobId: 'job-9' }], jobIds: ['job-1'] } }).entityIds.sort()).toEqual(['job-1', 'job-9']);
  });

  it.each([
    ['/api/registers/[accountId]', 'POST', ['accountId'], { accountId: 'bank-B' }, ['bank-B', 'expense-X']],
    ['/api/registers/[accountId]', 'DELETE', ['accountId'], { accountId: 'bank-B' }, ['bank-B', 'expense-X']],
    ['/api/accounts/[id]', 'PATCH', ['id'], { id: 'acct-7' }, ['acct-7', 'expense-X']],
    ['/api/invoices/[id]', 'PATCH', ['id'], { id: 'inv-1' }, ['expense-X']],
  ] as const)('%s %s takes its path value as an account', (route, method, params, values, ids) => {
    const f = facts(op({ route, method, params: [...params] }), { params: { ...values }, body: { lines: [{ accountId: 'expense-X' }] } });
    expect(f.accountIds.sort()).toEqual([...ids].sort());
  });

  it('takes a job route\'s [id] as a name', () => {
    expect(facts(op({ route: '/api/jobs/[id]', method: 'PATCH', params: ['id'] }), { params: { id: 'job-3' } }).entityIds).toEqual(['job-3']);
  });

  it('reads every line of a long entry: the last line names count as much as the first', () => {
    // 25,000 bare rows, then the one that names another customer and account.
    const bare = { body: { customerId: 'A', accountId: 'acctA', lines: [...Array.from({ length: 25_000 }, (_, i) => i), { customerId: 'B', accountId: 'acctB' }] } };
    expect(facts(op(), bare).entityIds.sort()).toEqual(['A', 'B']);
    expect(facts(op(), bare).accountIds.sort()).toEqual(['acctA', 'acctB']);
    // Realistic rows of seven fields each: a 5,000-line journal entry is valid (zLines has no maximum).
    const row = (i: number) => ({ accountId: 'acctA', debit: '1.00', credit: null, memo: `line ${i}`, classId: null, customerId: 'A', billable: false });
    const long = { body: { date: '2026-11-20', lines: [...Array.from({ length: 5_000 }, (_, i) => row(i)), { ...row(5_000), accountId: 'acctB', customerId: 'B' }] } };
    const f = facts(op(), long);
    expect(f.entityIds.sort()).toEqual(['A', 'B']);
    expect(f.accountIds.sort()).toEqual(['acctA', 'acctB']);
  });

  it('reads ids at any depth, and a very deep body does not stop it', () => {
    let deep: Record<string, unknown> = { vendorId: 'V-deep', accountId: 'acct-deep' };
    for (let i = 0; i < 20_000; i++) deep = { inner: deep };
    const f = facts(op(), { body: { customerId: 'A', wrap: deep } });
    expect(f.entityIds.sort()).toEqual(['A', 'V-deep']);
    expect(f.accountIds).toEqual(['acct-deep']);
  });
});

describe('factsOf: date and closed period', () => {
  it.each([
    ['date first', { date: '2026-11-02', txnDate: '2026-10-01' }, '2026-11-02'],
    ['then txnDate', { txnDate: '2026-10-01', entryDate: '2026-09-01' }, '2026-10-01'],
    ['then entryDate', { entryDate: '2026-09-01' }, '2026-09-01'],
    ['then paymentDate', { paymentDate: '2026-08-15' }, '2026-08-15'],
    ['a date-time keeps its day', { date: '2026-11-20T23:30:00-05:00' }, '2026-11-20'],
    ['none', { memo: 'x' }, null],
    ['an empty date is none', { date: '' }, null],
  ])('%s', (_label, bodyIn, date) => {
    expect(facts(op(), { body: bodyIn }).date).toBe(date);
  });

  it("takes the answer's date when the body names none (an edit is still dated)", () => {
    expect(facts(op(), { body: { memo: 'x' } }, null, { id: 'i', date: '2026-01-31' }).date).toBe('2026-01-31');
  });

  it('has no single date when the rows disagree (a grant by date must not cover them)', () => {
    expect(facts(op(), { body: { rows: [{ date: '2026-11-01' }, { date: '2026-03-01' }] } }).date).toBeNull();
    expect(facts(op(), { body: { rows: [{ date: '2026-11-01' }, { date: '2026-11-01' }] } }).date).toBe('2026-11-01');
  });

  it.each([
    ['before the closing date', { date: '2026-09-30' }, '2026-10-31', true],
    ['on the closing date', { date: '2026-10-31' }, '2026-10-31', true],
    ['after it', { date: '2026-11-01' }, '2026-10-31', false],
    ['no closing date', { date: '2020-01-01' }, null, false],
    ['no date at all', { memo: 'x' }, '2026-10-31', false],
    ['one row of many in the closed period', { rows: [{ date: '2026-11-05' }, { txnDate: '2026-10-05' }] }, '2026-10-31', true],
    ['a date that cannot be read', { date: '31/10/2026' }, '2026-10-31', true],
    ['a closing date that cannot be read', { date: '2026-11-05' }, 'end of October', true],
  ])('closed period: %s', (_label, bodyIn, closing, closed) => {
    expect(facts(op(), { body: bodyIn }, closing).closedPeriod).toBe(closed);
  });

  it('an unreadable date leaves no date to match a grant', () => {
    expect(facts(op(), { body: { date: 'yesterday' } }).date).toBeNull();
  });

  it("looks at the answer's date for the closed period too", () => {
    expect(facts(op(), { body: {} }, '2026-10-31', { date: '2026-10-15' }).closedPeriod).toBe(true);
  });

  it('finds a date at any depth of the body', () => {
    const f = facts(op(), { body: { deposits: [{ lines: [{ date: '2026-09-01' }] }], batch: { rows: [{ entry: { txnDate: '2026-11-05' } }] } } }, '2026-10-31');
    expect(f.closedPeriod).toBe(true);
    expect(f.date).toBeNull(); // two different dates: no single one for a grant to match
  });

  it("reads the answer's own date and its rows', not the dates of what it links to", () => {
    // An invoice dated after the closing date whose earlier payments are in a closed period.
    const answer = { id: 'inv1', date: '2026-11-15', payments: [{ date: '2020-01-01' }] };
    expect(facts(op(), { body: {} }, '2026-10-31', answer)).toMatchObject({ date: '2026-11-15', closedPeriod: false });
    // An answer that is a list: each row is a record of the request.
    expect(facts(op(), { body: {} }, '2026-10-31', [{ date: '2026-11-15' }, { date: '2026-10-01' }]).closedPeriod).toBe(true);
  });
});

describe('factsOf: whatever it is given', () => {
  it.each([[null], ['x'], [[]]])('reads %j as an empty request', (input) => {
    expect(factsOf(op({ amountField: 'total', countField: 'ids' }), input as never, { closingDate: null })).toEqual({
      confirm: [],
      reveal: false,
      amount: null,
      count: null,
      entityIds: [],
      accountIds: [],
      date: null,
      closedPeriod: false,
    });
  });
});
