'use client';

import { useEffect, useState } from 'react';
import { FileX } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { type AccountOpt, BackToCenter, accountLabel, money, today, useList } from '../_shared';

interface Candidate {
  invoiceId: string;
  invoiceNumber: number;
  customerName: string;
  date: string;
  dueDate: string | null;
  balanceDue: string;
  daysPastDue: number;
  foreignCurrency: boolean;
}

export default function WriteOffPage() {
  const accounts = useList<AccountOpt>('/api/accounts');
  const expenseAccounts = accounts.filter((a) => a.type === 'expense' && a.isActive !== false);
  const [minDays, setMinDays] = useState('90');
  const [maxBalance, setMaxBalance] = useState('');
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(today());
  const [badDebt, setBadDebt] = useState('');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!badDebt) {
      const guess = expenseAccounts.find((a) => /bad debt/i.test(a.name));
      if (guess) setBadDebt(guess.id);
    }
  }, [expenseAccounts, badDebt]);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ minDaysPastDue: minDays || '0', ...(maxBalance ? { maxBalance } : {}) });
      const res = await api.get<{ invoices: Candidate[] }>(`/api/accountant/write-off?${qs}`);
      setRows(res.invoices);
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Could not load open invoices.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = (rows ?? []).filter((r) => selected.has(r.invoiceId));
  const total = chosen.reduce((s, r) => s + Math.round(Number(r.balanceDue) * 100), 0) / 100;

  async function writeOff() {
    setSaving(true);
    try {
      const res = await api.post<{ total: string; results: unknown[] }>('/api/accountant/write-off', {
        invoiceIds: [...selected],
        date,
        badDebtAccountId: badDebt,
        memo: memo || null,
      });
      toast(`Wrote off ${res.results.length} invoice(s) totalling ${money(res.total)}.`, 'success');
      setConfirm(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not write off the invoices.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Write Off Invoices" icon={FileX} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        When a customer will never pay, write the open balance <Help term="ar" /> off to a bad debt expense account. Each
        write-off is recorded as a credit memo applied to the invoice, so the customer balance, A/R and your reports all agree.
      </p>
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="wo-days">At least this many days past due</Label>
            <Input id="wo-days" type="number" min={0} value={minDays} onChange={(e) => setMinDays(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="wo-max">Balance no more than (optional)</Label>
            <Input id="wo-max" inputMode="decimal" value={maxBalance} onChange={(e) => setMaxBalance(e.target.value)} placeholder="e.g. 50.00" />
          </div>
          <Button variant="secondary" onClick={load} loading={loading}>Find invoices</Button>
        </div>
      </Card>

      {rows !== null && (
        <Card className="p-6">
          {rows.length === 0 ? (
            <EmptyState icon={FileX} title="Nothing to write off" message="No open invoices match these filters." />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === rows.filter((r) => !r.foreignCurrency).length && selected.size > 0}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(rows.filter((r) => !r.foreignCurrency).map((r) => r.invoiceId)) : new Set())
                        }
                      />
                    </Th>
                    <Th>Invoice</Th>
                    <Th>Customer</Th>
                    <Th>Date</Th>
                    <Th>Due</Th>
                    <Th numeric>Days past due</Th>
                    <Th numeric>Open balance</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.invoiceId}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Select invoice ${r.invoiceNumber}`}
                          disabled={r.foreignCurrency}
                          checked={selected.has(r.invoiceId)}
                          onChange={() => {
                            const n = new Set(selected);
                            if (n.has(r.invoiceId)) n.delete(r.invoiceId);
                            else n.add(r.invoiceId);
                            setSelected(n);
                          }}
                        />
                      </Td>
                      <Td>
                        #{r.invoiceNumber} {r.foreignCurrency && <Badge tone="warning">Foreign currency</Badge>}
                      </Td>
                      <Td>{r.customerName}</Td>
                      <Td>{r.date.slice(0, 10)}</Td>
                      <Td>{r.dueDate ? r.dueDate.slice(0, 10) : ''}</Td>
                      <Td numeric>{r.daysPastDue}</Td>
                      <Td numeric>{money(r.balanceDue)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
                <div>
                  <Label htmlFor="wo-date">Write-off date</Label>
                  <Input id="wo-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="min-w-[240px]">
                  <Label htmlFor="wo-acct">Bad debt account</Label>
                  <Select id="wo-acct" value={badDebt} onChange={(e) => setBadDebt(e.target.value)}>
                    <option value="">Choose an expense account…</option>
                    {expenseAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{accountLabel(a)}</option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-[240px]">
                  <Label htmlFor="wo-memo">Memo (optional)</Label>
                  <Input id="wo-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
                </div>
                <Button variant="danger" disabled={selected.size === 0 || !badDebt} onClick={() => setConfirm(true)}>
                  Write off {selected.size > 0 ? money(total) : ''}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title="Write off these invoices?"
        message={`${selected.size} invoice(s), ${money(total)} in total, will be cleared to bad debt on ${date}. You can void the credit memos later if a customer pays after all.`}
        confirmLabel="Write off"
        loading={saving}
        onConfirm={writeOff}
        onClose={() => setConfirm(false)}
      />
    </main>
  );
}
