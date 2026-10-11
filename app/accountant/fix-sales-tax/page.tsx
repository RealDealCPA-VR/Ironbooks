'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader, Select, Spinner, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { type NamedOpt, BackToCenter, money, useList } from '../_shared';

interface Issue {
  issue: 'liability_unattributed' | 'expense_payment' | 'orphaned_fix';
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  accountName: string;
  amount: string;
  suggestedAgencyId: string | null;
  explanation: string;
}

export default function FixSalesTaxPage() {
  const agencies = useList<NamedOpt>('/api/tax-agencies');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [agencyFor, setAgencyFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<{ issues: Issue[] }>('/api/accountant/sales-tax/fix');
      setIssues(res.issues);
    } catch (err) {
      toastError(err, 'Could not search for sales tax problems.');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function fix(i: Issue, body: Record<string, unknown>, done: string) {
    setBusy(i.lineId);
    try {
      await api.post('/api/accountant/sales-tax/fix', body);
      toast(done, 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not fix this item.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Fix Incorrectly Recorded Sales Tax" icon={ShieldAlert} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Sales tax <Help term="sales-tax" /> paid with a regular check or a journal entry doesn’t show up as paid on the Pay
        Sales Tax screen. Choose the agency for each item below to fix it. Nothing already posted is changed or deleted.
      </p>
      <Card className="p-6">
        {!issues ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : issues.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Sales tax looks right" message="All sales tax activity is tied to an agency." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Entry</Th>
                <Th>What we found</Th>
                <Th numeric>Amount</Th>
                <Th>Agency</Th>
                <Th>Fix</Th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => {
                const agencyId = agencyFor[i.lineId] ?? i.suggestedAgencyId ?? '';
                return (
                  <Tr key={i.lineId}>
                    <Td className="whitespace-nowrap">{i.date.slice(0, 10)}</Td>
                    <Td>#{i.entryNumber}</Td>
                    <Td>
                      <div className="font-medium">{i.description}</div>
                      <div className="text-xs text-navy/60">{i.explanation}</div>
                      <Badge tone="neutral" className="mt-1">{i.accountName}</Badge>
                    </Td>
                    <Td numeric>{money(i.amount)}</Td>
                    <Td className="min-w-[180px]">
                      <Select
                        aria-label="Agency"
                        value={agencyId}
                        onChange={(e) => setAgencyFor((m) => ({ ...m, [i.lineId]: e.target.value }))}
                      >
                        <option value="">Choose agency…</option>
                        {agencies.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </Select>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {i.issue === 'orphaned_fix' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === i.lineId}
                          onClick={() => fix(i, { action: 'undo_fix', entryId: i.entryId }, 'Correction undone.')}
                        >
                          Undo correction
                        </Button>
                      ) : i.issue === 'expense_payment' ? (
                        <Button
                          size="sm"
                          disabled={!agencyId}
                          loading={busy === i.lineId}
                          onClick={() => fix(i, { action: 'reclassify', lineId: i.lineId, agencyId }, 'Moved to sales tax payable.')}
                        >
                          Count as tax payment
                        </Button>
                      ) : Number(i.amount) > 0 ? (
                        <Button
                          size="sm"
                          disabled={!agencyId}
                          loading={busy === i.lineId}
                          onClick={() => fix(i, { action: 'link', lineId: i.lineId, agencyId, kind: 'payment' }, 'Linked as a tax payment.')}
                        >
                          It was a tax payment
                        </Button>
                      ) : (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={!agencyId}
                            loading={busy === i.lineId}
                            onClick={() => fix(i, { action: 'link', lineId: i.lineId, agencyId, kind: 'collected' }, 'Linked as tax collected.')}
                          >
                            Tax collected
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!agencyId}
                            onClick={() => fix(i, { action: 'link', lineId: i.lineId, agencyId, kind: 'adjustment' }, 'Linked as an adjustment.')}
                          >
                            Adjustment
                          </Button>
                        </div>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
