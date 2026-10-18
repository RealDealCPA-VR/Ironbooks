'use client';

import { isPaymentSourceAccount } from '@/lib/accountTypes';
import { useEffect, useState } from 'react';
import { Repeat, Plus, Play, Clock, Trash2, Pencil, Layers } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate, todayISO } from '@/lib/dates';
import RecurringSuggestions from '@/components/RecurringSuggestions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocType =
  | 'invoice'
  | 'bill'
  | 'journal_entry'
  | 'expense'
  | 'check'
  | 'sales_receipt'
  | 'credit_memo'
  | 'deposit'
  | 'transfer'
  | 'purchase_order';
/** The document types this page can build from scratch (others are memorized from their forms). */
type BuildableDocType = 'invoice' | 'bill' | 'journal_entry' | 'expense';
type Frequency =
  | 'never'
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'every_four_weeks'
  | 'semimonthly'
  | 'monthly'
  | 'bimonthly'
  | 'quarterly'
  | 'semiannually'
  | 'yearly';
type Mode = 'automatic' | 'remind' | 'never';

interface RecurringTemplate {
  id: string;
  name: string;
  docType: DocType;
  frequency: Frequency;
  nextRunDate: string | null;
  isActive: boolean;
  template: Record<string, unknown> & { __options?: { autoEnter?: boolean } };
  createdAt: string;
  mode?: Mode;
  groupName?: string | null;
  remaining?: number | null;
  daysInAdvance?: number;
  lastRunAt?: string | null;
}

interface GeneratedDoc {
  templateId: string;
  templateName: string;
  docType: DocType;
  docId: string;
}

interface TemplateReminder {
  templateId: string;
  templateName: string;
  docType: DocType;
  dueDate: string;
}

interface CustomerOption {
  id: string;
  displayName: string;
}

interface VendorOption {
  id: string;
  displayName: string;
}

interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_TYPE_OPTIONS: { value: BuildableDocType; label: string }[] = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'bill', label: 'Bill' },
  { value: 'journal_entry', label: 'Journal Entry' },
  { value: 'expense', label: 'Expense / Check' },
];

const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'every_four_weeks', label: 'Every four weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'bimonthly', label: 'Every two months' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannually', label: 'Twice a year' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'never', label: 'No schedule' },
];

const FREQUENCY_LABEL: Record<Frequency, string> = Object.fromEntries(
  FREQUENCY_OPTIONS.map((o) => [o.value, o.label]),
) as Record<Frequency, string>;

const MODE_OPTIONS: { value: Mode; label: string; help: string }[] = [
  {
    value: 'automatic',
    label: 'Automate entry',
    help: 'Entered for you on schedule (by "Run Due Now" or when the app starts).',
  },
  {
    value: 'remind',
    label: 'Add to my Reminders list',
    help: "Never entered automatically: it shows on Reminders until you choose Enter Now.",
  },
  { value: 'never', label: "Don't remind me", help: 'Kept on the list; entered only when you choose Enter Now.' },
];

const DOC_BADGES: Record<DocType, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  invoice: { label: 'Invoice', tone: 'success' },
  bill: { label: 'Bill', tone: 'warning' },
  journal_entry: { label: 'Journal Entry', tone: 'info' },
  expense: { label: 'Expense', tone: 'neutral' },
  check: { label: 'Check', tone: 'neutral' },
  sales_receipt: { label: 'Sales Receipt', tone: 'success' },
  credit_memo: { label: 'Credit Memo', tone: 'warning' },
  deposit: { label: 'Deposit', tone: 'info' },
  transfer: { label: 'Transfer', tone: 'info' },
  purchase_order: { label: 'Purchase Order', tone: 'neutral' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return todayISO();
}

function modeOf(tpl: RecurringTemplate): Mode {
  if (tpl.mode) return tpl.mode;
  return tpl.template?.__options?.autoEnter === false ? 'remind' : 'automatic';
}

interface ScheduleValue {
  frequency: Frequency;
  nextRunDate: string;
  mode: Mode;
  groupName: string;
  remaining: string;
  daysInAdvance: string;
}

/** QB Schedule block: how often, next date, number remaining, days in advance, group. */
function ScheduleFields({
  value,
  onChange,
  groups,
}: {
  value: ScheduleValue;
  onChange: (patch: Partial<ScheduleValue>) => void;
  groups?: string[];
}) {
  const help = MODE_OPTIONS.find((m) => m.value === value.mode)?.help;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="tpl-mode">How should it be entered?</Label>
          <Select id="tpl-mode" value={value.mode} onChange={(e) => onChange({ mode: e.target.value as Mode })}>
            {MODE_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
          {help && <p className="text-[11px] text-navy/40 mt-1">{help}</p>}
        </div>
        <div>
          <Label htmlFor="tpl-group">Group (optional)</Label>
          <Input
            id="tpl-group"
            list="tpl-group-list"
            placeholder="e.g. Month-end"
            value={value.groupName}
            onChange={(e) => onChange({ groupName: e.target.value })}
          />
          <datalist id="tpl-group-list">
            {(groups ?? []).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="tpl-remaining">Number remaining</Label>
          <Input
            id="tpl-remaining"
            inputMode="numeric"
            placeholder="No limit"
            value={value.remaining}
            onChange={(e) => onChange({ remaining: e.target.value.replace(/[^0-9]/g, '') })}
          />
          <p className="text-[11px] text-navy/40 mt-1">Leave blank to keep going until you stop it.</p>
        </div>
        <div>
          <Label htmlFor="tpl-days">Days in advance to enter</Label>
          <Input
            id="tpl-days"
            inputMode="numeric"
            value={value.daysInAdvance}
            onChange={(e) => onChange({ daysInAdvance: e.target.value.replace(/[^0-9]/g, '') })}
          />
        </div>
      </div>
    </>
  );
}

function scheduleBody(v: ScheduleValue) {
  return {
    frequency: v.frequency,
    nextRunDate: v.nextRunDate,
    mode: v.mode,
    groupName: v.groupName.trim() || null,
    remaining: v.remaining === '' ? null : Number(v.remaining),
    daysInAdvance: Number(v.daysInAdvance || '0'),
  };
}

// ---------------------------------------------------------------------------
// Structured line rows per document type
// ---------------------------------------------------------------------------

interface InvoiceLineRow {
  description: string;
  quantity: string;
  rate: string;
}

interface AmountLineRow {
  accountId: string;
  description: string;
  amount: string;
}

interface JournalLineRow {
  accountId: string;
  memo: string;
  debit: string;
  credit: string;
}

const EMPTY_INVOICE_LINE: InvoiceLineRow = { description: '', quantity: '1', rate: '' };
const EMPTY_AMOUNT_LINE: AmountLineRow = { accountId: '', description: '', amount: '' };
const EMPTY_JOURNAL_LINE: JournalLineRow = { accountId: '', memo: '', debit: '', credit: '' };

interface TemplateFormState extends ScheduleValue {
  name: string;
  docType: BuildableDocType;
  // Invoice
  customerId: string;
  invoiceLines: InvoiceLineRow[];
  // Bill
  vendorId: string;
  billLines: AmountLineRow[];
  // Journal entry
  jeDescription: string;
  journalLines: JournalLineRow[];
  // Expense
  expVendorId: string;
  expPayeeName: string;
  expMethod: 'check' | 'cash' | 'credit_card';
  expPaymentAccountId: string;
  expenseLines: AmountLineRow[];
}

const EMPTY_FORM: TemplateFormState = {
  name: '',
  docType: 'invoice',
  frequency: 'monthly',
  nextRunDate: todayIso(),
  mode: 'automatic',
  groupName: '',
  remaining: '',
  daysInAdvance: '0',
  customerId: '',
  invoiceLines: [{ ...EMPTY_INVOICE_LINE }],
  vendorId: '',
  billLines: [{ ...EMPTY_AMOUNT_LINE }],
  jeDescription: '',
  journalLines: [{ ...EMPTY_JOURNAL_LINE }, { ...EMPTY_JOURNAL_LINE }],
  expVendorId: '',
  expPayeeName: '',
  expMethod: 'check',
  expPaymentAccountId: '',
  expenseLines: [{ ...EMPTY_AMOUNT_LINE }],
};

function buildTemplatePayload(form: TemplateFormState): Record<string, unknown> {
  if (form.docType === 'invoice') {
    return {
      customerId: form.customerId,
      date: form.nextRunDate,
      lines: form.invoiceLines.map((l) => ({
        description: l.description.trim() || 'Services',
        quantity: l.quantity || '1',
        rate: l.rate || '0.00',
      })),
    };
  }
  if (form.docType === 'bill') {
    return {
      vendorId: form.vendorId,
      date: form.nextRunDate,
      lines: form.billLines.map((l) => ({
        accountId: l.accountId,
        description: l.description.trim() || null,
        amount: l.amount || '0.00',
      })),
    };
  }
  if (form.docType === 'expense') {
    return {
      vendorId: form.expVendorId || null,
      payeeName: form.expPayeeName.trim() || null,
      method: form.expMethod,
      paymentAccountId: form.expPaymentAccountId,
      date: form.nextRunDate,
      lines: form.expenseLines.map((l) => ({
        accountId: l.accountId,
        description: l.description.trim() || null,
        amount: l.amount || '0.00',
      })),
    };
  }
  // journal_entry
  return {
    description: form.jeDescription.trim() || 'Recurring journal entry',
    date: form.nextRunDate,
    lines: form.journalLines.map((l) => ({
      accountId: l.accountId,
      memo: l.memo.trim() || null,
      ...(Number(l.debit) > 0 ? { debit: l.debit } : {}),
      ...(Number(l.credit) > 0 ? { credit: l.credit } : {}),
    })),
  };
}

/** Returns an error message or null when the form is valid. */
function validateForm(form: TemplateFormState): string | null {
  if (!form.name.trim()) return 'Template name is required';
  if (!form.nextRunDate) return 'Next run date is required';
  if (form.remaining && !/^\d{1,4}$/.test(form.remaining)) return 'Number remaining must be a whole number';
  if (!/^\d{1,3}$/.test(form.daysInAdvance || '0')) return 'Days in advance must be a whole number';

  if (form.docType === 'invoice') {
    if (!form.customerId) return 'Select a customer for invoice templates';
    for (const [i, l] of form.invoiceLines.entries()) {
      if (!l.rate || Number(l.rate) <= 0) return `Invoice line ${i + 1}: rate must be greater than zero`;
      if (!l.quantity || Number(l.quantity) <= 0) return `Invoice line ${i + 1}: quantity must be greater than zero`;
    }
    return null;
  }

  if (form.docType === 'bill' || form.docType === 'expense') {
    const lines = form.docType === 'bill' ? form.billLines : form.expenseLines;
    if (form.docType === 'bill' && !form.vendorId) return 'Select a vendor for bill templates';
    if (form.docType === 'expense') {
      if (!form.expVendorId && !form.expPayeeName.trim()) return 'Select a vendor or enter a payee name';
      if (!form.expPaymentAccountId) return 'Select a payment (bank / card) account';
    }
    for (const [i, l] of lines.entries()) {
      if (!l.accountId) return `Line ${i + 1}: select an account`;
      if (!l.amount || Number(l.amount) <= 0) return `Line ${i + 1}: amount must be greater than zero`;
    }
    return null;
  }

  // journal_entry
  if (!form.jeDescription.trim()) return 'Description is required for journal entry templates';
  let debits = 0;
  let credits = 0;
  for (const [i, l] of form.journalLines.entries()) {
    if (!l.accountId) return `Journal line ${i + 1}: select an account`;
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (d <= 0 && c <= 0) return `Journal line ${i + 1}: enter a debit or a credit`;
    if (d > 0 && c > 0) return `Journal line ${i + 1}: a line cannot have both a debit and a credit`;
    debits += d;
    credits += c;
  }
  if (Math.abs(debits - credits) > 0.005) {
    return `Journal entry is out of balance (debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line-grid sub-components
// ---------------------------------------------------------------------------

function LineGridHeader({ onAdd, label }: { onAdd: () => void; label: string }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <Label className="mb-0">{label} *</Label>
      <button
        type="button"
        onClick={onAdd}
        className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
      >
        <Plus className="h-3 w-3" /> Add Line
      </button>
    </div>
  );
}

function RemoveLineButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-1 text-red-400 hover:text-red-600 disabled:opacity-20 disabled:pointer-events-none"
      title="Remove line"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// TemplateFormFields component
// ---------------------------------------------------------------------------

function TemplateFormFields({
  form,
  setForm,
  customers,
  vendors,
  accounts,
}: {
  form: TemplateFormState;
  setForm: React.Dispatch<React.SetStateAction<TemplateFormState>>;
  customers: CustomerOption[];
  vendors: VendorOption[];
  accounts: AccountOption[];
}) {
  function onChange<K extends keyof TemplateFormState>(field: K, value: TemplateFormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  type LineField = 'invoiceLines' | 'billLines' | 'expenseLines' | 'journalLines';
  type AnyLine = InvoiceLineRow | AmountLineRow | JournalLineRow;

  function updateRow(field: LineField, index: number, patch: Partial<AnyLine>) {
    setForm((prev) => {
      const rows = (prev[field] as AnyLine[]).map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      );
      return { ...prev, [field]: rows } as TemplateFormState;
    });
  }

  function addRow(field: LineField) {
    const blank: AnyLine =
      field === 'invoiceLines'
        ? { ...EMPTY_INVOICE_LINE }
        : field === 'journalLines'
          ? { ...EMPTY_JOURNAL_LINE }
          : { ...EMPTY_AMOUNT_LINE };
    setForm((prev) => {
      const rows = [...(prev[field] as AnyLine[]), blank];
      return { ...prev, [field]: rows } as TemplateFormState;
    });
  }

  function removeRow(field: LineField, index: number) {
    setForm((prev) => {
      const rows = (prev[field] as AnyLine[]).filter((_, i) => i !== index);
      return { ...prev, [field]: rows } as TemplateFormState;
    });
  }

  // Payment sources for expenses: bank-ish assets + credit cards.
  const paymentAccounts = accounts.filter((a) => isPaymentSourceAccount(a));

  /** Account+description+amount grid shared by bill and expense templates. */
  const renderAmountLines = (field: 'billLines' | 'expenseLines', rows: AmountLineRow[]) => (
    <div>
      <LineGridHeader onAdd={() => addRow(field)} label="Lines" />
      <div className="space-y-2">
        {rows.map((line, idx) => (
          <div key={idx} className="flex gap-2 items-start">
            <div className="flex-1 min-w-0">
              <Select
                value={line.accountId}
                onChange={(e) => updateRow(field, idx, { accountId: e.target.value })}
              >
                <option value="">Account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} – {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-0">
              <Input
                placeholder="Description"
                value={line.description}
                onChange={(e) => updateRow(field, idx, { description: e.target.value })}
              />
            </div>
            <div className="w-24 shrink-0">
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={line.amount}
                onChange={(e) => updateRow(field, idx, { amount: e.target.value })}
              />
            </div>
            <RemoveLineButton onClick={() => removeRow(field, idx)} disabled={rows.length === 1} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="tpl-name">Template Name *</Label>
        <Input
          id="tpl-name"
          placeholder="e.g. Monthly Retainer"
          autoFocus
          value={form.name}
          onChange={(e) => onChange('name', e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="tpl-docType">Document Type *</Label>
          <Select
            id="tpl-docType"
            value={form.docType}
            onChange={(e) => onChange('docType', e.target.value as BuildableDocType)}
          >
            {DOC_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="tpl-frequency">Frequency *</Label>
          <Select
            id="tpl-frequency"
            value={form.frequency}
            onChange={(e) => onChange('frequency', e.target.value as Frequency)}
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="tpl-nextRunDate">Next Run Date *</Label>
          <Input
            id="tpl-nextRunDate"
            type="date"
            value={form.nextRunDate}
            onChange={(e) => onChange('nextRunDate', e.target.value)}
            required
          />
        </div>
      </div>

      <ScheduleFields value={form} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} />

      {/* ---- Invoice template ---- */}
      {form.docType === 'invoice' && (
        <>
          <div>
            <Label htmlFor="tpl-customerId">Customer *</Label>
            <Select
              id="tpl-customerId"
              value={form.customerId}
              onChange={(e) => onChange('customerId', e.target.value)}
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
            {customers.length === 0 && (
              <p className="text-xs text-navy/40 mt-1">
                No customers found — create one on the Customers page first.
              </p>
            )}
          </div>
          <div>
            <LineGridHeader onAdd={() => addRow('invoiceLines')} label="Lines" />
            <div className="space-y-2">
              {form.invoiceLines.map((line, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <Input
                      placeholder="Description (e.g. Services rendered)"
                      value={line.description}
                      onChange={(e) => updateRow('invoiceLines', idx, { description: e.target.value })}
                    />
                  </div>
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min="0.01"
                      step="any"
                      placeholder="Qty"
                      value={line.quantity}
                      onChange={(e) => updateRow('invoiceLines', idx, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Rate"
                      value={line.rate}
                      onChange={(e) => updateRow('invoiceLines', idx, { rate: e.target.value })}
                    />
                  </div>
                  <RemoveLineButton
                    onClick={() => removeRow('invoiceLines', idx)}
                    disabled={form.invoiceLines.length === 1}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ---- Bill template ---- */}
      {form.docType === 'bill' && (
        <>
          <div>
            <Label htmlFor="tpl-vendorId">Vendor *</Label>
            <Select
              id="tpl-vendorId"
              value={form.vendorId}
              onChange={(e) => onChange('vendorId', e.target.value)}
            >
              <option value="">— Select vendor —</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
            {vendors.length === 0 && (
              <p className="text-xs text-navy/40 mt-1">
                No vendors found — create one on the Vendors page first.
              </p>
            )}
          </div>
          {renderAmountLines('billLines', form.billLines)}
        </>
      )}

      {/* ---- Expense template ---- */}
      {form.docType === 'expense' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tpl-expVendor">Vendor</Label>
              <Select
                id="tpl-expVendor"
                value={form.expVendorId}
                onChange={(e) => onChange('expVendorId', e.target.value)}
              >
                <option value="">— Free-text payee —</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="tpl-expPayee">Payee Name {form.expVendorId ? '' : '*'}</Label>
              <Input
                id="tpl-expPayee"
                placeholder="e.g. City Utilities"
                value={form.expPayeeName}
                onChange={(e) => onChange('expPayeeName', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tpl-expMethod">Method *</Label>
              <Select
                id="tpl-expMethod"
                value={form.expMethod}
                onChange={(e) =>
                  onChange('expMethod', e.target.value as TemplateFormState['expMethod'])
                }
              >
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="credit_card">Credit Card</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="tpl-expPayAcct">Payment Account *</Label>
              <Select
                id="tpl-expPayAcct"
                value={form.expPaymentAccountId}
                onChange={(e) => onChange('expPaymentAccountId', e.target.value)}
              >
                <option value="">— Select account —</option>
                {paymentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} – {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {renderAmountLines('expenseLines', form.expenseLines)}
        </>
      )}

      {/* ---- Journal entry template ---- */}
      {form.docType === 'journal_entry' && (
        <>
          <div>
            <Label htmlFor="tpl-jeDesc">Description *</Label>
            <Input
              id="tpl-jeDesc"
              placeholder="e.g. Monthly depreciation accrual"
              value={form.jeDescription}
              onChange={(e) => onChange('jeDescription', e.target.value)}
            />
          </div>
          <div>
            <LineGridHeader onAdd={() => addRow('journalLines')} label="Lines (must balance)" />
            <div className="space-y-2">
              {form.journalLines.map((line, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <Select
                      value={line.accountId}
                      onChange={(e) => updateRow('journalLines', idx, { accountId: e.target.value })}
                    >
                      <option value="">Account…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} – {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex-1 min-w-0">
                    <Input
                      placeholder="Memo"
                      value={line.memo}
                      onChange={(e) => updateRow('journalLines', idx, { memo: e.target.value })}
                    />
                  </div>
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Debit"
                      value={line.debit}
                      onChange={(e) => updateRow('journalLines', idx, { debit: e.target.value })}
                    />
                  </div>
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Credit"
                      value={line.credit}
                      onChange={(e) => updateRow('journalLines', idx, { credit: e.target.value })}
                    />
                  </div>
                  <RemoveLineButton
                    onClick={() => removeRow('journalLines', idx)}
                    disabled={form.journalLines.length <= 2}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-end text-xs text-navy/50 tabular-nums gap-4">
              <span>
                Debits:{' '}
                {form.journalLines.reduce((s, l) => s + (Number(l.debit) || 0), 0).toFixed(2)}
              </span>
              <span>
                Credits:{' '}
                {form.journalLines.reduce((s, l) => s + (Number(l.credit) || 0), 0).toFixed(2)}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RecurringPage() {
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Picker data for the structured template forms
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  // New template modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<TemplateFormState>(EMPTY_FORM);
  const [addSaving, setAddSaving] = useState(false);

  // Run-now confirmation
  const [runNowTarget, setRunNowTarget] = useState<RecurringTemplate | null>(null);
  const [runNowLoading, setRunNowLoading] = useState(false);

  // Edit schedule / delete / enter group
  const [editTarget, setEditTarget] = useState<RecurringTemplate | null>(null);
  const [editForm, setEditForm] = useState<ScheduleValue & { name: string; isActive: boolean }>({
    name: '',
    isActive: true,
    frequency: 'monthly',
    nextRunDate: todayIso(),
    mode: 'automatic',
    groupName: '',
    remaining: '',
    daysInAdvance: '0',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecurringTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [groupRunning, setGroupRunning] = useState<string | null>(null);
  const groups = Array.from(
    new Set(templates.map((t) => t.groupName).filter((g): g is string => !!g)),
  ).sort();

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchTemplates() {
    setLoading(true);
    try {
      const data = await api.get<RecurringTemplate[]>('/api/recurring');
      setTemplates(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load templates', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTemplates();
    // Picker data — each is non-fatal if it fails (selects degrade to empty).
    api.get<CustomerOption[]>('/api/customers').then(setCustomers).catch(() => {});
    api.get<VendorOption[]>('/api/vendors').then(setVendors).catch(() => {});
    api.get<AccountOption[]>('/api/accounts').then(setAccounts).catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Run due now (all)
  // ---------------------------------------------------------------------------

  async function handleRunDue() {
    setRunning(true);
    try {
      const result = await api.post<{
        generated: GeneratedDoc[];
        reminders?: TemplateReminder[];
        failed?: { templateName: string; error: string }[];
      }>('/api/recurring/run', { asOf: new Date().toISOString() });
      const count = result.generated.length;
      const reminders = result.reminders?.length ?? 0;
      for (const f of result.failed ?? []) {
        toast(`"${f.templateName}" could not be entered: ${f.error}`, 'danger');
      }
      const parts: string[] = [
        count === 0
          ? 'No auto-post templates were due.'
          : `Generated ${count} document${count === 1 ? '' : 's'}.`,
      ];
      if (reminders > 0) {
        parts.push(
          `${reminders} remind-only template${reminders === 1 ? ' is' : 's are'} due — use Run Now to post.`,
        );
      }
      toast(parts.join(' '), count === 0 && reminders === 0 ? 'info' : 'success');
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Run failed', 'danger');
    } finally {
      setRunning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Run individual template now
  // ---------------------------------------------------------------------------

  async function handleRunNow() {
    if (!runNowTarget) return;
    setRunNowLoading(true);
    try {
      await api.post('/api/recurring/run', { id: runNowTarget.id });
      toast(`Generated 1 ${runNowTarget.docType.replace('_', ' ')} from "${runNowTarget.name}"`, 'success');
      setRunNowTarget(null);
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Run failed', 'danger');
    } finally {
      setRunNowLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Add template
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setAddForm({
      ...EMPTY_FORM,
      nextRunDate: todayIso(),
      invoiceLines: [{ ...EMPTY_INVOICE_LINE }],
      billLines: [{ ...EMPTY_AMOUNT_LINE }],
      journalLines: [{ ...EMPTY_JOURNAL_LINE }, { ...EMPTY_JOURNAL_LINE }],
      expenseLines: [{ ...EMPTY_AMOUNT_LINE }],
    });
    setAddOpen(true);
  }

  async function handleAdd() {
    const error = validateForm(addForm);
    if (error) {
      toast(error, 'danger');
      return;
    }

    setAddSaving(true);
    try {
      await api.post('/api/recurring', {
        name: addForm.name.trim(),
        docType: addForm.docType,
        ...scheduleBody(addForm),
        template: buildTemplatePayload(addForm),
      });
      toast('Recurring template created', 'success');
      setAddOpen(false);
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create template', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit schedule / delete / enter a group
  // ---------------------------------------------------------------------------

  function openEdit(tpl: RecurringTemplate) {
    setEditForm({
      name: tpl.name,
      isActive: tpl.isActive,
      frequency: tpl.frequency,
      nextRunDate: tpl.nextRunDate ? tpl.nextRunDate.slice(0, 10) : todayIso(),
      mode: modeOf(tpl),
      groupName: tpl.groupName ?? '',
      remaining: tpl.remaining === null || tpl.remaining === undefined ? '' : String(tpl.remaining),
      daysInAdvance: String(tpl.daysInAdvance ?? 0),
    });
    setEditTarget(tpl);
  }

  async function handleEditSave() {
    if (!editTarget) return;
    if (!editForm.name.trim()) {
      toast('Name is required', 'danger');
      return;
    }
    setEditSaving(true);
    try {
      await api.patch(`/api/recurring/${editTarget.id}`, {
        name: editForm.name.trim(),
        isActive: editForm.isActive,
        ...scheduleBody(editForm),
      });
      toast('Memorized transaction saved', 'success');
      setEditTarget(null);
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save', 'danger');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/recurring/${deleteTarget.id}`);
      toast(`Deleted "${deleteTarget.name}"`, 'success');
      setDeleteTarget(null);
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete', 'danger');
    } finally {
      setDeleting(false);
    }
  }

  async function handleRunGroup(group: string) {
    setGroupRunning(group);
    try {
      const result = await api.post<{ generated: GeneratedDoc[]; failed?: { templateName: string; error: string }[] }>(
        '/api/recurring/run',
        { group },
      );
      toast(`Entered ${result.generated.length} transaction(s) from group "${group}"`, 'success');
      for (const f of result.failed ?? []) toast(`"${f.templateName}" could not be entered: ${f.error}`, 'danger');
      await fetchTemplates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to enter the group', 'danger');
    } finally {
      setGroupRunning(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Recurring transactions (memorized)"
        icon={Repeat}
        action={
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={handleRunDue}
              loading={running}
              title="Run all templates that are due today"
            >
              <Play className="h-4 w-4" />
              Run Due Now
            </Button>
            <Button onClick={openAddModal}>
              <Plus className="h-4 w-4" />
              New Template
            </Button>
          </div>
        }
      />

      <RecurringSuggestions onMemorized={fetchTemplates} />

      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Transactions you enter again and again. Memorize one from any form with <strong>Memorize</strong> (or
        Ctrl+M), or build one here. Each entry posts through the normal form, so the books always stay in
        balance.
      </p>

      {groups.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-navy/60">Groups:</span>
          {groups.map((g) => (
            <Button
              key={g}
              size="sm"
              variant="secondary"
              loading={groupRunning === g}
              onClick={() => handleRunGroup(g)}
              title={`Enter every transaction in "${g}" now`}
            >
              <Layers className="h-3.5 w-3.5" /> Enter {g}
            </Button>
          ))}
        </div>
      )}

      <Card>
        {loading ? (
          <div className="p-12 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : templates.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No recurring templates yet"
            message="Set up a template to generate invoices, bills, expenses, or journal entries automatically."
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> New Template
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Group</Th>
                <Th>How Often</Th>
                <Th>Next Date</Th>
                <Th>How Entered</Th>
                <Th>Remaining</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => {
                const badge = DOC_BADGES[tpl.docType] ?? { label: tpl.docType, tone: 'neutral' as const };
                const isPastDue =
                  tpl.nextRunDate !== null && new Date(tpl.nextRunDate) <= new Date();
                const mode = modeOf(tpl);
                const auto = mode === 'automatic';
                return (
                  <Tr key={tpl.id}>
                    <Td className="font-semibold text-navy">{tpl.name}</Td>
                    <Td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </Td>
                    <Td className="text-navy/70">{tpl.groupName ?? ''}</Td>
                    <Td className="text-navy/70">{FREQUENCY_LABEL[tpl.frequency] ?? tpl.frequency}</Td>
                    <Td>
                      <span
                        className={
                          isPastDue && tpl.isActive
                            ? 'text-gold font-semibold'
                            : 'text-navy/70'
                        }
                      >
                        {formatDate(tpl.nextRunDate)}
                        {isPastDue && tpl.isActive && (
                          <span className="ml-1 text-xs">{auto ? '(due)' : '(reminder)'}</span>
                        )}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={auto ? 'info' : mode === 'remind' ? 'warning' : 'neutral'}>
                        {auto ? 'Automatic' : mode === 'remind' ? 'Reminder' : 'Manual'}
                      </Badge>
                      {(tpl.daysInAdvance ?? 0) > 0 && (
                        <span className="ml-1 text-xs text-navy/40">{tpl.daysInAdvance}d early</span>
                      )}
                    </Td>
                    <Td className="text-navy/70 tabular-nums">
                      {tpl.remaining === null || tpl.remaining === undefined ? 'No limit' : tpl.remaining}
                    </Td>
                    <Td>
                      {tpl.isActive ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Inactive</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRunNowTarget(tpl)}
                        title="Generate this document now"
                      >
                        <Clock className="h-3.5 w-3.5" />
                        Enter Now
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(tpl)} title="Edit the schedule">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(tpl)}
                        title="Delete this memorized transaction"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- New Template modal ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="New Recurring Template"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Template
            </Button>
          </>
        }
      >
        <TemplateFormFields
          form={addForm}
          setForm={setAddForm}
          customers={customers}
          vendors={vendors}
          accounts={accounts}
        />
      </Modal>

      {/* ---- Edit schedule modal ---- */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={`Schedule: ${editTarget?.name ?? ''}`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditTarget(null)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={handleEditSave} loading={editSaving}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <input
                id="edit-active"
                type="checkbox"
                checked={editForm.isActive}
                onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.checked }))}
                className="h-4 w-4"
              />
              <Label htmlFor="edit-active" className="mb-0">
                Active
              </Label>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-frequency">How often</Label>
              <Select
                id="edit-frequency"
                value={editForm.frequency}
                onChange={(e) => setEditForm((f) => ({ ...f, frequency: e.target.value as Frequency }))}
              >
                {FREQUENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-next">Next date</Label>
              <Input
                id="edit-next"
                type="date"
                value={editForm.nextRunDate}
                onChange={(e) => setEditForm((f) => ({ ...f, nextRunDate: e.target.value }))}
              />
            </div>
          </div>
          <ScheduleFields
            value={editForm}
            groups={groups}
            onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Memorized Transaction"
        message={
          <>
            Delete <strong className="text-navy">&quot;{deleteTarget?.name}&quot;</strong>? Transactions it
            already entered stay in your books.
          </>
        }
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />

      {/* ---- Run Now confirm dialog ---- */}
      <ConfirmDialog
        open={!!runNowTarget}
        title="Enter Transaction Now"
        message={
          <>
            Generate one{' '}
            <strong className="text-navy">
              {runNowTarget?.docType.replace('_', ' ')}
            </strong>{' '}
            from template{' '}
            <strong className="text-navy">&quot;{runNowTarget?.name}&quot;</strong> immediately?
            The next date moves ahead one period
            {runNowTarget ? ` (${FREQUENCY_LABEL[runNowTarget.frequency] ?? runNowTarget.frequency})` : ''}.
          </>
        }
        confirmLabel="Yes, Generate Now"
        loading={runNowLoading}
        onConfirm={handleRunNow}
        onClose={() => setRunNowTarget(null)}
      />
    </main>
  );
}
