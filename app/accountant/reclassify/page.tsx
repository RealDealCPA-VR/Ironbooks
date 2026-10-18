'use client';

import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { type AccountOpt, type NamedOpt, BackToCenter, accountLabel, money, monthsAgo, today, useList } from '../_shared';

interface Line {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  sourceType: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  className: string | null;
}

const SOURCE_TYPES = ['', 'Invoice', 'Sales Receipt', 'Credit Memo', 'Bill', 'Check / Expense', 'Journal Entry'];

export default function ReclassifyPage() {
  const accounts = useList<AccountOpt>('/api/accounts');
  const classes = useList<NamedOpt>('/api/classes');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(monthsAgo(12));
  const [to, setTo] = useState(today());
  const [sourceType, setSourceType] = useState('');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [isControl, setIsControl] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newAccountId, setNewAccountId] = useState('');
  const [classMode, setClassMode] = useState<'keep' | 'clear' | string>('keep');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!accountId) return toast('Choose the account to look in first.', 'info');
    setLoading(true);
    try {
      const qs = new URLSearchParams({ accountId, from, to, ...(sourceType ? { sourceType } : {}) });
      const res = await api.get<{ lines: Line[]; isControlAccount: boolean }>(`/api/accountant/reclassify?${qs}`);
      setLines(res.lines);
      setIsControl(res.isControlAccount);
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Could not load transactions.');
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { lineIds: [...selected] };
      if (newAccountId) body.newAccountId = newAccountId;
      if (classMode === 'clear') body.newClassId = null;
      else if (classMode !== 'keep') body.newClassId = classMode;
      const res = await api.post<{ linesChanged: number; entriesChanged: number; documentsUpdated?: number }>(
        '/api/accountant/reclassify',
        body,
      );
      const docs = res.documentsUpdated ?? 0;
      toast(
        `Reclassified ${res.linesChanged} line(s) in ${res.entriesChanged} transaction(s)` +
          (docs > 0 ? ` and updated ${docs} original form(s) to match.` : '.'),
        'success',
      );
      setConfirm(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not reclassify.');
    } finally {
      setSaving(false);
    }
  }

  const allSelected = lines !== null && lines.length > 0 && selected.size === lines.length;
  const canApply = selected.size > 0 && (newAccountId !== '' || classMode !== 'keep') && !isControl;
  const targetName = accounts.find((a) => a.id === newAccountId);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Reclassify Transactions" icon={ArrowLeftRight} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Pick an account and a date range, tick the lines that were posted to the wrong account <Help term="chart-of-accounts" /> or
        class, then choose where they belong. Amounts never change, so your books stay balanced. Every change is recorded in the
        audit trail. The original invoice, bill, check, deposit or credit is updated too, so editing it later keeps the new
        account. Lines that come from an item keep the item&apos;s account (you can still change their class) — change the
        item&apos;s account instead.
      </p>

      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px]">
            <Label htmlFor="rc-acct">Account to look in</Label>
            <Select id="rc-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="rc-from">From</Label>
            <Input id="rc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rc-to">To</Label>
            <Input id="rc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rc-type">Show</Label>
            <Select id="rc-type" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>{t || 'All transaction types'}</option>
              ))}
            </Select>
          </div>
          <Button onClick={load} loading={loading} variant="secondary">Show transactions</Button>
        </div>
      </Card>

      {lines !== null && (
        <Card className="p-6">
          {isControl && (
            <p className="mb-4 rounded-lg bg-gold/20 p-3 text-sm text-yellow-800">
              This account is linked to bank, customer, vendor, inventory, sales tax or payroll records, so its lines can’t be
              reclassified here. Edit the original transaction instead.
            </p>
          )}
          {lines.length === 0 ? (
            <EmptyState icon={ArrowLeftRight} title="No transactions" message="Nothing was posted to this account in the dates you chose." />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.lineId)))}
                      />
                    </Th>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th>#</Th>
                    <Th>Description / memo</Th>
                    <Th>Class</Th>
                    <Th numeric>Debit</Th>
                    <Th numeric>Credit</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <Tr key={l.lineId}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Select entry ${l.entryNumber}`}
                          checked={selected.has(l.lineId)}
                          onChange={() => {
                            const n = new Set(selected);
                            if (n.has(l.lineId)) n.delete(l.lineId);
                            else n.add(l.lineId);
                            setSelected(n);
                          }}
                        />
                      </Td>
                      <Td>{l.date.slice(0, 10)}</Td>
                      <Td><Badge tone="neutral">{l.sourceType}</Badge></Td>
                      <Td>{l.entryNumber}</Td>
                      <Td>
                        {l.description}
                        {l.memo && l.memo !== l.description ? <span className="block text-xs text-navy/50">{l.memo}</span> : null}
                      </Td>
                      <Td>{l.className ?? ''}</Td>
                      <Td numeric>{l.debit ? money(l.debit) : ''}</Td>
                      <Td numeric>{l.credit ? money(l.credit) : ''}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>

              <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
                <div className="min-w-[260px]">
                  <Label htmlFor="rc-new">Change account to</Label>
                  <Select id="rc-new" value={newAccountId} onChange={(e) => setNewAccountId(e.target.value)}>
                    <option value="">Keep the same account</option>
                    {accounts
                      .filter((a) => a.id !== accountId && a.isActive !== false)
                      .map((a) => (
                        <option key={a.id} value={a.id}>{accountLabel(a)}</option>
                      ))}
                  </Select>
                </div>
                <div className="min-w-[200px]">
                  <Label htmlFor="rc-class">Change class to</Label>
                  <Select id="rc-class" value={classMode} onChange={(e) => setClassMode(e.target.value)}>
                    <option value="keep">Keep the same class</option>
                    <option value="clear">No class</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </Select>
                </div>
                <Button disabled={!canApply} onClick={() => setConfirm(true)}>
                  Reclassify {selected.size > 0 ? `${selected.size} line(s)` : ''}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        title="Reclassify the selected lines?"
        message={`${selected.size} line(s) will be moved${targetName ? ` to ${accountLabel(targetName)}` : ''}${classMode !== 'keep' ? ' and their class changed' : ''}. Amounts stay the same.`}
        confirmLabel="Reclassify"
        loading={saving}
        onConfirm={apply}
        onClose={() => setConfirm(false)}
      />
    </main>
  );
}
