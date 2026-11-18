'use client';
/**
 * Review a bank / credit card statement read from a PDF or scan before importing it
 * (lib/services/statementImport.ts). Every row can be corrected, removed or added, and the
 * statement's own opening and closing balances drive a live TIE-OUT: opening + rows = closing
 * (for a card, whose balance is what you owe, opening − rows = closing). Import is offered when
 * it ties; otherwise only after ticking "Import anyway", which is recorded in the audit trail.
 *
 * When OCR misses or misreads rows: ± flips one row's sign, "Flip all signs" every row's, and
 * "Fix with AI" (POST /api/import/statement-assist) has the company's AI compare the rows with the
 * statement text and the person's note — its corrections replace the rows on screen, with Undo.
 */
import { useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import { ArrowUpDown, CheckCircle2, Plus, Sparkles, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { Badge, Button, Input, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { tieOut, type StatementKind, type StatementRow } from '@/lib/statements/parse';

export interface StatementExtract {
  kind: 'statement';
  statementKind: StatementKind;
  rows: StatementRow[];
  openingBalance: string | null;
  closingBalance: string | null;
  period: { start: string; end: string } | null;
  warnings: string[];
  method: 'text' | 'ocr' | 'ai';
  pages: number;
  /** The statement text as read, for "Fix with AI". */
  text?: string;
}

/** What "Fix with AI" returns (lib/services/statementImport.ts assistStatement). */
interface AssistResult {
  rows: StatementRow[];
  openingBalance: string | null;
  closingBalance: string | null;
  notes: string;
}

export interface ReviewedStatement {
  rows: Array<{ date: string; description: string; amount: string; payee?: string | null }>;
  openingBalance: string;
  closingBalance: string;
  acknowledgeDifference: boolean;
}

interface EditRow {
  key: number;
  date: string;
  description: string;
  payee: string;
  amount: string;
  flagged: boolean;
}

const METHOD_LABEL = { text: 'Read from the PDF text', ocr: 'Read with offline OCR', ai: 'Read by your AI' } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An amount as typed on the review screen, as the 2-decimal string the import checks ("2500" →
 * "2500.00", "$1,234.56" → "1234.56", "(45.00)" → "-45.00"), or null when it is not an amount.
 * The server ties the statement out with amounts written to the cent (lib/statements/parse.ts
 * parseMoney): a balance typed as "2500" tied out on screen but was refused on import as
 * "missing", and "1,234.56" (as statements print it) counted as missing on screen.
 */
export function statementAmount(raw: string): string | null {
  let t = raw.replace(/[\s ]/g, '');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-') || t.startsWith('+')) {
    if (t[0] === '-') neg = !neg;
    t = t.slice(1);
  }
  t = t.replace(/^\$/, '');
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  }
  if (!/^((\d{1,3}(,\d{3})+|\d+)(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const d = new Decimal(t.replace(/,/g, '').replace(/\.$/, ''));
  if (d.isZero()) return '0.00';
  return (neg ? d.negated() : d).toFixed(2);
}

export interface ReviewRow {
  date: string;
  description: string;
  payee: string;
  amount: string;
}

/** The amount with its sign flipped ("-42.10" ↔ "42.10"); text that isn't an amount is left as it is. */
export function flipSign(raw: string): string {
  const a = statementAmount(raw);
  if (a === null || a === '0.00') return raw;
  return a.startsWith('-') ? a.slice(1) : `-${a}`;
}

/** The rows that can be imported: a real date and a non-zero amount. */
export function importableRows<R extends ReviewRow>(rows: R[]): R[] {
  return rows.filter((r) => {
    const a = statementAmount(r.amount);
    return DATE_RE.test(r.date) && a !== null && a !== '0.00';
  });
}

/** What Import sends: every amount and both balances as checked on screen (2 decimals). */
export function reviewedPayload(
  rows: ReviewRow[],
  opening: string,
  closing: string,
  kind: StatementKind,
  ack: boolean,
): ReviewedStatement {
  const valid = importableRows(rows);
  const o = statementAmount(opening);
  const c = statementAmount(closing);
  const t = tieOut(valid.map((r) => ({ amount: statementAmount(r.amount)! })), o, c, kind);
  return {
    rows: valid.map((r) => ({ date: r.date, description: r.description.trim(), amount: statementAmount(r.amount)!, payee: r.payee.trim() || null })),
    openingBalance: o ?? opening.trim(),
    closingBalance: c ?? closing.trim(),
    acknowledgeDifference: !t.ok && ack,
  };
}

export function StatementReview({
  extract,
  bankAccountId,
  importing,
  onImport,
  onCancel,
}: {
  extract: StatementExtract;
  /** The bank account the statement is for ("Fix with AI" reads it as a bank or card statement). */
  bankAccountId?: string;
  importing: boolean;
  onImport: (reviewed: ReviewedStatement) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<EditRow[]>(() =>
    extract.rows.map((r, i) => ({
      key: i,
      date: r.date,
      description: r.description,
      payee: '',
      amount: r.amount,
      flagged: r.signFrom === 'guess' || r.signFrom === 'ai',
    })),
  );
  const [opening, setOpening] = useState(extract.openingBalance ?? '');
  const [closing, setClosing] = useState(extract.closingBalance ?? '');
  const [ack, setAck] = useState(false);
  // "Fix with AI": the note, the run, the AI's account of its changes, and what Undo restores.
  const [aiNote, setAiNote] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotes, setAiNotes] = useState<string | null>(null);
  const [beforeAi, setBeforeAi] = useState<{ rows: EditRow[]; opening: string; closing: string } | null>(null);

  const validRows = importableRows(rows);
  const t = useMemo(
    () =>
      tieOut(
        validRows.map((r) => ({ amount: statementAmount(r.amount)! })),
        statementAmount(opening),
        statementAmount(closing),
        extract.statementKind,
      ),
    [validRows, opening, closing, extract.statementKind],
  );
  const invalid = rows.length - validRows.length;

  function update(key: number, patch: Partial<EditRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch, flagged: patch.amount !== undefined ? false : r.flagged } : r)));
    setAck(false);
  }

  async function fixWithAi() {
    if (!bankAccountId) return;
    setAiBusy(true);
    try {
      const res = await api.post<AssistResult>('/api/import/statement-assist', {
        bankAccountId,
        text: extract.text ?? '',
        rows: rows.map((r) => ({ date: r.date, description: r.description, amount: statementAmount(r.amount) ?? r.amount })),
        openingBalance: statementAmount(opening),
        closingBalance: statementAmount(closing),
        instruction: aiNote.trim() || null,
      });
      setBeforeAi({ rows, opening, closing });
      // Payees typed so far stay on rows the AI kept (same date, description and amount).
      const payeeOf = new Map(rows.filter((r) => r.payee).map((r) => [`${r.date}|${r.description}|${statementAmount(r.amount)}`, r.payee]));
      setRows(
        res.rows.map((r, i) => ({
          key: i,
          date: r.date,
          description: r.description,
          payee: payeeOf.get(`${r.date}|${r.description}|${r.amount}`) ?? '',
          amount: r.amount,
          flagged: true,
        })),
      );
      setOpening(res.openingBalance ?? '');
      setClosing(res.closingBalance ?? '');
      setAiNotes(res.notes || 'Done.');
      setAck(false);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The AI could not check this statement.', 'danger');
    } finally {
      setAiBusy(false);
    }
  }

  function undoAi() {
    if (!beforeAi) return;
    setRows(beforeAi.rows);
    setOpening(beforeAi.opening);
    setClosing(beforeAi.closing);
    setBeforeAi(null);
    setAiNotes(null);
    setAck(false);
  }

  const card = extract.statementKind === 'card';
  return (
    <div className="flex flex-col gap-4 p-4 rounded-lg bg-slate-50 border border-slate-200" data-statement-review>
      <div className="flex flex-wrap items-center gap-2 text-sm text-navy/70">
        <Badge tone={extract.method === 'ai' ? 'warning' : 'info'}>{METHOD_LABEL[extract.method]}</Badge>
        <span>
          {extract.pages} page{extract.pages === 1 ? '' : 's'} · {rows.length} row{rows.length === 1 ? '' : 's'}
          {extract.period ? ` · ${extract.period.start} to ${extract.period.end}` : ''}
        </span>
        <span className="text-navy/50">
          {card ? 'Purchases and fees are negative; payments and credits positive.' : 'Deposits are positive; checks and withdrawals negative.'}
        </span>
      </div>

      {extract.warnings.length > 0 && (
        <ul className="text-xs text-amber-700 list-disc pl-5">
          {extract.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {bankAccountId && (
        <div className="flex flex-col gap-2 rounded-lg border border-electric/20 bg-white p-3" data-statement-ai>
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-electric" aria-hidden />
            <span className="text-sm font-semibold text-navy">AI help</span>
            <span className="text-xs text-navy/50">
              Missing rows, misread amounts, wrong signs or balances? Your AI checks the rows against the statement text.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="What is wrong (optional)"
              className="flex-1 min-w-[240px]"
              value={aiNote}
              onChange={(e) => setAiNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!aiBusy) void fixWithAi();
                }
              }}
              placeholder="What's wrong? (optional) e.g. “the ending balance is 5,560.65” or “row 4 is a deposit”"
            />
            <Button type="button" size="sm" loading={aiBusy} onClick={() => void fixWithAi()}>
              <Sparkles className="h-4 w-4" aria-hidden /> Fix with AI
            </Button>
            {beforeAi && (
              <Button type="button" size="sm" variant="secondary" onClick={undoAi} disabled={aiBusy}>
                <Undo2 className="h-4 w-4" aria-hidden /> Undo AI changes
              </Button>
            )}
          </div>
          {aiNotes && (
            <p className="text-xs text-navy/70" role="status">
              <b>AI:</b> {aiNotes} Rows the AI returned are highlighted — check them against the statement.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
        <div>
          <label htmlFor="stmt-opening" className="block text-xs font-medium text-navy/70 mb-1">
            {card ? 'Previous balance (owed)' : 'Beginning balance'}
          </label>
          <Input id="stmt-opening" inputMode="decimal" value={opening} onChange={(e) => { setOpening(e.target.value); setAck(false); }} placeholder="0.00" />
        </div>
        <div>
          <label htmlFor="stmt-closing" className="block text-xs font-medium text-navy/70 mb-1">
            {card ? 'New balance (owed)' : 'Ending balance'}
          </label>
          <Input id="stmt-closing" inputMode="decimal" value={closing} onChange={(e) => { setClosing(e.target.value); setAck(false); }} placeholder="0.00" />
        </div>
        <div
          role="status"
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${t.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
        >
          {t.ok ? <CheckCircle2 className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
          {t.ok
            ? `Ties out: rows total ${formatCurrency(t.extracted)}`
            : t.difference === null
              ? 'Enter both balances to tie out'
              : `Off by ${formatCurrency(t.difference)} (rows ${formatCurrency(t.extracted)}, statement ${formatCurrency(t.expected ?? '0')})`}
        </div>
      </div>

      <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-slate-200 bg-white">
        <Table>
          <thead className="sticky top-0 bg-white z-10">
            <Tr>
              <Th>Date</Th>
              <Th>Description</Th>
              <Th>Payee (optional)</Th>
              <Th numeric>Amount</Th>
              <Th className="w-8">
                <span className="sr-only">Flip sign</span>
              </Th>
              <Th className="w-10" />
            </Tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.key} className={r.flagged ? 'bg-amber-50' : undefined}>
                <Td>
                  <Input aria-label="Date" type="date" value={r.date} onChange={(e) => update(r.key, { date: e.target.value })} className="min-w-[140px]" />
                </Td>
                <Td>
                  <Input aria-label="Description" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
                </Td>
                <Td>
                  <Input aria-label="Payee" value={r.payee} onChange={(e) => update(r.key, { payee: e.target.value })} />
                </Td>
                <Td numeric>
                  <Input
                    aria-label="Amount"
                    inputMode="decimal"
                    value={r.amount}
                    onChange={(e) => update(r.key, { amount: e.target.value })}
                    title={r.flagged ? 'Check the sign: money in is positive, money out negative.' : undefined}
                    className="w-28 text-right"
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    aria-label="Flip sign (money in ↔ money out)"
                    title="Flip sign (money in ↔ money out)"
                    onClick={() => update(r.key, { amount: flipSign(r.amount) })}
                    className="text-navy/40 hover:text-electric"
                  >
                    <ArrowUpDown className="h-4 w-4" />
                  </button>
                </Td>
                <Td>
                  <button
                    type="button"
                    aria-label="Remove row"
                    onClick={() => {
                      setRows((prev) => prev.filter((x) => x.key !== r.key));
                      setAck(false); // "Import anyway" was for the difference before this change
                    }}
                    className="text-red-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setRows((prev) => [
              ...prev,
              { key: Math.max(0, ...prev.map((x) => x.key)) + 1, date: extract.period?.end ?? '', description: '', payee: '', amount: '', flagged: false },
            ]);
            setAck(false);
          }}
        >
          <Plus className="h-4 w-4" /> Add a row
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={rows.length === 0}
          onClick={() => {
            setRows((prev) => prev.map((r) => ({ ...r, amount: flipSign(r.amount), flagged: false })));
            setAck(false);
          }}
          title="Money in becomes money out and the other way round, on every row"
        >
          <ArrowUpDown className="h-4 w-4" /> Flip all signs
        </Button>
        {invalid > 0 && <span className="text-xs text-red-600">{invalid} row{invalid === 1 ? ' needs' : 's need'} a date and a non-zero amount.</span>}
        {!t.ok && (
          <label className="flex items-center gap-2 text-sm text-navy/80">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="rounded border-slate-300" />
            Import anyway — I&apos;ll find the difference later
          </label>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={importing}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={importing}
            disabled={invalid > 0 || validRows.length === 0 || (!t.ok && !ack)}
            onClick={() => onImport(reviewedPayload(rows, opening, closing, extract.statementKind, ack))}
          >
            Import {validRows.length} row{validRows.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default StatementReview;
