/**
 * Zod schemas for /api/payments — mirrors ReceivePaymentInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoney, zMoneyPositive, zUuid } from './helpers';

const zMoneyNonNegative = zMoney.refine((v) => Number(v) >= 0, { message: 'cannot be negative' });

export const paymentApplicationSchema = z
  .object({
    invoiceId: zUuid,
    /** Cash applied; may be 0 when only an early-payment discount is taken (wave2 sales C3). */
    amountApplied: zMoneyNonNegative,
    discountAmount: zMoneyNonNegative.nullish(),
  })
  .refine((a) => Number(a.amountApplied) > 0 || Number(a.discountAmount ?? 0) > 0, {
    message: 'amountApplied must be greater than zero',
    path: ['amountApplied'],
  });

/** wave2 sales (C4): credit memo applied to an invoice inside Receive Payments. */
export const paymentCreditSchema = z.object({
  creditMemoId: zUuid,
  invoiceId: zUuid,
  amount: zMoneyPositive,
});

export const receivePaymentSchema = z.object({
  customerId: zUuid,
  date: zDate,
  method: z.enum(['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'], {
    errorMap: () => ({
      message: 'method must be cash, check, credit_card, ach, bank_transfer, or other',
    }),
  }),
  reference: z.string().nullish(),
  /** May be 0 when the payment only applies credits/discounts (checked in the service). */
  amount: zMoneyNonNegative,
  depositAccountId: zUuid.nullish(),
  /** May be empty — the un-applied remainder is recorded as a customer credit. */
  applications: z.array(paymentApplicationSchema, {
    required_error: 'applications must be an array (may be empty)',
    invalid_type_error: 'applications must be an array',
  }),
  credits: z.array(paymentCreditSchema).nullish(),
  discountAccountId: zUuid.nullish(),
  memo: z.string().nullish(),
  currency: z.string().trim().length(3, 'currency must be a 3-letter ISO 4217 code').nullish(),
  /** FX rates carry more than 2 decimal places. */
  exchangeRate: zDecimalPositive.nullish(),
});
export type ReceivePaymentBody = z.infer<typeof receivePaymentSchema>;

/** POST /api/payments/:id { action: 'bounce' } — Record Bounced Check (wave2 sales F2). */
export const bouncedCheckSchema = z.object({
  date: zDate.nullish(),
  bankFee: zMoneyNonNegative.nullish(),
  bankFeeAccountId: zUuid.nullish(),
  customerFee: zMoneyNonNegative.nullish(),
  customerFeeAccountId: zUuid.nullish(),
  memo: z.string().nullish(),
});
