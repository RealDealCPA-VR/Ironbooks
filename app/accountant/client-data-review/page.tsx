'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Select, Spinner, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { BackToCenter, money, today } from '../_shared';

type Fix =
  | { kind: 'apply_customer_credit'; refType: 'payment' | 'credit_memo'; refId: string }
  | { kind: 'apply_vendor_credit'; refId: string }
  | { kind: 'link'; href: string; label: string };
interface Issue {
  id: string;
  title: string;
  detail: string;
  amount?: string;
  fix?: Fix;
}
interface Task {
  key: string;
  group: string;
  title: string;
  status: 'not_started' | 'in_progress' | 'completed';
  issues: Issue[];
}
interface Review {
  tasks: Task[];
  lastReview: { asOf: string; at: string } | null;
}

const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' } as const;

export default function ClientDataReviewPage() {
  const [data, setData] = useState<Review | null>(null);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(today());

  async function load() {
    try {
      setData(await api.get<Review>(`/api/accountant/client-data-review?undepositedDays=${days || 0}`));
    } catch (err) {
      toastError(err, 'Could not run the review.');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(id: string, body: Record<string, unknown>, done: string) {
    setBusy(id);
    try {
      await api.post('/api/accountant/client-data-review', body);
      toast(done, 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not complete that step.');
    } finally {
      setBusy(null);
    }
  }

  const groups = data ? [...new Set(data.tasks.map((t) => t.group))] : [];

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Client Data Review" icon={ClipboardCheck} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Work through each clean-up task. Every task lists what it found and how to fix it. When you finish, save the review
        balances — next time, “Compare balances” shows anything that changed in the period you already reviewed.
      </p>
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="cdr-days">Undeposited funds older than (days)</Label>
            <Input id="cdr-days" type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={load}>Refresh</Button>
          <div className="flex-1" />
          <div>
            <Label htmlFor="cdr-asof">Review period ends</Label>
            <Input id="cdr-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <Button loading={busy === 'snapshot'} onClick={() => act('snapshot', { action: 'snapshot', asOf }, `Review balances saved as of ${asOf}.`)}>
            Save review balances
          </Button>
        </div>
        {data?.lastReview && (
          <p className="mt-2 text-xs text-navy/50">
            Last review covered the books through {data.lastReview.asOf} (saved {data.lastReview.at.slice(0, 10)}).
          </p>
        )}
      </Card>

      {!data ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : (
        groups.map((g) => (
          <section key={g} className="mb-6">
            <h2 className="mb-2 text-lg font-bold text-navy">{g}</h2>
            {data.tasks
              .filter((t) => t.group === g)
              .map((t) => (
                <Card key={t.key} className="mb-3 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="font-semibold text-navy">{t.title}</h3>
                    <Badge tone={t.issues.length === 0 ? 'success' : 'warning'}>
                      {t.issues.length === 0 ? 'Nothing found' : `${t.issues.length} to look at`}
                    </Badge>
                    <div className="flex-1" />
                    <Select
                      aria-label={`Status of ${t.title}`}
                      className="w-40"
                      value={t.status}
                      onChange={(e) => act(`status-${t.key}`, { action: 'task_status', taskKey: t.key, status: e.target.value }, 'Status updated.')}
                    >
                      {Object.entries(STATUS_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </Select>
                  </div>
                  {t.issues.length === 0 ? (
                    <p className="mt-2 flex items-center gap-1 text-sm text-emerald"><CheckCircle2 className="h-4 w-4" /> All clear.</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-slate-100">
                      {t.issues.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-start gap-3 py-2">
                          <div className="flex-1 min-w-[260px]">
                            <div className="text-sm font-medium text-navy">{i.title}</div>
                            <div className="text-xs text-navy/60">{i.detail}</div>
                          </div>
                          {i.amount && <div className="text-sm tabular-nums text-navy">{money(i.amount)}</div>}
                          {i.fix?.kind === 'link' && (
                            <Link href={i.fix.href} className="text-sm text-electric hover:underline">{i.fix.label}</Link>
                          )}
                          {i.fix?.kind === 'apply_customer_credit' && (
                            <Button
                              size="sm"
                              loading={busy === i.id}
                              onClick={() => act(i.id, { action: 'apply_customer_credit', refType: (i.fix as { refType: string }).refType, refId: (i.fix as { refId: string }).refId }, 'Applied to the oldest open invoices.')}
                            >
                              Apply to open invoices
                            </Button>
                          )}
                          {i.fix?.kind === 'apply_vendor_credit' && (
                            <Button
                              size="sm"
                              loading={busy === i.id}
                              onClick={() => act(i.id, { action: 'apply_vendor_credit', refId: (i.fix as { refId: string }).refId }, 'Applied to the oldest open bills.')}
                            >
                              Apply to open bills
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
          </section>
        ))
      )}
    </main>
  );
}
