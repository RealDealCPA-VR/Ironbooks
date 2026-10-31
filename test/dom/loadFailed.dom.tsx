// Pages whose first load fails say "This page could not be loaded." with Try again (instead of a
// loading skeleton for ever), and Try again against a working server loads the page. Multi-user
// keeps refreshing every 30 seconds: a failed refresh is noted once on the page, never as a toast.
import * as React from 'react';
import PrivacyNetworkPage from '@/app/privacy/page';
import MultiUserPage from '@/app/multi-user/page';
import PasswordPolicyEditor from '@/app/users/PasswordPolicyEditor';
import { Toaster, toast } from '@/components/ui';
import { $, $$, button, check, click, domTest, equal, mount, reply, runDomTests, settle, stubFetch, textOf, until, type FetchAnswer } from './kit';

const FAILED = 'This page could not be loaded.';
const down = reply(500, { error: 'The server is restarting.' });

/** A route that fails while `state.down` is true. */
function flaky(state: { down: boolean }, body: unknown): FetchAnswer {
  return () => (state.down ? down : body);
}

/** The failed-load notice, its message and its Try again button. */
async function failedNotice() {
  const alert = await until(() => $$('[role="alert"]').find((a) => textOf(a).includes(FAILED)), `"${FAILED}"`);
  check(textOf(alert).includes('The server is restarting.'), `the notice says what failed: ${textOf(alert)}`);
  const retry = button('Try again', alert);
  check(retry, 'the notice offers Try again');
  return retry;
}

const gets = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;

// ---------------------------------------------------------------------------

const POLICY = {
  policy: { mode: 'tailnet-only', cloudOptIn: { ai: false, email: false, 'vendor-lookup': false, updates: true }, vendorLookupUrl: null },
  canEdit: true,
  ceiling: null,
  effectiveMode: 'tailnet-only',
  purposes: [],
  recent: [],
};

domTest('Privacy & Network: a failed first load offers Try again, which loads the page', async () => {
  const server = { down: true };
  const calls = stubFetch({ 'GET /api/network-policy': flaky(server, POLICY) });
  await mount(<PrivacyNetworkPage />);
  const retry = await failedNotice();
  check(!textOf().includes('Your books stay on this computer.'), 'the settings are not shown');

  server.down = false;
  await click(retry, 'Try again');
  await until(() => textOf().includes('Your books stay on this computer.'), 'the page after Try again');
  check(textOf().includes('Network mode'), 'the network modes are shown');
  check(!textOf().includes(FAILED), 'the failure notice is gone');
  equal(gets(calls, '/api/network-policy'), 2, 'one load and one retry');
});

// ---------------------------------------------------------------------------

const SESSIONS = {
  isAdmin: true,
  currentSessionId: 'me',
  activeWindowMinutes: 15,
  connectedCount: 2,
  singleUser: null,
  sessions: [
    { id: 'me', userId: 'u1', userName: 'Pat Owner', userEmail: 'pat@example.com', remoteAddr: null, userAgent: null, viaHost: false, createdAt: '2026-10-30T08:00:00.000Z', lastSeenAt: '2026-10-30T08:00:00.000Z', isCurrent: true },
    { id: 's2', userId: 'u2', userName: 'Sam Clerk', userEmail: 'sam@example.com', remoteAddr: '100.64.0.7', userAgent: null, viaHost: true, createdAt: '2026-10-30T08:05:00.000Z', lastSeenAt: '2026-10-30T08:05:00.000Z', isCurrent: false },
  ],
};

domTest('Multi-user: a failed first load offers Try again, which loads the page', async () => {
  const server = { down: true };
  const calls = stubFetch({ 'GET /api/sessions': flaky(server, SESSIONS) });
  await mount(<MultiUserPage />);
  const retry = await failedNotice();
  check(!textOf().includes('Who is logged in'), 'the session list is not shown');

  server.down = false;
  await click(retry, 'Try again');
  await until(() => textOf().includes('Sam Clerk'), 'the signed-in sessions after Try again');
  check(textOf().includes('Who is logged in'), 'the page is shown');
  check(!textOf().includes(FAILED), 'the failure notice is gone');
  equal(gets(calls, '/api/sessions'), 2, 'one load and one retry');
});

domTest('Multi-user: a failed 30-second refresh is noted once on the page, never as a toast', async () => {
  // Catch the page's 30-second refresh timer so the test can fire it (the real one would take 30 s).
  const realSetInterval = window.setInterval;
  const refreshes: Array<() => void> = [];
  window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (ms === 30000 && typeof fn === 'function') refreshes.push(fn as () => void);
    return realSetInterval(fn, ms, ...rest);
  }) as typeof window.setInterval;
  try {
    const server = { down: false };
    const calls = stubFetch({ 'GET /api/sessions': flaky(server, SESSIONS) });
    await mount(
      <>
        <Toaster />
        <MultiUserPage />
      </>,
    );
    await until(() => textOf().includes('Sam Clerk'), 'the signed-in sessions');
    equal(refreshes.length, 1, 'the page refreshes itself every 30 seconds');
    const toasts = () => $$('[aria-live="polite"] > [role]');
    const notes = () => $$('[role="status"]').filter((n) => textOf(n).includes('Could not refresh this page'));

    // The server goes away; three refreshes (a minute and a half) fail.
    server.down = true;
    for (let i = 0; i < 3; i++) {
      refreshes[0]();
      await settle(80);
    }
    equal(gets(calls, '/api/sessions'), 4, 'the first load and three refreshes asked the server');
    equal(toasts().length, 0, `no toast for a failed refresh (toasts: ${toasts().map((t) => textOf(t)).join(' | ')})`);
    equal(notes().length, 1, 'the page notes the failed refresh once');
    check(textOf(notes()[0]).includes('The server is restarting.'), 'the note says what failed');
    check(textOf().includes('Sam Clerk'), 'the last known sessions stay on screen');
    check(!textOf().includes(FAILED), 'a failed refresh is not a failed page');

    // Back again: the next refresh clears the note.
    server.down = false;
    refreshes[0]();
    await until(() => notes().length === 0, 'a successful refresh clears the note');
    equal(toasts().length, 0, 'still no toast');

    // The Toaster is live: a real toast would have been seen.
    toast('probe', 'info');
    await until(() => toasts().some((t) => textOf(t).includes('probe')), 'the Toaster shows toasts in this test');
  } finally {
    window.setInterval = realSetInterval;
  }
});

// ---------------------------------------------------------------------------

domTest('Users & Roles > Password rules: a failed load offers Try again, which loads the rules', async () => {
  const server = { down: true };
  const calls = stubFetch({
    'GET /api/users/password-policy': flaky(server, { minLength: 12, requireLettersAndNumbers: true, requireSymbol: true, expiryDays: 90, historyCount: 3 }),
  });
  await mount(<PasswordPolicyEditor />);
  const retry = await failedNotice();
  check(!textOf().includes('Loading password rules'), 'it no longer says "Loading…" for ever');

  server.down = false;
  await click(retry, 'Try again');
  await until(() => textOf().includes('Password rules for this company file'), 'the rules after Try again');
  equal($<HTMLInputElement>('#pp-min')?.value, '12', 'the loaded minimum length');
  check(!textOf().includes(FAILED), 'the failure notice is gone');
  equal(gets(calls, '/api/users/password-policy'), 2, 'one load and one retry');
});

void runDomTests();
