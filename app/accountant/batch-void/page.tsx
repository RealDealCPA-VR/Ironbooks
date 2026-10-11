'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast, toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { BackToCenter, money, monthsAgo, today } from '../_shared';

interface Txn {
  key: string;
  typeLabel: string;
  entryNumber: number | null;
  date: string;
  description: string;
  amount: string;
  status: 'posted' | 'draft';
}
interface VoidResult {
  key: string;
  ok: boolean;
  action: 'void' | 'delete';
  error?: string;
}

const TYPES: Array<[string, string]> = [
  ['', 'All types'],
  ['invoice', 'Invoices'],
  ['sales_receipt', 'Sales receipts'],
  ['credit_memo', 'Credit memos'],
  ['payment', 'Customer payments'],
  ['bill', 'Bills'],
  ['bill_payment', 'Bill payments'],
  ['check', 'Checks / expenses'],
  ['deposit', 'Deposits'],
  ['vendor_credit', 'Bill credits'],
  ['paycheck', 'Paychecks'],
  ['journal', 'Journal entries'],
];

export default function BatchVoidPage() {
  const [from, setFrom] = useState(monthsAgo(1));
  const [to, setTo] = useState(today());
  const [type, setType] = useState('');
  const [rows, setRows] = useState<Txn[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, VoidResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to, ...(type ? { type } : {}) });
      const res = await api.get<{ transactions: Txn[] }>(`/api/accountant/batch-void?${qs}`);
      setRows(res.transactions);
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Could not load transactions.');
    } finally {
      setLoading(false);
    }
  }

  async function run() {
    setSaving(true);
    try {
      const res = await api.post<{ results: VoidResult[]; succeeded: number; failed: number; salesTaxFixesVoided?: number }>('/api/accountant/batch-void', {
        keys: [...selected],
      });
      setResults(new Map(res.results.map((r) => [r.key, r])));
      toast(
        `${res.succeeded} transaction(s) voided${res.failed ? `; ${res.failed} could not be (see the reasons in the list)` : ''}.` +
          (res.salesTaxFixesVoided ? ` ${res.salesTaxFixesVoided} sales tax correction(s) for those payments were undone too.` : ''),
        res.failed ? 'info' : 'success',
      );
      setConfirm(false);
      const qs = new URLSearchParams({ from, to, ...(type ? { type } : {}) });
      const fresh = await api.get<{ transactions: Txn[] }>(`/api/accountant/batch-void?${qs}`);
      // Keep failed rows visible with their reason.
      const failedKeys = new Set(res.results.filter((r) => !r.ok).map((r) => r.key));
      setRows(fresh.transactions);
      setSelected(failedKeys);
    } catch (err) {
      toastError(err, 'Could not void the transactions.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Batch Delete/Void Transactions" icon={Trash2} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Select transactions to void in one step. Voiding keeps the transaction on record with a zero amount, so your history
        stays complete. Transactions that other transactions depend on (for example an invoice with a payment applied) are
        protected — remove the link first. Unposted draft journal entries are deleted.
      </p>
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="bv-from">From</Label>
            <Input id="bv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bv-to">To</Label>
            <Input id="bv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bv-type">Type</Label>
            <Select id="bv-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" loading={loading} onClick={load}>Show transactions</Button>
        </div>
      </Card>
      {rows !== null && (
        <Card className="p-6">
          {rows.length === 0 ? (
            <EmptyState icon={Trash2} title="No transactions" message="Nothing matches these dates and type." />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === rows.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())}
                      />
                    </Th>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th>Entry #</Th>
                    <Th>Description</Th>
                    <Th numeric>Amount</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const res = results.get(r.key);
                    return (
                      <Tr key={r.key}>
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.typeLabel} ${r.entryNumber ?? ''}`}
                            checked={selected.has(r.key)}
                            onChange={() => {
                              const n = new Set(selected);
                              if (n.has(r.key)) n.delete(r.key);
                              else n.add(r.key);
                              setSelected(n);
                            }}
                          />
                        </Td>
                        <Td>{r.date.slice(0, 10)}</Td>
                        <Td>
                          {r.typeLabel} {r.status === 'draft' && <Badge tone="neutral">Draft</Badge>}
                        </Td>
                        <Td>{r.entryNumber ?? ''}</Td>
                        <Td>{r.description}</Td>
                        <Td numeric>{money(r.amount)}</Td>
                        <Td className="text-sm">{res && !res.ok ? <span className="text-red-600">{res.error}</span> : null}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="mt-4 flex justify-end">
                <Button variant="danger" disabled={selected.size === 0} onClick={() => setConfirm(true)}>
                  Void {selected.size || ''} selected
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title="Void the selected transactions?"
        message={`${selected.size} transaction(s) will be voided (drafts deleted). Each one is recorded in the audit trail and on the Voided/Deleted Transactions report.`}
        confirmLabel="Void"
        loading={saving}
        onConfirm={run}
        onClose={() => setConfirm(false)}
      />
    </main>
  );
}
