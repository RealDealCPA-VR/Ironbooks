'use client';
/**
 * Client hook for advanced pricing on sales forms (invoices, estimates, sales orders, sales
 * receipts). Debounces line changes and asks the server pricing engine (/api/pricing/quote)
 * which price applies to each item line — the UI never computes rule prices itself, and the
 * document services re-run the same engine on save.
 *
 * Returns one entry per input line (null for lines without an item / quantity, or while
 * loading). Pair with components/PriceSourceBadge.tsx and a per-line "rate typed by the user"
 * flag so automatic prices never overwrite a manual override.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import type { PriceQuote } from '@/lib/pricingShared';

export interface QuoteLine {
  itemId: string | null | undefined;
  quantity: string | number | null | undefined;
  classId?: string | null;
}

export interface QuoteHeader {
  customerId?: string | null;
  /** YYYY-MM-DD */
  date?: string | null;
  classId?: string | null;
  salesRepId?: string | null;
  jobId?: string | null;
}

function qtyOf(q: QuoteLine['quantity']): number {
  const n = typeof q === 'number' ? q : parseFloat(q ?? '');
  return Number.isFinite(n) ? n : 0;
}

export function usePriceQuotes(header: QuoteHeader, lines: QuoteLine[], delayMs = 250): Array<PriceQuote | null> {
  const [quotes, setQuotes] = useState<Array<PriceQuote | null>>([]);
  const seq = useRef(0);

  const date = header.date && /^\d{4}-\d{2}-\d{2}$/.test(header.date) ? header.date : todayISO();
  const wanted = lines.map((l, idx) => ({ idx, itemId: l.itemId, qty: qtyOf(l.quantity), classId: l.classId ?? null }));
  const key = JSON.stringify([header.customerId ?? null, date, header.classId ?? null, header.salesRepId ?? null, header.jobId ?? null, wanted]);

  useEffect(() => {
    const req = wanted.filter((w) => w.itemId && w.qty > 0);
    const size = lines.length;
    // Every change supersedes the request in flight, including one that leaves nothing to price
    // (its late answer would otherwise bring back quotes for lines that were just cleared).
    const mine = ++seq.current;
    if (req.length === 0) {
      setQuotes(Array(size).fill(null));
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<{ quotes: PriceQuote[] }>('/api/pricing/quote', {
          customerId: header.customerId || null,
          date,
          classId: header.classId || null,
          salesRepId: header.salesRepId || null,
          jobId: header.jobId || null,
          lines: req.map((w) => ({ itemId: w.itemId, quantity: String(w.qty), classId: w.classId })),
        })
        .then((res) => {
          if (mine !== seq.current) return; // a newer request superseded this one
          const out: Array<PriceQuote | null> = Array(size).fill(null);
          req.forEach((w, i) => {
            out[w.idx] = res.quotes[i] ?? null;
          });
          setQuotes(out);
        })
        .catch(() => {
          // Pricing is advisory in the UI; the server prices the document on save anyway.
          if (mine === seq.current) setQuotes(Array(size).fill(null));
        });
    }, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return quotes;
}

/** True when two money-ish strings are the same amount ("10" === "10.00"). */
export function samePrice(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  const x = typeof a === 'number' ? a : parseFloat(a ?? '');
  const y = typeof b === 'number' ? b : parseFloat(b ?? '');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 10000) === Math.round(y * 10000);
}
