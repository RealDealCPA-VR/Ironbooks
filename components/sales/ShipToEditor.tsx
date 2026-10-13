'use client';
/**
 * Customer "Ship To" addresses (QB Enterprise: several named addresses, one default).
 * Used on the customer form; sales forms offer them in their Ship To dropdown.
 */
import * as React from 'react';
import { PlusCircle, Trash2 } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui';
import type { ShipToAddress } from '@/lib/shipTo';

export interface ShipToRow {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  isDefault: boolean;
}

export function shipToRowsFrom(list: ShipToAddress[] | null | undefined): ShipToRow[] {
  return (list ?? []).map((a) => ({
    name: a.name ?? '',
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    zip: a.zip ?? '',
    country: a.country ?? '',
    isDefault: a.isDefault === true,
  }));
}

/** Request body value (blank rows dropped; the server names / defaults the rest). */
export function shipToRowsPayload(rows: ShipToRow[]): ShipToAddress[] {
  return rows
    .filter((r) => [r.name, r.line1, r.line2, r.city, r.state, r.zip, r.country].some((v) => v.trim()))
    .map((r) => {
      const out: ShipToAddress = { name: r.name.trim(), isDefault: r.isDefault };
      for (const k of ['line1', 'line2', 'city', 'state', 'zip', 'country'] as const) {
        if (r[k].trim()) out[k] = r[k].trim();
      }
      return out;
    });
}

const blankRow = (n: number, isDefault: boolean): ShipToRow => ({
  name: `Ship To ${n}`,
  line1: '',
  line2: '',
  city: '',
  state: '',
  zip: '',
  country: '',
  isDefault,
});

export function ShipToEditor({ rows, onChange }: { rows: ShipToRow[]; onChange: (rows: ShipToRow[]) => void }) {
  const set = (i: number, patch: Partial<ShipToRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : patch.isDefault ? { ...r, isDefault: false } : r)));
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    if (next.length > 0 && !next.some((r) => r.isDefault)) next[0] = { ...next[0], isDefault: true };
    onChange(next);
  };
  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">Ship To addresses</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...rows, blankRow(rows.length + 1, rows.length === 0)])}
        >
          <PlusCircle className="h-4 w-4" /> Add address
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-navy/50">
          No ship-to address yet. Invoices, sales orders, sales receipts and estimates fill in the
          default one for you.
        </p>
      )}
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-slate-100 p-3">
            <div className="mb-2 flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[10rem]">
                <Label htmlFor={`shipto-name-${i}`}>Address name</Label>
                <Input
                  id={`shipto-name-${i}`}
                  maxLength={41}
                  value={r.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </div>
              <label className="mb-2 flex items-center gap-2 text-sm text-navy/80">
                <input
                  type="radio"
                  name="shipto-default"
                  checked={r.isDefault}
                  onChange={() => set(i, { isDefault: true })}
                />
                Default
              </label>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${r.name || 'address'}`}
                onClick={() => remove(i)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
              <Input className="sm:col-span-3" placeholder="Street" aria-label="Street" value={r.line1} onChange={(e) => set(i, { line1: e.target.value })} />
              <Input className="sm:col-span-3" placeholder="Suite / line 2" aria-label="Line 2" value={r.line2} onChange={(e) => set(i, { line2: e.target.value })} />
              <Input className="sm:col-span-2" placeholder="City" aria-label="City" value={r.city} onChange={(e) => set(i, { city: e.target.value })} />
              <Input className="sm:col-span-1" placeholder="State" aria-label="State" value={r.state} onChange={(e) => set(i, { state: e.target.value })} />
              <Input className="sm:col-span-1" placeholder="ZIP" aria-label="ZIP" value={r.zip} onChange={(e) => set(i, { zip: e.target.value })} />
              <Input className="sm:col-span-2" placeholder="Country" aria-label="Country" value={r.country} onChange={(e) => set(i, { country: e.target.value })} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
