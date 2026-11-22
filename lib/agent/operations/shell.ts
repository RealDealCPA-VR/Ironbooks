/**
 * Agent full access: the operations that are not API routes (plan §5.5 and §5.7): what the desktop
 * shell carries out (new, open, switch company, Save Copy As, restore, sandbox, hosting, updates,
 * printing), and what the server does itself (saving a staged file to a folder).
 * The registry merges these in as operations of kind 'shell'.
 *
 * How an 'electron' one runs (electron/agentShell.js): a person approves it in their own window,
 * the server sends it to the desktop shell with a one-time approval ticket (lib/agent/shellTicket.ts),
 * and the shell runs the same flow the File menu runs. Every native dialog the flow would show takes
 * its answer from the request instead of opening:
 *  - a file picker: the path fields of the input (checked against the folders agents may use: the
 *    open company file's folder, Documents\Ironbooks and its Agent Outbox, and what the Admin added);
 *  - a question: the approver's answer on the card to the matching entry of `questions` (yes_no: true
 *    or false; choice: one of `choices`, the window's own button words);
 *  - a password prompt: what the approver typed for `needsSecret`, never anything from the agent.
 * A question asked without an answer stops the flow the way Cancel would, and the request fails
 * with a message naming the question. Nothing ever waits on screen.
 *
 * The question ids and choices here must match the shell's own list (electron/agentShell.js
 * QUESTIONS), and the input fields its OPERATIONS table: test/agentShell.test.ts holds them together.
 */
import type { FlowQuestion, ShellOperationDef } from '../contract';

// ---- The flows' questions, worded as the card should ask them ----

/** confirmCompanyFileLocation: the file is in a temporary folder (an email attachment, a download). */
const TEMPORARY_FOLDER: FlowQuestion = {
  id: 'temporaryFolder',
  text:
    'If the company file turns out to be in a temporary folder (opened from an email or a download), work saved there can ' +
    'disappear when the folder is cleaned up. Save a copy in Documents and work on that, open it there anyway, or stop?',
  kind: 'choice',
  choices: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'],
};

/** confirmCompanyFileLocation: the file is read-only, so Ironbooks cannot save into it. */
const READ_ONLY_FILE: FlowQuestion = {
  id: 'readOnlyFile',
  text: 'If the company file turns out to be read-only, Ironbooks cannot work in it. Save a copy in Documents and work on that, or stop?',
  kind: 'choice',
  choices: ['Save a Copy and Open It', 'Cancel'],
};

/** confirmCompanyFileLocation: a OneDrive, Dropbox or other cloud-sync folder (asked once per file). */
const CLOUD_FOLDER: FlowQuestion = {
  id: 'cloudFolder',
  text:
    'If the company file is in a cloud-sync folder (OneDrive, Dropbox and the like): that is fine when only this computer opens it, ' +
    'but two computers opening it at once can end up with different changes. Open it anyway?',
  kind: 'yes_no',
};

/** After a restore: open the new company file now (Ironbooks restarts into it) or later. */
const OPEN_NOW: FlowQuestion = {
  id: 'openNow',
  text: 'Once it is ready, open the new company file now? Ironbooks then saves and closes the open company file and restarts into the new one.',
  kind: 'yes_no',
};

/** closeCompanyFlow while multi-user access is on. */
const CLOSE_WHILE_HOSTING: FlowQuestion = {
  id: 'closeWhileHosting',
  text: 'If multi-user access is on, teammates who have this company file open are disconnected. Close it anyway?',
  kind: 'yes_no',
};

/** switchToSingleUserFlow while other computers are working in the file. */
const DISCONNECT_OTHERS: FlowQuestion = {
  id: 'disconnectOthers',
  text:
    'If other computers have used this company file in the last few minutes, they are disconnected and anything they have not ' +
    'saved is lost. Switch to single-user mode anyway?',
  kind: 'yes_no',
};

/** Restarting to install an update while a form in the window has typed work. */
const CLOSE_OVER_UNSAVED_FORM: FlowQuestion = {
  id: 'closeOverUnsavedForm',
  text: 'If a form in the Ironbooks window has changes that are not recorded yet, restarting loses them. Restart anyway?',
  kind: 'yes_no',
};

const LOCATION_QUESTIONS = [TEMPORARY_FOLDER, READ_ONLY_FILE, CLOUD_FOLDER];

/** Every desktop-shell operation is approved at the host computer's own window, where it happens. */
const SHELL = { runner: 'electron', area: null, hostOnly: true } as const;

const COMPANY_FILE_PATH = 'The full path of a company file (it ends in .ironbooks).';
const RESTART_NOTE =
  'Ironbooks saves and closes the open company file and restarts, so your connection ends: connect again in a minute. ' +
  'A person must sign in again unless you may work unattended in that file.';

export const SHELL_OPERATIONS: readonly ShellOperationDef[] = [
  {
    ...SHELL,
    id: 'shell.company.new',
    flow: 'createCompanyFlow',
    class: 'file',
    describe: 'Create a new, empty company file at {file} and switch to it',
    why:
      `File > New Company. Creates an empty company file where you say (never over an existing file), then ${RESTART_NOTE} ` +
      'The new file opens on its Admin set-up, which a person completes: it holds the Admin user name and password.',
    input: { file: { type: 'path', required: true, describe: `Where the new company file goes. ${COMPANY_FILE_PATH}` } },
    questions: [TEMPORARY_FOLDER, CLOUD_FOLDER],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.company.open',
    flow: 'openCompanyFlow',
    class: 'file',
    describe: 'Open company file {file}',
    why:
      `File > Open or Restore Company, for a company file (.ironbooks). Backups, portable files and Accountant's Copies have ` +
      `their own operations. ${RESTART_NOTE}`,
    input: { file: { type: 'path', required: true, describe: COMPANY_FILE_PATH } },
    questions: LOCATION_QUESTIONS,
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.company.switch',
    flow: 'openCompany',
    class: 'file',
    describe: 'Switch to company file {file}',
    why: `File > Recent Companies: only a company file on that list. ${RESTART_NOTE}`,
    input: { file: { type: 'path', required: true, describe: `A company file from Recent Companies. ${COMPANY_FILE_PATH}` } },
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.company.close',
    flow: 'closeCompanyFlow',
    class: 'file',
    describe: 'Close the company file',
    why:
      'File > Close Company: saves the company file, releases it and restarts on "No Company Open". Your connection ends and ' +
      'cannot come back by itself: no company file is open until a person opens one.',
    input: {},
    questions: [CLOSE_WHILE_HOSTING],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.company.saveCopyAs',
    flow: 'saveCopyAsFlow',
    class: 'file',
    describe: 'Save a copy of the company file as {file}',
    why:
      'File > Save Copy As: a separate company file holding every company and every user of this one, nothing masked. ' +
      'Never saved over an existing file. Not available in a practice copy.',
    input: { file: { type: 'path', required: true, describe: `Where the copy goes. ${COMPANY_FILE_PATH}` } },
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: false,
  },
  {
    ...SHELL,
    id: 'shell.portable.open',
    flow: 'openPortableFlow',
    class: 'file',
    describe: 'Restore portable company file {file} as a new company file {target}',
    why:
      'File > Open or Restore Company with a portable file (.bkp): restored, checked and saved as a new company file; the open ' +
      'company file is not touched. A portable file saved with a password needs it, typed by the approver. If the approver ' +
      `chooses to open it now: ${RESTART_NOTE}`,
    input: {
      file: { type: 'path', required: true, describe: 'The portable company file (.bkp).' },
      target: { type: 'path', required: true, describe: `Where the new company file goes. ${COMPANY_FILE_PATH}` },
    },
    questions: [OPEN_NOW],
    needsSecret: ['backup_password'],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.accountantCopy.open',
    flow: 'openAccountantCopyFlow',
    class: 'file',
    describe: "Open Accountant's Copy {file} as a new company file {target}",
    why:
      "Accountant > Open Accountant's Copy with a transfer file (.ibac): restored, checked and saved as a new company file to " +
      "work in; the open company file is not touched. A transfer file saved with a password needs it, typed by the approver. " +
      `If the approver chooses to open it now: ${RESTART_NOTE}`,
    input: {
      file: { type: 'path', required: true, describe: "The Accountant's Copy transfer file (.ibac)." },
      target: { type: 'path', required: true, describe: `Where the new company file goes. ${COMPANY_FILE_PATH}` },
    },
    questions: [OPEN_NOW],
    needsSecret: ['backup_password'],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.backup.restoreAsNew',
    flow: 'restoreBackupAsNewFileFlow',
    class: 'file',
    describe: 'Restore backup {file} as a new company file {target}',
    why:
      'File > Open or Restore Company with a backup (.bka), as a new company file: the open company file is not touched (restoring ' +
      'INTO it is the Back Up and Restore page). A backup protected with passwords becomes a protected company file without ' +
      `being opened here. If the approver chooses to open it now: ${RESTART_NOTE}`,
    input: {
      file: { type: 'path', required: true, describe: 'The backup file (.bka).' },
      target: { type: 'path', required: true, describe: `Where the new company file goes. ${COMPANY_FILE_PATH}` },
    },
    questions: [OPEN_NOW, ...LOCATION_QUESTIONS],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.sandbox.enter',
    flow: 'sandboxStart',
    class: 'file',
    describe: 'Make a practice copy of the company file and switch to it',
    why:
      'File > Try It on a Copy, for a PERSON to practise in: the window makes the copy with the approver\'s own sign-in and ' +
      'Ironbooks restarts into it. Your connection ends there, and you cannot work in the practice copy at all: agents are ' +
      'refused inside one (plan 4.6). You can work again once a person has left it.',
    input: {},
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.sandbox.leave',
    flow: 'sandboxLeave',
    class: 'file',
    describe: 'Leave the practice copy',
    why:
      'Only opens the Leave the Sandbox page for the person at the window, who chooses to discard the copy or keep it as a ' +
      'training file; nothing is left or deleted by this request itself, and Ironbooks restarts only once that person leaves. ' +
      'Agents are refused inside a practice copy (plan 4.6), so in practice this cannot be asked from one.',
    input: {},
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    // The request itself only opens a page; the restart, if any, is the person's.
    restarts: false,
  },
  {
    ...SHELL,
    id: 'shell.hosting.start',
    flow: 'switchToMultiUserFlow',
    class: 'file',
    describe: 'Turn on multi-user access ({network})',
    why:
      'File > Switch to Multi-user Mode ("office": every computer on this office network can open the company file from the ' +
      'shared drive) or File > Host multi-user access ("tailnet": computers on your Tailscale network). Each person still signs ' +
      'in with their own user name. Not in a practice copy.',
    input: { network: { type: 'string', required: true, describe: '"office" (this office network) or "tailnet" (Tailscale).' } },
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: false,
  },
  {
    ...SHELL,
    id: 'shell.hosting.stop',
    flow: 'switchToSingleUserFlow',
    class: 'file',
    describe: 'Turn off multi-user access',
    why: 'File > Switch to Single-user Mode: other computers can no longer come in without asking.',
    input: {},
    questions: [DISCONNECT_OTHERS],
    needsSecret: [],
    fileAdmin: true,
    restarts: false,
  },
  {
    ...SHELL,
    id: 'shell.hosting.connect',
    flow: 'openOnHostFlow',
    class: 'file',
    describe: 'Open the company file hosted at {host}',
    why:
      'File > Open company on host. What joining really does: Ironbooks saves and closes the company file open on this computer, ' +
      'restarts, and from then on the Ironbooks window shows the pages the program at that address serves instead of its own, ' +
      'and people sign in there with their user names and passwords. So approve only the address of another computer you know ' +
      'hosts your company file (its Company > Multi-user page shows it). Ironbooks contacts the address first to check it ' +
      "answers, and refuses this computer's own addresses and names and the virtual machines or containers it runs (such as WSL " +
      'or Docker). Your connection ends with the restart, and this computer ' +
      'then has no books of its own open: agents connect to the host computer instead.',
    input: {
      host: {
        type: 'string',
        required: true,
        describe: "Another computer's address, as its Company > Multi-user page shows it (this office network or Tailscale); never this computer's own.",
      },
    },
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.hosting.disconnect',
    flow: 'disconnectFromHost',
    class: 'file',
    describe: "Disconnect from the host and reopen this computer's company file",
    why:
      'File > Disconnect, on a computer that is a client of another computer\'s company file. Such a computer has no books of ' +
      `its own open, so an agent rarely reaches it. ${RESTART_NOTE}`,
    input: {},
    questions: [],
    needsSecret: [],
    fileAdmin: true,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.update.install',
    flow: 'installUpdate',
    class: 'outside',
    describe: 'Install the Ironbooks update',
    why:
      'Help > Check for Updates. With an update downloaded: Ironbooks saves the company file, installs it and restarts (your ' +
      'connection ends; connect again in a few minutes). With one found but not downloaded yet: starts the download from the ' +
      "release feed (the company's Privacy & Network settings must allow it); ask again once it is ready. Not from a practice copy.",
    input: {},
    questions: [CLOSE_OVER_UNSAVED_FORM],
    needsSecret: [],
    fileAdmin: false,
    restarts: true,
  },
  {
    ...SHELL,
    id: 'shell.ollama.install',
    flow: 'installOllamaFlow',
    class: 'outside',
    describe: 'Download and install Ollama, the free AI that runs on this computer',
    why:
      "AI & Automation > Set up free AI: downloads Ollama's own installer from ollama.com (about 1 GB), checks it is signed by " +
      "Ollama and starts it (elsewhere than Windows: opens the download page). The company's Privacy & Network settings must " +
      'allow downloads. The download goes on after the answer; the AI & Automation page shows how far it is.',
    input: {},
    questions: [],
    needsSecret: [],
    fileAdmin: false,
    restarts: false,
  },
  {
    ...SHELL,
    id: 'shell.print.file',
    flow: 'printPdf',
    class: 'print',
    describe: 'Print file {fileId} on a printer',
    why:
      'Prints a staged PDF (a report, a form, checks) on this computer\'s default printer or the one named, without a print ' +
      'dialog (D10). For checks, the approver confirms afterwards whether they printed correctly.',
    input: {
      fileId: { type: 'fileId', required: true, describe: 'The PDF to print.' },
      printer: { type: 'string', required: false, describe: "The printer's name as this computer lists it; leave out for the default printer." },
      copies: { type: 'number', required: false, describe: 'How many copies, 1 to 100 (1 when left out).' },
    },
    questions: [],
    needsSecret: [],
    fileAdmin: false,
    restarts: false,
  },
  {
    id: 'files.save',
    runner: 'server',
    flow: 'saveStagedFile',
    class: 'file',
    area: null,
    describe: 'Save file {fileId} in {folder}',
    why:
      'Writes one of your staged files (an upload, or a PDF or download an operation gave you) into a folder on this computer: ' +
      "the open company file's folder, Documents\\Ironbooks and its Agent Outbox, or a folder the Admin added for you. Never " +
      'over a file that is already there.',
    input: {
      fileId: { type: 'fileId', required: true, describe: 'The staged file to save.' },
      folder: { type: 'path', required: true, describe: 'The folder it goes in; it must already exist.' },
      name: { type: 'string', required: false, describe: "The file's name in that folder (the staged file's own name when left out)." },
    },
    questions: [],
    needsSecret: [],
    hostOnly: true,
    fileAdmin: false,
    restarts: false,
  },
];
