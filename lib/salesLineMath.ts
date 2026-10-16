/**
 * Live totals for the sales-form previews (sales receipts, credit memos, estimates, sales
 * orders): the same item-type rules the services apply (lib/services/salesLineKinds.ts) and the
 * invoice form uses —
 *  - income lines add to the subtotal (and the taxable base when taxable)
 *  - discount lines always subtract (qty x |rate|); a taxable one lowers the taxable base
 *  - subtotal lines show the running body sum and add nothing
 *  - sales-tax item lines add straight to the tax
 * Pure (no React), so the forms and tests share it.
 */
export type PreviewLineKind = 'income' | 'discount' | 'subtotal' | 'sales_tax' | 'payment';

export function previewLineKind(itemType: string | null | undefined): PreviewLineKind {
  if (itemType === 'discount' || itemType === 'subtotal' || itemType === 'sales_tax' || itemType === 'payment') {
    return itemType;
  }
  return 'income';
}

export interface PreviewLine {
  quantity: string | number | null | undefined;
  rate: string | number | null | undefined;
  taxable?: boolean | null;
  itemType?: string | null;
}

export interface PreviewTotals {
  /** Amount shown per line (same index as the input). */
  amounts: number[];
  subtotal: number;
  taxableSubtotal: number;
  tax: number;
  total: number;
}

const num = (v: string | number | null | undefined) => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

export function previewSalesTotals(lines: PreviewLine[], taxRate = 0): PreviewTotals {
  let subtotal = 0;
  let taxableSubtotal = 0;
  let manualTax = 0;
  let running = 0;
  const amounts: number[] = [];
  for (const l of lines) {
    const kind = previewLineKind(l.itemType);
    if (kind === 'subtotal') {
      amounts.push(running);
      running = 0;
      continue;
    }
    const qty = num(l.quantity);
    const rate = num(l.rate);
    const amt = kind === 'discount' ? -Math.abs(qty * rate) : qty * rate;
    amounts.push(amt);
    if (kind === 'income' || kind === 'discount') {
      subtotal += amt;
      running += amt;
      if (l.taxable) taxableSubtotal += amt;
    } else if (kind === 'sales_tax') {
      manualTax += amt;
    }
    // payment items are refused by the server on these documents; they add nothing here.
  }
  const tax = Math.max(0, taxableSubtotal) * taxRate + manualTax;
  return { amounts, subtotal, taxableSubtotal, tax, total: subtotal + tax };
}
