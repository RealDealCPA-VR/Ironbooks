/**
 * Zod schemas for /api/expenses — mirrors CreateExpenseInput / ExpenseLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const expenseLineSchema = z
  .object({
    /** Expenses tab: GL account. Items tab: optional override for non-inventory items. */
    accountId: zUuid.nullish(),
    /** Items tab (wave2 D2). */
    itemId: zUuid.nullish(),
    quantity: zDecimal.nullish(),
    unitCost: zDecimal.nullish(),
    description: z.string().nullish(),
    /** Positive normally; all-negative lines flip into a credit-card credit. */
    amount: zMoney.nullish(),
    classId: zUuid.nullish(),
    customerId: zUuid.nullish(),
    jobId: zUuid.nullish(),
    /** Advanced Inventory: receiving site/bin/serial/lot (inventory item lines only). */
    ...inventoryLineFields,
  })
  .refine((l) => Boolean(l.accountId) || Boolean(l.itemId), {
    message: 'Pick an account or an item.',
    path: ['accountId'],
  })
  .refine((l) => Boolean(l.itemId) || (l.amount !== undefined && l.amount !== null), {
    message: 'amount is required',
    path: ['amount'],
  });

export const createExpenseSchema = z
  .object({
    vendorId: zUuid.nullish(),
    /** B3: payee from the Other Names list (instead of a vendor). */
    otherNameId: zUuid.nullish(),
    payeeName: z.string().max(255, 'can be at most 255 characters').nullish(),
    date: zDate,
    method: z.enum(['check', 'cash', 'credit_card'], {
      errorMap: () => ({ message: "method must be 'check', 'cash', or 'credit_card'" }),
    }),
    reference: z.string().max(100, 'can be at most 100 characters').nullish(),
    paymentAccountId: zUuid,
    memo: z.string().nullish(),
    toPrint: z.boolean().optional(),
    isRefund: z.boolean().optional(),
    /** Multi-currency (defaults from the payment account / vendor). */
    currency: z.string().max(3).nullish(),
    exchangeRate: zDecimal.nullish(),
    /** The user saw the duplicate check-number warning and chose to keep the number. */
    allowDuplicateNumber: z.boolean().optional(),
    lines: zLines(expenseLineSchema),
  })
  .refine((e) => Boolean(e.vendorId) || Boolean(e.otherNameId) || Boolean(e.payeeName?.trim()), {
    message: 'Provide a vendorId, an otherNameId or a payeeName.',
    path: ['payeeName'],
  })
  .refine((e) => !(e.vendorId && e.otherNameId), {
    message: 'Pick either a vendor or an Other Names entry as the payee, not both.',
    path: ['otherNameId'],
  });
export type CreateExpenseBody = z.infer<typeof createExpenseSchema>;
