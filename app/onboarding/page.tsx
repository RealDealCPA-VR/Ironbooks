'use client';

/**
 * First-run setup — an EasyStep-style interview in plain language.
 *
 * Step 1 — Welcome (+ prominent "Coming from QuickBooks Desktop?" link to /qb-import)
 * Step 2 — Company name + currency
 * Step 3 — What kind of business? (picks the industry chart-of-accounts template)
 * Step 4 — Fiscal year start month + accrual/cash reporting
 * Step 5 — Yes/no: sales tax, inventory, employees
 * Step 6 — Review & create, then a "what's next" checklist
 *
 * The answers become a setup plan (lib/onboarding.ts buildSetupPlan): Preferences switched on
 * via PATCH /api/company { settings } and template accounts added via POST /api/accounts. The
 * company is created once; if a later step fails, "Try again" resumes without creating a
 * second company. No opening balances are posted, so the books start in balance.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
  Store,
  CalendarRange,
  ToggleRight,
  ClipboardCheck,
} from 'lucide-react';
import { Button, Card, Input, Select, Label, toast, toastError } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';
import {
  BUSINESS_TYPES,
  buildSetupPlan,
  businessTypeOption,
  fiscalYearEndFromStartMonth,
  type BusinessType,
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

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STEPS = [
  { label: 'Welcome', icon: BookOpen },
  { label: 'Company', icon: Building2 },
  { label: 'Business', icon: Store },
  { label: 'Year', icon: CalendarRange },
  { label: 'Features', icon: ToggleRight },
  { label: 'Create', icon: ClipboardCheck },
];

interface WizardState extends InterviewAnswers {
  name: string;
  currency: string;
  /** Whether the user has touched the inventory question (else it follows the business type). */
  inventoryTouched: boolean;
}

const INITIAL: WizardState = {
  name: '',
  currency: 'USD',
  businessType: 'service',
  fiscalYearStartMonth: 1,
  reportBasis: 'accrual',
  salesTax: false,
  inventory: false,
  employees: false,
  inventoryTouched: false,
};

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
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === v}
              onChange={() => onChange(v)}
            />
            {v ? 'Yes' : 'No'}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div className="h-20 w-20 rounded-2xl bg-electric/10 flex items-center justify-center">
        <BookOpen className="h-10 w-10 text-electric" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-2xl font-extrabold text-navy mb-2" tabIndex={-1} data-step-heading>
          Welcome to BookKeeper AI
        </h2>
        <p className="text-navy/60 text-sm max-w-sm leading-relaxed mx-auto">
          A few easy questions about your business and we&apos;ll set up your books — the right
          accounts, your fiscal year, and only the features you need. About two minutes. You can
          change every answer later in Settings.
        </p>
      </div>

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

      <Button className="w-full" onClick={onNext}>
        Start fresh — set up a new company
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function StepCompany({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const nameMissing = !state.name.trim();
  return (
    <div>
      <StepHeading icon={Building2} title="What's your company called?" subtitle="This appears on invoices and reports." />
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="co-name" required>Company name</Label>
          <Input
            id="co-name"
            placeholder="e.g. Acme Plumbing LLC"
            value={state.name}
            onChange={(e) => set({ name: e.target.value })}
            onBlur={() => setTouched(true)}
            aria-required="true"
            aria-invalid={touched && nameMissing ? true : undefined}
            aria-describedby={touched && nameMissing ? 'co-name-err' : undefined}
            autoFocus
          />
          {touched && nameMissing && (
            <p id="co-name-err" className="mt-1 text-xs text-red-600">Enter your company name to continue.</p>
          )}
        </div>
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
      <NavButtons
        onBack={onBack}
        onNext={() => {
          setTouched(true);
          if (nameMissing) {
            toast('Enter your company name to continue.', 'danger');
            return;
          }
          onNext();
        }}
      />
    </div>
  );
}

function StepBusiness({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <StepHeading
        icon={Store}
        title="What kind of business is it?"
        subtitle="We'll add the income and expense accounts businesses like yours usually need."
      />
      <fieldset>
        <legend className="sr-only">Business type</legend>
        <div className="grid grid-cols-1 gap-2">
          {BUSINESS_TYPES.map((bt) => {
            const checked = state.businessType === bt.value;
            return (
              <label
                key={bt.value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-electric/50',
                  checked ? 'border-electric bg-electric/5' : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <input
                  type="radio"
                  name="business-type"
                  value={bt.value}
                  checked={checked}
                  onChange={() =>
                    set({
                      businessType: bt.value as BusinessType,
                      // Pre-answer the inventory question until the user answers it themselves.
                      ...(state.inventoryTouched ? {} : { inventory: bt.suggestsInventory }),
                    })
                  }
                  className="mt-1 accent-electric"
                />
                <span>
                  <span className="block text-sm font-semibold text-navy">{bt.label}</span>
                  <span className="block text-xs text-navy/50">{bt.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepYear({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const fye = fiscalYearEndFromStartMonth(state.fiscalYearStartMonth);
  return (
    <div>
      <StepHeading icon={CalendarRange} title="Your accounting year" subtitle="Most businesses use January to December." />
      <div className="flex flex-col gap-5">
        <div>
          <Label htmlFor="co-fy-start">
            First month of your <Help term="fiscal-year">fiscal year</Help>
          </Label>
          <Select
            id="co-fy-start"
            value={state.fiscalYearStartMonth}
            onChange={(e) => set({ fiscalYearStartMonth: Number(e.target.value) })}
            aria-describedby="co-fy-hint"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
          <p id="co-fy-hint" className="mt-1 text-xs text-navy/40">
            Your year ends on {MONTHS[Number(fye.slice(0, 2)) - 1]} {Number(fye.slice(3))}. Not sure? Ask your
            accountant or use January.
          </p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-navy/70 mb-2 flex items-center gap-1">
            How should reports count income? <Help term="accrual-vs-cash" />
          </legend>
          <div className="grid grid-cols-1 gap-2">
            {(
              [
                { v: 'accrual', title: 'When I invoice (accrual)', text: 'Recommended. Shows what you earned and owe, even before money moves.' },
                { v: 'cash', title: 'When I get paid (cash)', text: 'Simpler; matches your bank account.' },
              ] as const
            ).map((o) => (
              <label
                key={o.v}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-electric/50',
                  state.reportBasis === o.v ? 'border-electric bg-electric/5' : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <input
                  type="radio"
                  name="report-basis"
                  checked={state.reportBasis === o.v}
                  onChange={() => set({ reportBasis: o.v })}
                  className="mt-1 accent-electric"
                />
                <span>
                  <span className="block text-sm font-semibold text-navy">{o.title}</span>
                  <span className="block text-xs text-navy/50">{o.text}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-navy/40">This is only the default view — you can switch any report later.</p>
        </fieldset>
      </div>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepFeatures({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <StepHeading icon={ToggleRight} title="What do you need?" subtitle="We'll turn on only what you use. You can change this later." />
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
          help="Choose Yes to track quantities and costs of items you buy and resell."
          value={state.inventory}
          onChange={(v) => set({ inventory: v, inventoryTouched: true })}
        />
        <YesNo
          name="employees"
          question="Do you have employees?"
          help="Choose Yes to run payroll here. (Independent contractors don't count — pay them as vendors.)"
          value={state.employees}
          onChange={(v) => set({ employees: v })}
        />
      </div>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepCreate({
  state,
  onBack,
  onDone,
}: {
  state: WizardState;
  onBack: () => void;
  onDone: (nextSteps: SetupStep[], accountsAdded: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  // Remember the company once created so a retry never creates a duplicate.
  const [companyId, setCompanyId] = useState<string | null>(null);
  const preview = useMemo(() => buildSetupPlan(state), [state]);
  const bt = businessTypeOption(state.businessType);

  async function handleCreate() {
    setLoading(true);
    try {
      let id = companyId;
      if (!id) {
        const company = await api.post<{ id: string }>('/api/companies', { name: state.name.trim() });
        id = company.id;
        setCompanyId(id);
      }
      await api.post('/api/companies/select', { companyId: id });

      // Build the real plan against the seeded chart so nothing is duplicated.
      const existing = await api.get<{ code: string; name: string }[]>('/api/accounts?includeInactive=true');
      const plan = buildSetupPlan(state, existing);

      await api.patch('/api/company', { settings: { currency: state.currency, ...plan.settings } });

      let added = 0;
      const failed: string[] = [];
      for (const a of plan.accounts) {
        try {
          await api.post('/api/accounts', a);
          added++;
        } catch {
          failed.push(a.name);
        }
      }
      if (failed.length) {
        toast(
          `Your company is ready, but ${failed.length} suggested account${failed.length === 1 ? '' : 's'} could not be added (${failed.join(', ')}). You can add them in Chart of Accounts.`,
          'info',
        );
      }
      onDone(plan.nextSteps, added);
    } catch (err) {
      toastError(err, 'We could not finish setting up your company.');
    } finally {
      setLoading(false);
    }
  }

  const rows = [
    { label: 'Company', value: state.name },
    { label: 'Business type', value: bt.label },
    { label: 'Currency', value: state.currency },
    {
      label: 'Fiscal year',
      value: `Starts in ${MONTHS[state.fiscalYearStartMonth - 1]} (ends ${preview.settings.fiscalYearEnd as string})`,
    },
    { label: 'Reports count income', value: state.reportBasis === 'cash' ? 'When paid (cash)' : 'When invoiced (accrual)' },
    { label: 'Sales tax', value: state.salesTax ? 'On' : 'Off' },
    { label: 'Inventory tracking', value: state.inventory ? 'On' : 'Off' },
    { label: 'Payroll', value: state.employees ? 'On (every 2 weeks, 40-hour week)' : 'Off' },
  ];

  return (
    <div>
      <StepHeading icon={ClipboardCheck} title="Ready to set up your books" subtitle="Check your answers. Use Back to change anything." />
      <dl className="rounded-xl border border-slate-100 bg-slate-50 divide-y divide-slate-100 text-sm">
        {rows.map(({ label, value }, i) => (
          <div key={i} className="flex justify-between gap-4 px-4 py-2.5">
            <dt className="text-navy/50 font-medium">{label}</dt>
            <dd className="text-navy font-semibold text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {preview.accounts.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="font-semibold text-navy mb-1">
            Accounts we&apos;ll add for a {bt.label.toLowerCase()} business:
          </p>
          <p className="text-navy/60 text-xs leading-relaxed">{preview.accounts.map((a) => a.name).join(' · ')}</p>
          <p className="text-navy/40 text-xs mt-1">
            Plus the standard chart: checking, savings, A/R, A/P, sales tax, equity and common expenses.
          </p>
        </div>
      )}
      <NavButtons
        onBack={onBack}
        onNext={handleCreate}
        loading={loading}
        nextLabel={companyId ? 'Try again' : 'Create my company'}
      />
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
          {accountsAdded > 0 ? ` (including ${accountsAdded} account${accountsAdded === 1 ? '' : 's'} for your industry)` : ''} and
          your preferences turned on.
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
      <Link
        href="/dashboard"
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-electric px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none hover:bg-electric/90 focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1"
      >
        Go to Home
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [done, setDone] = useState<{ nextSteps: SetupStep[]; accountsAdded: number } | null>(null);

  const set = (patch: Partial<WizardState>) => setState((prev) => ({ ...prev, ...patch }));

  // Move keyboard/screen-reader focus to the new step's heading on navigation.
  function go(n: number) {
    setStep(n);
    setTimeout(() => {
      document.querySelector<HTMLElement>('[data-step-heading]')?.focus();
    }, 0);
  }

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
            <StepDone name={state.name} nextSteps={done.nextSteps} accountsAdded={done.accountsAdded} />
          ) : (
            <>
              {step === 1 && <StepWelcome onNext={() => go(2)} />}
              {step === 2 && <StepCompany state={state} set={set} onBack={() => go(1)} onNext={() => go(3)} />}
              {step === 3 && <StepBusiness state={state} set={set} onBack={() => go(2)} onNext={() => go(4)} />}
              {step === 4 && <StepYear state={state} set={set} onBack={() => go(3)} onNext={() => go(5)} />}
              {step === 5 && <StepFeatures state={state} set={set} onBack={() => go(4)} onNext={() => go(6)} />}
              {step === 6 && (
                <StepCreate
                  state={state}
                  onBack={() => go(5)}
                  onDone={(nextSteps, accountsAdded) => setDone({ nextSteps, accountsAdded })}
                />
              )}
            </>
          )}
        </Card>

        {!done && (
          <p className="text-center text-xs text-navy/30 mt-6">
            Step {step} of {STEPS.length}
          </p>
        )}
      </div>
    </main>
  );
}
