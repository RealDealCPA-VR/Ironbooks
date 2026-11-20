/**
 * Agent full access: classification of the "banking" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/banking.test.ts.
 *
 * Voids are not deletes: DELETE on a check, deposit, transfer or journal entry voids it (the record
 * stays, its amounts are reversed), so those are class "change". Only the register's Delete, a
 * cancelled reconciliation, a removed rule or memorized transaction and Undo Last Reconciliation
 * lose something for good.
 *
 * Masking (plan §5.9): bank account numbers come back as the last 4 digits unless the caller has
 * "view full account numbers" (lib/permissions/mask.ts). Those reads keep class "read" and carry
 * `reveal`, so an unmasked answer is a separate, approved request.
 *
 * Standing automation: a memorized transaction set to post automatically, and a bank rule set to
 * "Add automatically", both post later without anyone reviewing the line. Creating or changing
 * either (the rule order too, since the first matching rule wins) always asks, like a pay run.
 *
 * Bulk work over "every waiting line" has no list in the body, so its count is unknown until it
 * runs. The policy already asks for a bulk request with no count (lib/agent/policy.ts, decide), and
 * a capped grant never covers one; these entries also set alwaysAsk so the card does not offer a
 * standing grant that could never apply.
 */
import type { ClassificationMap } from '../types';

export const BANKING_CLASSES: ClassificationMap = {
  // Bank accounts: the link between a real bank or card account and its GL account.
  'GET /api/bank-accounts': {
    class: 'read',
    describe: 'List bank and credit card accounts',
    reveal: 'account_numbers',
    sensitiveFields: ['*.accountNumber'],
  },
  'POST /api/bank-accounts': {
    class: 'enter',
    describe: 'Link bank account {bankName} to GL account {accountId}',
    // The body carries the full account number the agent typed; the answer is masked.
    sensitiveFields: ['accountNumber'],
  },
  'POST /api/banking/account-currency': {
    class: 'change',
    describe: 'Set the currency of bank account {accountId} to {currency}',
    why: 'Changes a property of an existing bank or credit card account (only while it has no transactions). Nothing new is entered.',
  },

  // Bank feed: statement lines waiting for review, and adding them to the books.
  'GET /api/bank-transactions': {
    class: 'read',
    describe: 'List the bank feed lines of bank account {bankAccountId}',
  },
  'GET /api/bank-transactions/[id]/matches': {
    class: 'read',
    describe: 'Find the entries bank feed line {id} could be matched to',
  },
  'GET /api/bank-transactions/matches': {
    class: 'read',
    describe: 'Find match candidates for every bank feed line of bank account {bankAccountId}',
  },
  'GET /api/bank-transactions/suggestions': {
    class: 'outside',
    describe:
      'Suggest accounts for the bank feed lines of bank account {bankAccountId}, ai={ai} (when 1, the payee, description and amount of unsure lines go to the company\'s AI model)',
    why: 'Not a plain read. Every call refreshes the learned categorizer stored in the company file (ai_categorizer_models), and with ai=1 the low-confidence lines (payee, description, amount) are sent to the AI model the company set up, which may be a cloud service, plus the optional vendor web lookup. No dry run: a preview would send the same lines out.',
    effects: ['network'],
    dryRun: 'none',
  },
  'POST /api/bank-transactions/categorize': {
    class: 'enter',
    describe: 'Add bank feed line {bankTransactionId} to the books in account {accountId}',
    why: 'Posts a new entry for the line. It may also save a suggest-only bank rule for the payee, which never posts by itself.',
  },
  'POST /api/bank-transactions/match': {
    class: 'change',
    describe: 'Match bank feed line {bankTransactionId} to entry {journalEntryId}',
    why: 'Nothing new is posted: the line is marked as already in the books and leaves the review list. It is a decision about existing records, and a wrong match hides a missing transaction, so it is a change, not prepare. Unmatch takes it back.',
  },
  'POST /api/bank-transactions/unmatch': {
    class: 'change',
    describe: 'Undo the categorization or match of bank feed line {bankTransactionId}',
    why: 'Voids the entry that adding the line created (or only clears the link to an older entry) and puts the line back in review.',
  },
  'POST /api/bank-transactions/exclude': {
    class: 'change',
    describe: 'Exclude bank feed line {bankTransactionId} from review, or restore it',
    why: 'Nothing reaches the ledger, but an excluded line is never recorded: excluding is a bookkeeping decision about an existing line, and bank line text is untrusted input an agent reads. So it is a change, not prepare. restore: true brings the line back.',
  },
  'POST /api/bank-transactions/bulk': {
    class: 'bulk',
    describe:
      'Post (categorizeSuggested) or re-suggest (applyRules) every waiting bank feed line of bank account {bankAccountId}: {action}',
    why: 'One request over every waiting line of the bank account: applyRules rewrites the suggested account of each line, categorizeSuggested posts an entry for every line a live rule still covers. The body has no list, so the count is only known after the run; it always asks.',
    alwaysAsk: true,
  },
  'POST /api/bank-transactions/bulk-accept': {
    class: 'bulk',
    describe:
      'Post many bank feed lines at once: the listed items, or with allHighConfidence every waiting line of bank account {bankAccountId} at or above {minConfidence}% (90 when left out)',
    why: 'Posts one entry per accepted line: the listed items (at most 1000), or with allHighConfidence every waiting line of the bank account at or above minConfidence (as low as 50%), a count known only after the run. No countField: bulkAcceptSchema is a union whose allHighConfidence form drops an items list sent with it, so the length of items could claim 1 while every line is posted. Until the bridge counts from the body as the schema parses it, the count is unknown and it always asks.',
    alwaysAsk: true,
  },

  // Bank rules (Rules page) and the older categorization rules list.
  'GET /api/bank-rules': {
    class: 'read',
    describe: 'List bank rules',
  },
  'POST /api/bank-rules': {
    class: 'enter',
    describe: 'Add bank rule {name}',
    why: 'A rule set to "Add automatically" (mode auto) posts matching bank lines later without review, when anyone opens the bank feed. That is standing automation, like a memorized transaction, so making a rule always asks.',
    alwaysAsk: true,
  },
  'GET /api/bank-rules/[id]': {
    class: 'read',
    describe: 'Show bank rule {id}',
  },
  'PUT /api/bank-rules/[id]': {
    class: 'change',
    describe: 'Change bank rule {id}',
    why: 'Can switch a rule to "Add automatically" or change what it posts to, which then posts bank lines later without review. Always asks, like changing a memorized transaction.',
    alwaysAsk: true,
  },
  'DELETE /api/bank-rules/[id]': {
    class: 'remove',
    describe: 'Delete bank rule {id}',
    why: 'The rule is switched off and hidden for good (the row stays only for the audit trail); there is no way to bring it back.',
  },
  'POST /api/bank-rules/reorder': {
    class: 'change',
    describe: 'Change the order bank rules are checked in',
    why: 'Rewrites the priority of every rule as one ordering. Not bulk: it is one list setting. But the first matching rule wins a line, so moving an "Add automatically" rule above a suggest-only one makes lines post without review the next time the bank feed is opened. Always asks, like changing a rule.',
    alwaysAsk: true,
  },
  'POST /api/bank-rules/test': {
    class: 'read',
    describe: 'Test bank rule {name} against recent bank lines',
    why: 'Only lists the recent bank lines the draft rule would catch. Nothing is saved.',
  },
  'GET /api/bank-rules/offers': {
    class: 'read',
    describe: 'List suggested bank rules',
  },
  'POST /api/bank-rules/offers': {
    class: 'enter',
    describe: 'Answer the suggested bank rule for {pattern} ({action})',
    why: 'accept saves a learned rule, and mode auto makes it post bank lines later without review, so it always asks like making a rule. dismiss saves a "never ask again" note.',
    alwaysAsk: true,
  },
  'POST /api/bank-rules/run': {
    class: 'bulk',
    describe: 'Post the bank feed lines of bank account {bankAccountId} that an automatic rule covers',
    why: 'Posts every waiting line whose first matching rule is "Add automatically", one entry each, and first returns lines matched to voided entries to review. The body has no list, so the count is only known after the run; it always asks.',
    alwaysAsk: true,
  },
  'GET /api/rules': {
    class: 'read',
    describe: 'List categorization rules',
  },
  'POST /api/rules': {
    class: 'enter',
    describe: 'Add categorization rule {name}',
  },

  // Sample data for trying the bank feed.
  'POST /api/demo-feed': {
    class: 'enter',
    describe: 'Load 8 made-up sample lines into the bank feed of real bank account {bankAccountId}',
    why: 'Adds made-up statement lines (a $3,850 payroll payment, customer deposits, travel ...) to a real bank account\'s feed, with no audit row. They are not prepare work: a line an "Add automatically" rule matches is posted without review the next time anyone opens the bank feed. Sample data has no use in a real company file, so it always asks.',
    alwaysAsk: true,
  },

  // Registers.
  'GET /api/registers': {
    class: 'read',
    describe: 'List account registers',
  },
  'GET /api/registers/[accountId]': {
    class: 'read',
    describe: 'Show the register of account {accountId}',
  },
  'POST /api/registers/[accountId]': {
    class: 'enter',
    describe: 'Enter {amount} ({side}) in the register of account {accountId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'amount',
  },
  'DELETE /api/registers/[accountId]': {
    class: 'remove',
    describe: 'Void or delete ({action}) the transaction of entry {entryId} in the register of account {accountId}',
    why: 'action=void keeps the transaction with its amounts zeroed, but action=delete removes it for good. One class covers both, so it is the stricter one.',
  },

  // Checks and expenses (Write Checks, cash expenses, credit card charges).
  'GET /api/expenses': {
    class: 'read',
    describe: 'List checks and expenses',
  },
  'POST /api/expenses': {
    class: 'enter',
    describe: 'Write a {method} expense dated {date} from account {paymentAccountId}',
    confirmFlags: ['allowDuplicateNumber'],
  },
  'GET /api/expenses/[id]': {
    class: 'read',
    describe: 'Show check or expense {id}',
  },
  'PATCH /api/expenses/[id]': {
    class: 'change',
    describe: 'Change check or expense {id}',
    confirmFlags: ['allowDuplicateNumber', 'allowReconciledEdit'],
  },
  'DELETE /api/expenses/[id]': {
    class: 'change',
    describe: 'Void check or expense {id}',
    why: 'Voids, does not delete: the check stays in the books with its entry reversed.',
  },
  'POST /api/expenses/[id]/print': {
    class: 'print',
    describe: 'Record check {id} as printed with number {checkNumber}',
    why: 'Marks a queued check printed and stamps its number on the check and its entry.',
    confirmFlags: ['allowDuplicateNumber'],
  },
  'GET /api/check-numbers/next': {
    class: 'read',
    describe: 'Show the next check number for account {paymentAccountId}',
  },
  'GET /api/check-numbers/duplicate': {
    class: 'read',
    describe: 'Check whether check number {number} is already used on account {paymentAccountId}',
  },
  'POST /api/checks/pdf': {
    class: 'read',
    describe: 'Make a check PDF',
    why: 'Only renders a PDF (a recorded check, a batch, a one-off check or an alignment test page). Nothing is recorded: numbers are recorded by the print queue, and printing on paper is a separate print operation.',
    output: 'pdf',
  },
  'GET /api/checks/settings': {
    class: 'read',
    describe: 'Show the check printer setup',
  },
  'PUT /api/checks/settings': {
    class: 'settings',
    describe: 'Change the check printer setup (style {style})',
    why: 'The company check style, paper and alignment used for every check printed.',
  },

  // Print Checks queue: checks to print, a print run, and "Did the checks print OK?".
  'GET /api/print-queue': {
    class: 'read',
    describe: 'List checks waiting to print',
  },
  'POST /api/print-queue': {
    class: 'print',
    describe: 'Record {source} {id} as printed with check number {checkNumber}',
    why: 'Marks one queued check printed and stamps its number on the check and its entry.',
    confirmFlags: ['allowDuplicateNumber'],
  },
  'GET /api/print-queue/paychecks': {
    class: 'read',
    describe: 'List paychecks not yet printed or queued',
  },
  'POST /api/print-queue/paychecks': {
    class: 'bulk',
    describe: 'Put paychecks in the check print queue',
    why: 'Sets the "to print" flag on every listed paycheck in one request (a change to each paycheck; closed periods are checked). Nothing prints.',
    countField: 'paycheckIds',
  },
  'GET /api/print-queue/refunds': {
    class: 'read',
    describe: 'List customer refunds that have no check yet',
  },
  'POST /api/print-queue/refunds': {
    class: 'enter',
    describe: 'Put customer refund {entryId} in the check print queue',
    why: 'Adds a check document for a refund that is already posted. No new ledger entry.',
  },
  'POST /api/print-queue/run': {
    class: 'read',
    describe: 'Check a print run of checks before printing',
    why: 'Step 1 of Print Checks: only checks that the checks are still waiting, on one bank account, and that their numbers are free. Nothing is recorded.',
    confirmFlags: ['allowDuplicateNumber'],
  },
  'POST /api/print-queue/confirm': {
    class: 'print',
    describe: 'Record which checks of a print run printed correctly',
    why: '"Did the checks print OK?": records the number of every check that printed, on the check and its entry; the ones marked reprint stay in the queue.',
    confirmFlags: ['allowDuplicateNumber'],
    countField: 'items',
  },
  'POST /api/print-queue/reprint': {
    class: 'print',
    describe: 'Put printed {source} {id} back in the print queue to print again',
    why: 'Clears the printed check number from the check and its entry and queues it again.',
  },

  // Deposits.
  'GET /api/deposits': {
    class: 'read',
    describe: 'List deposits',
  },
  'POST /api/deposits': {
    class: 'enter',
    describe: 'Make a deposit to account {depositAccountId} dated {date}',
  },
  'GET /api/deposits/[id]': {
    class: 'read',
    describe: 'Show deposit {id}',
  },
  'PATCH /api/deposits/[id]': {
    class: 'change',
    describe: 'Change deposit {id}',
    confirmFlags: ['allowReconciledEdit'],
  },
  'DELETE /api/deposits/[id]': {
    class: 'change',
    describe: 'Void deposit {id}',
    why: 'Voids, does not delete: the deposit stays with its entry reversed, and its payments go back to Undeposited Funds.',
  },
  'GET /api/deposits/undeposited': {
    class: 'read',
    describe: 'List payments waiting in Undeposited Funds',
  },

  // Transfers between accounts.
  'GET /api/transfers': {
    class: 'read',
    describe: 'List transfers',
  },
  'POST /api/transfers': {
    class: 'enter',
    describe: 'Transfer {amount} from account {fromAccountId} to account {toAccountId}',
    amountField: 'amount',
  },
  'GET /api/transfers/[id]': {
    class: 'read',
    describe: 'Show transfer {id}',
  },
  'PATCH /api/transfers/[id]': {
    class: 'change',
    describe: 'Change transfer {id}',
    confirmFlags: ['allowReconciledEdit'],
    amountField: 'amount',
  },
  'DELETE /api/transfers/[id]': {
    class: 'change',
    describe: 'Void transfer {id}',
    why: 'Voids, does not delete: the transfer stays with its entry reversed.',
  },

  // General journal entries.
  'GET /api/journal-entries': {
    class: 'read',
    describe: 'List journal entries',
  },
  'POST /api/journal-entries': {
    class: 'enter',
    describe: 'Enter a journal entry dated {date}: {description}',
  },
  'GET /api/journal-entries/[id]': {
    class: 'read',
    describe: 'Show journal entry {id}',
  },
  'PATCH /api/journal-entries/[id]': {
    class: 'change',
    describe: 'Change journal entry {id}',
    confirmFlags: ['allowReconciledEdit'],
  },
  'DELETE /api/journal-entries/[id]': {
    class: 'change',
    describe: 'Void journal entry {id}',
    why: 'Voids, does not delete: the entry stays with its amounts reversed. Voiding a depreciation entry also takes that period off the fixed asset (its schedule row is removed and its accumulated depreciation lowered); the period can be posted again.',
  },
  'GET /api/journal-entries/[id]/history': {
    class: 'read',
    describe: 'Show the linked transactions of journal entry {id}',
  },
  'POST /api/journal-entries/[id]/reverse': {
    class: 'enter',
    describe: 'Reverse journal entry {id} as of {asOfDate}',
    why: 'Posts a new reversing entry; the original entry is not changed.',
  },
  'GET /api/journal-entries/adjusting': {
    class: 'read',
    describe: 'List adjusting journal entries',
  },
  'GET /api/journal-entries/for-source': {
    class: 'read',
    describe: 'Find the journal entry posted by {ref}',
  },

  // Reconciliations.
  'GET /api/reconciliations': {
    class: 'read',
    describe: 'List reconciliations',
    reveal: 'account_numbers',
    sensitiveFields: ['*.accountNumber'],
  },
  'POST /api/reconciliations': {
    class: 'prepare',
    describe: 'Start reconciling bank account {bankAccountId} against the statement of {statementDate}',
    why: 'Only opens a reconciliation in progress. Nothing reaches the ledger until it is completed, and it can be cancelled.',
  },
  'GET /api/reconciliations/[id]': {
    class: 'read',
    describe: 'Show the progress of reconciliation {id}',
  },
  'PATCH /api/reconciliations/[id]': {
    class: 'change',
    describe: 'Work on reconciliation {id} ({action})',
    why: 'The same request ticks lines and corrects the statement (prepare work), but also completes the reconciliation and posts service charge, interest and discrepancy entries (action complete or adjustments). One class covers every action, so it is the stricter one.',
  },
  'DELETE /api/reconciliations/[id]': {
    class: 'remove',
    describe: 'Cancel reconciliation {id} that is in progress',
    why: 'Deletes the session and every line ticked in it for good. Nothing in the ledger changes.',
  },
  'GET /api/reconciliations/[id]/clearable': {
    class: 'read',
    describe: 'List the lines that can be cleared in reconciliation {id}',
  },
  'POST /api/reconciliations/[id]/pay': {
    class: 'enter',
    describe: 'Pay {amount} on the credit card of reconciliation {id} from account {paymentAccountId} (no amount: the statement ending balance)',
    why: 'amount may be left out: then the reconciliation\'s statement ending balance is paid. The policy treats a missing amount as above any two-person limit, and no grant with a maximum amount covers it (lib/agent/policy.ts needsTwoPerson, grantCovers).',
    amountField: 'amount',
  },
  'GET /api/reconciliations/[id]/report': {
    class: 'read',
    describe: 'Show the reconciliation report of reconciliation {id}',
    reveal: 'account_numbers',
    sensitiveFields: ['accountNumber'],
  },
  'GET /api/reconciliations/discrepancies': {
    class: 'read',
    describe: 'Show the reconciliation discrepancy report',
    reveal: 'account_numbers',
    sensitiveFields: ['*.accountNumber'],
  },
  'GET /api/reconciliations/info': {
    class: 'read',
    describe: 'Show the reconciliation details of bank account {bankAccountId}',
    reveal: 'account_numbers',
    sensitiveFields: ['accountNumber'],
  },
  'POST /api/reconciliations/undo': {
    class: 'remove',
    describe: 'Undo the last reconciliation of bank account {bankAccountId}',
    why: 'Undo Last Reconciliation: the completed reconciliation is marked undone and the account goes back to the one before. It cannot be redone except by reconciling every line again.',
  },

  // Memorized transactions (recurring templates).
  'GET /api/recurring': {
    class: 'read',
    describe: 'List memorized transactions',
  },
  'POST /api/recurring': {
    class: 'enter',
    describe: 'Memorize {docType} {name} to repeat {frequency}',
    why: 'A memorized transaction set to automatic posts on its schedule without anyone reviewing it, so making one always asks (plan §8, Recurring).',
    alwaysAsk: true,
  },
  'GET /api/recurring/[id]': {
    class: 'read',
    describe: 'Show memorized transaction {id}',
  },
  'PATCH /api/recurring/[id]': {
    class: 'change',
    describe: 'Change memorized transaction {id}',
    why: 'Can change what an automatic memorized transaction posts, how often or how many times, so it always asks like making one.',
    alwaysAsk: true,
  },
  'DELETE /api/recurring/[id]': {
    class: 'remove',
    describe: 'Delete memorized transaction {id}',
  },
  'POST /api/recurring/run': {
    class: 'bulk',
    describe: 'Enter memorized transactions now',
    why: 'Enters every memorized transaction due by asOf (each due date of each one), or one template (id) or a whole group (group). The body has no list, so the count is only known after the run; it always asks. The desktop timer path of this route (x-bka-internal header, checked against the per-launch token) runs every company\'s due templates as each owner on its own database handle; the bridge must never pass that header from agent input.',
    alwaysAsk: true,
  },

  // Smart defaults: recall the name's last form of that kind to pre-fill a new one.
  'GET /api/smart-defaults/bills': {
    class: 'read',
    describe: 'Recall the last bill of vendor {vendorId}',
  },
  'GET /api/smart-defaults/expenses': {
    class: 'read',
    describe: 'Recall the last {form} of vendor {vendorId}',
  },
  'GET /api/smart-defaults/sales': {
    class: 'read',
    describe: 'Recall the last {form} of customer {customerId}',
  },
};
