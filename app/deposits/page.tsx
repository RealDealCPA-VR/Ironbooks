'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Landmark, Plus, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
  Label,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { useNewParam } from '@/lib/useFocusParam';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface UndepositedItem {
  id: string;
  kind: 'payment' | 'sales_receipt';
  customerId: string | null;
  customerName: string | null;
  date: string;
  method: string;
  reference: string | null;
  amount: string;
}

interface DepositLine {
  id: string;
  depositId: string;
  paymentId: string | null;
  description: string | null;
  amount: string;
}

interface Deposit {
  id: string;
  depositAccountId: string;
  accountName: string | null;
  accountCode: string | null;
  date: string;
  total: string;
  memo: string | null;
  voidedAt: string | null;
  createdAt: string;
  lines: DepositLine[];
}

interface ExtraLine {
  accountId: string;
  amount: string;
  description: string;
}

function emptyExtraLine(): ExtraLine {
  return { accountId: '', amount: '', description: '' };
}

// ---------------------------------------------------------------------------
// Make Deposit Modal
// ---------------------------------------------------------------------------

interface MakeDepositModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  bankAccounts: Account[];
  allAccounts: Account[];
  undepositedItems: UndepositedItem[];
  loadingItems: boolean;
}

function MakeDepositModal({
  open,
  onClose,
  onCreated,
  bankAccounts,
  allAccounts,
  undepositedItems,
  loadingItems,
}: MakeDepositModalProps) {
  const [depositAccountId, setDepositAccountId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [methodFilter, setMethodFilter] = useState('all');
  const [extraLines, setExtraLines] = useState<ExtraLine[]>([]);
  const [cashBackAccountId, setCashBackAccountId] = useState('');
  const [cashBackAmount, setCashBackAmount] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset when modal opens.
  useEffect(() => {
    if (open) {
      setDepositAccountId('');
      setDate(new Date().toISOString().slice(0, 10));
      setMemo('');
      setSelectedIds(new Set());
      setMethodFilter('all');
      setExtraLines([]);
      setCashBackAccountId('');
      setCashBackAmount('');
    }
  }, [open]);

  // QB groups "Payments to Deposit" by method — offer a method filter.
  const methods = [...new Set(undepositedItems.map((p) => p.method))];
  const visibleItems =
    methodFilter === 'all'
      ? undepositedItems
      : undepositedItems.filter((p) => p.method === methodFilter);

  function toggleItem(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    const visibleSelected = visibleItems.filter((p) => selectedIds.has(p.id)).length;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (visibleSelected === visibleItems.length) {
        for (const p of visibleItems) next.delete(p.id);
      } else {
        for (const p of visibleItems) next.add(p.id);
      }
      return next;
    });
  }

  function patchExtraLine(index: number, patch: Partial<ExtraLine>) {
    setExtraLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const selectedTotal = undepositedItems
    .filter((p) => selectedIds.has(p.id))
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const extraTotal = extraLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const cashBackNum = Number(cashBackAmount) || 0;
  const netTotal = selectedTotal + extraTotal - cashBackNum;

  async function handleSubmit() {
    if (!depositAccountId) {
      toast('Please select a bank account.', 'danger');
      return;
    }
    if (!date) {
      toast('Please enter a deposit date.', 'danger');
      return;
    }
    if (selectedIds.size === 0 && extraLines.length === 0) {
      toast('Select at least one payment or add a deposit line.', 'danger');
      return;
    }
    for (const [i, l] of extraLines.entries()) {
      if (!l.accountId || !(Number(l.amount) > 0)) {
        toast(`Additional line ${i + 1}: choose an account and a positive amount.`, 'danger');
        return;
      }
    }
    if (cashBackNum > 0 && !cashBackAccountId) {
      toast('Choose the account that cash back goes to.', 'danger');
      return;
    }
    if (netTotal <= 0) {
      toast('Net deposit must be greater than zero.', 'danger');
      return;
    }

    const paymentIds = undepositedItems
      .filter((p) => p.kind === 'payment' && selectedIds.has(p.id))
      .map((p) => p.id);
    const salesReceiptIds = undepositedItems
      .filter((p) => p.kind === 'sales_receipt' && selectedIds.has(p.id))
      .map((p) => p.id);

    setSaving(true);
    try {
      await api.post('/api/deposits', {
        depositAccountId,
        date,
        paymentIds,
        salesReceiptIds,
        extraLines: extraLines.map((l) => ({
          accountId: l.accountId,
          amount: l.amount,
          description: l.description.trim() || undefined,
        })),
        cashBack:
          cashBackNum > 0
            ? { accountId: cashBackAccountId, amount: cashBackAmount }
            : undefined,
        memo: memo || undefined,
      });
      toast('Deposit created successfully.', 'success');
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to create deposit.');
    } finally {
      setSaving(false);
    }
  }

  const allSelected =
    visibleItems.length > 0 && visibleItems.every((p) => selectedIds.has(p.id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Make Deposit"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={selectedIds.size === 0 && extraLines.length === 0}
          >
            {`Deposit ${formatCurrency(netTotal.toFixed(2))}`}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Bank account */}
        <div>
          <Label htmlFor="dep-account" required>Deposit To</Label>
          <Select
            id="dep-account"
            autoFocus
            value={depositAccountId}
            onChange={(e) => setDepositAccountId(e.target.value)}
          >
            <option value="">Select bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        {/* Date */}
        <div>
          <Label htmlFor="dep-date" required>Date</Label>
          <DateInput
            id="dep-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="dep-memo">Memo</Label>
          <Input
            id="dep-memo"
            placeholder="Optional note"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Undeposited items list */}
        <div>
          <div className="flex items-center justify-between mb-2 gap-2">
            <Label className="mb-0">Payments in Undeposited Funds <Help term="undeposited-funds" /></Label>
            <span className="flex items-center gap-3">
              {methods.length > 1 && (
                <select
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 text-navy/70 bg-white"
                  aria-label="Filter by payment method"
                >
                  <option value="all">All methods</option>
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {m.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              )}
              {visibleItems.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-electric hover:text-electric/80 font-medium"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </span>
          </div>

          {loadingItems ? (
            <div className="text-sm text-navy/40 py-4 text-center">Loading payments…</div>
          ) : visibleItems.length === 0 ? (
            <div className="text-sm text-navy/40 py-4 text-center rounded-lg border border-dashed border-slate-200">
              No undeposited payments found.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-hidden divide-y divide-slate-100">
              {visibleItems.map((p) => {
                const checked = selectedIds.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                      checked ? 'bg-electric/5' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(p.id)}
                      className="accent-electric"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-navy truncate">
                          {p.customerName ?? p.customerId ?? 'No customer'}
                          <span className="ml-2 inline-block">
                            <Badge tone={p.kind === 'sales_receipt' ? 'info' : 'neutral'}>
                              {p.kind === 'sales_receipt' ? 'Sales Receipt' : 'Payment'}
                            </Badge>
                          </span>
                        </span>
                        <span className="text-sm font-semibold text-navy tabular-nums shrink-0">
                          {formatCurrency(p.amount)}
                        </span>
                      </div>
                      <div className="flex gap-3 text-xs text-navy/50 mt-0.5">
                        <span>{formatDate(p.date)}</span>
                        <span className="capitalize">{p.method.replace('_', ' ')}</span>
                        {p.reference && <span>#{p.reference}</span>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Additional deposit lines (e.g. owner contribution) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Additional Deposit Lines</Label>
            <button
              type="button"
              onClick={() => setExtraLines((prev) => [...prev, emptyExtraLine()])}
              className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Add Line
            </button>
          </div>
          {extraLines.length === 0 ? (
            <p className="text-xs text-navy/40">
              For funds not in Undeposited Funds — e.g. an owner contribution or refund.
            </p>
          ) : (
            <div className="space-y-2">
              {extraLines.map((l, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <div className="flex-1 min-w-0">
                    <Select
                      value={l.accountId}
                      onChange={(e) => patchExtraLine(idx, { accountId: e.target.value })}
                      aria-label={`Extra line ${idx + 1} account`}
                    >
                      <option value="">From account…</option>
                      {allAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex-1 min-w-0">
                    <Input
                      placeholder="Description"
                      value={l.description}
                      onChange={(e) => patchExtraLine(idx, { description: e.target.value })}
                    />
                  </div>
                  <div className="w-28 shrink-0">
                    <AmountInput
                      placeholder="0.00"
                      value={l.amount}
                      onChange={(e) => patchExtraLine(idx, { amount: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setExtraLines((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-red-400 hover:text-red-600"
                    title="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cash back */}
        <div>
          <Label className="mb-2">Cash Back (optional)</Label>
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <Select
                value={cashBackAccountId}
                onChange={(e) => setCashBackAccountId(e.target.value)}
                aria-label="Cash back goes to"
              >
                <option value="">Cash back goes to…</option>
                {allAccounts
                  .filter((a) => a.id !== depositAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="w-28 shrink-0">
              <AmountInput
                placeholder="0.00"
                value={cashBackAmount}
                onChange={(e) => setCashBackAmount(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Live total */}
        {(selectedIds.size > 0 || extraTotal > 0 || cashBackNum > 0) && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 space-y-1">
            <div className="flex items-center justify-between text-sm text-navy/70">
              <span>
                Selected ({selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''})
              </span>
              <span className="tabular-nums">{formatCurrency(selectedTotal.toFixed(2))}</span>
            </div>
            {extraTotal > 0 && (
              <div className="flex items-center justify-between text-sm text-navy/70">
                <span>Additional lines</span>
                <span className="tabular-nums">{formatCurrency(extraTotal.toFixed(2))}</span>
              </div>
            )}
            {cashBackNum > 0 && (
              <div className="flex items-center justify-between text-sm text-navy/70">
                <span>Cash back</span>
                <span className="tabular-nums">-{formatCurrency(cashBackNum.toFixed(2))}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-navy/10 pt-1">
              <span className="text-sm font-semibold text-navy/70">Net deposit</span>
              <span className="text-lg font-bold text-navy tabular-nums">
                {formatCurrency(netTotal.toFixed(2))}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function DepositsPageContent() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [undepositedItems, setUndepositedItems] = useState<UndepositedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [pendingVoid, setPendingVoid] = useState<string | null>(null);

  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Deposit[]>('/api/deposits');
      setDeposits(rows);
    } catch (err: unknown) {
      toastError(err, 'Failed to load deposits.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSupportingData = useCallback(async () => {
    try {
      const [accts, items] = await Promise.all([
        api.get<Account[]>('/api/accounts'),
        (async () => {
          setLoadingItems(true);
          const r = await api.get<UndepositedItem[]>('/api/deposits/undeposited');
          setLoadingItems(false);
          return r;
        })(),
      ]);
      setAccounts(accts);
      setUndepositedItems(items);
    } catch (err: unknown) {
      toastError(err, 'Failed to load data.');
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    fetchDeposits();
    fetchSupportingData();
  }, [fetchDeposits, fetchSupportingData]);

  function openModal() {
    // Refresh undeposited items each time the modal is opened.
    fetchSupportingData();
    setShowModal(true);
  }

  // Quick Actions navigate here with ?new=1 — open the Make Deposit modal.
  useNewParam(openModal);

  function handleCreated() {
    fetchDeposits();
    fetchSupportingData();
  }

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/deposits/${id}`);
      toast('Deposit voided — items returned to Undeposited Funds.', 'success');
      await Promise.all([fetchDeposits(), fetchSupportingData()]);
    } catch (err: unknown) {
      toastError(err, 'Failed to void deposit.');
    } finally {
      setVoidingId(null);
      setPendingVoid(null);
    }
  }

  // Bank accounts for the "Deposit To" picker (asset accounts excluding UF).
  const bankAccounts = accounts.filter((a) => a.type === 'asset' && a.code !== '1050');

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Bank Deposits"
        icon={Landmark}
        action={
          <Button onClick={openModal}>
            <Plus className="h-4 w-4" /> Make Deposit
          </Button>
        }
      />

      {/* Undeposited Funds summary banner */}
      {undepositedItems.length > 0 && (
        <div className="mb-6 flex items-center justify-between rounded-xl bg-gold/10 border border-gold/30 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-navy">
              {undepositedItems.length} undeposited item
              {undepositedItems.length !== 1 ? 's' : ''} in Undeposited Funds
            </p>
            <p className="text-xs text-navy/60 mt-0.5">
              Total:{' '}
              <strong>
                {formatCurrency(
                  undepositedItems
                    .reduce((s, p) => s + Number(p.amount), 0)
                    .toFixed(2),
                )}
              </strong>
            </p>
          </div>
          <Button size="sm" onClick={openModal}>
            Make Deposit
          </Button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="py-20 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : deposits.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No deposits yet"
            message="After you receive payments, take them to the bank and record the deposit here so your books match your bank statement."
            action={
              <Button onClick={openModal}>
                <Plus className="h-4 w-4" /> Make Deposit
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Date</Th>
                <Th>Account</Th>
                <Th>Lines</Th>
                <Th>Memo</Th>
                <Th>Status</Th>
                <Th numeric>Total</Th>
                <Th />
              </Tr>
            </thead>
            <tbody>
              {deposits.map((dep) => (
                <Tr key={dep.id} className={dep.voidedAt ? 'opacity-60' : undefined}>
                  <Td className="text-navy/70">{formatDate(dep.date)}</Td>
                  <Td className="font-medium text-navy">
                    {dep.accountCode ? (
                      <span>
                        <span className="text-navy/50 text-xs mr-1">{dep.accountCode}</span>
                        {dep.accountName}
                      </span>
                    ) : (
                      dep.depositAccountId
                    )}
                  </Td>
                  <Td className="text-navy/70">
                    {dep.lines.length} line{dep.lines.length !== 1 ? 's' : ''}
                  </Td>
                  <Td className="text-navy/60 text-sm">{dep.memo ?? '—'}</Td>
                  <Td>
                    {dep.voidedAt ? (
                      <Badge tone="void">Voided</Badge>
                    ) : (
                      <Badge tone="success">Posted</Badge>
                    )}
                  </Td>
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(dep.total)}
                  </Td>
                  <Td className="text-right">
                    {!dep.voidedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === dep.id}
                        onClick={() => setPendingVoid(dep.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer (voided deposits excluded) */}
      {deposits.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {deposits.length} deposit{deposits.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total deposited:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                deposits
                  .filter((d) => !d.voidedAt)
                  .reduce((s, d) => s + Number(d.total), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <MakeDepositModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onCreated={handleCreated}
        bankAccounts={bankAccounts}
        allAccounts={accounts}
        undepositedItems={undepositedItems}
        loadingItems={loadingItems}
      />

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void deposit?"
        message="Items will be returned to Undeposited Funds."
        confirmLabel="Void"
        tone="danger"
        loading={!!voidingId}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

export default function DepositsPage() {
  return (
    <Suspense fallback={null}>
      <DepositsPageContent />
    </Suspense>
  );
}
