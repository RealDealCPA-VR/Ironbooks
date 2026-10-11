'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Banknote, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
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
  toast, toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bill {
  id: string;
  vendorId: string;
  billNumber: string | null;
  date: string;
  dueDate: string | null;
  total: string;
  amountPaid: string;
  amountCredited: string;
  balanceDue: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  memo: string | null;
}

interface BillDetailLine {
  id: string;
  accountId: string;
  itemId: string | null;
  description: string | null;
  quantity: string;
  amount: string;
}

/** A bill can be edited while nothing has been applied against it. */
function isEditable(bill: Bill): boolean {
  return (
    bill.status !== 'void' &&
    Number(bill.amountPaid) === 0 &&
    Number(bill.amountCredited) === 0
  );
}

interface Vendor {
  id: string;
  displayName: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface Item {
  id: string;
  name: string;
  type: 'service' | 'inventory' | 'non_inventory' | 'bundle';
  purchaseCost: string | null;
  quantityOnHand: string | null;
}

type LineMode = 'expense' | 'item';

interface LineRow {
  mode: LineMode;
  // Expense-mode fields
  accountId: string;
  amount: string;
  // Item-mode fields (QB "Items tab")
  itemId: string;
  quantity: string;
  unitCost: string;
  // Shared
  description: string;
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function statusTone(status: Bill['status']): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  switch (status) {
    case 'paid':
      return 'success';
    case 'partial':
      return 'warning';
    case 'void':
      return 'danger';
    default:
      return 'info';
  }
}

function statusLabel(status: Bill['status']): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'partial':
      return 'Partial';
    case 'paid':
      return 'Paid';
    case 'void':
      return 'Void';
  }
}

// ---------------------------------------------------------------------------
// Empty line factory
// ---------------------------------------------------------------------------

function emptyLine(mode: LineMode = 'expense'): LineRow {
  return { mode, accountId: '', amount: '', itemId: '', quantity: '', unitCost: '', description: '' };
}

/** Display amount for a line: explicit amount (expense) or qty x cost (item). */
function lineAmount(line: LineRow): number {
  if (line.mode === 'item') {
    return (Number(line.quantity) || 0) * (Number(line.unitCost) || 0);
  }
  return Number(line.amount) || 0;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function BillsPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state — editingId set means the modal is editing an existing bill.
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);

  // Form fields
  const [vendorId, setVendorId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);

  // Void confirm
  const [pendingVoid, setPendingVoid] = useState<Bill | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchBills = useCallback(async () => {
    try {
      const data = await api.get<Bill[]>('/api/bills');
      setBills(data);
    } catch (err) {
      toastError(err, 'Failed to load bills');
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [billData, vendorData, accountData, itemData] = await Promise.all([
          api.get<Bill[]>('/api/bills'),
          api.get<Vendor[]>('/api/vendors'),
          api.get<Account[]>('/api/accounts'),
          api.get<{ items: Item[] }>('/api/items'),
        ]);
        setBills(billData);
        setVendors(vendorData);
        setAccounts(accountData);
        setItems(itemData.items ?? []);
      } catch (err) {
        toastError(err, 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // ---------------------------------------------------------------------------
  // ID -> Name lookup helpers
  // ---------------------------------------------------------------------------

  function vendorName(id: string): string {
    return vendors.find((v) => v.id === id)?.displayName ?? '—';
  }

  // ---------------------------------------------------------------------------
  // Modal helpers
  // ---------------------------------------------------------------------------

  function openModal() {
    setEditingId(null);
    setVendorId('');
    setBillNumber('');
    setDate(new Date().toISOString().slice(0, 10));
    setDueDate('');
    setLines([emptyLine()]);
    setModalOpen(true);
  }

  /** Prefill the form from a saved bill and open the modal in edit mode. */
  async function openEditModal(bill: Bill) {
    setLoadingEditId(bill.id);
    try {
      const detail = await api.get<Bill & { lines: BillDetailLine[] }>(`/api/bills/${bill.id}`);
      setEditingId(bill.id);
      setVendorId(detail.vendorId);
      setBillNumber(detail.billNumber ?? '');
      setDate(detail.date.slice(0, 10));
      setDueDate(detail.dueDate ? detail.dueDate.slice(0, 10) : '');
      setLines(
        detail.lines.length === 0
          ? [emptyLine()]
          : detail.lines.map((l) => {
              if (l.itemId) {
                const qty = Number(l.quantity) || 1;
                const unitCost = Number(l.amount) / qty;
                return {
                  mode: 'item' as LineMode,
                  accountId: '',
                  amount: '',
                  itemId: l.itemId,
                  quantity: String(qty),
                  unitCost: String(parseFloat(unitCost.toFixed(4))),
                  description: l.description ?? '',
                };
              }
              return {
                mode: 'expense' as LineMode,
                accountId: l.accountId,
                amount: l.amount,
                itemId: '',
                quantity: '',
                unitCost: '',
                description: l.description ?? '',
              };
            }),
      );
      setModalOpen(true);
    } catch (err) {
      toastError(err, 'Failed to load bill.');
    } finally {
      setLoadingEditId(null);
    }
  }

  function closeModal() {
    if (!submitting) setModalOpen(false);
  }

  // Line row mutations
  function updateLine(index: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /** Item picked on an item-mode line: default the cost from the item's purchase cost. */
  function pickItem(index: number, itemId: string) {
    const item = items.find((it) => it.id === itemId);
    setLines((prev) =>
      prev.map((row, i) =>
        i === index
          ? {
              ...row,
              itemId,
              unitCost: row.unitCost || (item?.purchaseCost ?? ''),
              quantity: row.quantity || '1',
            }
          : row,
      ),
    );
  }

  function addLine(mode: LineMode = 'expense') {
    setLines((prev) => [...prev, emptyLine(mode)]);
  }

  function removeLine(index: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert adds a line (same mode as the
  // last line), Ctrl+Delete removes the focused row, Enter moves down.
  const grid = useGridKeys({
    addRow: () => setLines((prev) => [...prev, emptyLine(prev[prev.length - 1]?.mode ?? 'expense')]),
    removeRow: removeLine,
    disabled: submitting,
  });

  // Compute running total for display (Number() only — display only, not stored)
  const runningTotal = lines.reduce((sum, l) => sum + lineAmount(l), 0);

  // ---------------------------------------------------------------------------
  // Submit new bill
  // ---------------------------------------------------------------------------

  async function handleSubmit() {
    if (!vendorId) {
      toast('Please select a vendor.', 'danger');
      return;
    }
    if (!date) {
      toast('Bill date is required.', 'danger');
      return;
    }
    for (const [i, line] of lines.entries()) {
      if (line.mode === 'item') {
        if (!line.itemId) {
          toast(`Line ${i + 1}: select an item.`, 'danger');
          return;
        }
        if (!line.quantity || Number(line.quantity) <= 0) {
          toast(`Line ${i + 1}: quantity must be greater than zero.`, 'danger');
          return;
        }
        if (!line.unitCost || Number(line.unitCost) <= 0) {
          toast(`Line ${i + 1}: cost must be greater than zero.`, 'danger');
          return;
        }
      } else {
        if (!line.accountId) {
          toast(`Line ${i + 1}: select an account.`, 'danger');
          return;
        }
        if (!line.amount || Number(line.amount) <= 0) {
          toast(`Line ${i + 1}: amount must be greater than zero.`, 'danger');
          return;
        }
      }
    }

    setSubmitting(true);
    try {
      const payload = {
        vendorId,
        billNumber: billNumber.trim() || undefined,
        date,
        dueDate: dueDate || undefined,
        lines: lines.map((l) =>
          l.mode === 'item'
            ? {
                itemId: l.itemId,
                quantity: l.quantity,
                unitCost: l.unitCost,
                description: l.description.trim() || undefined,
              }
            : {
                accountId: l.accountId,
                description: l.description.trim() || undefined,
                amount: l.amount,
              },
        ),
      };
      if (editingId) {
        await api.patch(`/api/bills/${editingId}`, payload);
        toast('Bill updated.', 'success');
      } else {
        await api.post('/api/bills', payload);
        toast('Bill created.', 'success');
      }
      setModalOpen(false);
      await fetchBills();
    } catch (err) {
      toastError(err, editingId ? 'Failed to update bill.' : 'Failed to create bill.');
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Void bill
  // ---------------------------------------------------------------------------

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/bills/${id}`);
      toast('Bill voided.', 'success');
      setPendingVoid(null);
      await fetchBills();
    } catch (err) {
      toastError(err, 'Failed to void bill.');
    } finally {
      setVoidingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Bills"
        icon={Receipt}
        action={
          <span className="flex items-center gap-2">
            <Link href="/pay-bills">
              <Button variant="secondary">
                <Banknote className="h-4 w-4" />
                Pay Bills
              </Button>
            </Link>
            <Button onClick={openModal}>
              <Plus className="h-4 w-4" />
              New Bill
            </Button>
          </span>
        }
      />

      <p className="-mt-4 mb-4 text-sm text-navy/60">
        A bill is money you owe a vendor. Until you pay it, it sits in Accounts Payable{' '}
        <Help term="ap" side="bottom" />. Pay it from{' '}
        <Link href="/pay-bills" className="text-electric underline">Pay Bills</Link>.
      </p>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading bills…
          </div>
        ) : bills.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No bills yet"
            message="Got a bill you will pay later? Enter it here so you know what you owe (Accounts Payable). When you pay it, use Pay Bills."
            action={
              <Button onClick={openModal}>
                <Plus className="h-4 w-4" /> New Bill
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Bill #</Th>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>Due Date</Th>
                <Th numeric>Total</Th>
                <Th numeric>Balance Due</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => (
                <Tr key={bill.id}>
                  <Td className="font-mono text-sm">{bill.billNumber ?? <span className="text-navy/30 italic">—</span>}</Td>
                  <Td className="font-medium">{vendorName(bill.vendorId)}</Td>
                  <Td>{bill.date ? formatDate(bill.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td>{bill.dueDate ? formatDate(bill.dueDate, 'MMM d, yyyy') : <span className="text-navy/30">—</span>}</Td>
                  <Td numeric>{formatCurrency(bill.total)}</Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(bill.balanceDue)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(bill.status)}>{statusLabel(bill.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    {isEditable(bill) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={loadingEditId === bill.id}
                        loading={loadingEditId === bill.id}
                        onClick={() => openEditModal(bill)}
                        title="Edit this bill (re-posts the GL entry)"
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    )}
                    {bill.status !== 'void' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === bill.id}
                        onClick={() => setPendingVoid(bill)}
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

      {/* New / Edit Bill Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingId ? 'Edit Bill' : 'New Bill'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={submitting}>
              {editingId ? 'Save Changes' : 'Save Bill'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editingId && (
            <p className="text-xs text-navy/50 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              Saving re-posts the bill&apos;s journal entry on the new date and re-receives any
              inventory item lines. Editing is only possible while no payments or credits are applied.
            </p>
          )}
          {/* Vendor */}
          <div>
            <Label htmlFor="bill-vendor" required>Vendor <Help term="ap" /></Label>
            <Select
              id="bill-vendor"
              autoFocus
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
            >
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          </div>

          {/* Bill Number + Date row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bill-number">Bill # (optional)</Label>
              <Input
                id="bill-number"
                placeholder="e.g. INV-1001"
                value={billNumber}
                onChange={(e) => setBillNumber(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="bill-date" required>Bill Date</Label>
              <DateInput
                id="bill-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          {/* Due Date */}
          <div>
            <Label htmlFor="bill-due">Due Date (optional)</Label>
            <DateInput
              id="bill-due"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="mb-0" required>Line Items</Label>
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => addLine('expense')}
                  className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" /> Expense Line
                </button>
                <button
                  type="button"
                  onClick={() => addLine('item')}
                  className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" /> Item Line
                </button>
              </span>
            </div>

            <div className="space-y-2" onKeyDown={grid.onKeyDown}>
              {lines.map((line, idx) => (
                <div key={idx} data-grid-row className="flex gap-2 items-start">
                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
                    {(['expense', 'item'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => updateLine(idx, { mode: m })}
                        className={`px-2 py-2 text-[10px] font-semibold uppercase transition-colors ${
                          line.mode === m
                            ? 'bg-electric text-white'
                            : 'bg-white text-navy/50 hover:bg-slate-50'
                        }`}
                        title={m === 'expense' ? 'Expense (account) line' : 'Item line'}
                      >
                        {m === 'expense' ? 'Acct' : 'Item'}
                      </button>
                    ))}
                  </div>

                  {line.mode === 'item' ? (
                    <>
                      {/* Item */}
                      <div className="flex-1 min-w-0">
                        <Select
                          value={line.itemId}
                          onChange={(e) => pickItem(idx, e.target.value)}
                        >
                          <option value="">Item…</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.name}
                              {it.type === 'inventory'
                                ? ` (${Number(it.quantityOnHand ?? 0)} on hand)`
                                : ''}
                            </option>
                          ))}
                        </Select>
                      </div>

                      {/* Qty */}
                      <div className="w-16 shrink-0">
                        <AmountInput
                          placeholder="Qty"
                          value={line.quantity}
                          onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        />
                      </div>

                      {/* Unit cost */}
                      <div className="w-24 shrink-0">
                        <AmountInput
                          placeholder="Cost"
                          value={line.unitCost}
                          onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                        />
                      </div>

                      {/* Computed amount */}
                      <div className="w-20 shrink-0 pt-2 text-right text-xs font-semibold text-navy/70 tabular-nums">
                        {formatCurrency(lineAmount(line).toFixed(2))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Account */}
                      <div className="flex-1 min-w-0">
                        <Select
                          value={line.accountId}
                          onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                        >
                          <option value="">Account…</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} – {a.name}
                            </option>
                          ))}
                        </Select>
                      </div>

                      {/* Description */}
                      <div className="flex-1 min-w-0">
                        <Input
                          placeholder="Description"
                          value={line.description}
                          onChange={(e) => updateLine(idx, { description: e.target.value })}
                        />
                      </div>

                      {/* Amount */}
                      <div className="w-24 shrink-0">
                        <AmountInput
                          placeholder="0.00"
                          value={line.amount}
                          onChange={(e) => updateLine(idx, { amount: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="mt-1 text-red-400 hover:text-red-600 disabled:opacity-20 disabled:pointer-events-none"
                    title="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            {/* Running total */}
            <div className="mt-3 flex justify-end">
              <span className="text-sm text-navy/50 mr-2">Total:</span>
              <span className="text-sm font-bold text-navy tabular-nums">
                {formatCurrency(runningTotal.toFixed(2))}
              </span>
            </div>
          </div>
        </div>
      </Modal>

      {/* Void confirm */}
      <ConfirmDialog
        open={!!pendingVoid}
        title="Void bill?"
        message={`Void bill ${pendingVoid?.billNumber ? `#${pendingVoid.billNumber}` : `for ${pendingVoid ? vendorName(pendingVoid.vendorId) : ''}`} (${formatCurrency(pendingVoid?.total ?? '0')})? This reverses the posted entry and cannot be undone.`}
        confirmLabel="Void"
        tone="danger"
        loading={!!voidingId}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid.id)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}
