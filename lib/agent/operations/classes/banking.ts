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
 * `reveal`, so an unmasked answer is a separate, approved request. The same goes for the check
 * print queue: a check's memo line is "Acct # <the payee's account number>" when left blank, and
 * the queue's answers mask it (printQueue.ts checkMemoFor). The check PDF is the exception: it is
 * the printed text and keeps the full number for every caller, so it is protected data itself
 * (POST /api/checks/pdf, read_sensitive).
 *
 * Confirmation flags: allowReconciledEdit is in the body schema of every check, deposit, transfer
 * and journal entry save because one schema serves both the new record and the edit, but only the
 * edit asks for it (the services raise the "reconciled" warning in updateExpense, updateDeposit,
 * updateTransfer and updateEntry only; a new record has no reconciled lines). So it is listed on
 * the PATCH entries alone.
 *
 * Standing automation: a memorized transaction set to post automatically, and a bank rule set to
 * "Add automatically", both post later without anyone reviewing the line. Creating or changing
 * either (the rule order too, since the first matching rule wins) always asks, like a pay run.
 *
 * Bulk work over "every waiting line" has no list in the body, so its count is unknown until it
 * runs. The policy already asks for a bulk request with no count (lib/agent/policy.ts, decide), and
 * a capped grant never covers one; these entries also set alwaysAsk so the card does not offer a
 * standing grant that could never apply.
 *
 * Amounts (two-person approval, D8, and a grant's maxAmount), the same rule in every bucket:
 * amountField names the money the route's ANSWER carries (lib/agent/facts.ts takes the larger of
 * the body's and the answer's figure), and a '*' path adds up one figure per row. Entering, changing
 * and voiding a check, deposit or transfer names the amount its answer carries (expense.total, a
 * deposit's total, a transfer's amount); a void answers with the record, whose amount stays as it
 * was. A request with no amount counts as over every amount limit (policy.ts needsTwoPerson,
 * grantCovers) until its dry run. After it the bridge (lib/agent/bridge.ts factsFor) reads the
 * run's whole ledger: the entries it posted, and the entries already in the books that it voided,
 * deleted or changed in place. A void posts nothing new (posting.ts voidJournalEntry only marks the
 * entry void), but the bridge counts the voided entry at its total, and an entry deleted outright
 * at the total its audit row kept. With an amountField the amount is the larger of that field and
 * the largest single one of those entries (an amountField it cannot read stays over every limit).
 * With none it is all of them added up, except that a document an edit re-posts counts once, at
 * the larger of its new and its old entry (by source reference), and "0.00" only for a run that
 * made new records and posted no entry. A run that voided, deleted or changed a record that was
 * already there and touched no entry stays unknown (over every limit), as does one where a touched
 * entry's total cannot be read. So voiding a $50,000 journal entry is a $50,000 request after its
 * dry run, with or without an amountField: an amountField can only raise that figure. Entering or
 * editing a journal entry sets no amountField: the answer has its lines but no total, and the
 * entry it posts is its true size. The bulk bank feed routes (bulk, bulk-accept, bank-rules/run)
 * and recurring/run post one entry per line but answer no amounts, so after the dry run they are
 * judged by every entry they post, added up; they always ask, and the card's ledger preview lists
 * every entry.
 *
 * One request, two kinds of work: the Reconcile window's PATCH ticks lines and corrects the
 * statement (prepare work) but also completes the reconciliation and posts its adjustments
 * (change), by body.action; the bank feed's suggestions stay on this computer unless ai=1 asks
 * the company's AI model. An operation has one class (types.ts), so each is classed by its
 * riskiest work, and BANKING_CLASS_BY_INPUT below says how the input would class it. The policy
 * does not read that table yet: until types.ts has a field for a class that depends on the input,
 * ticking a line asks like completing, and a local suggestion asks like an AI one (fail closed).
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post", with a short verb; the real lists whose records live at another address also get
 * ".list" and ".create" (bank-accounts.list, bank-accounts.create).
 */
import type { ClassificationMap, OperationKey, RiskClass } from '../types';

/**
 * How one value of a request would class it, for a route whose one request does different kinds
 * of work. NOT READ BY THE POLICY: types.ts (OperationClassification) has no such field yet, so the
 * operation's own class is the strictest class of its table, and classes/banking.test.ts holds that
 * and that the table names every value the route acts on.
 */
export interface ClassByInput {
  /** Where the value is: a body field, or a query parameter (its first value, as the route reads it). */
  from: 'body' | 'query';
  field: string;
  /** The class for each value the route acts on. */
  classes: Readonly<Record<string, RiskClass>>;
  /** Any other value, or none: what the route then does. */
  otherwise: RiskClass;
}

export const BANKING_CLASS_BY_INPUT: Readonly<Partial<Record<OperationKey, ClassByInput>>> = {
  // Ticking lines and correcting the statement never reach the books and are undone by unticking
  // or cancelling (prepare, like starting the reconciliation). Completing it, with or without the
  // discrepancy adjustment, and the service charge and interest entries post (change). Any other
  // action is refused by the route; it is judged as the strictest.
  'PATCH /api/reconciliations/[id]': {
    from: 'body',
    field: 'action',
    classes: { setClearedMany: 'prepare', toggleCleared: 'prepare', updateStatement: 'prepare', complete: 'change', adjustments: 'change' },
    otherwise: 'change',
  },
  // Only ai=1 sends anything off this computer: the payee, description and amount of unsure lines
  // to the AI model the company set up, which may be a cloud service, and, when the owner turned
  // vendor lookup on, the payee name to that web lookup (llmSuggestBankCategory, lookupVendor).
  // Without it the suggestions come from the rules, the history and the learned model on this
  // computer: a read.
  'GET /api/bank-transactions/suggestions': {
    from: 'query',
    field: 'ai',
    classes: { '1': 'outside' },
    otherwise: 'read',
  },
};

export const BANKING_CLASSES: ClassificationMap = {
  // Bank accounts: the link between a real bank or card account and its GL account.
  'GET /api/bank-accounts': {
    class: 'read',
    id: 'bank-accounts.list',
    describe: 'List bank and credit card accounts',
    reveal: 'account_numbers',
    sensitiveFields: ['*.accountNumber'],
  },
  'POST /api/bank-accounts': {
    class: 'enter',
    id: 'bank-accounts.create',
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
      'Suggest accounts for the bank feed lines of bank account {bankAccountId} (ai: {ai}; with ai 1, the payee, description and amount of unsure lines go to the company\'s AI model)',
    why:
      'Classed by its riskiest form. With ai=1 the low-confidence lines (payee, description, amount) are sent to the AI model the company set up, which may be a cloud service, and, when the owner turned vendor lookup on, the payee name to that web lookup, so that form leaves this computer. ' +
      'Without ai=1 nothing leaves it: the suggestions come from the bank rules, the history and the learned model on this computer, and the only write is the refresh of that learned model (ai_categorizer_models), which an agent\'s read-only run cannot make (its opinion is then left out). ' +
      'That form would be a read, but an operation has one class, so it asks too until the policy can class a request by its query (BANKING_CLASS_BY_INPUT). ' +
      'Suggestions from the rules and the history alone are a read: the curated bank_feed_suggestions action. No dry run: a preview would send the same lines out.',
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
    why: 'Voids the entry that adding the line created (or only clears the link to an older entry, which stays as it was) and puts the line back in review. The amount is the line\'s own amount in the answer (the feed line). After the dry run the bridge also counts the entry the run voided, at its total, and the larger of the two is the amount.',
    amountField: 'amount',
  },
  'POST /api/bank-transactions/exclude': {
    class: 'change',
    describe: 'Exclude bank feed line {bankTransactionId} from review, or restore it',
    why:
      'Nothing reaches the ledger, but an excluded line is never recorded and leaves the review list; it shows again only under Excluded. A real charge excluded is missing from the books until someone finds it, at the latest when the account is reconciled and the difference shows. ' +
      'That is a bookkeeping decision about a line whose text outsiders wrote and the agent read, so excluding is a change, not prepare: under "Ask for every change" (the default) a person sees each one, and a policy that lets changes run lets this run too. ' +
      'Ticking a reconciliation line is different: it would be prepare once the policy can class a request by its body.action (see PATCH /api/reconciliations/[id]), and today it is a change as well. restore: true brings the line back.',
  },
  'POST /api/bank-transactions/bulk': {
    class: 'bulk',
    describe:
      'Post or re-suggest every waiting bank feed line of bank account {bankAccountId} (action: {action}; categorizeSuggested posts, applyRules re-suggests)',
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
    id: 'bank-rules.offers.answer',
    describe: 'Answer the suggested bank rule for {pattern} (action: {action})',
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
    id: 'rules.list',
    describe: 'List categorization rules',
  },
  'POST /api/rules': {
    class: 'enter',
    id: 'rules.create',
    describe: 'Add categorization rule {name}',
  },

  // Sample data for trying the bank feed.
  'POST /api/demo-feed': {
    class: 'enter',
    describe: 'Load 8 made-up sample lines into the real bank feed of bank account {bankAccountId}',
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
    describe: 'Enter a transaction of {amount} in the register of account {accountId} (side: {side})',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'amount',
  },
  'DELETE /api/registers/[accountId]': {
    class: 'remove',
    describe: 'Void or delete the transaction of entry {entryId} in the register of account {accountId} (action: {action}; void when left out)',
    why:
      'action=void keeps the transaction, marked void, but action=delete removes it for good. One class covers both, so it is the stricter one. ' +
      'No amountField: the answer is only { key, ok, action }. Until the dry run the amount is unknown and counts as over every amount limit. ' +
      'After it the bridge counts the entry the run voided or deleted at its total (read from the audit row when the entry itself is gone); when that total cannot be read, the amount stays unknown.',
  },

  // Checks and expenses (Write Checks, cash expenses, credit card charges).
  'GET /api/expenses': {
    class: 'read',
    describe: 'List checks and expenses',
  },
  'POST /api/expenses': {
    class: 'enter',
    describe: 'Write an expense (paid by {method}) dated {date} from account {paymentAccountId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'expense.total',
  },
  'GET /api/expenses/[id]': {
    class: 'read',
    describe: 'Show check or expense {id}',
  },
  'PATCH /api/expenses/[id]': {
    class: 'change',
    describe: 'Change check or expense {id}',
    confirmFlags: ['allowDuplicateNumber', 'allowReconciledEdit'],
    amountField: 'expense.total',
  },
  'DELETE /api/expenses/[id]': {
    class: 'change',
    describe: 'Void check or expense {id}',
    why: 'Voids, does not delete: the check stays in the books with its entry reversed. The answer is the voided check with its total as it was.',
    amountField: 'expense.total',
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
    class: 'read_sensitive',
    describe: 'Make a check PDF',
    why:
      'Only renders a PDF (a recorded check, a batch, a one-off check or an alignment test page); nothing is recorded: numbers are recorded by the print queue, and printing on paper is a separate print operation. ' +
      'But it is protected data: a recorded check prints the payee\'s full account number (vendor, Other Name or sales tax agency) on the memo line and the voucher stub for every caller, as the payee needs it to apply the payment (printQueue.ts checkPrintData), and nothing can mask a PDF. ' +
      'So it always asks someone with "view full account numbers" (reveal account_numbers), one PDF at a time. One operation covers every mode, so a one-off check or a test page asks too.',
    reveal: 'account_numbers',
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

  // Print Checks queue: checks to print, a print run, and "Did the checks print OK?". A queued
  // check's memo is "Acct # <the payee's full account number>" when left blank (a Sales Tax Payment
  // check stores it so); the listing and the check answers mask it for a caller without "view full
  // account numbers" (printQueue.ts and liabilityPayments.ts checkMemoFor), so a reveal shows it.
  'GET /api/print-queue': {
    class: 'read',
    id: 'print-queue.list',
    describe: 'List checks waiting to print',
    why: 'The memo of each check is masked to the last 4 digits of the account number unless revealed (listPrintQueue masks it).',
    reveal: 'account_numbers',
  },
  'POST /api/print-queue': {
    class: 'print',
    id: 'print-queue.mark-printed',
    describe: 'Record check {id} (kind: {source}) as printed with check number {checkNumber}',
    why: 'Marks one queued check printed and stamps its number on the check and its entry. The answer is the check; a Sales Tax Payment check answers its stored memo masked like the listing.',
    confirmFlags: ['allowDuplicateNumber'],
    reveal: 'account_numbers',
  },
  'GET /api/print-queue/paychecks': {
    class: 'read',
    describe: 'List paychecks not yet printed or queued',
  },
  'POST /api/print-queue/paychecks': {
    class: 'bulk',
    id: 'print-queue.paychecks.add',
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
    id: 'print-queue.refunds.add',
    describe: 'Put customer refund {entryId} in the check print queue',
    why: 'Adds a check document for a refund that is already posted. No new ledger entry. The answer is the queued check, its memo masked like the print queue\'s (an account number in a typed memo shows only its last 4 digits unless revealed).',
    reveal: 'account_numbers',
    sensitiveFields: ['memo'],
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
    describe: 'Put printed check {id} (kind: {source}) back in the print queue to print again',
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
    amountField: 'total',
  },
  'GET /api/deposits/[id]': {
    class: 'read',
    describe: 'Show deposit {id}',
  },
  'PATCH /api/deposits/[id]': {
    class: 'change',
    describe: 'Change deposit {id}',
    confirmFlags: ['allowReconciledEdit'],
    amountField: 'total',
  },
  'DELETE /api/deposits/[id]': {
    class: 'change',
    describe: 'Void deposit {id}',
    why: 'Voids, does not delete: the deposit stays with its entry reversed, and its payments go back to Undeposited Funds. The answer is the voided deposit with its total as it was.',
    amountField: 'total',
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
    why: 'Voids, does not delete: the transfer stays with its entry reversed. The answer is the voided transfer with its amount as it was.',
    amountField: 'amount',
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
    why: 'Voids, does not delete: the entry stays with its amounts reversed. Voiding a depreciation entry also takes that period off the fixed asset (its schedule row is removed and its accumulated depreciation lowered); the period can be posted again. No amountField: the answer is the entry row, with no total and no lines. Until the dry run the amount is unknown and counts as over every amount limit. After it the bridge counts the entry the run voided at its total (its debits added up), so voiding a $50,000 entry is a $50,000 request.',
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
    describe: 'Work on reconciliation {id} (action: {action})',
    why:
      'One request for every action. setClearedMany, toggleCleared and updateStatement tick lines and correct the statement: prepare work, nothing reaches the books. complete (with adjust: true, after posting the difference to Reconciliation Discrepancies) marks every ticked line reconciled, and adjustments posts the service charge and interest entries: change. ' +
      'An operation has one class, so it is the stricter one, and ticking a line asks wherever completing would, until the policy can class a request by its body.action (BANKING_CLASS_BY_INPUT).',
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
    describe: 'Memorize a transaction named {name} ({docType}) to repeat {frequency}',
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
    describe: 'Recall the last form ({form}) of vendor {vendorId}',
  },
  'GET /api/smart-defaults/sales': {
    class: 'read',
    describe: 'Recall the last form ({form}) of customer {customerId}',
  },
};
