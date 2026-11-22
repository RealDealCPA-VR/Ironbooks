/**
 * Agent full access: classification of the "payroll" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/payroll.test.ts.
 *
 * Masking (plan §5.9): the app masks SSNs and state account numbers unless the caller has
 * "view sensitive payroll data" / "view full account numbers" (lib/permissions/mask.ts). Routes
 * that mask keep their ordinary class and carry `reveal`, so an unmasked answer is a separate,
 * approved request. Nothing else in payroll is masked by the app but an account number in a
 * liability check's memo (see there), so paychecks, pay stubs and the payroll forms are ordinary
 * reads. That departs on purpose from the plan's §5.9 list
 * (paystub, W-3/941/940 as read_sensitive): the stub carries only names and pay a payroll user
 * already sees on the paycheck, and W-3/941/940 carry only the company's EIN. The state wage
 * worksheet shows employees by the last 4 digits of the SSN only (no caller sees more there) and
 * masks the employer's state account number like the state settings list, so it is a read whose
 * reveal is that account number.
 *
 * Amounts (two-person approval, D8, and a grant's maxAmount), the same rule in every bucket:
 * amountField names the money the route's ANSWER carries (lib/agent/facts.ts takes the larger of
 * the body's and the answer's figure, so a typed figure the route ignores cannot lower it). Where the
 * answer lists one figure per row, a '*' path adds them up. A request with no amount counts as over
 * every amount limit until its dry run. After it the bridge (lib/agent/bridge.ts factsFor) reads the
 * run's whole ledger: the entries it posted, and the entries already in the books that it voided,
 * deleted or changed in place. With an amountField the amount is the larger of that field and the
 * largest SINGLE one of those entries (an amountField it cannot read stays over every limit), so a
 * route that posts an entry per row names its rows with '*'. With none it is all of them added up,
 * and "0.00" only for a run that made new records and posted no entry. A void posts nothing new
 * (voidJournalEntry only marks the entry void), but the bridge counts the voided entry at its
 * total: voiding a paycheck is sized by the paycheck's entry after its dry run. A void that touches
 * no entry (a payroll adjustment entered without affectsAccounts never posted one) changed a
 * record that was already there, so its amount stays unknown, over every limit: its year-to-date
 * figures still leave the W-2, the 941 and the 940.
 *
 * Paychecks: writing or editing one pays a person, so both always ask, like a pay run. Their
 * amountField is the gross pay in the route's ANSWER (the preview or dry run), never the body:
 * the service ignores a typed grossPay whenever earnings lines are sent. A pay run adds up the gross
 * pay of every check it wrote (results.*.grossPay), never one check's. Voiding a liability check
 * names its amount (the void answers with the check, its amount as it was).
 *
 * Payroll adjustments change the W-2, the 941 and the 940 whether or not they post, so entering one
 * and voiding one both always ask, and so does voiding a paycheck, since that route voids any
 * payroll row, an adjustment too. Entering one names grossPay, and the bridge takes the larger of
 * that and the entry the run posts. A year-to-date adjustment's grossPay is its gross wages; its
 * entry, when affectsAccounts posts one, debits the wages and the employer taxes. So a posting one
 * is sized by its entry, and one that posts nothing by its gross wages. A liability adjustment
 * answers grossPay 0, so only its entry sizes it. One that posts no entry (entered without
 * affectsAccounts, or whose lines net to nothing on every account, so netLines posts nothing)
 * reads "0.00", and so does a year-to-date one that posts nothing and holds only employer
 * contribution lines, although their lines still change the 941 and the 940. No single answer
 * field is right for both kinds: adding up the lines (lines.*.amount, the field before) counted a
 * year-to-date adjustment's withholding a second time. Every adjustment still asks a person
 * (alwaysAsk, so no standing permission covers one); the lower figure reaches only the two-person
 * rule and the amount the card shows. Voiding answers the bare row: no amountField, and the entry
 * the void touched decides (unknown when there is none).
 *
 * Payroll items (the cross-bucket rule, with planning.ts): an item edit stays 'change', since plan
 * §8 lists payroll items with the list entries and an item's rate is not what paychecks charge. But
 * its tax tracking, pre-tax mark and posting accounts decide the taxable wages, W-2 boxes and
 * accounts of every later paycheck, so an edit always asks. One route carries every field, so every
 * edit asks.
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post" or a word that misleads: GET /api/pay-liabilities only shows what is due
 * (pay-liabilities.due), its POST pays (pay-liabilities.pay).
 */
import type { ClassificationMap } from '../types';

export const PAYROLL_CLASSES: ClassificationMap = {
  // Employees: the SSN comes back as the last 4 digits unless revealed.
  'GET /api/employees': {
    class: 'read',
    describe: 'List employees',
    reveal: 'ssn',
    sensitiveFields: ['*.ssn'],
  },
  'POST /api/employees': {
    class: 'enter',
    describe: 'Add employee {firstName} {lastName}',
  },
  'GET /api/employees/[id]': {
    class: 'read',
    describe: 'Show employee {id}',
    why: 'The route masks the SSN by default (last 4 digits), so the masked read is ordinary and only a reveal is protected.',
    reveal: 'ssn',
    sensitiveFields: ['ssn'],
  },
  'PATCH /api/employees/[id]': {
    class: 'change',
    describe: 'Change employee {id}',
    // The body may carry a full SSN the agent typed; the answer is masked like the GET.
    reveal: 'ssn',
    sensitiveFields: ['ssn'],
  },
  'POST /api/employees/[id]/portal-password': {
    class: 'secret',
    describe: 'Set the employee portal password of employee {id}',
    why: 'The input is a sign-in password for the employee portal. The approver types it on the card; it is never stored or shown to the agent. The route reads it from the body field "password" (not a header), so the bridge puts the typed password there and drops any password the agent sent. No dry run: the route refuses a request without the password, and the password only arrives with the approval.',
    needsSecret: ['portal_password'],
    sensitiveFields: ['password'],
    dryRun: 'none',
  },
  'DELETE /api/employees/[id]/portal-password': {
    class: 'remove',
    describe: 'Remove the employee portal access of employee {id}',
    why: 'Clears the stored portal password and signs the employee out of the portal everywhere. It cannot be undone; access comes back only when someone sets a new password.',
  },

  // Payroll items: the list of earnings, taxes and deductions paychecks post with.
  'GET /api/payroll-items': {
    class: 'read',
    describe: 'List payroll items',
    why:
      'Reads only. A person\'s first visit on a company with no payroll items adds the standard set (about 15 items, with audit rows) for any role but viewer, as it always has. ' +
      'An agent\'s read never does: the route skips it for an agent, and ensureDefaultPayrollItems for any read-only context, so the read answers with what is there, an empty list on such a company.',
  },
  'POST /api/payroll-items': {
    class: 'enter',
    describe: 'Add payroll item {name}',
  },
  'GET /api/payroll-items/[id]': {
    class: 'read',
    describe: 'Show payroll item {id}',
  },
  'PATCH /api/payroll-items/[id]': {
    class: 'change',
    describe: 'Change payroll item {id} (its tax tracking, pre-tax mark or accounts steer every later paycheck)',
    why: "An entry of the payroll item list (plan §8 lists payroll items with the list entries, not with payroll setup). Unlike a workers' comp code, an item's rate is not what paychecks charge: taxes come from the tax tables and the state settings. But the item's tax tracking, pre-tax mark and accounts decide the taxable wages, W-2 boxes and posting accounts of every later paycheck, so an edit always asks, never runs on its own policy or a standing permission. The route takes every field in one body, so a rename asks too.",
    alwaysAsk: true,
  },

  // Paychecks: one check at a time. Pay runs are below.
  'GET /api/payroll': {
    class: 'read',
    describe: 'List paychecks',
  },
  'POST /api/payroll': {
    class: 'enter',
    describe: 'Write a paycheck to employee {employeeId} dated {payDate}',
    why: 'Posts the paycheck and its ledger entry. "?preview=true" only calculates the check and is the dry run. A single paycheck is a pay run of one person, so it always asks, like a pay run; otherwise an agent could pay people one check at a time without asking. The amount is the grossPay of the preview answer: a grossPay typed in the body is ignored whenever earnings lines are sent.',
    dryRun: 'preview',
    amountField: 'grossPay',
    alwaysAsk: true,
  },
  'GET /api/payroll/[id]': {
    class: 'read',
    describe: 'Show paycheck {id}',
  },
  'PATCH /api/payroll/[id]': {
    class: 'change',
    describe: 'Edit paycheck {id}',
    why: 'Voids the posted entry, works the check out again at the new pay and posts it again. Editing a check can pay a person any amount, the same as writing one, so it always asks like a new paycheck; otherwise a small approved check could be edited up without asking. The amount is the grossPay of the dry-run answer: a grossPay typed in the body is ignored whenever earnings lines are sent.',
    amountField: 'grossPay',
    alwaysAsk: true,
  },
  'DELETE /api/payroll/[id]': {
    class: 'change',
    describe: 'Void paycheck {id}',
    why: "Voids the paycheck and its ledger entry; the check stays on file marked void. Nothing is deleted. voidPaycheck takes any payroll row, a payroll adjustment too, and voiding one takes its figures off the W-2, the 941 and the 940, so this always asks, like entering an adjustment or writing a paycheck. No amountField: a liability adjustment's grossPay is 0, so the answer's grossPay could read a large void as 0. Until the dry run the amount is unknown and counts as over every amount limit. After it the bridge counts the paycheck's entry, which the void marks void (it posts nothing new), at its total, its debits added up. A payroll row that never posted an entry keeps the amount unknown, not 0.00.",
    alwaysAsk: true,
  },

  // Pay runs: many paychecks in one request.
  'GET /api/payroll/pay-runs': {
    class: 'read',
    id: 'payroll.pay-runs.list',
    describe: 'List pay runs',
  },
  'POST /api/payroll/pay-runs': {
    class: 'bulk',
    id: 'payroll.pay-runs.create',
    describe: 'Run payroll dated {payDate} for the employees listed',
    why: "One paycheck per employee listed, each posted on its own (a refused employee does not stop the others). The amount is the total gross pay of the run: the answer lists each paycheck's grossPay under results, and results.*.grossPay adds them up (a refused employee has none). Each check posts its own ledger entry, and with an amountField the bridge compares the field only with the largest single entry, so the field must be the whole run's. Before the dry run has answered, the amount is unknown and counts as over every amount limit.",
    countField: 'employees',
    amountField: 'results.*.grossPay',
    alwaysAsk: true,
  },

  // Calculators and lookups used while writing a paycheck.
  'POST /api/payroll/calc': {
    class: 'read',
    describe: 'Calculate federal withholding on {grossPerPeriod} per pay period',
    why: 'Only calculates from the tax tables; saves nothing.',
  },
  'POST /api/payroll/state-tax': {
    class: 'read',
    describe: 'Calculate {state} state withholding on {grossPerPeriod} per pay period',
    why: 'Only calculates from the tax tables; saves nothing.',
  },
  'GET /api/payroll/unpaid-time': {
    class: 'read',
    describe: 'List the unpaid time of employee {employeeId} from {periodStart} to {periodEnd}',
  },

  // Year-to-date and liability adjustments.
  'GET /api/payroll/adjustments': {
    class: 'read',
    describe: 'List payroll year-to-date and liability adjustments',
  },
  'POST /api/payroll/adjustments': {
    class: 'enter',
    describe: 'Enter a payroll adjustment for employee {employeeId} dated {date} (type: {type})',
    why: "Year-to-date amounts land on the employee's W-2, the 941 and 940, and the wage bases of later checks. With affectsAccounts, a year-to-date adjustment posts net pay out of a bank account like a paycheck, and a liability adjustment moves what payroll owes. So it always asks, like a paycheck. The amount is the answer's grossPay, or the entry the dry run posts when that is larger, as it is for every posting adjustment (a year-to-date entry debits the wages and the employer taxes; a liability adjustment has grossPay 0, so only its entry counts). A year-to-date adjustment that posts nothing is sized by its gross wages, what the W-2 gains. A liability adjustment that posts nothing (no affectsAccounts, or lines that net to nothing on every account), and a year-to-date one that posts nothing and holds only employer contribution lines, read 0.00, although their lines still change the 941 and the 940; it still asks a person, and its lines are in the request. Adding up the lines instead would count a year-to-date adjustment's withholding a second time.",
    amountField: 'grossPay',
    alwaysAsk: true,
  },
  'DELETE /api/payroll/adjustments/[id]': {
    class: 'change',
    describe: 'Void payroll adjustment {id}',
    why: "Voids the adjustment (and its ledger entry when it has one); it stays on file marked void. Nothing is deleted. Its year-to-date figures leave the W-2, the 941 and the 940 whether or not it posted, so voiding always asks, as entering one does. No amountField: the void answers the bare row, without the lines that entering it answers, and its grossPay is 0 for a liability adjustment. Until the dry run the amount is unknown and counts as over every amount limit. After it the bridge counts the adjustment's entry, which the void marks void, at its total. An adjustment entered without affectsAccounts has no entry, so the amount of its void stays unknown, not 0.00.",
    alwaysAsk: true,
  },

  // Payroll setup: state tax rates, workers' comp codes, sick and vacation accruals (plan §8).
  'GET /api/payroll/state-settings': {
    class: 'read',
    describe: 'List state unemployment and disability tax settings',
    reveal: 'account_numbers',
    sensitiveFields: ['*.accountNumber'],
  },
  'POST /api/payroll/state-settings': {
    class: 'settings',
    describe: 'Set {state} unemployment and disability tax rates for {year}',
    why: 'Payroll tax setup: these rates drive every later paycheck in that state.',
    reveal: 'account_numbers',
    sensitiveFields: ['accountNumber'],
  },
  'DELETE /api/payroll/state-settings/[id]': {
    class: 'remove',
    describe: 'Remove state tax settings {id}',
    why: "Deletes the row for good (no void or inactive mark), and later paychecks in that state then accrue without those rates. The answer is the removed row, masked like the list.",
    reveal: 'account_numbers',
    sensitiveFields: ['accountNumber'],
  },
  'GET /api/payroll/workers-comp': {
    class: 'read',
    describe: "List workers' comp class codes",
  },
  'POST /api/payroll/workers-comp': {
    class: 'settings',
    describe: "Add workers' comp class code {code}",
    why: "Payroll setup: a class code's rate is the premium every later paycheck accrues (unlike a payroll item's rate, which paychecks do not use).",
  },
  'PATCH /api/payroll/workers-comp/[id]': {
    class: 'settings',
    describe: "Change workers' comp class code {id}",
    why: "Payroll setup: a class code's rate is the premium every later paycheck accrues (unlike a payroll item's rate, which paychecks do not use).",
  },
  'GET /api/payroll/accruals': {
    class: 'read',
    describe: 'List sick and vacation balances',
  },
  'PUT /api/payroll/accruals': {
    class: 'settings',
    describe: 'Set the sick and vacation accrual policy of employee {employeeId}',
    why: 'Payroll setup: the policy decides the hours every later paycheck accrues.',
  },

  // Pay stubs, payroll reports and payroll forms (PDF for viewing; nothing is printed).
  'GET /api/payroll/paystub': {
    class: 'read',
    describe: 'Show the pay stub of paycheck {paycheckId}',
    why: 'The stub holds no SSN or account number, only pay a person with payroll rights already sees on the paycheck, so it is an ordinary read. The PDF is for viewing; nothing is printed.',
    output: 'pdf',
  },
  'GET /api/payroll/reports': {
    class: 'read',
    describe: 'Run payroll reports from {from} to {to}',
  },
  'GET /api/payroll/state-wage-worksheet': {
    class: 'read',
    describe: 'Show the state wage worksheet of {state} for {year} (quarter {quarter})',
    why: "Employees show by the last 4 digits of the SSN for every caller (the service never answers more of it, so there is no SSN to reveal), and the employer's state account number is masked to its last 4 digits unless the caller may view full account numbers, as on the state settings list (payrollReports.ts stateWageWorksheet). So the worksheet is an ordinary read, and only revealing that account number is protected.",
    reveal: 'account_numbers',
    sensitiveFields: ['accountNumber'],
  },
  'GET /api/payroll/941': {
    class: 'read',
    describe: 'Show Form 941 for {year} (quarter {quarter})',
    output: 'pdf',
  },
  'GET /api/payroll/940': {
    class: 'read',
    describe: 'Show Form 940 for {year}',
    output: 'pdf',
  },
  'GET /api/payroll/w2': {
    class: 'read',
    describe: 'Show the W-2 of employee {employeeId} for {year}',
    why: 'The route prints the SSN masked to the last 4 digits by default, so the masked form is an ordinary read and only a reveal is protected.',
    reveal: 'ssn',
    output: 'pdf',
  },
  'GET /api/payroll/w3': {
    class: 'read',
    describe: 'Show Form W-3 for {year}',
    output: 'pdf',
  },

  // Payroll liabilities: paying what payroll owes, and the liability checks that pay it.
  'GET /api/pay-liabilities': {
    class: 'read',
    id: 'pay-liabilities.due',
    describe: 'Show payroll liabilities due',
  },
  'POST /api/pay-liabilities': {
    class: 'enter',
    id: 'pay-liabilities.pay',
    describe: 'Pay {amount} of payroll liabilities from account {paymentAccountId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'amount',
  },
  'GET /api/pay-liabilities/by-item': {
    class: 'read',
    describe: 'Show payroll liability balances by item',
  },
  'POST /api/pay-liabilities/by-item': {
    class: 'enter',
    id: 'pay-liabilities.by-item.pay',
    describe: 'Pay payroll liabilities by item from account {paymentAccountId} dated {date}',
    why: 'Pays out of a bank account. The total is the sum of items[].amount (the route ignores a body "amount", so a typed one could be made up), and items.*.amount adds them up. The answer is the one journal entry (credit the bank for the total), so after the dry run its ledger entry gives the same figure.',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'items.*.amount',
  },
  // A liability check's memo can hold an account number someone typed; every check answer masks it
  // for a caller without "view full account numbers" (liabilityPayments.ts checkMemoFor), as for
  // the Sales Tax Payment checks in planning.ts, so a reveal shows it.
  'GET /api/pay-liabilities/checks': {
    class: 'read',
    describe: 'List payroll liability checks',
    why: 'The memo of each check is masked to the last 4 digits of an account number in it unless revealed (listPaymentChecks masks it).',
    reveal: 'account_numbers',
    sensitiveFields: ['items.*.memo'],
  },
  'POST /api/pay-liabilities/checks/[id]': {
    class: 'change',
    describe: 'Void payroll liability check {id}',
    why: 'The only action is "void": the check and its ledger entry are voided and the check stays on file marked void. The answer is the voided check, its amount as it was and its memo masked.',
    amountField: 'amount',
    reveal: 'account_numbers',
    sensitiveFields: ['memo'],
  },
  'GET /api/pay-liabilities/sales-tax': {
    class: 'read',
    describe: 'Show sales tax owed by agency',
  },

  // Employee portal: an employee signed in as themselves (plan §8, auth routes stay person-only).
  'POST /api/portal/login': {
    class: 'secret',
    describe: 'Sign in to the employee portal as {email}',
    availability: 'person_only',
    why: 'An employee signing in to their own portal with their own password. Not something an agent asks for.',
    sensitiveFields: ['password'],
    dryRun: 'none',
  },
  'POST /api/portal/logout': {
    class: 'admin',
    describe: 'Sign out of the employee portal',
    availability: 'person_only',
    why: "An employee ending their own portal session (it ends every copy of that session). Not something an agent asks for.",
    body: 'none',
    dryRun: 'none',
  },
  'GET /api/portal/me': {
    class: 'read',
    describe: "Show the signed-in employee's own paychecks",
    availability: 'person_only',
    why: "The employee portal's own page: it answers only to an employee's portal sign-in, never to the app's users or agents.",
  },
};
