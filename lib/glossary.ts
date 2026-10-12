/**
 * Plain-language glossary of accounting terms, shown by the <Help term="..."> tooltip
 * (components/Help.tsx) and listed in full on the /help page.
 *
 * Written for a small-business owner who is not an accountant: every `short` answer is one
 * or two sentences with no jargon left unexplained; `long` adds an everyday example. Keys are
 * stable kebab-case ids; `aliases` let callers (and the help page search) use the words
 * people actually type, e.g. "A/R" or "accounts receivable".
 */

export interface GlossaryEntry {
  /** Display name, e.g. "Accounts Receivable (A/R)". */
  term: string;
  /** One- or two-sentence plain-language definition (the tooltip body). */
  short: string;
  /** Optional longer explanation with an example (help page only). */
  long?: string;
  /** Alternative spellings / abbreviations that resolve to this entry. */
  aliases?: string[];
}

export const GLOSSARY = {
  ar: {
    term: 'Accounts Receivable (A/R)',
    short:
      'Money customers owe you. When you send an invoice, the amount goes into A/R until the customer pays.',
    long:
      'Example: you invoice a customer $500 today with 30-day terms. Your income is recorded now, and the $500 sits in A/R. When the customer pays, use Receive Payments — the $500 moves out of A/R and into your bank (or Undeposited Funds).',
    aliases: ['a/r', 'accounts receivable', 'receivables', 'receivable'],
  },
  ap: {
    term: 'Accounts Payable (A/P)',
    short:
      'Money you owe vendors. When you enter a bill, the amount goes into A/P until you pay it.',
    long:
      'Example: your supplier sends a $300 bill due next month. Enter Bills records the expense now and puts $300 in A/P. When you pay it with Pay Bills, A/P goes down and so does your bank balance.',
    aliases: ['a/p', 'accounts payable', 'payables', 'payable'],
  },
  'undeposited-funds': {
    term: 'Undeposited Funds',
    short:
      'A holding spot for payments you have received but not yet taken to the bank. Use Record Deposits to move them into your bank account.',
    long:
      'Like the envelope of checks in your drawer. Grouping them into one deposit means your books show the same single deposit your bank statement shows, which makes reconciling easy.',
    aliases: ['undeposited', 'undeposited funds'],
  },
  accrual: {
    term: 'Accrual basis',
    short:
      'Income counts when you invoice and expenses count when you get the bill — even if no money has moved yet.',
    long:
      'Accrual shows what you earned and owe in a period, which gives a truer picture of profit. Most growing businesses and all businesses with inventory use it.',
    aliases: ['accrual basis', 'accrual accounting'],
  },
  'cash-basis': {
    term: 'Cash basis',
    short:
      'Income counts when the money arrives and expenses count when you pay them.',
    long:
      'Cash basis is simpler and matches your bank account. You can record everything normally and still switch any report between cash and accrual.',
    aliases: ['cash basis', 'cash accounting', 'cash'],
  },
  'accrual-vs-cash': {
    term: 'Accrual vs. cash',
    short:
      'Two ways to time your reports. Accrual counts sales when you invoice; cash counts them when you get paid. Your records are the same either way — only the report view changes.',
    aliases: ['accrual vs cash', 'cash vs accrual', 'report basis', 'basis'],
  },
  class: {
    term: 'Class',
    short:
      'An optional tag for tracking parts of your business — such as locations, departments or product lines — so you can see profit for each one.',
    long:
      'Example: a bakery with two shops can tag every sale and expense with "Downtown" or "Uptown" and then run Profit & Loss by Class.',
    aliases: ['classes', 'class tracking'],
  },
  'closing-date': {
    term: 'Closing date',
    short:
      'A lock on your books. Transactions dated on or before the closing date cannot be changed without the closing-date password.',
    long:
      'Set it after you file taxes or finish a year so nobody accidentally changes numbers you already reported.',
    aliases: ['closing date', 'closed period', 'period closed', 'lock date'],
  },
  reconcile: {
    term: 'Reconcile',
    short:
      'Checking your books against your bank or credit card statement, line by line, so you know both agree.',
    long:
      'Each month, enter the statement ending balance, tick off every transaction that appears on the statement, and finish when the difference is 0.00. Anything left over is a mistake or something the bank has not processed yet.',
    aliases: ['reconciliation', 'reconciling', 'reconciled'],
  },
  'debit-credit': {
    term: 'Debits and credits',
    short:
      'Every transaction touches at least two accounts: one side is the debit, the other the credit, and the two must always be equal. That rule is what keeps your books in balance.',
    long:
      'Debits increase what you own (assets) and your expenses. Credits increase what you owe (liabilities), owner equity and income. You rarely need to think about this — invoices, bills and checks pick the right side for you. It matters only for journal entries.',
    aliases: ['debit', 'credit', 'debits', 'credits', 'debits and credits', 'dr', 'cr'],
  },
  'retained-earnings': {
    term: 'Retained Earnings',
    short:
      'Profit from earlier years that is still in the business. At the start of each fiscal year, last year’s profit (or loss) moves here automatically.',
    aliases: ['retained earnings', 're'],
  },
  'opening-balance-equity': {
    term: 'Opening Balance Equity',
    short:
      'A temporary account that balances your books when you enter starting balances. Once setup is finished it should be zero — your accountant moves what is left into owner’s equity.',
    aliases: ['opening balance equity', 'obe', 'opening balance'],
  },
  'journal-entry': {
    term: 'Journal entry',
    short:
      'A manual transaction where you choose the accounts and the debit and credit amounts yourself. Usually used for adjustments and corrections — everyday work has its own forms.',
    aliases: ['journal entry', 'general journal', 'je', 'journal'],
  },
  'chart-of-accounts': {
    term: 'Chart of Accounts',
    short:
      'The list of categories your money is sorted into: bank accounts, what you own, what you owe, income and expenses.',
    aliases: ['chart of accounts', 'coa', 'accounts'],
  },
  deposit: {
    term: 'Deposit',
    short:
      'Recording money you took to the bank. Pick the payments waiting in Undeposited Funds so your deposit matches the bank statement.',
    aliases: ['make deposit', 'record deposit', 'deposits'],
  },
  'sales-tax': {
    term: 'Sales tax',
    short:
      'Tax you collect from customers on behalf of the government. It is not your income — it is held in Sales Tax Payable until you pay it to the tax agency.',
    aliases: ['sales tax', 'sales tax payable', 'tax'],
  },
  'payroll-liabilities': {
    term: 'Payroll liabilities',
    short:
      'Payroll taxes and withholdings you have taken out of paychecks (or owe as the employer) but have not yet paid to the government.',
    aliases: ['payroll liabilities', 'pay liabilities', 'liabilities'],
  },
  'fiscal-year': {
    term: 'Fiscal year',
    short:
      'Your business’s 12-month accounting year. Most businesses use January to December, but it can start in any month.',
    aliases: ['fiscal year', 'financial year', 'fy', 'fiscal year end'],
  },
  void: {
    term: 'Void',
    short:
      'Cancelling a transaction while keeping a record of it. The amounts become zero, but the transaction stays visible in the audit trail.',
    aliases: ['voided', 'voiding'],
  },
  'statement-ending-balance': {
    term: 'Statement ending balance',
    short:
      'The final balance printed on your bank or credit card statement for the period you are reconciling.',
    aliases: ['ending balance', 'statement balance'],
  },
  'account-type': {
    term: 'Account type',
    short:
      'Tells the books what kind of account this is — a bank account, money customers owe you, a bill you owe, income, an expense and so on. It decides where the account appears on your reports.',
    long:
      'Example: prepaid insurance is something you own but cannot spend, so it is an Other Current Asset, not a Bank account. A loan you repay over five years is a Long Term Liability.',
    aliases: ['account type', 'account types', 'other current asset', 'other current liability', 'long term liability'],
  },
  'non-posting-account': {
    term: 'Non-posting account',
    short:
      'An account that only keeps track of estimates, sales orders or purchase orders. Nothing in it is real money yet, so it never appears on your financial reports.',
    aliases: ['non-posting', 'nonposting', 'non posting account'],
  },
  'adjusting-entry': {
    term: 'Adjusting entry',
    short:
      'A journal entry made at the end of a period to correct or update the books — for example recording depreciation or expenses you owe but have not been billed for yet.',
    aliases: ['adjusting entries', 'adjusting journal entry', 'aje', 'adjustment'],
  },
  'tax-line': {
    term: 'Tax line',
    short:
      'The line on your business income-tax return that an account adds up to. Setting it lets your tax preparer pull the right totals straight from your books.',
    aliases: ['tax line', 'tax-line mapping', 'tax line mapping'],
  },
  'name-on-journal-line': {
    term: 'Name (on a journal entry)',
    short:
      'The customer, vendor or employee a journal entry line is for. Lines that touch Accounts Receivable need a customer, and lines that touch Accounts Payable need a vendor, so their balances stay right.',
    aliases: ['journal name', 'name column'],
  },
  // ---- wave2 sales ----
  'statement-charge': {
    term: 'Statement charge',
    short:
      'A charge you add straight to the balance a customer owes instead of sending a separate invoice. It shows up on their next statement and in A/R aging.',
    long:
      'Example: you bill a monthly $50 service fee. Enter it as a statement charge, and it appears on their monthly statement with everything else they owe.',
    aliases: ['statement charges', 'customer register charge'],
  },
  'bounced-check': {
    term: 'Bounced check (NSF)',
    short:
      'A customer check the bank returned unpaid, usually for "non-sufficient funds". Recording it takes the money back out of your bank and puts the amount back on what the customer owes.',
    long:
      'Example: a customer pays a $200 invoice by check and you deposit it. A week later the bank returns it. Record Bounced Check reopens the invoice, takes $200 out of the bank, and can add the bank fee as an expense and charge the customer a returned-check fee.',
    aliases: ['nsf', 'nsf check', 'returned check', 'bounced checks'],
  },
  'early-payment-discount': {
    term: 'Early-payment discount',
    short:
      'A reduction you give a customer for paying before a set date, such as 2% off if paid within 10 days ("2% 10, Net 30").',
    long:
      'Example: an invoice of $1,000 has terms 2% 10, Net 30. If the customer pays within 10 days they pay $980; in Receive Payments you apply $980 of cash plus a $20 discount, and the invoice is paid in full.',
    aliases: ['early payment discount', 'sales discount', 'payment discount', 'discount terms'],
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

export const GLOSSARY_KEYS = Object.keys(GLOSSARY) as GlossaryKey[];

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
}

/**
 * Resolve a key, display name or alias ("A/R", "accounts receivable", "ar") to its entry.
 * Returns null when nothing matches.
 */
export function lookupTerm(query: string): (GlossaryEntry & { key: GlossaryKey }) | null {
  const q = normalize(query);
  if (!q) return null;
  for (const key of GLOSSARY_KEYS) {
    const e: GlossaryEntry = GLOSSARY[key];
    if (
      key === q ||
      normalize(e.term) === q ||
      (e.aliases ?? []).some((a) => normalize(a) === q)
    ) {
      return { ...e, key };
    }
  }
  return null;
}

/** Anchor id used by the /help page for an entry (so tooltips can deep-link to it). */
export function glossaryAnchor(key: GlossaryKey): string {
  return `term-${key}`;
}
