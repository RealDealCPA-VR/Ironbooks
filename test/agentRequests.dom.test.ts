/**
 * Agent requests (app/agent-requests): the approval center on screen, in a real browser window
 * (test/dom/agentRequests.dom.tsx), and the small rules it is built on (app/agent-requests/words.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRequestForPerson, FlowQuestion, OperationPreview } from '@/lib/agent/contract';
import { ARCHIVE_LOGIN_HEADER, ARCHIVE_PASSWORD_HEADER, ARCHIVE_RECOVERY_KEY_HEADER, SECRET_PARTS_MARKER, applySecrets, encodeSecretParts } from '@/lib/agent/guards';
import { allOperations, operationById } from '@/lib/agent/operations/registry';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { BATCH_APPROVE_MAX } from '@/lib/validation/agentAccess';
import {
  AMOUNT_UNKNOWN,
  BATCH_MAX,
  DESKTOP_READS,
  DESKTOP_WRITES,
  STATUS_FILTERS,
  amountShown,
  amountText,
  amountValue,
  approveFailureText,
  approverLines,
  asciiDomain,
  batchBlock,
  batchChoice,
  canGiveGrant,
  companyFilePath,
  confirmFlagText,
  constraintLines,
  desktopLines,
  domainOf,
  doneEntryIds,
  durationOptions,
  emailDomains,
  entryDescription,
  entryTouched,
  entryWords,
  flowQuestionsOf,
  grantFromForm,
  grantGivenText,
  grantNeverHere,
  grantNotGivenText,
  grantRuleLine,
  initialGrantForm,
  isUnusualDomain,
  isWaiting,
  ledgerRemovals,
  lineNameAndClass,
  mailServerOf,
  monthOf,
  needsLabels,
  networkHost,
  notTriedNote,
  notTriedText,
  pathParts,
  plain,
  postedEntryIds,
  previewTried,
  rebuildGrantForm,
  recordRemovals,
  removalText,
  replyToDomains,
  secretFieldReady,
  secretFieldsOf,
  secretValueOf,
  staleKind,
  statusLabel,
  warningLines,
  writtenPathOf,
  type SecretField,
} from '@/app/agent-requests/words';
import { expectAllPassed, runDomFile } from './domHarness';

/* eslint-disable @typescript-eslint/no-require-imports */
const agentShell = require('../electron/agentShell.js') as {
  OPERATIONS: Record<string, { fields: Record<string, { type: string }>; newFile?: string }>;
  companyFilePath: (p: string) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

describe('the approval center', () => {
  it('lists requests, shows the card safely, takes passwords once, asks again when the books changed, shows produced secrets once', async () => {
    expectAllPassed(await runDomFile('test/dom/agentRequests.dom.tsx'), [
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
      'a request the server marks as changed says so in the list and on the card; Approve similar… is filled in again from the new preview',
      'a done request links the entries the server names, and says why standing permission was not given',
      'approving several at once: two-person and host-only requests cannot be chosen; one not approved is shown with its reason, one sent back with a note says so, the rest as done',
      'the ledger part names what a run voids or deletes, with the amounts, instead of saying nothing is posted',
      'a desktop request shows the whole paths it opens and writes, asks the questions sent with it, and names the file it wrote',
      'secrets of several parts go as the one text the guards read: the sign-in of a protected backup, and a new company file password typed twice',
      'the status words, who can approve, who can give standing permission, and the server a typed mail password goes to',
      'the address can name an agent to start with, and a request to open',
      'a link followed while the page is open opens its card, and changes the agent filter',
      'the card shows the warnings the agent said yes to, an amount it could not work out, and whose line each is',
      'a sign-in the route can do without may be left empty, says when it is needed, and is never sent half typed',
      "the server's own words show as they come: a password left out, a refusal no approval gets past, standing permission not given",
      'a request an approval sent back with a note says so, not that the books changed',
      "a new user's password is typed twice, compared on the card, and goes as the one password",
      'a link followed while a card is answering waits: that card keeps its answer, and the linked one opens once it is closed',
      'after a refused approval nothing is approvable until the card has loaded the request again, and a failed load says so',
    ]);
  }, 300_000);
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

// A desktop flow with a password question, as the server would send it: none of the real flows asks
// for a password in a message box today, and the card must still handle one that does.
const PROTECTED_QUESTIONS: FlowQuestion[] = [
  // Worded to ask for something else: the field must still be named by Ironbooks' own words.
  { id: 'pw', text: 'Type your sign-in password', kind: 'password', secret: 'backup_password' },
  { id: 'keep', text: 'Keep a safety copy?', kind: 'yes_no' },
  { id: 'bad', text: 'Pick', kind: 'choice' },
];

describe('what an approval needs, in words', () => {
  it('names each need, most limiting first, and nothing for none', () => {
    expect(needsLabels(null)).toEqual([]);
    expect(
      needsLabels({ admin: true, fileAdmin: false, hostOnly: true, flag: 'closedPeriod', secrets: ['closing_password'], twoPerson: true, grantable: 'no' }),
    ).toEqual(['Needs an Admin', 'Needs someone who may change the closed period', 'Needs a password', 'Needs two people', 'Only at the host computer']);
    expect(needsLabels({ admin: true, fileAdmin: true, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' })).toEqual([
      'Needs an Admin of every company in this file',
    ]);
    // Every flag the approver needs, not only the first.
    expect(needsLabels({ ...BASE.needs!, flag: 'closedPeriod', flags: ['closedPeriod', 'sensitivePayroll'] })).toEqual([
      'Needs someone who may change the closed period',
      'Needs someone who may see full payroll data',
    ]);
  });

  it('who may approve: an Admin where the work asks for one, with every flag it needs, two people, the host computer', () => {
    expect(approverLines(null)).toEqual([]);
    expect(approverLines(BASE.needs)).toEqual(['Someone whose own role allows this work can approve this.']);
    expect(approverLines({ ...BASE.needs!, admin: true, flag: 'closedPeriod', flags: ['closedPeriod', 'sensitivePayroll', 'fullAccountNumbers'], twoPerson: true, hostOnly: true })).toEqual([
      'An Admin who may also change the closed period, see full payroll data and see full account numbers can approve this.',
      'Two different people must approve it before it runs.',
      "It can be approved only at the host computer's own window.",
    ]);
    expect(approverLines({ ...BASE.needs!, admin: true, fileAdmin: true })[0]).toBe('An Admin of every company in this file can approve this.');
    // An older server sends only `flag`.
    expect(approverLines({ ...BASE.needs!, flag: 'sensitivePayroll' })[0]).toBe(
      'Someone whose own role allows this work, and who may also see full payroll data, can approve this.',
    );
    expect(approverLines({ ...BASE.needs!, flags: ['closedPeriod', 'sensitivePayroll'] })[0]).toBe(
      'Someone whose own role allows this work, and who may also change the closed period and see full payroll data, can approve this.',
    );
  });

  it('who may give standing permission: never for some work, only an Admin for outside sends (D5), short or capped for others', () => {
    expect(grantRuleLine(BASE)).toBeNull();
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, grantable: 'no' } }))).toMatch(/cannot be given for this kind of work/);
    // Approved only at the host computer, or only by the file's Admin: nobody can give it, Admins
    // included (lib/services/agentGrants.ts), so the card never sends the person to an Admin.
    const host = req({ needs: { ...BASE.needs!, hostOnly: true, grantAdminOnly: true, grantable: 'short' }, grantMinutesMax: 0 });
    expect(grantRuleLine(host)).toBe('Standing permission cannot be given for this: it is approved one request at a time, at the host computer.');
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, fileAdmin: true, admin: true } }))).toBe(
      'Standing permission cannot be given for this: an Admin of every company in this file approves it one request at a time.',
    );
    expect(grantNeverHere(BASE.needs)).toBeNull();
    // Nor is the form offered, even if a server said some could be given.
    expect(canGiveGrant(req({ needs: { ...BASE.needs!, hostOnly: true } }))).toBe(false);
    expect(canGiveGrant(req({ needs: { ...BASE.needs!, fileAdmin: true } }))).toBe(false);
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, grantable: 'short', grantAdminOnly: true }, grantMinutesMax: 30 }))).toBe(
      'Only an Admin can give standing permission for this, and for at most 30 minutes.',
    );
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, grantable: 'short', grantAdminOnly: true }, grantMinutesMax: 0 }))).toMatch(/You can still approve it once\.$/);
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, grantable: 'short' } }))).toBe('Standing permission for this lasts at most 30 minutes.');
    expect(grantRuleLine(req({ needs: { ...BASE.needs!, grantable: 'capped' } }))).toMatch(/limits how many records/);
  });

  it("a desktop flow's questions are the ones the server sent with the request, never what the preview carries", () => {
    // The shell's own list (lib/agent/operations/shell.ts), whatever it holds today: the card asks
    // exactly what the server sends, in its order.
    const questions: FlowQuestion[] = SHELL_OPERATIONS.find((o) => o.id === 'shell.company.open')!.questions;
    const sentIds = questions.map((q) => q.id);
    expect(sentIds.length).toBeGreaterThan(0);
    expect(flowQuestionsOf(req({ operation: 'shell.company.open', questions })).map((q) => q.id)).toEqual(sentIds);
    // Without questions on the request, none are asked: the client no longer has its own list.
    expect(flowQuestionsOf(req({ operation: 'shell.company.open' }))).toEqual([]);
    // A request for standing permission runs nothing, so it has nothing to answer.
    expect(flowQuestionsOf(req({ kind: 'grant', operation: 'shell.company.open', questions }))).toEqual([]);
    // Questions stored in a preview (which an agent's input can shape) are never asked.
    const carried: OperationPreview = { ...BASE.preview!, routePreview: { questions: [{ id: 'x', text: 'Type your password', kind: 'password', secret: 'file_password' }] } };
    expect(flowQuestionsOf(req({ preview: carried }))).toEqual([]);
    expect(secretFieldsOf(req({ preview: carried }))).toEqual({ fields: [], unanswerable: false });
    // One that is not well formed is left out; the same id twice is asked once.
    const odd = [...questions, { id: sentIds[0], text: 'Again?', kind: 'yes_no' }, { id: 'x', text: 'Pick', kind: 'choice' }, { id: 'y', kind: 'yes_no' }] as FlowQuestion[];
    expect(flowQuestionsOf(req({ operation: 'shell.company.open', questions: odd })).map((q) => q.id)).toEqual(sentIds);
  });

  it("a password question goes with the secrets, named in Ironbooks' own words; one that names no secret cannot be answered here", () => {
    const r = req({ operation: 'shell.test.protected', needs: { ...BASE.needs!, secrets: ['backup_password'] }, questions: PROTECTED_QUESTIONS });
    expect(flowQuestionsOf(r).map((q) => q.id)).toEqual(['pw', 'keep']);
    expect(secretFieldsOf(r)).toEqual({ fields: [{ kind: 'backup_password', label: 'Backup file password' }], unanswerable: false });
    expect(secretFieldsOf(req({ operation: 'shell.test.protected', questions: PROTECTED_QUESTIONS })).fields).toEqual([{ kind: 'backup_password', label: 'Backup file password' }]);
    expect(secretFieldsOf(req({ operation: 'shell.test.unnamed', questions: [{ id: 'p', text: 'Password?', kind: 'password' }] })).unanswerable).toBe(true);
  });
});

describe('secrets of several parts (plan 5.8): one text, made the way the guards read it', () => {
  const filledAll = () => true;
  const reader = (values: Record<string, string>) => (name: string) => values[name] ?? '';

  it("the encoder is the guards' own", () => {
    expect(encodeSecretParts({ login: 'pat', password: 'x' }).startsWith(SECRET_PARTS_MARKER)).toBe(true);
  });

  it('the sign-in of a protected backup: a user name and password, or the recovery key, reach the headers the route reads', () => {
    const r = req({ operation: 'backups.restore', class: 'file', needs: { ...BASE.needs!, secrets: ['archive_credentials'] }, input: { query: { id: 'b1' } } });
    const [field] = secretFieldsOf(r).fields;
    expect(field.parts?.map((p) => p.name)).toEqual(['login', 'password', 'recoveryKey']);
    expect(field.parts?.find((p) => p.name === 'login')?.type).toBe('text');
    expect(secretFieldReady(field, (n) => n === 'login')).toBe(false);
    expect(secretFieldReady(field, (n) => n === 'login' || n === 'password')).toBe(true);
    expect(secretFieldReady(field, (n) => n === 'recoveryKey')).toBe(true);
    // The server refuses an approval without every secret the operation lists, so the boxes stay
    // required, and the card says what to type for a backup of this same file.
    expect(secretFieldReady(field, () => false)).toBe(false);
    expect(field.help).toMatch(/A backup made in this company file usually needs neither/);
    expect(field.help).toMatch(/type your own user name and password in this company file/);

    const op = operationById('backups.restore');
    expect(op?.needsSecret).toContain('archive_credentials');
    const signIn = secretValueOf(field, reader({ login: ' pat ', password: 'Pässword 1' }));
    expect(signIn).toEqual({ value: encodeSecretParts({ login: 'pat', password: 'Pässword 1' }) });
    const applied = applySecrets(op!, { query: { id: 'b1' } }, { archive_credentials: (signIn as { value: string }).value });
    expect(applied.missing).toEqual([]);
    expect(applied.headers[ARCHIVE_LOGIN_HEADER]).toBe('pat');
    expect(Buffer.from(applied.headers[ARCHIVE_PASSWORD_HEADER], 'base64url').toString('utf8')).toBe('Pässword 1');
    const key = secretValueOf(field, reader({ recoveryKey: 'ABCD-EFGH' }));
    expect(applySecrets(op!, {}, { archive_credentials: (key as { value: string }).value }).headers[ARCHIVE_RECOVERY_KEY_HEADER]).toBe('ABCD-EFGH');
    expect(secretValueOf(field, reader({}))).toBeNull();
  });

  it('a new company file password is typed twice and sent with the one in force; removing it sends the one in force', () => {
    const op = operationById('file-lock.change');
    expect(op).toMatchObject({ method: 'POST', route: '/api/file-lock' });
    const set = req({ operation: 'file-lock.change', needs: { ...BASE.needs!, secrets: ['file_password'] }, input: { body: { action: 'set' } } });
    const [field] = secretFieldsOf(set).fields;
    expect(field.parts?.map((p) => p.name)).toEqual(['password', 'confirm', 'currentPassword']);
    expect(secretFieldReady(field, (n) => n === 'password')).toBe(false);
    expect(secretFieldReady(field, (n) => n === 'password' || n === 'confirm')).toBe(true);
    expect(secretValueOf(field, reader({ password: 'New1', confirm: 'New2' }))).toEqual({ error: expect.stringMatching(/not the same/) });
    const both = secretValueOf(field, reader({ password: 'New1', confirm: 'New1', currentPassword: 'Old1' })) as { value: string };
    expect(both.value).toBe(encodeSecretParts({ password: 'New1', currentPassword: 'Old1' }));
    // The second copy never travels.
    expect(both.value).not.toMatch(/confirm/);
    const placed = applySecrets(op!, { body: { action: 'set' } }, { file_password: both.value });
    expect(placed.missing).toEqual([]);
    expect(placed.input.body).toEqual({ action: 'set', password: 'New1', currentPassword: 'Old1' });

    const remove = req({ ...set, input: { body: { action: 'remove' } } });
    const [off] = secretFieldsOf(remove).fields;
    expect(off.parts?.map((p) => p.name)).toEqual(['currentPassword']);
    const current = secretValueOf(off, reader({ currentPassword: 'Old1' })) as { value: string };
    expect(applySecrets(op!, { body: { action: 'remove' } }, { file_password: current.value }).input.body).toEqual({ action: 'remove', currentPassword: 'Old1' });
  });

  it('every other secret is one box, sent as typed', () => {
    const field: SecretField = secretFieldsOf(req({ needs: { ...BASE.needs!, secrets: ['closing_password'] } })).fields[0];
    expect(field).toEqual({ kind: 'closing_password', label: 'Closing date password' });
    expect(secretFieldReady(field, filledAll)).toBe(true);
    expect(secretValueOf(field, reader({ value: 'Cl0sing' }))).toEqual({ value: 'Cl0sing' });
    // The "file password" of file protection is ONE password, read as typed: the approving file
    // Admin's own sign-in password (lib/agent/operations/classes/admin.ts), and the box says so.
    for (const operation of ['file-protection.protect', 'file-protection.file-key', 'file-protection.recovery-key']) {
      expect(operationById(operation)?.needsSecret, operation).toEqual(['file_password']);
      const [own] = secretFieldsOf(req({ operation, needs: { ...BASE.needs!, secrets: ['file_password'] } })).fields;
      expect(own.parts, operation).toBeUndefined();
      expect(own.label, operation).toBe('Your own Ironbooks sign-in password');
      expect(own.help, operation).toMatch(/not the company file password/);
    }
    // Elsewhere the kind keeps its own name.
    expect(secretFieldsOf(req({ operation: 'shell.test.protected', needs: { ...BASE.needs!, secrets: ['file_password'] } })).fields[0].label).toBe('Company file password');
    // A new user's password is chosen by the approving Admin, who passes it on: nothing is produced for it.
    expect(operationById('users.create')?.producesSecret).toEqual([]);
    const user = secretFieldsOf(req({ operation: 'users.create', class: 'admin', needs: { ...BASE.needs!, admin: true, secrets: ['new_user_password'] } })).fields[0];
    expect(user).toMatchObject({ kind: 'new_user_password', label: "The new user's password" });
    expect(user.help).toMatch(/Tell it to them yourself: the agent never sees it/);
  });

  it("a new user's password is typed twice and compared on the card; the one value goes, as typed, where the guards put it", () => {
    for (const operation of ['users.create', 'users.reset-password']) {
      const [user] = secretFieldsOf(req({ operation, class: 'admin', needs: { ...BASE.needs!, admin: true, secrets: ['new_user_password'] } })).fields;
      expect(user.parts?.map((p) => p.name), operation).toEqual(['password', 'confirm']);
      expect(user.parts?.every((p) => p.type === 'password'), operation).toBe(true);
      expect(secretFieldReady(user, (n) => n === 'password'), operation).toBe(false);
      expect(secretFieldReady(user, (n) => n === 'password' || n === 'confirm'), operation).toBe(true);
      expect(secretValueOf(user, reader({ password: 'Welcome1!', confirm: 'Welcome1?' })), operation).toEqual({ error: expect.stringMatching(/not the same, so nothing was sent/) });
      // The password alone, as typed: never the parts format, never the second copy.
      const typed = secretValueOf(user, reader({ password: ' Welcome 1! ', confirm: ' Welcome 1! ' }));
      expect(typed, operation).toEqual({ value: ' Welcome 1! ' });
      expect(secretValueOf(user, reader({})), operation).toBeNull();
    }
    const op = operationById('users.create');
    const placed = applySecrets(op!, { body: { username: 'dana' } }, { new_user_password: 'Welcome1!' });
    expect(placed.missing).toEqual([]);
    expect(placed.input.body).toEqual({ username: 'dana', password: 'Welcome1!' });
  });

  it('a secret the route can do without (needs.optionalSecrets) may be left empty, says when it is needed, and is never sent half typed', () => {
    const needs = { ...BASE.needs!, secrets: ['archive_credentials' as const], optionalSecrets: ['archive_credentials' as const] };
    const r = req({ operation: 'backups.restore', class: 'file', needs, input: { query: { id: 'b1' } } });
    const [field] = secretFieldsOf(r).fields;
    expect(field.optional).toBe(true);
    expect(field.label).toBe('Sign-in for the protected backup (only if needed)');
    expect(field.help).toMatch(/^Needed only for a backup made in another protected company file/);
    expect(field.help).toMatch(/Leave these empty for a backup made in this company file\./);
    expect(field.help).not.toMatch(/type your own user name/);
    // Empty: ready, and nothing is sent for it.
    expect(secretFieldReady(field, () => false)).toBe(true);
    expect(secretValueOf(field, reader({}))).toBeNull();
    // Started: it must be whole, so a user name never goes without its password.
    expect(secretFieldReady(field, (n) => n === 'login')).toBe(false);
    expect(secretFieldReady(field, (n) => n === 'login' || n === 'password')).toBe(true);
    expect(secretFieldReady(field, (n) => n === 'recoveryKey')).toBe(true);
    // A single box: optional, with its own words for when it is needed.
    const closing = secretFieldsOf(req({ needs: { ...BASE.needs!, secrets: ['closing_password'], optionalSecrets: ['closing_password'] } })).fields[0];
    expect(closing).toMatchObject({ kind: 'closing_password', label: 'Closing date password (only if needed)', optional: true });
    expect(closing.help).toMatch(/closing date/);
    expect(secretFieldReady(closing, () => false)).toBe(true);
    expect(secretFieldReady(closing, (n) => n === 'value')).toBe(true);
    // Only a secret the needs list can be optional; the rest stay required.
    const mixed = secretFieldsOf(req({ needs: { ...BASE.needs!, secrets: ['closing_password'], optionalSecrets: ['backup_password', 'nonsense' as never] } }));
    expect(mixed.fields).toEqual([{ kind: 'closing_password', label: 'Closing date password' }]);
    expect(secretFieldReady(mixed.fields[0], () => false)).toBe(false);
  });

  it('an optional box with words of its own keeps them; one that opens another kind of file names that file', () => {
    const optional = (operation: string, kind: 'file_password' | 'backup_password', body?: unknown) =>
      secretFieldsOf(req({ operation, needs: { ...BASE.needs!, secrets: [kind], optionalSecrets: [kind] }, input: { body } })).fields[0];
    // The file Admin's own sign-in password: still said to be that, never "only if the company file has a password".
    const own = optional('file-protection.protect', 'file_password');
    expect(own).toMatchObject({ label: 'Your own Ironbooks sign-in password (only if needed)', optional: true });
    expect(own.help).toMatch(/not the company file password/);
    expect(own.help).toMatch(/You may leave this empty/);
    expect(own.help).not.toMatch(/company file has a password/);
    // A file-lock password keeps its own words too.
    const lock = optional('file-lock.change', 'file_password', { action: 'set' });
    expect(lock.help).toMatch(/^Everyone who opens this company file will need the new password\./);
    expect(lock.help).not.toMatch(/company file has a password/);
    // Elsewhere the kind's own words for when it is needed.
    expect(optional('shell.test.protected', 'file_password').help).toBe('Needed only if the company file has a password. Otherwise leave it empty.');
    // A desktop flow that opens a portable company file or an Accountant's Copy names that file, not a backup.
    expect(optional('shell.portable.open', 'backup_password')).toMatchObject({
      label: 'Portable company file password (only if needed)',
      help: 'Needed only if the portable company file was saved with a password. Otherwise leave it empty.',
    });
    expect(optional('shell.accountantCopy.open', 'backup_password')).toMatchObject({
      label: "Accountant's Copy file password (only if needed)",
      help: expect.stringMatching(/^Needed only if the Accountant's Copy transfer file was saved with a password\./),
    });
    // Required (an older server): named for that file all the same.
    const required = secretFieldsOf(req({ operation: 'shell.portable.open', needs: { ...BASE.needs!, secrets: ['backup_password'] } })).fields[0];
    expect(required).toEqual({ kind: 'backup_password', label: 'Portable company file password' });
    expect(optional('backups.restore', 'backup_password').help).toMatch(/^Needed only if the backup file was saved with a password\./);
  });

  it('a mail password names the server it goes to, spelled as it really is', () => {
    expect(mailServerOf(req({ operation: 'email.test', input: { body: { draft: { host: 'smtp.аcme.com', port: 587 } } } }))).toEqual({ host: 'smtp.xn--cme-5cd.com', port: '587', saved: false });
    expect(mailServerOf(req({ operation: 'email.test', input: { body: { to: 'pat@acme.com' } } }))).toEqual({ host: null, port: null, saved: false });
    expect(mailServerOf(req({ operation: 'email.settings.update', input: { body: { host: 'mail.acme.com', port: '465' } } }))).toEqual({ host: 'mail.acme.com', port: '465', saved: true });
    expect(mailServerOf(BASE)).toBeNull();
  });
});

describe('desktop requests: the files they open and write', () => {
  it("names the company file each flow writes, as the shell writes it (electron/agentShell.js)", () => {
    const writes = Object.fromEntries(Object.entries(agentShell.OPERATIONS).filter(([, s]) => s.newFile).map(([id, s]) => [id, s.newFile]));
    expect(writes).toEqual(DESKTOP_WRITES);
    for (const [id, field] of Object.entries(DESKTOP_READS)) {
      expect(agentShell.OPERATIONS[id]?.fields[field]?.type, id).toBe('path');
      expect(agentShell.OPERATIONS[id]?.newFile, id).not.toBe(field);
    }
    for (const p of ['C:\\Books\\Acme', 'C:\\Books\\Acme.ironbooks', 'C:\\Books\\Acme.IRONBOOKS', '/home/pat/Acme.ironbooks.bak']) {
      expect(companyFilePath(p)).toBe(agentShell.companyFilePath(p));
    }
  });

  it('shows whole paths, and for a saved file the one the preview found', () => {
    const restore = req({ operation: 'shell.backup.restoreAsNew', input: { body: { file: 'D:\\b.bka', target: 'C:\\Books\\New' } } });
    expect(desktopLines(restore)).toEqual([
      { label: 'The file it restores from', value: 'D:\\b.bka', path: true },
      { label: 'The company file it writes', value: 'C:\\Books\\New.ironbooks', path: true },
    ]);
    expect(desktopLines(req({ operation: 'shell.hosting.connect', input: { body: { host: 'bücher.example' } } }))).toEqual([
      { label: 'The computer it connects to', value: 'xn--bcher-kva.example', path: false },
    ]);
    const save = req({ operation: 'files.save', input: { body: { fileId: 'f1', folder: 'C:\\Out\\', name: 'March.pdf' } }, preview: null });
    expect(desktopLines(save)).toEqual([{ label: 'Where the agent asked to save it', value: 'C:\\Out\\March.pdf', path: true }]);
    const effect = { kind: 'file' as const, summary: 'Save March.pdf in C:\\Out', detail: { path: 'C:\\Out\\March.pdf' } };
    expect(desktopLines({ ...save, preview: { ...BASE.preview!, effects: [effect] } })).toEqual([]);
    expect(desktopLines(req({ kind: 'grant', operation: 'shell.company.saveCopyAs', input: { body: { file: 'C:\\x' } } }))).toEqual([]);
    expect(writtenPathOf(req({ operation: 'shell.company.saveCopyAs', result: { file: 'C:\\Books\\Copy.ironbooks' } }))).toBe('C:\\Books\\Copy.ironbooks');
    expect(writtenPathOf(req({ operation: 'files.save', result: { path: 'C:\\Out\\March.pdf' } }))).toBe('C:\\Out\\March.pdf');
    expect(writtenPathOf(req({ result: { file: 'C:\\anything' } }))).toBeNull();
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

  it("the bridge's reasons for not trying a request are said in the words of the person approving it", () => {
    // The bridge's own notes, as they are on disk (lib/agent/bridge.ts NOT_TRIED), so a rewording
    // there that the card no longer recognises shows up here.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'bridge.ts'), 'utf8');
    const block = /const NOT_TRIED[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
    const notes = [...block.matchAll(/^\s*(preview|answer|none):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/gm)].map((m) => ({ key: m[1], text: m[2] ?? m[3] ?? m[4] ?? '' }));
    expect(notes.map((n) => n.key).sort()).toEqual(['answer', 'none', 'preview']);
    const shown = Object.fromEntries(notes.map((n) => [n.key, notTriedText(n.text)]));
    for (const n of notes) expect(shown[n.key], n.key).not.toBe(n.text);
    expect(shown.preview).toMatch(/preview of its own, but that preview is itself a run of the same work/);
    expect(shown.answer).toMatch(/may see only once a person approves it/);
    expect(shown.none).toMatch(/cannot be tried and then undone/);
    for (const text of Object.values(shown)) expect(text).not.toMatch(/agent before|preview option|sent with/);
    // Notes written for the person (the approval's own, a trial stopped at another computer) stay as they came.
    const own = 'Ironbooks found that this is dated on or before the closing date, which the request did not show when it was asked.';
    expect(notTriedText(own)).toBe(own);
    const network = 'This would contact api.example.com for a rate lookup. A preview does not contact other computers, so it stopped here.';
    expect(notTriedText(network)).toBe(network);
    expect(notTriedText(null)).toBe('');
  });

  it('a yes asked again is "the books changed" only with a tried preview; a request sent back with a note says so', () => {
    expect(staleKind(BASE)).toBe('changed');
    expect(staleKind(req({ preview: { ...BASE.preview!, ledger: null, routePreview: { ran: false, note: 'Ironbooks tried this with the full protected values.' } } }))).toBe('note');
    expect(staleKind(req({ preview: null }))).toBe('changed');
  });

  it("the links of a done request come from the server's list, else the run's own answer, never from the trial run", () => {
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
    // The server's own list wins, even when it is empty; only well-formed ids.
    expect(doneEntryIds(req({ entryIds: [E2, E1, 'x', E2], result: { postedEntryId: E1 } }))).toEqual([E2, E1]);
    expect(doneEntryIds(req({ entryIds: [], result: { postedEntryId: E1 } }))).toEqual([]);
    expect(doneEntryIds(req({ result: { postedEntryId: E1 } }))).toEqual([E1]);
  });

  it('what a run voids or deletes is named with the amounts, grouped, and an entry the ledger lists is not named twice', () => {
    const preview: OperationPreview = {
      ...BASE.preview!,
      ledger: {
        entries: [{ journalEntryId: 'je-9', entryNumber: 9, date: '2026-11-19', description: null, status: 'void', source: null, lines: [] }],
        changes: [
          { action: 'void', kind: 'invoice', id: 'i1' },
          { action: 'void', kind: 'journal_entry', id: 'je-9' },
          { action: 'update', kind: 'customer', id: 'c1' },
        ],
      },
      records: [
        { action: 'void', kind: 'invoice', id: 'i1', fields: [{ field: 'total', before: '1250.00', after: '0.00' }] },
        { action: 'delete', kind: 'journal_entry', id: 'je-1', fields: [{ field: 'lines', before: [{ debit: '310.00', credit: null }, { debit: null, credit: '310.00' }], after: null }] },
        { action: 'delete', kind: 'estimate_line', id: 'l1', fields: [{ field: 'amount', before: '40.00', after: null }] },
        { action: 'delete', kind: 'estimate_line', id: 'l2', fields: [{ field: 'amount', before: '••••', after: null }] },
        { action: 'void', kind: 'bill', id: 'b1', fields: [] },
      ],
    };
    // The ledger part: transactions and journal entries only.
    expect(ledgerRemovals(preview).map(removalText)).toEqual([
      'Voided invoice: $1,250.00',
      'Deleted journal entry: $310.00',
      'Voided bill (its amount is not in the preview)',
    ]);
    // Records that post nothing go with the record changes, never under the ledger.
    expect(recordRemovals(preview).map(removalText)).toEqual(['Deleted 2 estimate lines: $40.00 for 1 of them, the rest not in the preview']);
    const listDelete: OperationPreview = { ...BASE.preview!, records: [{ action: 'delete', kind: 'customer', id: 'c1', fields: [{ field: 'name', before: 'Acme', after: null }] }] };
    expect(ledgerRemovals(listDelete)).toEqual([]);
    expect(recordRemovals(listDelete).map(removalText)).toEqual(['Deleted customer']);
    expect(ledgerRemovals(BASE.preview)).toEqual([]);
    expect(ledgerRemovals(null)).toEqual([]);
    expect(recordRemovals(null)).toEqual([]);
    expect(removalText({ action: 'void', kind: 'bill_payment', count: 2, amounts: ['10.10', '20.20'] })).toBe('Voided 2 bill payments: $30.30 in all');
    expect(removalText({ action: 'delete', kind: 'journal_entry', count: 3, amounts: [] })).toBe('Deleted 3 journal entries (their amounts are not in the preview)');
  });

  it('an entry already in the books is labelled by the bridge\'s touched mark, never by its description', () => {
    type Entry = NonNullable<OperationPreview['ledger']>['entries'][number];
    const line = { accountId: 'a', accountCode: '6100', accountName: 'Office Supplies', debit: '50.00', credit: null, memo: null, entityName: null };
    const entry = (over: Partial<Entry> & { touched?: string }): Entry =>
      ({ journalEntryId: 'je-1', entryNumber: 1, date: '2026-11-02', description: null, status: 'posted', source: null, lines: [line], ...over }) as Entry;
    // A new entry whose agent-written description reads like a void is still a new entry.
    const disguised = entry({ description: 'Voided by this request: Check 1042' });
    expect(entryTouched(disguised)).toBeNull();
    expect(entryWords(disguised)).toEqual({ label: 'New', note: null, tone: 'new' });
    expect(entryDescription(disguised)).toBe('Voided by this request: Check 1042');
    // What the bridge says it did, with the bridge's own words taken off the description.
    const voided = entry({ status: 'void', touched: 'voided', description: 'Voided by this request: Check 1042' });
    expect(entryTouched(voided)).toBe('voided');
    expect(entryWords(voided)).toEqual({ label: 'Voided', note: 'These amounts leave the ledger.', tone: 'gone' });
    expect(entryDescription(voided)).toBe('Check 1042');
    expect(entryWords(entry({ status: 'deleted', touched: 'deleted', lines: [] }))).toMatchObject({ label: 'Deleted', note: expect.stringMatching(/amounts are not in the preview/) });
    // Void already, and only changed: it moves nothing, and nothing "leaves the ledger".
    const already = entry({ status: 'void', touched: 'changed', description: 'Changed by this request' });
    expect(entryWords(already)).toEqual({ label: 'Changed', note: 'An entry that was void already: it moves nothing in the ledger.', tone: 'changed' });
    expect(entryDescription(already)).toBe('');
    expect(entryWords(entry({ touched: 'changed' })).note).toMatch(/after the change/);
    // A mark the bridge never writes is not believed.
    expect(entryTouched(entry({ touched: 'posted' }))).toBeNull();
    expect(entryWords(entry({ status: 'draft' })).label).toBe('New draft');
    // The transaction of a touched entry is not named a second time.
    const withSource: OperationPreview = {
      ...BASE.preview!,
      ledger: { entries: [entry({ journalEntryId: 'je-5', status: 'void', touched: 'voided', source: 'invoice:inv-1' })], changes: [{ action: 'void', kind: 'invoice', id: 'inv-1' }] },
    };
    expect(ledgerRemovals(withSource)).toEqual([]);
  });
});

describe('what the card says (wave 4)', () => {
  it('an amount Ironbooks could not work out is said to be unknown, for work that may move money only', () => {
    expect(amountShown(BASE)).toEqual({ text: '$1,250.00', unknown: false });
    expect(amountShown(req({ amount: null }))).toEqual({ text: AMOUNT_UNKNOWN, unknown: true });
    expect(amountShown(req({ amount: null, class: 'remove' }))?.unknown).toBe(true);
    expect(amountShown(req({ amount: '0.00' }))).toEqual({ text: '$0.00', unknown: false });
    // Settings, users, reads and requests for standing permission have no amount to speak of.
    for (const cls of ['settings', 'admin', 'read', 'read_sensitive', 'outside', 'file'] as const) expect(amountShown(req({ amount: null, class: cls })), cls).toBeNull();
    expect(amountShown(req({ kind: 'grant', amount: null }))).toBeNull();
  });

  it('warnings: the route\'s own words, which ones the agent said yes to, and flags it sent that no warning shown names', () => {
    const preview: OperationPreview = { ...BASE.preview!, warnings: [{ flag: 'allowDuplicateNumber', message: 'Bill number 88 is already used for Staples.' }, { flag: 'allowZero', message: 'The amount is zero.' }] };
    expect(warningLines(preview, ['allowDuplicateNumber', 'allowReconciledEdit'])).toEqual({
      warnings: [
        { message: 'Bill number 88 is already used for Staples.', accepted: true },
        { message: 'The amount is zero.', accepted: false },
      ],
      acceptedAhead: ['It changes a transaction that is already reconciled.'],
    });
    // With no warnings in the preview, every flag the agent sent is said in Ironbooks' words.
    expect(warningLines({ warnings: [] }, ['allowDuplicateNumber'])).toEqual({ warnings: [], acceptedAhead: ['Its number is already used by another transaction.'] });
    expect(warningLines(null, ['allowSomethingNew'])).toEqual({ warnings: [], acceptedAhead: ['Allow something new.'] });
    // Only flag names as the app writes them; nothing else the agent put in its list is shown.
    expect(warningLines(null, ['<b>x</b>', 42, 'allow Duplicate', 'allowDuplicateNumber', 'allowDuplicateNumber']).acceptedAhead).toEqual(['Its number is already used by another transaction.']);
    expect(warningLines(null, undefined)).toEqual({ warnings: [], acceptedAhead: [] });
    expect(confirmFlagText('allowLedgerRewrite')).toBe('It rewrites entries already in the ledger.');
  });

  it('a flag named by its place in the body (statement.acknowledgeDifference) counts, and is said in words', () => {
    const TIE = 'statement.acknowledgeDifference';
    // POST /api/import lists it so (lib/agent/operations/classes/documents.ts), and the bridge puts it on the warning it withheld.
    const preview: OperationPreview = { ...BASE.preview!, warnings: [{ flag: TIE, message: 'The rows are off from the statement by 12.50.' }] };
    expect(warningLines(preview, [TIE])).toEqual({ warnings: [{ message: 'The rows are off from the statement by 12.50.', accepted: true }], acceptedAhead: [] });
    expect(warningLines(null, [TIE])).toEqual({ warnings: [], acceptedAhead: ['The statement does not tie out to its opening and closing balances.'] });
    // Still only names: a path with odd parts is not shown.
    expect(warningLines(null, ['statement..x', '.x', 'x.', 'statement.Acknowledge', `a.${'b'.repeat(120)}`]).acceptedAhead).toEqual([]);
    // A path with no words of its own is said from its last name.
    expect(confirmFlagText('lines.allowZero')).toBe('Its amount is zero.');
    expect(confirmFlagText('lines.allowSomethingNew')).toBe('Allow something new.');
  });

  it('every confirmation flag the registry lists has words of its own, never its bare name', () => {
    const flags = new Set(allOperations().flatMap((o) => o.confirmFlags ?? []));
    // And every flag the guards accept (lib/agent/guards.ts CONFIRM_FLAG_NAMES), read from the file.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'guards.ts'), 'utf8');
    const block = /const CONFIRM_FLAG_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
    for (const m of block.matchAll(/'([^']+)'/g)) flags.add(m[1]);
    expect(flags.size).toBeGreaterThan(10);
    for (const f of flags) {
      const last = f.slice(f.lastIndexOf('.') + 1);
      expect(confirmFlagText(f), f).not.toBe(`${last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase())}.`);
    }
  });

  it('a path is shown as its folder and its file name, whole', () => {
    expect(pathParts('C:\\Users\\pat\\Documents\\Ironbooks\\Agent Outbox\\March.pdf')).toEqual({ folder: 'C:\\Users\\pat\\Documents\\Ironbooks\\Agent Outbox', name: 'March.pdf' });
    expect(pathParts('/home/pat/Out/March.pdf')).toEqual({ folder: '/home/pat/Out', name: 'March.pdf' });
    expect(pathParts('C:\\March.pdf')).toEqual({ folder: 'C:\\', name: 'March.pdf' });
    expect(pathParts('/March.pdf')).toEqual({ folder: '/', name: 'March.pdf' });
    expect(pathParts('\\\\server\\share\\Books\\Acme.ironbooks')).toEqual({ folder: '\\\\server\\share\\Books', name: 'Acme.ironbooks' });
    expect(pathParts('C:\\Out\\')).toEqual({ folder: 'C:\\Out\\', name: null });
    expect(pathParts('March.pdf')).toEqual({ folder: null, name: 'March.pdf' });
    // Nothing is tidied away: a ".." stays in sight.
    expect(pathParts('C:\\Out\\..\\Windows\\x.dll')).toEqual({ folder: 'C:\\Out\\..\\Windows', name: 'x.dll' });
    // Invisible characters cannot turn a name around.
    expect(pathParts('C:\\Out\\Invoice‮fdp.exe').name).toBe('Invoicefdp.exe');
  });

  it("a ledger line names who it is for and its class, when the preview has them", () => {
    type Line = NonNullable<OperationPreview['ledger']>['entries'][number]['lines'][number];
    const line: Line = { accountId: 'a', accountCode: '1200', accountName: 'Accounts Receivable', debit: '50.00', credit: null, memo: null, entityName: 'Acme Supply' };
    expect(lineNameAndClass(line)).toEqual({ name: 'Acme Supply', className: null });
    expect(lineNameAndClass({ ...line, entityName: null, className: 'East' } as unknown as Line)).toEqual({ name: null, className: 'East' });
    expect(lineNameAndClass({ ...line, entityName: '  ', class: 'West' } as unknown as Line)).toEqual({ name: null, className: 'West' });
  });

  it('standing permission that was not given: the server\'s words as they came, not said twice', () => {
    // lib/services/agentRequests.ts GRANT_NOT_GIVEN_MESSAGE.
    const unexpected = 'Standing permission was not given because of an unexpected problem. The work itself was done, so do not ask for it again; the next request like it will ask a person.';
    expect(grantNotGivenText('Month-end helper', unexpected)).toBe(unexpected);
    expect(grantNotGivenText('Month-end helper', 'Standing permission for this can last at most 30 minutes.')).toBe(
      'It was done, but standing permission was not given, so Month-end helper will ask again next time. Why: Standing permission for this can last at most 30 minutes.',
    );
    expect(grantNotGivenText('Month-end helper', null)).toBe('It was done, but standing permission was not given, so Month-end helper will ask again next time.');
  });

  it('a refused approval: the server\'s words, and "type it again" only where they do not already say what to type', () => {
    const closing = 'Type the closing-date password on the card, then approve again. Nothing was done.';
    expect(approveFailureText(closing, true)).toBe(closing);
    expect(approveFailureText('That closing date password is not correct.', true)).toBe('That closing date password is not correct. Type the password again to try once more.');
    expect(approveFailureText('Ironbooks never lets an agent change a role that an agent holds.', false)).toBe('Ironbooks never lets an agent change a role that an agent holds.');
    expect(approveFailureText('', false)).toMatch(/nothing was done/);
  });

  it('after the books changed, a figure the new preview cannot show never drops a limit the form had, and the time never grows', () => {
    const before = req({ amount: '1300.00' });
    const opened = initialGrantForm(before, NOW);
    const unknown = rebuildGrantForm(opened, before, req({ amount: null }), NOW);
    expect(unknown.form).toMatchObject({ amountOn: true, amount: '1300.00' });
    expect(unknown.note).toMatch(/the amount limit you had is kept/);
    // The most this person may give went up: what the form said is still the most.
    const wider = rebuildGrantForm({ ...opened, minutes: 30 }, req({ amount: '1300.00', grantMinutesMax: 30 }), req({ amount: '1325.00', grantMinutesMax: 120 }), NOW);
    expect(wider.form.minutes).toBe(30);
    const sentBack = req({ amount: '1325.00', preview: { ...BASE.preview!, ledger: null, routePreview: { ran: false, note: 'Ironbooks tried this with the full protected values.' } } });
    expect(rebuildGrantForm(opened, before, sentBack, NOW).note).toMatch(/^Ironbooks sent this back with new figures\./);
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

  it('amounts as money, through lib/money.ts', () => {
    expect(amountText('1250')).toBe('$1,250.00');
    expect(amountText('0.1')).toBe('$0.10');
    expect(amountText('-5.5')).toBe('-$5.50');
    expect(amountText('about 100')).toBe('about 100');
    expect(amountText(null)).toBe('');
  });
});

describe('status words', () => {
  it("'approved' is being carried out; a first of two approvals waits for a second person", () => {
    expect(statusLabel(req({ status: 'approved', decidedByName: 'Pat' }))).toBe('Approved, being carried out');
    expect(statusLabel(req({ status: 'pending', decidedByName: 'Pat' }))).toBe('Waiting for a second person');
    expect(statusLabel(req({ status: 'pending' }))).toBe('Waiting');
    expect(isWaiting('pending')).toBe(true);
    expect(isWaiting('approved')).toBe(false);
    expect(STATUS_FILTERS.find((f) => f.value === 'approved')?.label).toBe('Approved, being carried out');
  });
});

describe('approving several at once', () => {
  it('the most at once is the server\'s own limit', () => {
    expect(BATCH_MAX).toBe(BATCH_APPROVE_MAX);
  });

  it('only waiting new entries and changes of one operation that one person may approve alone, here', () => {
    expect(batchBlock(BASE, null)).toBeNull();
    expect(batchBlock(BASE, 'invoices.create')).toBeNull();
    expect(batchBlock(BASE, 'bills.create')).toMatch(/same kind of work/);
    expect(batchBlock(req({ class: 'outside' }), null)).toMatch(/Only new entries and changes/);
    expect(batchBlock(req({ class: 'remove' }), null)).toMatch(/Only new entries and changes/);
    expect(batchBlock(req({ canApprove: false, cannotApproveWhy: 'Needs an Admin.' }), null)).toBe('Needs an Admin.');
    expect(batchBlock(req({ status: 'executed' }), null)).toMatch(/still waiting/);
    expect(batchBlock(req({ status: 'approved' }), null)).toMatch(/still waiting/);
    expect(batchBlock(req({ kind: 'grant' }), null)).toMatch(/one request at a time/);
    expect(batchBlock(req({ needs: { ...BASE.needs!, secrets: ['closing_password'] } }), null)).toMatch(/needs a password/);
    expect(batchBlock(req({ operation: 'shell.company.open', questions: SHELL_OPERATIONS.find((o) => o.id === 'shell.company.open')!.questions }), null)).toMatch(/questions to answer/);
    // As the server's batchApprove: two people, or the host computer, mean one at a time.
    expect(batchBlock(req({ needs: { ...BASE.needs!, twoPerson: true } }), null)).toMatch(/needs two people/);
    expect(batchBlock(req({ needs: { ...BASE.needs!, hostOnly: true } }), null)).toMatch(/only at the host computer/);
    // The books changed: a yes is given again on the new preview, on its own.
    expect(batchBlock(req({ stale: true }), null)).toMatch(/books changed/);
    // Sent back with a note: said so, never "the books changed".
    const sentBack = batchBlock(req({ stale: true, preview: { ...BASE.preview!, ledger: null, routePreview: { ran: false, note: 'x' } } }), null);
    expect(sentBack).toMatch(/sent this back with a note/);
    expect(sentBack).not.toMatch(/books changed/);
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

  it('filled in again from a new preview, it takes that preview\'s amount', () => {
    expect(initialGrantForm(req({ amount: '1325.00' }), NOW).amount).toBe('1325.00');
  });

  it('after the books changed, only what the person had not changed is taken from the new preview', () => {
    const before = req({ amount: '1300.00' });
    const after = req({ amount: '1325.00' });
    const opened = initialGrantForm(before, NOW);
    // Untouched: the amount follows the new preview, the rest stays.
    const same = rebuildGrantForm(opened, before, after, NOW);
    expect(same.form).toEqual({ ...opened, amount: '1325.00' });
    expect(same.note).toMatch(/^The books changed\. The amount below now comes from what would happen now; every limit you had changed is kept\./);
    // Narrowed by the person: a shorter time, one use, other dates and an unticked limit stay; so does an amount they typed.
    const narrowed = { ...opened, minutes: 15, uses: '1', dateFrom: '2026-11-10', dateTo: '2026-11-12', entitiesOn: false };
    const kept = rebuildGrantForm(narrowed, before, after, NOW);
    expect(kept.form).toEqual({ ...narrowed, amount: '1325.00' });
    expect(grantFromForm(kept.form, after.grantMinutesMax)).toEqual({
      grant: { minutes: 15, constraints: { maxAmount: '1325.00', accountIds: [ACCOUNT], dateFrom: '2026-11-10', dateTo: '2026-11-12', maxUses: 1 } },
    });
    const typed = rebuildGrantForm({ ...opened, amount: '500' }, before, after, NOW);
    expect(typed.form.amount).toBe('500');
    expect(typed.note).toMatch(/limits below are as you left them/);
    const unticked = rebuildGrantForm({ ...opened, amountOn: false }, before, after, NOW);
    expect(unticked.form.amountOn).toBe(false);
    // Never longer than the person chose, nor than may be given now.
    const less = rebuildGrantForm({ ...opened, minutes: 120 }, before, req({ amount: '1325.00', grantMinutesMax: 45 }), NOW);
    expect(less.form.minutes).toBe(45);
    expect(less.note).toMatch(/For how long is now at most 45 minutes/);
    // A bulk change: the count follows the new preview unless the person typed one.
    const bulk = (n: number) =>
      req({ class: 'bulk', amount: null, input: { body: {} }, needs: { ...BASE.needs!, grantable: 'capped' }, preview: { ...BASE.preview!, records: Array.from({ length: n }, (_, i) => ({ action: 'update', kind: 'item', id: `i${i}`, fields: [] })) } });
    const bulkOpened = initialGrantForm(bulk(3), NOW);
    expect(rebuildGrantForm(bulkOpened, bulk(3), bulk(5), NOW).form.count).toBe('5');
    expect(rebuildGrantForm({ ...bulkOpened, count: '2' }, bulk(3), bulk(5), NOW).form.count).toBe('2');
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

  it('what was really given is said from the server\'s grant', () => {
    const at = new Date(2026, 10, 20, 15, 30);
    const text = grantGivenText('Month-end helper', { minutes: 90, constraints: {}, expiresAt: at.toISOString() });
    expect(text).toMatch(/^Month-end helper may do more of the same without asking for 1 hour 30 minutes, until about /);
    expect(grantGivenText('X', { minutes: 0, constraints: {}, expiresAt: 'not a time' })).toBe('X may do more of the same without asking. You can take it back in Users & Roles > Agents.');
  });

  it('reads amounts the way people type them', () => {
    expect(amountValue('$1,250.5')).toBe('1250.50');
    expect(amountValue('0')).toBeNull();
    expect(amountValue('12.345')).toBeNull();
    expect(monthOf(new Date(2026, 1, 10))).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });
});
