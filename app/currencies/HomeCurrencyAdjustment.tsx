'use client';
/**
 * Home Currency Adjustment (p1 fx) — QB Company > Manage Currency > Home Currency Adjustment.
 *
 * Pick a date, confirm (or type) the exchange rate for each foreign currency, see what each
 * foreign bank / card account, customer, vendor and loan is revalued by, then post. A/R, A/P and
 * loan amounts reverse automatically the next day. Past adjustments can be voided.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Label, Modal, Table, Th, Td, Tr, Badge, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/dates';

interface CurrencyLite {
  code: string;
  name: string;
  rateToBase: string;
  isBase: boolean;
}

interface HcaLine {
  kind: 'account' | 'customer' | 'vendor' | 'loan';
  accountName: string;
  entityName: string | null;
  currency: string;
  foreignBalance: string;
  homeBalance: string;
  newHomeBalance: string;
  gainLoss: string;
  reversible: boolean;
}

interface HcaPreview {
  date: string;
  homeCurrency: string | null;
  lines: HcaLine[];
  total: string;
}

interface HcaRow {
  id: string;
  date: string;
  memo: string | null;
  total: string;
  rates: Record<string, string>;
  voidedAt: string | null;
}

const KIND_LABEL: Record<HcaLine['kind'], string> = {
  account: 'Bank / card',
  customer: 'Customer',
  vendor: 'Vendor',
  loan: 'Loan',
};

const money = (v: string) =>
  Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HomeCurrencyAdjustmentModal({
  open,
  onClose,
  onPosted,
  currencies,
}: {
  open: boolean;
  onClose: () => void;
  onPosted: () => void;
  currencies: CurrencyLite[];
}) {
  const foreign = currencies.filter((c) => !c.isBase);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rates, setRates] = useState<Record<string, string>>({});
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState<HcaPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setMemo('');
    setRates(Object.fromEntries(foreign.map((c) => [c.code, String(Number(c.rateToBase))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function run(post: boolean) {
    if (!date) {
      toast('Pick the date of the adjustment.', 'danger');
      return;
    }
    setBusy(true);
    try {
      const body = { date, rates, memo: memo.trim() || null, preview: !post };
      if (post) {
        await api.post('/api/currencies/home-currency-adjustment', body);
        toast('Home currency adjustment posted.', 'success');
        onPosted();
        onClose();
      } else {
        setPreview(await api.post<HcaPreview>('/api/currencies/home-currency-adjustment', body));
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not calculate the adjustment.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const home = preview?.homeCurrency ?? currencies.find((c) => c.isBase)?.code ?? '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Home Currency Adjustment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => run(false)} loading={busy && !preview}>Calculate</Button>
          <Button onClick={() => run(true)} disabled={!preview || preview.lines.length === 0} loading={busy && !!preview}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-navy/60">
          Revalue your foreign-currency bank and card accounts, customer and vendor balances and loans
          to {home || 'your home currency'} at the rates below. The difference is an unrealized exchange
          gain or loss. Customer, vendor and loan amounts are reversed the next day, so the gain or loss
          is counted only once when they are paid.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="hca-date">As of</Label>
            <Input id="hca-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); }} />
          </div>
          <div>
            <Label htmlFor="hca-memo">Memo (optional)</Label>
            <Input id="hca-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Month-end revaluation" />
          </div>
        </div>
        {foreign.length === 0 ? (
          <p className="text-sm text-navy/60">Add a foreign currency first.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {foreign.map((c) => (
              <div key={c.code}>
                <Label htmlFor={`hca-rate-${c.code}`}>1 {c.code} = ? {home}</Label>
                <Input
                  id={`hca-rate-${c.code}`}
                  type="number"
                  step="0.00000001"
                  min="0.00000001"
                  value={rates[c.code] ?? ''}
                  onChange={(e) => { setRates({ ...rates, [c.code]: e.target.value }); setPreview(null); }}
                />
              </div>
            ))}
          </div>
        )}
        {preview && (
          preview.lines.length === 0 ? (
            <p className="text-sm text-navy/60">Nothing to adjust — every foreign balance is already at these rates.</p>
          ) : (
            <div className="max-h-80 overflow-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Type</Th>
                    <Th>Name / account</Th>
                    <Th numeric>Foreign balance</Th>
                    <Th numeric>Now ({home})</Th>
                    <Th numeric>New ({home})</Th>
                    <Th numeric>Gain / loss</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l, i) => (
                    <Tr key={i}>
                      <Td>{KIND_LABEL[l.kind]}</Td>
                      <Td>{l.entityName ?? l.accountName}</Td>
                      <Td numeric>{money(l.foreignBalance)} {l.currency}</Td>
                      <Td numeric>{money(l.homeBalance)}</Td>
                      <Td numeric>{money(l.newHomeBalance)}</Td>
                      <Td numeric className={Number(l.gainLoss) < 0 ? 'text-red-600' : 'text-emerald-700'}>{money(l.gainLoss)}</Td>
                    </Tr>
                  ))}
                  <Tr>
                    <Td className="font-semibold">Total</Td>
                    <Td />
                    <Td />
                    <Td />
                    <Td />
                    <Td numeric className="font-semibold">{money(preview.total)}</Td>
                  </Tr>
                </tbody>
              </Table>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}

/** Past Home Currency Adjustments with Void. */
export function HomeCurrencyAdjustmentHistory({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<HcaRow[]>([]);
  const load = useCallback(() => {
    api.get<HcaRow[]>('/api/currencies/home-currency-adjustment').then(setRows).catch(() => {/* non-fatal */});
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function voidRow(id: string) {
    if (!confirm('Void this home currency adjustment and its reversal?')) return;
    try {
      await api.del(`/api/currencies/home-currency-adjustment/${id}`);
      toast('Adjustment voided.', 'success');
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not void the adjustment.', 'danger');
    }
  }

  if (rows.length === 0) return null;
  return (
    <Card className="mt-6 p-0 overflow-hidden">
      <h2 className="text-base font-bold text-navy px-5 pt-4 pb-2">Home currency adjustments</h2>
      <Table>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Rates</Th>
            <Th>Memo</Th>
            <Th numeric>Gain / loss</Th>
            <Th>Status</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td>{formatDate(r.date)}</Td>
              <Td className="text-xs text-navy/60">
                {Object.entries(r.rates).map(([k, v]) => `${k} ${Number(v)}`).join(', ')}
              </Td>
              <Td>{r.memo ?? ''}</Td>
              <Td numeric>{money(r.total)}</Td>
              <Td>{r.voidedAt ? <Badge tone="neutral">Void</Badge> : <Badge tone="success">Posted</Badge>}</Td>
              <Td className="text-right">
                {!r.voidedAt && (
                  <Button variant="ghost" size="sm" onClick={() => voidRow(r.id)}>Void</Button>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
