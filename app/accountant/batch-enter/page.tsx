'use client';
/**
 * Enter Batch Transactions (QB Accountant "Batch Enter Transactions").
 *
 * A spreadsheet-style grid for checks, deposits, credit card charges/credits, bills, bill credits,
 * invoices, credit memos and journal entries:
 *  - type rows or paste straight from Excel / Google Sheets — into any cell (fills right and down
 *    like a spreadsheet) or through "Paste from Excel", which maps the pasted columns by their
 *    headers and lets the user change the mapping before using the rows;
 *  - every row is checked while typing (names and accounts matched by name / number, amounts,
 *    dates, closing date) with the same rules the server uses (batchEnterMatch.ts);
 *  - "Save transactions" posts every good row through the normal document services (each row its
 *    own transaction by default) and reports a result per row; saved rows leave the grid, rows
 *    that failed stay with their reason.
 * Keyboard: Tab across cells, Enter / Down next line (adds one at the end), Up previous line,
 * Ctrl+Insert insert, Ctrl+D delete line, Ctrl+S save, + / - / T in date cells, Alt+letter buttons.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ClipboardPaste, Plus, Rows3, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Th,
  toast,
  toastError,
  useGridKeys,
} from '@/components/ui';
import { Typeahead } from '@/components/Typeahead';
import { AccessKeyText } from '@/components/AccessKey';
import { api } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';
import { dateKeyForTextField } from '@/lib/shortcuts';
import type { TypeaheadOption } from '@/lib/typeahead';
import {
  BATCH_COLUMN_LABELS,
  BATCH_ENTER_LABELS,
  BATCH_ENTER_TYPES,
  type BatchColumn,
  type BatchEnterRow,
  type BatchEnterType,
  type KeyedBatchRow,
  blankKeyedRow,
  applyColumnMapping,
  batchColumns,
  guessColumnMapping,
  isBlankBatchRow,
  mappableColumns,
  normalizeAmount,
  normalizeDate,
  parseClipboardGrid,
  pasteBlockAt,
  stripRowKey,
  withRowKeys,
} from '@/lib/services/accountant/batchEnterParse';
import {
  type BatchLookupLists,
  type ResolvedBatchJob,
  compactRowErrors,
  createBatchMatchers,
  renumberRowMessage,
  resolveBatchRows,
} from '@/lib/services/accountant/batchEnterMatch';
import { BackToCenter } from '../_shared';

interface RowResult {
  rows: number[];
  ok: boolean;
  errors: string[];
  warnings?: string[];
  id?: string;
}
interface BatchResult {
  saved: number;
  failed: number;
  rolledBack: boolean;
  results: RowResult[];
}
interface Lookups extends BatchLookupLists {
  closingDate: string | null;
  closingDateHasPassword: boolean;
  apAccountLabel: string | null;
}

/** A finished save, kept for the per-row report. `row` is the grid row number shown at the time. */
interface ReportLine {
  row: number;
  ok: boolean;
  text: string;
}

const START_ROWS = 10;
const blank = blankKeyedRow;
/** Types whose Name column takes any payee (a name not in the vendor list saves as a one-time payee). */
const FREE_TEXT_NAME_TYPES: BatchEnterType[] = ['check', 'cc_charge', 'cc_credit', 'deposit'];
const NEEDS_BANK: BatchEnterType[] = ['check', 'deposit', 'cc_charge', 'cc_credit'];
const MONEY_COLS: BatchColumn[] = ['amount', 'debit', 'credit'];
const DATE_COLS: BatchColumn[] = ['date', 'dueDate'];

/** Plain-language column headings per type (the Name column means different people). */
function columnLabel(c: BatchColumn, type: BatchEnterType): string {
  if (c !== 'name') return BATCH_COLUMN_LABELS[c];
  if (type === 'invoice' || type === 'credit_memo') return 'Customer';
  if (type === 'bill' || type === 'bill_credit') return 'Vendor';
  if (type === 'deposit') return 'Received from';
  if (type === 'journal') return 'Name';
  return 'Payee';
}

const EMPTY_LOOKUPS: Lookups = {
  accounts: [],
  customers: [],
  vendors: [],
  classes: [],
  closingDate: null,
  closingDateHasPassword: false,
  apAccountLabel: null,
};

export default function BatchEnterPage() {
  const [lookups, setLookups] = useState<Lookups>(EMPTY_LOOKUPS);
  const [type, setType] = useState<BatchEnterType>('check');
  const [bankAccountId, setBankAccountId] = useState('');
  const [rows, setRows] = useState<KeyedBatchRow[]>(() => Array.from({ length: START_ROWS }, blank));
  const [mode, setMode] = useState<'all' | 'row'>('row');
  const [serverErrors, setServerErrors] = useState<Map<number, string[]>>(new Map());
  const [report, setReport] = useState<ReportLine[] | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  /** Where the paste dialog puts rows by default: below what is already typed, so nothing is lost. */
  const [pasteWhere, setPasteWhere] = useState<'replace' | 'append'>('replace');
  const [closingPassword, setClosingPassword] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get<Lookups>('/api/accountant/batch-enter/lookups')
      .then((l) => alive && setLookups({ ...EMPTY_LOOKUPS, ...l }))
      .catch((err) => alive && toastError(err, 'Could not load your accounts and names.'));
    return () => {
      alive = false;
    };
  }, []);

  const cols = batchColumns(type);
  const isCard = type === 'cc_charge' || type === 'cc_credit';
  const bankChoices = lookups.accounts.filter((a) => (isCard ? isCreditCardAccount(a) : isBankAccount(a)));

  // ---- live row checks (same rules as the server) ----
  const matchers = useMemo(() => createBatchMatchers(lookups), [lookups]);
  const filledIdx = useMemo(() => rows.map((r, i) => (isBlankBatchRow(r) ? -1 : i)).filter((i) => i >= 0), [rows]);
  /** Blank rows are skipped before checking, so messages are renumbered to the grid's # column. */
  const gridRowNumber = useCallback((k: number) => (filledIdx[k] ?? k) + 1, [filledIdx]);
  const jobs: ResolvedBatchJob[] = useMemo(
    () =>
      filledIdx.length === 0
        ? []
        : resolveBatchRows(
            { type, bankAccountId: NEEDS_BANK.includes(type) ? bankAccountId || null : null, rows: filledIdx.map((i) => rows[i]) },
            matchers,
            { closingDate: lookups.closingDate, rowNumber: gridRowNumber },
          ),
    [filledIdx, rows, type, bankAccountId, matchers, lookups.closingDate, gridRowNumber],
  );
  /** Grid row index → its messages (job row indexes point into the filled rows). */
  const rowMessages = useMemo(() => {
    const m = new Map<number, { errors: string[]; warnings: string[] }>();
    for (const j of jobs) for (const k of j.rows) m.set(filledIdx[k], { errors: j.errors, warnings: j.warnings });
    return m;
  }, [jobs, filledIdx]);
  const readyCount = jobs.filter((j) => j.errors.length === 0).length;
  const problemCount = jobs.length - readyCount;
  const needsClosingPassword = jobs.some((j) => j.warnings.some((w) => /closing date/.test(w)));
  const total = useMemo(() => {
    let t = Money.zero();
    for (const i of filledIdx) {
      const r = rows[i];
      const v = normalizeAmount(type === 'journal' ? r.debit : r.amount);
      if (v) t = t.plus(Money.of(v));
    }
    return t.toFixed(2);
  }, [filledIdx, rows, type]);

  // ---- picker options ----
  const accountOptions: TypeaheadOption[] = useMemo(
    () => lookups.accounts.map((a) => ({ value: `${a.code} · ${a.name}`, terms: [a.code, a.name], hint: a.type })),
    [lookups.accounts],
  );
  const nameOptions: TypeaheadOption[] = useMemo(() => {
    const cust = lookups.customers.filter((c) => c.name).map((c) => ({ value: c.name!, hint: 'Customer' }));
    const vend = lookups.vendors.filter((v) => v.name).map((v) => ({ value: v.name!, hint: 'Vendor' }));
    if (type === 'invoice' || type === 'credit_memo') return cust;
    if (type === 'bill' || type === 'bill_credit' || type === 'check' || type === 'cc_charge' || type === 'cc_credit') return vend;
    return [...cust, ...vend];
  }, [lookups.customers, lookups.vendors, type]);
  const classOptions: TypeaheadOption[] = useMemo(
    () => lookups.classes.filter((c) => c.name).map((c) => ({ value: c.name! })),
    [lookups.classes],
  );

  // ---- grid editing ----
  const setCell = useCallback((i: number, key: BatchColumn, v: string) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
    setServerErrors((m) => {
      if (!m.has(i)) return m;
      const n = new Map(m);
      n.delete(i);
      return n;
    });
  }, []);
  const addRow = useCallback(() => setRows((rs) => [...rs, blank()]), []);
  const insertRow = useCallback((i: number) => {
    setRows((rs) => [...rs.slice(0, i), blank(), ...rs.slice(i)]);
    setServerErrors(new Map());
  }, []);
  const removeRow = useCallback((i: number) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [blank()]));
    setServerErrors(new Map());
  }, []);
  const grid = useGridKeys({ addRow, insertRow, removeRow, disabled: busy !== null });

  function changeType(next: BatchEnterType) {
    setType(next);
    setServerErrors(new Map());
    setReport(null);
  }

  /** Open the mapping dialog; it adds below existing rows by default when the grid isn't empty. */
  function openPaste() {
    setPasteWhere(rows.some((r) => !isBlankBatchRow(r)) ? 'append' : 'replace');
    setPasteOpen(true);
  }

  /** Paste a copied block into the grid at a cell (spreadsheet style), or map it when it has headers. */
  function onCellPaste(e: React.ClipboardEvent<HTMLInputElement>, rowIdx: number, colIdx: number) {
    const text = e.clipboardData.getData('text/plain');
    if (!text || (!text.includes('\t') && !/\r?\n./.test(text.trimEnd()))) return; // a single value: normal paste
    e.preventDefault();
    const block = parseClipboardGrid(text);
    if (block.length === 0) return;
    if (guessColumnMapping(block, type).hasHeader) {
      setPasteText(text);
      openPaste();
      return;
    }
    setRows((rs) => withRowKeys(pasteBlockAt(rs, { row: rowIdx, col: colIdx }, block, type)));
    setServerErrors(new Map());
    toast(`Pasted ${block.length} row${block.length === 1 ? '' : 's'}. Check the marks on the right, then save.`, 'success');
  }

  function applyMappedRows(mapped: BatchEnterRow[], where: 'replace' | 'append') {
    if (mapped.length === 0) return toast('Nothing to paste: no column is mapped, or the rows are empty.', 'info');
    setRows((rs) => {
      const kept = where === 'append' ? rs.filter((r) => !isBlankBatchRow(r)) : [];
      const next = [...kept, ...withRowKeys(mapped)];
      return next.length < START_ROWS ? [...next, ...Array.from({ length: START_ROWS - next.length }, blank)] : [...next, blank()];
    });
    setServerErrors(new Map());
    setReport(null);
    setPasteOpen(false);
    setPasteText('');
    toast(`Pasted ${mapped.length} row${mapped.length === 1 ? '' : 's'}. Check the marks on the right, then save.`, 'success');
  }

  // ---- save ----
  async function submit(validateOnly: boolean) {
    if (filledIdx.length === 0) return toast('Enter or paste at least one row.', 'info');
    if (NEEDS_BANK.includes(type) && !bankAccountId) {
      return toast(`Choose the ${isCard ? 'credit card' : 'bank'} account first.`, 'info');
    }
    const data = filledIdx.map((i) => stripRowKey(rows[i]));
    setBusy(validateOnly ? 'check' : 'save');
    try {
      const res = await api.post<BatchResult>(
        '/api/accountant/batch-enter',
        { type, bankAccountId: NEEDS_BANK.includes(type) ? bankAccountId : null, rows: data, mode, validateOnly },
        closingPassword ? { closingPassword } : undefined,
      );
      // Server results point into `data`; map them back onto grid rows.
      const errs = new Map<number, string[]>();
      const savedGridRows = new Set<number>();
      const lines: ReportLine[] = [];
      for (const r of res.results) {
        const gridRows = r.rows.map((k) => filledIdx[k]);
        const rowErrors = r.errors.map((e) => renumberRowMessage(e, gridRowNumber));
        if (!r.ok) for (const g of gridRows) errs.set(g, rowErrors);
        if (r.ok && r.id && !res.rolledBack && !validateOnly) gridRows.forEach((g) => savedGridRows.add(g));
        const first = gridRows[0] + 1;
        lines.push({
          row: first,
          ok: r.ok,
          text: r.ok
            ? validateOnly || res.rolledBack
              ? 'Ready to save.'
              : `Saved${gridRows.length > 1 ? ` (rows ${first}–${gridRows[gridRows.length - 1] + 1})` : ''}.`
            : rowErrors.join(' '),
        });
      }
      setReport(lines);
      if (validateOnly) {
        setServerErrors(errs);
        toast(res.failed === 0 ? 'Every row looks good — ready to save.' : `${res.failed} row(s) need fixing.`, res.failed === 0 ? 'success' : 'danger');
        return;
      }
      if (res.rolledBack) {
        setServerErrors(errs);
        toast(`Nothing was saved: ${res.failed} row(s) need fixing.`, 'danger');
        return;
      }
      // Saved rows leave the grid; rows that failed stay with their reason.
      const keep = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => !savedGridRows.has(i) && !isBlankBatchRow(r));
      const nextErrs = compactRowErrors(errs, keep.map(({ i }) => i));
      const nextRows = keep.map(({ r }) => r);
      setRows(nextRows.length < START_ROWS ? [...nextRows, ...Array.from({ length: START_ROWS - nextRows.length }, blank)] : nextRows);
      setServerErrors(nextErrs);
      toast(
        `Saved ${res.saved} transaction(s)${res.failed ? `; ${res.failed} row(s) were not saved and stay in the grid` : ''}.`,
        res.failed ? 'info' : 'success',
      );
    } catch (err) {
      toastError(err, 'Could not save the batch.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main
      data-shortcut-scope
      className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans"
    >
      <BackToCenter />
      <PageHeader title="Enter Batch Transactions" icon={Rows3} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Enter many transactions at once — type them in the grid like a spreadsheet, or copy rows in Excel or Google
        Sheets and paste them into any cell. Accounts can be typed by number or name; customers and vendors must already
        be in your lists. Each row is saved exactly as if you had filled in the form yourself.
      </p>

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="be-type">
              <AccessKeyText text="Transaction type" accessKey="y" />
            </Label>
            <Select id="be-type" accessKey="y" value={type} onChange={(e) => changeType(e.target.value as BatchEnterType)}>
              {BATCH_ENTER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BATCH_ENTER_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
          {NEEDS_BANK.includes(type) && (
            <div className="min-w-[240px]">
              <Label htmlFor="be-bank" required>
                <AccessKeyText text={isCard ? 'Credit card account' : 'Bank account'} accessKey="u" />
              </Label>
              <Select id="be-bank" accessKey="u" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                <option value="">Choose…</option>
                {(bankChoices.length ? bankChoices : lookups.accounts).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {(type === 'bill' || type === 'bill_credit') && (
            <div className="min-w-[220px]">
              <span className="mb-1 block text-sm font-medium text-navy/70">Accounts Payable account</span>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-navy/70">
                {lookups.apAccountLabel ?? 'Accounts Payable'}
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="be-mode">If a row has a problem</Label>
            <Select id="be-mode" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'row')}>
              <option value="row">Save the good rows, report the rest</option>
              <option value="all">Save nothing until every row is right</option>
            </Select>
          </div>
          <Button variant="secondary" accessKey="p" onClick={openPaste}>
            <ClipboardPaste className="h-4 w-4" /> <AccessKeyText text="Paste from Excel" accessKey="p" />
          </Button>
        </div>
        {type === 'journal' && (
          <p className="mt-3 text-xs text-navy/50">
            Journal entries: give every row of one entry the same date and Ref (or leave both blank on the follow-on rows).
            Debits and credits of each entry must be equal.
          </p>
        )}
        {needsClosingPassword && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-gold/10 p-3">
            <p className="max-w-xl text-sm text-navy/70">
              Some rows are dated on or before your closing date ({lookups.closingDate}).
              {lookups.closingDateHasPassword
                ? ' Enter the closing date password to save them, or change their dates.'
                : ' Only someone allowed to change closed periods can save them.'}
            </p>
            {lookups.closingDateHasPassword && (
              <div>
                <Label htmlFor="be-closing-pw">Closing date password</Label>
                <Input
                  id="be-closing-pw"
                  type="password"
                  autoComplete="off"
                  value={closingPassword}
                  onChange={(e) => setClosingPassword(e.target.value)}
                />
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-navy/60" aria-live="polite">
          <span>
            {jobs.length} {type === 'journal' ? 'entr' + (jobs.length === 1 ? 'y' : 'ies') : 'row' + (jobs.length === 1 ? '' : 's')}
          </span>
          {readyCount > 0 && <Badge tone="success">{readyCount} ready</Badge>}
          {problemCount > 0 && <Badge tone="danger">{problemCount} need fixing</Badge>}
          <span className="ml-auto tabular-nums">
            Total {type === 'journal' ? 'debits' : ''} {formatCurrency(total)}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label="Batch transactions">
            <thead>
              <tr>
                <Th className="w-10 px-2">#</Th>
                {cols.map((c) => (
                  <Th key={c} numeric={MONEY_COLS.includes(c)} className="px-1">
                    {columnLabel(c, type)}
                  </Th>
                ))}
                <Th className="w-10 px-2">
                  <span className="sr-only">Check</span>
                </Th>
                <Th className="w-10 px-2">
                  <span className="sr-only">Delete</span>
                </Th>
              </tr>
            </thead>
            <tbody onKeyDown={grid.onKeyDown}>
              {rows.map((r, i) => {
                const msgs = rowMessages.get(i);
                const errs = serverErrors.get(i) ?? msgs?.errors ?? [];
                const warns = msgs?.warnings ?? [];
                const filled = !isBlankBatchRow(r);
                const msgId = `be-row-${r._key}-msg`;
                return (
                  <tr key={r._key} data-grid-row className={filled && errs.length ? 'bg-red-50/70' : undefined}>
                    <td className="px-2 pt-3 align-top text-xs text-navy/40">{i + 1}</td>
                    {cols.map((c, ci) => {
                      const v = (r[c] as string | undefined) ?? '';
                      const common = {
                        'aria-label': `Row ${i + 1} ${columnLabel(c, type)}`,
                        'aria-describedby': filled && (errs.length || warns.length) ? msgId : undefined,
                        'aria-invalid': filled && errs.length > 0 ? true : undefined,
                        onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => onCellPaste(e, i, ci),
                        className: 'px-2 py-1.5',
                      };
                      let cell: React.ReactNode;
                      if (c === 'account' || c === 'name' || c === 'className') {
                        cell = (
                          <Typeahead
                            {...common}
                            value={v}
                            onChange={(val) => setCell(i, c, val)}
                            options={c === 'account' ? accountOptions : c === 'name' ? nameOptions : classOptions}
                            allowFreeText={c === 'name' && FREE_TEXT_NAME_TYPES.includes(type)}
                          />
                        );
                      } else if (MONEY_COLS.includes(c)) {
                        cell = (
                          <AmountInput
                            {...common}
                            className="px-2 py-1.5 text-right"
                            value={v}
                            onChange={(e) => setCell(i, c, e.target.value)}
                          />
                        );
                      } else if (DATE_COLS.includes(c)) {
                        cell = (
                          <Input
                            {...common}
                            value={v}
                            placeholder="MM/DD/YYYY"
                            onChange={(e) => setCell(i, c, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.ctrlKey || e.metaKey || e.altKey) return;
                              const next = dateKeyForTextField(e.key, e.currentTarget.value, normalizeDate);
                              if (next !== null) {
                                e.preventDefault();
                                setCell(i, c, next);
                              }
                            }}
                          />
                        );
                      } else {
                        cell = <Input {...common} value={v} onChange={(e) => setCell(i, c, e.target.value)} />;
                      }
                      return (
                        <td key={c} className={`px-1 py-1 align-top ${c === 'memo' || c === 'account' || c === 'name' ? 'min-w-[160px]' : 'min-w-[96px]'}`}>
                          {cell}
                          {ci === 0 && filled && (errs.length > 0 || warns.length > 0) && (
                            <div id={msgId} className="sr-only">
                              {[...errs, ...warns].join(' ')}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 pt-2.5 align-top">
                      {filled &&
                        (errs.length > 0 ? (
                          <span title={errs.join('\n')}>
                            <XCircle className="h-5 w-5 text-red-500" aria-label="Needs fixing" />
                          </span>
                        ) : warns.length > 0 ? (
                          <span title={warns.join('\n')}>
                            <TriangleAlert className="h-5 w-5 text-yellow-600" aria-label="Ready, with a note" />
                          </span>
                        ) : (
                          <CheckCircle2 className="h-5 w-5 text-emerald" aria-label="Ready" />
                        ))}
                    </td>
                    <td className="px-1 pt-1.5 align-top">
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => removeRow(i)}
                        className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-600"
                        aria-label={`Delete row ${i + 1}`}
                        title="Delete this row (Ctrl+D)"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(problemCount > 0 || jobs.some((j) => j.warnings.length > 0) || serverErrors.size > 0) && (
          <ul className="mt-4 space-y-1 rounded-lg bg-slate-50 p-3 text-sm" aria-label="Row problems">
            {Array.from(new Set(rows.flatMap((_, i) => serverErrors.get(i) ?? rowMessages.get(i)?.errors ?? []))).map((e, k) => (
              <li key={`e${k}`} className="text-red-700">
                {e}
              </li>
            ))}
            {Array.from(new Set(jobs.flatMap((j) => j.warnings))).map((w, k) => (
              <li key={`w${k}`} className="text-yellow-800">
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" accessKey="a" data-shortcut="new" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, blank)])}>
            <Plus className="h-4 w-4" /> <AccessKeyText text="Add rows" accessKey="a" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRows(Array.from({ length: START_ROWS }, blank));
              setServerErrors(new Map());
              setReport(null);
            }}
          >
            Clear grid
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" accessKey="k" loading={busy === 'check'} onClick={() => submit(true)}>
            <AccessKeyText text="Check rows" accessKey="k" />
          </Button>
          <Button accessKey="s" data-shortcut="save" loading={busy === 'save'} disabled={readyCount === 0} onClick={() => submit(false)}>
            <AccessKeyText text={`Save transactions${readyCount ? ` (${readyCount})` : ''}`} accessKey="s" />
          </Button>
        </div>
      </Card>

      {report && report.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="mb-2 text-sm font-bold text-navy">Results by row</h2>
          <ul className="space-y-1 text-sm">
            {report.map((l, k) => (
              <li key={k} className={`flex gap-2 ${l.ok ? 'text-emerald' : 'text-red-700'}`}>
                {l.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                <span>
                  <span className="font-semibold">Row {l.row}:</span> {l.text.replace(/^Row \d+: /, '')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PasteDialog
        open={pasteOpen}
        initialWhere={pasteWhere}
        type={type}
        text={pasteText}
        onText={setPasteText}
        onClose={() => setPasteOpen(false)}
        onUse={applyMappedRows}
        columnLabel={(c) => columnLabel(c, type)}
      />
    </main>
  );
}

/** "Paste from Excel / Google Sheets" with a column mapping step and a preview. */
function PasteDialog({
  open,
  initialWhere,
  type,
  text,
  onText,
  onClose,
  onUse,
  columnLabel,
}: {
  open: boolean;
  /** 'append' when the grid already has rows, so Use / Ctrl+S never silently throws them away. */
  initialWhere: 'replace' | 'append';
  type: BatchEnterType;
  text: string;
  onText: (t: string) => void;
  onClose: () => void;
  onUse: (rows: BatchEnterRow[], where: 'replace' | 'append') => void;
  columnLabel: (c: BatchColumn) => string;
}) {
  const grid = useMemo(() => parseClipboardGrid(text), [text]);
  const guess = useMemo(() => guessColumnMapping(grid, type), [grid, type]);
  const [hasHeader, setHasHeader] = useState(false);
  const [mapping, setMapping] = useState<Array<BatchColumn | null>>([]);
  const [where, setWhere] = useState<'replace' | 'append'>(initialWhere);
  useEffect(() => {
    if (open) setWhere(initialWhere);
  }, [open, initialWhere]);

  // Re-guess whenever the pasted text or the type changes.
  useEffect(() => {
    setHasHeader(guess.hasHeader);
    setMapping(guess.mapping);
  }, [guess]);

  const mapped = useMemo(() => applyColumnMapping(grid, mapping, { hasHeader, type }), [grid, mapping, hasHeader, type]);
  const targets = mappableColumns(type);
  const headerRow = grid[0] ?? [];
  const preview = mapped.slice(0, 5);
  const cols = batchColumns(type);

  async function readClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) onText(t);
      else toast('The clipboard is empty.', 'info');
    } catch {
      toast('Could not read the clipboard here — click in the box and press Ctrl+V instead.', 'info');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Paste from Excel or Google Sheets"
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-shortcut="save" disabled={mapped.length === 0} onClick={() => onUse(mapped, where)}>
            Use {mapped.length} row{mapped.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-navy/60">
        In your spreadsheet, select the cells (with or without the heading row), copy them, then paste below. If the
        sheet has headings such as Date, Payee, Account and Amount, the columns are matched for you — change any of
        them in the list under the box.
      </p>
      <div className="mb-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={readClipboard}>
          <ClipboardPaste className="h-4 w-4" /> Paste what I copied
        </Button>
      </div>
      <textarea
        aria-label="Pasted rows"
        className="h-40 w-full rounded-lg border border-slate-200 p-2 font-mono text-xs outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
        value={text}
        placeholder={`Expected order without headings: ${cols.map(columnLabel).join(', ')}`}
        onChange={(e) => onText(e.target.value)}
      />

      {grid.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-navy/70">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              The first row is headings (don&apos;t import it)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="be-where" checked={where === 'replace'} onChange={() => setWhere('replace')} />
              Replace the grid
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="be-where" checked={where === 'append'} onChange={() => setWhere('append')} />
              Add below the rows already entered
            </label>
          </div>

          <h3 className="mt-4 mb-1 text-sm font-bold text-navy">Match the columns</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {mapping.map((m, j) => (
              <div key={j} className="flex items-center gap-2">
                <label htmlFor={`be-map-${j}`} className="w-36 truncate text-xs text-navy/60" title={headerRow[j]}>
                  {hasHeader && headerRow[j] ? `“${headerRow[j]}”` : `Column ${j + 1}`}
                </label>
                <Select
                  id={`be-map-${j}`}
                  value={m ?? ''}
                  onChange={(e) => {
                    const v = (e.target.value || null) as BatchColumn | null;
                    setMapping((prev) => prev.map((x, k) => (k === j ? v : v && x === v ? null : x)));
                  }}
                >
                  <option value="">(skip this column)</option>
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t === 'amount' && type === 'journal' ? 'Amount (+ debit / − credit)' : columnLabel(t)}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>

          <h3 className="mt-4 mb-1 text-sm font-bold text-navy">
            Preview {mapped.length > preview.length ? `(first ${preview.length} of ${mapped.length})` : ''}
          </h3>
          {preview.length === 0 ? (
            <p className="text-sm text-navy/50">No rows yet — map at least one column.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c} className="border-b border-slate-200 px-2 py-1 text-left font-semibold text-navy/60">
                        {columnLabel(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, k) => (
                    <tr key={k}>
                      {cols.map((c) => (
                        <td key={c} className="border-b border-slate-100 px-2 py-1 text-navy/80">
                          {(r[c] as string | undefined) ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
