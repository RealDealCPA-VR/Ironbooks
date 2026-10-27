/**
 * Pay Liabilities form defaults (pure, unit-tested in lib/ui.review5.test.ts).
 */
import { todayISO } from '@/lib/dates';

export interface PayForm {
  amount: string;
  date: string;
  paymentAccountId: string;
  memo: string;
  payeeName: string;
  checkNumber: string;
  toPrint: boolean;
}

/**
 * A blank payment form dated today — worked out each time the form opens. A module-level constant
 * kept the date the page was first loaded, so in an app left open overnight the next payment was
 * dated yesterday (or earlier).
 */
export function emptyPayForm(): PayForm {
  return {
    amount: '',
    date: todayISO(),
    paymentAccountId: '',
    memo: '',
    payeeName: '',
    checkNumber: '',
    toPrint: false,
  };
}
