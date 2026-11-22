/**
 * Zod schemas for paying liabilities with a check (POST /api/sales-tax/pay, POST
 * /api/pay-liabilities; lib/services/liabilityPayments.ts).
 *
 * These routes read their body by hand, and their own checks answer first with the messages they
 * always gave. The schema is checked after them: it says what each field is, for agents
 * (describe_operation, plan §6.3). A field the handler ignores or converts when it has another type
 * is zLenient, so what each route accepts is unchanged.
 */
import { z } from 'zod';
import { zLenient, zUuid } from './helpers';

const checkFields = {
  memo: zLenient(z.string().nullable()).describe('Memo printed on the check; leave out for none.'),
  checkNumber: zLenient(z.string().nullable()).describe(
    'Number of the check; leave out to use the next check number of the bank account, or no number yet when toPrint is true.',
  ),
  toPrint: zLenient(z.boolean()).describe('true puts the check in the print queue, and its number is given when it is printed; leave out for a check written now.'),
  allowDuplicateNumber: zLenient(z.boolean()).describe(
    'Send true only after the app warned that this check number is already used on the account, to keep it.',
  ),
};

/** POST /api/sales-tax/pay — QB Pay Sales Tax: one Sales Tax Payment check per agency. */
export const paySalesTaxSchema = z.object({
  date: z.string().describe('Date of the checks, YYYY-MM-DD.'),
  paymentAccountId: z.string().min(1).describe('Id of the bank account the checks are written from (chart of accounts).'),
  payments: z
    .array(
      zLenient(
        z.object({
          agencyId: zUuid.describe('Id of the tax agency paid (from GET /api/sales-tax/pay, rows).'),
          amount: z.union([z.string(), z.number()]).describe('Amount paid to that agency, as decimal text above zero such as "412.50".'),
        }),
      ),
    )
    .min(1)
    .describe('The agencies paid and how much each, one check per agency; each agency at most once.'),
  ...checkFields,
  memo: checkFields.memo.describe("Memo on every check; leave out to print the agency's account number, when its vendor record has one."),
  checkNumber: checkFields.checkNumber.describe(
    'Number of the first check (each further agency gets the following number); leave out to use the next check number of the bank account, or no number yet when toPrint is true.',
  ),
  dueThrough: zLenient(z.string().nullable()).describe(
    'The pay-through date, YYYY-MM-DD, the amounts were worked out for (GET /api/sales-tax/pay); kept with the payment in the audit trail. Leave out for none.',
  ),
});

/** Who a payroll Liability Check is made out to. */
const payeeFields = {
  vendorId: zLenient(zUuid.nullable()).describe('Id of the vendor the check is made out to, such as the tax agency (vendor list); leave out to use payeeName.'),
  payeeName: zLenient(z.string().nullable()).describe('Name the check is made out to when no vendorId is given.'),
};

/** POST /api/pay-liabilities — pay payroll liabilities with a Liability Check. */
export const payPayrollLiabilitiesSchema = z.object({
  type: z
    .literal('payroll')
    .optional()
    .describe('Leave out, or "payroll". Sales tax is paid with POST /api/sales-tax/pay instead.'),
  amount: z
    .string()
    .regex(/^\s*\d+(\.\d{1,2})?\s*$/, 'amount must be an amount like 120.00.')
    .describe('Amount paid, as decimal text such as "1200.00".'),
  date: z.string().min(1).describe('Date of the check, YYYY-MM-DD.'),
  paymentAccountId: z.string().min(1).describe('Id of the bank account the check is written from (chart of accounts).'),
  ...payeeFields,
  ...checkFields,
});

/**
 * POST /api/pay-liabilities/by-item — QB Pay Scheduled Liabilities by payroll item: one Liability
 * Check for the total, one line per item. The route checks the date, the bank account and that
 * there is at least one item; the service checks each item.
 */
export const payLiabilitiesByItemSchema = z.object({
  date: z.string().describe('Date of the check, YYYY-MM-DD.'),
  paymentAccountId: z.string().min(1).describe('Id of the bank account the check is written from (chart of accounts).'),
  items: z
    .array(
      zLenient(
        z.object({
          name: z
            .string()
            .describe('Name of the payroll item paid, as GET /api/pay-liabilities/by-item lists it (items), such as "Federal Withholding"; it is the memo of its line.'),
          amount: z.union([z.string(), z.number()]).describe('Amount paid for that item, as decimal text above zero such as "412.50".'),
        }),
      ),
    )
    .min(1)
    .describe('The payroll items paid and how much each; the check is for their total.'),
  ...payeeFields,
  ...checkFields,
});

/** POST /api/sales-tax/payments/:id — void a Sales Tax Payment check. */
export const voidSalesTaxPaymentSchema = z.object({
  action: z
    .literal('void')
    .describe('void: void the check. It stays on file marked void, its entry is voided (the bank gets the money back) and the tax is owed again.'),
});

/** POST /api/pay-liabilities/checks/:id — void a payroll Liability Check. */
export const voidLiabilityCheckSchema = z.object({
  action: z
    .literal('void')
    .describe('void: void the check. It stays on file marked void, its entry is voided (the bank gets the money back) and the liabilities it paid are owed again.'),
});
