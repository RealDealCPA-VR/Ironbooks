'use client';
/**
 * Line-item grid for simple sales forms (estimates, sales orders) with advanced pricing:
 * picking an item fills its description and asks the server pricing engine for the price
 * (price rules / price levels / customer prices); the rate field shows which rule applied and
 * can be typed over (a manual override that later quotes never replace).
 */
import { useEffect, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AmountInput, Button, Input, Select, useGridKeys } from '@/components/ui';
import { formatCurrency } from '@/lib/money';
import { usePriceQuotes, samePrice, type QuoteHeader } from '@/lib/usePriceQuotes';
import { PriceSourceBadge } from '@/components/PriceSourceBadge';

export interface PricedLineItem {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  salesPrice: string | null;
  taxable?: boolean;
  isActive?: boolean;
}

export interface PricedLineValue {
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  /** The user typed the rate — automatic prices leave it alone. */
  rateManual?: boolean;
}

const SPECIAL = new Set(['discount', 'subtotal', 'payment', 'sales_tax']);

export function emptyPricedLine(): PricedLineValue {
  return { itemId: '', description: '', quantity: '1', rate: '', taxable: true, rateManual: false };
}

export function PricedLinesEditor({
  items,
  lines,
  onChange,
  header,
  showTaxable = false,
}: {
  items: PricedLineItem[];
  lines: PricedLineValue[];
  onChange: (lines: PricedLineValue[]) => void;
  header: QuoteHeader;
  showTaxable?: boolean;
}) {
  const latest = useRef(lines);
  latest.current = lines;
  const sellable = items.filter((i) => i.isActive !== false && !SPECIAL.has(i.type));
  const byId = new Map(items.map((i) => [i.id, i]));

  const quotes = usePriceQuotes(
    header,
    lines.map((l) => ({ itemId: l.itemId || null, quantity: l.quantity || '1' })),
  );
  useEffect(() => {
    let changed = false;
    const next = latest.current.map((l, i) => {
      const q = quotes[i];
      if (!q || l.rateManual || l.itemId !== q.itemId || samePrice(l.rate, q.price)) return l;
      changed = true;
      return { ...l, rate: String(Number(q.price)) };
    });
    if (changed) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes]);

  function patch(idx: number, p: Partial<PricedLineValue>) {
    const next = [...latest.current];
    next[idx] = { ...next[idx], ...p };
    onChange(next);
  }
  function pickItem(idx: number, itemId: string) {
    const it = byId.get(itemId);
    patch(idx, {
      itemId,
      description: it ? (it.description || it.name) : latest.current[idx].description,
      rate: it ? (it.salesPrice ?? '0') : latest.current[idx].rate,
      taxable: it ? it.taxable !== false : latest.current[idx].taxable,
      rateManual: false,
    });
  }
  const addLine = () => onChange([...latest.current, emptyPricedLine()]);
  const removeLine = (idx: number) => {
    if (latest.current.length > 1) onChange(latest.current.filter((_, i) => i !== idx));
  };
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine });

  return (
    <div onKeyDown={grid.onKeyDown}>
      <div className="grid grid-cols-12 gap-2 text-xs font-semibold text-navy/50 mb-2">
        <div className="col-span-3">Item</div>
        <div className={showTaxable ? 'col-span-3' : 'col-span-4'}>Description</div>
        <div className="col-span-1">Qty</div>
        <div className="col-span-2">Rate</div>
        {showTaxable && <div className="col-span-1 text-center">Tax</div>}
        <div className="col-span-2 text-right">Amount</div>
      </div>
      {lines.map((line, idx) => {
        const amount = (parseFloat(line.quantity) || 0) * (parseFloat(line.rate) || 0);
        return (
          <div key={idx} data-grid-row className="grid grid-cols-12 gap-2 items-start mb-2">
            <div className="col-span-3">
              <Select value={line.itemId} onChange={(e) => pickItem(idx, e.target.value)} aria-label="Item">
                <option value="">— No item —</option>
                {sellable.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className={showTaxable ? 'col-span-3' : 'col-span-4'}>
              <Input
                placeholder="Description"
                value={line.description}
                onChange={(e) => patch(idx, { description: e.target.value })}
              />
            </div>
            <div className="col-span-1">
              <AmountInput
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => patch(idx, { quantity: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <AmountInput
                placeholder="Rate"
                value={line.rate}
                onChange={(e) => patch(idx, { rate: e.target.value, rateManual: true })}
              />
              {line.itemId && (
                <PriceSourceBadge
                  quote={quotes[idx]}
                  rate={line.rate}
                  onUseQuoted={(p) => patch(idx, { rate: String(Number(p)), rateManual: false })}
                />
              )}
            </div>
            {showTaxable && (
              <div className="col-span-1 flex justify-center pt-2">
                <input
                  type="checkbox"
                  checked={line.taxable}
                  onChange={(e) => patch(idx, { taxable: e.target.checked })}
                  className="accent-electric"
                  aria-label="Taxable line"
                />
              </div>
            )}
            <div className="col-span-1 pt-2 text-right text-sm tabular-nums text-navy font-semibold">
              {formatCurrency(amount.toFixed(2))}
            </div>
            <div className="col-span-1 flex justify-end pt-1">
              <button
                type="button"
                onClick={() => removeLine(idx)}
                disabled={lines.length === 1}
                className="text-red-400 hover:text-red-600 p-1 rounded disabled:opacity-20"
                aria-label="Remove line"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
      <Button variant="ghost" size="sm" type="button" onClick={addLine} className="mt-1 text-electric">
        <Plus className="h-3.5 w-3.5" /> Add Line
      </Button>
    </div>
  );
}
