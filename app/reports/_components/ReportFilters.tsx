'use client';

/**
 * Report settings & filters for the standard report viewer (QB "Customize Report → Display /
 * Filters"): dates, columns, comparison, and the detail filters — account, name, transaction
 * type, amount range, cleared status, class, memo, number — plus sort-by and total-by.
 * Only the controls the report declares (lib/reports/catalog.ts) are shown.
 */
import { useEffect, useState } from 'react';
import { Input, Label, Select } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import type { ReportControl } from '@/lib/reports/catalog';

export type Params = Record<string, string>;

interface Option {
  id: string;
  name: string;
}

export interface FilterOptions {
  accounts: (Option & { section: string })[];
  customers: Option[];
  vendors: Option[];
  classes: Option[];
  items: Option[];
  employees: Option[];
  jobs: Option[];
  budgets: (Option & { fiscalYear: number; kind: string; isForecast: boolean })[];
  vehicles: string[];
}

const NEEDS_OPTIONS: ReportControl[] = ['account', 'customer', 'vendor', 'class', 'item', 'employee', 'job', 'budget', 'vehicle'];

let cache: Promise<FilterOptions> | null = null;
export function loadFilterOptions(): Promise<FilterOptions> {
  if (!cache) {
    cache = api.get<FilterOptions>('/api/reports/filter-options').catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}

export const TXN_TYPES: [string, string][] = [
  ['invoice', 'Invoice'],
  ['payment', 'Payment'],
  ['sales_receipt', 'Sales Receipt'],
  ['credit_memo', 'Credit Memo'],
  ['refund', 'Refund'],
  ['bill', 'Bill'],
  ['bill_payment', 'Bill Payment'],
  ['bill_credit', 'Bill Credit'],
  ['check', 'Check / Expense'],
  ['deposit', 'Deposit'],
  ['transfer', 'Transfer'],
  ['paycheck', 'Paycheck'],
  ['journal', 'General Journal'],
  ['inventory', 'Inventory Adjustment'],
  ['item_receipt', 'Item Receipt'],
  ['depreciation', 'Depreciation'],
  ['sales_tax_payment', 'Sales Tax Payment'],
  ['cc_payment', 'Credit Card Payment'],
  ['expense_report', 'Expense Report'],
  ['opening_balance', 'Opening Balance'],
  ['other', 'Other'],
];

/** Relative date ranges — saved with memorized reports so they always run for the current period. */
export const DATE_CHOICES: [string, string][] = [
  ['today', 'Today'],
  ['this_week', 'This week'],
  ['this_month', 'This month'],
  ['this_month_to_date', 'This month to date'],
  ['last_month', 'Last month'],
  ['this_quarter', 'This quarter'],
  ['this_quarter_to_date', 'This quarter to date'],
  ['last_quarter', 'Last quarter'],
  ['this_year', 'This calendar year'],
  ['this_year_to_date', 'This calendar year to date'],
  ['last_year', 'Last calendar year'],
  ['this_fiscal_year', 'This fiscal year'],
  ['this_fiscal_year_to_date', 'This fiscal year to date'],
  ['last_fiscal_year', 'Last fiscal year'],
  ['all', 'All dates'],
];
const AS_OF_CHOICES = ['today', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'this_fiscal_year', 'last_fiscal_year'];

function Field({ id, label, children }: { id: string; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-[10rem]">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export default function ReportFilters({
  controls,
  params,
  onChange,
  showAdvanced,
}: {
  controls: ReportControl[];
  params: Params;
  onChange: (p: Params) => void;
  showAdvanced: boolean;
}) {
  const [opts, setOpts] = useState<FilterOptions | null>(null);
  const has = (c: ReportControl) => controls.includes(c);
  useEffect(() => {
    if (controls.some((c) => NEEDS_OPTIONS.includes(c))) {
      loadFilterOptions()
        .then(setOpts)
        .catch(() => setOpts(null));
    }
  }, [controls]);
  const set = (k: string, v: string) => {
    const next = { ...params };
    if (v) next[k] = v;
    else delete next[k];
    onChange(next);
  };
  const pick = (k: string, label: string, list: Option[] | undefined, help?: React.ReactNode) =>
    list && (
      <Field id={`rf-${k}`} label={<>{label}{help}</>}>
        <Select id={`rf-${k}`} value={params[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
          <option value="">All</option>
          {list.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
    );

  const datesSet = !!params.dates;
  const setDate = (k: string, v: string) => {
    const next = { ...params };
    delete next.dates;
    if (v) next[k] = v;
    else delete next[k];
    onChange(next);
  };
  const basic = (
    <>
      {(has('range') || has('optionalRange') || has('asOf')) && (
        <Field id="rf-dates" label="Dates">
          <Select
            id="rf-dates"
            value={params.dates ?? ''}
            onChange={(e) => {
              const next = { ...params };
              if (e.target.value) {
                next.dates = e.target.value;
                delete next.from;
                delete next.to;
                delete next.asOf;
              } else delete next.dates;
              onChange(next);
            }}
          >
            <option value="">Custom</option>
            {DATE_CHOICES.filter(([k]) => !has('asOf') || has('range') || AS_OF_CHOICES.includes(k)).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(has('range') || has('optionalRange')) && (
        <>
          <Field id="rf-from" label="From">
            <Input id="rf-from" type="date" disabled={datesSet} value={params.from ?? ''} onChange={(e) => setDate('from', e.target.value)} />
          </Field>
          <Field id="rf-to" label="To">
            <Input id="rf-to" type="date" disabled={datesSet} value={params.to ?? ''} onChange={(e) => setDate('to', e.target.value)} />
          </Field>
        </>
      )}
      {has('asOf') && (
        <Field id="rf-asof" label="As of">
          <Input id="rf-asof" type="date" disabled={datesSet} value={params.asOf ?? ''} onChange={(e) => setDate('asOf', e.target.value)} />
        </Field>
      )}
      {has('budget') && opts && (
        <Field id="rf-budget" label="Budget / forecast">
          <Select id="rf-budget" value={params.budgetId ?? ''} onChange={(e) => set('budgetId', e.target.value)}>
            <option value="">Choose…</option>
            {opts.budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} (FY{b.fiscalYear}{b.isForecast ? ', forecast' : ''}{b.kind === 'balance_sheet' ? ', balance sheet' : ''})
              </option>
            ))}
          </Select>
        </Field>
      )}
      {has('periodColumns') && (
        <Field id="rf-cols" label="Columns">
          <Select id="rf-cols" value={params.columns ?? 'total'} onChange={(e) => set('columns', e.target.value === 'total' ? '' : e.target.value)}>
            <option value="total">Total only</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
          </Select>
        </Field>
      )}
      {has('compare') && (
        <Field id="rf-compare" label="Compare with">
          <Select id="rf-compare" value={params.compare ?? ''} onChange={(e) => set('compare', e.target.value)}>
            <option value="">Nothing</option>
            <option value="prev_period">Previous period</option>
            <option value="prev_year">Previous year</option>
          </Select>
        </Field>
      )}
      {has('compare') && has('asOf') && params.compare && (
        <Field id="rf-prior" label="Compare to date">
          <Input id="rf-prior" type="date" value={params.priorAsOf ?? ''} onChange={(e) => set('priorAsOf', e.target.value)} />
        </Field>
      )}
      {has('view') && (
        <Field id="rf-view" label="Show">
          <Select id="rf-view" value={params.view ?? 'summary'} onChange={(e) => set('view', e.target.value === 'summary' ? '' : e.target.value)}>
            <option value="summary">Summary</option>
            <option value="detail">Detail</option>
          </Select>
        </Field>
      )}
      {has('aging') && (
        <>
          <Field id="rf-interval" label="Interval (days)">
            <Input id="rf-interval" inputMode="numeric" placeholder="30" value={params.interval ?? ''} onChange={(e) => set('interval', e.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
          <Field id="rf-through" label="Through (days past due)">
            <Input id="rf-through" inputMode="numeric" placeholder="90" value={params.through ?? ''} onChange={(e) => set('through', e.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
          <Field id="rf-agefrom" label="Age from">
            <Select id="rf-agefrom" value={params.agingFrom ?? ''} onChange={(e) => set('agingFrom', e.target.value)}>
              <option value="">Preference setting</option>
              <option value="due_date">Due date</option>
              <option value="transaction_date">Transaction date</option>
            </Select>
          </Field>
        </>
      )}
      {has('class') && pick('classId', 'Class', opts?.classes, <Help term="class" />)}
      {has('customer') && pick('customerId', 'Customer:Job', opts?.customers)}
      {has('vendor') && pick('vendorId', 'Vendor', opts?.vendors)}
      {has('job') && pick('jobId', 'Job', opts?.jobs)}
      {has('employee') && pick('employeeId', 'Employee', opts?.employees)}
      {has('item') && pick('itemId', 'Item', opts?.items)}
      {has('vehicle') && opts && (
        <Field id="rf-vehicle" label="Vehicle">
          <Select id="rf-vehicle" value={params.vehicle ?? ''} onChange={(e) => set('vehicle', e.target.value)}>
            <option value="">All</option>
            {opts.vehicles.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );

  const advanced = showAdvanced && (
    <>
      {has('account') && pick('accountId', 'Account (incl. sub-accounts)', opts?.accounts)}
      {has('txnType') && (
        <Field id="rf-type" label="Transaction type">
          <Select id="rf-type" value={params.txnType ?? ''} onChange={(e) => set('txnType', e.target.value)}>
            <option value="">All</option>
            {TXN_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {has('amount') && (
        <>
          <Field id="rf-amin" label="Amount from">
            <Input id="rf-amin" inputMode="decimal" placeholder="0.00" value={params.amountMin ?? ''} onChange={(e) => set('amountMin', e.target.value.trim())} />
          </Field>
          <Field id="rf-amax" label="Amount to">
            <Input id="rf-amax" inputMode="decimal" placeholder="any" value={params.amountMax ?? ''} onChange={(e) => set('amountMax', e.target.value.trim())} />
          </Field>
        </>
      )}
      {has('cleared') && (
        <Field id="rf-cleared" label={<>Cleared <Help term="reconcile" /></>}>
          <Select id="rf-cleared" value={params.cleared ?? ''} onChange={(e) => set('cleared', e.target.value)}>
            <option value="">Either</option>
            <option value="cleared">Cleared</option>
            <option value="uncleared">Not cleared</option>
          </Select>
        </Field>
      )}
      {has('memo') && (
        <Field id="rf-memo" label="Memo contains">
          <Input id="rf-memo" value={params.memo ?? ''} onChange={(e) => set('memo', e.target.value)} />
        </Field>
      )}
      {has('number') && (
        <Field id="rf-num" label="Number contains">
          <Input id="rf-num" value={params.number ?? ''} onChange={(e) => set('number', e.target.value)} />
        </Field>
      )}
      {has('sort') && (
        <>
          <Field id="rf-sort" label="Sort by">
            <Select id="rf-sort" value={params.sortBy ?? ''} onChange={(e) => set('sortBy', e.target.value)}>
              <option value="">Date</option>
              <option value="num">Number</option>
              <option value="name">Name</option>
              <option value="amount">Amount</option>
              <option value="account">Account</option>
              <option value="type">Type</option>
              <option value="memo">Memo</option>
            </Select>
          </Field>
          <Field id="rf-dir" label="Order">
            <Select id="rf-dir" value={params.sortDir ?? ''} onChange={(e) => set('sortDir', e.target.value)}>
              <option value="">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
          </Field>
        </>
      )}
      {has('subtotal') && (
        <Field id="rf-total" label="Total by">
          <Select id="rf-total" value={params.subtotalBy ?? ''} onChange={(e) => set('subtotalBy', e.target.value)}>
            <option value="">Default</option>
            <option value="none">Nothing (flat list)</option>
            <option value="account">Account</option>
            <option value="name">Name</option>
            <option value="type">Transaction type</option>
            <option value="month">Month</option>
            <option value="class">Class</option>
          </Select>
        </Field>
      )}
    </>
  );

  return (
    <div className="flex items-end gap-3 flex-wrap">
      {basic}
      {advanced}
    </div>
  );
}

/** True when the report has any filter beyond the basic settings row. */
export function hasAdvancedFilters(controls: ReportControl[]): boolean {
  return controls.some((c) => ['account', 'txnType', 'amount', 'cleared', 'memo', 'number', 'sort', 'subtotal'].includes(c));
}
