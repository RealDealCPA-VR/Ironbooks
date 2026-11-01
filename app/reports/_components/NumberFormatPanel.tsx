'use client';

/**
 * "Fonts & Numbers" (QB Customize Report): how amounts look on screen and on paper.
 * The choice is remembered per person in this browser (localStorage, best effort) and saved
 * with a memorized report.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { Label, Select } from '@/components/ui';
import { Type } from 'lucide-react';
import { DEFAULT_NUMBER_FORMAT, FONT_CLASS, FONT_SIZE_CLASS, formatAmount, normalizeNumberFormat, type NumberFormat } from '@/lib/reports/format';

const STORAGE_KEY = 'bk.reports.numberFormat';

export function useNumberFormat(initial?: unknown) {
  const [format, setFormat] = useState<NumberFormat>(() => normalizeNumberFormat(initial));
  useEffect(() => {
    if (initial) {
      setFormat(normalizeNumberFormat(initial));
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setFormat(normalizeNumberFormat(JSON.parse(raw)));
    } catch {
      /* storage unavailable — defaults */
    }
  }, [initial]);
  const update = (next: NumberFormat) => {
    setFormat(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return [format, update] as const;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-navy cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-electric" />
      {label}
    </label>
  );
}

export default function NumberFormatPanel({ format, onChange }: { format: NumberFormat; onChange: (f: NumberFormat) => void }) {
  const set = <K extends keyof NumberFormat>(k: K, v: NumberFormat[K]) => onChange({ ...format, [k]: v });
  const sample = formatAmount('-1234567.89', format);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm max-w-3xl">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-navy/50">Numbers</p>
          <Check label="Thousands separators (1,000)" checked={format.thousands} onChange={(v) => set('thousands', v)} />
          <Check label="Without cents" checked={format.withoutCents} onChange={(v) => set('withoutCents', v)} />
          <Check label="Divide by 1,000" checked={format.divideBy1000} onChange={(v) => set('divideBy1000', v)} />
          <Check label="Hide zero amounts" checked={format.hideZero} onChange={(v) => set('hideZero', v)} />
          <Check label="Show $ sign" checked={format.currencySymbol} onChange={(v) => set('currencySymbol', v)} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-navy/50">Negative numbers</p>
          <Select aria-label="Negative number style" value={format.negative} onChange={(e) => set('negative', e.target.value as NumberFormat['negative'])}>
            <option value="minus">-300.00</option>
            <option value="parens">(300.00)</option>
            <option value="trailing">300.00-</option>
          </Select>
          <Check label="In red" checked={format.redNegatives} onChange={(v) => set('redNegatives', v)} />
          <p className="text-xs text-navy/50">
            Example:{' '}
            <span className={sample.negative && format.redNegatives ? 'text-red-600 font-semibold' : 'font-semibold'}>{sample.text}</span>
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-navy/50">Font</p>
          <div>
            <Label htmlFor="rf-font">Typeface</Label>
            <Select id="rf-font" value={format.font} onChange={(e) => set('font', e.target.value as NumberFormat['font'])}>
              <option value="sans">Sans serif</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="rf-size">Size</Label>
            <Select id="rf-size" value={format.fontSize} onChange={(e) => set('fontSize', e.target.value as NumberFormat['fontSize'])}>
              <option value="sm">Small</option>
              <option value="md">Normal</option>
              <option value="lg">Large</option>
            </Select>
          </div>
          <button type="button" className="text-xs text-electric hover:underline" onClick={() => onChange(DEFAULT_NUMBER_FORMAT)}>
            Reset to standard
          </button>
        </div>
      </div>
    </div>
  );
}

/** An amount as the pages hold it: a decimal string, a number or a Decimal. */
type AmountValue = string | number | { toFixed(dp: number): string } | null | undefined;
const amountText = (v: NonNullable<AmountValue>): string => (typeof v === 'string' ? v : v.toFixed(2));

/**
 * Fonts & Numbers on a report page that is not on the standard engine (1099 summary, combined
 * company reports, reconciliation reports, Report Builder, Find): the same remembered format as
 * every standard report. `money(v)` renders one amount with it; `tableClass` is the font.
 */
export function useReportNumbers() {
  const [format, setFormat] = useNumberFormat();
  const [open, setOpen] = useState(false);
  const money = (v: AmountValue): React.ReactNode => {
    if (v === null || v === undefined || v === '') return '';
    const f = formatAmount(amountText(v), format);
    return f.negative && format.redNegatives ? <span className="text-red-600">{f.text}</span> : f.text;
  };
  const tableClass = `${FONT_CLASS[format.font]} ${FONT_SIZE_CLASS[format.fontSize]}`;
  const button = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-electric/5 print-hidden"
    >
      <Type className="h-4 w-4" aria-hidden="true" /> Fonts &amp; numbers
    </button>
  );
  const panel = open ? (
    <div className="mb-4 print-hidden">
      <NumberFormatPanel format={format} onChange={setFormat} />
    </div>
  ) : null;
  return { format, money, tableClass, button, panel };
}

/** The page's amount formatter for its sub-components (MoneyProvider value = useReportNumbers().money). */
const MoneyContext = createContext<(v: AmountValue) => React.ReactNode>((v) =>
  v === null || v === undefined || v === '' ? '' : formatAmount(amountText(v), DEFAULT_NUMBER_FORMAT).text,
);
export const MoneyProvider = MoneyContext.Provider;
export function useMoney() {
  return useContext(MoneyContext);
}
