/**
 * Pay Bills: the payment method that goes with the Payment Account just picked (QB Desktop
 * switches the method to Credit Card when a credit card account is chosen). A check is written on
 * a bank account only (payBills refuses "check" from a card account), so leaving the method on
 * its "Check" default after picking 2100 Credit Card made every such save a 400. Picking a bank
 * account again turns a Credit Card method back to Check; any other method that fits is kept.
 * Pure (shared by the page and tests).
 */
import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';

export function methodForPaymentAccount(
  account: { type: string; subtype?: string | null } | null | undefined,
  method: string,
): string {
  if (!account) return method;
  if (isCreditCardAccount(account)) return 'credit_card';
  if (isBankAccount(account) && method === 'credit_card') return 'check';
  return method;
}
