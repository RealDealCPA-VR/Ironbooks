/**
 * Zod schemas for expense reports (POST /api/expense-reports, POST /api/expense-reports/:id;
 * lib/services/expenseReports.ts).
 *
 * These routes read their body by hand, and the handler's and the service's own checks give the
 * messages they always gave. The schema is checked after the handler's checks: it says what each
 * field is, for agents (describe_operation, plan §6.3). Every field the handler does not check
 * itself is zLenient (the service checks it, with its own message), so what each route accepts is
 * unchanged; "Required" in a description means the service refuses the report without it.
 */
import { z } from 'zod';
import { zLenient, zUuid } from './helpers';

/** POST /api/expense-reports — a new expense report, saved as a draft (no entry is posted). */
export const createExpenseReportSchema = z.object({
  employeeId: zLenient(zUuid).describe('Id of the employee (employee list) who spent the money and is paid back. Required.'),
  title: z.string().nullish().describe('Title of the report, such as "March travel"; leave out for none.'),
  lines: zLenient(
    z.array(
      z.object({
        accountId: zLenient(zUuid).describe('Id of the expense account (chart of accounts) the line is charged to. Required.'),
        date: zLenient(z.string().nullable()).describe('Date of the expense, YYYY-MM-DD; leave out for none.'),
        description: zLenient(z.string().nullable()).describe('What the money was spent on; leave out for none.'),
        amount: zLenient(z.union([z.string(), z.number()])).describe('Amount spent, as decimal text above zero such as "42.50". Required.'),
      }),
    ),
  ).describe('The expenses on the report, at least one. Required.'),
});

/** POST /api/expense-reports/:id — move the report on: submit it, or reimburse it. */
export const expenseReportActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('submit').describe('submit: send a draft report on for approval.'),
  }),
  z.object({
    action: z
      .literal('reimburse')
      .describe('reimburse: approve a submitted report and pay the employee back, posting the expenses against the bank account.'),
    bankAccountId: zLenient(zUuid.nullable()).describe(
      'Id of the active home-currency bank account (chart of accounts) the reimbursement is paid from; leave out for the usual checking account.',
    ),
  }),
]);
