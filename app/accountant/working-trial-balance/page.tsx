'use client';

import { useEffect, useState } from 'react';
import { Scale, Plus } from 'lucide-react';
import { Badge, Button, Card, Input, Label, Modal, PageHeader, Select, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { type AccountOpt, BackToCenter, accountLabel, money, thisYearStart, today, useList } from '../_shared';

interface Row {
  accountId: string;
  code: string;
  name: string;
  beginning: string;
  transactions: string;
  adjustments: string;
  ending: string;
  workpaperRef: string | null;
  note: string | null;
}
interface Wtb {
  from: string;
  to: string;
  rows: Row[];
  totals: { beginning: string; transactions: string; adjustments: string; ending: string };
  balanced: boolean;
}
interface AdjLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

export default function WorkingTrialBalancePage() {
  const accounts = useList<AccountOpt>('/api/accounts');
  const [from, setFrom] = useState(thisYearStart());
  const [to, setTo] = useState(today());
  const [data, setData] = useState<Wtb | null>(null);
  const [loading, setLoading] = useState(false);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjDesc, setAdjDesc] = useState('Adjusting entry');
  const [adjLines, setAdjLines] = useState<AdjLine[]>([
    { accountId: '', debit: '', credit: '', memo: '' },
    { accountId: '', debit: '', credit: '', memo: '' },
  ]);
  const [posting, setPosting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<Wtb>(`/api/accountant/working-trial-balance?from=${from}&to=${to}`));
    } catch (err) {
      toastError(err, 'Could not load the working trial balance.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveNote(row: Row, patch: Partial<Pick<Row, 'workpaperRef' | 'note'>>) {
    const next = { ...row, ...patch };
    if ((next.workpaperRef ?? '') === (row.workpaperRef ?? '') && (next.note ?? '') === (row.note ?? '')) return;
    try {
      await api.put('/api/accountant/working-trial-balance', {
        accountId: row.accountId,
        periodEnd: data!.to,
        workpaperRef: next.workpaperRef || null,
        note: next.note || null,
      });
      setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.accountId === row.accountId ? next : r)) } : d));
      toast('Saved.', 'success');
    } catch (err) {
      toastError(err, 'Could not save the note.');
    }
  }

  const td = adjLines.reduce((s, l) => s + Math.round(Number(l.debit || 0) * 100), 0) / 100;
  const tc = adjLines.reduce((s, l) => s + Math.round(Number(l.credit || 0) * 100), 0) / 100;

  async function postAdjustment() {
    setPosting(true);
    try {
      await api.post('/api/accountant/working-trial-balance', {
        date: to,
        description: adjDesc,
        lines: adjLines
          .filter((l) => l.accountId && (l.debit || l.credit))
          .map((l) => ({ accountId: l.accountId, debit: l.debit || null, credit: l.credit || null, memo: l.memo || null })),
      });
      toast('Adjusting entry posted.', 'success');
      setAdjOpen(false);
      setAdjLines([
        { accountId: '', debit: '', credit: '', memo: '' },
        { accountId: '', debit: '', credit: '', memo: '' },
      ]);
      await load();
    } catch (err) {
      toastError(err, 'Could not post the adjusting entry.');
    } finally {
      setPosting(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader
        title="Working Trial Balance"
        icon={Scale}
        action={data ? <Badge tone={data.balanced ? 'success' : 'danger'}>{data.balanced ? 'In balance' : 'OUT OF BALANCE'}</Badge> : undefined}
      />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Each account’s starting balance, this period’s transactions, your adjusting entries <Help term="journal-entry" /> and
        the ending balance. Debits are positive and credits negative, so every column adds up to zero. Add a workpaper
        reference and notes for each account; they are kept per period end.
      </p>
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="wtb-from">Period from</Label>
            <Input id="wtb-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="wtb-to">to</Label>
            <Input id="wtb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="secondary" loading={loading} onClick={load}>Refresh</Button>
          <Button onClick={() => setAdjOpen(true)}>
            <Plus className="h-4 w-4" /> Make adjustment
          </Button>
        </div>
      </Card>
      {data && (
        <Card className="p-6">
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th numeric>Beginning</Th>
                <Th numeric>Transactions</Th>
                <Th numeric>Adjustments</Th>
                <Th numeric>Ending</Th>
                <Th>Workpaper ref</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Tr key={`${data.to}-${r.accountId}`}>
                  <Td className="whitespace-nowrap">{r.code} · {r.name}</Td>
                  <Td numeric>{money(r.beginning)}</Td>
                  <Td numeric>{money(r.transactions)}</Td>
                  <Td numeric className={Number(r.adjustments) !== 0 ? 'font-semibold text-electric' : undefined}>{money(r.adjustments)}</Td>
                  <Td numeric>{money(r.ending)}</Td>
                  {r.accountId ? (
                    <>
                      <Td className="min-w-[110px]">
                        <Input
                          aria-label={`Workpaper reference for ${r.name}`}
                          defaultValue={r.workpaperRef ?? ''}
                          onBlur={(e) => saveNote(r, { workpaperRef: e.target.value })}
                        />
                      </Td>
                      <Td className="min-w-[220px]">
                        <Input aria-label={`Notes for ${r.name}`} defaultValue={r.note ?? ''} onBlur={(e) => saveNote(r, { note: e.target.value })} />
                      </Td>
                    </>
                  ) : (
                    <Td colSpan={2} className="text-sm text-navy/60">Earlier years&apos; profit or loss, carried into equity.</Td>
                  )}
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy/20 font-bold text-navy">
                <td className="py-3 px-4">Total</td>
                <td className="py-3 px-4 text-right tabular-nums">{money(data.totals.beginning)}</td>
                <td className="py-3 px-4 text-right tabular-nums">{money(data.totals.transactions)}</td>
                <td className="py-3 px-4 text-right tabular-nums">{money(data.totals.adjustments)}</td>
                <td className="py-3 px-4 text-right tabular-nums">{money(data.totals.ending)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </Table>
        </Card>
      )}

      <Modal
        open={adjOpen}
        onClose={() => setAdjOpen(false)}
        title={`Adjusting entry dated ${to}`}
        size="lg"
        footer={
          <>
            <span className={`mr-auto text-sm ${td === tc && td > 0 ? 'text-emerald' : 'text-red-600'}`}>
              Debits {money(td)} · Credits {money(tc)}
            </span>
            <Button variant="secondary" onClick={() => setAdjOpen(false)}>Cancel</Button>
            <Button loading={posting} disabled={td !== tc || td === 0} onClick={postAdjustment}>Post adjustment</Button>
          </>
        }
      >
        <Label htmlFor="adj-desc">Description</Label>
        <Input id="adj-desc" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} className="mb-3" />
        {adjLines.map((l, i) => (
          <div key={i} className="mb-2 grid grid-cols-12 gap-2">
            <Select
              aria-label={`Line ${i + 1} account`}
              className="col-span-5"
              value={l.accountId}
              onChange={(e) => setAdjLines((ls) => ls.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}
            >
              <option value="">Account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a)}</option>
              ))}
            </Select>
            <Input
              aria-label={`Line ${i + 1} debit`}
              className="col-span-2 text-right"
              placeholder="Debit"
              inputMode="decimal"
              value={l.debit}
              onChange={(e) => setAdjLines((ls) => ls.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))}
            />
            <Input
              aria-label={`Line ${i + 1} credit`}
              className="col-span-2 text-right"
              placeholder="Credit"
              inputMode="decimal"
              value={l.credit}
              onChange={(e) => setAdjLines((ls) => ls.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))}
            />
            <Input
              aria-label={`Line ${i + 1} memo`}
              className="col-span-3"
              placeholder="Memo"
              value={l.memo}
              onChange={(e) => setAdjLines((ls) => ls.map((x, j) => (j === i ? { ...x, memo: e.target.value } : x)))}
            />
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setAdjLines((ls) => [...ls, { accountId: '', debit: '', credit: '', memo: '' }])}>
          <Plus className="h-4 w-4" /> Add line
        </Button>
      </Modal>
    </main>
  );
}
