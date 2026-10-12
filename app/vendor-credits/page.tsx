'use client';

import { isDepositTargetAccount } from '@/lib/accountTypes';
import { useEffect, useState, useCallback } from 'react';
import { RotateCcw, Plus, Trash2, PlusCircle, MinusCircle, CheckCircle, Banknote, Pencil } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
  /** p1 fx: the vendor's currency (null = home); its credits are in it. */
  currency?: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

interface Bill {
  id: string;
  vendorId: string;
  billNumber: string | null;
  total: string;
  balanceDue: string;
  status: string;
  date: string;
}

interface VendorCredit {
  id: string;
  vendorId: string;
  date: string;
  status: 'open' | 'partial' | 'closed' | 'void';
  total: string;
  unapplied: string;
  refundedAmount: string;
  memo: string | null;
}

interface CreditLine {
  accountId: string;
  description: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusTone(status: VendorCredit['status']): 'info' | 'warning' | 'success' | 'neutral' {
  if (status === 'open') return 'info';
  if (status === 'partial') return 'warning';
  if (status === 'closed') return 'success';
  return 'neutral';
}

function statusLabel(status: VendorCredit['status']): string {
  if (status === 'open') return 'Open';
  if (status === 'partial') return 'Partial';
  if (status === 'closed') return 'Closed';
  return 'Void';
}

const EMPTY_LINE: CreditLine = { accountId: '', description: '', amount: '' };

// ---------------------------------------------------------------------------
// New Vendor Credit Modal
// ---------------------------------------------------------------------------

interface NewCreditModalProps {
  open: boolean;
  onClose: () => void;
  vendors: Vendor[];
  accounts: Account[];
  onCreated: () => void;
  /** When set, the modal edits this saved credit (PATCH) instead of creating one. */
  editId?: string | null;
}

function NewCreditModal({ open, onClose, vendors, accounts, onCreated, editId }: NewCreditModalProps) {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<CreditLine[]>([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);
  // p1 fx: a foreign vendor's credit is in its currency at the stated / list rate.
  const [fxRate, setFxRate] = useState('');
  const vendorCur = vendors.find((v) => v.id === vendorId)?.currency || null;

  const [loadingEdit, setLoadingEdit] = useState(false);

  // Reset on open (or load the saved credit when editing).
  useEffect(() => {
    if (!open) return;
    setVendorId('');
    setDate(new Date().toISOString().slice(0, 10));
    setMemo('');
    setLines([{ ...EMPTY_LINE }]);
    if (!editId) return;
    let cancelled = false;
    setLoadingEdit(true);
    api
      .get<{
        vendorId: string;
        date: string;
        memo: string | null;
        lines: Array<{ accountId: string; description: string | null; amount: string }>;
      }>(`/api/vendor-credits/${editId}`)
      .then((c) => {
        if (cancelled) return;
        setVendorId(c.vendorId);
        setDate(String(c.date).slice(0, 10));
        setMemo(c.memo ?? '');
        setLines(
          c.lines.length > 0
            ? c.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? '', amount: l.amount }))
            : [{ ...EMPTY_LINE }],
        );
      })
      .catch((err) => {
        toastError(err, 'Could not load this vendor credit.');
        onClose();
      })
      .finally(() => !cancelled && setLoadingEdit(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  function updateLine(idx: number, field: keyof CreditLine, value: string) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  const liveTotal = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

  async function handleSubmit() {
    if (!vendorId) { toast('Please select a vendor.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }
    const validLines = lines.filter((l) => l.accountId && l.amount);
    if (validLines.length === 0) { toast('Add at least one line with an account and amount.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (parseFloat(l.amount) <= 0) {
        toast(`Line ${i + 1}: amount must be greater than zero.`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const body = {
        vendorId,
        date,
        memo: memo || null,
        lines: validLines.map((l) => ({
          accountId: l.accountId,
          description: l.description || null,
          amount: l.amount,
        })),
        ...(vendorCur && fxRate.trim() ? { exchangeRate: fxRate.trim() } : {}),
      };
      if (editId) {
        await api.patch(`/api/vendor-credits/${editId}`, body);
        toast('Vendor credit updated.', 'success');
      } else {
        await api.post('/api/vendor-credits', body);
        toast('Vendor credit created.', 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, editId ? 'Failed to save changes.' : 'Failed to create vendor credit.');
    } finally {
      setSaving(false);
    }
  }

  // Show only expense/asset accounts for credit lines (the accounts that get credited).
  const eligibleAccounts = accounts.filter(
    (a) => a.type === 'expense' || a.type === 'asset',
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editId ? 'Edit Vendor Credit' : 'New Vendor Credit'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {editId ? 'Cancel edit' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={loadingEdit}>
            {editId ? 'Save Changes' : 'Create Credit'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Changing amounts is only possible while none of the credit is applied or refunded — memo
            and descriptions can always be changed.
          </div>
        )}
        {loadingEdit && (
          <div className="flex items-center gap-2 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading credit…
          </div>
        )}
        {/* Vendor */}
        <div>
          <Label htmlFor="vc-vendor">Vendor *</Label>
          <Select id="vc-vendor" autoFocus value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select a vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.displayName}</option>
            ))}
          </Select>
        </div>

        {/* Date */}
        <div>
          <Label htmlFor="vc-date">Credit Date *</Label>
          <Input
            id="vc-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="vc-memo">Memo</Label>
          <Input
            id="vc-memo"
            placeholder="e.g. Returned goods, overcharge refund…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Credit Lines</Label>
            <Button type="button" variant="ghost" size="sm" onClick={addLine}>
              <PlusCircle className="h-4 w-4" /> Add line
            </Button>
          </div>

          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_100px_32px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
              <span>Account</span>
              <span>Description</span>
              <span>Amount</span>
              <span />
            </div>

            {lines.map((line, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_1fr_100px_32px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
              >
                <Select
                  value={line.accountId}
                  onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                >
                  <option value="">Select account…</option>
                  {eligibleAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(idx, 'description', e.target.value)}
                />
                <Input
                  placeholder="0.00"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={line.amount}
                  onChange={(e) => updateLine(idx, 'amount', e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  disabled={lines.length === 1}
                  className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors flex items-center justify-center"
                  aria-label="Remove line"
                >
                  <MinusCircle className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Live total */}
        <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
          <span className="text-sm font-semibold text-navy/70">Credit Total</span>
          <span className="text-lg font-bold text-navy tabular-nums">
            {formatCurrency(liveTotal.toFixed(2), vendorCur ?? undefined)}
          </span>
        </div>
        {vendorCur && (
          <div>
            <Label htmlFor="vc-rate">Exchange rate (1 {vendorCur} = ? home)</Label>
            <Input
              id="vc-rate"
              inputMode="decimal"
              placeholder="Blank = Currencies list rate"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
            />
            <p className="text-xs text-navy/40 mt-1">
              This vendor uses {vendorCur}. When the credit is applied to a {vendorCur} bill, any difference between the two
              rates is recorded as an exchange gain or loss.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply to Bill Modal
// ---------------------------------------------------------------------------

interface ApplyModalProps {
  open: boolean;
  credit: VendorCredit | null;
  bills: Bill[];
  onClose: () => void;
  onApplied: () => void;
}

function ApplyModal({ open, credit, bills, onClose, onApplied }: ApplyModalProps) {
  const [billId, setBillId] = useState('');
  const [amount, setAmount] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (open) {
      setBillId('');
      setAmount('');
    }
  }, [open]);

  // Only bills belonging to the same vendor that have a balance.
  const eligibleBills = bills.filter(
    (b) => b.vendorId === credit?.vendorId && parseFloat(b.balanceDue) > 0 && b.status !== 'void',
  );

  const maxAmount = Math.min(
    parseFloat(credit?.unapplied ?? '0'),
    parseFloat(bills.find((b) => b.id === billId)?.balanceDue ?? '0'),
  );

  async function handleApply() {
    if (!credit) return;
    if (!billId) { toast('Please select a bill.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Amount must be greater than zero.', 'danger'); return; }

    setApplying(true);
    try {
      await api.post(`/api/vendor-credits/${credit.id}`, {
        action: 'apply',
        billId,
        amount,
      });
      toast('Credit applied to bill.', 'success');
      onApplied();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to apply credit.';
      toast(msg, 'danger');
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply Vendor Credit to Bill"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button onClick={handleApply} loading={applying}>
            Apply Credit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {credit && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied credit balance: </span>
            <span className="font-bold text-navy tabular-nums">
              {formatCurrency(credit.unapplied)}
            </span>
          </div>
        )}

        <div>
          <Label htmlFor="apply-bill">Bill *</Label>
          <Select id="apply-bill" autoFocus value={billId} onChange={(e) => setBillId(e.target.value)}>
            <option value="">Select a bill…</option>
            {eligibleBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNumber
                  ? `#${b.billNumber} — Balance: ${formatCurrency(b.balanceDue)} — ${formatDate(b.date, 'MMM d, yyyy')}`
                  : `Bill dated ${formatDate(b.date, 'MMM d, yyyy')} — Balance: ${formatCurrency(b.balanceDue)}`}
              </option>
            ))}
          </Select>
          {eligibleBills.length === 0 && (
            <p className="mt-1 text-xs text-navy/40">No open bills found for this vendor.</p>
          )}
        </div>

        <div>
          <Label htmlFor="apply-amount">Amount to Apply *</Label>
          <Input
            id="apply-amount"
            type="number"
            min="0.01"
            step="0.01"
            max={maxAmount > 0 ? maxAmount : undefined}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {billId && maxAmount > 0 && (
            <p className="mt-1 text-xs text-navy/50">
              Max applicable: {formatCurrency(maxAmount.toFixed(2))}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Refund Modal — record a vendor refund (cash back) against the credit
// ---------------------------------------------------------------------------

interface RefundModalProps {
  open: boolean;
  credit: VendorCredit | null;
  accounts: Account[];
  onClose: () => void;
  onRefunded: () => void;
}

function RefundModal({ open, credit, accounts, onClose, onRefunded }: RefundModalProps) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && credit) {
      setBankAccountId('');
      setAmount(Number(credit.unapplied).toFixed(2));
    }
  }, [open, credit]);

  // Accounts a vendor refund can be deposited to: banks, Undeposited Funds and other
  // cash-like current assets (lib/accountTypes.ts, same rule the service enforces).
  const bankAccounts = accounts.filter((a) => isDepositTargetAccount(a));

  async function handleRefund() {
    if (!credit) return;
    if (!bankAccountId) { toast('Select a bank account.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid refund amount.', 'danger'); return; }

    setSaving(true);
    try {
      await api.post(`/api/vendor-credits/${credit.id}`, {
        action: 'refund',
        bankAccountId,
        amount,
      });
      toast('Vendor refund recorded.', 'success');
      onRefunded();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record refund.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Vendor Refund"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleRefund} loading={saving}>
            Record Refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {credit && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied credit available to refund: </span>
            <span className="font-bold text-navy tabular-nums">
              {formatCurrency(credit.unapplied)}
            </span>
          </div>
        )}

        <div>
          <Label htmlFor="vc-refund-bank">Deposit To (Bank Account) *</Label>
          <Select
            id="vc-refund-bank"
            autoFocus
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          >
            <option value="">Select a bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="vc-refund-amt">Refund Amount *</Label>
          <Input
            id="vc-refund-amt"
            type="number"
            min="0.01"
            step="0.01"
            max={credit?.unapplied}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function VendorCreditsPage() {
  const [credits, setCredits] = useState<VendorCredit[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<VendorCredit | null>(null);
  const [refundTarget, setRefundTarget] = useState<VendorCredit | null>(null);
  const [voidTarget, setVoidTarget] = useState<VendorCredit | null>(null);
  const [voiding, setVoiding] = useState(false);

  const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [creditList, vendorList, accountList, billList] = await Promise.all([
        api.get<VendorCredit[]>('/api/vendor-credits'),
        api.get<Vendor[]>('/api/vendors'),
        api.get<Account[]>('/api/accounts'),
        api.get<Bill[]>('/api/bills'),
      ]);
      setCredits(creditList);
      setVendors(vendorList);
      setAccounts(accountList);
      setBills(billList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load vendor credits.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/vendor-credits/${voidTarget.id}`);
      toast('Vendor credit voided.', 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void vendor credit.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  const totalUnapplied = credits
    .filter((c) => c.status !== 'void')
    .reduce((s, c) => s + Number(c.unapplied), 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Vendor Credits"
        icon={RotateCcw}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Vendor Credit
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading vendor credits…
          </div>
        ) : credits.length === 0 ? (
          <EmptyState
            icon={RotateCcw}
            title="No vendor credits yet"
            message="Record a credit from a vendor to apply it against bills or get a refund."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Vendor Credit
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>Memo</Th>
                <Th numeric>Total</Th>
                <Th numeric>Unapplied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {credits.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium text-navy">
                    {vendorMap[c.vendorId] ?? '—'}
                  </Td>
                  <Td className="text-navy/70">{c.date ? formatDate(c.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td className="text-navy/60 text-sm truncate max-w-[200px]">
                    {c.memo ?? '—'}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(c.total)}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(c.unapplied)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      {c.status !== 'void' && c.status !== 'closed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setApplyTarget(c)}
                          title="Apply to bill"
                        >
                          <CheckCircle className="h-3.5 w-3.5" /> Apply
                        </Button>
                      )}
                      {c.status !== 'void' && Number(c.unapplied) > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRefundTarget(c)}
                          title="Record vendor refund (cash back)"
                        >
                          <Banknote className="h-3.5 w-3.5" /> Refund
                        </Button>
                      )}
                      {c.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditId(c.id);
                            setShowNew(true);
                          }}
                          title="Edit credit"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      )}
                      {c.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setVoidTarget(c)}
                          title="Void credit"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Void
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {credits.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {credits.length} credit{credits.length !== 1 ? 's' : ''}
          </span>
          <span>
            Open:{' '}
            <span className="font-semibold text-navy/70">
              {credits.filter((c) => c.status === 'open' || c.status === 'partial').length}
            </span>
          </span>
          <span>
            Total unapplied:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(totalUnapplied.toFixed(2))}
            </span>
          </span>
        </div>
      )}

      <NewCreditModal
        open={showNew}
        onClose={() => {
          setShowNew(false);
          setEditId(null);
        }}
        vendors={vendors}
        accounts={accounts}
        onCreated={fetchData}
        editId={editId}
      />

      <ApplyModal
        open={!!applyTarget}
        credit={applyTarget}
        bills={bills}
        onClose={() => setApplyTarget(null)}
        onApplied={fetchData}
      />

      <RefundModal
        open={!!refundTarget}
        credit={refundTarget}
        accounts={accounts}
        onClose={() => setRefundTarget(null)}
        onRefunded={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void vendor credit?"
        message={`Are you sure you want to void this vendor credit (${formatCurrency(voidTarget?.total ?? '0')})? This will reverse the GL entry and cannot be undone.`}
        confirmLabel="Void Credit"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
