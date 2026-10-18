'use client';
/**
 * Statement Charges (wave2 sales C5) — charges entered straight into a customer's register.
 * They show on the customer's statement and in A/R aging, and are paid through Receive
 * Payments like an invoice — but no separate invoice form is sent.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ScrollText, Pencil, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useCreditLimitConfirm } from '@/components/sales/SalesExtras';

interface Customer {
  id: string;
  displayName: string;
}
interface Item {
  id: string;
  name: string;
  type: string;
  salesPrice: string | null;
  description?: string | null;
}
interface Charge {
  id: string;
  customerId: string;
  customerName: string;
  invoiceNumber: number;
  date: string;
  dueDate: string | null;
  status: string;
  total: string;
  balanceDue: string;
  memo: string | null;
  line: { itemId: string | null; itemName: string | null; description: string | null; quantity: string; rate: string } | null;
}

const today = () => todayISO();

export default function StatementChargesPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [charges, setCharges] = useState<Charge[]>([]);
  const [editing, setEditing] = useState<Charge | null>(null);
  const [date, setDate] = useState(today());
  const [itemId, setItemId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [rate, setRate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Charge | null>(null);
  const creditLimit = useCreditLimitConfirm();

  useEffect(() => {
    api.get<Customer[]>('/api/customers').then((c) => setCustomers(Array.isArray(c) ? c : [])).catch(() => {});
    api.get<{ items: Item[] }>('/api/items').then((r) => setItems((r.items ?? []).filter((i) => !['discount', 'subtotal', 'payment', 'sales_tax'].includes(i.type)))).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ charges: Charge[] }>(
        `/api/invoices/statement-charges${customerId ? `?customerId=${customerId}` : ''}`,
      );
      setCharges(r.charges ?? []);
    } catch (err) {
      toastError(err, 'Could not load statement charges.');
    }
  }, [customerId]);
  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditing(null);
    setDate(today());
    setItemId('');
    setDescription('');
    setQuantity('1');
    setRate('');
    setDueDate('');
  }

  function startEdit(c: Charge) {
    setEditing(c);
    setCustomerId(c.customerId);
    setDate(c.date.slice(0, 10));
    setDueDate(c.dueDate ? c.dueDate.slice(0, 10) : '');
    setItemId(c.line?.itemId ?? '');
    setDescription(c.line?.description ?? c.memo ?? '');
    setQuantity(String(Number(c.line?.quantity ?? 1)));
    setRate(String(Number(c.line?.rate ?? c.total)));
  }

  function pickItem(id: string) {
    setItemId(id);
    const it = items.find((i) => i.id === id);
    if (it) {
      if (!description) setDescription(it.description || it.name);
      if (!rate && it.salesPrice) setRate(String(Number(it.salesPrice)));
    }
  }

  async function save() {
    if (!customerId) return toast('Pick a customer.', 'danger');
    if (!rate || Number(rate) <= 0) return toast('Enter the charge amount.', 'danger');
    if (!Number(quantity) || Number(quantity) <= 0) return toast('Quantity must be more than zero.', 'danger');
    const body = {
      customerId,
      date,
      dueDate: dueDate || null,
      itemId: itemId || null,
      description: description.trim() || null,
      quantity,
      rate,
    };
    setSaving(true);
    try {
      const done = await creditLimit.run((override) =>
        editing
          ? api.put(`/api/invoices/statement-charges/${editing.id}`, { ...body, overrideCreditLimit: override })
          : api.post('/api/invoices/statement-charges', { ...body, overrideCreditLimit: override }),
      );
      if (done === undefined) return;
      toast(editing ? 'Statement charge updated.' : 'Statement charge added.', 'success');
      resetForm();
      await load();
    } catch (err) {
      toastError(err, 'Could not save the statement charge.');
    } finally {
      setSaving(false);
    }
  }

  async function doVoid() {
    if (!voidTarget) return;
    try {
      await api.del(`/api/invoices/${voidTarget.id}`);
      toast('Statement charge voided.', 'success');
      setVoidTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not void the charge.');
    }
  }

  const amount = (Number(quantity) || 0) * (Number(rate) || 0);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Statement Charges"
        icon={ScrollText}
        action={<Link href="/invoices" className="text-sm font-semibold text-electric hover:underline">Back to invoices</Link>}
      />
      <Card className="p-4 mb-4 space-y-3">
        <p className="text-sm text-navy/60">
          A statement charge <Help term="statement-charge" /> adds an amount to what a customer owes <Help term="ar" /> without sending an
          invoice. It appears on their next statement and can be paid in Receive Payments.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
          <div className="sm:col-span-2">
            <Label htmlFor="sc-cust" required>Customer</Label>
            <Select id="sc-cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={!!editing}>
              <option value="">All customers (pick one to add)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sc-date" required>Date</Label>
            <DateInput id="sc-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="sc-due">Due</Label>
            <DateInput id="sc-due" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="sc-item">Item</Label>
            <Select id="sc-item" value={itemId} onChange={(e) => pickItem(e.target.value)}>
              <option value="">No item (Sales Income)</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="sc-desc">Description</Label>
            <Input id="sc-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Monthly service" />
          </div>
          <div>
            <Label htmlFor="sc-qty">Qty</Label>
            <Input id="sc-qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="sc-rate" required>Rate</Label>
            <AmountInput id="sc-rate" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.00" />
          </div>
          <div className="flex items-end">
            <span className="text-sm text-navy/70">Amount <strong>{formatCurrency(amount.toFixed(2))}</strong></span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {editing && <Button variant="secondary" onClick={resetForm}>Cancel edit</Button>}
          <Button loading={saving} onClick={save}>{editing ? 'Save changes' : 'Add charge'}</Button>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {charges.length === 0 ? (
          <EmptyState icon={ScrollText} title="No statement charges" message="Charges you enter here show up on customer statements." />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>No.</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th>Due</Th>
                <Th>Description</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Balance</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <Tr key={c.id}>
                  <Td>#{c.invoiceNumber}</Td>
                  <Td>{c.customerName}</Td>
                  <Td>{formatDate(c.date)}</Td>
                  <Td>{formatDate(c.dueDate)}</Td>
                  <Td className="text-navy/70">{c.line?.description ?? c.line?.itemName ?? '—'}</Td>
                  <Td numeric>{formatCurrency(c.total)}</Td>
                  <Td numeric className="font-semibold">{formatCurrency(c.balanceDue)}</Td>
                  <Td><Badge tone={c.status as never}>{c.status}</Badge></Td>
                  <Td className="text-right">
                    {c.status !== 'void' && (
                      <>
                        <Button variant="ghost" size="sm" title="Edit" aria-label="Edit charge" onClick={() => startEdit(c)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {Number(c.balanceDue) === Number(c.total) && (
                          <Button variant="ghost" size="sm" className="text-red-500" title="Void" aria-label="Void charge" onClick={() => setVoidTarget(c)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={!!voidTarget}
        title="Void statement charge"
        message="This removes the charge from the customer's balance and reverses its posting. It cannot be undone."
        confirmLabel="Void charge"
        tone="danger"
        onConfirm={doVoid}
        onClose={() => setVoidTarget(null)}
      />
      {creditLimit.dialog}
    </main>
  );
}
