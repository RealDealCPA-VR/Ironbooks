'use client';
/**
 * Print / Send Forms (wave2 sales C7) — QB's "Print Forms" and "Send Forms" queues: every sales
 * form marked "To be printed" or "To be emailed", sent or printed in one batch. Also emails a
 * customer statement on demand.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Send } from 'lucide-react';
import {
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
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';

type Kind = 'invoice' | 'estimate' | 'sales_receipt' | 'credit_memo' | 'sales_order';
interface QueueItem {
  kind: Kind;
  id: string;
  number: string;
  date: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  total: string;
}
interface Customer {
  id: string;
  displayName: string;
  email?: string | null;
}

const LABEL: Record<Kind, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  sales_order: 'Sales Order',
};

export default function SendFormsPage() {
  const [mode, setMode] = useState<'print' | 'email'>('email');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmPrinted, setConfirmPrinted] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(true);
  // Statement emailing
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stmtCustomer, setStmtCustomer] = useState('');
  const [stmtFrom, setStmtFrom] = useState('');
  const [stmtTo, setStmtTo] = useState(todayISO());
  const [stmtEmail, setStmtEmail] = useState('');

  const key = (i: QueueItem) => `${i.kind}:${i.id}`;
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: QueueItem[] }>(`/api/sales-forms/queue?mode=${mode}`);
      setItems(r.items ?? []);
      setPicked(new Set((r.items ?? []).map(key)));
    } catch (err) {
      toastError(err, 'Could not load the queue.');
    }
  }, [mode]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.get<{ configured: boolean }>('/api/email/status').then((r) => setEmailConfigured(!!r.configured)).catch(() => {});
    api.get<Customer[]>('/api/customers').then((c) => setCustomers(Array.isArray(c) ? c : [])).catch(() => {});
  }, []);

  const chosen = items.filter((i) => picked.has(key(i)));

  async function sendEmails() {
    if (chosen.length === 0) return toast('Select at least one form.', 'danger');
    setBusy(true);
    try {
      const r = await api.post<{ sent: unknown[]; failed: Array<{ error: string }> }>('/api/sales-forms/queue', {
        action: 'send_emails',
        items: chosen.map((i) => ({ kind: i.kind, id: i.id })),
      });
      if (r.sent.length) toast(`${r.sent.length} form${r.sent.length === 1 ? '' : 's'} emailed.`, 'success');
      if (r.failed.length) toast(`${r.failed.length} not sent: ${r.failed[0].error}`, 'danger');
      await load();
    } catch (err) {
      toastError(err, 'Could not send the emails.');
    } finally {
      setBusy(false);
    }
  }

  function printSelected() {
    if (chosen.length === 0) return toast('Select at least one form.', 'danger');
    for (const i of chosen) window.open(`/api/sales-forms/${i.kind}/${i.id}/pdf`, '_blank', 'noopener');
    setConfirmPrinted(true);
  }

  async function markPrinted() {
    setBusy(true);
    try {
      await api.post('/api/sales-forms/queue', {
        action: 'mark_printed',
        items: chosen.map((i) => ({ kind: i.kind, id: i.id })),
      });
      toast('Marked as printed.', 'success');
      setConfirmPrinted(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not update the queue.');
    } finally {
      setBusy(false);
    }
  }

  async function emailStatement() {
    if (!stmtCustomer) return toast('Pick a customer.', 'danger');
    setBusy(true);
    try {
      const r = await api.post<{ to: string }>('/api/sales-forms/statement-email', {
        customerId: stmtCustomer,
        from: stmtFrom || null,
        to: stmtTo || null,
        email: stmtEmail || null,
      });
      toast(`Statement emailed to ${r.to}.`, 'success');
    } catch (err) {
      toastError(err, 'Could not email the statement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Print & Send Forms"
        icon={Send}
        action={<Link href="/invoices" className="text-sm font-semibold text-electric hover:underline">Back to invoices</Link>}
      />
      {!emailConfigured && mode === 'email' && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          Email is not set up yet, so forms can&apos;t be sent. You can still print them.
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant={mode === 'email' ? 'primary' : 'secondary'} onClick={() => setMode('email')}>
          To be emailed
        </Button>
        <Button variant={mode === 'print' ? 'primary' : 'secondary'} onClick={() => setMode('print')}>
          To be printed
        </Button>
        <span className="ml-auto text-sm text-navy/50">{chosen.length} selected</span>
        {mode === 'email' ? (
          <Button loading={busy} disabled={!emailConfigured || chosen.length === 0} onClick={sendEmails}>
            Send selected
          </Button>
        ) : (
          <Button loading={busy} disabled={chosen.length === 0} onClick={printSelected}>
            Print selected
          </Button>
        )}
      </div>
      <Card className="p-0 overflow-hidden mb-6">
        {items.length === 0 ? (
          <EmptyState
            icon={Send}
            title="Nothing waiting"
            message={`Tick "To be ${mode === 'email' ? 'emailed' : 'printed'}" on a sales form and it will wait here.`}
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={items.every((i) => picked.has(key(i)))}
                    onChange={(e) => setPicked(e.target.checked ? new Set(items.map(key)) : new Set())}
                  />
                </Th>
                <Th>Form</Th>
                <Th>No.</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                {mode === 'email' && <Th>Email</Th>}
                <Th numeric>Total</Th>
              </Tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <Tr key={key(i)}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${LABEL[i.kind]} ${i.number}`}
                      checked={picked.has(key(i))}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(key(i));
                          else n.delete(key(i));
                          return n;
                        })
                      }
                    />
                  </Td>
                  <Td><Badge tone="neutral">{LABEL[i.kind]}</Badge></Td>
                  <Td>#{i.number}</Td>
                  <Td>{formatDate(i.date)}</Td>
                  <Td>{i.customerName}</Td>
                  {mode === 'email' && (
                    <Td className={i.customerEmail ? 'text-navy/70' : 'text-red-500'}>
                      {i.customerEmail ?? 'No email on file'}
                    </Td>
                  )}
                  <Td numeric>{formatCurrency(i.total)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="font-bold text-navy">Email a customer statement</h2>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <div className="sm:col-span-2">
            <Label htmlFor="st-cust">Customer</Label>
            <Select id="st-cust" value={stmtCustomer} onChange={(e) => setStmtCustomer(e.target.value)}>
              <option value="">Select a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="st-from">From</Label>
            <DateInput id="st-from" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="st-to">To</Label>
            <DateInput id="st-to" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="st-email">Send to</Label>
            <Input id="st-email" type="email" placeholder="Customer's email" value={stmtEmail} onChange={(e) => setStmtEmail(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!stmtCustomer}
            onClick={() =>
              window.open(
                `/api/reports/customer-statement/pdf?customerId=${stmtCustomer}${stmtFrom ? `&from=${stmtFrom}` : ''}${stmtTo ? `&to=${stmtTo}` : ''}`,
                '_blank',
                'noopener',
              )
            }
          >
            Preview PDF
          </Button>
          <Button loading={busy} disabled={!emailConfigured || !stmtCustomer} onClick={emailStatement}>
            Email statement
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmPrinted}
        title="Did everything print?"
        message="If the forms printed correctly, mark them as printed so they leave this list."
        confirmLabel="Mark as printed"
        loading={busy}
        onConfirm={markPrinted}
        onClose={() => setConfirmPrinted(false)}
      />
    </main>
  );
}
