/**
 * Agent full access: secrets go through the person, never the agent (plan 4.6, 5.8, 10 "Secrets").
 *
 * A scripted run on a real PGlite company with the app's own modules: an agent asks through the
 * door (lib/agent/operate.ts handleVerb, its context from its token), and the Admin approves in
 * lib/services/agentRequests.ts, typing on the card (ApproveInput.secrets):
 *  - the closing-date password, to post a journal entry dated in a closed period (once right,
 *    once wrong) and to move the closing date;
 *  - a mail server password, for a test email through a mail server the agent wrote down;
 *  - a new user's password, and the temporary password of a reset that makes them choose their own;
 *  - the password of a portable copy of the company file (a backup).
 * One run produces a secret itself: a phone upload link for receipts (the link IS the secret).
 *
 * Afterwards every row of every table (agent_permission_requests, agent_requests, audit_logs and
 * ai_proposals among them), the transaction log file, the staged files, the console and every
 * answer the agent received are read as text and searched for each secret, as typed and in the
 * encodings the app uses for headers and bytes: none may appear. So is every file of the scenario
 * as raw bytes, the company file's own pages and write-ahead log among them (kept uncompressed
 * for the run), which also holds what a row held before it was overwritten. Also:
 *  - an agent that puts a secret-named field in its own input has it stripped before anything is
 *    stored, and the run uses the person's value, never the agent's;
 *  - a secret a run produces is only in ApproveResult.produced: not in the request a person or the
 *    agent reads, not in any row.
 *
 * Only the mail transport is replaced (and no desktop shell is running): test/helpers/agentSecretsScenario.ts.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';

const h = vi.hoisted(() => ({ headers: new Map<string, string>(), cookies: new Map<string, string>() }));
// Outside a route there is no request: an empty one, as a script would see it.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

import { agentPermissionRequests, companies, journalEntries, users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth';
import type { AgentOperationAnswer, AgentRequestView, ApproveInput, ApproveResult } from '@/lib/agent/contract';
import { PRODUCED_SECRET_TEXT } from '@/lib/agent/guards';
import { setClosingDate } from '@/lib/services/company';
import { sendTestEmail } from '@/lib/services/emailSettings';
import { saveAgentPolicy } from '@/lib/services/agentPolicies';
import { unlockPortableBuffer } from '@/lib/services/portableFile';
import { readAllTransactionLog, transactionLogPath } from '@/lib/services/transactionLog';
import { approveAgentRequest, requestForPerson, waitForDecision } from '@/lib/services/agentRequests';
import { runAgentAction } from '@/lib/agent/actions';
// The curated actions register themselves here, as POST /api/agent/actions loads them.
import '@/lib/agent/catalog';
import {
  captureConsole,
  consoleLines,
  describeHits,
  findSecrets,
  flushToDisk,
  folderTexts,
  mailbox,
  scanFiles,
  scanTables,
  setupScenario,
  storeUncompressed,
  tableNames,
  transactionLogTexts,
  transcript,
  transcriptTexts,
  type Hit,
  type Needle,
  type Scenario,
  type ScenarioAgent,
} from './helpers/agentSecretsScenario';

// What the person types on the card. Letters, digits and dashes only, so JSON and URL encoding
// leave them as they are; the scan also looks for base64, base64url and hex.
const CLOSING_PW = 'Clos3-Card-Pw-7f3a91';
const WRONG_CLOSING_PW = 'Wr0ng-Clos3-Pw-44aa1';
const MAIL_PW = 'Ma1l-Card-Pw-2b7c55';
const MAIL_SAVE_PW = 'Ma1l-Saved-Card-Pw-8e1f07';
const NEW_USER_PW = 'N3w-User-Card-Pw-9d4e17';
const RESET_PW = 'R3set-Temp-Card-Pw-6a8b42';
const BACKUP_PW = 'B4ckup-Card-Pw-1c5d83';
// Typed on a card that needs none, and by the first of two approvers.
const EXTRA_PW = 'Extr4-Closing-Pw-0b1c2d';
const EXTRA_PW_2 = 'Extr4-Backup-Pw-3e4f5a';
const EXTRA_PW_3 = 'Extr4-Mail-Pw-6b7c8d';
const FIRST_OF_TWO_PW = 'F1rst-Of-Two-Pw-9e0f1a';
const EXTRA_ANSWER_PW = 'Extr4-Answer-Pw-2c3d4e';
// What the agent puts in its own input, named like a secret: it must be stripped, never stored.
const AGENT_PW = 'Ag3nt-Own-Pw-0e0e51';
const AGENT_CURRENT_PW = 'Ag3nt-Current-Pw-77ab3';
const AGENT_KEY = 'Ag3nt-Api-Key-5f5f19';
const AGENT_MAIL_PW = 'Ag3nt-Mail-Pw-31c0de';
const AGENT_BACKUP_PW = 'Ag3nt-Backup-Pw-9a9a02';

let s: Scenario;
let agent: ScenarioAgent;
/** Every ApproveResult the person's screen got. */
const approvals: ApproveResult[] = [];
/** Secrets runs produced (shown once to the approver), to look for afterwards. */
const produced: Needle[] = [];
/** Parts of a produced secret that are secret on their own (the token of a link). */
const producedParts: Needle[] = [];
let seq = 0;

const typed: Needle[] = [
  { label: 'the closing-date password', value: CLOSING_PW },
  { label: 'a wrong closing-date password', value: WRONG_CLOSING_PW },
  { label: 'the mail server password', value: MAIL_PW },
  { label: 'the mail server password saved for the company', value: MAIL_SAVE_PW },
  { label: "the new user's password", value: NEW_USER_PW },
  { label: 'the temporary password of the reset', value: RESET_PW },
  { label: 'the password of the portable copy', value: BACKUP_PW },
  { label: 'a closing-date password typed on a card that needs none', value: EXTRA_PW },
  { label: 'a copy password typed on a card that needs none', value: EXTRA_PW_2 },
  { label: 'a mail password typed on a card that needs none', value: EXTRA_PW_3 },
  { label: 'what the first of two approvers typed', value: FIRST_OF_TWO_PW },
  { label: 'an answer named like a password', value: EXTRA_ANSWER_PW },
];
const agentSent: Needle[] = [
  { label: "the agent's own password field", value: AGENT_PW },
  { label: "the agent's own currentPassword field", value: AGENT_CURRENT_PW },
  { label: "the agent's own apiKey field", value: AGENT_KEY },
  { label: "the agent's own mail password", value: AGENT_MAIL_PW },
  { label: "the agent's own copy password", value: AGENT_BACKUP_PW },
];

const key = (what: string) => `secrets-${what}-${(seq += 1)}`;

async function approve(requestId: string, secrets: Record<string, string>, more: Omit<ApproveInput, 'secrets'> = {}): Promise<ApproveResult> {
  const r = await approveAgentRequest(await s.admin.ctx(), requestId, { ...more, secrets }, { atHost: true });
  approvals.push(JSON.parse(JSON.stringify(r)));
  return r;
}

/** The agent asks; the answer must be 'asked' (a person approves it). */
async function asked(args: Record<string, unknown>): Promise<AgentOperationAnswer> {
  const a = await agent.run(args);
  expect(a.outcome, JSON.stringify(a)).toBe('asked');
  expect(a.requestId).toBeTruthy();
  return a;
}

/** What the agent reads of its request now (list_my_requests), kept in the transcript. */
async function agentView(requestId: string): Promise<AgentRequestView> {
  const { requests } = await agent.verb('list_my_requests', { limit: 200 });
  const v = requests.find((r) => r.id === requestId);
  if (!v) throw new Error(`The agent does not see request ${requestId}`);
  return v;
}

const JE_LINES = () => [
  { accountId: s.rich.acct['6300'], debit: '125.00', memo: 'Year-end accrual' },
  { accountId: s.rich.acct['1000'], credit: '125.00' },
];

beforeAll(async () => {
  captureConsole();
  s = await setupScenario('test-agent-secrets');
  // So that the scan of the raw files at the end sees every value as it was written.
  expect(await storeUncompressed(s.db)).toBeGreaterThan(50);
  // The agent may hold the Admin role (D1) and asks for everything above plain entry.
  agent = await s.makeAgent('Secrets Agent', 'full_with_asks', { roleKeys: ['admin'] });
  // A person set the closing date with its password in Ironbooks (never through an agent).
  await setClosingDate(await s.admin.ctx(), { closingDate: '2025-12-31', password: CLOSING_PW });
  // A person allowed phone receipt links (Preferences > Integrated Applications).
  await s.setSettings({ allowPhoneReceipts: true });
}, 240_000);

afterAll(async () => {
  await s?.close();
});

describe('the closing-date password, typed by the approver', () => {
  it('a journal entry dated in a closed period is asked, never tried, and posts with the password the person typed', async () => {
    const a = await asked({
      operation: 'journal-entries.create',
      requestId: key('je'),
      reason: 'Post the year-end accrual the accountant sent.',
      // The agent sends passwords of its own every way it can: they are taken out.
      body: { date: '2025-11-14', description: 'Year-end accrual', lines: JE_LINES(), password: AGENT_PW, currentPassword: AGENT_CURRENT_PW, closingPassword: AGENT_PW },
    });
    expect(a.needs?.secrets).toContain('closing_password');
    expect(a.note ?? '').toMatch(/password|currentPassword/);

    const r = await approve(a.requestId!, { closing_password: CLOSING_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    expect(r.produced).toEqual([]);
    const [je] = await s.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, s.companyId), eq(journalEntries.description, 'Year-end accrual')))
      .orderBy(desc(journalEntries.createdAt));
    expect(je, 'the entry was posted').toBeTruthy();

    const seen = await agentView(a.requestId!);
    expect(seen.status).toBe('executed');
  });

  it('a wrong password fails the request in plain words, and the words hold no password', async () => {
    const a = await asked({
      operation: 'journal-entries.create',
      requestId: key('je-wrong'),
      reason: 'Post the second accrual.',
      body: { date: '2025-11-20', description: 'Second accrual', lines: JE_LINES() },
    });
    const r = await approve(a.requestId!, { closing_password: WRONG_CLOSING_PW });
    expect(r.status).toBe('failed');
    expect(r.request.error).toBeTruthy();
    expect(r.request.error).not.toContain(WRONG_CLOSING_PW);
    const seen = await agentView(a.requestId!);
    expect(seen.status).toBe('failed');
    expect(seen.error ?? '').not.toContain(WRONG_CLOSING_PW);
  });

  it('moving the closing date is asked with the password; the agent cannot set a new one', async () => {
    const a = await asked({
      operation: 'company.closing-date.update',
      requestId: key('closing'),
      reason: 'The accountant closed January.',
      body: { closingDate: '2026-01-31', password: AGENT_PW, currentPassword: AGENT_CURRENT_PW },
    });
    expect(a.needs?.secrets).toEqual(['closing_password']);
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    expect(JSON.stringify(row.input)).not.toMatch(/password/i);

    const r = await approve(a.requestId!, { closing_password: CLOSING_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    const [co] = await s.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, s.companyId));
    const settings = (co?.settings ?? {}) as Record<string, unknown>;
    expect(settings.closingDate).toBe('2026-01-31');
    // The agent's new password did not become the closing-date password: the person's still holds.
    const hash = settings.closingDatePasswordHash;
    expect(typeof hash, 'the closing date still has its password').toBe('string');
    expect(await verifyPassword(AGENT_PW, hash as string)).toBe(false);
    expect(await verifyPassword(CLOSING_PW, hash as string)).toBe(true);
  });
});

describe('the mail server password, typed by the approver', () => {
  it('a test email through the mail server the agent wrote down signs in with the password the person typed', async () => {
    const before = mailbox.length;
    const a = await asked({
      operation: 'email.test',
      requestId: key('mail'),
      reason: 'Check the new mail server before the statements go out.',
      body: {
        to: 'books@secrets-scenario.test',
        draft: {
          host: '192.168.1.25',
          port: 587,
          security: 'starttls',
          username: 'books@secrets-scenario.test',
          password: AGENT_MAIL_PW,
          fromEmail: 'books@secrets-scenario.test',
          fromName: 'Scenario Books',
        },
      },
    });
    expect(a.needs?.secrets).toEqual(['mail_password']);
    // The person is told where the password goes.
    expect(a.summary).toContain('192.168.1.25');
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    expect(JSON.stringify(row.input)).not.toContain(AGENT_MAIL_PW);

    const r = await approve(a.requestId!, { mail_password: MAIL_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    const sent = mailbox.slice(before);
    expect(sent).toHaveLength(1);
    const auth = (sent[0].options.auth ?? {}) as Record<string, unknown>;
    // The person's password reached the mail server, never the agent's.
    expect(auth.pass).toBe(MAIL_PW);
    expect(sent[0].options.host).toBe('192.168.1.25');
    expect(JSON.stringify(sent[0].message)).not.toContain(MAIL_PW);
  });

  it('saving the mail server keeps the password the person typed sealed: it signs in, and is never stored as typed', async () => {
    const a = await asked({
      operation: 'email.settings.update',
      requestId: key('mail-save'),
      reason: 'Save the new mail server for the statements.',
      body: {
        host: '192.168.1.26',
        port: 587,
        security: 'starttls',
        username: 'books@secrets-scenario.test',
        password: AGENT_MAIL_PW,
        fromEmail: 'books@secrets-scenario.test',
        fromName: 'Scenario Books',
      },
    });
    expect(a.needs?.secrets).toEqual(['mail_password']);
    // The person is told which server the password is saved for.
    expect(a.summary).toContain('192.168.1.26');
    const r = await approve(a.requestId!, { mail_password: MAIL_SAVE_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    // A person's own test of the saved set-up signs in with what was typed on the card. (The
    // scan at the end proves it is kept only sealed.)
    const before = mailbox.length;
    const tested = await sendTestEmail(await s.admin.ctx(), { to: 'ada@secrets-scenario.test' });
    expect(tested.ok, JSON.stringify(tested)).toBe(true);
    expect(mailbox.length).toBe(before + 1);
    const auth = (mailbox[before].options.auth ?? {}) as Record<string, unknown>;
    expect(mailbox[before].options.host).toBe('192.168.1.26');
    expect(auth.pass).toBe(MAIL_SAVE_PW);
  });

  // FAILS today (wave 3, tests-secrets): with the launch pass enforced (BKA_LAUNCH_PASS, as the
  // packaged app always runs), the run approved at the host is refused by the route itself with
  // "This can only be done on the computer that holds the company file." lib/agent/bridge.ts
  // buildRequest makes the handler's request without the launch pass, so app/api/email/test's own
  // isRemoteRequest(req) (lib/net/requestInfo.ts originFromHeaders) reads it as another program
  // on this computer. Fails closed (nothing is sent, no secret leaks), but no host-only route
  // that checks the request itself can ever be carried out for an agent in the real app. The case
  // above passes only because the test suite runs without a launch pass.
  it.fails('the same, with the launch pass enforced as in the packaged app: approved at the host, it still runs', async () => {
    const before = mailbox.length;
    const a = await asked({
      operation: 'email.test',
      requestId: key('mail-pass'),
      reason: 'Check the mail server once more.',
      body: {
        to: 'books@secrets-scenario.test',
        draft: { host: '192.168.1.25', port: 587, security: 'starttls', username: 'books@secrets-scenario.test', fromEmail: 'books@secrets-scenario.test' },
      },
    });
    process.env.BKA_LAUNCH_PASS = 'pass-of-this-launch-0123456789abcdef';
    let r: ApproveResult;
    try {
      r = await approve(a.requestId!, { mail_password: MAIL_PW });
    } finally {
      delete process.env.BKA_LAUNCH_PASS;
    }
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    expect(mailbox.length).toBe(before + 1);
    expect(((mailbox[before].options.auth ?? {}) as Record<string, unknown>).pass).toBe(MAIL_PW);
  });
});

describe("a user's password, typed by the approving Admin", () => {
  let newUserId = '';

  it('a new user gets the password the Admin typed, never the one the agent sent', async () => {
    const a = await asked({
      operation: 'users.create',
      requestId: key('user'),
      reason: 'Add the new bookkeeper, Dana Lee.',
      body: { name: 'Dana Lee', login: 'dana.lee@secrets-scenario.test', roleKeys: ['bookkeeper'], password: AGENT_PW },
    });
    expect(a.needs?.secrets).toEqual(['new_user_password']);
    expect(a.needs?.admin).toBe(true);
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    expect(row.input).toBeTruthy();
    expect(JSON.stringify(row.input)).not.toContain(AGENT_PW);

    const r = await approve(a.requestId!, { new_user_password: NEW_USER_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    const [u] = await s.db.select().from(users).where(eq(users.email, 'dana.lee@secrets-scenario.test'));
    expect(u, 'the user was added').toBeTruthy();
    newUserId = u.id;
    expect(await verifyPassword(NEW_USER_PW, u.passwordHash!)).toBe(true);
    expect(await verifyPassword(AGENT_PW, u.passwordHash!)).toBe(false);
  });

  it('a reset sets the temporary password the Admin typed, and the user must choose their own', async () => {
    expect(newUserId).not.toBe('');
    const a = await asked({
      operation: 'users.reset-password',
      requestId: key('reset'),
      reason: 'Dana forgot her password.',
      params: { id: newUserId },
      body: { requireChange: true, password: AGENT_PW, currentPassword: AGENT_CURRENT_PW },
    });
    expect(a.needs?.secrets).toEqual(['new_user_password']);
    const r = await approve(a.requestId!, { new_user_password: RESET_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    const [u] = await s.db.select().from(users).where(eq(users.id, newUserId));
    expect(await verifyPassword(RESET_PW, u.passwordHash!)).toBe(true);
    expect(await verifyPassword(AGENT_PW, u.passwordHash!)).toBe(false);
    // A temporary password: Dana must choose her own at her next sign-in.
    expect(u.mustChangePassword).toBe(true);
    // The agent's answer says it was done, and holds no password.
    const seen = await agentView(a.requestId!);
    expect(seen.status).toBe('executed');
    expect(JSON.stringify(seen)).not.toMatch(/R3set|N3w-User/);
  });
});

describe('the password of a backup, typed by the approving file Admin', () => {
  it('a portable copy is protected with the password the Admin typed; the agent gets only the locked file', async () => {
    const a = await asked({
      operation: 'portable.post',
      requestId: key('portable'),
      reason: 'Send the accountant a copy of the books.',
      // "Without a password" and a password of its own are both the person's to choose.
      body: { protect: false, password: AGENT_BACKUP_PW },
    });
    expect(a.needs?.secrets).toEqual(['backup_password']);
    expect(a.needs?.fileAdmin).toBe(true);

    const r = await approve(a.requestId!, { backup_password: BACKUP_PW });
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    const seen = await agentView(a.requestId!);
    expect(seen.file, 'the copy is staged for the agent').toBeTruthy();
    const got = await agent.verb('get_file', { fileId: seen.file!.fileId });
    const bytes = Buffer.from(got.base64, 'base64');
    // Locked with the person's password: it opens with it, and with nothing else.
    await expect(unlockPortableBuffer(bytes, AGENT_BACKUP_PW)).rejects.toThrow();
    await expect(unlockPortableBuffer(bytes, null)).rejects.toThrow();
    const opened = await unlockPortableBuffer(bytes, BACKUP_PW);
    expect(opened.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('a secret the run produces', () => {
  it('a phone upload link is only in ApproveResult.produced, never in the request anyone reads', async () => {
    const rk = key('link');
    const a = await asked({ operation: 'receipts.upload-links.create', requestId: rk, reason: 'Let the owner send receipts from the phone.' });
    const r = await approve(a.requestId!, {});
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
    expect(r.produced).toHaveLength(1);
    expect(r.produced[0].kind).toBe('capability_link');
    const link = r.produced[0].value;
    expect(link.length).toBeGreaterThan(20);
    produced.push({ label: 'the phone upload link a run produced', value: link });
    // Should the value be a whole link, its secret part alone is looked for too (a row could keep
    // the token without the rest of the address).
    const tail = link.split(/[/=#?&]/).filter(Boolean).pop() ?? link;
    if (tail !== link && tail.length >= 16) producedParts.push({ label: 'the secret part of the phone upload link', value: tail });

    // Everything of the result but `produced` holds no trace of it.
    const { produced: _shown, ...rest } = r;
    expect(JSON.stringify(rest)).not.toContain(link);
    const forPerson = await requestForPerson(await s.admin.ctx(), a.requestId!);
    expect(JSON.stringify(forPerson)).not.toContain(link);
    const seen = await agentView(a.requestId!);
    expect(JSON.stringify(seen)).not.toContain(link);
    expect(JSON.stringify(seen.result)).toContain(PRODUCED_SECRET_TEXT);
    // Asking again with the same request id answers what became of it: the link stays redacted.
    const again = await agent.run({ operation: 'receipts.upload-links.create', requestId: rk, reason: 'Let the owner send receipts from the phone.' });
    expect(again.replayed).toBe(true);
    expect(JSON.stringify(again)).not.toContain(link);
  });
});

describe('an agent that puts secret-named fields in its own input', () => {
  it('has them taken out before anything runs or is stored, and is told which', async () => {
    const a = await agent.run({
      operation: 'customers.create',
      requestId: key('customer'),
      body: { displayName: 'Stripped Fields Co', password: AGENT_PW, currentPassword: AGENT_CURRENT_PW, apiKey: AGENT_KEY },
    });
    // Plain entry runs at once under this preset; what was taken out is named, never echoed.
    expect(['posted', 'done']).toContain(a.outcome);
    expect(a.note ?? '').toMatch(/Left out of your input/);
    for (const n of agentSent) expect(JSON.stringify(a)).not.toContain(n.value);
  });

  it('a request that asks keeps no secret-named field in its stored input, at any depth', async () => {
    const a = await asked({
      operation: 'email.test',
      requestId: key('mail-2'),
      reason: 'Test the mail server again.',
      body: {
        to: 'books@secrets-scenario.test',
        draft: { host: '192.168.1.25', port: 587, security: 'starttls', username: 'books', password: AGENT_MAIL_PW, fromEmail: 'books@secrets-scenario.test' },
      },
    });
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    expect(JSON.stringify(row.input)).not.toMatch(/"password"/);
    expect(JSON.stringify(row)).not.toContain(AGENT_MAIL_PW);
    // Left waiting: the person never answers it.
  });

  it('the older curated actions ({ action, input }) keep none of it either', async () => {
    for (const body of [
      { action: 'add_customer', input: { displayName: 'Curated Secrets Co', password: AGENT_PW, apiKey: AGENT_KEY }, requestId: key('curated'), reason: 'Add the customer.' },
      { action: 'add_customer', input: { displayName: 'Curated Secrets Co', currentPassword: AGENT_CURRENT_PW }, dryRun: true },
    ]) {
      const entry: (typeof transcript)[number] = { agent: agent.name, verb: `action:${body.action}`, args: JSON.parse(JSON.stringify(body)) };
      transcript.push(entry);
      try {
        entry.answer = JSON.parse(JSON.stringify(await runAgentAction(await agent.ctx(), body)));
      } catch (err) {
        // Refused (the action's own fields are checked strictly): what the route would send.
        entry.error = { message: (err as Error).message, code: (err as { code?: string }).code ?? null, details: (err as { details?: unknown }).details ?? null };
      }
      const said = JSON.stringify(entry.error ? { error: entry.error } : { answer: entry.answer });
      for (const n of agentSent) expect(said, n.label).not.toContain(n.value);
    }
    // The scans at the end look at every row and every answer for these values.
  });

  it('the same names in other spellings are taken out too: any case, snake_case, in the query', async () => {
    // Each value is the agent's own, under a name that says it is a secret. None may be kept in
    // the request a person reads (or that is stored), wherever it sits.
    const spelled: Record<string, string> = {
      Password: 'Ag3nt-Spelled-Pw-a1',
      PASSWORD: 'Ag3nt-Spelled-Pw-b2',
      CurrentPassword: 'Ag3nt-Spelled-Pw-c3',
      APIKEY: 'Ag3nt-Spelled-Key-d4',
      api_key: 'Ag3nt-Spelled-Key-e5',
      new_password: 'Ag3nt-Spelled-Pw-f6',
    };
    const a = await asked({
      operation: 'company.update',
      requestId: key('spelled'),
      reason: 'Fix the company name once more.',
      body: { name: 'Secrets Scenario Books', ...spelled, settings: { Password: 'Ag3nt-Spelled-Pw-g7' } },
      query: { password: 'Ag3nt-Spelled-Pw-h8' },
    });
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    const stored = JSON.stringify(row);
    const kept = [...Object.entries(spelled), ['settings.Password', 'Ag3nt-Spelled-Pw-g7'], ['query.password', 'Ag3nt-Spelled-Pw-h8']]
      .filter(([, v]) => stored.includes(v) || JSON.stringify(a).includes(v))
      .map(([k]) => k);
    expect(kept, `kept in the stored request or the answer: ${kept.join(', ')}`).toEqual([]);
  });

  it('even the right closing-date password, sent by the agent, opens nothing: the request is still asked', async () => {
    // The agent somehow learned the real password (from a note it read, say). It is taken out and
    // never used: only what the approver types on the card counts.
    const a = await asked({
      operation: 'journal-entries.create',
      requestId: key('je-agent-pw'),
      reason: 'Post the late accrual.',
      body: {
        date: '2025-10-03',
        description: 'Late accrual',
        lines: JE_LINES(),
        currentPassword: CLOSING_PW,
        password: CLOSING_PW,
        closingPassword: CLOSING_PW,
        closing_password: CLOSING_PW,
        'x-closing-password': CLOSING_PW,
      },
      query: { 'x-closing-password': CLOSING_PW },
    });
    expect(a.needs?.secrets).toContain('closing_password');
    const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
    expect(JSON.stringify(row)).not.toContain(CLOSING_PW);
    const posted = await s.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, s.companyId), eq(journalEntries.description, 'Late accrual')));
    expect(posted).toHaveLength(0);
    // The answer echoes none of it either (the scan of every answer at the end looks again, for
    // every secret).
    expect(JSON.stringify(a)).not.toContain(CLOSING_PW);
  });
});

describe('secrets typed where they are not needed, or before the work can run', () => {
  it('passwords typed on a card that needs none go nowhere', async () => {
    const a = await asked({ operation: 'company.update', requestId: key('extra'), reason: 'Fix the company name.', body: { name: 'Secrets Scenario Books' } });
    expect(a.needs?.secrets ?? []).toEqual([]);
    // Answers named like a password (as a desktop flow's would be) count as typed secrets too.
    const r = await approve(
      a.requestId!,
      { closing_password: EXTRA_PW, backup_password: EXTRA_PW_2, mail_password: EXTRA_PW_3 },
      { answers: { password: EXTRA_ANSWER_PW, filePassword: EXTRA_ANSWER_PW } },
    );
    expect(r.status, JSON.stringify(r.request.error)).toBe('executed');
  });

  it('what the first of two approvers types is not kept while the request waits for the second', async () => {
    // Above 100.00 two different people approve (D8). Set by the Admin for this test only.
    await saveAgentPolicy(await s.admin.ctx(), agent.id, { twoPersonOver: '100.00' });
    try {
      const a = await asked({
        operation: 'journal-entries.create',
        requestId: key('je-two'),
        reason: 'Post the large accrual.',
        body: { date: '2025-09-30', description: 'Large accrual', lines: [{ accountId: s.rich.acct['6300'], debit: '900.00' }, { accountId: s.rich.acct['1000'], credit: '900.00' }] },
      });
      expect(a.needs?.twoPerson).toBe(true);
      expect(a.needs?.secrets).toContain('closing_password');
      const first = await approve(a.requestId!, { closing_password: FIRST_OF_TWO_PW });
      expect(first.status).toBe('needs_second_approver');
      const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, a.requestId!));
      expect(JSON.stringify(row)).not.toContain(FIRST_OF_TWO_PW);
      // Left waiting for a second person: the scan below looks for what the first one typed.
    } finally {
      await saveAgentPolicy(await s.admin.ctx(), agent.id, { twoPersonOver: null });
    }
  });
});

describe('after the run: no secret anywhere', () => {
  let tables: string[] = [];
  const all = () => [...typed, ...produced, ...producedParts];

  beforeAll(async () => {
    // What the agent reads at the end: every request of its own, and each one as a wait answers it.
    const { requests } = await agent.verb('list_my_requests', { limit: 200 });
    for (const r of requests) {
      const view = await waitForDecision(await agent.ctx(), r.id, 0);
      transcript.push({ agent: agent.name, verb: 'wait_for_decision', args: { requestId: r.id }, answer: JSON.parse(JSON.stringify(view)) });
    }
    tables = await tableNames(s.db);
  });

  it('the scan finds what is there: a value as written, in base64, base64url and hex', async () => {
    const probe: Needle = { label: 'the agent name', value: 'Secrets Agent' };
    const { hits } = await scanTables(s.db, ['agents'], [probe]);
    expect(hits.map((x) => x.form)).toContain('as typed');
    const v = 'Pr0be-Value-123';
    for (const enc of ['base64', 'base64url', 'hex'] as const) {
      // (base64 and base64url are one and the same text for a value without "+" or "/" in it.)
      const text = `{"x":"${Buffer.from(v).toString(enc)}"}`;
      expect(findSecrets('probe', text, [{ label: 'probe', value: v }]).length, enc).toBeGreaterThan(0);
    }
    expect(findSecrets('probe', 'nothing of it here', [{ label: 'probe', value: v }])).toEqual([]);
  });

  it('the run really happened: the requests, their audit rows and the transaction log are there to scan', async () => {
    expect(tables).toEqual(expect.arrayContaining(['agent_permission_requests', 'agent_requests', 'audit_logs', 'ai_proposals']));
    const rows = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agent.id));
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter((r) => r.status === 'executed').length).toBeGreaterThanOrEqual(6);
    // The log file is there, and holds the agent's approved changes (the scan below is not of nothing).
    expect(fs.existsSync(transactionLogPath(s.dir)), 'the transaction log file').toBe(true);
    const records = readAllTransactionLog(s.dir).records;
    expect(records.filter((r) => r.agentId === agent.id && r.approvedBy === s.admin.id).length).toBeGreaterThanOrEqual(5);
    expect(produced.length).toBe(1);
  });

  it('none in agent_permission_requests, agent_requests, audit_logs or ai_proposals', async () => {
    const { hits, rows } = await scanTables(s.db, ['agent_permission_requests', 'agent_requests', 'audit_logs', 'ai_proposals'], [...all(), ...agentSent]);
    expect(rows).toBeGreaterThan(10);
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it('none in any other row of the company file (a hash or a sealed value is not the secret)', async () => {
    const { hits } = await scanTables(s.db, tables, [...all(), ...agentSent]);
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it('none in the transaction log file', () => {
    const hits: Hit[] = transactionLogTexts(s.dir).flatMap((t) => findSecrets(t.where, t.text, [...all(), ...agentSent]));
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it('none in any answer the agent received, a refusal or a wait included', () => {
    expect(transcript.length).toBeGreaterThan(15);
    // Not even its own secret-named values come back to it: they were dropped, not kept somewhere.
    const hits: Hit[] = transcriptTexts().flatMap((t) => findSecrets(t.where, t.text, [...all(), ...agentSent]));
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it('none in a staged file, in the folders the agent may save to, or in what the app wrote to the console', () => {
    const texts = [
      ...folderTexts(process.env.BKA_AGENT_FILES_DIR!),
      ...folderTexts(process.env.BKA_AGENT_DOCUMENTS!),
      ...consoleLines.map((text, i) => ({ where: `console line ${i + 1}`, text })),
    ];
    const hits: Hit[] = texts.flatMap((t) => findSecrets(t.where, t.text, [...all(), ...agentSent]));
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it('none in any file of the scenario, read as raw bytes: the company file itself (its pages and log), the endpoints, the staged files, Documents', async () => {
    // A secret written to a row during the run and overwritten or cleared later passes every scan
    // of the rows as they stand now; the old page on disk still holds it. What the person typed
    // must never reach the database at all. Read once as the files are (the write-ahead log holds
    // every change of the run), and once more after the pages in memory are written out (a
    // checkpoint may recycle a log file).
    const asIs = scanFiles(s.root, [...all(), ...agentSent]);
    await flushToDisk(s.db);
    const { hits: flushed, files, bytes } = scanFiles(s.root, [...all(), ...agentSent]);
    const hits = [...asIs.hits, ...flushed];
    // The company file is there to read (this is not the scan of an empty folder).
    expect(fs.readdirSync(s.dir).length).toBeGreaterThan(3);
    expect(files).toBeGreaterThan(50);
    expect(bytes).toBeGreaterThan(1_000_000);
    // And the scan reads the rows on disk: the agent's name, written to the agents table, is found.
    const probe = scanFiles(s.dir, [{ label: 'the agent name', value: 'Secrets Agent' }]);
    expect(probe.hits.length, 'a value of a row, found in the raw files').toBeGreaterThan(0);
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it("the person's screen never shows back what they typed, only what a run produced, once", () => {
    expect(approvals.length).toBeGreaterThanOrEqual(8);
    const hits: Hit[] = approvals.flatMap((r, i) => findSecrets(`approval ${i + 1}`, JSON.stringify({ ...r, produced: [] }), all()));
    expect(hits, describeHits(hits)).toEqual([]);
    const shown = approvals.flatMap((r) => r.produced.map((p) => p.value));
    expect(shown).toEqual(produced.map((p) => p.value));
  });

  it('no email the app sent carries a secret in its message', () => {
    const hits: Hit[] = mailbox.flatMap((m, i) => findSecrets(`email ${i + 1}`, JSON.stringify(m.message), [...all(), ...agentSent]));
    expect(hits, describeHits(hits)).toEqual([]);
  });
});
