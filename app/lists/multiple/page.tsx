'use client';
/**
 * Add/Edit Multiple List Entries — /lists/multiple?list=customers|vendors|items
 *
 * A spreadsheet-style grid: type directly, or copy cells in Excel / Google Sheets and paste them
 * into any cell (Ctrl+V). "Check" validates every row without saving; "Save" saves the whole grid
 * only when every row is valid (nothing is saved otherwise), and shows the problem on each row.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Table2, Plus, Trash2, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Card, Label, PageHeader, Select, Spinner, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { BULK_COLUMNS, type BulkList, parseTsv, pastedRowsToRecords } from '@/lib/lists/bulk';
import { cn } from '@/lib/utils';

type Row = Record<string, string> & { __key: string };
interface RowError {
  row: number;
  field?: string;
  message: string;
}
interface BulkResult {
  saved: boolean;
  dryRun: boolean;
  created: number;
  updated: number;
  errors: RowError[];
}

const LISTS: Array<{ value: BulkList; label: string }> = [
  { value: 'customers', label: 'Customers' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'items', label: 'Items' },
];

let keySeq = 0;
const newKey = () => `r${++keySeq}`;
const blankRow = (): Row => ({ __key: newKey() });

export default function AddEditMultiplePage() {
  const [list, setList] = useState<BulkList>('customers');
  const [mode, setMode] = useState<'add' | 'edit'>('add');
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 8 }, blankRow));
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [lastCheck, setLastCheck] = useState<BulkResult | null>(null);
  const columns = BULK_COLUMNS[list];

  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('list');
    if (k === 'customers' || k === 'vendors' || k === 'items') setList(k);
  }, []);

  const loadExisting = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ rows: Array<Record<string, string>> }>(`/api/${list}/bulk`);
      const loaded = data.rows.map((r) => ({ ...r, __key: newKey() }));
      setRows(loaded);
      setOriginal(Object.fromEntries(data.rows.map((r) => [r.id, JSON.stringify(r)])));
    } catch (err) {
      toastError(err, 'Could not load the list.');
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    setErrors([]);
    setLastCheck(null);
    if (mode === 'edit') void loadExisting();
    else {
      setRows(Array.from({ length: 8 }, blankRow));
      setOriginal({});
    }
  }, [list, mode, loadExisting]);

  function setCell(i: number, key: string, value: string) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  /** Paste a block from Excel starting at (rowIdx, colIdx); grows the grid as needed. */
  function onPaste(e: React.ClipboardEvent, rowIdx: number, colIdx: number) {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return; // single value: normal paste
    e.preventDefault();
    const parsed = parseTsv(text);
    const { records, usedHeader, mappedColumns } = pastedRowsToRecords(list, parsed, colIdx);
    setRows((prev) => {
      const next = [...prev];
      records.forEach((rec, k) => {
        const target = rowIdx + k;
        while (next.length <= target) next.push(blankRow());
        next[target] = { ...next[target], ...rec };
      });
      return next;
    });
    toast(
      `Pasted ${records.length} row${records.length === 1 ? '' : 's'}${usedHeader ? ` (matched columns: ${mappedColumns.length})` : ''}.`,
      'info',
    );
  }

  const payloadRows = useMemo(() => {
    const out: Array<{ index: number; data: Record<string, string> }> = [];
    rows.forEach((r, index) => {
      const { __key, ...data } = r;
      void __key;
      const hasContent = Object.entries(data).some(([k, v]) => k !== 'id' && (v ?? '').trim() !== '');
      if (!hasContent) return;
      if (mode === 'edit' && data.id && original[data.id] === JSON.stringify(rowWithoutKey(r, columns))) return; // unchanged
      out.push({ index, data });
    });
    return out;
  }, [rows, mode, original, columns]);

  async function submit(dryRun: boolean) {
    if (payloadRows.length === 0) {
      toast(mode === 'edit' ? 'Nothing has changed yet.' : 'Type or paste at least one row.', 'info');
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const res = await api.post<BulkResult>(`/api/${list}/bulk`, { rows: payloadRows.map((p) => p.data), dryRun });
      if (res.errors.length) {
        // Map batch row index back to grid row index.
        setErrors(res.errors.map((e) => ({ ...e, row: payloadRows[e.row]?.index ?? e.row })));
        setLastCheck(null);
        const n = new Set(res.errors.map((e) => e.row)).size;
        toast(`${n} row${n === 1 ? ' needs' : 's need'} fixing — nothing was saved.`, 'danger');
        return;
      }
      setLastCheck(res);
      if (dryRun) toast(`All ${payloadRows.length} rows look good.`, 'success');
      else {
        toast(`Saved: ${res.created} added, ${res.updated} updated.`, 'success');
        if (mode === 'edit') await loadExisting();
        else setRows(Array.from({ length: 8 }, blankRow));
      }
    } catch (err) {
      toastError(err, 'Could not save the rows.');
    } finally {
      setBusy(false);
    }
  }

  const errorsByRow = useMemo(() => {
    const m = new Map<number, RowError[]>();
    for (const e of errors) m.set(e.row, [...(m.get(e.row) ?? []), e]);
    return m;
  }, [errors]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Add/Edit Multiple List Entries" icon={Table2} />
      <Card className="p-6">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="bulk-list">List</Label>
            <Select id="bulk-list" value={list} onChange={(e) => setList(e.target.value as BulkList)} className="w-44">
              {LISTS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="bulk-mode">I want to</Label>
            <Select id="bulk-mode" value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'edit')} className="w-56">
              <option value="add">Add new entries</option>
              <option value="edit">Edit existing entries</option>
            </Select>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => submit(true)} loading={busy}>
              <CheckCircle2 className="h-4 w-4" /> Check rows
            </Button>
            <Button onClick={() => submit(false)} loading={busy}>
              Save all
            </Button>
          </div>
        </div>
        <p className="mb-4 text-sm text-navy/60">
          Tip: copy cells in Excel and paste them into the first cell — include the header row to match columns by name.
          Nothing is saved unless every row is correct. {mode === 'edit' && 'Only the rows you change are saved.'}
        </p>
        {lastCheck && !errors.length && (
          <p className="mb-3 text-sm text-emerald">
            {lastCheck.dryRun ? 'Check passed' : 'Saved'}: {lastCheck.created} to add, {lastCheck.updated} to update.
          </p>
        )}
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white px-2 text-left text-xs text-navy/40">#</th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      title={c.hint}
                      style={{ minWidth: c.width ?? 120 }}
                      className="border-b-2 border-navy/10 px-2 py-2 text-left font-semibold text-navy/70"
                    >
                      {c.label}
                      {c.required && <span className="text-red-500"> *</span>}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rowErrs = errorsByRow.get(i);
                  return (
                    <tr key={r.__key} className={cn(rowErrs && 'bg-red-50')}>
                      <td className="sticky left-0 bg-inherit px-2 text-xs text-navy/40">
                        {i + 1}
                        {rowErrs && (
                          <span className="block max-w-[14rem] whitespace-normal text-red-600" role="alert">
                            {rowErrs.map((e) => e.message).join(' ')}
                          </span>
                        )}
                      </td>
                      {columns.map((c, ci) => {
                        const bad = rowErrs?.some((e) => e.field === c.key);
                        const readOnly = mode === 'edit' && c.key === 'type' && !!r.id;
                        return (
                          <td key={c.key} className="border border-slate-100 p-0">
                            <input
                              aria-label={`${c.label}, row ${i + 1}`}
                              className={cn(
                                'w-full bg-transparent px-2 py-1.5 text-navy outline-none focus:bg-electric/5 focus:ring-2 focus:ring-electric/40',
                                bad && 'bg-red-100',
                                readOnly && 'text-navy/40',
                              )}
                              readOnly={readOnly}
                              value={r[c.key] ?? ''}
                              list={c.options ? `opts-${c.key}` : undefined}
                              onChange={(e) => setCell(i, c.key, e.target.value)}
                              onPaste={(e) => onPaste(e, i, ci)}
                            />
                          </td>
                        );
                      })}
                      <td className="px-1">
                        {(mode === 'add' || !r.id) && (
                          <button type="button" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
                            <Trash2 className="h-4 w-4 text-navy/30 hover:text-red-500" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {columns
              .filter((c) => c.options)
              .map((c) => (
                <datalist key={c.key} id={`opts-${c.key}`}>
                  {c.options!.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => setRows((prev) => [...prev, ...Array.from({ length: 5 }, blankRow)])}>
            <Plus className="h-4 w-4" /> Add rows
          </Button>
          <Badge tone="info">{payloadRows.length} row{payloadRows.length === 1 ? '' : 's'} to save</Badge>
        </div>
      </Card>
    </main>
  );
}

function rowWithoutKey(r: Row, columns: Array<{ key: string }>): Record<string, string> {
  const out: Record<string, string> = { id: r.id };
  void columns;
  for (const [k, v] of Object.entries(r)) if (k !== '__key') out[k] = v;
  return out;
}
