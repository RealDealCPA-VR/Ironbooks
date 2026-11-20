/**
 * Agent full access: classification of the "documents" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/documents.test.ts.
 *
 * Things that run outside the database transaction a dry run is rolled back in, and so get
 * dryRun 'none' here:
 *  - deleting a document (lib/services/attachments.ts deleteAttachment) removes its file from disk
 *    right away, so a rolled-back preview would still delete the real file;
 *  - uploading a document writes its file before the database row, so a preview would leave the
 *    file behind;
 *  - calls to an AI, a mail server or another computer (lib/ai/*, the mail transport) are made
 *    directly, not through the effects outbox yet, so a preview would really send. That includes
 *    reading a receipt: when the company has a vision model set, the picture goes to that model,
 *    which may run on another computer on the network or tailnet (lib/services/receipts.ts
 *    readWithVision). Uploading a receipt starts that reading in the background by itself.
 *
 * Where one route does two things of different risk (an action field, an opt-in flag), the entry
 * takes the stricter class until the bridge can split it per request; the "why" says so.
 */
import type { ClassificationMap } from '../types';

export const DOCUMENTS_CLASSES: ClassificationMap = {
  // attachments: the Doc Center (documents filed to records, and the inbox)
  'GET /api/attachments': { class: 'read', describe: 'List documents in the Doc Center' },
  'POST /api/attachments': {
    class: 'enter',
    describe: 'Add document {filename}',
    effects: ['file'],
    dryRun: 'none',
    why: 'Writes the file to the company data folder before the database row, so a rolled-back preview would leave the file behind.',
  },
  'GET /api/attachments/[id]': { class: 'read', describe: 'Download document {id}', output: 'file' },
  'PATCH /api/attachments/[id]': { class: 'change', describe: 'File or describe document {id}' },
  'DELETE /api/attachments/[id]': {
    class: 'remove',
    describe: 'Delete document {id} and its file',
    effects: ['file'],
    dryRun: 'none',
    why: 'The file is deleted from disk at once, outside the database transaction, so even a rolled-back preview would delete it.',
  },

  // receipts: receipt capture (inbox, reading, saving as a transaction, phone upload links)
  'GET /api/receipts': { class: 'read', describe: 'List receipts in the receipt inbox' },
  'POST /api/receipts': {
    class: 'outside',
    describe: 'Add a receipt file to the receipt inbox and read it (offline OCR or the company\'s vision model)',
    body: 'multipart',
    effects: ['file', 'network'],
    dryRun: 'none',
    why: 'The receipt itself only waits in the inbox (not in the books), but the route starts reading it in the background after the answer (app/api/receipts/_upload.ts readInBackground). With a vision model set, that sends the picture to the model, which may be on another computer on the network or tailnet, so the upload is classed by that send. The file is written to disk before the row, so a rolled-back preview cannot contain it. The background read also reuses the request\'s database handle after the answer.',
  },
  'GET /api/receipts/[id]': {
    class: 'prepare',
    describe: 'Show receipt {id} with suggestions',
    why: 'Suggesting the expense account brings the learned categorizer up to date, which saves its model (derived data, never the ledger). A read must not write at all.',
  },
  'DELETE /api/receipts/[id]': {
    class: 'remove',
    describe: 'Delete receipt {id} and its file',
    effects: ['file'],
    dryRun: 'none',
    why: 'Deletes the receipt\'s file from disk at once, outside the database transaction, so even a rolled-back preview would delete it.',
  },
  'POST /api/receipts/[id]/extract': {
    class: 'outside',
    describe: 'Read receipt {id} (offline OCR or the company\'s vision model)',
    effects: ['network'],
    dryRun: 'none',
    why: 'Stores what was read in the inbox; nothing reaches the books. PDF text and offline OCR stay on this computer, but with a vision model set the receipt picture is sent to that model (lib/services/receipts.ts readWithVision), which may be on another computer on the network or tailnet; never a cloud AI. Classed by that send until the bridge can tell the two apart; a rolled-back preview would already send.',
  },
  'POST /api/receipts/[id]/save': {
    class: 'enter',
    describe: 'Save receipt {id} as a {kind} for {total}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/receipts/settings': {
    class: 'read',
    describe: 'Show receipt reading settings',
    why: 'A read in normal running. It loads the AI settings (lib/services/aiSettings.ts loadSettings), which on a company file saved by an older version moves its saved AI keys once (a database write), and looks up *.ts.net addresses in DNS.',
  },
  'PUT /api/receipts/settings': {
    class: 'settings',
    describe: 'Change receipt reading settings',
    why: 'A company setting: which local AI model reads receipts and the date order.',
  },
  'GET /api/receipts/upload-links': { class: 'read', describe: 'List phone upload links that still work' },
  'POST /api/receipts/upload-links': {
    class: 'secret',
    describe: 'Make a phone upload link for receipts',
    body: 'none',
    producesSecret: ['capability_link'],
    sensitiveFields: ['token'],
    why: 'The answer is a link that lets anyone holding it add receipts for 15 minutes without signing in. It is shown to the approver only.',
  },
  'DELETE /api/receipts/upload-links/[id]': {
    class: 'remove',
    describe: 'Turn off phone upload link {id}',
    why: 'The method\'s default. Turning a link off only makes things safer, but it cannot be undone (a new link has to be made), so it stays "remove".',
  },
  'GET /api/receipts/mobile/[token]': {
    class: 'read',
    describe: 'Check a phone upload link',
    availability: 'person_only',
    sensitiveFields: ['token'],
    why: 'The phone page of a person who scanned the link; the link itself is the credential.',
  },
  'POST /api/receipts/mobile/[token]': {
    class: 'prepare',
    describe: 'Upload a receipt through a phone link',
    availability: 'person_only',
    body: 'multipart',
    effects: ['file', 'network'],
    dryRun: 'none',
    sensitiveFields: ['token'],
    why: 'The phone page of a person who scanned the link; the link itself is the credential. It opens its own database handle, and like the desktop upload it starts reading the receipt in the background (the company\'s vision model, when set).',
  },

  // form-templates: Layout Designer templates for printed and emailed forms
  'GET /api/form-templates': { class: 'read', describe: 'List form templates' },
  'POST /api/form-templates': {
    class: 'settings',
    describe: 'Create {formType} form template {name}',
    why: 'Form templates are company settings: they change how every form of that kind prints.',
  },
  'GET /api/form-templates/[id]': { class: 'read', describe: 'Show form template {id}' },
  'PATCH /api/form-templates/[id]': {
    class: 'settings',
    describe: 'Change form template {id}',
    why: 'Form templates are company settings: they change how every form of that kind prints.',
  },
  'DELETE /api/form-templates/[id]': {
    class: 'remove',
    describe: 'Delete form template {id}',
    effects: ['file'],
    dryRun: 'none',
    why: 'Its logo file is deleted from disk at once (unless another template uses it), so even a rolled-back preview would delete it.',
  },
  'POST /api/form-templates/[id]/logo': {
    class: 'settings',
    describe: 'Set the logo of form template {id} to {filename}',
    effects: ['file'],
    dryRun: 'none',
    why: 'Changes a form template (a company setting). Writes the new logo file and deletes the old one from disk at once, so a rolled-back preview cannot undo it.',
  },
  'DELETE /api/form-templates/[id]/logo': {
    class: 'remove',
    describe: 'Remove the logo from form template {id}',
    effects: ['file'],
    dryRun: 'none',
    why: 'The logo file is deleted from disk at once (unless another template uses it), so even a rolled-back preview would delete it.',
  },
  'POST /api/form-templates/preview': {
    class: 'read',
    describe: 'Preview a {formType} form design as a PDF',
    output: 'pdf',
    why: 'Draws a sample form as a PDF; nothing is saved.',
  },

  // letters: letters, mailing labels and envelopes (PDFs to print or save)
  'GET /api/letters/recipients': { class: 'read', describe: 'List {type} letter recipients' },
  'GET /api/letters/templates': { class: 'read', describe: 'List letter templates' },
  'POST /api/letters/templates': { class: 'enter', describe: 'Create letter template {name}' },
  'PATCH /api/letters/templates/[id]': { class: 'change', describe: 'Change letter template {id}' },
  'DELETE /api/letters/templates/[id]': { class: 'remove', describe: 'Delete letter template {id}' },
  'POST /api/letters/prepare': {
    class: 'read',
    describe: 'Prepare letters to {recipientType} recipients as a PDF',
    output: 'pdf',
    why: 'Merges the letters into one PDF; nothing is saved or printed. With preview: true the answer is the merged text as JSON instead of a PDF, so the output kind depends on the request.',
  },
  'POST /api/letters/labels': {
    class: 'read',
    describe: 'Make mailing labels for {recipientType} recipients',
    output: 'pdf',
    why: 'Makes a PDF of labels; nothing is saved or printed.',
  },
  'POST /api/letters/envelopes': {
    class: 'read',
    describe: 'Make envelopes for {recipientType} recipients',
    output: 'pdf',
    why: 'Makes a PDF of envelopes; nothing is saved or printed.',
  },

  // email: the company file's mail server (Preferences > Send Forms)
  'GET /api/email/settings': {
    class: 'read',
    describe: 'Show the mail server set-up',
    why: 'A read in normal running. On a company file saved by an older version, the first load moves the saved mail password to this computer\'s own secret once (lib/services/emailSettings.ts storedRow, migrateStoredSecrets): a database write.',
  },
  'PUT /api/email/settings': {
    class: 'settings',
    describe: 'Set the mail server to {host}',
    hostOnly: true,
    needsSecret: ['mail_password'],
    sensitiveFields: ['password'],
    why: 'A company setting, changed only at the computer that holds the company file. The mail password is typed by the approver, never sent by the agent; the route reads it from the body field "password", so that is where the bridge puts it.',
  },
  'DELETE /api/email/settings': {
    class: 'settings',
    describe: 'Remove the mail server set-up',
    hostOnly: true,
    why: 'Removes a company setting (not a record), only at the computer that holds the company file. The saved mail password is lost with it.',
  },
  'GET /api/email/status': {
    class: 'read',
    describe: 'Check whether email is set up',
    why: 'A read in normal running. On a company file saved by an older version, the first load moves the saved mail password to this computer\'s own secret once (lib/services/emailSettings.ts storedRow): a database write.',
  },
  'POST /api/email/test': {
    class: 'outside',
    describe: 'Send a test email to {to}',
    effects: ['email'],
    hostOnly: true,
    dryRun: 'none',
    needsSecret: ['mail_password'],
    sensitiveFields: ['draft.password'],
    why: 'Sends a real email through the mail server. Only testing typed (unsaved) settings in "draft" is host-only; the saved settings can be tested from anywhere, and that test remembers its result. A typed password is typed by the approver and goes in the body field "draft.password".',
  },

  // ai: the app's own AI features (assistant, suggestions, auto-posting) and AI settings
  'POST /api/ai/assistant': {
    class: 'outside',
    describe: 'Ask the AI assistant: {message}',
    effects: ['network'],
    dryRun: 'none',
    why: 'Sends the question, and the report figures the assistant reads, to the company\'s AI (a cloud AI when the company allows it). It may also save proposed entries for approval. The answer is JSON, but with ?stream=1 it is a stream of JSON lines (application/x-ndjson), so the output kind depends on the request.',
  },
  'GET /api/ai/bank-suggestions': {
    class: 'prepare',
    describe: 'Suggest accounts for the bank feed lines of {bankAccountId}',
    why: 'Brings the learned categorizer up to date first, which saves its model (derived data, never the ledger). A read must not write at all.',
  },
  'POST /api/ai/bank-suggestions': {
    class: 'outside',
    describe: 'Bank feed AI: {action} (auto-apply posts every feed line of account {bankAccountId} the learned model is sure of; llm sends feed line {bankTransactionId} to the AI)',
    effects: ['network'],
    dryRun: 'none',
    why: 'One route, two actions. Action "llm" sends one bank line to the company\'s AI (a cloud AI when allowed) and posts nothing. Action "auto-apply" sends nothing out but posts a journal entry for every feed line at or above the company threshold (lib/services/aiCategorizer.ts autoApplyBankSuggestions): really bulk, dry run "transaction", count = lines posted. Classed "outside" (never Allow, at most a short grant) until the bridge splits it by action; no preview, because a preview of "llm" would already send.',
  },
  'GET /api/ai/categorizer': { class: 'read', describe: 'Show the learned categorizer status' },
  'POST /api/ai/categorizer': {
    class: 'prepare',
    describe: 'Retrain the learned categorizer',
    why: 'Rebuilds the learned model from the books (derived data); nothing in the ledger changes.',
  },
  'GET /api/ai/chatgpt': {
    class: 'read',
    describe: 'Check a ChatGPT sign-in',
    availability: 'person_only',
    why: 'Part of "Continue with ChatGPT": the person signs in to their own ChatGPT plan in their own browser.',
  },
  'POST /api/ai/chatgpt': {
    class: 'outside',
    describe: 'ChatGPT sign-in: {action}',
    availability: 'person_only',
    effects: ['network'],
    dryRun: 'none',
    why: 'Starts, cancels or disconnects the person\'s own ChatGPT sign-in; it talks to OpenAI and turns cloud AI on for the company.',
  },
  'GET /api/ai/posts': { class: 'read', describe: 'List what the AI posted' },
  'POST /api/ai/posts': {
    class: 'change',
    describe: 'Undo AI post {id}',
    why: 'Undo is Bank Review\'s Unmatch: it voids the entry the AI posted.',
  },
  'GET /api/ai/prefill': {
    class: 'outside',
    describe: 'Suggest accounts for a vendor or payee',
    effects: ['network'],
    dryRun: 'none',
    why: 'With ai=1 it sends the payee name to the company\'s AI (and to its vendor lookup, when on). Without it, it still saves the learned model while suggesting, so it is never a pure read.',
  },
  'GET /api/ai/proposals': { class: 'read', describe: 'List AI and agent proposals' },
  'POST /api/ai/proposals/[id]': {
    class: 'change',
    describe: 'Approve or reject proposal {id}',
    availability: 'hard_floor',
    why: 'Approving or rejecting proposals is how a person decides what the AI assistant and agents asked for (agent proposals live here too). An agent approving its own requests would defeat the approval.',
  },
  'POST /api/ai/pull': {
    class: 'outside',
    describe: 'Download AI model {model} into Ollama',
    effects: ['network'],
    hostOnly: true,
    dryRun: 'none',
    why: 'Downloads a model from the internet onto the computer that holds the company file.',
  },
  'GET /api/ai/recurring': { class: 'read', describe: 'List suggested recurring bills and expenses' },
  'POST /api/ai/recurring': {
    class: 'enter',
    describe: 'Memorize {docType} {sourceDocId} as recurring {frequency}',
    alwaysAsk: true,
  },
  'GET /api/ai/settings': {
    class: 'read',
    describe: 'Show AI settings',
    why: 'A read in normal running. lib/services/aiSettings.ts loadSettings moves saved AI keys once on a company file saved by an older version (a database write) and looks up *.ts.net addresses in DNS.',
  },
  'PUT /api/ai/settings': {
    class: 'settings',
    describe: 'Change AI settings',
    hostOnly: true,
    sensitiveFields: ['providers.*.apiKey'],
    why: 'Company AI settings. Adding an AI, changing its address or turning cloud AI on is refused away from the computer that holds the company file; turning cloud AI on also changes Privacy & Network. providers[].apiKey is a typed secret, but there is no secret kind for an AI key yet, so it is only masked here: an agent should not be the one sending it.',
  },
  'GET /api/ai/tailnet': {
    class: 'outside',
    describe: 'List AI servers on this computer\'s tailnet',
    effects: ['network'],
    hostOnly: true,
    dryRun: 'none',
    why: 'Runs the Tailscale program to list the other computers on the tailnet; it reads nothing from the books.',
  },
  'POST /api/ai/test': {
    class: 'settings',
    describe: 'Test AI server {baseUrl} ({kind}); allow cloud AI: {allowCloud}',
    effects: ['network'],
    hostOnly: true,
    dryRun: 'none',
    sensitiveFields: ['apiKey'],
    why: 'Connects to the AI server address in the body (a send outside). With allowCloud: true it also turns cloud AI on in Privacy & Network and keeps that when the test succeeds (lib/services/aiSettings.ts testConnection, allowCloudPurpose), and the route stamps the company file as approved on this computer (approveQuietFileHere). Those are lasting setting changes, so it is "settings" (asked every time, never a standing grant) rather than "outside".',
  },

  // errors: possible bookkeeping errors (scan, AI analysis, correcting entries)
  'GET /api/errors': { class: 'read', describe: 'List possible bookkeeping errors found' },
  'POST /api/errors': {
    class: 'prepare',
    describe: 'Scan the books for possible errors',
    body: 'none',
    why: 'Saves the new findings to the list of possible errors; nothing in the books changes.',
  },
  'POST /api/errors/[id]/analyze': {
    class: 'outside',
    describe: 'Ask the AI about possible error {id}',
    body: 'none',
    effects: ['network'],
    dryRun: 'none',
    why: 'Sends the flagged entry to the company\'s AI (a cloud AI when allowed) and saves its suggestion.',
  },
  'POST /api/errors/[id]/apply': {
    class: 'change',
    describe: 'Post the correcting entry for possible error {id} (correction {correctionId})',
    why: 'Posts the correcting journal entry and marks the error fixed: a correction of entries already in the books. With approved: true, a body "entry" replaces the AI\'s suggested entry, so what posts can be an entry the caller wrote; the ledger preview shows the real one.',
  },

  // command-bar: the Ctrl+K plain-English command bar
  'POST /api/command-bar': {
    class: 'outside',
    describe: 'Run command bar text: {text}',
    effects: ['network'],
    dryRun: 'none',
    why: 'With allowAi it sends the typed text to the company\'s AI. Without it, it only reads and answers (a pure read); it never saves anything. Classed by the stricter case until the bridge can split it on allowAi.',
  },

  // import: bank file import, statement reading, QuickBooks list import, Rebuild Data
  'POST /api/import': {
    class: 'bulk',
    describe: 'Import bank lines ({fileType}) into the feed of {bankAccountId}',
    countField: 'rows',
    confirmFlags: ['statement.acknowledgeDifference'],
    why: 'Stages every line of the file in the bank feed, and when AI auto-apply is on (the default for new companies) also posts each line the learned model is sure of. countField counts reviewed statement rows (fileType "rows"); for an OFX, QBO or CSV file the number of lines is known only after reading it. The confirm flag is the nested field statement.acknowledgeDifference, and a statement that does not tie out answers 400 VALIDATION with details.tieOut, not a 409 warning; it is listed so a request that sends it counts as confirmed and cannot ride on a standing grant.',
  },
  'POST /api/import/csv-preview': {
    class: 'read',
    describe: 'Preview a CSV column mapping',
    why: 'Reads the CSV text it is sent with the mapping and returns the first rows; nothing is saved.',
  },
  'POST /api/import/extract': {
    class: 'outside',
    describe: 'Read bank statement file {filename}',
    effects: ['network'],
    dryRun: 'none',
    why: 'When the layout reader cannot tie out a PDF or picture statement, the statement text is sent to the company\'s AI (a cloud AI when allowed). Nothing is imported or saved.',
  },
  'POST /api/import/statement-assist': {
    class: 'outside',
    describe: 'Ask the AI to fix a bank statement reading',
    effects: ['network'],
    dryRun: 'none',
    why: 'Sends the statement text and rows to the company\'s AI (a cloud AI when allowed). Nothing is imported or saved.',
  },
  'POST /api/import/qb': {
    class: 'file',
    describe: 'Import QuickBooks {format} data',
    why: 'QuickBooks import into the books: lists, opening balances and transactions, many records at once. Owner or Admin only, with nobody else working in the company.',
  },
  'GET /api/import/rebuild': { class: 'read', describe: 'Preview Rebuild Data {action}' },
  'POST /api/import/rebuild': {
    class: 'file',
    describe: 'Run Rebuild Data {action}',
    why: 'A file utility (Rebuild Data) that rewrites saved balances across the books; Owner or Admin only, with nobody else working in the company. GET /api/import/rebuild is its preview. The action "orphaned_audit_refs" deletes audit trail rows, which is on the hard floor: the bridge must refuse that action for agents.',
  },

  // qb-import: QuickBooks conversion (lists, general ledger history, open invoices and bills)
  'POST /api/qb-import': {
    class: 'file',
    describe: 'Import QuickBooks {format} lists',
    why: 'QuickBooks import into the books (IIF or customer and vendor CSV), many records at once. Owner or Admin only, with nobody else working in the company.',
  },
  'GET /api/qb-import/gl': { class: 'read', describe: 'List past QuickBooks general ledger imports' },
  'POST /api/qb-import/gl': {
    class: 'file',
    describe: 'QuickBooks general ledger import: {action}',
    dryRun: 'preview',
    confirmFlags: ['acceptVariance', 'acceptExistingEntries'],
    why: 'Brings years of QuickBooks history into the books. Its own "preview" and "dry-run" actions show what an import would do; the accept flags answer its warnings (the warning comes back as ok: false, not a 409).',
  },
  'GET /api/qb-import/open-items': { class: 'read', describe: 'Compare A/R and A/P with their aging' },
  'POST /api/qb-import/open-items': {
    class: 'file',
    describe: 'QuickBooks open invoices and bills: {action}',
    dryRun: 'preview',
    why: 'QuickBooks cutover: action "import" creates the open invoices, credit memos, bills and vendor credits. Action "preview" is its own preview and saves nothing.',
  },

  // product-info: the Product Information window
  'GET /api/product-info': { class: 'read', describe: 'Show product and company file information' },
};
