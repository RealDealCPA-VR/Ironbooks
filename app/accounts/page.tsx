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
import { api, ApiError } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import type Decimal from 'decimal.js';

// ---- Types ----------------------------------------------------------------

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  balance: string;
  isActive: boolean;
  description?: string | null;
  parentId?: string | null;
}

/** Node shape returned by GET /api/accounts?tree=true (getAccountTree). */
interface AccountNode extends Account {
  children: AccountNode[];
}

// Map API type values -> display labels (API uses singular lowercase)
const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
};

// Ordered for display
const TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

// Valid subtypes per type (must match accountSubtypeEnum in lib/db/schema.ts)
const SUBTYPES_BY_TYPE: Record<AccountType, { value: string; label: string }[]> = {
  asset: [
    { value: 'checking', label: 'Checking' },
    { value: 'savings', label: 'Savings' },
    { value: 'accounts_receivable', label: 'Accounts Receivable' },
    { value: 'inventory', label: 'Inventory' },
    { value: 'fixed_assets', label: 'Fixed Assets' },
  ],
  liability: [
    { value: 'accounts_payable', label: 'Accounts Payable' },
    { value: 'credit_card', label: 'Credit Card' },
    { value: 'long_term_liability', label: 'Long-Term Liability' },
  ],
  equity: [
    { value: 'owners_equity', label: "Owner's Equity" },
    { value: 'retained_earnings', label: 'Retained Earnings' },
  ],
  revenue: [
    { value: 'sales', label: 'Sales' },
    { value: 'service_revenue', label: 'Service Revenue' },
    { value: 'other_income', label: 'Other Income' },
  ],
  expense: [
    { value: 'cost_of_goods_sold', label: 'Cost of Goods Sold' },
    { value: 'operating_expenses', label: 'Operating Expenses' },
    { value: 'payroll', label: 'Payroll' },
    { value: 'taxes', label: 'Taxes' },
  ],
};

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

/** Map subtype enum value -> display label (e.g. 'accounts_receivable' -> 'Accounts Receivable'). */
const SUBTYPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(SUBTYPES_BY_TYPE).flatMap((opts) => opts.map((o) => [o.value, o.label])),
);

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

// ---- Parent picker (shared by Add + Edit modals) ----------------------------

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
        Sub-accounts must have the same type as their parent.
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
  type: 'asset' as AccountType,
  subtype: SUBTYPES_BY_TYPE.asset[0].value,
  parentId: '',
};

function AddAccountModal({ open, onClose, onCreated, accounts }: AddAccountModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  function set(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((prev) => {
      // Changing the type resets the subtype + parent (parent must match type).
      if (field === 'type') {
        const type = value as AccountType;
        return { ...prev, type, subtype: SUBTYPES_BY_TYPE[type][0].value, parentId: '' };
      }
      return { ...prev, [field]: value };
    });
  }

  // Parent candidates: active accounts of the same type.
  const parentOptions = accounts.filter((a) => a.type === form.type && a.isActive);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim()) { toast('Account code is required.', 'danger'); return; }
    if (!form.name.trim()) { toast('Account name is required.', 'danger'); return; }
    setSaving(true);
    try {
      await api.post('/api/accounts', {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        subtype: form.subtype,
        parentId: form.parentId || null,
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
        <div>
          <Label htmlFor="acc-code">Account Code *</Label>
          <Input
            id="acc-code"
            placeholder="e.g. 1010"
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="acc-name">Account Name *</Label>
          <Input
            id="acc-name"
            placeholder="e.g. Checking Account"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="acc-type">Type *</Label>
          <Select
            id="acc-type"
            value={form.type}
            onChange={(e) => set('type', e.target.value as AccountType)}
          >
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
            <option value="equity">Equity</option>
            <option value="revenue">Revenue</option>
            <option value="expense">Expense</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="acc-subtype">Subtype *</Label>
          <Select
            id="acc-subtype"
            value={form.subtype}
            onChange={(e) => set('subtype', e.target.value)}
          >
            {SUBTYPES_BY_TYPE[form.type].map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <ParentSelect
          id="acc-parent"
          value={form.parentId}
          onChange={(v) => set('parentId', v)}
          options={parentOptions}
        />
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
  const [subtype, setSubtype] = useState('');
  const [parentId, setParentId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) {
      setName(account.name);
      setSubtype(account.subtype);
      setParentId(account.parentId ?? '');
      setDescription(account.description ?? '');
      setSaving(false);
    }
  }, [account]);

  // Parent candidates: same type, active, and not the account itself or any of
  // its descendants (the service re-validates cycles server-side).
  const invalidIds = account ? selfAndDescendantIds(account) : new Set<string>();
  const parentOptions = accounts.filter(
    (a) => account && a.type === account.type && a.isActive && !invalidIds.has(a.id),
  );

  async function handleSave() {
    if (!account) return;
    if (!name.trim()) { toast('Account name is required.', 'danger'); return; }
    setSaving(true);
    try {
      await api.patch(`/api/accounts/${account.id}`, {
        name: name.trim(),
        subtype,
        parentId: parentId || null,
        description: description.trim() || null,
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
            <Label htmlFor="edit-acc-name">Account Name *</Label>
            <Input
              id="edit-acc-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-acc-subtype">Subtype</Label>
            <Select
              id="edit-acc-subtype"
              value={subtype}
              onChange={(e) => setSubtype(e.target.value)}
            >
              {SUBTYPES_BY_TYPE[account.type].map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
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
        </div>
      )}
    </Modal>
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
          <span className="text-navy/50 text-xs">{SUBTYPE_LABELS[node.subtype] ?? node.subtype}</span>
        </Td>
        <Td numeric className="font-semibold text-navy">
          <div>{formatCurrency(node.balance)}</div>
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
  type: AccountType;
  roots: AccountNode[];
  onDeactivate: (account: Account) => void;
  onEdit: (account: AccountNode) => void;
}

function AccountGroup({ type, roots, onDeactivate, onEdit }: AccountGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const label = TYPE_LABELS[type];
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
              <Th>Subtype</Th>
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

  // Group root nodes by type in display order (children render under their parent).
  const grouped = TYPE_ORDER.map((type) => ({
    type,
    roots: tree.filter((a) => a.type === type),
  }));

  const totalAccounts = flat.length;

  return (
    <>
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader
          title="Chart of Accounts"
          icon={BookOpen}
          action={
            <div className="flex items-center gap-2">
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
