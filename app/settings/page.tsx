'use client';

/**
 * Settings — QBD-style Preferences dialog.
 *
 * Tabbed preference panes (Company, Accounting, Sales & Customers, Purchases &
 * Vendors, Payroll, Inventory, Custom Fields, Users & Roles, Backup) persisting
 * to companies.settings via PATCH /api/company { name?, settings } — validated
 * by lib/validation/company.ts and whitelisted in lib/services/company.ts.
 *
 * Keys read by services TODAY: fiscalYearEnd (year-end close, dashboard),
 * currency/timezone (display), closingDate (+password, via its own endpoint).
 * Everything else is a default for NEW documents and is labeled as such.
 *
 * wave2 prefs: the full QB category list (Bills, Checking, General, Items & Inventory, Jobs &
 * Estimates, Multiple Currencies, Payments, Reminders, Reports, Sales Tax, Send Forms, Spelling,
 * Time & Expenses, Form Templates) renders <PreferencePane> with Company Preferences and My
 * Preferences; consumers read them through getPreferences / usePreferences (lib/preferences.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bell,
  BookOpen,
  Briefcase,
  Building2,
  Calculator,
  Clock,
  Coins,
  CreditCard,
  Database,
  Download,
  FileText,
  HandCoins,
  Lock,
  Mail,
  Package,
  Percent,
  PieChart,
  Settings,
  ShoppingCart,
  SpellCheck,
  Tags,
  Truck,
  Upload,
  Users,
  Wallet,
} from 'lucide-react';
import PreferencePane from './PreferencePane';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  PageSkeleton,
  Select,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CustomFieldDef {
  name: string;
}
type CustomFieldEntity = 'customer' | 'vendor' | 'item' | 'invoice';
type CustomFieldsSetting = Record<CustomFieldEntity, CustomFieldDef[]>;

interface CompanySettings {
  legalName?: string;
  ein?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  email?: string;
  fiscalYearEnd?: string;
  currency?: string;
  timezone?: string;
  accountNumbersEnabled?: boolean;
  reportBasis?: 'accrual' | 'cash';
  defaultCustomerTerms?: string;
  defaultInvoiceMemo?: string;
  defaultVendorTerms?: string;
  defaultExpenseAccountId?: string | null;
  payrollPayPeriod?: string;
  payrollStandardHours?: number;
  payrollExpenseAccountId?: string | null;
  payrollLiabilityAccountId?: string | null;
  negativeStockWarning?: boolean;
  customFields?: Partial<CustomFieldsSetting>;
}

interface Company {
  id: string;
  name: string;
  settings?: (CompanySettings & Record<string, unknown>) | null;
}

interface ClosingDateSettings {
  closingDate: string | null;
  hasPassword: boolean;
}

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  isOwner: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isActive?: boolean;
}

interface InvoiceRow {
  invoiceNumber?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLES = [
  { value: 'viewer', label: 'Viewer (read-only)' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN'];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Europe/Helsinki',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

const TERMS = [
  { value: 'due_on_receipt', label: 'Due on receipt' },
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_60', label: 'Net 60' },
];

const PAY_PERIODS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
];

const CUSTOM_FIELD_ENTITIES: Array<{ key: CustomFieldEntity; label: string }> = [
  { key: 'customer', label: 'Customers' },
  { key: 'vendor', label: 'Vendors' },
  { key: 'item', label: 'Items' },
  { key: 'invoice', label: 'Invoices' },
];

// QB Preferences categories (alphabetical like QB, after Company info). Panes marked in
// PANE_FOR_TAB render the categorized PreferencePane (Company + My Preferences).
const TABS = [
  { id: 'company', label: 'Company', icon: Building2 },
  { id: 'accounting', label: 'Accounting', icon: Calculator },
  { id: 'purchases', label: 'Bills', icon: Truck },
  { id: 'checking', label: 'Checking', icon: CreditCard },
  { id: 'general', label: 'General', icon: Settings },
  { id: 'inventory', label: 'Items & Inventory', icon: Package },
  { id: 'jobs', label: 'Jobs & Estimates', icon: Briefcase },
  { id: 'currencies', label: 'Multiple Currencies', icon: Coins },
  { id: 'payments', label: 'Payments', icon: HandCoins },
  { id: 'payroll', label: 'Payroll & Employees', icon: Wallet },
  { id: 'reminders', label: 'Reminders', icon: Bell },
  { id: 'reports', label: 'Reports & Graphs', icon: PieChart },
  { id: 'sales', label: 'Sales & Customers', icon: ShoppingCart },
  { id: 'salesTax', label: 'Sales Tax', icon: Percent },
  { id: 'sendForms', label: 'Send Forms', icon: Mail },
  { id: 'spelling', label: 'Spelling', icon: SpellCheck },
  { id: 'time', label: 'Time & Expenses', icon: Clock },
  { id: 'templates', label: 'Form Templates', icon: FileText },
  { id: 'customFields', label: 'Custom Fields', icon: Tags },
  { id: 'users', label: 'Users & Roles', icon: Users },
  { id: 'backup', label: 'Backup', icon: Database },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Tab → PREFERENCE_CATEGORIES id rendered with <PreferencePane>. */
const PANE_FOR_TAB: Partial<Record<TabId, string>> = {
  accounting: 'accounting',
  purchases: 'bills',
  checking: 'checking',
  general: 'general',
  inventory: 'items',
  jobs: 'jobs',
  currencies: 'currencies',
  payments: 'payments',
  payroll: 'payroll',
  reminders: 'reminders',
  reports: 'reports',
  sales: 'sales',
  salesTax: 'salesTax',
  sendForms: 'sendForms',
  spelling: 'spelling',
  time: 'time',
};

/** Company keys the original panes on this page already edit (not repeated in PreferencePane). */
const LEGACY_PANE_KEYS = [
  'currency',
  'fiscalYearEnd',
  'timezone',
  'accountNumbersEnabled',
  'reportBasis',
  'defaultCustomerTerms',
  'defaultInvoiceMemo',
  'defaultVendorTerms',
  'defaultExpenseAccountId',
  'payrollPayPeriod',
  'payrollStandardHours',
  'payrollExpenseAccountId',
  'payrollLiabilityAccountId',
  'negativeStockWarning',
];

const FYE_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function emptyCustomFields(): CustomFieldsSetting {
  return { customer: [], vendor: [], item: [], invoice: [] };
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/** "Applies to new documents" advisory marker for preference defaults. */
function AdvisoryBadge({ label = 'Applies to new documents' }: { label?: string }) {
  return (
    <Badge tone="info" className="ml-2 align-middle">
      {label}
    </Badge>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  label,
  help,
  advisory,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  help?: string;
  advisory?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
      />
      <div>
        <Label htmlFor={id} className="mb-0 cursor-pointer">
          {label}
          {advisory !== undefined && <AdvisoryBadge label={advisory || undefined} />}
        </Label>
        {help && <p className="mt-0.5 text-xs text-navy/50">{help}</p>}
      </div>
    </div>
  );
}

function AccountSelect({
  id,
  value,
  onChange,
  accounts,
  types,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  accounts: Account[];
  types: Account['type'][];
  placeholder: string;
}) {
  const options = accounts.filter((a) => types.includes(a.type) && a.isActive !== false);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.code} — {a.name}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [tab, setTab] = useState<TabId>('company');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [companyName, setCompanyName] = useState('');
  const [s, setS] = useState<CompanySettings>({});
  const patch = (p: Partial<CompanySettings>) => setS((prev) => ({ ...prev, ...p }));

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [nextInvoiceNumber, setNextInvoiceNumber] = useState<number | null>(null);

  // Closing date (books protection)
  const [closingDate, setClosingDate] = useState('');
  const [closingHasPassword, setClosingHasPassword] = useState(false);
  const [closingPassword, setClosingPassword] = useState('');
  const [savingClosing, setSavingClosing] = useState(false);

  // Users & roles
  const [members, setMembers] = useState<Member[]>([]);
  const [savingRole, setSavingRole] = useState<string | null>(null);

  // Custom fields draft
  const [customFields, setCustomFields] = useState<CustomFieldsSetting>(emptyCustomFields());

  useEffect(() => {
    api
      .get<Company>('/api/company')
      .then((data) => {
        setCompanyName(data.name ?? '');
        const st = data.settings ?? {};
        setS({
          currency: st.currency ?? 'USD',
          fiscalYearEnd: st.fiscalYearEnd ?? '12-31',
          timezone: st.timezone ?? 'America/New_York',
          legalName: st.legalName ?? '',
          ein: st.ein ?? '',
          addressLine1: st.addressLine1 ?? '',
          addressLine2: st.addressLine2 ?? '',
          city: st.city ?? '',
          state: st.state ?? '',
          zip: st.zip ?? '',
          country: st.country ?? '',
          phone: st.phone ?? '',
          email: st.email ?? '',
          accountNumbersEnabled: st.accountNumbersEnabled ?? true,
          reportBasis: st.reportBasis ?? 'accrual',
          defaultCustomerTerms: st.defaultCustomerTerms ?? 'net_30',
          defaultInvoiceMemo: st.defaultInvoiceMemo ?? '',
          defaultVendorTerms: st.defaultVendorTerms ?? 'net_30',
          defaultExpenseAccountId: st.defaultExpenseAccountId ?? null,
          payrollPayPeriod: st.payrollPayPeriod ?? 'biweekly',
          payrollStandardHours: st.payrollStandardHours ?? 40,
          payrollExpenseAccountId: st.payrollExpenseAccountId ?? null,
          payrollLiabilityAccountId: st.payrollLiabilityAccountId ?? null,
          negativeStockWarning: st.negativeStockWarning ?? true,
        });
      })
      .catch((err: ApiError) => toast(err.message || 'Failed to load company settings', 'danger'))
      .finally(() => setLoading(false));

    // Custom-field definitions come from the dedicated endpoint (it normalizes
    // settings.customFields), so this page and the list pages stay in sync.
    api
      .get<Partial<CustomFieldsSetting>>('/api/custom-fields')
      .then((defs) => setCustomFields({ ...emptyCustomFields(), ...defs }))
      .catch(() => {});

    api
      .get<ClosingDateSettings>('/api/company/closing-date')
      .then((data) => {
        setClosingDate(data.closingDate ?? '');
        setClosingHasPassword(data.hasPassword);
      })
      .catch(() => {});

    api.get<Member[]>('/api/users').then(setMembers).catch(() => {});
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
    api
      .get<InvoiceRow[]>('/api/invoices')
      .then((rows) => {
        const max = rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber ?? 0)), 0);
        setNextInvoiceNumber(max + 1);
      })
      .catch(() => {});
  }, []);

  /** Persist a subset of settings (one tab) — optionally the company name too. */
  async function saveSettings(
    keys: (keyof CompanySettings)[],
    opts?: { name?: string; extra?: Record<string, unknown> },
  ) {
    const settings: Record<string, unknown> = { ...(opts?.extra ?? {}) };
    for (const k of keys) {
      const v = s[k];
      if (v !== undefined) settings[k] = v; // '' clears text fields; null clears account ids
    }
    setSaving(true);
    try {
      const updated = await api.patch<Company>('/api/company', {
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
        settings,
      });
      if (opts?.name !== undefined) setCompanyName(updated.name);
      toast('Preferences saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save preferences', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveClosingDate(e: React.FormEvent) {
    e.preventDefault();
    if (!closingDate) {
      toast('Pick a closing date first (or use Clear to remove it)', 'danger');
      return;
    }
    setSavingClosing(true);
    try {
      const updated = await api.patch<ClosingDateSettings>('/api/company/closing-date', {
        closingDate,
        ...(closingPassword ? { password: closingPassword } : {}),
      });
      setClosingDate(updated.closingDate ?? '');
      setClosingHasPassword(updated.hasPassword);
      setClosingPassword('');
      toast('Closing date saved. Transactions on or before this date are now protected.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save closing date', 'danger');
    } finally {
      setSavingClosing(false);
    }
  }

  async function handleClearClosingDate() {
    setSavingClosing(true);
    try {
      const updated = await api.patch<ClosingDateSettings>('/api/company/closing-date', {
        closingDate: null,
      });
      setClosingDate(updated.closingDate ?? '');
      setClosingHasPassword(updated.hasPassword);
      setClosingPassword('');
      toast('Closing date cleared', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to clear closing date', 'danger');
    } finally {
      setSavingClosing(false);
    }
  }

  async function handleRoleChange(userId: string, role: string) {
    setSavingRole(userId);
    try {
      const updated = await api.patch<Member>(`/api/users/${userId}`, { role });
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: updated.role } : m)));
      toast('Role updated', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update role', 'danger');
    } finally {
      setSavingRole(null);
    }
  }

  async function handleSaveCustomFields() {
    for (const { key, label } of CUSTOM_FIELD_ENTITIES) {
      if (customFields[key].some((f) => !f.name.trim())) {
        toast(`Every ${label.toLowerCase()} custom field needs a name`, 'danger');
        return;
      }
    }
    const cleaned = Object.fromEntries(
      CUSTOM_FIELD_ENTITIES.map(({ key }) => [
        key,
        customFields[key].map((f) => ({ name: f.name.trim() })),
      ]),
    ) as CustomFieldsSetting;
    setSaving(true);
    try {
      // PATCH the dedicated endpoint (admin-only, normalizes + audits) rather
      // than writing settings.customFields directly — one write path app-wide.
      const saved = await api.patch<Partial<CustomFieldsSetting>>('/api/custom-fields', cleaned);
      setCustomFields({ ...emptyCustomFields(), ...saved });
      toast('Custom field definitions saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save custom fields', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const activeTab = useMemo(() => TABS.find((t) => t.id === tab) ?? TABS[0], [tab]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Preferences" icon={Settings} />

      {loading ? (
        <PageSkeleton />
      ) : (
        <div className="flex gap-8 max-w-5xl items-start">
          {/* Tab rail (QBD Preferences category list) */}
          <nav className="w-56 shrink-0 rounded-2xl bg-white/70 border border-slate-200 p-2 flex flex-col gap-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                    active ? 'bg-electric text-white shadow-sm' : 'text-navy/70 hover:bg-electric/10 hover:text-navy'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </nav>

          {/* Active pane */}
          <div className="flex-1 flex flex-col gap-8 min-w-0">
            {/* ── Company ─────────────────────────────────────────────────── */}
            {tab === 'company' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Company Information</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Shown on invoices, statements, and tax forms.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    // Compose the single-line employer address read by payroll
                    // W-2 / 940 reports (settings.address) from the parts.
                    const cityStateZip = [s.city, [s.state, s.zip].filter(Boolean).join(' ')]
                      .filter(Boolean)
                      .join(', ');
                    const address = [s.addressLine1, s.addressLine2, cityStateZip]
                      .map((p) => p?.trim())
                      .filter(Boolean)
                      .join(', ');
                    void saveSettings(
                      ['legalName', 'ein', 'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'phone', 'email'],
                      { name: companyName, extra: { address } },
                    );
                  }}
                  className="flex flex-col gap-5"
                >
                  <div className="grid grid-cols-2 gap-5">
                    <div>
                      <Label htmlFor="company-name">Business Name</Label>
                      <Input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} required />
                    </div>
                    <div>
                      <Label htmlFor="legal-name">Legal Name</Label>
                      <Input id="legal-name" value={s.legalName ?? ''} onChange={(e) => patch({ legalName: e.target.value })} placeholder="Acme Corp, Inc." />
                    </div>
                    <div>
                      <Label htmlFor="ein">EIN</Label>
                      <Input id="ein" value={s.ein ?? ''} onChange={(e) => patch({ ein: e.target.value })} placeholder="12-3456789" />
                    </div>
                    <div>
                      <Label htmlFor="phone">Phone</Label>
                      <Input id="phone" value={s.phone ?? ''} onChange={(e) => patch({ phone: e.target.value })} placeholder="(555) 555-5555" />
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor="email">Email</Label>
                      <Input id="email" type="email" value={s.email ?? ''} onChange={(e) => patch({ email: e.target.value })} placeholder="billing@acme.com" />
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor="addr1">Address</Label>
                      <Input id="addr1" value={s.addressLine1 ?? ''} onChange={(e) => patch({ addressLine1: e.target.value })} placeholder="Street address" />
                    </div>
                    <div className="col-span-2">
                      <Input id="addr2" value={s.addressLine2 ?? ''} onChange={(e) => patch({ addressLine2: e.target.value })} placeholder="Suite / unit (optional)" />
                    </div>
                    <div>
                      <Label htmlFor="city">City</Label>
                      <Input id="city" value={s.city ?? ''} onChange={(e) => patch({ city: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-5">
                      <div>
                        <Label htmlFor="state">State</Label>
                        <Input id="state" value={s.state ?? ''} onChange={(e) => patch({ state: e.target.value })} />
                      </div>
                      <div>
                        <Label htmlFor="zip">ZIP</Label>
                        <Input id="zip" value={s.zip ?? ''} onChange={(e) => patch({ zip: e.target.value })} />
                      </div>
                    </div>
                  </div>
                  <div className="pt-2">
                    <Button type="submit" loading={saving}>Save Company Info</Button>
                  </div>
                </form>
              </Card>
            )}

            {/* ── Accounting ──────────────────────────────────────────────── */}
            {tab === 'accounting' && (
              <>
                <Card className="p-8">
                  <h2 className="text-lg font-bold text-navy mb-6">Accounting</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!FYE_RE.test(s.fiscalYearEnd ?? '')) {
                        toast('Fiscal year end must be in MM-DD format (e.g. 12-31)', 'danger');
                        return;
                      }
                      void saveSettings(['currency', 'fiscalYearEnd', 'timezone', 'accountNumbersEnabled', 'reportBasis']);
                    }}
                    className="flex flex-col gap-5"
                  >
                    <div className="grid grid-cols-2 gap-5">
                      <div>
                        <Label htmlFor="currency">Currency</Label>
                        <Select id="currency" value={s.currency ?? 'USD'} onChange={(e) => patch({ currency: e.target.value })}>
                          {CURRENCIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="fiscal-year-end">Fiscal Year End (MM-DD)</Label>
                        <Input
                          id="fiscal-year-end"
                          value={s.fiscalYearEnd ?? ''}
                          onChange={(e) => patch({ fiscalYearEnd: e.target.value })}
                          placeholder="12-31"
                          pattern="(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])"
                          title="Format: MM-DD, e.g. 12-31"
                        />
                      </div>
                      <div>
                        <Label htmlFor="timezone">Timezone</Label>
                        <Select id="timezone" value={s.timezone ?? 'UTC'} onChange={(e) => patch({ timezone: e.target.value })}>
                          {TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>{tz}</option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="report-basis">
                          Default Report Basis
                          <AdvisoryBadge label="Report default only" />
                        </Label>
                        <Select
                          id="report-basis"
                          value={s.reportBasis ?? 'accrual'}
                          onChange={(e) => patch({ reportBasis: e.target.value as 'accrual' | 'cash' })}
                        >
                          <option value="accrual">Accrual</option>
                          <option value="cash">Cash</option>
                        </Select>
                        <p className="mt-1 text-xs text-navy/50">Pre-selects the basis on reports that support both.</p>
                      </div>
                    </div>
                    <Toggle
                      id="account-numbers"
                      checked={s.accountNumbersEnabled ?? true}
                      onChange={(v) => patch({ accountNumbersEnabled: v })}
                      label="Use account numbers"
                      advisory="Display preference"
                      help="Show account numbers alongside names in the chart of accounts and on forms."
                    />
                    <div className="pt-2">
                      <Button type="submit" loading={saving}>Save Accounting</Button>
                    </div>
                  </form>
                </Card>

                {/* Closing date (books protection) — enforced by the posting layer */}
                <Card className="p-8">
                  <h2 className="text-lg font-bold text-navy mb-1 flex items-center gap-2">
                    <Lock className="h-5 w-5 text-electric" />
                    Set Closing Date
                  </h2>
                  <p className="text-sm text-navy/50 mb-6">
                    Protect prior-period books: transactions dated on or before the closing date cannot be
                    added, edited, or voided without the closing-date password.
                  </p>
                  <form onSubmit={handleSaveClosingDate} className="flex flex-col gap-5">
                    <div>
                      <Label htmlFor="closing-date">Closing Date</Label>
                      <Input id="closing-date" type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} />
                      {closingDate ? (
                        <p className="mt-1 text-xs text-navy/50">
                          Books are closed through {closingDate}
                          {closingHasPassword ? ' (password protected)' : ' (no password set)'}.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-navy/50">No closing date is currently set.</p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="closing-password">Closing Date Password</Label>
                      <Input
                        id="closing-password"
                        type="password"
                        value={closingPassword}
                        onChange={(e) => setClosingPassword(e.target.value)}
                        placeholder={closingHasPassword ? 'Leave blank to keep current password' : 'Optional password'}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="flex gap-3 pt-2">
                      <Button type="submit" loading={savingClosing}>Save Closing Date</Button>
                      {closingDate && (
                        <Button type="button" variant="ghost" disabled={savingClosing} onClick={handleClearClosingDate}>
                          Clear Closing Date
                        </Button>
                      )}
                    </div>
                  </form>
                </Card>
              </>
            )}

            {/* ── Sales & Customers ───────────────────────────────────────── */}
            {tab === 'sales' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Sales &amp; Customers</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Defaults pre-filled on new sales documents. <AdvisoryBadge />
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveSettings(['defaultCustomerTerms', 'defaultInvoiceMemo']);
                  }}
                  className="flex flex-col gap-5"
                >
                  <div className="grid grid-cols-2 gap-5">
                    <div>
                      <Label htmlFor="cust-terms">Default Payment Terms</Label>
                      <Select id="cust-terms" value={s.defaultCustomerTerms ?? 'net_30'} onChange={(e) => patch({ defaultCustomerTerms: e.target.value })}>
                        {TERMS.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>Next Invoice Number</Label>
                      <Input value={nextInvoiceNumber !== null ? `#${nextInvoiceNumber}` : 'N/A'} disabled readOnly />
                      <p className="mt-1 text-xs text-navy/50">Assigned automatically and sequentially — display only.</p>
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor="invoice-memo">Default Invoice Memo</Label>
                      <Input
                        id="invoice-memo"
                        value={s.defaultInvoiceMemo ?? ''}
                        onChange={(e) => patch({ defaultInvoiceMemo: e.target.value })}
                        placeholder="Thank you for your business!"
                      />
                    </div>
                  </div>
                  <div className="pt-2">
                    <Button type="submit" loading={saving}>Save Sales Preferences</Button>
                  </div>
                </form>
              </Card>
            )}

            {/* ── Purchases & Vendors ─────────────────────────────────────── */}
            {tab === 'purchases' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Purchases &amp; Vendors</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Defaults pre-filled on new bills and expenses. <AdvisoryBadge />
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveSettings(['defaultVendorTerms', 'defaultExpenseAccountId']);
                  }}
                  className="flex flex-col gap-5"
                >
                  <div className="grid grid-cols-2 gap-5">
                    <div>
                      <Label htmlFor="vendor-terms">Default Vendor Terms</Label>
                      <Select id="vendor-terms" value={s.defaultVendorTerms ?? 'net_30'} onChange={(e) => patch({ defaultVendorTerms: e.target.value })}>
                        {TERMS.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="default-expense">Default Expense Account</Label>
                      <AccountSelect
                        id="default-expense"
                        value={s.defaultExpenseAccountId ?? ''}
                        onChange={(v) => patch({ defaultExpenseAccountId: v || null })}
                        accounts={accounts}
                        types={['expense']}
                        placeholder="No default"
                      />
                    </div>
                  </div>
                  <div className="pt-2">
                    <Button type="submit" loading={saving}>Save Purchase Preferences</Button>
                  </div>
                </form>
              </Card>
            )}

            {/* ── Payroll ─────────────────────────────────────────────────── */}
            {tab === 'payroll' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Payroll</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Defaults used when setting up new employees and pay runs. <AdvisoryBadge label="Applies to new pay runs" />
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const hrs = Number(s.payrollStandardHours);
                    if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 168) {
                      toast('Standard hours must be between 1 and 168', 'danger');
                      return;
                    }
                    void saveSettings(['payrollPayPeriod', 'payrollStandardHours', 'payrollExpenseAccountId', 'payrollLiabilityAccountId']);
                  }}
                  className="flex flex-col gap-5"
                >
                  <div className="grid grid-cols-2 gap-5">
                    <div>
                      <Label htmlFor="pay-period">Default Pay Period</Label>
                      <Select id="pay-period" value={s.payrollPayPeriod ?? 'biweekly'} onChange={(e) => patch({ payrollPayPeriod: e.target.value })}>
                        {PAY_PERIODS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="std-hours">Standard Hours / Week</Label>
                      <Input
                        id="std-hours"
                        type="number"
                        min={1}
                        max={168}
                        value={s.payrollStandardHours ?? 40}
                        onChange={(e) => patch({ payrollStandardHours: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="payroll-expense">Default Payroll Expense Account</Label>
                      <AccountSelect
                        id="payroll-expense"
                        value={s.payrollExpenseAccountId ?? ''}
                        onChange={(v) => patch({ payrollExpenseAccountId: v || null })}
                        accounts={accounts}
                        types={['expense']}
                        placeholder="No default"
                      />
                    </div>
                    <div>
                      <Label htmlFor="payroll-liability">Default Payroll Liability Account</Label>
                      <AccountSelect
                        id="payroll-liability"
                        value={s.payrollLiabilityAccountId ?? ''}
                        onChange={(v) => patch({ payrollLiabilityAccountId: v || null })}
                        accounts={accounts}
                        types={['liability']}
                        placeholder="No default"
                      />
                    </div>
                  </div>
                  <div className="pt-2">
                    <Button type="submit" loading={saving}>Save Payroll Preferences</Button>
                  </div>
                </form>
              </Card>
            )}

            {/* ── Inventory ───────────────────────────────────────────────── */}
            {tab === 'inventory' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-6">Inventory</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveSettings(['negativeStockWarning']);
                  }}
                  className="flex flex-col gap-5"
                >
                  <Toggle
                    id="negative-stock"
                    checked={s.negativeStockWarning ?? true}
                    onChange={(v) => patch({ negativeStockWarning: v })}
                    label="Warn when selling below zero stock"
                    advisory="Warning preference"
                    help="Show a warning when an invoice or sales receipt would drive an inventory item's quantity on hand negative."
                  />
                  <div className="pt-2">
                    <Button type="submit" loading={saving}>Save Inventory Preferences</Button>
                  </div>
                </form>
              </Card>
            )}

            {/* ── Custom Fields ───────────────────────────────────────────── */}
            {tab === 'customFields' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Custom Fields</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Define up to 7 custom fields per list (QuickBooks Desktop parity). Values are entered on
                  each record&apos;s form. <AdvisoryBadge label="Applies to new and edited records" />
                </p>
                <div className="grid grid-cols-2 gap-6">
                  {CUSTOM_FIELD_ENTITIES.map(({ key, label }) => (
                    <div key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-semibold text-sm text-navy">{label}</span>
                        <Badge>{customFields[key].length}/7</Badge>
                      </div>
                      <div className="flex flex-col gap-2">
                        {customFields[key].length === 0 && (
                          <p className="text-xs text-navy/40">No custom fields defined.</p>
                        )}
                        {customFields[key].map((f, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Input
                              value={f.name}
                              placeholder="Field name"
                              onChange={(e) =>
                                setCustomFields((prev) => ({
                                  ...prev,
                                  [key]: prev[key].map((row, j) => (j === i ? { name: e.target.value } : row)),
                                }))
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() =>
                                setCustomFields((prev) => ({
                                  ...prev,
                                  [key]: prev[key].filter((_, j) => j !== i),
                                }))
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={customFields[key].length >= 7}
                          onClick={() =>
                            setCustomFields((prev) => ({ ...prev, [key]: [...prev[key], { name: '' }] }))
                          }
                        >
                          Add field
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="pt-6">
                  <Button type="button" loading={saving} onClick={handleSaveCustomFields}>
                    Save Custom Fields
                  </Button>
                </div>
              </Card>
            )}

            {/* ── Users & Roles ───────────────────────────────────────────── */}
            {tab === 'users' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1 flex items-center gap-2">
                  <Users className="h-5 w-5 text-electric" />
                  Users &amp; Roles
                </h2>
                <p className="text-sm text-navy/50 mb-6">
                  Viewers are read-only across the whole app. Accountants can post transactions; admins can
                  also manage users and settings.
                </p>
                {members.length === 0 ? (
                  <p className="text-sm text-navy/50">No members found.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {members.map((m) => (
                      <div
                        key={m.userId}
                        className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-3"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-sm text-navy truncate">{m.name}</div>
                          <div className="text-xs text-navy/50 truncate">{m.email}</div>
                        </div>
                        {m.isOwner ? (
                          <Badge>Owner</Badge>
                        ) : (
                          <Select
                            value={m.role}
                            disabled={savingRole === m.userId}
                            onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                            className="w-48"
                          >
                            {ROLES.map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </Select>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* ── Backup / Data ───────────────────────────────────────────── */}
            {tab === 'backup' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1 flex items-center gap-2">
                  <Database className="h-5 w-5 text-electric" />
                  Backup &amp; Data
                </h2>
                <p className="text-sm text-navy/50 mb-6">Import, export, and manage your company data.</p>
                <div className="flex flex-col gap-3">
                  <Link
                    href="/qb-import"
                    className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-navy font-medium hover:border-electric hover:bg-electric/5 transition-colors"
                  >
                    <Upload className="h-5 w-5 text-electric shrink-0" />
                    <div>
                      <div className="font-semibold text-sm">QuickBooks Import</div>
                      <div className="text-xs text-navy/50 mt-0.5">Import QBO, IIF, or CSV files from QuickBooks</div>
                    </div>
                  </Link>
                  <Link
                    href="/backup"
                    className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-navy font-medium hover:border-electric hover:bg-electric/5 transition-colors"
                  >
                    <Download className="h-5 w-5 text-electric shrink-0" />
                    <div>
                      <div className="font-semibold text-sm">Backup &amp; Export</div>
                      <div className="text-xs text-navy/50 mt-0.5">Download a backup of your company data</div>
                    </div>
                  </Link>
                  <Link
                    href="/accounts"
                    className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-navy font-medium hover:border-electric hover:bg-electric/5 transition-colors"
                  >
                    <BookOpen className="h-5 w-5 text-electric shrink-0" />
                    <div>
                      <div className="font-semibold text-sm">Chart of Accounts</div>
                      <div className="text-xs text-navy/50 mt-0.5">View and manage your general ledger accounts</div>
                    </div>
                  </Link>
                </div>
              </Card>
            )}

            {/* ── Categorized QB preferences (Company + My Preferences) ───────── */}
            {PANE_FOR_TAB[tab] && (
              <PreferencePane categoryId={PANE_FOR_TAB[tab]!} accounts={accounts} exclude={LEGACY_PANE_KEYS} />
            )}

            {tab === 'templates' && (
              <Card className="p-8">
                <h2 className="text-lg font-bold text-navy mb-1">Form Templates</h2>
                <p className="text-sm text-navy/50 mb-6">
                  Design how invoices, estimates, sales receipts, credit memos, sales orders, purchase orders
                  and statements look when printed or emailed: logo, colors, fonts, which fields and columns
                  show, and your own header and footer text.
                </p>
                <Link
                  href="/templates"
                  className="inline-flex items-center gap-2 rounded-xl bg-electric px-4 py-2 text-sm font-semibold text-white hover:bg-electric/90"
                >
                  <FileText className="h-4 w-4" /> Open the template designer
                </Link>
              </Card>
            )}

            <p className="text-xs text-navy/40 -mt-2">
              Viewing: {activeTab.label}. Preferences are saved per section.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
