/**
 * Agent full access: classification of the "company" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/company.test.ts.
 *
 * The cross-bucket rule for lookups (the same in documents.ts for the AI and receipt settings): a
 * GET that can look up a *.ts.net address in DNS or refresh the tailnet trust is 'outside', not
 * 'read', even when that lookup is its only side effect and it happens only when such an address is
 * set up. GET /api/network-policy is one; GET /api/network-policy/check makes no lookup and stays
 * 'read'.
 *
 * Closed periods: the Accountant Center's batch routes (batch enter, batch void and restore,
 * reclassify) carry their dates on each row or on the transactions they name, not in one body date
 * field, so the run-time closed-period check (RequestFacts.date, closedPeriod) cannot see them. The
 * services check every row themselves and refuse one dated on or before the closing date unless the
 * closing-date password comes with the request. These entries name no needsSecret, so the approver
 * is never asked for that password and such a row is refused, never posted.
 *
 * Amounts, the same rule in every bucket (see sales.ts or payroll.ts): amountField names the money
 * the route's ANSWER carries. Write-off answers the total of every invoice it writes off. Batch
 * enter, batch void and restore and reclassify answer no amounts and set no amountField, so before
 * the dry run they count as over every amount limit, and after it the bridge (lib/agent/bridge.ts
 * factsFor) judges them by the largest SINGLE ledger entry the run posted, not the total. Their bulk
 * cap limits how many records, not how much money.
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post", with a short verb: a tool that works on the rows picked from its list applies
 * (accountant.reclassify.apply), a door whose body names the action runs it.
 */
import type { ClassificationMap } from '../types';

export const COMPANY_CLASSES: ClassificationMap = {
  // company: the company record, Preferences, the closing date, Multiple Currencies, the setup interview
  'GET /api/company': {
    class: 'read',
    describe: 'Read the company record and its preferences',
  },
  'PATCH /api/company': {
    class: 'settings',
    describe: 'Change the company name or company preferences',
    why:
      'Company preferences (lib/services/company.ts updateCompany). Three fields are not ordinary settings, so ' +
      'the bridge must act on them: settings.integratedAppsBlocked is the Integrated Applications switch that ' +
      'also shuts agents out (hard floor), so it is always stripped from agent input; settings.allowEmployeePortal ' +
      'and settings.allowPhoneReceipts decide who may reach the company file from outside and are Admin-only in ' +
      'the service (Integrated Applications), so they are stripped too, or a request that carries them is raised ' +
      'to class admin. A new name renames the company file (Rename & Archive Company File right).',
  },
  'GET /api/company/closing-date': {
    class: 'read',
    describe: 'Read the closing date and whether it has a password',
  },
  'PATCH /api/company/closing-date': {
    class: 'period',
    describe: 'Set or clear the closing date: {closingDate} (empty clears the date and its password)',
    why:
      'Moves, sets or clears the closing date and its password. Someone who is not an Admin gives the current ' +
      'closing-date password (body currentPassword) to move the date earlier, clear it, or change the password; ' +
      'a new password goes in body password. Neither may come from the agent.',
    needsSecret: ['closing_password'],
    sensitiveFields: ['password', 'currentPassword'],
  },
  'GET /api/company/multi-currency': {
    class: 'read',
    describe: 'Read whether Multiple Currencies is on and whether it is locked',
  },
  'GET /api/company/setup-interview': {
    class: 'read',
    describe: 'Read the setup interview record',
  },
  'POST /api/company/setup-interview': {
    class: 'settings',
    id: 'company.setup-interview.apply',
    describe: 'Apply the setup interview answers to the company',
    why:
      'Saves company preferences and switches features on or off (lib/services/setupInterview.ts), and in the ' +
      'same transaction adds accounts, maps tax lines and posts opening balances. { skip: true } only records ' +
      '"Skip for now".',
  },

  // preferences: the resolved Preferences; My Preferences belong to the signed-in person
  'GET /api/preferences': {
    class: 'read',
    describe: "Read the company preferences and the caller's own preferences",
  },
  'GET /api/preferences/my': {
    class: 'read',
    describe: "Read the signed-in person's own preferences",
    availability: 'person_only',
    why:
      'My Preferences are a person\'s own settings for how the app behaves for them. An agent has no user, so it ' +
      'would only ever see the defaults; GET /api/preferences already answers them.',
  },
  'PATCH /api/preferences/my': {
    class: 'settings',
    describe: "Change the signed-in person's own preferences",
    availability: 'person_only',
    why:
      'A person changing their own preferences. The service needs a signed-in user (an agent has none), and run ' +
      "under an approver it would change the approver's own preferences.",
  },

  // doc-numbers: starting and next numbers per document type
  'GET /api/doc-numbers': {
    class: 'read',
    describe: 'List the starting and next numbers of each document type',
    why: 'nextDocNumber only looks the number up; nothing is reserved.',
  },
  'PUT /api/doc-numbers': {
    class: 'settings',
    describe: 'Set the starting number of {docType} to {startingNumber}',
    why: 'Document numbering is a company setting.',
  },

  // network-policy: Privacy & Network (host-only to change)
  'GET /api/network-policy': {
    class: 'outside',
    describe: 'Read the Privacy & Network policy and recent outbound activity',
    why:
      'Not a pure read. When the company file is not approved on this computer, the answer lists the internet ' +
      'services it is held from (lib/net/fileTrust.ts holdStatus), and working that out looks up every ' +
      'configured *.ts.net AI, mail or vendor lookup address in DNS (lib/net/tailnetVerify.ts) and refreshes the ' +
      'tailnet trust that later outbound checks rely on. A rolled-back preview would still make those lookups, ' +
      'so there is no dry run.',
    effects: ['network'],
    dryRun: 'none',
  },
  'PUT /api/network-policy': {
    class: 'settings',
    describe: 'Change the Privacy & Network policy',
    why:
      'Decides where this computer may connect (network mode, cloud opt-ins, vendor lookup address). Owner or ' +
      'Admin only, and only from the computer that holds the company file. { allowOnThisComputer: true } instead ' +
      "approves the company file's internet services on this computer.",
    hostOnly: true,
  },
  'PATCH /api/network-policy': {
    class: 'settings',
    describe: 'Change the Privacy & Network policy',
    why: 'Same handler as PUT /api/network-policy (an alias for the shared api client).',
    hostOnly: true,
  },
  'GET /api/network-policy/check': {
    class: 'read',
    describe: 'Check whether the network policy lets {purpose} reach {url}',
    why:
      'Only asks the policy; it makes no connection, looks nothing up in DNS and adds nothing to the outbound log.',
  },

  // accountant: Accountant Center tools (batch enter, batch void, reclassify, write-off, reviews, sales tax)
  'GET /api/accountant/center': {
    class: 'read',
    describe: 'Read the Accountant Center summary',
  },
  'GET /api/accountant/batch-enter/lookups': {
    class: 'read',
    describe: 'Read the accounts, names and classes Batch Enter matches against',
  },
  'POST /api/accountant/batch-enter': {
    class: 'bulk',
    describe: 'Batch enter {type} transactions',
    why:
      'Creates many transactions in one request (up to 1,000 rows). Its own preview: validateOnly: true runs ' +
      'every row and rolls everything back. Each row has its own date, so the closed-period check cannot ' +
      'see them; a row dated on or before the closing date is refused by the service.',
    countField: 'rows',
    dryRun: 'preview',
  },
  'GET /api/accountant/batch-void': {
    class: 'read',
    describe: 'List transactions for Batch Delete/Void, or the deleted ones that can be restored',
  },
  'POST /api/accountant/batch-void': {
    class: 'remove',
    id: 'accountant.batch-void.apply',
    describe: 'Batch void or delete the selected transactions (action: {action}; empty means void)',
    why:
      'Voids or deletes up to 500 transactions at once, and voids the sales tax corrections that depended on ' +
      'them. Voids cannot be taken back. The dates are on the transactions named, so the closed-period check ' +
      'cannot see them; one dated on or before the closing date is refused by the void services.',
    countField: 'keys',
  },
  'POST /api/accountant/batch-void/restore': {
    class: 'bulk',
    describe: 'Restore the selected deleted transactions',
    why:
      'Re-creates up to 500 deleted transactions through their normal create services in one request. The ' +
      'dates are on the transactions named, so the closed-period check cannot see them; one dated on or ' +
      'before the closing date is refused by the create services.',
    countField: 'ids',
  },
  'GET /api/accountant/reclassify': {
    class: 'read',
    describe: 'List the lines on account {accountId} that can be reclassified',
  },
  'POST /api/accountant/reclassify': {
    class: 'bulk',
    id: 'accountant.reclassify.apply',
    describe: 'Move the selected ledger lines to account {newAccountId} or class {newClassId}',
    why:
      'Rewrites the account or class of up to 2,000 posted lines in place, and of their source documents. The ' +
      'dates are on the lines named, so the closed-period check cannot see them; the service checks each ' +
      'entry and refuses one dated on or before the closing date.',
    countField: 'lineIds',
  },
  'GET /api/accountant/write-off': {
    class: 'read',
    describe: 'List invoices that could be written off',
  },
  'POST /api/accountant/write-off': {
    class: 'bulk',
    id: 'accountant.write-off.apply',
    describe: 'Write off the selected invoices as bad debt on {date}',
    why:
      'Writes off up to 500 invoices in one request, one credit memo each. The amount is the answer\'s total ' +
      '(lib/services/accountant/writeOff.ts writeOffInvoices adds up every write-off), not one credit memo\'s.',
    countField: 'invoiceIds',
    amountField: 'total',
  },
  'GET /api/accountant/working-trial-balance': {
    class: 'read',
    describe: 'Read the working trial balance from {from} to {to}',
  },
  'PUT /api/accountant/working-trial-balance': {
    class: 'prepare',
    describe: 'Save the workpaper reference or note of account {accountId} for {periodEnd}',
    why: 'A workpaper note on the working trial balance; it never reaches the ledger.',
  },
  'POST /api/accountant/working-trial-balance': {
    class: 'enter',
    id: 'accountant.working-trial-balance.adjust',
    describe: 'Post an adjusting journal entry dated {date}: {description}',
  },
  'GET /api/accountant/list-changes': {
    class: 'read',
    describe: 'List changes made to the lists',
  },
  'POST /api/accountant/list-changes': {
    class: 'bulk',
    id: 'accountant.list-changes.review',
    describe: 'Mark the selected list changes as reviewed or not reviewed',
    why:
      "Marks up to 5,000 list changes reviewed in one request. Marking reviewed is the reviewer's sign-off and " +
      'takes the changes off the review list and the Accountant Center count, so an agent must not do it ' +
      'quietly (it could hide its own changes): always asked, never run on a standing permission.',
    countField: 'auditLogIds',
    alwaysAsk: true,
  },
  'GET /api/accountant/client-data-review': {
    class: 'read',
    describe: 'Run the Client Data Review checks',
  },
  'POST /api/accountant/client-data-review': {
    class: 'change',
    id: 'accountant.client-data-review.run',
    describe: 'Client Data Review: {action}',
    why:
      'One route for several fixes: apply_customer_credit and apply_vendor_credit apply credits, ' +
      'clear_undeposited changes a deposit. task_status and snapshot are the reviewer\'s sign-off: task_status ' +
      'marks a review task complete, and snapshot ("Mark review complete") resets the baseline that later ' +
      'shows what changed after the last review, so an agent could hide its own changes. Always asked.',
    alwaysAsk: true,
  },
  'GET /api/accountant/closing-date-exceptions': {
    class: 'read',
    describe: 'Read the Closing Date Exception report',
  },
  'GET /api/accountant/voided-deleted': {
    class: 'read',
    describe: 'Read the Voided/Deleted Transactions report',
    why:
      'With ?detail=1 each row carries the original values, masked by maskForContext ' +
      '(lib/services/accountant/auditReports.ts): SSNs and tax IDs unless the reader has sensitivePayroll, bank ' +
      'and account numbers unless the reader has fullAccountNumbers. So the masked read is ordinary and only a ' +
      'reveal is protected. The contract takes one reveal kind, so it names SSNs; a run whose access holds both ' +
      'flags unmasks account numbers too.',
    reveal: 'ssn',
    sensitiveFields: [
      'rows.*.original.ssn',
      'rows.*.original.employeeSsn',
      'rows.*.original.taxId',
      'rows.*.original.accountNumber',
      'rows.*.original.routingNumber',
      'rows.*.original.bankAccountNumber',
    ],
  },
  'GET /api/accountant/sales-tax/liability': {
    class: 'read',
    describe: 'Read the Sales Tax Liability report from {from} to {to}',
  },
  'GET /api/accountant/sales-tax/revenue-summary': {
    class: 'read',
    describe: 'Read the Sales Tax Revenue Summary from {from} to {to}',
  },
  'POST /api/accountant/sales-tax/adjustments': {
    class: 'enter',
    describe: 'Enter a sales tax adjustment of {amount} dated {date}',
    amountField: 'amount',
  },
  'GET /api/accountant/sales-tax/fix': {
    class: 'read',
    describe: 'List sales tax that looks recorded incorrectly',
  },
  'POST /api/accountant/sales-tax/fix': {
    class: 'change',
    id: 'accountant.sales-tax.fix.run',
    describe: 'Fix incorrectly recorded sales tax: {action}',
    why:
      'Corrects existing records: link or unlink a ledger line to an agency, post a correcting entry that moves ' +
      'an expense-coded payment to sales tax, or void such a correction (undo_fix).',
  },

  // accountant-copy: Accountant's Copy, both the client side and the accountant side
  'GET /api/accountant-copy': {
    class: 'read',
    describe: "Read the Accountant's Copy status",
  },
  'POST /api/accountant-copy': {
    class: 'file',
    id: 'accountant-copy.create',
    describe: "Create the Accountant's Copy transfer file (dividing date {dividingDate}), or save the one that is out again",
    why:
      "Locks the books on or before the dividing date and answers with the transfer file: a copy of the whole " +
      "company file with its users' sign-in data, active users' password hashes included " +
      '(lib/services/portableFile.ts OUTSIDER_VIEWS). { saveAgain: true } instead saves the transfer file of the ' +
      'copy that is already out again (same copy and dividing date; no dividingDate in the body). The ' +
      'transfer-file password (body password) is typed by the approver. Body { protect: false } skips the ' +
      'password (allowed when the company file itself is not protected) and answers with an unencrypted file ' +
      'whose password hashes the agent could then read, so the bridge must strip "protect" from agent input and ' +
      'always send the approver\'s password. Builds the file from its own snapshot of the database, so it cannot ' +
      'be rolled back.',
    fileAdmin: true,
    needsSecret: ['backup_password'],
    sensitiveFields: ['password'],
    output: 'file',
    dryRun: 'none',
  },
  'POST /api/accountant-copy/cancel': {
    class: 'file',
    describe: "Cancel the Accountant's Copy that is out",
    why:
      "Removes the Accountant's Copy restriction without importing. It cannot be taken back: the accountant's " +
      'changes file for that copy is refused from then on.',
    body: 'none',
  },
  'POST /api/accountant-copy/open': {
    class: 'file',
    describe: "Open a client's Accountant's Copy transfer file as a new company file",
    why:
      'Restores the transfer file into a new company-file folder with its own database. Owner or Admin only. ' +
      'A protected transfer file needs its password (x-ironbooks-password). Its own preview: ?inspect=1 only ' +
      'checks and describes the file.',
    needsSecret: ['backup_password'],
    body: 'bytes',
    dryRun: 'preview',
  },
  'GET /api/accountant-copy/changes': {
    class: 'read',
    describe: "List the changes made in this Accountant's Copy",
  },
  'POST /api/accountant-copy/changes': {
    class: 'file',
    id: 'accountant-copy.changes.export',
    describe: "Make the accountant's changes file for the client",
    why:
      "Part of the Accountant's Copy: answers with the .ibcx changes file and records that it was exported " +
      '(with the note), so it is not a read.',
    output: 'file',
  },
  'POST /api/accountant-copy/changes/review': {
    class: 'read',
    describe: "Review an accountant's changes file without importing it",
    why: 'Takes the changes file as the body and only describes it; nothing is changed.',
    body: 'bytes',
  },
  'POST /api/accountant-copy/changes/import': {
    class: 'file',
    describe: "Import the accountant's changes file into the books",
    why:
      "Applies every change in the accountant's file in one transaction and lifts the Accountant's Copy " +
      'restriction (Owner or Admin only). POST /api/accountant-copy/changes/review is its preview. Changes dated ' +
      'on or before the closing date need the closing-date password (x-closing-password); those dates are inside ' +
      'the file, so the run-time closed-period check cannot see them. The approver types it when the review ' +
      'answers needsClosingPassword.',
    needsSecret: ['closing_password'],
    body: 'bytes',
  },

  // fiscal-periods: closed fiscal periods
  'GET /api/fiscal-periods': {
    class: 'read',
    describe: 'List the closed and open fiscal periods',
  },
  'POST /api/fiscal-periods': {
    class: 'period',
    describe: 'Close the fiscal period from {periodStart} to {periodEnd}',
    why: 'Closes a fiscal period: entries dated in it are refused from then on.',
  },
  'PATCH /api/fiscal-periods/[id]': {
    class: 'period',
    describe: 'Reopen closed fiscal period {id}',
    why: 'Reopens a closed period so entries dated in it can post again.',
    body: 'none',
  },

  // month-end-close: the guided month-end checklist and close
  'GET /api/month-end-close': {
    class: 'read',
    describe: 'Read the month-end checklist for {periodEnd}',
  },
  'GET /api/month-end-close/report-pack': {
    class: 'read',
    describe: 'Make the month-end report pack for {periodEnd}',
    output: 'pdf',
  },
  'PATCH /api/month-end-close/steps': {
    class: 'prepare',
    describe: 'Month-end step {stepKey} for {periodEnd}: {action}',
    why:
      'Saves checklist progress (review or skip a step); it never reaches the ledger. Closing the month after it ' +
      'is its own request, class period. But reviewing or skipping a step that needs attention is the sign-off ' +
      'that lets the close go ahead (closeMonth only needs every required step done, skipped or reviewed), so it ' +
      'is always asked rather than left to the prepare setting.',
    alwaysAsk: true,
  },
  'POST /api/month-end-close/scan': {
    class: 'prepare',
    describe: 'Run the month-end error scan for {periodEnd}',
    why:
      'Saves the findings of the rules-based error scan and when it ran; it never reaches the ledger and calls ' +
      'no AI service.',
  },
  'POST /api/month-end-close/close': {
    class: 'period',
    describe: 'Close the month: set the closing date to {periodEnd}',
    why:
      'Sets the closing date to the period end through the Set Closing Date flow. A new closing-date password ' +
      '(body password) or the current one (body currentPassword) never comes from the agent.',
    needsSecret: ['closing_password'],
    sensitiveFields: ['password', 'currentPassword'],
  },

  // year-end-close: the closing entry that moves the year's profit or loss into retained earnings
  'POST /api/year-end-close': {
    class: 'period',
    describe: 'Run the year-end close for fiscal year {fiscalYear}',
    why:
      "Posts the closing entry that zeros the year's income and expense accounts into retained earnings, dated " +
      'on the fiscal year end, which is usually already on or before the closing date. The body only carries ' +
      'fiscalYear, so the run-time closed-period check cannot see that date: the class is period (year-end close ' +
      'is closed-period work) and the approver types the closing-date password. Plan section 8 lists it under ' +
      'remove; both can never be Allow, but the entry itself can be voided later like any journal entry, while ' +
      'the approver does need closed-period rights. Before it posts, the service writes a safety copy of the ' +
      'whole company folder and drops the oldest one, outside the database, so a rolled-back preview would still ' +
      'do that.',
    needsSecret: ['closing_password'],
    dryRun: 'none',
  },

  // period-copy: a company file of one date range
  'POST /api/period-copy': {
    class: 'file',
    describe: 'Make a Period Copy of the books from {from} to {to}',
    why:
      "Answers with a portable company file of the date range, carrying the file's users with active users' " +
      'password hashes (lib/services/portableFile.ts OUTSIDER_VIEWS). The file password (body password) is typed ' +
      'by the approver. Body { protect: false } skips the password (allowed when the company file itself is not ' +
      'protected) and answers with an unencrypted file whose password hashes the agent could then read, so the ' +
      'bridge must strip "protect" from agent input and always send the approver\'s password. Built in a ' +
      'separate folder with its own database.',
    fileAdmin: true,
    needsSecret: ['backup_password'],
    sensitiveFields: ['password'],
    output: 'file',
    dryRun: 'none',
  },

  // undo: the 30-second Undo behind the toast
  'POST /api/undo/prepare': {
    class: 'prepare',
    describe: 'Save a snapshot of {resource} {id} so the next change to it can be undone',
    why: 'Only stores a snapshot of the record for the Undo button; the record itself is not changed.',
  },
  'POST /api/undo/commit': {
    class: 'prepare',
    describe: 'Turn on the 30-second Undo for the change to {resource} {id}',
    why: 'Only arms the undo token after the change was saved; no record is changed.',
  },
  'POST /api/undo/[id]': {
    class: 'remove',
    describe: 'Undo the change held by undo token {id}',
    why:
      'Applies the opposite of the last change: voids a new transaction, puts back the old values, or enters a ' +
      'voided document again as a new copy.',
    body: 'none',
  },
};
