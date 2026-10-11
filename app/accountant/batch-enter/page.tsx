'use client';

import { useState } from 'react';
import { Rows3, ClipboardPaste, Plus } from 'lucide-react';
import { Button, Card, Input, Label, Modal, PageHeader, Select, Table, Th, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import {
  BATCH_COLUMN_LABELS,
  BATCH_ENTER_LABELS,
  BATCH_ENTER_TYPES,
  type BatchEnterRow,
  type BatchEnterType,
  batchColumns,
  parseBatchPaste,
} from '@/lib/services/accountant/batchEnterParse';
import { type AccountOpt, BackToCenter, accountLabel } from '../_shared';
import { useList } from '../_shared';

interface RowResult {
  rows: number[];
  ok: boolean;
  errors: string[];
  id?: string;
}
interface BatchResult {
  saved: number;
  failed: number;
  rolledBack: boolean;
  results: RowResult[];
}

const blank = (): BatchEnterRow => ({ date: '', account: '' });
const NEEDS_BANK: BatchEnterType[] = ['check', 'deposit', 'cc_charge', 'cc_credit'];

export default function BatchEnterPage() {
  const accounts = useList<AccountOpt>('/api/accounts');
  const [type, setType] = useState<BatchEnterType>('check');
  const [bankAccountId, setBankAccountId] = useState('');
  const [rows, setRows] = useState<BatchEnterRow[]>(() => Array.from({ length: 8 }, blank));
  const [mode, setMode] = useState<'all' | 'row'>('all');
  const [result, setResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const cols = batchColumns(type);
  const isCard = type === 'cc_charge' || type === 'cc_credit';
  const bankChoices = accounts.filter((a) =>
    isCard ? a.type === 'liability' && (a.subtype === 'credit_card' || /card/i.test(a.name)) : a.type === 'asset' && ['checking', 'savings'].includes(a.subtype ?? ''),
  );
  const errorsByRow = new Map<number, string[]>();
  for (const r of result?.results ?? []) for (const i of r.rows) if (!r.ok) errorsByRow.set(i, r.errors);

  function setCell(i: number, key: keyof BatchEnterRow, v: string) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  }

  function filled(): BatchEnterRow[] {
    return rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.trim() !== ''));
  }

  async function submit(validateOnly: boolean) {
    const data = filled();
    if (data.length === 0) return toast('Enter or paste at least one row.', 'info');
    if (NEEDS_BANK.includes(type) && !bankAccountId) return toast(`Choose the ${isCard ? 'credit card' : 'bank'} account first.`, 'info');
    setBusy(validateOnly ? 'check' : 'save');
    try {
      const res = await api.post<BatchResult>('/api/accountant/batch-enter', {
        type,
        bankAccountId: NEEDS_BANK.includes(type) ? bankAccountId : null,
        rows: data,
        mode,
        validateOnly,
      });
      setResult(res);
      // Map result row indexes (into `data`) back onto the grid by keeping only filled rows.
      setRows(data.length < 8 ? [...data, ...Array.from({ length: 8 - data.length }, blank)] : data);
      if (validateOnly) {
        toast(res.failed === 0 ? 'Every row looks good — ready to save.' : `${res.failed} row(s) need fixing.`, res.failed === 0 ? 'success' : 'danger');
      } else if (res.rolledBack) {
        toast(`Nothing was saved: ${res.failed} row(s) need fixing.`, 'danger');
      } else {
        toast(`Saved ${res.saved} transaction(s)${res.failed ? `; ${res.failed} row(s) were not saved` : ''}.`, res.failed ? 'info' : 'success');
        if (res.failed === 0) {
          setRows(Array.from({ length: 8 }, blank));
          setResult(null);
        }
      }
    } catch (err) {
      toastError(err, 'Could not save the batch.');
    } finally {
      setBusy(null);
    }
  }

  function applyPaste() {
    const parsed = parseBatchPaste(pasteText, type);
    if (parsed.length === 0) return toast('Nothing to paste.', 'info');
    setRows(parsed);
    setResult(null);
    setPasteOpen(false);
    setPasteText('');
    toast(`Pasted ${parsed.length} row(s). Check them, then save.`, 'success');
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Batch Enter Transactions" icon={Rows3} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Enter many transactions at once — type them in the grid or paste rows straight from Excel. Accounts can be typed by
        number or name; names must already be in your customer or vendor list. Each row is saved exactly as if you had
        entered the form yourself.
      </p>

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="be-type">Transaction type</Label>
            <Select
              id="be-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as BatchEnterType);
                setResult(null);
              }}
            >
              {BATCH_ENTER_TYPES.map((t) => (
                <option key={t} value={t}>{BATCH_ENTER_LABELS[t]}</option>
              ))}
            </Select>
          </div>
          {NEEDS_BANK.includes(type) && (
            <div className="min-w-[240px]">
              <Label htmlFor="be-bank">{isCard ? 'Credit card account' : 'Bank account'}</Label>
              <Select id="be-bank" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                <option value="">Choose…</option>
                {(bankChoices.length ? bankChoices : accounts).map((a) => (
                  <option key={a.id} value={a.id}>{accountLabel(a)}</option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="be-mode">If a row has a problem</Label>
            <Select id="be-mode" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'row')}>
              <option value="all">Save nothing until every row is right</option>
              <option value="row">Save the good rows, report the rest</option>
            </Select>
          </div>
          <Button variant="secondary" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste className="h-4 w-4" /> Paste from Excel
          </Button>
        </div>
        {type === 'journal' && (
          <p className="mt-3 text-xs text-navy/50">
            Journal entries: give every row of one entry the same date and Ref (or leave both blank on the follow-on rows).
            Debits and credits of each entry must be equal.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              {cols.map((c) => (
                <Th key={c} numeric={c === 'amount' || c === 'debit' || c === 'credit'}>{BATCH_COLUMN_LABELS[c]}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={errorsByRow.has(i) ? 'bg-red-50' : undefined}>
                <td className="px-2 text-xs text-navy/40 align-top pt-3">{i + 1}</td>
                {cols.map((c) => (
                  <td key={c} className="px-1 py-1 align-top">
                    <Input
                      aria-label={`Row ${i + 1} ${BATCH_COLUMN_LABELS[c]}`}
                      list={c === 'account' ? 'be-accounts' : undefined}
                      value={(r[c] as string | undefined) ?? ''}
                      placeholder={c === 'date' || c === 'dueDate' ? 'YYYY-MM-DD' : undefined}
                      onChange={(e) => setCell(i, c, e.target.value)}
                      className={c === 'amount' || c === 'debit' || c === 'credit' ? 'text-right' : undefined}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
        <datalist id="be-accounts">
          {accounts.map((a) => (
            <option key={a.id} value={accountLabel(a)} />
          ))}
        </datalist>
        {result && result.results.some((r) => !r.ok) && (
          <ul className="mt-4 space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {result.results.filter((r) => !r.ok).flatMap((r) => r.errors).map((e, k) => (
              <li key={k}>{e}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, blank)])}>
            <Plus className="h-4 w-4" /> Add rows
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" loading={busy === 'check'} onClick={() => submit(true)}>Check rows</Button>
          <Button loading={busy === 'save'} onClick={() => submit(false)}>Save transactions</Button>
        </div>
      </Card>

      <Modal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Paste from Excel"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button onClick={applyPaste}>Use these rows</Button>
          </>
        }
      >
        <p className="mb-2 text-sm text-navy/60">
          Copy the cells in this column order and paste below: {cols.map((c) => BATCH_COLUMN_LABELS[c]).join(', ')}. A header
          row is skipped automatically.
        </p>
        <textarea
          aria-label="Pasted rows"
          className="h-56 w-full rounded-lg border border-slate-200 p-2 font-mono text-xs"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
      </Modal>
    </main>
  );
}
