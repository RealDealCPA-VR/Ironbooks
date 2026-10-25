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
import { quickReportHref } from '@/lib/shortcuts';
import { Help } from '@/components/Help';
import WhyChanged from '@/components/WhyChanged';
import { api, ApiError } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import {
  QB_ACCOUNT_TYPES,
  SUBTYPE_LABELS,
  type QbAccountType,
  getQbAccountTypeInfo,
} from '@/lib/accountTypes';
import { INCOME_TAX_FORMS, type IncomeTaxForm, getTaxLine } from '@/lib/taxLines';
import type Decimal from 'decimal.js';
import {
  type Account,
  AccountTypePicker,
  AddAccountModal,
  ParentSelect,
  TaxLineSelect,
  qbTypeOfAccount,
  useIncomeTaxForm,
} from '@/components/accounts/AccountForm';

// ---- Types ----------------------------------------------------------------

/** Node shape returned by GET /api/accounts?tree=true (getAccountTree). */
interface AccountNode extends Account {
  children: AccountNode[];
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
      <Tr
        key={node.id}
        className={node.isActive ? '' : 'opacity-60'}
        data-quick-report={quickReportHref('account', node.id)}
      >
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
      <main className="min-h-screen bg-offwhite p-8 font-sans">
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
