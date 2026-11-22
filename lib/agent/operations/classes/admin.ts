/**
 * Agent full access: classification of the "admin" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/admin.test.ts.
 *
 * How this bucket was decided (plan sections 4.2, 4.6, 5.1, 5.6, 5.8, 5.9 and the rows "Users, roles,
 * security", "Backup & file utilities" and "Multi-user & hosting" of section 8):
 *  - Users, roles, password rules, the file password and sessions are 'admin'. An operation whose
 *    whole point is a secret (a user's new password, a recovery key, a new file key) is 'secret'.
 *  - Reading Users & Roles is 'admin' too (plan 4.2): who may sign in, what each role allows and
 *    the password rules are what an attacker would read first, and the door asks by class, not by
 *    area, so a 'read' here would run for an Admin-role agent with nobody asked.
 *  - Backups, restores, portable files, the company list and saving the file are 'file'. A restore
 *    is 'file' (Admin, never Allow) rather than 'remove': it replaces every company in the file.
 *    File Utilities reads that show file names, folders or backups, or produce a file, are 'file'
 *    as well (plan 4.2). Pure checks of the books (integrity, books in balance) stay 'read': they
 *    answer pass or fail per check and show nothing of the files on disk.
 *  - A GET classed above 'read' is dryRun 'none'. A dry run hands the route's answer back to the
 *    agent (lib/agent/operate.ts tryOnly), and for a read the answer is the very thing a person is
 *    asked about, so it is described only and runs once someone approves.
 *  - Signing in, unlocking the file and a person's own two-step sign-in are 'person_only': they ARE
 *    a person acting as themselves. The desktop shell's own calls (internal token) are marked the
 *    same way: an agent cannot ask for them; its way is the shell operation (plan 5.5).
 *  - Making, changing, pausing or removing agents, their policies and standing permissions, answering
 *    permission requests (the approval center) and working in a practice copy are on the hard floor
 *    (plan 4.6, D9): even looking is a person's, in their own window. An agent reads its OWN requests
 *    at /api/agent/requests, class read.
 *  - Where the generated id names a route badly (a GET that downloads, a POST that restores or
 *    signs everyone out), the entry gives a better `id`.
 *  - Routes that refuse a request from another computer with the host-only test (lib/net/hostOnly.ts,
 *    or the same originFromHeaders test written out in the route) are hostOnly, so a person can only
 *    approve them at the host's own window: the bridge's own request would otherwise pass that test.
 *  - Services that open their own database handle or work on the files on disk (backup.ts,
 *    companyFileSave.ts, sandbox.ts, the protection key) are dryRun 'none': nothing to roll back.
 *  - Some routes act through the caller's own user id (getSessionGate, requireAccessInCompany) and
 *    check THAT person's access, in the company the request names, not the agent's role. Their
 *    "why" says so: the bridge has to run them as the approver and show which company they touch.
 */
import type { ClassificationMap } from '../types';

/**
 * Where a one-company backup carries the fields maskSensitive masks (lib/permissions/mask.ts
 * SSN_KEYS and ACCOUNT_KEYS): the rows of each table in its company-data.json.
 */
const COMPANY_BACKUP_MASKED = ['ssn', 'employeeSsn', 'taxId', 'accountNumber', 'routingNumber', 'bankAccountNumber'].map(
  (k) => `tables.*.*.${k}`,
);

/** Why a read of Users & Roles is 'admin' (see the header), said once for each of them. */
const USERS_READ_WHY =
  'A read of Users & Roles, so class admin (plan 4.2): it shows who can sign in to the books and what each of them may do, which is where an attacker would start. An Admin approves it. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.';

/** Why a File Utilities read that shows the files on disk is 'file' (see the header). */
const FILE_READ_WHY =
  'A File Utilities read that shows the company file on disk (backup, archive or copy names, folders, or a file to download), so class file (plan 4.2): an Admin approves it. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.';

/** Why a pure check of the books stays 'read' although it sits in File Utilities. */
const BOOKS_CHECK_WHY =
  'Stays class read on purpose, although File Utilities: a pure check of the books (plan 4.2 lets those stay read). It runs read-only queries and answers pass or fail per check, with no file names, folders or backups. Through the door it runs without asking for an agent whose role may view File Utilities; an agent\'s own request never reaches it (lib/permissions/agentAccess.ts AGENT_DOOR_ONLY_AREAS).';

export const ADMIN_CLASSES: ClassificationMap = {
  // ---- Users (Users & Roles) ----
  'GET /api/users': { class: 'admin', describe: 'List the users of this company', why: USERS_READ_WHY, dryRun: 'none' },
  'POST /api/users': {
    class: 'admin',
    describe: 'Add user {name} (login: {login})',
    why: "Adds a person who can sign in to the books. A new login needs a password (body field password), which the approving Admin types; the agent never sees it and must never supply it, or it could sign in as that person. A login that already exists in the file is added as it is, without a password.",
    needsSecret: ['new_user_password'],
    sensitiveFields: ['password'],
  },
  'GET /api/users/[id]': { class: 'admin', describe: 'Show user {id} and what they may do', why: USERS_READ_WHY, dryRun: 'none' },
  'PATCH /api/users/[id]': {
    class: 'admin',
    describe: 'Change user {id}: name, login, roles or whether they can sign in',
    why: "Changes a person's login, roles or access. Deactivating someone also asks for a new file key at the next save (in memory, not rolled back by a dry run; harmless, it keeps every slot that should open the file).",
  },
  'POST /api/users/[id]/reset-password': {
    class: 'secret',
    describe: 'Set a new password for user {id}',
    why: "The input is a person's new password (body field password): the approving Admin types it, the agent never sees it and must never supply it, or it could sign in as that person. It also signs that person out everywhere and can turn off their two-step sign-in (turnOffTwoFactor). In a protected file it asks for a new file key at the next save (in memory, not rolled back by a dry run; harmless).",
    needsSecret: ['new_user_password'],
    sensitiveFields: ['password', 'currentPassword'],
  },
  'GET /api/users/password-policy': {
    class: 'admin',
    describe: 'Show the password rules of the company file',
    why: USERS_READ_WHY,
    dryRun: 'none',
  },
  'PUT /api/users/password-policy': {
    class: 'admin',
    describe: 'Change the password rules of the company file',
    why: 'Password rules cover every login in the file; only an Admin of every company may change them.',
    fileAdmin: true,
  },
  'GET /api/users/permissions-report': {
    class: 'admin',
    describe: 'Show a permissions report of the users or roles',
    why: `${USERS_READ_WHY} ?kind= picks the report (roles when left out). ?format=csv answers the same report as a CSV file (text/csv) instead of JSON.`,
    dryRun: 'none',
  },

  // ---- Roles ----
  'GET /api/roles': { class: 'admin', describe: 'List the roles and what each one allows', why: USERS_READ_WHY, dryRun: 'none' },
  'POST /api/roles': {
    class: 'admin',
    describe: 'Make role {name}',
    why: 'Roles decide what people and agents may do. Never more than the approver has (assertCanGrant).',
  },
  'GET /api/roles/[id]': { class: 'admin', describe: 'Show role {id} and what it allows', why: USERS_READ_WHY, dryRun: 'none' },
  'PATCH /api/roles/[id]': {
    class: 'admin',
    describe: 'Change what role {id} allows',
    why: "Changes what everyone holding the role may do. Agents can hold custom roles (agents.ts checks an agent's roles against the same list), so editing a role an agent holds changes that agent: the bridge must refuse it when ANY agent holds the role, not only the agent asking (plan 4.6, D9).",
  },
  'DELETE /api/roles/[id]': {
    class: 'admin',
    describe: 'Delete role {id}',
    why: "A Users & Roles change, Admin-approved like the rest of them. The service refuses it while a PERSON holds the role, but never looks at agents (users.ts deleteRole checks people's role assignments only), so deleting a role an agent holds quietly changes that agent's access: the bridge must refuse it when any agent holds the role (plan 4.6, D9).",
  },

  // ---- Company file password ----
  'GET /api/file-lock': { class: 'read', describe: 'Show whether the company file has a password', id: 'file-lock.status' },
  'POST /api/file-lock': {
    class: 'admin',
    describe: 'Set or remove the company file password ({action})',
    id: 'file-lock.change',
    why: 'The file password locks every company in the file. The new and current passwords are typed by the approving file Admin, never by the agent.',
    fileAdmin: true,
    needsSecret: ['file_password'],
    sensitiveFields: ['password', 'currentPassword'],
  },

  // ---- File protection (encrypted company file) ----
  'GET /api/file-protection': { class: 'read', describe: 'Show who can open the protected company file', id: 'file-protection.status' },
  'POST /api/file-protection': {
    class: 'secret',
    describe: 'Protect the company file with passwords',
    id: 'file-protection.protect',
    why: "Encrypts the whole file and answers its recovery key once: shown to the approver only. Needs the approving file Admin's OWN sign-in password, typed again and checked against the user id the request runs as (getSessionGate), so it must run as the approver. The contract has no kind for that password; file_password is the nearest. Refused from another computer, so host-only. Writes the protection marker on disk, so no dry run.",
    hostOnly: true,
    fileAdmin: true,
    needsSecret: ['file_password'],
    producesSecret: ['recovery_key'],
    sensitiveFields: ['password', 'recoveryKey'],
    dryRun: 'none',
  },
  'POST /api/file-protection/file-key': {
    class: 'secret',
    describe: 'Give the protected company file a new file key',
    why: "Changes the key that opens the file; older copies stop opening what is saved from now on. Needs the approving file Admin's OWN sign-in password, checked against the user id the request runs as (getSessionGate), so it must run as the approver; file_password is the nearest kind the contract has. Refused from another computer, so host-only. Opens its own transaction and writes the key marker on disk, so no dry run.",
    hostOnly: true,
    fileAdmin: true,
    needsSecret: ['file_password'],
    sensitiveFields: ['password'],
    dryRun: 'none',
  },
  'POST /api/file-protection/recovery-key': {
    class: 'secret',
    describe: 'Make a new recovery key for the company file',
    why: "The answer is the new recovery key, shown once to the approver only. Needs the approving file Admin's OWN sign-in password, checked against the user id the request runs as (getSessionGate), so it must run as the approver; file_password is the nearest kind the contract has. Refused from another computer, so host-only. Also changes the file key (own transaction, marker on disk), so no dry run.",
    hostOnly: true,
    fileAdmin: true,
    needsSecret: ['file_password'],
    producesSecret: ['recovery_key'],
    sensitiveFields: ['password', 'recoveryKey'],
    dryRun: 'none',
  },

  // ---- Unlocking the company file (the unlock screen) ----
  'POST /api/unlock': {
    class: 'secret',
    describe: 'Open the company file with its password',
    availability: 'person_only',
    why: 'Unlocking is a person opening the file with its password before signing in. An agent never types the file password.',
    sensitiveFields: ['password'],
  },
  'POST /api/unlock/admin': {
    class: 'secret',
    describe: 'Remove a forgotten company file password by signing in as Admin',
    availability: 'person_only',
    why: "This is an Admin signing in with their own user name and password; an agent never signs in as a person.",
    sensitiveFields: ['password', 'totp'],
  },

  // ---- Sessions and single-user mode (multi-user hosting) ----
  'GET /api/sessions': {
    class: 'read',
    describe: 'Show who is signed in to this company',
    why: "Reads only. Looking up single-user mode releases a hold whose session has ended (sessions.ts getSingleUserMode), but the agent door's own single-user check (lib/agentContext.ts, assertSessionAllowed) does the same for this company on every agent request just before, so nothing is left to release; on a read-only handle it would be refused, never hidden. Only an Admin sees other people's computers and sign-in times; anyone else gets a head count.",
  },
  'POST /api/sessions': {
    class: 'admin',
    describe: 'Sign out every signed-in session of this company',
    id: 'sessions.sign-out-all',
    why: 'Body { action: "sign-out-others" }. It keeps only the session the request runs in, and a bridged call has none, so every session of the company ends, the approving person\'s included (unless the bridge passes the approver\'s session id). Also releases a single-user hold one of them had.',
  },
  'DELETE /api/sessions/[id]': {
    class: 'admin',
    describe: 'Sign out session {id}',
    why: 'Ends a sign-in session. Nothing is deleted: the person can sign in again.',
  },
  'GET /api/single-user': {
    class: 'read',
    describe: 'Show whether the company is in single-user mode',
    id: 'single-user.status',
    why: "Reads only. It releases a single-user hold whose session has ended (sessions.ts getSingleUserMode), the same as the agent door's single-user check (lib/agentContext.ts) does for this company on every agent request just before, so nothing is left to release; on a read-only handle it would be refused, never hidden.",
  },
  'POST /api/single-user': {
    class: 'admin',
    describe: 'Turn single-user mode on or off (on: {enabled})',
    id: 'single-user.switch',
    why: 'Single-user mode keeps everyone else out of the company. Agents cannot work while it is on.',
  },

  // ---- Signing in and a person's own sign-in security (auth) ----
  'GET /api/auth/2fa/recovery-codes': {
    class: 'read',
    describe: 'Show how many two-step recovery codes are left',
    availability: 'person_only',
    why: "A person's own two-step sign-in. An agent has its own token and no sign-in of its own.",
  },
  'POST /api/auth/2fa/recovery-codes': {
    class: 'secret',
    describe: 'Make new two-step recovery codes',
    availability: 'person_only',
    why: "A person's own two-step sign-in; the answer is their new recovery codes.",
    sensitiveFields: ['token', 'recoveryCodes'],
  },
  'POST /api/auth/2fa/setup': {
    class: 'secret',
    describe: 'Start setting up two-step sign-in',
    availability: 'person_only',
    why: "A person's own two-step sign-in, confirmed with their own password; the answer is the authenticator secret.",
    sensitiveFields: ['currentPassword', 'secret', 'otpauthUrl'],
  },
  'POST /api/auth/2fa/enable': {
    class: 'secret',
    describe: 'Turn on two-step sign-in',
    availability: 'person_only',
    why: "A person's own two-step sign-in, confirmed with a code from their authenticator; the answer is their recovery codes.",
    sensitiveFields: ['token', 'recoveryCodes'],
  },
  'POST /api/auth/2fa/disable': {
    class: 'secret',
    describe: 'Turn off two-step sign-in',
    availability: 'person_only',
    why: "A person's own two-step sign-in, turned off with a code from their authenticator or a recovery code.",
    sensitiveFields: ['token'],
  },
  'GET /api/auth/challenge': {
    class: 'read',
    describe: 'Show my challenge question',
    availability: 'person_only',
    why: "The signed-in person's own challenge question for \"I forgot my password\".",
  },
  'POST /api/auth/challenge': {
    class: 'secret',
    describe: 'Set my challenge question',
    availability: 'person_only',
    why: "The signed-in person's own challenge question and answer, confirmed with their current password.",
    sensitiveFields: ['currentPassword', 'answer'],
  },
  'POST /api/auth/change-password': {
    class: 'secret',
    describe: 'Change my password',
    availability: 'person_only',
    why: "A person changing their own password. An Admin sets someone else's with POST /api/users/[id]/reset-password.",
    sensitiveFields: ['currentPassword', 'newPassword'],
  },
  'POST /api/auth/login': {
    class: 'secret',
    describe: 'Sign in as {email}',
    availability: 'person_only',
    why: 'Signing in is a person proving who they are. An agent is its own identity and never signs in as a person.',
    sensitiveFields: ['password', 'totp', 'filePassword'],
  },
  'POST /api/auth/logout': {
    class: 'admin',
    describe: 'Sign out of Ironbooks',
    availability: 'person_only',
    why: "Ends the caller's own sign-in session (its cookie). An agent has no session to end.",
  },
  'GET /api/auth/me': {
    class: 'read',
    describe: 'Show who is signed in here',
    availability: 'person_only',
    why: "The signed-in person's own identity from their session cookie. An agent asks GET /api/agent/whoami.",
  },
  'GET /api/auth/password-policy': {
    class: 'read',
    describe: 'Show the password rules for the sign-in screens',
    availability: 'person_only',
    why: 'The sign-in, sign-up and reset screens\' copy of the rules. An agent reads the same rules at GET /api/users/password-policy.',
  },
  'POST /api/auth/recover': {
    class: 'secret',
    describe: "Set a new Admin password with the company file's recovery key",
    availability: 'person_only',
    why: 'The way back in when every password is lost: a person with the recovery key, at the host computer.',
    sensitiveFields: ['recoveryKey', 'password'],
  },
  'POST /api/auth/request-reset': {
    class: 'secret',
    describe: 'Ask to reset the password of {email}',
    availability: 'person_only',
    why: '"I forgot my password": a person answering their own challenge question; the answer can carry a reset code.',
    sensitiveFields: ['challengeAnswer', 'token'],
  },
  'POST /api/auth/reset': {
    class: 'secret',
    describe: 'Reset a password with a reset code',
    availability: 'person_only',
    why: 'A person finishing their own password reset with the code they were given.',
    sensitiveFields: ['token', 'password'],
  },
  'POST /api/auth/signup': {
    class: 'secret',
    describe: "Set up the company file's Admin and company {companyName}",
    availability: 'person_only',
    why: "The first person setting up a new company file as its Admin; the answer carries the file's recovery key.",
    sensitiveFields: ['password', 'challengeAnswer', 'recoveryKey'],
  },

  // ---- Device security (Company > Security) ----
  // Runs a local Windows check of the drive (nothing written, no network); 'unknown' from another computer.
  'GET /api/device-security': { class: 'read', describe: 'Show whether the drive holding the company file is encrypted' },

  // ---- Desktop shell start-up check ----
  'GET /api/handshake': {
    class: 'read',
    describe: 'Check that the server answering is the one the desktop started',
    availability: 'person_only',
    why: 'Not an operation (plan section 8): the desktop shell checks at start-up that the port answers with the server it started. Nothing for an agent to ask for.',
  },

  // ---- The agent's own door (/api/agent/*) ----
  'GET /api/agent/whoami': { class: 'read', describe: 'Show who this agent is and which books these are' },
  // The agent's OWN permission requests: the handlers refuse a person and drop any other agent's.
  'GET /api/agent/requests': {
    class: 'read',
    describe: 'List my requests to people and their answers',
    id: 'agent.requests.list',
  },
  'GET /api/agent/requests/[id]': {
    class: 'read',
    describe: 'Show my request {id} and its answer',
    why: '?wait= makes it a long poll: it answers when a person has decided, or after at most WAIT_MAX_SECONDS (lib/agent/contract.ts). Run by the route bridge it never waits.',
  },
  // The connector calls it directly before it shows its token; answers from memory.
  'GET /api/agent/hello': { class: 'read', describe: 'Check that this is the Ironbooks the connector expects' },
  'POST /api/agent/actions': {
    class: 'enter',
    describe: 'Run agent action {action}',
    availability: 'person_only',
    why: 'Not applicable: this is the door an agent\'s curated actions come in through, not an operation. Running it as an operation would put an action inside an action, and people do not use it.',
  },
  'GET /api/agent/service': {
    class: 'read',
    describe: 'Tell the desktop when an agent last worked',
    availability: 'person_only',
    why: "Not applicable: the desktop shell's own call with its per-launch token, to close an unattended file after a quiet while. An agent's request never carries that token.",
  },
  'POST /api/agent/service': {
    class: 'admin',
    describe: 'Let agents work while nobody is signed in',
    availability: 'person_only',
    why: "Not applicable: the desktop shell's own call with its per-launch token, deciding whether agents may work with nobody signed in. Part of how agents are let in, so never an agent's to ask for.",
  },

  // ---- Agents (Users & Roles > Agents): the hard floor ----
  // The GETs of the Agents tab are Users & Roles reads, so class admin like the others; on the
  // hard floor the class decides nothing, but no list shows them as a plain read.
  'GET /api/agents': {
    class: 'admin',
    describe: 'List the agents of this company',
    availability: 'hard_floor',
    why: 'Agents never manage agents (plan 4.6, D9). The service already refuses any caller that is not a person (assertAdminPerson), and the answer tells where the connector lives on this computer.',
    dryRun: 'none',
  },
  'POST /api/agents': {
    class: 'admin',
    describe: 'Make agent {name}',
    availability: 'hard_floor',
    why: 'Agents never make agents or choose their roles (plan 4.6, D9): a prompt-injected agent would ask to widen itself until someone clicks yes. The answer holds the new agent\'s token, a secret; it stays class admin (not secret) only because the hard floor means an agent never reaches it.',
    hostOnly: true,
    sensitiveFields: ['token'],
  },
  'DELETE /api/agents/[id]': {
    class: 'admin',
    describe: 'Take away the access of agent {id}',
    availability: 'hard_floor',
    why: 'Agents never change or remove agents (plan 4.6, D9). A person does it in two clicks in the Agents tab.',
    hostOnly: true,
  },
  'GET /api/agents/[id]': {
    class: 'admin',
    describe: 'Show agent {id} with its roles and permissions',
    availability: 'hard_floor',
    why: "Agents never manage agents (plan 4.6, D9): the detail page is where a person decides what an agent may do, so even reading it is a person's, in their own window. An agent reads its own permissions with get_my_permissions.",
    dryRun: 'none',
  },
  'PATCH /api/agents/[id]': {
    class: 'admin',
    describe: 'Change what agent {id} may do: preset, Allow / Ask / Never, limits and folders',
    availability: 'hard_floor',
    why: 'Agents never change their own or another agent\'s permissions (plan 4.6, D9): a prompt-injected agent would ask to widen itself until someone clicks yes. A person does it in the Agents tab, at the computer that holds the company file (the folders are folders of that computer).',
    hostOnly: true,
  },
  'POST /api/agents/[id]/pause': {
    class: 'admin',
    describe: 'Pause or resume agent {id} (paused: {paused})',
    availability: 'hard_floor',
    why: 'Pausing and resuming agents stays with people (plan 4.6, D9): an agent could otherwise resume itself or stop another.',
  },
  'POST /api/agents/pause-all': {
    class: 'admin',
    describe: 'Pause or resume every agent of this company (paused: {paused})',
    availability: 'hard_floor',
    why: 'The kill switch (the Integrated Applications switch, one click away) stays with people in both directions (plan 4.6).',
  },
  'GET /api/agents/[id]/grants': {
    class: 'admin',
    describe: 'List the standing permissions of agent {id}',
    availability: 'hard_floor',
    why: "Agents never manage agents' standing permissions (plan 4.6, D9); this list is the person's, with Revoke beside each one. An agent reads its own live grants with get_my_permissions.",
    dryRun: 'none',
  },
  'GET /api/agents/[id]/activity': {
    class: 'admin',
    describe: 'Show what agent {id} ran and asked for',
    availability: 'hard_floor',
    why: "Part of a person watching over agents (plan 7.1, 4.6): one agent's record is not another agent's to read.",
    dryRun: 'none',
  },

  // ---- Answering agents: the approval center (plan 7.2). All on the hard floor (plan 4.6) ----
  // An approval only ever comes from a signed-in person's window, never from a request that
  // carries an agent token; the handlers refuse an agent's context before anything else.
  'GET /api/agent-requests': {
    class: 'read',
    describe: 'List the requests agents are waiting on',
    id: 'agent-requests.list',
    availability: 'hard_floor',
    why: "The approval center is a person's: it shows every agent's requests and who may approve them. An agent lists its own at GET /api/agent/requests.",
  },
  'GET /api/agent-requests/count': {
    class: 'read',
    describe: 'Count the agent requests waiting for my answer',
    availability: 'hard_floor',
    why: "The title bar's badge for the signed-in person (plan 7.2). An agent has no requests to answer.",
  },
  'GET /api/agent-requests/[id]': {
    class: 'read',
    describe: 'Show agent request {id} with its preview',
    availability: 'hard_floor',
    why: "The approval card is a person's. An agent reads its own request at GET /api/agent/requests/[id].",
  },
  'POST /api/agent-requests/[id]/approve': {
    class: 'admin',
    describe: 'Approve agent request {id}',
    availability: 'hard_floor',
    why: 'Approving is what a person does in their own window (plan 4.5, 4.6): an agent that could approve would approve itself. The body carries the secrets the approver typed on the card, and the answer secrets the run produced: both for that person only.',
    sensitiveFields: ['secrets.*', 'produced.*.value'],
  },
  'POST /api/agent-requests/[id]/deny': {
    class: 'admin',
    describe: 'Deny agent request {id}',
    availability: 'hard_floor',
    why: 'Answering a request is a person\'s (plan 4.6): an agent never approves, denies or alters a permission request.',
  },
  'POST /api/agent-requests/batch-approve': {
    class: 'admin',
    describe: 'Approve several agent requests of the same kind at once',
    availability: 'hard_floor',
    why: 'Approving is what a person does in their own window (plan 4.5, 4.6). Each request is still approved and reported on its own.',
    sensitiveFields: ['results.*.produced.*.value'],
  },
  'DELETE /api/agent-grants/[id]': {
    class: 'admin',
    describe: 'Take back standing permission {id}',
    id: 'agent-grants.revoke',
    availability: 'hard_floor',
    why: "Agents never change standing permissions, their own or another agent's (plan 4.6, D9). Taking one back ends nothing for good: a person can give it again.",
  },

  // ---- Backup and restore of the whole company file ----
  'GET /api/backup': {
    class: 'file',
    describe: 'Download a backup of the whole company file',
    id: 'backup.download',
    why: 'Not a pure read: a copy of every company and every login in the file, nothing masked (full SSNs and account numbers), recorded in the backup history on disk. The service reads the files on disk, so no dry run.',
    fileAdmin: true,
    output: 'file',
    dryRun: 'none',
  },
  'POST /api/backup': {
    class: 'file',
    describe: 'Restore the whole company file from an uploaded backup',
    id: 'backup.restore',
    why: 'Replaces every company in the file (and revokes every agent). Closes the database and swaps the folder, so no dry run. A backup from another protected file needs its user name and password or recovery key, typed by the approver.',
    fileAdmin: true,
    body: 'bytes',
    dryRun: 'none',
    needsSecret: ['archive_credentials'],
    effects: ['file'],
  },
  'GET /api/backup/company': {
    class: 'file',
    describe: "Download a backup of one company's books (company {companyId})",
    id: 'backup.company.download',
    why: "Not a pure read: a copy of one company's books, recorded in the backup history on disk. ?companyId= can name ANOTHER company in the file (this one when left out); the route checks the access of the user id it runs as, in that company (requireAccessInCompany), not the agent's role. SSNs and tax IDs, and bank and account numbers, are masked unless that same access holds the matching flags, so the masked copy is the ordinary one and a reveal is asked for. The contract takes one reveal kind, so it names SSNs; a run whose access holds both flags unmasks account numbers too. Reads attachment files on disk, so no dry run.",
    output: 'file',
    dryRun: 'none',
    reveal: 'ssn',
    sensitiveFields: COMPANY_BACKUP_MASKED,
  },
  'POST /api/backup/company': {
    class: 'file',
    describe: 'Restore a company backup as a new company {name}',
    id: 'backup.company.restore',
    why: 'Adds a whole new company to the file. Makes a safety copy and copies attachment files on disk first, so no dry run. A backup from another protected file needs its credentials, typed by the approver.',
    body: 'bytes',
    dryRun: 'none',
    needsSecret: ['archive_credentials'],
    effects: ['file'],
  },

  // ---- Backup history, automatic backups, back up now ----
  // Both GETs also start the in-process backup timer when it is not running yet. The GET itself
  // writes nothing, but the timer's first check (about 15 seconds later) writes a scheduled backup
  // if one is due. A read-only handle would not catch that: it happens outside the request.
  'GET /api/backups': {
    class: 'file',
    describe: 'Show the backup history and automatic backup settings',
    why: `${FILE_READ_WHY} The history names every backup file and, for a file Admin, the backup folder on this computer.`,
    dryRun: 'none',
  },
  'PUT /api/backups': {
    class: 'file',
    describe: 'Change automatic backups (schedule: {schedule}) (versions kept: {keep}) (folder: {folder})',
    why: 'Decides how often and where the whole company file is copied, from then on, unattended. The folder can be any folder this computer can write to, a network share included, so full copies of the file can leave this computer on schedule. The folder can only be changed at the host computer, so host-only. Settings and a test file are written on disk, so no dry run.',
    fileAdmin: true,
    hostOnly: true,
    dryRun: 'none',
    effects: ['file'],
  },
  'GET /api/backups/status': {
    class: 'file',
    describe: 'Show when the company file was last backed up',
    why: `${FILE_READ_WHY} It tells when the last backup was made, whether the books changed since and when the next one is due.`,
    dryRun: 'none',
  },
  'POST /api/backups/preview': {
    class: 'file',
    describe: 'Look inside a backup before restoring it',
    why: 'Only looks, but at a whole backup (?id= from the history, or uploaded bytes): every company in it, beyond this company\'s books. Needs the file Admin, and opens the backup in a temporary folder on disk, so it is asked for and has no dry run.',
    fileAdmin: true,
    body: 'bytes',
    dryRun: 'none',
    needsSecret: ['archive_credentials'],
  },
  'POST /api/backups/restore': {
    class: 'file',
    describe: 'Restore the whole company file from backup {id}',
    why: 'Replaces every company in the file with a version from the backup history (and revokes every agent). Swaps the folder on disk, so no dry run; POST /api/backups/preview is its preview.',
    fileAdmin: true,
    dryRun: 'none',
    needsSecret: ['archive_credentials'],
    effects: ['file'],
  },
  'POST /api/backups/run': {
    class: 'file',
    describe: 'Back up the company file now',
    why: 'Writes a full copy of the company file into the backup folder.',
    fileAdmin: true,
    body: 'none',
    dryRun: 'none',
    effects: ['file'],
  },

  // ---- Condense ----
  'POST /api/condense': {
    class: 'remove',
    describe: 'Condense the books (the detail dated before {beforeDate}) (preview only: {dryRun})',
    why: "Rewrites the detail of a closed period into summary entries: cannot be undone except by restoring the archive copy it saves first. No dry run: the service opens the company's own folder through getDb() (protectionForDir) and writes a safety copy and an archive of it on disk before it condenses, so inside the bridge's transaction it would wait on that transaction for ever (PGlite runs one at a time), and a rollback could not take the files back. So the card shows no preview and no loss statement, only this line. The route's own read-only preview (body dryRun: true) is the same operation and needs the same approval; the line says which of the two is asked for (\"preview only: yes\", or \"no\" or nothing at all for the real condense).",
    dryRun: 'none',
    effects: ['file'],
  },
  'GET /api/condense/archives': {
    class: 'file',
    describe: 'List the copies saved before each condense',
    why: `${FILE_READ_WHY} Each archive copy is listed by its file name.`,
    dryRun: 'none',
  },
  'POST /api/condense/archives': {
    class: 'file',
    describe: 'Restore the whole company file from the pre-condense copy {id}',
    why: 'Replaces every company in the file with the copy saved before a condense. Swaps the folder on disk, so no dry run.',
    fileAdmin: true,
    dryRun: 'none',
    needsSecret: ['archive_credentials'],
    effects: ['file'],
  },

  // ---- Data integrity ----
  'GET /api/integrity': { class: 'read', describe: 'Check the books for data problems', why: BOOKS_CHECK_WHY },
  'GET /api/integrity/books-in-balance': { class: 'read', describe: 'Check that the books are in balance', why: BOOKS_CHECK_WHY },

  // ---- Portable company file and shareable ledger ----
  'GET /api/portable': {
    class: 'file',
    describe: 'Download a portable company file without a password',
    why: 'Not a pure read: a full copy of the company file with every company, user and password hash, nothing masked. Takes its own snapshot of the database, so no dry run.',
    fileAdmin: true,
    output: 'file',
    dryRun: 'none',
  },
  'POST /api/portable': {
    class: 'file',
    describe: 'Download a portable copy of the whole company file, with or without a password (protect: {protect})',
    why: 'A full copy of the company file with every company, user and password hash, nothing masked. With protect left out or true, the password the approver types protects it. With { protect: false } the route ignores any password and answers the copy WITHOUT one, so the card must not read as protected; GET /api/portable is the honest way to ask for an unprotected copy.',
    fileAdmin: true,
    output: 'file',
    dryRun: 'none',
    needsSecret: ['backup_password'],
    sensitiveFields: ['password'],
  },
  'POST /api/portable/restore': {
    class: 'file',
    describe: 'Open a portable company file as a new company file',
    why: 'Writes a whole new company file on disk next to the open one. ?inspect=1 is its own read-only preview. A protected portable file needs its password, typed by the approver.',
    body: 'bytes',
    dryRun: 'preview',
    needsSecret: ['backup_password'],
    effects: ['file'],
  },
  // An export of the books, nothing masked to hide (no tax IDs or account numbers in it): an Excel
  // workbook, or with ?format=pdf a PDF summary. The route map asks for File Utilities' Print right.
  'GET /api/portable/shareable': {
    class: 'file',
    describe: 'Download a shareable ledger (an Excel workbook, or a PDF summary when format is pdf)',
    why: `${FILE_READ_WHY} The answer is a file of the whole ledger, made to be shared outside the company.`,
    output: 'file',
    dryRun: 'none',
  },

  // ---- The single company file ----
  // GET also starts the autosave timer when it is not running yet. The GET itself writes nothing,
  // but the timer then saves unsaved changes into the company file when a save is due. A read-only
  // handle would not catch that: it happens outside the request.
  'GET /api/company-file/status': { class: 'read', describe: 'Show whether the company file is saved' },
  'GET /api/company-file/info': { class: 'read', describe: "Show the company file's name and where it is" },
  'POST /api/company-file/save': {
    class: 'file',
    describe: 'Save the company file now',
    why: 'Writes the open books into the company file on disk (companyFileSave.ts opens its own database handle), so no dry run.',
    body: 'none',
    dryRun: 'none',
    effects: ['file'],
  },
  'POST /api/company-file/close': {
    class: 'file',
    describe: 'Save and close the company file',
    availability: 'person_only',
    why: "Not applicable: the desktop shell's own call with its per-launch token, when it closes the file or quits. An agent's way is the shell operation shell.company.close.",
    body: 'none',
    dryRun: 'none',
  },
  'POST /api/company-file/save-as': {
    class: 'file',
    describe: 'Save a copy of the company file to {target}',
    availability: 'person_only',
    why: "Not applicable: the desktop shell's own call with its per-launch token, after a person chose the place in a Save dialog. An agent's way is the shell operation shell.company.saveCopyAs.",
    dryRun: 'none',
  },

  // ---- Companies in the file ----
  // Writes only on first run with no user at all (a demo company), which no agent can reach.
  'GET /api/companies': { class: 'read', describe: 'List the companies in this file' },
  'POST /api/companies': {
    class: 'file',
    describe: 'Make a new company {name}',
    why: 'Adds a whole company to the file, owned by the approving Admin.',
  },
  'POST /api/companies/select': {
    class: 'file',
    describe: 'Switch to another company ({companyId})',
    availability: 'person_only',
    why: "Sets the person's own active-company cookie for their window. An agent is tied to one company and has no cookie.",
  },
  'PATCH /api/companies/[id]': {
    class: 'file',
    describe: 'Rename company {id} to {name}, or bring it back from the archive',
    why: "Renames a company in the file or brings an archived one back ({ archived: false }). [id] can be ANY company in the file, not only the agent's: the route checks the access of the user id it runs as (getSessionGate) in that company, not the agent's role. So it must run as the approver, and the card should name the company.",
  },
  'DELETE /api/companies/[id]': {
    class: 'file',
    describe: 'Archive company "{confirm}" ({id})',
    why: "Archives (hides) a whole company; it can be brought back, so not a delete for good. ?confirm= must be the company's exact name or nothing happens, so the name on the card is the real one. [id] can be ANY company in the file: the route checks the access of the user id it runs as (getSessionGate) in that company, not the agent's role, so it must run as the approver.",
  },

  // ---- Practice copy (sandbox): working in one is on the hard floor ----
  'GET /api/sandbox': {
    class: 'file',
    describe: 'Show whether this is a practice copy and any copies left over',
    why: `${FILE_READ_WHY} In the real file it lists the practice copies left over on disk.`,
    dryRun: 'none',
  },
  'POST /api/sandbox': {
    class: 'file',
    describe: 'Make a practice copy of the company file and switch to it',
    availability: 'hard_floor',
    why: 'Agents never work in a practice copy (plan 4.6): a person opens such books.',
    fileAdmin: true,
    body: 'none',
    dryRun: 'none',
  },
  'GET /api/sandbox/status': { class: 'read', describe: 'Show the practice copy banner' },
  'POST /api/sandbox/discard': {
    class: 'file',
    describe: 'Leave the practice copy and delete it',
    availability: 'hard_floor',
    why: 'Agents never work in a practice copy (plan 4.6); leaving one is part of that work, and agents are refused inside one anyway.',
    fileAdmin: true,
    body: 'none',
    dryRun: 'none',
  },
  'POST /api/sandbox/keep': {
    class: 'file',
    describe: 'Leave the practice copy and keep it as a training file ({name})',
    availability: 'hard_floor',
    why: 'Agents never work in a practice copy (plan 4.6); leaving one is part of that work, and agents are refused inside one anyway.',
    fileAdmin: true,
    dryRun: 'none',
  },
  'POST /api/sandbox/leftovers/[id]': {
    class: 'file',
    describe: 'Reopen leftover practice copy {id}',
    availability: 'hard_floor',
    why: 'Reopening a practice copy switches the server into it: agents never work in a practice copy (plan 4.6).',
    fileAdmin: true,
    body: 'none',
    dryRun: 'none',
  },
  'DELETE /api/sandbox/leftovers/[id]': {
    class: 'remove',
    describe: 'Delete leftover practice copy {id}',
    why: 'Deletes a leftover copy of the whole company file from disk, for good. Done from the real file, not inside a practice copy.',
    fileAdmin: true,
    dryRun: 'none',
  },
};
