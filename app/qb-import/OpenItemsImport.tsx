'use client';

/**
 * Step 3 of "Migrate from QuickBooks": open invoices and unpaid bills as real documents.
 *
 * Upload QuickBooks' "Open Invoices" (Reports › Customers & Receivables) or "Unpaid Bills
 * Detail" (Reports › Vendors & Payables) exported to Excel / CSV / PDF — or type customer and
 * vendor balances by hand. A preview shows every document that will be created; importing
 * creates them and shows the proof that A/R and A/P still equal their aging reports.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Label, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { Help } from '@/components/Help';
import { api, ApiError } from '@/lib/client';

type Side = 'ar' | 'ap';
type Kind = 'invoice' | 'credit_memo' | 'bill' | 'vendor_credit';

interface OpenItem {
  kind: Kind;
  name: string;
  date: string;
  dueDate?: string | null;
  number?: string | null;
  qbType?: string | null;
  openBalance: string;
  exists?: boolean;
  nameFound?: boolean;
}

interface Preview {
  side: Side;
  items: OpenItem[];
  totals: { documents: string; credits: string; net: string };
  missingNames: string[];
  warnings: string[];
  controlAccount: { id: string; code: string; name: string; balance: string } | null;
  controlAccounts: Array<{ id: string; code: string; name: string; balance: string }>;
  alreadyInGlSuggested: boolean;
}

interface RecSide {
  control: string;
  aging: string;
  difference: string;
  inBalance: boolean;
}

interface ImportResult {
  invoices: number;
  bills: number;
  credits: number;
  skipped: number;
  issues: Array<{ name: string; reason: string; message: string }>;
  reconciliation: { ar: RecSide; ap: RecSide };
}

const KIND_LABEL: Record<Kind, string> = {
  invoice: 'Invoice',
  credit_memo: 'Credit',
  bill: 'Bill',
  vendor_credit: 'Vendor credit',
};

function fmt(v: string | number) {
  return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}

interface ManualRow {
  name: string;
  date: string;
  number: string;
  amount: string;
}

/**
 * Typed-in rows → open items. Amounts as a QuickBooks user types them: "1,250.00", "$1,250",
 * "-25" or "(25.00)" for a credit. Only the sign, brackets and "$" are taken off: the number goes
 * to the server as typed, which reads "1,250.00" and refuses a decimal comma ("12,50"). Stripping
 * commas and spaces here turned "12,50" into 1,250.00 and "1 250,00" into 125,000.00.
 */
export function manualOpenItems(manual: ManualRow[], side: Side) {
  return manual
    .filter((m) => m.name.trim() && m.amount.trim())
    .map((m) => {
      const typed = m.amount.trim();
      const credit = /^\(.*\)$|^[-]|[-]$|^\$\s*-/.test(typed);
      return {
        kind: (side === 'ar' ? (credit ? 'credit_memo' : 'invoice') : credit ? 'vendor_credit' : 'bill') as Kind,
        name: m.name.trim(),
        date: m.date,
        number: m.number.trim() || null,
        openBalance: typed.replace(/^\(\s*|\s*\)$/g, '').replace(/^-\s*|\s*-$/g, '').replace(/^\$\s*-?\s*/, '').trim(),
      };
    });
}

export function OpenItemsImport() {
  const [mode, setMode] = useState<'report' | 'manual'>('report');
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [side, setSide] = useState<'' | Side>('');
  const [manualSide, setManualSide] = useState<Side>('ar');
  const [manual, setManual] = useState<ManualRow[]>([{ name: '', date: '', number: '', amount: '' }]);
  const [alreadyInGl, setAlreadyInGl] = useState(true);
  const [controlId, setControlId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<{ ar: RecSide; ap: RecSide } | null>(null);

  useEffect(() => {
    api.get<{ ar: RecSide; ap: RecSide }>('/api/qb-import/open-items').then(setProof).catch(() => {});
  }, [result]);

  function body(action: 'preview' | 'import') {
    const base =
      mode === 'report'
        ? { file, side: side || undefined }
        : { side: manualSide, items: manualOpenItems(manual, manualSide) };
    const sideNow = mode === 'report' ? preview?.side ?? side : manualSide;
    return {
      action,
      ...base,
      alreadyInGl,
      ...(controlId ? (sideNow === 'ap' ? { apAccountId: controlId } : { arAccountId: controlId }) : {}),
    };
  }

  async function runPreview() {
    if (mode === 'report' && !file) {
      toast('Choose the report file first.', 'danger');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const p = await api.post<Preview>('/api/qb-import/open-items', body('preview'));
      setPreview(p);
      setAlreadyInGl(p.alreadyInGlSuggested);
      setControlId(p.controlAccount?.id ?? '');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read the report.', 'danger');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    try {
      const r = await api.post<ImportResult>('/api/qb-import/open-items', body('import'));
      setResult(r);
      toast(`Created ${r.invoices + r.bills + r.credits} documents${r.skipped ? `, ${r.skipped} skipped` : ''}.`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Import failed.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const newItems = preview?.items.filter((i) => !i.exists) ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-6 space-y-4">
        <p className="text-sm text-navy/70">
          Bring each customer&apos;s unpaid invoices and each vendor&apos;s unpaid bills over as real documents, so
          you can receive payments, pay bills and print statements right after the move. Your{' '}
          <Help term="ar">A/R</Help> and <Help term="ap">A/P</Help> totals do not change when your General Ledger
          is already imported — the documents only add the detail.
        </p>
        <div className="flex gap-2">
          <Button variant={mode === 'report' ? 'primary' : 'secondary'} onClick={() => { setMode('report'); setPreview(null); }}>
            From a QuickBooks report
          </Button>
          <Button variant={mode === 'manual' ? 'primary' : 'secondary'} onClick={() => { setMode('manual'); setPreview(null); }}>
            Type balances in
          </Button>
        </div>

        {mode === 'report' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Report file (Excel, CSV or PDF)</Label>
              <input
                type="file"
                accept=".xlsx,.csv,.pdf,.txt"
                className="block text-sm"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setFile({ name: f.name, data: await readBase64(f) });
                  setPreview(null);
                }}
              />
              <p className="mt-1 text-xs text-navy/50">
                In QuickBooks: Reports › Customers &amp; Receivables › Open Invoices, or Reports › Vendors &amp;
                Payables › Unpaid Bills Detail. Then Excel › Create New Worksheet (or Print › Save as PDF).
              </p>
            </div>
            <div>
              <Label>This report lists</Label>
              <Select value={side} onChange={(e) => setSide(e.target.value as '' | Side)}>
                <option value="">Work it out from the report</option>
                <option value="ar">What customers owe me (invoices)</option>
                <option value="ap">What I owe vendors (bills)</option>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="max-w-xs">
              <Label>Balances for</Label>
              <Select value={manualSide} onChange={(e) => setManualSide(e.target.value as Side)}>
                <option value="ar">Customers (what they owe me)</option>
                <option value="ap">Vendors (what I owe them)</option>
              </Select>
            </div>
            <p className="text-xs text-navy/50">One row per open invoice or bill. Use a minus sign for a credit.</p>
            {manual.map((m, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <Input aria-label="Name" placeholder={manualSide === 'ar' ? 'Customer' : 'Vendor'} value={m.name} onChange={(e) => setManual((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
                <Input aria-label="Date" type="date" value={m.date} onChange={(e) => setManual((rows) => rows.map((r, j) => (j === i ? { ...r, date: e.target.value } : r)))} />
                <Input aria-label="Number" placeholder="Number (optional)" value={m.number} onChange={(e) => setManual((rows) => rows.map((r, j) => (j === i ? { ...r, number: e.target.value } : r)))} />
                <Input aria-label="Amount" placeholder="Open balance" inputMode="decimal" value={m.amount} onChange={(e) => setManual((rows) => rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))} />
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setManual((rows) => [...rows, { name: '', date: '', number: '', amount: '' }])}>
              + Add a row
            </Button>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-navy">
          <input type="checkbox" className="mt-1" checked={alreadyInGl} onChange={(e) => setAlreadyInGl(e.target.checked)} />
          <span>
            My General Ledger history (step 2) already has these balances. Keep the totals as they are.
            <span className="block text-xs text-navy/50">
              Untick for a fresh start without history: the balances are then recorded against{' '}
              <Help term="opening-balance-equity">Opening Balance Equity</Help>.
            </span>
          </span>
        </label>

        <Button onClick={runPreview} loading={busy && !preview}>
          Check the balances
        </Button>
      </Card>

      {preview && (
        <Card className="p-6 space-y-4">
          <h3 className="text-lg font-bold text-navy">
            {preview.side === 'ar' ? 'Open invoices and credits' : 'Unpaid bills and credits'} found
          </h3>
          <div className="flex flex-wrap gap-6 text-sm">
            <span>Documents: <b>{fmt(preview.totals.documents)}</b></span>
            <span>Credits: <b>{fmt(preview.totals.credits)}</b></span>
            <span>Net: <b>{fmt(preview.totals.net)}</b></span>
          </div>
          {alreadyInGl && preview.controlAccounts.length > 0 && (
            <div className="max-w-md">
              <Label>Account that already holds this balance</Label>
              <Select value={controlId} onChange={(e) => setControlId(e.target.value)}>
                {preview.controlAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name} — {fmt(a.balance)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {preview.missingNames.length > 0 && (
            <p className="text-sm text-navy/70">
              New {preview.side === 'ar' ? 'customers' : 'vendors'} will be added: {preview.missingNames.join(', ')}.
            </p>
          )}
          {preview.warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-800">{w}</p>
          ))}
          <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-100">
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Number</Th>
                  <Th>Date</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Open balance</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it, i) => (
                  <Tr key={i}>
                    <Td>{it.name}</Td>
                    <Td>{KIND_LABEL[it.kind]}</Td>
                    <Td>{it.number ?? '—'}</Td>
                    <Td>{it.date}</Td>
                    <Td>{it.dueDate ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{fmt(it.openBalance)}</Td>
                    <Td>{it.exists ? <Badge tone="neutral">Already in</Badge> : <Badge tone="info">New</Badge>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <Button onClick={runImport} loading={busy} disabled={newItems.length === 0}>
            Create {newItems.length} document{newItems.length === 1 ? '' : 's'}
          </Button>
        </Card>
      )}

      {result && (
        <Card className="p-6 space-y-3">
          <h3 className="text-lg font-bold text-navy">Done</h3>
          <p className="text-sm text-navy/70">
            {result.invoices} invoices, {result.bills} bills and {result.credits} credits created; {result.skipped} skipped.
          </p>
          {result.issues.length > 0 && (
            <ul className="text-xs text-navy/70 list-disc pl-5 space-y-1">
              {result.issues.map((i, k) => (
                <li key={k}>
                  <b>{i.name}</b>: {i.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {proof && (
        <Card className="p-6 space-y-2">
          <h3 className="text-sm font-bold text-navy">Do the totals agree?</h3>
          {(['ar', 'ap'] as const).map((k) => (
            <p key={k} className="text-sm">
              <Badge tone={proof[k].inBalance ? 'success' : 'warning'}>{proof[k].inBalance ? 'In balance' : 'Check'}</Badge>{' '}
              {k === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'}: books {fmt(proof[k].control)} · aging report{' '}
              {fmt(proof[k].aging)}
              {!proof[k].inBalance && ` · difference ${fmt(proof[k].difference)}`}
            </p>
          ))}
          <p className="text-xs text-navy/50">
            A difference means some open invoices or bills have not been brought in yet (or the General Ledger has
            balances without documents).
          </p>
        </Card>
      )}
    </div>
  );
}
