// Agent requests (app/agent-requests), in a real browser window (test/domHarness.ts runs it; the
// vitest side is test/agentRequests.dom.test.ts).
//
// The list shows requests in plain words and greys what this person cannot approve; the card shows
// the agent's reason as its words and as text only; a typed password goes with the approval and is
// then in neither the page nor React's state; when the books changed nothing runs until a second,
// explicit Approve on that same card (a card opened later starts over), and a request the server
// marks as changed says so in the list and on the card; a secret the run produced is shown once;
// Deny carries the note; approving several at once is for one kind of work one person may approve
// alone, asks first and reports each; Approve similar… sends narrow limits, is filled in again
// when the books changed, and the card says what standing permission was really given (or why
// none was); a request Ironbooks did not try out says so instead of claiming nothing is posted, and
// one that voids or deletes names what, with amounts; nothing is approvable before the card's own
// copy has loaded; a desktop request shows the whole paths it opens and writes and asks the
// questions sent with it; secrets of several parts go as the one text the guards read; a typed mail
// password names its server; the address can name an agent or a request, also when a link is
// followed while the page is open. Entries are labelled by the bridge's `touched` mark, never by
// their description, and records that post nothing are named with the record changes.
import * as React from 'react';
import AgentRequestsPage from '@/app/agent-requests/page';
import { Toaster } from '@/components/ui';
import type { AgentRequestForPerson, ApproveResult, OperationPreview } from '@/lib/agent/contract';
import { encodeSecretParts } from '@/lib/agent/guards';
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
import { setTestPathname } from './stubs/next-navigation';

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

/** Replace what a text box holds, as a paste would (React reads the input event). */
async function fill(input: HTMLInputElement | null, value: string, what: string) {
  check(input, `missing ${what}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
  // Plan 7.2: by agent, kind of work and area.
  await choose($<HTMLSelectElement>('#ar-area'), 'company', 'the area filter');
  check(rowOf(ADMIN_ONLY.id) && !rowOf(BASE.id) && !rowOf(EMAIL.id), 'the area filter narrows the list');
  await choose($<HTMLSelectElement>('#ar-area'), '', 'the area filter');
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

// ---------------------------------------------------------------------------
// The second pass (wave 3): fields the requests service now fills in, answered here by the stubs
// ---------------------------------------------------------------------------

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * Put an address on the test page. The page reads ?id= and ?agentId= through useSearchParams (the
 * stub reads window.location), so a change shows once the page renders again: setTestPathname
 * makes it, as a link followed in the app would.
 */
function setQuery(query: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${query}`);
}

domTest('a request the server marks as changed says so in the list and on the card; Approve similar… is filled in again from the new preview', async () => {
  const CHANGED = req({ id: ids(20), stale: true, preview: LEDGER('1300.00'), amount: '1300.00' });
  const later = req({ ...CHANGED, preview: LEDGER('1325.00'), amount: '1325.00' });
  const GIVEN = { minutes: 15, constraints: { maxAmount: '1325.00', maxUses: 1 }, expiresAt: inMinutes(15) };
  const done = req({ ...later, stale: false, status: 'executed', canApprove: false, decidedByName: 'Pat Owner', grantId: 'cccccccc-0000-4000-8000-000000000002', grant: GIVEN });
  let asked = 0;
  const path = `/api/agent-requests/${CHANGED.id}/approve`;
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [CHANGED, req({ id: ids(21), summary: 'Enter invoice 1043 for Acme Supply' })] },
    [`GET /api/agent-requests/${CHANGED.id}`]: { request: CHANGED },
    [`POST ${path}`]: () => {
      asked++;
      return (asked === 1 ? { status: 'stale', request: later, produced: [], effects: [] } : { status: 'executed', request: done, produced: [], effects: [] }) satisfies ApproveResult;
    },
  });
  await mount(page());
  const row = await until(() => rowOf(CHANGED.id), 'the requests');
  check($('[data-stale-mark]', row) && textOf(row).includes('Open it to see what would happen now: it needs your approval again'), `the list marks it: ${textOf(row)}`);
  const box = $<HTMLInputElement>('input[type="checkbox"]', row);
  check(box?.getAttribute('aria-disabled') === 'true', 'it cannot be approved together with others');
  check(textOf(document.getElementById(box!.getAttribute('aria-describedby')!)).includes('The books changed since the agent asked'), 'and says why');

  const card = await openCard(CHANGED.id);
  const mark = textOf($('[data-stale-notice]', card));
  check(mark.includes('The preview below is what would happen now') && mark.includes('the first approval only confirms you have seen it'), `the card says the books changed, and what Approve does: ${mark}`);
  check(!textOf(card).includes('This is what would happen now'), 'it never says the preview was accepted');
  check(button('Approve once', card), 'the plain Approve is offered');
  await click(button('Approve similar…', card), 'Approve similar…');
  equal($<HTMLInputElement>('input[aria-label="Largest amount"]')?.value, '1300.00', 'the limit starts at the amount shown');
  // The person narrows it before the first yes: a quarter of an hour, once.
  await choose($<HTMLSelectElement>('#similar-minutes'), '15', 'for how long');
  await fill($<HTMLInputElement>('input[aria-label="Most times"]'), '1', 'most times');
  await click(button('Approve this and similar', dialog()!), 'Approve this and similar');
  await until(() => textOf(dialog()).includes('The books changed since the agent asked. This is what would happen now.'), 'the books-changed notice');
  check(!('acceptStale' in (posts(calls, path)[0].body as object)), 'the first yes accepted nothing unseen');
  equal($<HTMLInputElement>('input[aria-label="Largest amount"]')?.value, '1325.00', 'the amount was taken again from the new preview');
  equal($<HTMLSelectElement>('#similar-minutes')?.value, '15', 'the time the person chose is kept, never lengthened');
  equal($<HTMLInputElement>('input[aria-label="Most times"]')?.value, '1', 'and so is the number of times');
  const rebuilt = textOf($('[data-similar-rebuilt]', dialog()!));
  check(rebuilt.includes('The amount below now comes from what would happen now') && rebuilt.includes('every limit you had changed is kept'), `and it says so: ${rebuilt}`);
  check(!$('[data-stale-notice]', dialog()!), 'the mark gives way to the notice of what would happen now');

  await click(button('Approve what would happen now, and similar', dialog()!), 'Approve what would happen now, and similar');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  const second = posts(calls, path)[1].body as { acceptStale?: boolean; grant?: { minutes: number; constraints: { maxAmount?: string; maxUses?: number } } };
  equal(second.acceptStale, true, 'the second yes accepts the preview shown');
  equal(second.grant?.constraints.maxAmount, '1325.00', 'with the limit of the new preview');
  equal(JSON.stringify([second.grant?.minutes, second.grant?.constraints.maxUses]), JSON.stringify([15, 1]), "and the person's own time and number of times");
  const given = textOf($('[data-grant-given]', dialog()!));
  check(given.includes('Month-end helper may do more of the same without asking for 15 minutes, until about'), `what was given, and until when: ${given}`);
  check(given.includes('Amount at or below $1,325.00') && given.includes('Once'), 'with its limits');
  await unmount();
});

domTest('a done request links the entries the server names, and says why standing permission was not given', async () => {
  const E1 = 'bbbbbbbb-0000-4000-8000-000000000101';
  const E2 = 'bbbbbbbb-0000-4000-8000-000000000102';
  const ELSEWHERE = 'bbbbbbbb-0000-4000-8000-000000000199';
  const WHY = 'Standing permission for this can last at most 30 minutes, and 60 were asked for.';
  const done = req({
    status: 'executed',
    canApprove: false,
    decidedByName: 'Pat Owner',
    posted: true,
    entryIds: [E1, E2],
    // The answer names another entry: the server's list is the one that counts.
    result: { invoice: { postedEntryId: ELSEWHERE } },
    grant: null,
    grantError: WHY,
  });
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
  const notGiven = textOf($('[data-grant-not-given]', dialog()!));
  check(notGiven.includes('standing permission was not given') && notGiven.includes(WHY), `it says it was not given, and why: ${notGiven}`);
  check(!textOf(dialog()).includes('may do more of the same without asking'), 'no standing permission is claimed');
  const links = $$<HTMLAnchorElement>('[data-done-links] a', dialog()!);
  const hrefs = links.map((a) => a.getAttribute('href') ?? '');
  check(textOf(links[0]) === 'Open entry 1 of 2 it posted' && hrefs[0].startsWith(`/reports/open?entry=${E1}`), `the first entry: ${hrefs.join(' ')}`);
  check(textOf(links[1]) === 'Open entry 2 of 2 it posted' && hrefs[1].startsWith(`/reports/open?entry=${E2}`), 'the second entry');
  check(!hrefs.some((h) => h.includes(ELSEWHERE)), "not one the server did not name");
  await unmount();
});

domTest('approving several at once: two-person and host-only requests cannot be chosen; one not approved is shown with its reason, the rest as done', async () => {
  const E1 = req({ id: ids(31), summary: 'Enter invoice 1060 for Acme Supply', amount: '100.00' });
  const E2 = req({ id: ids(32), summary: 'Enter invoice 1061 for Acme Supply', amount: '200.00' });
  const TWO = req({ id: ids(33), summary: 'Enter invoice 1062 for Acme Supply', needs: { ...BASE.needs!, twoPerson: true } });
  const HOST = req({ id: ids(34), summary: 'Enter invoice 1063 for Acme Supply', needs: { ...BASE.needs!, hostOnly: true } });
  const WHY = 'The agent was paused, so this one was not approved. It is still waiting.';
  const results: ApproveResult[] = [
    { status: 'executed', request: { ...E1, status: 'executed', canApprove: false }, produced: [], effects: [] },
    { status: 'not_approved', request: { ...E2, error: WHY }, produced: [], effects: [] },
  ];
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [E1, E2, TWO, HOST] },
    'POST /api/agent-requests/batch-approve': { results },
  });
  await mount(page());
  await until(() => rowOf(E1.id), 'the requests');
  const box = (id: string) => $<HTMLInputElement>('input[type="checkbox"]', rowOf(id)!);
  const why = (id: string) => textOf(document.getElementById(box(id)?.getAttribute('aria-describedby') ?? '') ?? null);
  check(box(TWO.id)?.getAttribute('aria-disabled') === 'true' && why(TWO.id).includes('needs two people'), `two people: ${why(TWO.id)}`);
  check(box(HOST.id)?.getAttribute('aria-disabled') === 'true' && why(HOST.id).includes('only at the host computer'), `the host computer: ${why(HOST.id)}`);
  await click(box(TWO.id), 'the two-person request');
  check(!box(TWO.id)?.checked, 'choosing it does nothing');
  await click(box(E1.id), 'the first invoice');
  await click(box(E2.id), 'the second invoice');
  await click(button('Approve chosen (2)…'), 'Approve chosen');
  const confirm = await until(dialog, 'the confirmation');
  await click(button('Approve all 2', confirm), 'Approve all 2');
  await until(() => textOf(dialog()).includes('What happened'), 'what happened');
  equal(JSON.stringify(posts(calls, '/api/agent-requests/batch-approve').map((c) => c.body)), JSON.stringify([{ ids: [E1.id, E2.id] }]), 'only the two were sent');
  const done = textOf($('[data-batch-result="executed"]', dialog()!));
  const not = textOf($('[data-batch-result="not_approved"]', dialog()!));
  check(done.includes('Enter invoice 1060') && done.includes('Done.'), `the first is done: ${done}`);
  check(not.includes('Enter invoice 1061') && not.includes('Not approved') && not.includes(WHY), `the second is not approved, with why: ${not}`);
  check(!not.includes('Done.'), 'and is not called done');
  await click(button('Close', dialog()!), 'Close');
  check(textOf(rowOf(E1.id)).includes('Done') && textOf(rowOf(E2.id)).includes('Waiting'), 'the list shows the first done and the second still waiting');
  await unmount();
});

domTest('the ledger part names what a run voids or deletes, with the amounts, instead of saying nothing is posted', async () => {
  const VOID = req({
    id: ids(40),
    operation: 'invoices.void',
    class: 'change',
    summary: 'Void invoice 1042 for Acme Supply',
    preview: {
      ledger: {
        entries: [],
        changes: [
          { action: 'void', kind: 'invoice', id: 'inv-1' },
          { action: 'void', kind: 'journal_entry', id: 'je-77' },
        ],
      },
      records: [
        { action: 'void', kind: 'invoice', id: 'inv-1', fields: [{ field: 'status', before: 'open', after: 'void' }, { field: 'total', before: '1250.00', after: '0.00' }] },
        { action: 'void', kind: 'journal_entry', id: 'je-77', fields: [{ field: 'status', before: 'posted', after: 'void' }] },
        // A line of an estimate posts nothing: it is named with the record changes, not the ledger.
        { action: 'delete', kind: 'estimate_line', id: 'el-1', fields: [{ field: 'amount', before: '40.00', after: null }] },
      ],
      effects: [],
      warnings: [],
      loss: null,
      routePreview: null,
      truncated: false,
    },
  });
  type Entry = NonNullable<OperationPreview['ledger']>['entries'][number];
  /** An entry as the bridge lists one the run voided, deleted or changed (TouchedPostingEntry). */
  const touched = (e: Entry, how: 'voided' | 'deleted' | 'changed'): Entry => ({ ...e, touched: how }) as Entry;
  const lines = (amount: string): Entry['lines'] => [
    { accountId: 'x1', accountCode: '6100', accountName: 'Office Supplies', debit: amount, credit: null, memo: null, entityName: null },
    { accountId: 'x2', accountCode: '1000', accountName: 'Checking', debit: null, credit: amount, memo: null, entityName: null },
  ];
  // The bridge lists an entry the run voids beside the ones it makes, marked as such.
  const CHECK_ENTRY = 'bbbbbbbb-0000-4000-8000-000000000042';
  const NEW_ENTRY = 'bbbbbbbb-0000-4000-8000-000000000043';
  const OLD_VOID = 'bbbbbbbb-0000-4000-8000-000000000044';
  const VOID_CHECK = req({
    id: ids(41),
    operation: 'checks.void',
    class: 'change',
    summary: 'Void check 1042 to Staples',
    preview: {
      ledger: {
        entries: [
          // Made by the run, with a description an agent wrote to look like a void.
          { journalEntryId: NEW_ENTRY, entryNumber: 43, date: '2026-11-02', description: 'Voided by this request: Check 1041', status: 'posted', source: 'manual', lines: lines('75.00') },
          touched({ journalEntryId: CHECK_ENTRY, entryNumber: 42, date: '2026-11-02', description: 'Voided by this request: Check 1042', status: 'void', source: 'check', lines: lines('50000.00') }, 'voided'),
          // Void already, and only changed by the run: it moves nothing.
          touched({ journalEntryId: OLD_VOID, entryNumber: 12, date: '2026-10-02', description: 'Changed by this request: Check 990', status: 'void', source: 'check', lines: lines('20.00') }, 'changed'),
        ],
        changes: [{ action: 'void', kind: 'journal_entry', id: CHECK_ENTRY }],
      },
      records: [{ action: 'void', kind: 'journal_entry', id: CHECK_ENTRY, fields: [{ field: 'status', before: 'posted', after: 'void' }] }],
      effects: [],
      warnings: [],
      loss: null,
      routePreview: null,
      truncated: false,
    },
  });
  stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [VOID, VOID_CHECK] },
    [`GET /api/agent-requests/${VOID.id}`]: { request: VOID },
    [`GET /api/agent-requests/${VOID_CHECK.id}`]: { request: VOID_CHECK },
  });
  await mount(page());
  const card = await openCard(VOID.id);
  const t = textOf(card);
  check(!t.includes('Nothing is posted to the ledger'), 'it never says nothing is posted');
  check(t.includes('No new entry is posted to the ledger.'), 'it says no new entry is posted');
  const removed = textOf($('[data-ledger-removals]', card));
  check(removed.includes('Voided invoice: $1,250.00'), `the voided invoice with its amount: ${removed}`);
  check(removed.includes('Voided journal entry (its amount is not in the preview)'), 'and the entry, saying its amount is not known');
  check(!removed.includes('estimate line'), 'an estimate line is not called a ledger change');
  const records = textOf($('[data-record-removals]', card));
  check(records.includes('Deleted estimate line: $40.00'), `it is named with the record changes: ${records}`);
  await click(button('Close', card), 'Close');
  await until(() => !dialog(), 'the card to close');

  const check2 = await openCard(VOID_CHECK.id);
  const entryOf = (id: string) => $$('[data-entry]', check2).find((el) => textOf(el).includes(id)) ?? null;
  const labelOf = (el: Element | null) => textOf($('[data-entry-label]', el ?? document.createElement('div')));
  const entry = $('[data-entry-gone="void"]', check2);
  check(entry && entry.getAttribute('data-entry') === 'voided', 'the voided entry is shown as voided');
  const e = textOf(entry);
  check(labelOf(entry) === 'Voided' && e.includes('Check 1042') && e.includes('These amounts leave the ledger.'), `with what it is: ${e}`);
  check(!e.includes('Voided by this request'), "the bridge's own words are not repeated after the label");
  check(e.includes('$50,000.00') && e.includes('Office Supplies'), 'and its amounts');
  // The new entry reads as new, whatever its description says.
  const made = entryOf('Entry 43');
  check(made && made.getAttribute('data-entry') === 'new' && !made.hasAttribute('data-entry-gone'), 'an entry the run makes is new');
  equal(labelOf(made), 'Posts', 'and is labelled as posting');
  check(!textOf(made).includes('leave the ledger'), `its description does not make it a void: ${textOf(made)}`);
  check(textOf(made).includes('Voided by this request: Check 1041'), 'its description is shown as written');
  // An entry that was void already and that the run only changes moves nothing.
  const old = entryOf('Entry 12');
  check(old && old.getAttribute('data-entry') === 'changed' && !old.hasAttribute('data-entry-gone'), 'the changed entry is marked as changed');
  equal(labelOf(old), 'Changed', 'and labelled so');
  check(textOf(old).includes('void already: it moves nothing') && !textOf(old).includes('leave the ledger'), `and it moves nothing: ${textOf(old)}`);
  check(!textOf(check2).includes('Nothing is posted to the ledger'), 'never "nothing is posted"');
  check(!$('[data-ledger-removals]', check2), 'and the voided one is not named a second time');
  await unmount();
});

domTest('a desktop request shows the whole paths it opens and writes, asks the questions sent with it, and names the file it wrote', async () => {
  const BACKUP = 'D:\\Backups\\Acme 2026-11-01.bka';
  const TARGET = 'C:\\Users\\pat\\Documents\\Ironbooks\\Acme restored';
  const RESTORE = req({
    id: ids(50),
    operation: 'shell.backup.restoreAsNew',
    class: 'file',
    area: null,
    summary: `Restore backup ${BACKUP} as a new company file ${TARGET}`,
    amount: null,
    needs: { admin: true, fileAdmin: true, hostOnly: true, flag: null, secrets: [], twoPerson: false, grantable: 'no' },
    input: { body: { file: BACKUP, target: TARGET } },
    preview: { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { ran: false, note: 'Carried out by the desktop app.' }, truncated: false },
    grantMinutesMax: 0,
    questions: [
      { id: 'openNow', text: 'Once it is ready, open the new company file now?', kind: 'yes_no' },
      { id: 'cloudFolder', text: 'If the company file is in a cloud-sync folder, open it anyway?', kind: 'yes_no' },
    ],
  });
  const WRITTEN = `${TARGET}.ironbooks`;
  const done = req({ ...RESTORE, status: 'executed', canApprove: false, decidedByName: 'Pat Owner', result: { file: WRITTEN, opened: false } });
  const OUTBOX = 'C:\\Users\\pat\\Documents\\Ironbooks\\Agent Outbox';
  const SAVE = req({
    id: ids(51),
    operation: 'files.save',
    class: 'file',
    area: null,
    summary: `Save file f1 in ${OUTBOX}`,
    amount: null,
    needs: { admin: true, fileAdmin: false, hostOnly: true, flag: null, secrets: [], twoPerson: false, grantable: 'no' },
    input: { body: { fileId: 'f1', folder: OUTBOX, name: 'March.pdf' } },
    preview: {
      ledger: null,
      records: [],
      effects: [{ kind: 'file', summary: 'Save March.pdf (84 KB) in C:\\Users\\pat\\Doc…\\Agent Outbox', detail: { dir: OUTBOX, name: 'March.pdf', path: `${OUTBOX}\\March.pdf`, size: 86016, replaces: false } }],
      warnings: [],
      loss: null,
      routePreview: null,
      truncated: false,
    },
    grantMinutesMax: 0,
  });
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [RESTORE, SAVE] },
    [`GET /api/agent-requests/${RESTORE.id}`]: { request: RESTORE },
    [`GET /api/agent-requests/${SAVE.id}`]: { request: SAVE },
    [`POST /api/agent-requests/${RESTORE.id}/approve`]: { status: 'executed', request: done, produced: [], effects: [] } satisfies ApproveResult,
  });
  await mount(page());
  const card = await openCard(RESTORE.id);
  const paths = $$('[data-desktop-path]', card).map((p) => p.textContent);
  equal(JSON.stringify(paths), JSON.stringify([BACKUP, WRITTEN]), 'the file it reads and the company file it writes, ".ironbooks" added, in full');
  const t = textOf(card);
  check(t.includes('Once it is ready, open the new company file now?') && t.includes('open it anyway?'), 'the questions sent with the request are asked');
  check(button('Approve once', card)?.disabled, 'Approve waits for the answers');
  const radios = (name: string) => $$<HTMLInputElement>(`input[type="radio"][name="flow-q-${name}"]`, card);
  await click(radios('openNow')[0], 'Yes to opening it now');
  check(button('Approve once', card)?.disabled, 'every question must be answered');
  await click(radios('cloudFolder')[1], 'No to the cloud folder');
  check(!button('Approve once', card)?.disabled, 'Approve is ready');
  await click(button('Approve once', card), 'Approve once');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  equal(JSON.stringify(posts(calls, `/api/agent-requests/${RESTORE.id}/approve`)[0].body), JSON.stringify({ answers: { openNow: true, cloudFolder: false } }), 'the answers went with the approval');
  equal($('[data-written-path]', dialog()!)?.textContent, WRITTEN, 'it names the company file it wrote');
  await click(button('Close', dialog()!), 'Close');
  await until(() => !dialog(), 'the card to close');

  const saved = await openCard(SAVE.id);
  equal($('[data-file-path]', saved)?.textContent, `${OUTBOX}\\March.pdf`, 'a saved file shows the whole path it is written to');
  check(!$('[data-desktop-lines]', saved), 'from the preview, not from what the agent sent');
  await unmount();
});

domTest('secrets of several parts go as the one text the guards read: the sign-in of a protected backup, and a new company file password typed twice', async () => {
  const ARCHIVE = req({
    id: ids(60),
    operation: 'backups.restore',
    class: 'file',
    area: null,
    summary: 'Restore the whole company file from backup b1',
    amount: null,
    needs: { admin: true, fileAdmin: true, hostOnly: false, flag: null, secrets: ['archive_credentials'], twoPerson: false, grantable: 'no' },
    input: { query: { id: 'b1' } },
    preview: null,
    grantMinutesMax: 0,
  });
  const LOCK = req({
    id: ids(61),
    operation: 'file-lock.change',
    class: 'admin',
    area: null,
    summary: 'Set or remove the company file password (set)',
    amount: null,
    needs: { admin: true, fileAdmin: true, hostOnly: false, flag: null, secrets: ['file_password'], twoPerson: false, grantable: 'no' },
    input: { body: { action: 'set' } },
    preview: null,
    grantMinutesMax: 0,
  });
  const executed = (r: AgentRequestForPerson): ApproveResult => ({ status: 'executed', request: { ...r, status: 'executed', canApprove: false }, produced: [], effects: [] });
  const calls = stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [ARCHIVE, LOCK] },
    [`GET /api/agent-requests/${ARCHIVE.id}`]: { request: ARCHIVE },
    [`GET /api/agent-requests/${LOCK.id}`]: { request: LOCK },
    [`POST /api/agent-requests/${ARCHIVE.id}/approve`]: executed(ARCHIVE),
    [`POST /api/agent-requests/${LOCK.id}/approve`]: executed(LOCK),
  });
  await mount(page());
  const card = await openCard(ARCHIVE.id);
  check(textOf(card).includes('Sign-in for the protected backup'), 'it says what the boxes are for');
  const login = $<HTMLInputElement>('#secret-archive_credentials-login', card);
  const password = $<HTMLInputElement>('#secret-archive_credentials-password', card);
  check(login && password && $('#secret-archive_credentials-recoveryKey', card), 'a user name, a password and a recovery key');
  equal(password.type, 'password', 'the password is hidden');
  await focus(login, 'the user name');
  await typeText('patowner');
  check(button('Approve once', card)?.disabled, 'a user name alone is not enough');
  await focus(password, 'the password');
  await typeText('Arch1vePass');
  check(!button('Approve once', card)?.disabled, 'with its password it is');
  check(!reactStateHolds('Arch1vePass'), 'the password is not kept in state');
  await click(button('Approve once', card), 'Approve once');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  equal(
    JSON.stringify(posts(calls, `/api/agent-requests/${ARCHIVE.id}/approve`)[0].body),
    JSON.stringify({ secrets: { archive_credentials: encodeSecretParts({ login: 'patowner', password: 'Arch1vePass' }) } }),
    'the sign-in went as one text, made the way the guards read it',
  );
  check(!document.body.innerHTML.includes('Arch1vePass') && !reactStateHolds('Arch1vePass'), 'and is nowhere afterwards');
  await click(button('Close', dialog()!), 'Close');
  await until(() => !dialog(), 'the card to close');

  const lock = await openCard(LOCK.id);
  const type = async (sel: string, text: string) => {
    await focus($(sel, dialog()!), sel);
    await typeText(text);
  };
  await type('#secret-file_password-password', 'NewPass9');
  check(button('Approve once', lock)?.disabled, 'the new password must be typed twice');
  await type('#secret-file_password-confirm', 'NewPass8');
  await click(button('Approve once', dialog()!), 'Approve once');
  await until(() => textOf(dialog()).includes('not the same'), 'the copies to differ');
  equal(posts(calls, `/api/agent-requests/${LOCK.id}/approve`).length, 0, 'nothing was sent');
  check(!$$<HTMLInputElement>('input[type="password"]', dialog()!).some((i) => i.value), 'and the boxes are empty again');
  await type('#secret-file_password-password', 'NewPass9');
  await type('#secret-file_password-confirm', 'NewPass9');
  await type('#secret-file_password-currentPassword', 'OldPass1');
  await click(button('Approve once', dialog()!), 'Approve once');
  await until(() => textOf(dialog()).includes('Done.'), 'the run to be done');
  equal(
    JSON.stringify(posts(calls, `/api/agent-requests/${LOCK.id}/approve`)[0].body),
    JSON.stringify({ secrets: { file_password: encodeSecretParts({ password: 'NewPass9', currentPassword: 'OldPass1' }) } }),
    'the new and the current password went as one text, the second copy never',
  );
  check(!reactStateHolds('NewPass9') && !reactStateHolds('OldPass1'), 'neither is kept in state');
  await unmount();
});

domTest("the status words, who can approve, who can give standing permission, and the server a typed mail password goes to", async () => {
  const FIRST = req({ id: ids(70), summary: 'Enter invoice 1070 for Acme Supply', needs: { ...BASE.needs!, twoPerson: true }, decidedByName: 'Pat Owner' });
  const RUNNING = req({ id: ids(71), summary: 'Enter invoice 1071 for Acme Supply', status: 'approved', canApprove: false, decidedByName: 'Pat Owner' });
  const MAIL = req({
    id: ids(72),
    operation: 'email.test',
    class: 'outside',
    area: 'company',
    summary: 'Send a test email to pat@acme-supply.com',
    amount: null,
    // "аcme" begins with a Cyrillic "а": it looks like the company's own mail server.
    input: { body: { to: 'pat@acme-supply.com', draft: { host: 'smtp.аcme-supply.com', port: 587, security: 'starttls', fromEmail: 'books@acme-supply.com' } } },
    needs: { admin: false, fileAdmin: false, hostOnly: true, flag: null, flags: [], grantAdminOnly: true, secrets: ['mail_password'], twoPerson: false, grantable: 'short' },
    preview: { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { ran: false, note: '' }, truncated: false },
    grantMinutesMax: 0,
  });
  const HOST_GRANT = req({
    id: ids(73),
    kind: 'grant',
    operation: 'email.test',
    class: 'outside',
    area: 'company',
    summary: 'Standing permission to send test emails',
    amount: null,
    input: null,
    needs: { ...MAIL.needs!, secrets: [] },
    preview: null,
    grantAsked: { minutes: 30, constraints: { maxUses: 3 } },
    grantMinutesMax: 0,
  });
  stubFetch({
    'GET /api/agent-requests?status=pending': { requests: [FIRST, RUNNING, MAIL, HOST_GRANT] },
    [`GET /api/agent-requests/${FIRST.id}`]: { request: FIRST },
    [`GET /api/agent-requests/${MAIL.id}`]: { request: MAIL },
    [`GET /api/agent-requests/${HOST_GRANT.id}`]: { request: HOST_GRANT },
  });
  await mount(page());
  await until(() => rowOf(FIRST.id), 'the requests');
  check(textOf(rowOf(FIRST.id)).includes('Waiting for a second person'), 'a first approval waits for a second person');
  check(textOf(rowOf(RUNNING.id)).includes('Approved, being carried out'), `'approved' is being carried out: ${textOf(rowOf(RUNNING.id))}`);
  check(!rowOf(RUNNING.id)!.className.includes('opacity-60'), 'and is not waiting for anyone');

  const first = await openCard(FIRST.id);
  check(textOf(first).includes('Approved by Pat Owner. A second person must also approve before it runs.'), 'the card says who approved first');
  check(textOf($('[data-who-approves]', first)).includes('Two different people must approve it before it runs.'), 'and that two people must');
  await click(button('Close', first), 'Close');
  await until(() => !dialog(), 'the card to close');

  const mail = await openCard(MAIL.id);
  const who = textOf($('[data-who-approves]', mail));
  check(who.includes('Someone whose own role allows this work can approve this.'), `who can approve: ${who}`);
  check(who.includes("only at the host computer's own window"), 'and where');
  // Host-only work: nobody can give standing permission for it, Admins included, so the card does
  // not send the person to an Admin.
  const rule = textOf($('[data-grant-rule]', mail));
  equal(rule, 'Standing permission cannot be given for this: it is approved one request at a time, at the host computer.', 'who can give standing permission');
  check(!who.includes('Only an Admin can give'), 'and no Admin is named for it');
  const server = $('[data-mail-server]', mail);
  check(server && textOf(server).includes('The password you type is sent to the mail server'), 'the mail password says where it goes');
  equal(textOf($('[data-mail-host]', server)), 'smtp.xn--cme-supply-yqi.com', 'the server, spelled as it really is');
  check(textOf(server).includes('on port 587') && textOf(server).includes('uses letters from other alphabets'), 'with its port, and the look-alike called out');
  await click(button('Close', mail), 'Close');
  await until(() => !dialog(), 'the card to close');

  // An agent asks for standing permission for host-only work: the card says nobody can give it.
  const hostGrant = await openCard(HOST_GRANT.id);
  const note = textOf($('[role="note"]', hostGrant));
  check(note.includes('Standing permission cannot be given for this: it is approved one request at a time, at the host computer.'), `why none can be given: ${note}`);
  check(!note.includes('ask an Admin'), 'and it does not send the person to an Admin');
  check(!button('Give permission', hostGrant), 'nothing is offered');
  await unmount();
});

domTest('the address can name an agent to start with, and a request to open', async () => {
  const QUIET = '44444444-4444-4444-8444-444444444444';
  try {
    stubFetch({ 'GET /api/agent-requests?status=pending': { requests: [BASE, ADMIN_ONLY, EMAIL] } });
    setQuery(`?agentId=${NIGHT}`);
    await mount(page());
    await until(() => rowOf(ADMIN_ONLY.id), 'the requests');
    check(!rowOf(BASE.id) && !rowOf(EMAIL.id), "only that agent's requests are listed");
    equal($<HTMLSelectElement>('#ar-agent')?.value, NIGHT, 'the agent filter starts on it');
    await unmount();

    const calls = stubFetch({
      'GET /api/agent-requests?status=pending': { requests: [BASE] },
      [`GET /api/agent-requests?status=all&agentId=${QUIET}&limit=1`]: { requests: [req({ id: ids(80), agentId: QUIET, agentName: 'Quiet helper', status: 'executed' })] },
    });
    setQuery(`?agentId=${QUIET}`);
    await mount(page());
    await until(() => textOf().includes('No requests from Quiet helper match'), 'the empty list, naming the agent');
    check(calls.some((c) => c.path === `/api/agent-requests?status=all&agentId=${QUIET}&limit=1`), "its name was looked up from its own requests");
    const sel = $<HTMLSelectElement>('#ar-agent');
    equal(sel?.selectedOptions[0]?.textContent, 'Quiet helper', 'the filter names it');
    await unmount();

    stubFetch({
      'GET /api/agent-requests?status=pending': { requests: [BASE, EMAIL] },
      [`GET /api/agent-requests/${EMAIL.id}`]: { request: EMAIL },
    });
    setQuery(`?id=${EMAIL.id}`);
    await mount(page());
    const card = await until(() => (dialog() && $('[data-request-summary]', dialog()!) ? dialog() : null), 'the card');
    equal(textOf($('[data-request-summary]', card)), 'Email invoice 1042 to billing@acme-supply.com', 'the request it names is open');
    await unmount();
  } finally {
    setQuery('');
  }
});

domTest('a link followed while the page is open opens its card, and changes the agent filter', async () => {
  /** Follow a link to the approval center while it is open (the address changes; the page stays). */
  const follow = async (query: string) => {
    setQuery(query);
    setTestPathname('/agent-requests');
    await settle();
  };
  try {
    stubFetch({
      'GET /api/agent-requests?status=pending': { requests: [BASE, ADMIN_ONLY, EMAIL] },
      [`GET /api/agent-requests/${EMAIL.id}`]: { request: EMAIL },
      [`GET /api/agent-requests/${BASE.id}`]: { request: BASE },
    });
    setQuery('');
    await mount(page());
    await until(() => rowOf(BASE.id), 'the requests');
    check(!dialog(), 'no card is open to start with');

    // The Ask AI panel's "Open in Agent requests" link, followed from here.
    await follow(`?id=${EMAIL.id}`);
    const card = await until(() => (dialog() && $('[data-request-summary]', dialog()!) ? dialog() : null), 'the card it names');
    equal(textOf($('[data-request-summary]', card)), 'Email invoice 1042 to billing@acme-supply.com', 'the request it names is open');
    await click(button('Close', card), 'Close');
    await until(() => !dialog(), 'the card to close');

    // Another one.
    await follow(`?id=${BASE.id}`);
    const next = await until(() => (dialog() && $('[data-request-summary]', dialog()!) ? dialog() : null), 'the next card');
    equal(textOf($('[data-request-summary]', next)), 'Enter invoice 1042 for Acme Supply', 'a new ?id= opens its own card');
    await click(button('Close', next), 'Close');
    await until(() => !dialog(), 'the card to close');

    // The Agents tab's link: the filter follows it.
    await follow(`?agentId=${NIGHT}`);
    await until(() => !rowOf(BASE.id), 'the list to narrow');
    check(rowOf(ADMIN_ONLY.id) && !rowOf(EMAIL.id), "only that agent's requests are listed");
    equal($<HTMLSelectElement>('#ar-agent')?.value, NIGHT, 'the agent filter follows the address');
    // A malformed id is ignored.
    await follow('?id=not-an-id');
    await settle(60);
    check(!dialog(), 'a malformed id opens nothing');
    await unmount();
  } finally {
    setQuery('');
  }
});

void runDomTests();
