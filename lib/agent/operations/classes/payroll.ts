/**
 * Agent full access: classification of the "payroll" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/payroll.test.ts.
 *
 * Masking (plan §5.9): the app masks SSNs and state account numbers unless the caller has
 * "view sensitive payroll data" / "view full account numbers" (lib/permissions/mask.ts). Routes
 * that mask keep their ordinary class and carry `reveal`, so an unmasked answer is a separate,
 * approved request. Nothing else in payroll is masked by the app, so paychecks, pay stubs and
 * the payroll forms are ordinary reads. That departs on purpose from the plan's §5.9 list
 * (paystub, W-3/941/940 as read_sensitive): the stub carries only names and pay a payroll user
 * already sees on the paycheck, and W-3/941/940 carry only the company's EIN.
 *
 * Amounts (two-person approval, D8, and a grant's maxAmount), the same rule in every bucket:
 * amountField names the money the route's ANSWER carries (lib/agent/facts.ts takes the larger of
 * the body's and the answer's figure, so a typed figure the route ignores cannot lower it). Where the
 * answer lists one figure per row, a '*' path adds them up. A request with no amount counts as over
 * every amount limit until its dry run. After it the bridge (lib/agent/bridge.ts factsFor) takes the
 * larger of that figure and the largest SINGLE ledger entry the run posted (with no amountField, the
 * entry alone; an amountField it cannot read stays over every limit). One entry is the true size of
 * a request that posts one (a paycheck void, an adjustment), but only the largest row of one that
 * posts an entry per row, so a per-row route names its rows with '*'.
 *
 * Paychecks: writing or editing one pays a person, so both always ask, like a pay run. Their
 * amountField is the gross pay in the route's ANSWER (the preview or dry run), never the body:
 * the service ignores a typed grossPay whenever earnings lines are sent. A pay run adds up the gross
 * pay of every check it wrote (results.*.grossPay), never one check's. Voiding a liability check
 * names its amount (the void answers with the check, its amount as it was). Where no answer field
 * holds the money (an adjustment's money sits in grossPay for a year-to-date one but in totalTaxes
 * and totalDeductions for a liability one, whose grossPay is 0, and the paycheck void takes
 * adjustments too), no amountField is set rather than one that could read low: each posts one entry,
 * so after the dry run its ledger entry is the amount.
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
    class: 'enter',
    describe: 'List payroll items (adds the standard items on first use)',
    why: 'When the company has no payroll items yet, this GET first adds the standard set (about 15 items, with audit rows) for any role that can write. Every later call only reads, but the first one writes, so it is not a read. It can become a read once the standard set is added somewhere else (when the company is created, or by its own POST).',
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
    why: "Voids the paycheck and its ledger entry; the check stays on file marked void. Nothing is deleted. No amountField: voidPaycheck takes any payroll row, a payroll adjustment too, and a liability adjustment's grossPay is 0, so the answer's grossPay could read a large void as 0. The amount stays unknown until the ledger preview shows it and counts as over every amount limit.",
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
    why: "One paycheck per employee listed, each posted on its own (a refused employee does not stop the others). The amount is the total gross pay of the run: the answer lists each paycheck's grossPay under results, and results.*.grossPay adds them up (a refused employee has none). Each check posts its own ledger entry, so without this path the bridge would judge the run by its largest single check. Before the dry run has answered, the amount is unknown and counts as over every amount limit.",
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
    describe: 'List time of employee {employeeId} not yet paid from {periodStart} to {periodEnd}',
  },

  // Year-to-date and liability adjustments.
  'GET /api/payroll/adjustments': {
    class: 'read',
    describe: 'List payroll year-to-date and liability adjustments',
  },
  'POST /api/payroll/adjustments': {
    class: 'enter',
    describe: 'Enter a payroll adjustment ({type}) for employee {employeeId} dated {date}',
    why: "Year-to-date amounts land on the employee's W-2, the 941 and 940, and the wage bases of later checks. With affectsAccounts, a year-to-date adjustment posts net pay out of a bank account like a paycheck, and a liability adjustment moves what payroll owes. So it always asks, like a paycheck. No amountField: a year-to-date adjustment answers its money as grossPay, but a liability adjustment answers grossPay 0 with the money in totalTaxes and totalDeductions, so one path would read a large liability adjustment as 0. The amount stays unknown until the ledger preview shows it and counts as over every amount limit.",
    alwaysAsk: true,
  },
  'DELETE /api/payroll/adjustments/[id]': {
    class: 'change',
    describe: 'Void payroll adjustment {id}',
    why: 'Voids the adjustment (and its ledger entry when it has one); it stays on file marked void. Nothing is deleted. No amountField, for the same reason as entering one: a liability adjustment answers grossPay 0, so the amount counts as over every amount limit.',
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
    class: 'read_sensitive',
    describe: 'Show the {state} wage worksheet for quarter {quarter} of {year}',
    why: "Employees show by the last 4 digits of the SSN, but the employer's state account number comes back in full: unlike the state settings list, neither the route nor the service masks it. Until it does, the whole worksheet is protected data. Once it is masked, this becomes a read with reveal 'account_numbers'.",
    sensitiveFields: ['accountNumber'],
  },
  'GET /api/payroll/941': {
    class: 'read',
    describe: 'Show Form 941 for quarter {quarter} of {year}',
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
  'GET /api/pay-liabilities/checks': {
    class: 'read',
    describe: 'List payroll liability checks',
  },
  'POST /api/pay-liabilities/checks/[id]': {
    class: 'change',
    describe: 'Void payroll liability check {id}',
    why: 'The only action is "void": the check and its ledger entry are voided and the check stays on file marked void. The answer is the voided check with its amount as it was.',
    amountField: 'amount',
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
