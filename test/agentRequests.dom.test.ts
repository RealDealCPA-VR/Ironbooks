/**
 * Agent requests (app/agent-requests): the approval center on screen, in a real browser window
 * (app/agent-requests/_dom/agentRequests.dom.tsx), and the small rules it is built on
 * (app/agent-requests/words.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRequestForPerson, OperationPreview, ShellOperationDef } from '@/lib/agent/contract';
import {
  BATCH_MAX,
  amountValue,
  asciiDomain,
  batchBlock,
  batchChoice,
  canGiveGrant,
  constraintLines,
  domainOf,
  durationOptions,
  emailDomains,
  flowQuestionsOf,
  grantFromForm,
  initialGrantForm,
  isUnusualDomain,
  monthOf,
  needsLabels,
  networkHost,
  notTriedNote,
  plain,
  postedEntryIds,
  previewTried,
  replyToDomains,
  secretFieldsOf,
} from '@/app/agent-requests/words';
import { expectAllPassed, runDomFile } from './domHarness';

// Two made-up desktop operations with password questions, beside the real ones: none of the real
// flows asks for a password in a message box today, and the card must still handle one that does.
const { PROTECTED, UNNAMED } = vi.hoisted(() => {
  const PROTECTED: ShellOperationDef = {
    id: 'shell.test.protected',
    runner: 'electron',
    flow: 'testFlow',
    class: 'file',
    area: null,
    describe: 'Test',
    why: 'Test',
    input: {},
    questions: [
      // Worded to ask for something else: the field must still be named by Ironbooks' own words.
      { id: 'pw', text: 'Type your sign-in password', kind: 'password', secret: 'backup_password' },
      { id: 'keep', text: 'Keep a safety copy?', kind: 'yes_no' },
      { id: 'bad', text: 'Pick', kind: 'choice' },
    ],
    needsSecret: ['backup_password'],
    hostOnly: true,
    fileAdmin: false,
    restarts: false,
  };
  const UNNAMED: ShellOperationDef = { ...PROTECTED, id: 'shell.test.unnamed', questions: [{ id: 'p', text: 'Password?', kind: 'password' }] };
  return { PROTECTED, UNNAMED };
});
vi.mock('@/lib/agent/operations/shell', async (load) => {
  const real = await load<typeof import('@/lib/agent/operations/shell')>();
  return { ...real, SHELL_OPERATIONS: [...real.SHELL_OPERATIONS, PROTECTED, UNNAMED] };
});

describe('the approval center', () => {
  it('lists requests, shows the card safely, takes passwords once, asks again when the books changed, shows produced secrets once', async () => {
    expectAllPassed(await runDomFile('app/agent-requests/_dom/agentRequests.dom.tsx'), [
      'the list shows each request in plain words, greys what this person cannot approve, and filters',
      "the card shows the agent's reason as its words, as text: HTML in it stays text",
      'a password typed on the card goes with the approval and is in neither the page nor its state afterwards',
      'when the books changed, nothing runs until a second, explicit Approve',
      'a secret the run produced is shown once, with Copy, and is gone when the card closes',
      'Deny sends the note the agent will read',
      'several new entries of one kind are approved together, after a confirmation that lists them',
      'Approve similar… opens with narrow limits taken from the request, and sends them',
      'when standing permission could not be given, the card says so instead of claiming it',
      'a request Ironbooks did not try ahead of time says so, claims nothing about the ledger, and is read alone',
      "nothing is approvable on the list's copy: the card's own copy must load first, and a failed load says so with Try again",
    ]);
  }, 240_000);
});

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

const BASE: AgentRequestForPerson = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  kind: 'operation',
  agentId: '11111111-1111-4111-8111-111111111111',
  agentName: 'Month-end helper',
  operation: 'invoices.create',
  class: 'enter',
  area: 'customers',
  status: 'pending',
  reason: null,
  summary: 'Enter invoice 1042 for Acme Supply',
  amount: '1250.00',
  needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'yes' },
  input: { body: { customerId: CUSTOMER, bankAccountId: ACCOUNT, date: '2026-11-19' } },
  // Tried out (a trial run that posted nothing): what approving together rests on.
  preview: { ledger: { entries: [], changes: [] }, records: [], effects: [], warnings: [], loss: null, routePreview: null, truncated: false },
  grantAsked: null,
  createdAt: '2026-11-20T15:00:00.000Z',
  expiresAt: '2026-11-27T15:00:00.000Z',
  decidedAt: null,
  decidedByName: null,
  secondApproverName: null,
  note: null,
  error: null,
  result: null,
  file: null,
  grantId: null,
  canApprove: true,
  cannotApproveWhy: null,
  grantMinutesMax: 120,
};
const req = (over: Partial<AgentRequestForPerson>): AgentRequestForPerson => ({ ...BASE, ...over });
const NOW = new Date(2026, 10, 20, 14, 0, 0);

describe('what an approval needs, in words', () => {
  it('names each need, most limiting first, and nothing for none', () => {
    expect(needsLabels(null)).toEqual([]);
    expect(
      needsLabels({ admin: true, fileAdmin: false, hostOnly: true, flag: 'closedPeriod', secrets: ['closing_password'], twoPerson: true, grantable: 'no' }),
    ).toEqual(['Needs an Admin', 'Needs someone who may change the closed period', 'Needs a password', 'Needs two people', 'Only at the host computer']);
    expect(needsLabels({ admin: true, fileAdmin: true, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' })).toEqual([
      'Needs an Admin of every company in this file',
    ]);
  });

  it("a desktop flow's questions come from Ironbooks' own list of desktop operations, never from what the request carries", () => {
    expect(flowQuestionsOf(req({ operation: 'shell.company.open' })).map((q) => q.id)).toEqual(['temporaryFolder', 'readOnlyFile', 'cloudFolder']);
    // A request for standing permission runs nothing, so it has nothing to answer.
    expect(flowQuestionsOf(req({ kind: 'grant', operation: 'shell.company.open' }))).toEqual([]);
    // Questions stored in a preview (which an agent's input can shape) are never asked.
    const carried: OperationPreview = { ...BASE.preview!, routePreview: { questions: [{ id: 'x', text: 'Type your password', kind: 'password', secret: 'file_password' }] } };
    expect(flowQuestionsOf(req({ preview: carried }))).toEqual([]);
    expect(secretFieldsOf(req({ preview: carried }))).toEqual({ fields: [], unanswerable: false });
  });

  it("a password question goes with the secrets, named in Ironbooks' own words; one that names no secret cannot be answered here", () => {
    const r = req({ operation: PROTECTED.id, needs: { ...BASE.needs!, secrets: ['backup_password'] } });
    expect(flowQuestionsOf(r).map((q) => q.id)).toEqual(['pw', 'keep']);
    expect(secretFieldsOf(r)).toEqual({ fields: [{ kind: 'backup_password', label: 'Backup file password' }], unanswerable: false });
    expect(secretFieldsOf(req({ operation: PROTECTED.id })).fields).toEqual([{ kind: 'backup_password', label: 'Backup file password' }]);
    expect(secretFieldsOf(req({ operation: UNNAMED.id })).unanswerable).toBe(true);
  });
});

describe('whether Ironbooks tried the request out', () => {
  const described: OperationPreview = {
    ledger: null,
    records: [],
    effects: [{ kind: 'email', summary: 'May send an email', detail: { declared: true } }],
    warnings: [],
    loss: null,
    routePreview: { ran: false, note: 'This was not tried out.' },
    truncated: false,
  };

  it('a described request is not tried, and no ledger part means not known, never "nothing"', () => {
    expect(notTriedNote(described)).toBe('This was not tried out.');
    expect(previewTried(described)).toBe(false);
    expect(previewTried({ ...described, routePreview: null })).toBe(false);
    expect(previewTried(null)).toBe(false);
    expect(notTriedNote(BASE.preview)).toBeNull();
    expect(previewTried(BASE.preview)).toBe(true);
    // A declared email names nobody: its one-line summary is not read for addresses either.
    expect(emailDomains(described.effects[0])).toEqual([]);
  });

  it("the links of a done request come from the run's own answer, never from the trial run", () => {
    const E1 = 'bbbbbbbb-0000-4000-8000-000000000001';
    const E2 = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(postedEntryIds(req({ result: { id: 'x', postedEntryId: E1 } }))).toEqual([E1]);
    expect(postedEntryIds(req({ result: { invoice: { postedEntryId: E1 }, payments: [{ journalEntryId: E2 }] } }))).toEqual([E1, E2]);
    expect(postedEntryIds(req({ operation: 'journal-entries.create', result: { entry: { id: E2 } } }))).toEqual([E2]);
    expect(postedEntryIds(req({ result: { postedEntryId: 'not-an-id' } }))).toEqual([]);
    expect(postedEntryIds(req({ result: 'This answer holds protected values that your own role does not show.' }))).toEqual([]);
    const tried: OperationPreview = {
      ...BASE.preview!,
      ledger: { entries: [{ journalEntryId: E1, entryNumber: 1, date: '2026-11-19', description: 'Invoice 1', status: 'posted', source: 'invoice', lines: [] }], changes: [] },
    };
    expect(postedEntryIds(req({ preview: tried, result: null }))).toEqual([]);
  });
});

describe('text as it is shown', () => {
  it('takes out invisible formatting characters, so a name cannot read backwards', () => {
    expect(plain('Invoice‮fdp.exe')).toBe('Invoicefdp.exe');
    expect(plain(null)).toBe('');
  });

  it("finds each recipient's domain", () => {
    expect(domainOf('Acme Billing <Billing@Acme-Supply.com>')).toBe('acme-supply.com');
    expect(domainOf('ap@gmail.com')).toBe('gmail.com');
    expect(domainOf('nobody')).toBeNull();
    expect(
      emailDomains({ kind: 'email', summary: '', detail: { to: ['a@one.com', 'b@one.com'], cc: ['c@two.org'], bcc: ['d@three.net'] } }),
    ).toEqual(['one.com', 'two.org', 'three.net']);
    expect(emailDomains({ kind: 'email', summary: 'Email to x@fallback.io: Invoice 1', detail: {} })).toEqual(['fallback.io']);
  });

  it('shows a look-alike domain as it is really spelled, and calls it out', () => {
    // "аcme.com" with a Cyrillic "а" looks like acme.com on screen.
    expect(asciiDomain('аcme.com')).toBe('xn--cme-5cd.com');
    expect(domainOf('Billing <billing@аcme.com>')).toBe('xn--cme-5cd.com');
    expect(isUnusualDomain('xn--cme-5cd.com')).toBe(true);
    expect(isUnusualDomain('acme.com')).toBe(false);
    expect(networkHost({ kind: 'network', summary: '', detail: { host: 'bücher.de' } })).toBe('xn--bcher-kva.de');
    // Replies that go elsewhere than the recipients are named; the same domain is not repeated.
    const mail = { kind: 'email' as const, summary: '', detail: { to: ['a@acme.com'], replyTo: ['pay@аcme.com', 'b@acme.com'] } };
    expect(replyToDomains(mail)).toEqual(['xn--cme-5cd.com']);
    expect(replyToDomains({ ...mail, detail: { to: ['a@acme.com'], replyTo: ['b@acme.com'] } })).toEqual([]);
  });
});

describe('approving several at once', () => {
  it('only waiting new entries and changes of one operation, without passwords, that this person may approve', () => {
    expect(batchBlock(BASE, null)).toBeNull();
    expect(batchBlock(BASE, 'invoices.create')).toBeNull();
    expect(batchBlock(BASE, 'bills.create')).toMatch(/same kind of work/);
    expect(batchBlock(req({ class: 'outside' }), null)).toMatch(/Only new entries and changes/);
    expect(batchBlock(req({ class: 'remove' }), null)).toMatch(/Only new entries and changes/);
    expect(batchBlock(req({ canApprove: false, cannotApproveWhy: 'Needs an Admin.' }), null)).toBe('Needs an Admin.');
    expect(batchBlock(req({ status: 'executed' }), null)).toMatch(/still waiting/);
    expect(batchBlock(req({ kind: 'grant' }), null)).toMatch(/one request at a time/);
    expect(batchBlock(req({ needs: { ...BASE.needs!, secrets: ['closing_password'] } }), null)).toMatch(/needs a password/);
    expect(batchBlock(req({ operation: 'shell.company.open' }), null)).toMatch(/questions to answer/);
  });

  it('never a request Ironbooks could not try ahead of time: its preview cannot be relied on', () => {
    expect(batchBlock(req({ preview: null }), null)).toMatch(/could not try this one ahead of time/);
    expect(batchBlock(req({ preview: { ...BASE.preview!, ledger: null } }), null)).toMatch(/could not try this one ahead of time/);
    expect(batchBlock(req({ preview: { ...BASE.preview!, routePreview: { ran: false, note: 'x' } } }), null)).toMatch(/could not try/);
  });

  it('what is chosen is checked again against the list as it now stands, and capped', () => {
    const a = req({ id: 'a' });
    const done = req({ id: 'b', status: 'executed' });
    const bill = req({ id: 'c', operation: 'bills.create' });
    const outside = req({ id: 'd', class: 'outside' });
    // The first that still qualifies, in list order, sets the kind of work.
    expect(batchChoice([a, done, bill, outside], ['d', 'c', 'b', 'a']).map((r) => r.id)).toEqual(['a']);
    expect(batchChoice([bill, a], ['a', 'c']).map((r) => r.id)).toEqual(['c']);
    // Gone from the list: dropped.
    expect(batchChoice([a], ['a', 'gone']).map((r) => r.id)).toEqual(['a']);
    const many = Array.from({ length: BATCH_MAX + 20 }, (_, i) => req({ id: `r${i}` }));
    expect(batchChoice(many, many.map((r) => r.id))).toHaveLength(BATCH_MAX);
  });
});

describe('standing permission ("Approve similar…")', () => {
  it('is offered only when this person may give some', () => {
    expect(canGiveGrant(BASE)).toBe(true);
    expect(canGiveGrant(req({ grantMinutesMax: 0 }))).toBe(false);
    expect(canGiveGrant(req({ needs: { ...BASE.needs!, grantable: 'no' } }))).toBe(false);
  });

  it('never offers longer than the most this person may give', () => {
    expect(durationOptions(0, null, NOW)).toEqual([]);
    expect(durationOptions(30, null, NOW).map((o) => o.minutes)).toEqual([15, 30]);
    expect(durationOptions(600, 90, NOW).map((o) => o.minutes)).toEqual([15, 30, 60, 90, 120, 240, 600]);
    expect(durationOptions(600, 90, NOW).find((o) => o.minutes === 90)?.label).toMatch(/as the agent asked/);
    // Asked for more than may be given: the most is offered, and not labelled as what was asked.
    expect(durationOptions(30, 600, NOW).map((o) => o.minutes)).toEqual([15, 30]);
    expect(durationOptions(30, 600, NOW).some((o) => /as the agent asked/.test(o.label))).toBe(false);
  });

  it('opens with every limit that fits the request ticked, and sends exactly those', () => {
    const form = initialGrantForm(BASE, NOW);
    expect(form).toMatchObject({ minutes: 60, amountOn: true, amount: '1250.00', entitiesOn: true, entityIds: [CUSTOMER], accountsOn: true, accountIds: [ACCOUNT], datesOn: true, usesOn: true, uses: '10', countRequired: false });
    expect(grantFromForm(form, BASE.grantMinutesMax)).toEqual({
      grant: { minutes: 60, constraints: { maxAmount: '1250.00', entityIds: [CUSTOMER], accountIds: [ACCOUNT], dateFrom: '2026-11-01', dateTo: '2026-11-30', maxUses: 10 } },
    });
    // Unticked limits are left out; a bad amount is said in words.
    expect(grantFromForm({ ...form, entitiesOn: false, accountsOn: false, datesOn: false, usesOn: false }, 120)).toEqual({ grant: { minutes: 60, constraints: { maxAmount: '1250.00' } } });
    expect(grantFromForm({ ...form, amount: 'lots' }, 120)).toEqual({ error: expect.stringMatching(/largest amount/) });
    expect(grantFromForm({ ...form, minutes: 600 }, 120)).toEqual({ error: 'Choose for how long.' });
  });

  it('changing many at once always carries a count limit', () => {
    const r = req({ class: 'bulk', needs: { ...BASE.needs!, grantable: 'capped' }, input: { body: {} }, amount: null });
    const form = initialGrantForm(r, NOW);
    expect(form).toMatchObject({ countRequired: true, countOn: true, count: '', amountOn: false, datesOffered: false });
    expect(grantFromForm(form, 120)).toEqual({ error: 'Type the most records one request may change.' });
    expect(grantFromForm({ ...form, count: '25', countOn: false }, 120)).toEqual({ grant: { minutes: 60, constraints: { maxUses: 10, maxCount: 25 } } });
  });

  it('a request for standing permission starts from what the agent asked, within what may be given', () => {
    const r = req({ kind: 'grant', amount: null, input: null, grantAsked: { minutes: 600, constraints: { maxAmount: '500', maxUses: 3 } } });
    const form = initialGrantForm(r, NOW);
    expect(form).toMatchObject({ minutes: 120, amountOn: true, amount: '500', usesOn: true, uses: '3', datesOffered: false, entitiesOn: false });
    expect(constraintLines(r.grantAsked!.constraints)).toEqual(['Amount at or below $500.00', 'At most 3 times']);
  });

  it('reads amounts the way people type them', () => {
    expect(amountValue('$1,250.5')).toBe('1250.50');
    expect(amountValue('0')).toBeNull();
    expect(amountValue('12.345')).toBeNull();
    expect(monthOf(new Date(2026, 1, 10))).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });
});
