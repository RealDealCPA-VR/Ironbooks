'use client';

import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftRight, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
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
  Badge,
  ConfirmDialog,
  PageHeader,
  toast, toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface Transfer {
  id: string;
  date: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  memo: string | null;
  postedEntryId: string | null;
  voidedAt?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// New Transfer Modal
// ---------------------------------------------------------------------------

interface NewTransferModalProps {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  onCreated: () => void;
  /** When set, the modal edits this saved transfer (PATCH) instead of creating one. */
  editing?: Transfer | null;
}

function NewTransferModal({ open, onClose, accounts, onCreated, editing }: NewTransferModalProps) {
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens.
  useEffect(() => {
    if (open) {
      setFromAccountId(editing?.fromAccountId ?? '');
      setToAccountId(editing?.toAccountId ?? '');
      setAmount(editing?.amount ?? '');
      setDate(editing ? editing.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
      setMemo(editing?.memo ?? '');
    }
  }, [open, editing]);

  async function handleSubmit() {
    if (!fromAccountId) { toast('Please select a From account.', 'danger'); return; }
    if (!toAccountId) { toast('Please select a To account.', 'danger'); return; }
    if (fromAccountId === toAccountId) { toast('From and To accounts must be different.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Amount must be greater than zero.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }

    setSaving(true);
    try {
      const body = { fromAccountId, toAccountId, amount, date, memo: memo || null };
      if (editing) {
        await api.patch(`/api/transfers/${editing.id}`, body);
        toast('Transfer updated.', 'success');
      } else {
        await api.post('/api/transfers', body);
        toast('Transfer recorded.', 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to create transfer.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Transfer' : 'New Transfer'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Record Transfer'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Date */}
        <div>
          <Label htmlFor="tr-date" required>Date</Label>
          <Input
            id="tr-date"
            type="date"
            autoFocus
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {/* From / To accounts */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="tr-from" required>From Account</Label>
            <Select
              id="tr-from"
              value={fromAccountId}
              onChange={(e) => setFromAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tr-to" required>To Account</Label>
            <Select
              id="tr-to"
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {/* Amount */}
        <div>
          <Label htmlFor="tr-amount" required>Amount</Label>
          <Input
            id="tr-amount"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="tr-memo">Memo</Label>
          <Input
            id="tr-memo"
            placeholder="Optional note…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Transfer | null>(null);
  const [pendingVoid, setPendingVoid] = useState<Transfer | null>(null);
  const [voiding, setVoiding] = useState(false);

  async function handleVoid(tr: Transfer) {
    setVoiding(true);
    try {
      await api.del(`/api/transfers/${tr.id}`);
      toast('Transfer voided.', 'success');
      setPendingVoid(null);
      await fetchData();
    } catch (err: unknown) {
      toastError(err, 'Failed to void transfer.');
    } finally {
      setVoiding(false);
    }
  }

  // Build id -> display name map for rendering.
  const accountMap = Object.fromEntries(
    accounts.map((a) => [a.id, `${a.code} — ${a.name}`]),
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [trList, acctList] = await Promise.all([
        api.get<Transfer[]>('/api/transfers'),
        api.get<Account[]>('/api/accounts'),
      ]);
      setTransfers(trList);
      setAccounts(acctList);
    } catch (err: unknown) {
      toastError(err, 'Failed to load transfers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Transfers"
        icon={ArrowLeftRight}
        action={
          <Button onClick={() => { setEditing(null); setShowNew(true); }}>
            <Plus className="h-4 w-4" /> New Transfer
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="py-20 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : transfers.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No transfers yet"
            message="Moved money between your own accounts (for example, checking to savings)? Record it here. It is not income or an expense."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Transfer
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Date</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th numeric>Amount</Th>
                <Th>Memo</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {transfers.map((tr) => (
                <Tr key={tr.id}>
                  <Td className="text-navy/70">{formatDate(tr.date)}</Td>
                  <Td className="text-navy/80">
                    {accountMap[tr.fromAccountId] ?? tr.fromAccountId}
                  </Td>
                  <Td className="text-navy/80">
                    {accountMap[tr.toAccountId] ?? tr.toAccountId}
                  </Td>
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(tr.amount)}
                  </Td>
                  <Td className="text-navy/50 text-sm">{tr.memo ?? '—'}</Td>
                  <Td className="text-right whitespace-nowrap">
                    {tr.voidedAt ? (
                      <Badge tone="danger">Void</Badge>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditing(tr); setShowNew(true); }}
                        >
                          <Pencil className="h-4 w-4" /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setPendingVoid(tr)}
                        >
                          <Trash2 className="h-4 w-4" /> Void
                        </Button>
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {transfers.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {transfers.length} transfer{transfers.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total moved:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                transfers
                  .filter((t) => !t.voidedAt)
                  .reduce((s, t) => s + Number(t.amount), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <NewTransferModal
        open={showNew}
        onClose={() => { setShowNew(false); setEditing(null); }}
        accounts={accounts}
        onCreated={fetchData}
        editing={editing}
      />

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void transfer?"
        message={`Void this ${formatCurrency(pendingVoid?.amount ?? '0')} transfer? Both account balances go back to how they were before it.`}
        confirmLabel="Void"
        tone="danger"
        loading={voiding}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}
