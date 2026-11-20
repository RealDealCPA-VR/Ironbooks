// Agent requests (app/agent-requests), in a real browser window (test/domHarness.ts runs it; the
// vitest side is test/agentRequests.dom.test.ts). Kept beside the page it tests: the folder starts
// with "_", so Next never makes a page of it.
//
// The list shows requests in plain words and greys what this person cannot approve; the card shows
// the agent's reason as its words and as text only; a typed password goes with the approval and is
// then in neither the page nor React's state; when the books changed nothing runs until a second,
// explicit Approve on that same card (a card opened later starts over); a secret the run produced
// is shown once; Deny carries the note; approving several at once is for one kind of work and asks
// first; Approve similar… sends narrow limits; a request Ironbooks did not try out says so instead
// of claiming nothing is posted; nothing is approvable before the card's own copy has loaded.
import * as React from 'react';
import AgentRequestsPage from '@/app/agent-requests/page';
import { Toaster } from '@/components/ui';
import type { AgentRequestForPerson, ApproveResult, OperationPreview } from '@/lib/agent/contract';
import { monthOf } from '@/app/agent-requests/words';
import {
  $,
  $$,
  CheckError,
  button,
  check,
  click,
  domTest,
  equal,
  focus,
  mount,
  reply,
  runDomTests,
  settle,
  stubFetch,
  textOf,
  typeText,
  unmount,
  until,
  type FetchCall,
} from '@/test/dom/kit';

const HELPER = '11111111-1111-4111-8111-111111111111';
const NIGHT = '22222222-2222-4222-8222-222222222222';
const ACME = '33333333-3333-4333-8333-333333333333';
const ids = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const LEDGER = (amount: string): OperationPreview => ({
  ledger: {
    entries: [
      {
        journalEntryId: 'bbbbbbbb-0000-4000-8000-000000000077',
        entryNumber: 77,
        date: '2026-11-19',
        description: 'Invoice 1042',
        status: 'posted',
        source: 'invoice',
        lines: [
          { accountId: 'x1', accountCode: '1200', accountName: 'Accounts Receivable', debit: amount, credit: null, memo: null, entityName: 'Acme Supply' },
          { accountId: 'x2', accountCode: '4000', accountName: 'Sales', debit: null, credit: amount, memo: null, entityName: null },
        ],
      },
    ],
    changes: [],
  },
  records: [{ action: 'create', kind: 'invoice', id: 'inv-1', fields: [{ field: 'dueDate', before: null, after: '2026-12-19' }] }],
  effects: [],
  warnings: [],
  loss: null,
  routePreview: null,
  truncated: false,
});

const BASE: AgentRequestForPerson = {
  id: ids(1),
  kind: 'operation',
  agentId: HELPER,
  agentName: 'Month-end helper',
  operation: 'invoices.create',
  class: 'enter',
  area: 'customers',
  status: 'pending',
  reason: 'Acme asked for their November invoice.',
  summary: 'Enter invoice 1042 for Acme Supply',
  amount: '1250.00',
  needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'yes' },
  input: { body: { customerId: ACME, date: '2026-11-19', lines: [{ amount: '1250.00' }] } },
  preview: LEDGER('1250.00'),
  grantAsked: null,
  createdAt: minutesAgo(5),
  expiresAt: inDays(7),
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

const ADMIN_ONLY = req({
  id: ids(2),
  agentId: NIGHT,
  agentName: 'Night closer',
  operation: 'network-policy.update',
  class: 'settings',
  area: 'company',
  summary: 'Change who may connect to this computer',
  amount: null,
  needs: { admin: true, fileAdmin: false, hostOnly: true, flag: null, secrets: ['file_password'], twoPerson: true, grantable: 'no' },
  input: { body: {} },
  preview: null,
  canApprove: false,
  cannotApproveWhy: 'Only an Admin at the host computer can approve this.',
  grantMinutesMax: 0,
  createdAt: minutesAgo(180),
});

const EMAIL = req({
  id: ids(3),
  operation: 'invoices.email',
  class: 'outside',
  area: 'customers',
  summary: 'Email invoice 1042 to billing@acme-supply.com',
  amount: null,
  reason: '<img src=x onerror="window.__pwned=1"><b>Trust me</b> <a href="https://evil.example/pay">Click here</a> and pay https://evil.example',
  needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'short' },
  preview: {
    ...LEDGER('0'),
    ledger: null,
    records: [],
    effects: [
      {
        kind: 'email',
        summary: 'Email to billing@acme-supply.com, copy to ap.clerk@gmail.com: Invoice 1042 (1 attachment, 84 KB)',
        // Replies go to a look-alike of the recipient's domain: its first letter is a Cyrillic "а".
        detail: { to: ['Acme Billing <billing@acme-supply.com>'], cc: ['ap.clerk@gmail.com'], bcc: [], replyTo: ['pay@аcme-supply.com'], subject: 'Invoice 1042' },
      },
    ],
  },
  grantMinutesMax: 0,
  createdAt: minutesAgo(60 * 26),
});

const CLOSING = req({
  id: ids(4),
  operation: 'journal-entries.update',
  class: 'period',
  summary: 'Change journal entry 61, dated in a closed period',
  amount: '310.00',
  needs: { admin: false, fileAdmin: false, hostOnly: false, flag: 'closedPeriod', flags: ['closedPeriod'], secrets: ['closing_password'], twoPerson: false, grantable: 'no' },
  grantMinutesMax: 0,
});

/** A paycheck posts to the ledger, but its route cannot be tried and rolled back: it is described only. */
const PAYCHECK = req({
  id: ids(6),
  operation: 'payroll.create',
  area: 'payroll',
  summary: 'Write a paycheck for Dana Lee',
  amount: '2100.00',
  input: { body: {} },
  preview: {
    ledger: null,
    records: [],
    effects: [{ kind: 'email', summary: 'May send an email', detail: { declared: true } }],
    warnings: [],
    loss: null,
    routePreview: { ran: false, note: 'This was not tried out: this operation has a preview of its own, which is a separate operation to read. Nothing was changed.' },
    truncated: false,
  },
});

const RESET = req({
  id: ids(5),
  operation: 'users.reset-password',
  class: 'admin',
  area: 'users',
  summary: 'Reset the password of Dana Lee',
  amount: null,
  needs: { admin: true, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' },
  input: { body: {} },
  preview: { ...LEDGER('0'), ledger: null, records: [] },
  grantMinutesMax: 0,
});

const page = () => (
  <div>
    <Toaster />
    <AgentRequestsPage />
  </div>
);
const dialog = () => $('[role="dialog"]');
const rowOf = (id: string) => $(`[data-request-row="${id}"]`);
const posts = (calls: FetchCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

/** Pick an option of a <select> the way a person would (React reads the change event). */
async function choose(sel: HTMLSelectElement | null, value: string, what: string) {
  check(sel, `missing ${what}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(sel, value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

/** Open a request's card from its row, and wait for the card's own copy of the request. */
async function openCard(id: string) {
  const row = await until(() => rowOf(id), `the row of ${id}`);
  await click(button('Open', row), 'Open');
  return until(() => (dialog() && $('[data-request-summary]', dialog()!) && !$('[data-card-loading]', dialog()!) ? dialog() : null), 'the card');
}

/**
 * Whether any React state on the page (every hook of every component, both copies React keeps)
 * holds `text`. DOM elements are skipped: the page itself is checked separately.
 */
function reactStateHolds(text: string): boolean {
  const host = document.getElementById('dom-test-root');
  const key = host ? Object.keys(host).find((k) => k.startsWith('__reactContainer$')) : undefined;
  if (!host || !key) throw new CheckError('no React root on the page');
  const seen = new Set<unknown>();
  const holds = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') return v.includes(text);
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v) || v instanceof Node) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some((x) => holds(x, depth + 1));
    return Object.keys(v).some((k) => k !== '_owner' && k !== 'stateNode' && holds((v as Record<string, unknown>)[k], depth + 1));
  };
  type Fiber = { tag: number; memoizedState: unknown; memoizedProps: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  const stateOf = (f: Fiber): boolean => {
    // Function components keep their hooks as a list: each hook's own state is checked.
    if (f.tag === 0 || f.tag === 11 || f.tag === 15) {
      for (let h = f.memoizedState as { memoizedState: unknown; next: unknown } | null; h; h = h.next as typeof h) {
        if (holds(h.memoizedState, 0)) return true;
      }
      return false;
    }
    return holds(f.memoizedState, 0);
  };
  const stack: Fiber[] = [(host as unknown as Record<string, Fiber>)[key]];
  while (stack.length) {
    const f = stack.pop()!;
    if (stateOf(f) || (f.alternate && stateOf(f.alternate))) return true;
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  return false;
}

domTest('the list shows each request in plain words, greys what this person cannot approve, and filters', async () => {
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE, ADMIN_ONLY, EMAIL] },
    'GET /api/agent-requests?status=all': { requests: [BASE, ADMIN_ONLY, EMAIL, req({ id: ids(9), status: 'executed', summary: 'Enter invoice 1040 for Acme Supply', decidedByName: 'Pat Owner' })] },
  });
  await mount(page());
  await until(() => rowOf(BASE.id), 'the requests');
  const text = textOf();
  check(text.includes('Month-end helper') && text.includes('Night closer'), 'each agent is named');
  check(text.includes('Enter invoice 1042 for Acme Supply'), 'the summary is shown');
  check(textOf(rowOf(BASE.id)).includes('Enter new') && textOf(rowOf(EMAIL.id)).includes('Send outside this computer'), 'the kind of work is shown in words');
  check(textOf(rowOf(BASE.id)).includes('$1,250.00'), 'the amount is shown as money');
  check(textOf(rowOf(BASE.id)).includes('5 minutes ago') && textOf(rowOf(EMAIL.id)).includes('1 day ago'), `the age is shown: ${textOf(rowOf(EMAIL.id))}`);
  const admin = textOf(rowOf(ADMIN_ONLY.id));
  for (const need of ['Needs an Admin', 'Needs a password', 'Needs two people', 'Only at the host computer']) check(admin.includes(need), `"${need}" is shown: ${admin}`);
  check(textOf(rowOf(BASE.id)).includes('Waiting'), 'the status is shown');
  check(rowOf(ADMIN_ONLY.id)!.className.includes('opacity-60') && !rowOf(BASE.id)!.className.includes('opacity-60'), 'a request this person cannot approve is greyed');
  check(admin.includes('Only an Admin at the host computer can approve this.'), 'with the reason');
  check(!text.includes('Acme asked for their November invoice.'), "the agent's own words are kept for the card");

  await choose($<HTMLSelectElement>('#ar-class'), 'outside', 'the kind of work filter');
  check(rowOf(EMAIL.id) && !rowOf(BASE.id) && !rowOf(ADMIN_ONLY.id), 'the kind of work filter narrows the list');
  await choose($<HTMLSelectElement>('#ar-class'), '', 'the kind of work filter');
  await choose($<HTMLSelectElement>('#ar-agent'), NIGHT, 'the agent filter');
  check(rowOf(ADMIN_ONLY.id) && !rowOf(BASE.id) && !rowOf(EMAIL.id), 'the agent filter narrows the list');
  await choose($<HTMLSelectElement>('#ar-agent'), '', 'the agent filter');
  await choose($<HTMLSelectElement>('#ar-status'), 'all', 'the status filter');
  await until(() => rowOf(ids(9)), 'every request');
  check(calls.some((c) => c.path === '/api/agent-requests?status=all'), 'the status filter asks the server');
  check(textOf(rowOf(ids(9))).includes('Done'), 'a done request says so');
  await unmount();
});

domTest("the card shows the agent's reason as its words, as text: HTML in it stays text", async () => {
  stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [EMAIL] },
    [`GET /api/agent-requests/${EMAIL.id}`]: { request: EMAIL },
  });
  await mount(page());
  const card = await openCard(EMAIL.id);
  const quote = $('[data-agent-reason]', card);
  check(quote, 'the reason is shown');
  check(textOf(card).includes('The agent says'), 'under the label "The agent says"');
  const shown = quote.textContent ?? '';
  check(shown.includes('<b>Trust me</b>') && shown.includes('<a href="https://evil.example/pay">Click here</a>'), `the HTML is shown as text: ${shown}`);
  check(shown.startsWith('“') && shown.endsWith('”'), 'in quotes');
  equal($$('img, b, a, script', quote).length, 0, 'no element was made from it');
  check(!$('a[href*="evil.example"]'), 'no link anywhere goes where the agent said');
  check((window as unknown as { __pwned?: number }).__pwned === undefined, 'nothing in it ran');
  check(textOf(card).includes('What Ironbooks worked out'), "what the app worked out is set apart from the agent's words");
  check(textOf($('[data-request-summary]', card)) === 'Email invoice 1042 to billing@acme-supply.com', 'the summary is shown');
  const domains = $$('[data-recipient-domain]', card).map((d) => textOf(d));
  equal(domains.join(' '), 'acme-supply.com gmail.com', "the recipients' domains stand out");
  const replies = $$('[data-reply-domain]', card).map((d) => textOf(d));
  equal(replies.join(' '), 'xn--cme-supply-yqi.com', 'a Reply-To elsewhere is shown, spelled as it really is (never as a look-alike)');
  check(textOf(card).includes('uses letters from other alphabets'), 'and the look-alike is called out');
  check(!button('Approve similar…', card), 'no standing permission where this person may give none');
  check(button('Approve once', card) && button('Deny…', card), 'Approve once and Deny are offered');
  await unmount();
});

domTest('a password typed on the card goes with the approval and is in neither the page nor its state afterwards', async () => {
  const PASSWORD = 'Cl0singPass7';
  const done = req({ ...CLOSING, status: 'executed', canApprove: false, decidedByName: 'Pat Owner', decidedAt: new Date().toISOString() });
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [CLOSING] },
    [`GET /api/agent-requests/${CLOSING.id}`]: { request: CLOSING },
    [`POST /api/agent-requests/${CLOSING.id}/approve`]: { status: 'executed', request: done, produced: [], effects: [] } satisfies ApproveResult,
  });
  await mount(page());
  const card = await openCard(CLOSING.id);
  const field = $<HTMLInputElement>('input[type="password"]', card);
  check(field, 'a password field');
  equal(field.getAttribute('autocomplete'), 'off', 'the browser does not offer to fill or keep it');
  check(textOf(card).includes('Closing date password'), 'it says which password');
  check(button('Approve once', card)?.disabled, 'Approve waits for the password');
  await focus(field, 'the password field');
  await typeText(PASSWORD);
  check(!button('Approve once', card)?.disabled, 'Approve is ready');
  check(!reactStateHolds(PASSWORD), 'the password is not kept in state while it is typed');
  await click(button('Approve once', card), 'Approve once');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');

  const sent = posts(calls, `/api/agent-requests/${CLOSING.id}/approve`);
  equal(sent.length, 1, 'one approval');
  equal(JSON.stringify(sent[0].body), JSON.stringify({ secrets: { closing_password: PASSWORD } }), 'the password went with the approval, and nothing else');
  check(!document.body.innerHTML.includes(PASSWORD), 'the password is not in the page');
  check(!$$<HTMLInputElement>('input').some((i) => i.value.includes(PASSWORD)), 'nor in any field');
  check(!reactStateHolds(PASSWORD), 'nor in any state');
  await click(button('Close', dialog()!), 'Close');
  await until(() => !dialog(), 'the card to close');
  check(textOf(rowOf(CLOSING.id)).includes('Done'), 'the list shows it done');
  check(!reactStateHolds(PASSWORD) && !document.body.innerHTML.includes(PASSWORD), 'still nowhere after the card closed');
  await unmount();
});

domTest('when the books changed, nothing runs until a second, explicit Approve', async () => {
  const now = req({ preview: LEDGER('1300.00'), amount: '1300.00' });
  const later = req({ preview: LEDGER('1325.00'), amount: '1325.00' });
  // The entry the real run posted: not the trial run's (…077), which was rolled back.
  const POSTED = 'bbbbbbbb-0000-4000-8000-000000000099';
  const done = req({ ...later, status: 'executed', canApprove: false, decidedByName: 'Pat Owner', result: { invoice: { id: 'inv-1', postedEntryId: POSTED } } });
  let asked = 0;
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE] },
    [`GET /api/agent-requests/${BASE.id}`]: () => ({ request: asked === 0 ? BASE : asked === 1 ? now : later }),
    [`POST /api/agent-requests/${BASE.id}/approve`]: () => {
      asked++;
      return (asked === 1
        ? { status: 'stale', request: now, produced: [], effects: [] }
        : asked === 2
          ? { status: 'stale', request: later, produced: [], effects: [] }
          : { status: 'executed', request: done, produced: [], effects: [] }) satisfies ApproveResult;
    },
  });
  await mount(page());
  const card = await openCard(BASE.id);
  check(textOf(card).includes('$1,250.00'), 'the preview as the agent asked');
  await click(button('Approve once', card), 'Approve once');
  await until(() => textOf(dialog()).includes('The books changed since the agent asked. This is what would happen now.'), 'the books-changed notice');
  const path = `/api/agent-requests/${BASE.id}/approve`;
  equal(posts(calls, path).length, 1, 'only the first approval was sent');
  check(!('acceptStale' in (posts(calls, path)[0].body as object)), 'the first approval did not accept a change');
  check(textOf(dialog()).includes('$1,300.00'), 'the card shows what would happen now');
  check(!button('Approve once', dialog()!), 'the plain Approve is gone');
  check(textOf(rowOf(BASE.id)).includes('The books changed since the agent asked'), 'the list marks it');
  await settle(100);
  equal(posts(calls, path).length, 1, 'nothing runs by itself');

  // Closed and opened again later: the card starts over. Its Approve does not accept anything
  // unseen, so the server checks the books again (and here they moved once more).
  await click(button('Close', dialog()!), 'Close');
  await until(() => !dialog(), 'the card to close');
  const reopened = await openCard(BASE.id);
  await until(() => !button('Approve once', reopened)?.disabled, 'the card to load');
  check(!textOf(reopened).includes('This is what would happen now'), 'a reopened card does not say the preview is current');
  await click(button('Approve once', reopened), 'Approve once');
  await until(() => textOf(dialog()).includes('$1,325.00'), 'what would happen now, worked out again');
  equal(posts(calls, path).length, 2, 'a second approval');
  check(!('acceptStale' in (posts(calls, path)[1].body as object)), 'a reopened card never accepts a change it did not show');
  check(textOf(dialog()).includes('This is what would happen now'), 'the books-changed notice again');

  await click(button('Approve what would happen now', dialog()!), 'Approve what would happen now');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  const sent = posts(calls, path);
  equal(sent.length, 3, 'a third approval');
  equal((sent[2].body as { acceptStale?: boolean }).acceptStale, true, 'the yes to the preview shown accepts what would happen now');
  const links = $$<HTMLAnchorElement>('a', dialog()!);
  const open = links.find((a) => textOf(a) === 'Open the entry it posted');
  check(open && open.getAttribute('href')?.startsWith(`/reports/open?entry=${POSTED}`), `a link to what the run posted: ${links.map((a) => a.getAttribute('href')).join(' ')}`);
  check(!links.some((a) => (a.getAttribute('href') ?? '').includes('000000000077')), "never to the trial run's entry, which does not exist");
  check(links.some((a) => a.getAttribute('href') === '/audit-trail'), 'and to the audit trail');
  await unmount();
});

domTest('a secret the run produced is shown once, with Copy, and is gone when the card closes', async () => {
  const SECRET = 'Tmp-4Kq9-Zx';
  const done = req({ ...RESET, status: 'executed', canApprove: false, decidedByName: 'Pat Owner' });
  let finished = false;
  stubFetch({
    'GET /api/agent-requests?status=pending': () => ({ requests: [finished ? done : RESET] }),
    [`GET /api/agent-requests/${RESET.id}`]: () => ({ request: finished ? done : RESET }),
    [`POST /api/agent-requests/${RESET.id}/approve`]: () => {
      finished = true;
      return { status: 'executed', request: done, produced: [{ kind: 'new_user_password', label: 'Temporary password for Dana Lee', value: SECRET }], effects: [] } satisfies ApproveResult;
    },
  });
  await mount(page());
  const card = await openCard(RESET.id);
  await click(button('Approve once', card), 'Approve once');
  const shown = await until(() => (textOf(dialog()).includes(SECRET) ? dialog() : null), 'the produced secret');
  const t = textOf(shown);
  check(t.includes('Temporary password for Dana Lee'), 'it says what it is');
  check(t.includes('This will not be shown again'), 'and that it will not be shown again');
  check(button('Copy Temporary password for Dana Lee', shown), 'with Copy');
  equal($$('[data-produced-secret]').length, 1, 'once');
  check(
    !$$('[role="alert"], [role="status"], [aria-live]').some((live) => (live.textContent ?? '').includes(SECRET)),
    'the value is in no live region, so a screen reader does not read it out by itself',
  );
  check(!textOf(rowOf(RESET.id)).includes(SECRET), 'never in the list');
  check(reactStateHolds(SECRET), 'while it is shown, the card holds it');

  await click(button('Close', shown), 'Close');
  await until(() => !dialog(), 'the card to close');
  check(!document.body.innerHTML.includes(SECRET), 'gone from the page');
  check(!reactStateHolds(SECRET), 'and from every state');
  const again = await openCard(RESET.id);
  check(!textOf(again).includes(SECRET) && !textOf(again).includes('This will not be shown again'), 'opening it again does not show it');
  await unmount();
});

domTest('Deny sends the note the agent will read', async () => {
  const denied = req({ status: 'denied', canApprove: false, decidedByName: 'Pat Owner', note: 'Wait for the signed order' });
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE] },
    [`GET /api/agent-requests/${BASE.id}`]: { request: BASE },
    [`POST /api/agent-requests/${BASE.id}/deny`]: { request: denied },
  });
  await mount(page());
  const card = await openCard(BASE.id);
  await click(button('Deny…', card), 'Deny…');
  const note = await until(() => $<HTMLTextAreaElement>('#deny-note'), 'the note');
  check(textOf(dialog()).includes('The agent reads this note.'), 'it says who reads the note');
  await focus(note, 'the note');
  // The test window's keyboard has no full stop (test/dom/runner.cjs), so the note ends without one.
  await typeText('Wait for the signed order');
  // The check the password test relies on does see what a field keeps in state.
  check(reactStateHolds('Wait for the signed order'), 'the state check finds a typed note');
  equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing is sent before Deny request');
  await click(button('Deny request', dialog()!), 'Deny request');
  await until(() => !dialog(), 'the card to close');
  const sent = posts(calls, `/api/agent-requests/${BASE.id}/deny`);
  equal(JSON.stringify(sent.map((c) => c.body)), JSON.stringify([{ note: 'Wait for the signed order' }]), 'the note was sent');
  check(textOf(rowOf(BASE.id)).includes('Denied'), 'the list shows it denied');
  check(textOf().includes('Denied. The agent will read your note.'), 'and says so');
  await unmount();
});

domTest('several new entries of one kind are approved together, after a confirmation that lists them', async () => {
  const E1 = req({ id: ids(11), summary: 'Enter invoice 1050 for Acme Supply', amount: '100.00' });
  const E2 = req({ id: ids(12), summary: 'Enter invoice 1051 for Acme Supply', amount: '200.00' });
  const BILL = req({ id: ids(13), operation: 'bills.create', summary: 'Enter bill 88 from Staples', amount: '40.00' });
  const results: ApproveResult[] = [E1, E2].map((r) => ({ status: 'executed', request: { ...r, status: 'executed', canApprove: false }, produced: [], effects: [] }));
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [E1, E2, BILL, EMAIL] },
    'POST /api/agent-requests/batch-approve': { results },
  });
  await mount(page());
  await until(() => rowOf(E1.id), 'the requests');
  const box = (id: string) => $<HTMLInputElement>('input[type="checkbox"]', rowOf(id)!);
  /** Why a box cannot be chosen, as a screen reader hears it (its description). */
  const why = (id: string) => {
    const ref = box(id)?.getAttribute('aria-describedby');
    return ref ? textOf(document.getElementById(ref)) : '';
  };
  const blocked = (id: string) => box(id)?.getAttribute('aria-disabled') === 'true';
  check(blocked(EMAIL.id), 'an outside send cannot be approved with others');
  check(!box(EMAIL.id)?.disabled, 'yet its box still takes the focus, so its reason can be reached by keyboard');
  check(why(EMAIL.id).includes('Only new entries and changes can be approved together'), `and it says why: ${why(EMAIL.id)}`);
  await click(box(EMAIL.id), 'the outside send');
  check(!box(EMAIL.id)?.checked && !button(/^Approve chosen/), 'choosing it does nothing');
  await click(box(E1.id), 'the first invoice');
  check(blocked(BILL.id) && why(BILL.id).includes('the same kind of work'), 'another kind of work cannot join');
  check(textOf(rowOf(BILL.id)).includes('Not with the chosen ones'), 'which is said on screen while some are chosen');
  check(!blocked(E2.id), 'the same kind can');
  await click(box(E2.id), 'the second invoice');
  await click(button('Approve chosen (2)…'), 'Approve chosen');
  const confirm = await until(dialog, 'the confirmation');
  const listed = textOf($('[data-batch-list]', confirm));
  check(listed.includes('Enter invoice 1050 for Acme Supply') && listed.includes('Enter invoice 1051 for Acme Supply'), `it lists them: ${listed}`);
  check(!listed.includes('Staples'), 'only those');
  equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing is approved before the answer');
  await click(button('Approve all 2', confirm), 'Approve all 2');
  await until(() => textOf(dialog()).includes('What happened'), 'what happened');
  equal(JSON.stringify(posts(calls, '/api/agent-requests/batch-approve').map((c) => c.body)), JSON.stringify([{ ids: [E1.id, E2.id] }]), 'the two were sent');
  check(textOf(rowOf(E1.id)).includes('Done') && textOf(rowOf(E2.id)).includes('Done'), 'both are shown done');
  await unmount();
});

domTest('Approve similar… opens with narrow limits taken from the request, and sends them', async () => {
  const done = req({ status: 'executed', canApprove: false, grantId: 'cccccccc-0000-4000-8000-000000000001' });
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE] },
    [`GET /api/agent-requests/${BASE.id}`]: { request: BASE },
    [`POST /api/agent-requests/${BASE.id}/approve`]: { status: 'executed', request: done, produced: [], effects: [] } satisfies ApproveResult,
  });
  await mount(page());
  const card = await openCard(BASE.id);
  await click(button('Approve similar…', card), 'Approve similar…');
  const minutes = await until(() => $<HTMLSelectElement>('#similar-minutes'), 'for how long');
  equal(minutes.value, '60', 'an hour to start with');
  check(!$$<HTMLOptionElement>('option', minutes).some((o) => Number(o.value) > BASE.grantMinutesMax), 'never longer than this person may give');
  check($<HTMLInputElement>('#similar-amount-on')?.checked, 'the amount limit is ticked');
  equal($<HTMLInputElement>('input[aria-label="Largest amount"]')?.value, '1250.00', 'at the amount asked for');
  await click(button('Approve this and similar', dialog()!), 'Approve this and similar');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  const body = posts(calls, `/api/agent-requests/${BASE.id}/approve`)[0]?.body as { grant?: unknown };
  const month = monthOf(new Date());
  equal(
    JSON.stringify(body.grant),
    JSON.stringify({ minutes: 60, constraints: { maxAmount: '1250.00', entityIds: [ACME], dateFrom: month.dateFrom, dateTo: month.dateTo, maxUses: 10 } }),
    'the limits were sent',
  );
  check(textOf(dialog()).includes('may do more of the same without asking for 1 hour, until about'), 'the card says for how long');
  await unmount();
});

domTest('when standing permission could not be given, the card says so instead of claiming it', async () => {
  // The run went through, but the grant was not made: the server leaves grantId empty.
  const done = req({ status: 'executed', canApprove: false, grantId: null });
  stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE] },
    [`GET /api/agent-requests/${BASE.id}`]: { request: BASE },
    [`POST /api/agent-requests/${BASE.id}/approve`]: { status: 'executed', request: done, produced: [], effects: [] } satisfies ApproveResult,
  });
  await mount(page());
  const card = await openCard(BASE.id);
  await click(button('Approve similar…', card), 'Approve similar…');
  await click(button('Approve this and similar', dialog()!), 'Approve this and similar');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  check(!textOf(dialog()).includes('may do more of the same without asking'), 'no standing permission is claimed');
  check(textOf(dialog()).includes('standing permission was not given, so Month-end helper will ask again next time'), 'it says it was not given');
  await unmount();
});

domTest('a request Ironbooks did not try ahead of time says so, claims nothing about the ledger, and is read alone', async () => {
  stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE, PAYCHECK] },
    [`GET /api/agent-requests/${PAYCHECK.id}`]: { request: PAYCHECK },
  });
  await mount(page());
  await until(() => rowOf(PAYCHECK.id), 'the requests');
  const box = $<HTMLInputElement>('input[type="checkbox"]', rowOf(PAYCHECK.id)!);
  check(box?.getAttribute('aria-disabled') === 'true', 'it cannot be approved together with others');
  const ref = box?.getAttribute('aria-describedby');
  check(ref && textOf(document.getElementById(ref)).includes('could not try this one ahead of time'), 'and it says why');

  const card = await openCard(PAYCHECK.id);
  const t = textOf(card);
  check($('[data-not-tried]', card) && t.includes('Ironbooks did not try this ahead of time'), `it says it was not tried: ${t}`);
  check(t.includes('a preview of its own'), "with Ironbooks' own note");
  check(!t.includes('Nothing is posted to the ledger'), 'it never says nothing is posted');
  check(!t.includes('No recipient is named'), 'nor that the email has no recipient');
  check(t.includes('Who it goes to is not known ahead of time.'), 'it says who the email goes to is not known');
  check(button('Approve once', card) && !button('Approve once', card)?.disabled, 'it can still be approved on its own');
  await unmount();
});

domTest("nothing is approvable on the list's copy: the card's own copy must load first, and a failed load says so with Try again", async () => {
  let fail = true;
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [BASE] },
    [`GET /api/agent-requests/${BASE.id}`]: () => (fail ? reply(500, { error: 'Ironbooks is busy. Try again in a moment.' }) : { request: BASE }),
  });
  await mount(page());
  const row = await until(() => rowOf(BASE.id), 'the row');
  await click(button('Open', row), 'Open');
  const card = await until(() => (dialog() && $('[data-load-error]', dialog()!) ? dialog() : null), 'the load error');
  check(textOf(card).includes('Enter invoice 1042 for Acme Supply'), "the list's copy is shown");
  check(textOf($('[data-load-error]', card)).includes('cannot be approved until it loads'), 'it says why it cannot be approved');
  check(button('Approve once', card)?.disabled, 'Approve waits');
  check(!button('Approve similar…', card), 'and so does Approve similar…');
  fail = false;
  await click(button('Try again', card), 'Try again');
  await until(() => !$('[data-load-error]', dialog()!) && !button('Approve once', dialog()!)?.disabled, 'the card to load');
  check(button('Approve similar…', dialog()!), 'Approve similar… is offered once it loaded');
  equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing was sent');
  await unmount();
});

void runDomTests();
