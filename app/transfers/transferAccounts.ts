/**
 * Accounts offered in Transfer Funds (pure, unit-tested in lib/ui.review5.test.ts).
 */
import { isAccountsPayable, isAccountsReceivable, isNonPosting, isUndepositedFunds } from '@/lib/accountTypes';

export interface TransferAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
  isActive?: boolean;
  currency?: string | null;
}

/**
 * QB Transfer Funds moves money between balance-sheet accounts — banks, credit cards, other
 * assets and liabilities, equity. Never:
 *  - Accounts Receivable / Payable: a transfer carries no customer or vendor, so the A/R or A/P
 *    balance would move without the aging (the subledger) — the books stop tying out;
 *  - Undeposited Funds: the payments in it would still wait for Make Deposits;
 *  - Inventory Asset: the stock value would change without any quantity;
 *  - income, expense or non-posting accounts.
 * The list used to offer the whole chart of accounts. Inactive accounts are left out too, except
 * the ones a saved transfer being edited already uses.
 */
export function transferAccounts<T extends TransferAccount>(accounts: T[], keepIds: Array<string | null | undefined> = []): T[] {
  return accounts.filter((a) => {
    if (keepIds.includes(a.id)) return true;
    if (a.isActive === false) return false;
    const like = { type: a.type, subtype: a.subtype ?? null };
    if (!['asset', 'liability', 'equity'].includes(a.type)) return false;
    if (isAccountsReceivable(like) || isAccountsPayable(like) || isUndepositedFunds(like) || isNonPosting(like)) return false;
    return a.subtype !== 'inventory';
  });
}
