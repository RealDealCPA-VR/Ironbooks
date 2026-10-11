'use client';
/**
 * Small indicator under a sales-form rate field: which price rule / price level / customer
 * price priced the line, or that the user overrode it — with a one-click way back to the
 * computed price. Driven by lib/usePriceQuotes.ts.
 */
import { Tag, Undo2 } from 'lucide-react';
import { formatCurrency } from '@/lib/money';
import type { PriceQuote } from '@/lib/pricingShared';
import { samePrice } from '@/lib/usePriceQuotes';

export function PriceSourceBadge({
  quote,
  rate,
  onUseQuoted,
}: {
  quote: PriceQuote | null | undefined;
  rate: string;
  /** Called when the user wants the computed price back (clears the manual override). */
  onUseQuoted: (price: string) => void;
}) {
  if (!quote) return null;
  const overridden = rate !== '' && !samePrice(rate, quote.price);
  if (!overridden && quote.source === 'base') return null;

  const why = quote.candidates.length > 1 ? quote.candidates.map((c) => `${c.name}: ${c.price}`).join(' · ') : undefined;

  if (overridden) {
    return (
      <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-700" title={quote.label}>
        <span>Manual price</span>
        <button
          type="button"
          onClick={() => onUseQuoted(quote.price)}
          className="inline-flex items-center gap-0.5 font-semibold text-electric hover:underline"
          aria-label={`Use the computed price ${quote.price}`}
        >
          <Undo2 className="h-3 w-3" /> use {formatCurrency(quote.price)}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald" title={why ?? quote.label}>
      <Tag className="h-3 w-3 shrink-0" />
      <span className="truncate max-w-[14rem]">{quote.label}</span>
    </div>
  );
}
