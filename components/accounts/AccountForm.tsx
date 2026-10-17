'use client';
/**
 * Account form pieces shared by the Chart of Accounts (Add / Edit Account) and the registers
 * (the Account column's "+ New account…" opens AddAccountModal and puts the new account on the
 * row): the QB account-type picker, parent and tax-line pickers, and the Add Account modal.
 */
import { useEffect, useState } from 'react';
import { usePreferences } from '@/lib/usePreferences';
import { Button, Input, Select, Label, Modal, toast } from '@/components/ui';
import { Help } from '@/components/Help';
import { api, ApiError } from '@/lib/client';
import {
  QB_ACCOUNT_TYPES,
  SUBTYPE_LABELS,
  type QbAccountType,
  getQbAccountTypeInfo,
  qbAccountTypeOf,
} from '@/lib/accountTypes';
import { INCOME_TAX_FORMS, type IncomeTaxForm, getTaxLine, taxLinesForForm } from '@/lib/taxLines';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** An account as GET /api/accounts returns it (the fields these forms use). */
export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  /** QuickBooks account type derived by the server (lib/accountTypes.ts). */
  qbType?: QbAccountType;
  balance: string;
  isActive: boolean;
  description?: string | null;
  parentId?: string | null;
  taxLine?: string | null;
  /** Bank / credit card account currency (null = home). */
  currency?: string | null;
}

export function qbTypeOfAccount(a: Pick<Account, 'type' | 'subtype' | 'qbType'>): QbAccountType {
  return a.qbType ?? qbAccountTypeOf(a);
}

// ---- Tax form (company setting used by the tax-line picker) ----------------

interface TaxMappingResponse {
  form: IncomeTaxForm | null;
}

export function useIncomeTaxForm(open: boolean): [IncomeTaxForm | null, (f: IncomeTaxForm | null) => void] {
  const [form, setForm] = useState<IncomeTaxForm | null>(null);
  useEffect(() => {
    if (!open) return;
    api
      .get<TaxMappingResponse>('/api/accounts/tax-lines')
      .then((r) => setForm(r.form))
      .catch(() => setForm(null));
  }, [open]);
  return [form, setForm];
}

// ---- Shared pickers (Add + Edit modals) -------------------------------------

export function ParentSelect({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: Account[];
}) {
  return (
    <div>
      <Label htmlFor={id}>Subaccount of (optional)</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— None (top-level account) —</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
      </Select>
      <p className="text-xs text-navy/40 mt-1">
        Sub-accounts must have the same account type as their parent.
      </p>
    </div>
  );
}

/** QuickBooks account-type picker with a plain-language explanation of the chosen type. */
export function AccountTypePicker({
  id,
  qbType,
  subtype,
  onChange,
  disabled,
}: {
  id: string;
  qbType: QbAccountType;
  subtype: string;
  onChange: (qbType: QbAccountType, subtype: string) => void;
  disabled?: boolean;
}) {
  const info = getQbAccountTypeInfo(qbType)!;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor={id} required>
          Account type <Help term="account-type" />
        </Label>
        <Select
          id={id}
          value={qbType}
          disabled={disabled}
          onChange={(e) => {
            const next = getQbAccountTypeInfo(e.target.value)!;
            onChange(next.value, next.defaultSubtype);
          }}
        >
          {QB_ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-navy/60 mt-1">
          {info.help} <span className="text-navy/40">Examples: {info.examples}.</span>
        </p>
      </div>
      {info.subtypes.length > 1 && (
        <div>
          <Label htmlFor={`${id}-detail`}>Detail type</Label>
          <Select
            id={`${id}-detail`}
            value={subtype}
            onChange={(e) => onChange(qbType, e.target.value)}
          >
            {info.subtypes.map((s) => (
              <option key={s} value={s}>
                {SUBTYPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}

export function TaxLineSelect({
  id,
  value,
  onChange,
  form,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  form: IncomeTaxForm | null;
}) {
  const current = getTaxLine(value);
  const lines = form ? taxLinesForForm(form) : [];
  const formLabel = INCOME_TAX_FORMS.find((f) => f.value === form)?.label;
  return (
    <div>
      <Label htmlFor={id}>
        Tax line (optional) <Help term="tax-line" />
      </Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!form && !current}>
        <option value="">— Unassigned —</option>
        {current && current.form !== form && (
          <option value={current.key}>
            {current.form}: {current.label}
          </option>
        )}
        {lines.map((l) => (
          <option key={l.key} value={l.key}>
            {l.label} (line {l.line})
          </option>
        ))}
      </Select>
      <p className="text-xs text-navy/40 mt-1">
        {form
          ? `Lines from ${formLabel}.`
          : 'Choose your business tax form on the Chart of Accounts page (Tax form) to map tax lines.'}
      </p>
    </div>
  );
}

// ---- Add Account Modal ----------------------------------------------------

export interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new account (as POST /api/accounts returns it). */
  onCreated: (account: Account) => void;
  /** Flat list of accounts for the parent picker. */
  accounts: Account[];
  /** Starting values, e.g. the name typed into a register's Account column. */
  initial?: { name?: string; qbType?: QbAccountType };
}

const EMPTY_FORM = {
  code: '',
  name: '',
  qbType: 'bank' as QbAccountType,
  subtype: 'checking',
  parentId: '',
  taxLine: '',
  openingBalance: '',
};

export function AddAccountModal({ open, onClose, onCreated, accounts, initial }: AddAccountModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [taxForm] = useIncomeTaxForm(open);
  // Preferences > Accounting: 'Require account numbers' (else a blank number is assigned for you).
  const acctPrefs = usePreferences().company;
  const numberRequired = acctPrefs.accountNumbersEnabled && acctPrefs.requireAccountNumbers;

  // Reset form when modal opens
  useEffect(() => {
    if (!open) return;
    const qbType = initial?.qbType ?? EMPTY_FORM.qbType;
    const subtype = initial?.qbType ? (getQbAccountTypeInfo(qbType)?.defaultSubtype ?? EMPTY_FORM.subtype) : EMPTY_FORM.subtype;
    setForm({ ...EMPTY_FORM, name: initial?.name ?? '', qbType, subtype });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Parent candidates: active accounts of the same QB account type.
  const parentOptions = accounts.filter((a) => qbTypeOfAccount(a) === form.qbType && a.isActive);
  const nonPosting = form.qbType === 'non_posting';
  // QB: A/R and A/P balances come only from customer / vendor transactions, never an opening balance.
  const subledger = form.qbType === 'accounts_receivable' || form.qbType === 'accounts_payable';
  const allowOpening = !nonPosting && !subledger;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (numberRequired && !form.code.trim()) { toast('Enter an account number. Your preferences require one.', 'danger'); return; }
    if (!form.name.trim()) { toast('Account name is required.', 'danger'); return; }
    setSaving(true);
    try {
      const created = await api.post<Account>('/api/accounts', {
        code: form.code.trim(),
        name: form.name.trim(),
        qbType: form.qbType,
        subtype: form.subtype,
        parentId: form.parentId || null,
        taxLine: form.taxLine || null,
        openingBalance: allowOpening && form.openingBalance.trim() ? form.openingBalance.trim() : null,
      });
      toast('Account created.', 'success');
      onCreated(created);
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create account.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Account"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit as never} loading={saving}>
            Create Account
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AccountTypePicker
          id="acc-type"
          qbType={form.qbType}
          subtype={form.subtype}
          onChange={(qbType, subtype) =>
            // Changing the type resets the parent (parent must have the same type).
            setForm((prev) => ({ ...prev, qbType, subtype, parentId: prev.qbType === qbType ? prev.parentId : '' }))
          }
        />
        <div>
          <Label htmlFor="acc-code" required={numberRequired}>Account number</Label>
          <Input
            id="acc-code"
            placeholder={numberRequired ? 'e.g. 1010' : 'Leave blank to number it for you'}
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="acc-name" required>Account name</Label>
          <Input
            id="acc-name"
            placeholder="e.g. Business Checking"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <ParentSelect
          id="acc-parent"
          value={form.parentId}
          onChange={(v) => set('parentId', v)}
          options={parentOptions}
        />
        {subledger && (
          <p className="text-xs text-navy/60">
            {form.qbType === 'accounts_receivable'
              ? 'This account gets its balance from invoices and payments, so it has no opening balance. Enter what customers owe as invoices.'
              : 'This account gets its balance from bills and bill payments, so it has no opening balance. Enter what you owe vendors as bills.'}
          </p>
        )}
        {allowOpening && (
          <div>
            <Label htmlFor="acc-opening">
              Opening balance (optional) <Help term="opening-balance-equity" />
            </Label>
            <Input
              id="acc-opening"
              inputMode="decimal"
              placeholder="0.00"
              value={form.openingBalance}
              onChange={(e) => set('openingBalance', e.target.value)}
            />
          </div>
        )}
        {!nonPosting && (
          <TaxLineSelect id="acc-taxline" value={form.taxLine} onChange={(v) => set('taxLine', v)} form={taxForm} />
        )}
      </form>
    </Modal>
  );
}
