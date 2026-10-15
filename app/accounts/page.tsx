'use client';

import { useEffect, useState } from 'react';
// wave2 prefs: Accounting > "Use account numbers" shows/hides the number column.
import { usePreferences } from '@/lib/usePreferences';
import { BookOpen, Plus, Trash2, Pencil, ChevronDown, ChevronRight, CornerDownRight, Download } from 'lucide-react';
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
import { Help } from '@/components/Help';
import WhyChanged from '@/components/WhyChanged';
import { api, ApiError } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import {
  QB_ACCOUNT_TYPES,
  SUBTYPE_LABELS,
  type QbAccountType,
  getQbAccountTypeInfo,
  qbAccountTypeOf,
} from '@/lib/accountTypes';
import { INCOME_TAX_FORMS, type IncomeTaxForm, getTaxLine, taxLinesForForm } from '@/lib/taxLines';
import type Decimal from 'decimal.js';

// ---- Types ----------------------------------------------------------------

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

interface Account {
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
}

/** Node shape returned by GET /api/accounts?tree=true (getAccountTree). */
interface AccountNode extends Account {
  children: AccountNode[];
}

function qbTypeOfAccount(a: Account): QbAccountType {
  return a.qbType ?? qbAccountTypeOf(a);
}

// ---- Tree helpers (client-side) --------------------------------------------

/** Depth-first flatten of the tree (parents before children). */
function flattenTree(nodes: AccountNode[]): AccountNode[] {
  const out: AccountNode[] = [];
  const walk = (list: AccountNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Own balance + all descendants — the QB parent subtotal (decimal-safe). */
function subtotal(node: AccountNode): Decimal {
  return node.children.reduce((sum, c) => sum.plus(subtotal(c)), Money.of(node.balance));
}

/** Ids of a node and everything beneath it (invalid parent choices when editing). */
function selfAndDescendantIds(node: AccountNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: AccountNode) => {
    ids.add(n.id);
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

// ---- Tax form (company setting used by the tax-line picker) ----------------

interface TaxMappingResponse {
  form: IncomeTaxForm | null;
}

function useIncomeTaxForm(open: boolean): [IncomeTaxForm | null, (f: IncomeTaxForm | null) => void] {
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

function ParentSelect({
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
function AccountTypePicker({
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

function TaxLineSelect({
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

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Flat list of accounts for the parent picker. */
  accounts: Account[];
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

function AddAccountModal({ open, onClose, onCreated, accounts }: AddAccountModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [taxForm] = useIncomeTaxForm(open);
  // Preferences > Accounting: 'Require account numbers' (else a blank number is assigned for you).
  const acctPrefs = usePreferences().company;
  const numberRequired = acctPrefs.accountNumbersEnabled && acctPrefs.requireAccountNumbers;

  // Reset form when modal opens
  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
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
      await api.post('/api/accounts', {
        code: form.code.trim(),
        name: form.name.trim(),
        qbType: form.qbType,
        subtype: form.subtype,
        parentId: form.parentId || null,
        taxLine: form.taxLine || null,
        openingBalance: allowOpening && form.openingBalance.trim() ? form.openingBalance.trim() : null,
      });
      toast('Account created.', 'success');
      onCreated();
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

// ---- Edit Account Modal -----------------------------------------------------

interface EditAccountModalProps {
  account: AccountNode | null;
  onClose: () => void;
  onSaved: () => void;
  /** Flat list of accounts for the parent picker. */
  accounts: Account[];
}

function EditAccountModal({ account, onClose, onSaved, accounts }: EditAccountModalProps) {
  const [name, setName] = useState('');
  const [qbType, setQbType] = useState<QbAccountType>('bank');
  const [subtype, setSubtype] = useState('');
  const [parentId, setParentId] = useState('');
  const [description, setDescription] = useState('');
  const [taxLine, setTaxLine] = useState('');
  const [saving, setSaving] = useState(false);
  const [taxForm] = useIncomeTaxForm(!!account);

  useEffect(() => {
    if (account) {
      setName(account.name);
      const t = qbTypeOfAccount(account);
      const info = getQbAccountTypeInfo(t)!;
      setQbType(t);
      // Legacy charts can hold a detail type that does not match the account type; fall back
      // to the type's default so saving fixes it instead of failing validation.
      setSubtype((info.subtypes as string[]).includes(account.subtype) ? account.subtype : info.defaultSubtype);
      setParentId(account.parentId ?? '');
      setDescription(account.description ?? '');
      setTaxLine(account.taxLine ?? '');
      setSaving(false);
    }
  }, [account]);

  // Parent candidates: same QB type, active, and not the account itself or any of
  // its descendants (the service re-validates cycles server-side).
  const invalidIds = account ? selfAndDescendantIds(account) : new Set<string>();
  const parentOptions = accounts.filter(
    (a) => account && qbTypeOfAccount(a) === qbType && a.isActive && !invalidIds.has(a.id),
  );

  async function handleSave() {
    if (!account) return;
    if (!name.trim()) { toast('Account name is required.', 'danger'); return; }
    setSaving(true);
    try {
      await api.patch(`/api/accounts/${account.id}`, {
        name: name.trim(),
        qbType,
        subtype,
        parentId: parentId || null,
        description: description.trim() || null,
        taxLine: taxLine || null,
      });
      toast('Account updated.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update account.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={account ? `Edit Account ${account.code}` : 'Edit Account'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save Changes
          </Button>
        </>
      }
    >
      {account && (
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="edit-acc-name" required>Account name</Label>
            <Input
              id="edit-acc-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <AccountTypePicker
            id="edit-acc-type"
            qbType={qbType}
            subtype={subtype}
            onChange={(t, s) => {
              if (t !== qbType) setParentId('');
              setQbType(t);
              setSubtype(s);
            }}
          />
          <ParentSelect
            id="edit-acc-parent"
            value={parentId}
            onChange={setParentId}
            options={parentOptions}
          />
          <div>
            <Label htmlFor="edit-acc-desc">Description</Label>
            <Input
              id="edit-acc-desc"
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {qbType !== 'non_posting' && (
            <TaxLineSelect id="edit-acc-taxline" value={taxLine} onChange={setTaxLine} form={taxForm} />
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- Tax form picker (company setting) --------------------------------------

function TaxFormPicker() {
  const [form, setForm] = useIncomeTaxForm(true);
  const [saving, setSaving] = useState(false);
  async function change(value: string) {
    const next = (value || null) as IncomeTaxForm | null;
    setSaving(true);
    try {
      await api.put('/api/accounts/tax-lines', { form: next });
      setForm(next);
      toast('Tax form saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save the tax form.', 'danger');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="coa-tax-form" className="mb-0 whitespace-nowrap">
        Tax form <Help term="tax-line" />
      </Label>
      <Select
        id="coa-tax-form"
        value={form ?? ''}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        className="w-56"
      >
        <option value="">— Not set —</option>
        {INCOME_TAX_FORMS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---- Account row (recursive — indented sub-accounts) ------------------------

interface AccountRowProps {
  node: AccountNode;
  depth: number;
  onDeactivate: (account: Account) => void;
  onEdit: (account: AccountNode) => void;
}

function AccountRow({ node, depth, onDeactivate, onEdit }: AccountRowProps) {
  const hasChildren = node.children.length > 0;
  const rolledUp = subtotal(node);
  const showNumbers = usePreferences().company.accountNumbersEnabled;

  return (
    <>
      <Tr key={node.id} className={node.isActive ? '' : 'opacity-60'}>
        {showNumbers && (
          <Td>
            <span className="font-mono text-xs text-navy/60">{node.code}</span>
          </Td>
        )}
        <Td>
          <span
            className="flex items-center gap-1.5"
            style={{ paddingLeft: `${depth * 1.25}rem` }}
          >
            {depth > 0 && <CornerDownRight className="h-3.5 w-3.5 text-navy/30 shrink-0" />}
            <span className="font-medium text-navy">{node.name}</span>
          </span>
        </Td>
        <Td>
          <span className="text-navy/50 text-xs">
            {SUBTYPE_LABELS[node.subtype as keyof typeof SUBTYPE_LABELS] ?? node.subtype}
          </span>
          {node.taxLine && (
            <span className="block text-[11px] text-navy/40" title="Tax line">
              {getTaxLine(node.taxLine)?.label ?? node.taxLine}
            </span>
          )}
        </Td>
        <Td numeric className="font-semibold text-navy">
          <div className="inline-flex items-center gap-1">
            {formatCurrency(node.balance)}
            <WhyChanged
              compact
              title={`the ${node.name} balance`}
              query={{ accounts: [node.id] }}
              storageKey={`account:${node.id}`}
            />
          </div>
          {hasChildren && (
            <div className="text-xs font-normal text-navy/50">
              Total {formatCurrency(rolledUp)}
            </div>
          )}
        </Td>
        <Td className="text-center">
          {node.isActive ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="neutral">Inactive</Badge>
          )}
        </Td>
        <Td className="text-center whitespace-nowrap">
          <button
            className="p-1.5 rounded-lg text-navy/40 hover:text-electric hover:bg-electric/10 transition-colors"
            title="Edit account"
            onClick={() => onEdit(node)}
          >
            <Pencil className="h-4 w-4" />
          </button>
          {node.isActive && (
            <button
              className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Deactivate account"
              onClick={() => onDeactivate(node)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </Td>
      </Tr>
      {node.children.map((child) => (
        <AccountRow
          key={child.id}
          node={child}
          depth={depth + 1}
          onDeactivate={onDeactivate}
          onEdit={onEdit}
        />
      ))}
    </>
  );
}

// ---- Account Group Section ------------------------------------------------

interface AccountGroupProps {
  type: QbAccountType;
  roots: AccountNode[];
  onDeactivate: (account: Account) => void;
  onEdit: (account: AccountNode) => void;
}

function AccountGroup({ type, roots, onDeactivate, onEdit }: AccountGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const info = getQbAccountTypeInfo(type)!;
  const label = info.label;
  const prefs = usePreferences();

  // Group total = sum of every account in the type (roots + all descendants).
  const all = flattenTree(roots);
  const total = Money.add(...all.map((a) => a.balance));

  return (
    <div className="mb-6">
      {/* Group header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-navy/5 to-transparent rounded-xl mb-1 hover:from-navy/10 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-navy/50 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-navy/50 shrink-0" />
        )}
        <span className="text-sm font-bold text-navy uppercase tracking-wide flex-1 text-left">
          {label}
          {type === 'non_posting' && (
            <span className="ml-2 normal-case font-normal text-navy/50">
              (tracks estimates and orders; never on reports)
            </span>
          )}
        </span>
        <span className="text-sm font-semibold text-navy/60 tabular-nums">
          {formatCurrency(total)}
        </span>
        <Badge tone="info">{all.length}</Badge>
      </button>

      {!collapsed && (
        <Table>
          <thead>
            <tr>
              {prefs.company.accountNumbersEnabled && <Th className="w-24">Code</Th>}
              <Th>Name</Th>
              <Th>Detail type</Th>
              <Th numeric>Balance</Th>
              <Th className="w-24 text-center">Status</Th>
              <Th className="w-20 text-center">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {roots.length === 0 ? (
              <Tr>
                <Td colSpan={6} className="text-center text-navy/40 py-6 italic">
                  No {label.toLowerCase()} accounts yet.
                </Td>
              </Tr>
            ) : (
              roots.map((node) => (
                <AccountRow
                  key={node.id}
                  node={node}
                  depth={0}
                  onDeactivate={onDeactivate}
                  onEdit={onEdit}
                />
              ))
            )}
          </tbody>
        </Table>
      )}
    </div>
  );
}

// ---- Main Page ------------------------------------------------------------

export default function AccountsPage() {
  const [tree, setTree] = useState<AccountNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AccountNode | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Account | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  async function fetchAccounts() {
    try {
      // Hierarchical chart of accounts (includes inactive accounts so history stays visible).
      const data = await api.get<AccountNode[]>('/api/accounts?tree=true');
      setTree(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load accounts.', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAccounts();
  }, []);

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.del(`/api/accounts/${deactivateTarget.id}`);
      toast(`"${deactivateTarget.name}" deactivated.`, 'success');
      setDeactivateTarget(null);
      fetchAccounts();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to deactivate account.', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  const flat = flattenTree(tree);

  // Group root nodes by QuickBooks account type in QB order (children render under their
  // parent); empty types are hidden.
  const grouped = QB_ACCOUNT_TYPES.map((t) => ({
    type: t.value,
    roots: tree.filter((a) => qbTypeOfAccount(a) === t.value),
  })).filter((g) => g.roots.length > 0);

  const totalAccounts = flat.length;

  return (
    <>
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader
          title="Chart of Accounts"
          icon={BookOpen}
          action={
            <div className="flex items-center gap-2 flex-wrap">
              <TaxFormPicker />
              <Button
                variant="secondary"
                onClick={() => window.open('/api/export/accounts.csv', '_blank')}
                title="Export the chart of accounts to CSV"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Account
              </Button>
            </div>
          }
        />

        {loading ? (
          <Card className="p-12 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </Card>
        ) : totalAccounts === 0 ? (
          <Card>
            <EmptyState
              icon={BookOpen}
              title="No accounts yet"
              message="Add your first account to build out your chart of accounts. Start with assets like a checking account."
              action={
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add Account
                </Button>
              }
            />
          </Card>
        ) : (
          <Card className="p-6">
            {grouped.map(({ type, roots }) => (
              <AccountGroup
                key={type}
                type={type}
                roots={roots}
                onDeactivate={setDeactivateTarget}
                onEdit={setEditTarget}
              />
            ))}
          </Card>
        )}

        <AddAccountModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onCreated={fetchAccounts}
          accounts={flat}
        />

        <EditAccountModal
          account={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={fetchAccounts}
          accounts={flat}
        />

        <ConfirmDialog
          open={!!deactivateTarget}
          title="Deactivate Account"
          message={
            <>
              Are you sure you want to deactivate{' '}
              <span className="font-semibold text-navy">{deactivateTarget?.name}</span>? It will be
              hidden from the chart of accounts but preserved in historical reports.
            </>
          }
          confirmLabel="Deactivate"
          tone="danger"
          loading={deactivating}
          onConfirm={handleDeactivate}
          onClose={() => setDeactivateTarget(null)}
        />
      </main>
    </>
  );
}
