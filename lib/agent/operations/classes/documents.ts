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
 *
 * The cross-bucket rule for lookups (the same in company.ts for GET /api/network-policy): a GET that
 * can look up a *.ts.net address in DNS or refresh the tailnet trust is 'outside', not 'read', even
 * when that lookup is its only side effect and it happens only when such an address is set up. A
 * name lookup leaves this computer and the trust it refreshes steers later outbound checks. Loading
 * the AI settings (lib/services/aiSettings.ts loadSettings) does that lookup for every *.ts.net AI
 * server, so every GET that loads them is 'outside' with no dry run (a rolled-back preview would
 * still look the names up). A GET with another, lighter side effect too takes the stricter class.
 * The settings PUTs that look names up while saving keep their class ('settings') but have no dry
 * run either, for the same reason: saving the AI settings and the receipt settings loads the AI
 * settings before and after, and saving the mail server checks whether its name is on this
 * network. The approval card then shows the request itself instead of a before-and-after preview.
 *
 * A GET classed above 'read' (a document download, a File Utilities read, one that saves derived
 * data) is dryRun 'none' too: a dry run hands the route's answer back to the agent
 * (lib/agent/operate.ts tryOnly), and for a read that answer is what a person is asked about.
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post" or a word that misleads, with a short verb: POST /api/errors scans (errors.scan), it does
 * not create an error; a door whose body names the action runs it (ai.bank-suggestions.run).
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
  'GET /api/attachments/[id]': {
    class: 'read_sensitive',
    describe: 'Download document {id}',
    why: "The file exactly as it was filed: a scanned W-9, W-4 or I-9 shows a full SSN or tax ID, a bank statement or a voided check full account numbers, and masking cannot hide anything inside a picture or a PDF. So it is protected data, asked for one at a time. reveal names SSNs and sensitiveFields names account numbers (no field of the answer is masked: they are there so whoever approves holds both View flags, as the file may show either). Described only, never dry run: a dry run would hand the agent the file before anyone approved it.",
    output: 'file',
    reveal: 'ssn',
    sensitiveFields: ['accountNumber'],
    dryRun: 'none',
  },
  'PATCH /api/attachments/[id]': { class: 'change', describe: 'File or describe document {id}' },
  'DELETE /api/attachments/[id]': {
    class: 'remove',
    describe: 'Delete document {id} and its file',
    effects: ['file'],
    dryRun: 'none',
    why: 'The file is deleted from disk at once, outside the database transaction, so even a rolled-back preview would delete it.',
  },

  // receipts: receipt capture (inbox, reading, saving as a transaction, phone upload links)
  'GET /api/receipts': {
    class: 'read',
    describe: 'List receipts in the receipt inbox',
    sensitiveFields: ['receipts.*.rawText'],
    why: "Everyday agent work, so a plain read. The list never carries the text read off each file (rawText is null in every row, lib/services/receipts.ts listReceipts): up to 20,000 characters of every file's text in one answer is what a W-9 or a bank statement dropped into the inbox through a phone upload link would leak. So no reveal is offered here: there is nothing to reveal. An agent that needs one receipt's text reads it with GET /api/receipts/[id] (receipts.get) and reveal: true, which a person approves. sensitiveFields stays as a backstop: should the list ever carry the text again, the door hides it in every answer that goes through it.",
  },
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
    why: 'Suggesting the expense account brings the learned categorizer up to date, which saves its model (derived data, never the ledger). A read must not write at all. Described only, never dry run: a dry run would hand the agent the receipt before anyone approved it, where the policy asks. The answer carries rawText, up to 20,000 characters of the text read off the file, and a phone upload link takes any file: a W-9 or a bank statement dropped into the inbox shows its numbers there, which masking by field name never reaches. So rawText is hidden in every answer to an agent (the receipts service gives an agent no text, lib/services/receipts.ts receiptTextFor, and the door hides the field too); vendor, date, amounts and the card\'s last 4 still show. An agent that needs the text asks again with reveal: true: that always asks a person, one request at a time, and whoever approves must hold "View sensitive payroll data", as the text can hold a full SSN or EIN. The approved answer shows the text as that person would see it in Ironbooks: SSNs and EINs in full, account numbers after a label ("Acct #", "Account Number:") still masked. A number with no label (a statement line such as "Checking 000123456789") is not caught by that masking, so it shows to the agent, though the approver is not asked to hold "View full bank / account numbers" (a reveal names one kind). The agent still sees no more than that approver sees of the same receipt in Ironbooks.',
    dryRun: 'none',
    sensitiveFields: ['receipt.rawText'],
    reveal: 'ssn',
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
    describe: 'Save receipt {id} as a transaction ({kind}) for {total}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/receipts/settings': {
    class: 'outside',
    describe: 'Show receipt reading settings (looks up any *.ts.net AI server address in DNS)',
    why: 'Not a pure read. It loads the AI settings (lib/services/aiSettings.ts loadSettings), which looks up every *.ts.net AI server address in DNS and refreshes the tailnet trust later outbound checks rely on: the same rule as GET /api/network-policy, so it is "outside". On a company file saved by an older version it also moves the saved AI keys once (a database write). A rolled-back preview would still make the lookups, so there is no dry run.',
    effects: ['network'],
    dryRun: 'none',
  },
  'PUT /api/receipts/settings': {
    class: 'settings',
    describe: 'Change receipt reading settings',
    why: 'A company setting: which local AI model reads receipts and the date order. No dry run: saving loads the AI settings (lib/services/receipts.ts setReceiptSettings calls loadSettings), which looks up every *.ts.net AI server address in DNS and refreshes the tailnet trust, and a rolled-back preview would still make those lookups (the rule in this file\'s header).',
    dryRun: 'none',
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
    describe: 'Prepare letters to the recipients as a PDF ({recipientType})',
    output: 'pdf',
    why: 'Merges the letters into one PDF; nothing is saved or printed. With preview: true the answer is the merged text as JSON instead of a PDF, so the output kind depends on the request.',
  },
  'POST /api/letters/labels': {
    class: 'read',
    describe: 'Make mailing labels for the recipients ({recipientType})',
    output: 'pdf',
    why: 'Makes a PDF of labels; nothing is saved or printed.',
  },
  'POST /api/letters/envelopes': {
    class: 'read',
    describe: 'Make envelopes for the recipients ({recipientType})',
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
    why: 'A company setting, changed only at the computer that holds the company file. The mail password is typed by the approver, never sent by the agent; the route reads it from the body field "password", so that is where the bridge puts it. No dry run: for a server that signs in without encryption, the service looks the server\'s name up in DNS before saving, to check that it is on this network (lib/services/emailSettings.ts assertPlainMailAllowed, mailServerIsLocal), and a rolled-back preview would still make that lookup (the rule in this file\'s header).',
    dryRun: 'none',
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
    // The server the typed password is sent to is on the line itself: the agent writes the draft,
    // so without it a test against the agent's own server would collect the approver's password.
    describe: 'Send a test email to {to} through {draft.host}',
    effects: ['email'],
    hostOnly: true,
    dryRun: 'none',
    needsSecret: ['mail_password'],
    sensitiveFields: ['draft.password'],
    why: 'Sends a real email through the mail server. Only testing typed (unsaved) settings in "draft" is host-only; the saved settings can be tested from anywhere, and that test remembers its result. A typed password is typed by the approver and goes in the body field "draft.password", and the test connects to draft.host with it: the line names that server, so the approver sees where the password goes (with no draft, the saved set-up is tested and no typed password is used).',
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
    class: 'outside',
    describe: 'Suggest accounts for the bank feed lines of {bankAccountId} from the learned model (looks up any *.ts.net AI server address in DNS)',
    why: 'Sends no bank line anywhere: the suggestions come from the learned model on this computer. But it loads the AI settings (lib/services/aiSettings.ts loadSettings), which looks up every *.ts.net AI server address in DNS and refreshes the tailnet trust, so by the rule in this file\'s header it is "outside" (stricter than the "prepare" its other write would need: it brings the learned categorizer up to date first, which saves its model, derived data, never the ledger). A rolled-back preview would still make the lookups, so there is no dry run.',
    effects: ['network'],
    dryRun: 'none',
  },
  'POST /api/ai/bank-suggestions': {
    class: 'outside',
    id: 'ai.bank-suggestions.run',
    describe:
      'Run bank feed AI action {action} (account: {bankAccountId}) (feed line: {bankTransactionId}); auto-apply posts every line the learned model is sure of, llm sends one line to the AI',
    effects: ['network'],
    dryRun: 'none',
    why: 'One route, two actions. Action "llm" sends one bank line to the company\'s AI (a cloud AI when allowed) and posts nothing. Action "auto-apply" sends nothing out but posts a journal entry for every feed line at or above the company threshold (lib/services/aiCategorizer.ts autoApplyBankSuggestions): really bulk, dry run "transaction", count = lines posted. Classed "outside" (never Allow, at most a short grant) until the bridge splits it by action; no preview, because a preview of "llm" would already send.',
  },
  'GET /api/ai/categorizer': { class: 'read', describe: 'Show the learned categorizer status' },
  'POST /api/ai/categorizer': {
    class: 'prepare',
    id: 'ai.categorizer.retrain',
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
    id: 'ai.chatgpt.sign-in',
    describe: 'Start, cancel or disconnect the ChatGPT sign-in ({action})',
    availability: 'person_only',
    effects: ['network'],
    dryRun: 'none',
    why: 'Starts, cancels or disconnects the person\'s own ChatGPT sign-in; it talks to OpenAI and turns cloud AI on for the company.',
  },
  'GET /api/ai/posts': { class: 'read', describe: 'List what the AI posted' },
  'POST /api/ai/posts': {
    class: 'change',
    id: 'ai.posts.undo',
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
    why: "Approving or rejecting what the app's own AI assistant proposed is a person's decision, in their own window; an agent that could approve would defeat the approval. What an agent asks for is not decided here: it is approved or denied in Agent requests (app/agent-requests), and this route refuses to approve or reject an agent's proposal (lib/services/aiAssistant.ts refuseIfAgentProposal). The only exception is a leftover agent proposal with no request, which a person can decline to clear it; that enters nothing.",
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
    id: 'ai.recurring.memorize',
    // autoEnter shows as "yes" or "no" in its own aside; left out, the aside goes and the template
    // only reminds (the default), so the line never reads as if it would post on its own.
    describe:
      'Memorize {docType} {sourceDocId} as a recurring transaction ({frequency}, from {nextRunDate}) (enters itself with nobody reviewing it: {autoEnter})',
    why: 'Makes a memorized transaction (lib/services/aiRecurring.ts memorizeSuggestion). With autoEnter: true it is set to post on its own schedule, standing automation like a bank rule set to "Add automatically", so making one always asks; without it (or with false) the template only reminds.',
    alwaysAsk: true,
  },
  'GET /api/ai/settings': {
    class: 'outside',
    describe: 'Show AI settings (looks up any *.ts.net AI server address in DNS)',
    why: 'Not a pure read. lib/services/aiSettings.ts loadSettings looks up every *.ts.net AI server address in DNS and refreshes the tailnet trust later outbound checks rely on: the same rule as GET /api/network-policy, so it is "outside". On a company file saved by an older version it also moves the saved AI keys once (a database write). A rolled-back preview would still make the lookups, so there is no dry run.',
    effects: ['network'],
    dryRun: 'none',
  },
  'PUT /api/ai/settings': {
    class: 'settings',
    // The card line is cut at 200 characters (lib/agent/describe.ts) and a placeholder cannot name
    // a list's items, so the AI servers, their addresses and the cloud-or-local choice per task
    // (providers, taskPolicies) are named as changing and shown by the request itself, which the
    // approval card shows (masked). A "(label: )" left empty is removed.
    describe:
      'Change AI settings: AI servers, addresses, cloud use per task (see the request) (cloud AI on: {cloudEnabled}) (cloud calls a day: {cloudDailyCap}) (bank auto-post: {autoApplyEnabled}) (confidence: {autoApplyThreshold}) (AI suggestions: {llmSuggestEnabled})',
    hostOnly: true,
    sensitiveFields: ['providers.*.apiKey'],
    dryRun: 'none',
    why: 'Company AI settings. A save can point an AI at a new server address, add one, or send a task (bank line suggestions, the assistant, error correction) to cloud AI while the cloud switch stays as it was; the request on the card shows each AI server and each task\'s choice as it would be saved. Adding an AI, changing its address or turning cloud AI on is refused away from the computer that holds the company file. Turning cloud AI on also opens Privacy & Network to cloud AI. bank auto-post is "post bank lines automatically" at that confidence. No dry run: saving loads the AI settings before and after (lib/services/aiSettings.ts updateSettings, getPublicSettings), which looks up every *.ts.net AI server address in DNS, a new one the agent typed included, and refreshes the tailnet trust; a rolled-back preview would still make those lookups (the rule in this file\'s header). providers[].apiKey is a typed secret, but there is no secret kind for an AI key yet, so it is only masked here: an agent should not be the one sending it.',
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
    // allowCloud is a person's choice (lib/agent/guards.ts takes it out of an agent's input), so on
    // an agent's card its aside is always left out: the line never reads as "allow cloud AI".
    describe: 'Test AI server {baseUrl} ({kind}) (and turn cloud AI on: {allowCloud})',
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
    // The id rule gives "errors.create", but nothing is created by hand: it runs the scan.
    id: 'errors.scan',
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
    class: 'prepare',
    describe: 'Import bank lines ({fileType}) into the feed of {bankAccountId}',
    countField: 'rows',
    confirmFlags: ['statement.acknowledgeDifference'],
    why: 'Classed by what it brings in, and for an agent every body only brings statement lines into the bank feed, where they wait for review: prepare work (plan 4.2), whatever the file type, reviewed statement rows (fileType "rows") included. The import service stages the lines (rules only fill in a suggested account and payee) and posts nothing for an agent: its auto-posting after an import, which posts each line the learned model is sure of when AI auto-apply is on, is skipped when the run is an agent\'s (ctx.agent, which the bridge always sets) and in any rolled-back preview (lib/services/import.ts importTransactions, autoPostHere). Posting those lines is its own operation, ai.bank-suggestions.run (action "auto-apply"), asked about on its own. A person\'s own import works as before. countField counts reviewed statement rows (fileType "rows"), so the record limit holds for them; for an OFX, QBO or CSV file the number of lines is known only after reading it. The confirm flag is the nested field statement.acknowledgeDifference: a statement that does not tie out answers 400 VALIDATION with details.tieOut, not a 409 warning. It is listed so a request that sends it counts as confirmed: one class higher (enter), and never under a standing grant. The dry run stages the lines in a transaction that is rolled back and looks no name up (the AI settings are not loaded for it).',
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
  'GET /api/import/rebuild': {
    class: 'file',
    describe: 'Preview Rebuild Data {action}',
    why: 'A File Utilities read (plan 4.2): the preview of Rebuild Data, the file utility that rewrites saved balances across the books, lists every record it would repair. Class file, like the repair it previews: an Admin approves it. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.',
    dryRun: 'none',
  },
  'POST /api/import/rebuild': {
    class: 'file',
    id: 'import.rebuild.run',
    describe: 'Run Rebuild Data {action}',
    why: 'A file utility (Rebuild Data) that rewrites saved balances across the books; Owner or Admin only, with nobody else working in the company. GET /api/import/rebuild is its preview. The action "orphaned_audit_refs" deletes audit trail rows, which is on the hard floor: the bridge must refuse that action for agents.',
  },

  // qb-import: QuickBooks conversion (lists, general ledger history, open invoices and bills)
  'POST /api/qb-import': {
    class: 'file',
    describe: 'Import QuickBooks {format} lists',
    why: 'QuickBooks import into the books (IIF or customer and vendor CSV), many records at once. Owner or Admin only, with nobody else working in the company.',
  },
  'GET /api/qb-import/gl': {
    class: 'file',
    describe: 'List past QuickBooks general ledger imports',
    why: 'A File Utilities read (plan 4.2): each past import of the QuickBooks conversion is listed with the name of the report file it came from and its stored proof. Class file: an Admin approves it. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.',
    dryRun: 'none',
  },
  'POST /api/qb-import/gl': {
    class: 'file',
    id: 'qb-import.gl.run',
    describe: 'Bring in QuickBooks general ledger history ({action})',
    dryRun: 'preview',
    confirmFlags: ['acceptVariance', 'acceptExistingEntries'],
    why: 'Brings years of QuickBooks history into the books. Its own "preview" and "dry-run" actions show what an import would do; the accept flags answer its warnings (the warning comes back as ok: false, not a 409).',
  },
  'GET /api/qb-import/open-items': {
    class: 'file',
    describe: 'Compare A/R and A/P with their aging',
    why: "A File Utilities read (plan 4.2): the proof page of the QuickBooks cutover, part of the conversion that plan 4.2 files under class file, so an Admin approves it, as for the import it proves. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.",
    dryRun: 'none',
  },
  'POST /api/qb-import/open-items': {
    class: 'file',
    id: 'qb-import.open-items.run',
    describe: 'Bring in open QuickBooks invoices and bills ({action})',
    dryRun: 'preview',
    why: 'QuickBooks cutover: action "import" creates the open invoices, credit memos, bills and vendor credits. Action "preview" is its own preview and saves nothing.',
  },

  // product-info: the Product Information window
  'GET /api/product-info': { class: 'read', describe: 'Show product and company file information' },
};
