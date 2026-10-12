'use client';

/**
 * Setup interview — an EasyStep-style interview in plain language (QB "EasyStep Interview").
 *
 * Every new company goes through it: sign-up, New Company (/companies) and the desktop app's
 * File > New Company all land here, and Help > "Run setup interview" (and the command palette)
 * opens it again for the company that is open. "Skip for now" is always offered.
 *
 * Step 1 — Welcome (+ "Coming from QuickBooks Desktop?" link to /qb-import)
 * Step 2 — Company information: name, legal name, address, phone, email, EIN (used on invoices,
 *          W-2 and 1099), home currency
 * Step 3 — Industry (picks the starter chart of accounts)
 * Step 4 — How the business is organized (entity type → tax form, equity accounts, tax lines)
 * Step 5 — Dates: first month of the fiscal year and of the income-tax year, start date,
 *          accrual/cash reporting
 * Step 6 — Yes/no features: sales tax, inventory, employees, estimates (+ progress invoicing),
 *          time tracking, class tracking, more than one currency
 * Step 7 — Review (the summary is built from the values that will be saved) and finish
 *
 * Finishing POSTs the answers to /api/company/setup-interview, which applies them to the open
 * company in one transaction (lib/services/setupInterview.ts). No opening balances are posted,
 * so the books start in balance.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  BookOpen,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
  Landmark,
  Store,
  CalendarRange,
  ToggleRight,
  ClipboardCheck,
} from 'lucide-react';
import { Button, Card, Input, Select, Label, toast, toastError } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { resolveCompanyPreferences } from '@/lib/preferences';
import { cn } from '@/lib/utils';
import {
  BUSINESS_TYPES,
  ENTITY_TYPES,
  MONTH_NAMES,
  buildSetupPlan,
  businessTypeOption,
  entityTypeOption,
  fiscalYearEndFromStartMonth,
  fiscalYearStartMonthFromEnd,
  type BusinessType,
  type CompanyInfo,
  type EntityType,
  type InterviewAnswers,
  type SetupStep,
} from '@/lib/onboarding';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENCIES = [
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'EUR', label: 'EUR — Euro (€)' },
  { value: 'GBP', label: 'GBP — British Pound (£)' },
  { value: 'CAD', label: 'CAD — Canadian Dollar (C$)' },
  { value: 'AUD', label: 'AUD — Australian Dollar (A$)' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar (NZ$)' },
  { value: 'JPY', label: 'JPY — Japanese Yen (¥)' },
  { value: 'CHF', label: 'CHF — Swiss Franc (Fr)' },
  { value: 'INR', label: 'INR — Indian Rupee (₹)' },
  { value: 'MXN', label: 'MXN — Mexican Peso (MX$)' },
  { value: 'BRL', label: 'BRL — Brazilian Real (R$)' },
  { value: 'SGD', label: 'SGD — Singapore Dollar (S$)' },
  { value: 'HKD', label: 'HKD — Hong Kong Dollar (HK$)' },
];

const STEPS = [
  { label: 'Welcome', icon: BookOpen },
  { label: 'Company', icon: Building2 },
  { label: 'Industry', icon: Store },
  { label: 'Tax form', icon: Landmark },
  { label: 'Dates', icon: CalendarRange },
  { label: 'Features', icon: ToggleRight },
  { label: 'Finish', icon: ClipboardCheck },
];

type FeatureAnswers = Required<
  Pick<
    InterviewAnswers,
    'salesTax' | 'inventory' | 'employees' | 'estimates' | 'progressInvoicing' | 'timeTracking' | 'classTracking' | 'multiCurrency'
  >
>;

interface WizardState extends FeatureAnswers {
  businessType: BusinessType;
  entityType: EntityType;
  fiscalYearStartMonth: number;
  taxYearStartMonth: number;
  startDate: string;
  reportBasis: 'accrual' | 'cash';
  currency: string;
  company: Required<CompanyInfo>;
  /** Whether the user has touched the inventory question (else it follows the industry). */
  inventoryTouched: boolean;
}

function firstOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

const INITIAL: WizardState = {
  businessType: 'service',
  entityType: 'sole_prop',
  fiscalYearStartMonth: 1,
  taxYearStartMonth: 1,
  startDate: firstOfYear(),
  reportBasis: 'accrual',
  currency: 'USD',
  salesTax: false,
  inventory: false,
  employees: false,
  estimates: false,
  progressInvoicing: false,
  timeTracking: false,
  classTracking: false,
  multiCurrency: false,
  company: {
    name: '',
    legalName: '',
    ein: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    zip: '',
    country: 'US',
    phone: '',
    email: '',
  },
  inventoryTouched: false,
};

/** The answers object sent to the server (and used for the review preview). */
function toAnswers(s: WizardState): InterviewAnswers {
  return {
    businessType: s.businessType,
    entityType: s.entityType,
    fiscalYearStartMonth: s.fiscalYearStartMonth,
    taxYearStartMonth: s.taxYearStartMonth,
    startDate: s.startDate || undefined,
    reportBasis: s.reportBasis,
    currency: s.currency,
    salesTax: s.salesTax,
    inventory: s.inventory,
    employees: s.employees,
    estimates: s.estimates,
    progressInvoicing: s.estimates && s.progressInvoicing,
    timeTracking: s.timeTracking,
    classTracking: s.classTracking,
    multiCurrency: s.multiCurrency,
    company: s.company,
  };
}

/** Pre-fill from the open company (so re-running the interview starts from what is saved). */
function prefill(
  company: { name: string; settings: Record<string, unknown> | null },
  isNew: boolean,
): Partial<WizardState> {
  const s = company.settings ?? {};
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
  const bool = (k: string, fallback: boolean) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : fallback);
  const rec = (s.setupInterview && typeof s.setupInterview === 'object' ? s.setupInterview : {}) as Record<string, unknown>;
  const businessType = BUSINESS_TYPES.find((b) => b.industry === str('industry'))?.value;
  const fiscalYearStartMonth = fiscalYearStartMonthFromEnd(str('fiscalYearEnd') || '12-31');
  // A brand-new company (?new=1) starts every feature at "No" so each one is a conscious
  // choice. An existing company — finished, skipped or never asked — starts from the switches
  // it uses today, so clicking straight through never turns off a feature already in use.
  const prefs = resolveCompanyPreferences(s);
  const cur = (k: keyof typeof prefs) => (isNew ? false : prefs[k] === true);
  return {
    ...(businessType ? { businessType } : {}),
    ...(ENTITY_TYPES.some((e) => e.value === rec.entityType) ? { entityType: rec.entityType as EntityType } : {}),
    fiscalYearStartMonth,
    taxYearStartMonth: typeof rec.taxYearStartMonth === 'number' ? rec.taxYearStartMonth : fiscalYearStartMonth,
    ...(typeof rec.startDate === 'string' ? { startDate: rec.startDate } : {}),
    reportBasis: str('reportBasis') === 'cash' ? 'cash' : 'accrual',
    currency: /^[A-Z]{3}$/.test(str('currency')) ? str('currency') : 'USD',
    salesTax: cur('salesTaxEnabled'),
    inventory: cur('inventoryEnabled'),
    inventoryTouched: !isNew,
    employees: cur('payrollEnabled'),
    estimates: cur('estimatesEnabled'),
    progressInvoicing: cur('estimatesEnabled') && cur('progressInvoicingEnabled'),
    timeTracking: cur('timeTrackingEnabled'),
    classTracking: cur('classTrackingEnabled'),
    multiCurrency: bool('multiCurrencyEnabled', false),
    company: {
      name: company.name ?? '',
      legalName: str('legalName'),
      ein: str('ein'),
      addressLine1: str('addressLine1'),
      addressLine2: str('addressLine2'),
      city: str('city'),
      state: str('state'),
      zip: str('zip'),
      country: str('country') || 'US',
      phone: str('phone'),
      email: str('email'),
    },
  };
}

// ---------------------------------------------------------------------------
// Stepper indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex items-center mb-8 w-full" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const idx = i + 1;
        const done = current > idx;
        const active = current === idx;
        return (
          <li key={s.label} className="flex items-center flex-1 last:flex-none" aria-current={active ? 'step' : undefined}>
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors',
                  done
                    ? 'bg-emerald border-emerald text-white'
                    : active
                      ? 'bg-electric border-electric text-white'
                      : 'bg-white border-slate-200 text-navy/30',
                )}
              >
                {done ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : idx}
              </div>
              <span
                className={cn(
                  'mt-1 text-[11px] font-medium whitespace-nowrap hidden sm:block',
                  active ? 'text-electric' : done ? 'text-emerald' : 'text-navy/30',
                )}
              >
                {s.label}
                {done && <span className="sr-only"> (done)</span>}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                aria-hidden="true"
                className={cn('flex-1 h-0.5 mx-1 sm:mb-5 transition-colors', done ? 'bg-emerald' : 'bg-slate-200')}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StepHeading({ icon: Icon, title, subtitle }: { icon: typeof BookOpen; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3 mb-5">
      <Icon className="h-6 w-6 text-electric mt-0.5 shrink-0" aria-hidden="true" />
      <div>
        <h2 className="text-xl font-extrabold text-navy" tabIndex={-1} data-step-heading>
          {title}
        </h2>
        <p className="text-navy/50 text-sm">{subtitle}</p>
      </div>
    </div>
  );
}

function NavButtons({
  onBack,
  onNext,
  nextLabel = 'Next',
  loading,
  nextDisabled,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  loading?: boolean;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex gap-3 mt-6">
      {onBack && (
        <Button variant="secondary" onClick={onBack} disabled={loading} className="flex-1">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
      )}
      <Button onClick={onNext} loading={loading} disabled={nextDisabled} className="flex-1">
        {nextLabel}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Large yes/no radio pair (native radios: arrow keys move, Space selects). */
function YesNo({
  name,
  question,
  help,
  value,
  onChange,
}: {
  name: string;
  question: React.ReactNode;
  help: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <fieldset className="rounded-xl border border-slate-200 p-4">
      <legend className="px-1 text-sm font-semibold text-navy">{question}</legend>
      <p className="text-xs text-navy/50 mb-3">{help}</p>
      <div className="grid grid-cols-2 gap-2">
        {[true, false].map((v) => (
          <label
            key={String(v)}
            className={cn(
              'flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-electric/50',
              value === v ? 'border-electric bg-electric/10 text-electric' : 'border-slate-200 text-navy/70 hover:bg-slate-50',
            )}
          >
            <input type="radio" name={name} className="sr-only" checked={value === v} onChange={() => onChange(v)} />
            {v ? 'Yes' : 'No'}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A card-style single-choice list (industry, tax form, report basis). */
function ChoiceList<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  options: Array<{ value: T; label: string; description: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <div className="grid grid-cols-1 gap-2">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-electric/50',
                checked ? 'border-electric bg-electric/5' : 'border-slate-200 hover:bg-slate-50',
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="mt-1 accent-electric"
              />
              <span>
                <span className="block text-sm font-semibold text-navy">{o.label}</span>
                <span className="block text-xs text-navy/50">{o.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

interface StepProps {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onBack: () => void;
  onNext: () => void;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepWelcome({ onNext, rerun }: { onNext: () => void; rerun: boolean }) {
  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div className="h-20 w-20 rounded-2xl bg-electric/10 flex items-center justify-center">
        <BookOpen className="h-10 w-10 text-electric" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-2xl font-extrabold text-navy mb-2" tabIndex={-1} data-step-heading>
          {rerun ? 'Setup interview' : 'Welcome to BookKeeper AI'}
        </h2>
        <p className="text-navy/60 text-sm max-w-sm leading-relaxed mx-auto">
          {rerun
            ? 'Go through the questions again to update your company details and turn features on or off. Your answers start from what is saved now, and nothing you entered is deleted.'
            : "A few easy questions about your business and we'll set up your books — the right accounts, your fiscal and tax year, and only the features you need. About three minutes. You can change every answer later in Settings."}
        </p>
      </div>

      {!rerun && (
        <Link
          href="/qb-import"
          className="w-full rounded-xl border-2 border-gold/60 bg-gold/10 p-4 text-left outline-none transition-colors hover:bg-gold/20 focus-visible:ring-2 focus-visible:ring-electric"
        >
          <span className="flex items-start gap-3">
            <DownloadCloud className="h-6 w-6 text-gold shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              <span className="block font-bold text-navy">Coming from QuickBooks Desktop? Bring your data</span>
              <span className="block text-xs text-navy/60 mt-0.5">
                Import your customers, vendors, items, chart of accounts and transactions instead of
                starting from scratch.
              </span>
            </span>
          </span>
        </Link>
      )}

      <Button className="w-full" onClick={onNext}>
        {rerun ? 'Start' : 'Start the interview'}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function StepCompany({ state, set, onBack, onNext }: StepProps) {
  const [touched, setTouched] = useState(false);
  const c = state.company;
  const setC = (patch: Partial<CompanyInfo>) => set({ company: { ...c, ...patch } as Required<CompanyInfo> });
  const nameMissing = !c.name.trim();
  const einBad = c.ein.trim() !== '' && !/^\d{2}-?\d{7}$/.test(c.ein.trim());
  const emailBad = c.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim());
  const field = (
    id: string,
    label: string,
    key: keyof CompanyInfo,
    opts: { placeholder?: string; type?: string; autoComplete?: string; error?: string | false; autoFocus?: boolean; required?: boolean } = {},
  ) => (
    <div>
      <Label htmlFor={id} required={opts.required}>
        {label}
      </Label>
      <Input
        id={id}
        type={opts.type}
        placeholder={opts.placeholder}
        autoComplete={opts.autoComplete}
        value={c[key] ?? ''}
        onChange={(e) => setC({ [key]: e.target.value })}
        onBlur={() => setTouched(true)}
        aria-invalid={touched && opts.error ? true : undefined}
        aria-describedby={touched && opts.error ? `${id}-err` : undefined}
        autoFocus={opts.autoFocus}
      />
      {touched && opts.error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-red-600">
          {opts.error}
        </p>
      )}
    </div>
  );
  return (
    <div>
      <StepHeading
        icon={Building2}
        title="Tell us about your company"
        subtitle="This appears on invoices and statements, and on W-2 and 1099 forms."
      />
      <div className="flex flex-col gap-3">
        {field('co-name', 'Company name', 'name', {
          placeholder: 'e.g. Acme Plumbing',
          error: nameMissing && 'Enter your company name to continue.',
          autoFocus: true,
          required: true,
        })}
        {field('co-legal', 'Legal name (if different)', 'legalName', { placeholder: 'e.g. Acme Plumbing LLC' })}
        {field('co-addr1', 'Street address', 'addressLine1', { autoComplete: 'address-line1' })}
        {field('co-addr2', 'Address line 2', 'addressLine2', { autoComplete: 'address-line2' })}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {field('co-city', 'City', 'city', { autoComplete: 'address-level2' })}
          {field('co-state', 'State', 'state', { autoComplete: 'address-level1' })}
          {field('co-zip', 'ZIP', 'zip', { autoComplete: 'postal-code' })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('co-phone', 'Phone', 'phone', { type: 'tel', autoComplete: 'tel' })}
          {field('co-email', 'Email', 'email', {
            type: 'email',
            autoComplete: 'email',
            error: emailBad && 'Enter an email like name@example.com, or leave it blank.',
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('co-ein', 'Federal Employer ID (EIN)', 'ein', {
            placeholder: '12-3456789',
            error: einBad && 'An EIN has 9 digits, like 12-3456789. Leave it blank if you do not have one.',
          })}
          <div>
            <Label htmlFor="co-currency">Currency you report in</Label>
            <Select id="co-currency" value={state.currency} onChange={(e) => set({ currency: e.target.value })}>
              {CURRENCIES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-xs text-navy/40">Only the company name is required. You can fill in the rest later in Settings.</p>
      </div>
      <NavButtons
        onBack={onBack}
        onNext={() => {
          setTouched(true);
          if (nameMissing || einBad || emailBad) {
            toast(nameMissing ? 'Enter your company name to continue.' : 'Fix the highlighted field to continue.', 'danger');
            return;
          }
          onNext();
        }}
      />
    </div>
  );
}

function StepBusiness({ state, set, onBack, onNext }: StepProps) {
  return (
    <div>
      <StepHeading
        icon={Store}
        title="What is your industry?"
        subtitle="We'll add the income and expense accounts businesses like yours usually need."
      />
      <ChoiceList
        name="business-type"
        legend="Industry"
        options={BUSINESS_TYPES.map((b) => ({ value: b.value, label: b.label, description: b.description }))}
        value={state.businessType}
        onChange={(v) => {
          const bt = businessTypeOption(v);
          set({
            businessType: v,
            // Pre-answer the inventory question until the user answers it themselves.
            ...(state.inventoryTouched ? {} : { inventory: bt.suggestsInventory }),
          });
        }}
      />
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepEntity({ state, set, onBack, onNext }: StepProps) {
  return (
    <div>
      <StepHeading
        icon={Landmark}
        title="How is your business organized?"
        subtitle="This picks your equity accounts and matches your accounts to the lines of your tax return."
      />
      <ChoiceList
        name="entity-type"
        legend="Business organization"
        options={ENTITY_TYPES.map((e) => ({ value: e.value, label: e.label, description: e.description }))}
        value={state.entityType}
        onChange={(v) => set({ entityType: v })}
      />
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepDates({ state, set, onBack, onNext }: StepProps) {
  const fye = fiscalYearEndFromStartMonth(state.fiscalYearStartMonth);
  const dateBad = state.startDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(state.startDate);
  return (
    <div>
      <StepHeading icon={CalendarRange} title="Your dates" subtitle="Most businesses use January to December for both years." />
      <div className="flex flex-col gap-5">
        <div>
          <Label htmlFor="co-fy-start">
            First month of your <Help term="fiscal-year">fiscal year</Help>
          </Label>
          <Select
            id="co-fy-start"
            value={state.fiscalYearStartMonth}
            onChange={(e) => {
              const m = Number(e.target.value);
              // The tax year usually matches the fiscal year: keep them together until changed.
              set({
                fiscalYearStartMonth: m,
                ...(state.taxYearStartMonth === state.fiscalYearStartMonth ? { taxYearStartMonth: m } : {}),
              });
            }}
            aria-describedby="co-fy-hint"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
          <p id="co-fy-hint" className="mt-1 text-xs text-navy/40">
            Your year ends on {MONTH_NAMES[Number(fye.slice(0, 2)) - 1]} {Number(fye.slice(3))}. Not sure? Ask your
            accountant or use January.
          </p>
        </div>
        <div>
          <Label htmlFor="co-tax-start">First month of your income tax year</Label>
          <Select
            id="co-tax-start"
            value={state.taxYearStartMonth}
            onChange={(e) => set({ taxYearStartMonth: Number(e.target.value) })}
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="co-start">Date you want to start tracking your finances here</Label>
          <Input
            id="co-start"
            type="date"
            value={state.startDate}
            onChange={(e) => set({ startDate: e.target.value })}
            aria-describedby="co-start-hint"
          />
          <p id="co-start-hint" className="mt-1 text-xs text-navy/40">
            Usually the first day of this year or of this month. You&apos;ll enter your bank balances as of this date.
          </p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-navy/70 mb-2 flex items-center gap-1">
            How should reports count income? <Help term="accrual-vs-cash" />
          </legend>
          <ChoiceList
            name="report-basis"
            legend="Report basis"
            options={[
              { value: 'accrual', label: 'When I invoice (accrual)', description: 'Recommended. Shows what you earned and owe, even before money moves.' },
              { value: 'cash', label: 'When I get paid (cash)', description: 'Simpler; matches your bank account.' },
            ]}
            value={state.reportBasis}
            onChange={(v) => set({ reportBasis: v })}
          />
          <p className="mt-2 text-xs text-navy/40">This is only the default view — you can switch any report later.</p>
        </fieldset>
      </div>
      <NavButtons
        onBack={onBack}
        onNext={() => {
          if (dateBad) {
            toast('Enter a start date like 2026-01-01, or leave it blank.', 'danger');
            return;
          }
          onNext();
        }}
      />
    </div>
  );
}

function StepFeatures({ state, set, onBack, onNext }: StepProps) {
  return (
    <div>
      <StepHeading icon={ToggleRight} title="What do you need?" subtitle="We'll turn on only what you use. Answering No hides the feature; you can turn it on later in Settings." />
      <div className="flex flex-col gap-3">
        <YesNo
          name="sales-tax"
          question={<span className="inline-flex items-center gap-1">Do you charge <Help term="sales-tax">sales tax</Help>?</span>}
          help="Choose Yes if you collect tax from customers and pay it to a tax agency."
          value={state.salesTax}
          onChange={(v) => set({ salesTax: v })}
        />
        <YesNo
          name="inventory"
          question="Do you keep products in stock?"
          help="Choose Yes to track quantities and costs of items you buy and resell, and to use purchase orders."
          value={state.inventory}
          onChange={(v) => set({ inventory: v, inventoryTouched: true })}
        />
        <YesNo
          name="employees"
          question="Do you have employees?"
          help="Yes turns payroll on. No hides pay runs and payroll forms (your employee list stays). Independent contractors don't count — pay them as vendors."
          value={state.employees}
          onChange={(v) => set({ employees: v })}
        />
        <YesNo
          name="estimates"
          question="Do you give customers estimates or quotes?"
          help="Choose Yes to write estimates and turn them into invoices."
          value={state.estimates}
          onChange={(v) => set({ estimates: v, ...(v ? {} : { progressInvoicing: false }) })}
        />
        {state.estimates && (
          <YesNo
            name="progress-invoicing"
            question="Do you bill a job in parts (progress invoicing)?"
            help="Choose Yes to invoice part of an estimate at a time, for example 30% up front."
            value={state.progressInvoicing}
            onChange={(v) => set({ progressInvoicing: v })}
          />
        )}
        <YesNo
          name="time-tracking"
          question="Do you track hours worked for customers?"
          help="Choose Yes to enter time and bill it to customers."
          value={state.timeTracking}
          onChange={(v) => set({ timeTracking: v })}
        />
        <YesNo
          name="class-tracking"
          question="Do you want to split reports by department or location (classes)?"
          help="Choose Yes to tag transactions with a class and see a profit and loss for each."
          value={state.classTracking}
          onChange={(v) => set({ classTracking: v })}
        />
        <YesNo
          name="multi-currency"
          question="Do you have customers or vendors that use another currency?"
          help="Choose Yes only if you bill or pay in more than one currency."
          value={state.multiCurrency}
          onChange={(v) => set({ multiCurrency: v })}
        />
      </div>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepFinish({
  state,
  onBack,
  onDone,
}: {
  state: WizardState;
  onBack: () => void;
  onDone: (nextSteps: SetupStep[], accountsAdded: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [existing, setExisting] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<{ code: string; name: string }[]>('/api/accounts?includeInactive=true')
      .then(setExisting)
      .catch(() => setExisting([]));
  }, []);
  const preview = useMemo(() => buildSetupPlan(toAnswers(state), existing), [state, existing]);
  const bt = businessTypeOption(state.businessType);
  const entity = entityTypeOption(state.entityType);

  async function handleFinish() {
    setLoading(true);
    try {
      const res = await api.post<{ nextSteps: SetupStep[]; accountsAdded: number }>(
        '/api/company/setup-interview',
        toAnswers(state),
      );
      onDone(res.nextSteps, res.accountsAdded);
    } catch (err) {
      toastError(err, 'We could not finish setting up your company. Nothing was changed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <StepHeading icon={ClipboardCheck} title="Ready to set up your books" subtitle="Check your answers. Use Back to change anything." />
      <p className="text-sm font-semibold text-navy mb-1">{state.company.name}</p>
      <ul className="rounded-xl border border-slate-100 bg-slate-50 divide-y divide-slate-100 text-sm" aria-label="What will be saved">
        {preview.summary.map((row) => (
          <li key={row} className="px-4 py-2 text-navy">
            {row}
          </li>
        ))}
      </ul>
      {preview.accounts.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="font-semibold text-navy mb-1">
            Accounts we&apos;ll add for a {bt.label.toLowerCase()} business ({entity.label.toLowerCase()}):
          </p>
          <p className="text-navy/60 text-xs leading-relaxed">{preview.accounts.map((a) => a.name).join(' · ')}</p>
          <p className="text-navy/40 text-xs mt-1">
            Plus the standard chart: checking, savings, A/R, A/P, sales tax, equity and common expenses.
          </p>
        </div>
      )}
      <NavButtons onBack={onBack} onNext={handleFinish} loading={loading} nextLabel="Finish setup" />
    </div>
  );
}

function StepDone({ name, nextSteps, accountsAdded }: { name: string; nextSteps: SetupStep[]; accountsAdded: number }) {
  return (
    <div className="flex flex-col items-center text-center gap-5">
      <div className="h-20 w-20 rounded-full bg-emerald/10 flex items-center justify-center">
        <CheckCircle2 className="h-12 w-12 text-emerald" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-2xl font-extrabold text-navy mb-2" tabIndex={-1} data-step-heading>
          You&apos;re all set!
        </h2>
        <p className="text-navy/60 text-sm max-w-sm leading-relaxed">
          <strong className="text-navy">{name}</strong> is ready with a chart of accounts
          {accountsAdded > 0 ? ` (including ${accountsAdded} new account${accountsAdded === 1 ? '' : 's'} for your business)` : ''} and
          your features switched on or off as you chose.
        </p>
      </div>
      <div className="w-full text-left">
        <p className="font-semibold text-navy text-xs uppercase tracking-wide mb-2">Suggested next steps</p>
        <ol className="space-y-2">
          {nextSteps.map((s, i) => (
            <li key={s.href}>
              <Link
                href={s.href}
                className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-electric"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-electric/10 text-xs font-bold text-electric">
                  {i + 1}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-navy">{s.label}</span>
                  <span className="block text-xs text-navy/50">{s.why}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
      <a
        href="/dashboard"
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-electric px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none hover:bg-electric/90 focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1"
      >
        Go to Home
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

function Interview() {
  const params = useSearchParams();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [rerun, setRerun] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [done, setDone] = useState<{ nextSteps: SetupStep[]; accountsAdded: number } | null>(null);

  const set = (patch: Partial<WizardState>) => setState((prev) => ({ ...prev, ...patch }));

  // The interview always sets up the company that is open: pre-fill from it.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ name: string; settings: Record<string, unknown> | null }>('/api/company'),
      api.get<{ status: string } | null>('/api/company/setup-interview').catch(() => null),
    ])
      .then(([company, rec]) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, ...prefill(company, params.get('new') === '1') }));
        setRerun(Boolean(rec) && params.get('new') !== '1');
      })
      .catch(() => {
        /* not signed in yet: the API client sends the user to sign in */
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  // Move keyboard/screen-reader focus to the new step's heading on navigation.
  function go(n: number) {
    setStep(n);
    setTimeout(() => {
      document.querySelector<HTMLElement>('[data-step-heading]')?.focus();
    }, 0);
  }

  async function skip() {
    setSkipping(true);
    try {
      await api.post('/api/company/setup-interview', { skip: true });
    } catch {
      // Skipping must never trap the user (e.g. a role that can't change company settings).
    }
    window.location.href = '/dashboard';
  }

  const steps = [
    <StepWelcome key="w" rerun={rerun} onNext={() => go(2)} />,
    <StepCompany key="c" state={state} set={set} onBack={() => go(1)} onNext={() => go(3)} />,
    <StepBusiness key="b" state={state} set={set} onBack={() => go(2)} onNext={() => go(4)} />,
    <StepEntity key="e" state={state} set={set} onBack={() => go(3)} onNext={() => go(5)} />,
    <StepDates key="d" state={state} set={set} onBack={() => go(4)} onNext={() => go(6)} />,
    <StepFeatures key="f" state={state} set={set} onBack={() => go(5)} onNext={() => go(7)} />,
    <StepFinish
      key="r"
      state={state}
      onBack={() => go(6)}
      onDone={(nextSteps, accountsAdded) => setDone({ nextSteps, accountsAdded })}
    />,
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-4 sm:p-8 font-sans flex items-center justify-center">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="h-9 w-9 rounded-xl bg-electric flex items-center justify-center">
            <BookOpen className="h-5 w-5 text-white" aria-hidden="true" />
          </div>
          <span className="text-xl font-extrabold text-navy tracking-tight">BookKeeper AI</span>
        </div>

        {!done && <StepIndicator current={step} />}

        <Card className="p-6 sm:p-8">
          {done ? (
            <StepDone name={state.company.name} nextSteps={done.nextSteps} accountsAdded={done.accountsAdded} />
          ) : (
            steps[step - 1]
          )}
        </Card>

        {!done && (
          <div className="mt-6 flex items-center justify-between text-xs text-navy/40">
            <span>
              Step {step} of {STEPS.length}
            </span>
            <button
              type="button"
              onClick={skip}
              disabled={skipping}
              className="font-semibold text-navy/60 underline-offset-2 hover:text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
            >
              {skipping ? 'Skipping…' : rerun ? 'Close without changes' : 'Skip for now'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <Interview />
    </Suspense>
  );
}
