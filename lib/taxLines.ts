/**
 * Income-tax line lists (client-safe). QuickBooks lets each account carry a "Tax-Line Mapping"
 * so the Income Tax Summary / Detail reports group balances by the line of the business's
 * return. The company picks its form (Company settings `incomeTaxForm`); each account stores a
 * key like "1120S:7" in accounts.tax_line.
 *
 * Lines follow the current IRS forms (Form 1120, 1120-S, 1065 and Schedule C of Form 1040),
 * plus the balance-sheet schedule L lines for the entity returns.
 */

export type IncomeTaxForm = '1120' | '1120S' | '1065' | 'SCHC';

export interface TaxLine {
  /** Stored key: "<form>:<line>". */
  key: string;
  form: IncomeTaxForm;
  line: string;
  label: string;
  /** Which kind of account normally maps here. */
  section: 'income' | 'cogs' | 'deduction' | 'balance_sheet' | 'other';
}

export const INCOME_TAX_FORMS: { value: IncomeTaxForm; label: string; help: string }[] = [
  { value: 'SCHC', label: 'Form 1040 Schedule C', help: 'Sole proprietors and single-member LLCs.' },
  { value: '1065', label: 'Form 1065', help: 'Partnerships and multi-member LLCs.' },
  { value: '1120S', label: 'Form 1120-S', help: 'S corporations.' },
  { value: '1120', label: 'Form 1120', help: 'C corporations.' },
];

type Row = [line: string, label: string, section: TaxLine['section']];

const SCHEDULE_L: Row[] = [
  ['L1', 'Sch L: Cash', 'balance_sheet'],
  ['L2', 'Sch L: Trade notes and accounts receivable', 'balance_sheet'],
  ['L3', 'Sch L: Inventories', 'balance_sheet'],
  ['L4', 'Sch L: U.S. government obligations', 'balance_sheet'],
  ['L6', 'Sch L: Other current assets', 'balance_sheet'],
  ['L7', 'Sch L: Loans to shareholders / partners', 'balance_sheet'],
  ['L9', 'Sch L: Other investments', 'balance_sheet'],
  ['L10a', 'Sch L: Buildings and other depreciable assets', 'balance_sheet'],
  ['L10b', 'Sch L: Less accumulated depreciation', 'balance_sheet'],
  ['L12', 'Sch L: Land', 'balance_sheet'],
  ['L13a', 'Sch L: Intangible assets', 'balance_sheet'],
  ['L14', 'Sch L: Other assets', 'balance_sheet'],
  ['L16', 'Sch L: Accounts payable', 'balance_sheet'],
  ['L17', 'Sch L: Mortgages, notes, bonds payable in less than 1 year', 'balance_sheet'],
  ['L18', 'Sch L: Other current liabilities', 'balance_sheet'],
  ['L19', 'Sch L: Loans from shareholders / partners', 'balance_sheet'],
  ['L20', 'Sch L: Mortgages, notes, bonds payable in 1 year or more', 'balance_sheet'],
  ['L21', 'Sch L: Other liabilities', 'balance_sheet'],
  ['L22', 'Sch L: Capital stock / partners\' capital', 'balance_sheet'],
  ['L24', 'Sch L: Retained earnings', 'balance_sheet'],
  ['L26', 'Sch L: Less cost of treasury stock / distributions', 'balance_sheet'],
];

const ROWS: Record<IncomeTaxForm, Row[]> = {
  SCHC: [
    ['1', 'Gross receipts or sales', 'income'],
    ['2', 'Returns and allowances', 'income'],
    ['6', 'Other income', 'income'],
    ['4', 'Cost of goods sold', 'cogs'],
    ['36', 'COGS: Purchases less cost of items withdrawn', 'cogs'],
    ['37', 'COGS: Cost of labor', 'cogs'],
    ['38', 'COGS: Materials and supplies', 'cogs'],
    ['39', 'COGS: Other costs', 'cogs'],
    ['8', 'Advertising', 'deduction'],
    ['9', 'Car and truck expenses', 'deduction'],
    ['10', 'Commissions and fees', 'deduction'],
    ['11', 'Contract labor', 'deduction'],
    ['12', 'Depletion', 'deduction'],
    ['13', 'Depreciation and section 179 expense', 'deduction'],
    ['14', 'Employee benefit programs', 'deduction'],
    ['15', 'Insurance (other than health)', 'deduction'],
    ['16a', 'Interest: Mortgage', 'deduction'],
    ['16b', 'Interest: Other', 'deduction'],
    ['17', 'Legal and professional services', 'deduction'],
    ['18', 'Office expense', 'deduction'],
    ['19', 'Pension and profit-sharing plans', 'deduction'],
    ['20a', 'Rent or lease: Vehicles, machinery, equipment', 'deduction'],
    ['20b', 'Rent or lease: Other business property', 'deduction'],
    ['21', 'Repairs and maintenance', 'deduction'],
    ['22', 'Supplies', 'deduction'],
    ['23', 'Taxes and licenses', 'deduction'],
    ['24a', 'Travel', 'deduction'],
    ['24b', 'Deductible meals', 'deduction'],
    ['25', 'Utilities', 'deduction'],
    ['26', 'Wages', 'deduction'],
    ['27a', 'Other expenses', 'deduction'],
    ['30', 'Business use of home', 'deduction'],
  ],
  '1065': [
    ['1a', 'Gross receipts or sales', 'income'],
    ['1b', 'Returns and allowances', 'income'],
    ['4', 'Ordinary income from other partnerships', 'income'],
    ['5', 'Net farm profit', 'income'],
    ['6', 'Net gain (Form 4797)', 'income'],
    ['7', 'Other income', 'income'],
    ['2', 'Cost of goods sold', 'cogs'],
    ['9', 'Salaries and wages', 'deduction'],
    ['10', 'Guaranteed payments to partners', 'deduction'],
    ['11', 'Repairs and maintenance', 'deduction'],
    ['12', 'Bad debts', 'deduction'],
    ['13', 'Rent', 'deduction'],
    ['14', 'Taxes and licenses', 'deduction'],
    ['15', 'Interest', 'deduction'],
    ['16a', 'Depreciation', 'deduction'],
    ['17', 'Depletion', 'deduction'],
    ['18', 'Retirement plans', 'deduction'],
    ['19', 'Employee benefit programs', 'deduction'],
    ['21', 'Other deductions', 'deduction'],
    ['K13a', 'Sch K: Charitable contributions', 'other'],
    ['K19a', 'Sch K: Distributions (cash)', 'other'],
    ['M1-4b', 'Sch M-1: Travel and entertainment (nondeductible)', 'other'],
    ...SCHEDULE_L,
  ],
  '1120S': [
    ['1a', 'Gross receipts or sales', 'income'],
    ['1b', 'Returns and allowances', 'income'],
    ['4', 'Net gain (Form 4797)', 'income'],
    ['5', 'Other income', 'income'],
    ['2', 'Cost of goods sold', 'cogs'],
    ['7', 'Compensation of officers', 'deduction'],
    ['8', 'Salaries and wages', 'deduction'],
    ['9', 'Repairs and maintenance', 'deduction'],
    ['10', 'Bad debts', 'deduction'],
    ['11', 'Rents', 'deduction'],
    ['12', 'Taxes and licenses', 'deduction'],
    ['13', 'Interest', 'deduction'],
    ['14', 'Depreciation', 'deduction'],
    ['15', 'Depletion', 'deduction'],
    ['16', 'Advertising', 'deduction'],
    ['17', 'Pension, profit-sharing plans', 'deduction'],
    ['18', 'Employee benefit programs', 'deduction'],
    ['19', 'Other deductions', 'deduction'],
    ['K4', 'Sch K: Interest income', 'other'],
    ['K12a', 'Sch K: Charitable contributions', 'other'],
    ['K16d', 'Sch K: Distributions', 'other'],
    ['M1-3b', 'Sch M-1: Travel and entertainment (nondeductible)', 'other'],
    ...SCHEDULE_L,
  ],
  '1120': [
    ['1a', 'Gross receipts or sales', 'income'],
    ['1b', 'Returns and allowances', 'income'],
    ['4', 'Dividends', 'income'],
    ['5', 'Interest income', 'income'],
    ['6', 'Gross rents', 'income'],
    ['7', 'Gross royalties', 'income'],
    ['8', 'Capital gain net income', 'income'],
    ['9', 'Net gain (Form 4797)', 'income'],
    ['10', 'Other income', 'income'],
    ['2', 'Cost of goods sold', 'cogs'],
    ['12', 'Compensation of officers', 'deduction'],
    ['13', 'Salaries and wages', 'deduction'],
    ['14', 'Repairs and maintenance', 'deduction'],
    ['15', 'Bad debts', 'deduction'],
    ['16', 'Rents', 'deduction'],
    ['17', 'Taxes and licenses', 'deduction'],
    ['18', 'Interest', 'deduction'],
    ['19', 'Charitable contributions', 'deduction'],
    ['20', 'Depreciation', 'deduction'],
    ['21', 'Depletion', 'deduction'],
    ['22', 'Advertising', 'deduction'],
    ['23', 'Pension, profit-sharing plans', 'deduction'],
    ['24', 'Employee benefit programs', 'deduction'],
    ['26', 'Other deductions', 'deduction'],
    ['M1-5c', 'Sch M-1: Travel and entertainment (nondeductible)', 'other'],
    ['M1-5a', 'Sch M-1: Federal income tax', 'other'],
    ...SCHEDULE_L,
  ],
};

export const TAX_LINES: TaxLine[] = (Object.keys(ROWS) as IncomeTaxForm[]).flatMap((form) =>
  ROWS[form].map(([line, label, section]) => ({ key: `${form}:${line}`, form, line, label, section })),
);

const BY_KEY = new Map(TAX_LINES.map((t) => [t.key, t]));

export function getTaxLine(key: string | null | undefined): TaxLine | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

export function taxLinesForForm(form: IncomeTaxForm): TaxLine[] {
  return TAX_LINES.filter((t) => t.form === form);
}

export function isIncomeTaxForm(v: unknown): v is IncomeTaxForm {
  return v === '1120' || v === '1120S' || v === '1065' || v === 'SCHC';
}
