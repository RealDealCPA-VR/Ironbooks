'use client';

/**
 * "Fonts & Numbers" (QB Customize Report): how amounts look on screen and on paper.
 * The choice is remembered per person in this browser (localStorage, best effort) and saved
 * with a memorized report.
 */
import { useEffect, useState } from 'react';
import { Label, Select } from '@/components/ui';
import { DEFAULT_NUMBER_FORMAT, formatAmount, normalizeNumberFormat, type NumberFormat } from '@/lib/reports/format';

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
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[#2563eb]" />
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
