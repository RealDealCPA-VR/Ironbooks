'use client';

/**
 * <AmountExplain> — one report amount that explains itself.
 *
 *  - Hover (after a short pause) or keyboard focus shows a tooltip: "Made of 12 transactions,
 *    largest $1,200.00 (Acme Corp, 03/14/2026)". The text is fetched lazily from
 *    /api/reports/drilldown/[report]?brief=1 the first time, then cached for the page.
 *  - Click / Enter follows `href` (the QuickZoom transaction list) or calls `onActivate` (open a
 *    single transaction). Escape closes the tooltip.
 *
 * The tooltip is position: fixed so the report table's horizontal scroller never clips it, and
 * the trigger points at it with aria-describedby while it is open.
 */
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/client';
import type { CellDrilldown } from '@/lib/reports/drilldown';
import { formatCurrency } from '@/lib/money';

const cache = new Map<string, Promise<CellDrilldown>>();

/** Forget cached explanations (after the report re-runs, numbers may have changed). */
export function clearExplainCache() {
  cache.clear();
}

function fetchExplanation(url: string): Promise<CellDrilldown> {
  let p = cache.get(url);
  if (!p) {
    p = api.get<CellDrilldown>(url);
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

interface Tip {
  status: 'loading' | 'done' | 'error';
  text: string;
  note?: string;
}

export default function AmountExplain({
  children,
  href,
  onActivate,
  apiUrl,
  localText,
  hint,
  onNavigate,
  label,
}: {
  children: React.ReactNode;
  /** QuickZoom target (the transaction list behind the number). */
  href?: string;
  /** Instead of a link: open something in place (e.g. the transaction view). */
  onActivate?: () => void;
  /** Lazy explanation source. */
  apiUrl?: string;
  /** Explanation known on the client (no fetch). */
  localText?: string;
  /** Second line of the tooltip (what clicking does). */
  hint?: string;
  /** Called just before following `href` (the report saves its scroll position). */
  onNavigate?: () => void;
  /** Accessible name prefix, e.g. "Rent, Jan 2026". */
  label?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const load = () => {
    if (localText) {
      setTip({ status: 'done', text: localText });
      return;
    }
    if (!apiUrl) return;
    setTip((t) => (t?.status === 'done' ? t : { status: 'loading', text: 'Adding up the transactions…' }));
    fetchExplanation(apiUrl)
      .then((d) => {
        const note =
          d.kind === 'transactions' && !d.ties && d.cell !== null
            ? `These add up to ${formatCurrency(d.total)}; the report shows ${formatCurrency(d.cell)}. The books changed since the report ran — run it again.`
            : undefined;
        setTip({ status: 'done', text: d.explanation, note });
      })
      .catch((err) => setTip({ status: 'error', text: err instanceof ApiError ? err.message : 'Could not explain this amount.' }));
  };

  const show = (delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 288;
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      const above = r.top > 150;
      setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
      setOpen(true);
      load();
    }, delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  const common = {
    onMouseEnter: () => show(300),
    onMouseLeave: hide,
    onFocus: () => show(0),
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    },
    'aria-describedby': open ? id : undefined,
    className:
      'rounded hover:text-electric hover:underline decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-electric/60',
  };

  const trigger = href ? (
    <Link
      href={href}
      ref={(el) => {
        ref.current = el;
      }}
      {...common}
      onClick={() => {
        hide();
        onNavigate?.();
      }}
      aria-label={label ? `${label}: see the transactions behind this amount` : undefined}
    >
      {children}
    </Link>
  ) : (
    <button
      type="button"
      ref={(el) => {
        ref.current = el;
      }}
      {...common}
      onClick={() => {
        hide();
        onActivate?.();
      }}
      aria-label={label ? `${label}: open this transaction` : undefined}
    >
      {children}
    </button>
  );

  return (
    <>
      {trigger}
      {open && pos && tip && (
        <span
          id={id}
          role="tooltip"
          style={{ position: 'fixed', left: pos.left, top: pos.top, transform: pos.above ? 'translateY(-100%)' : undefined }}
          className="z-[60] w-72 rounded-xl bg-navy px-4 py-3 text-left text-xs font-normal normal-case tracking-normal leading-relaxed text-white shadow-xl print-hidden pointer-events-none"
        >
          <span className={`block ${tip.status === 'error' ? 'text-red-200' : 'text-white'}`}>{tip.text}</span>
          {tip.note && <span className="mt-1 block text-gold">{tip.note}</span>}
          {tip.status !== 'error' && (
            <span className="mt-1 block text-white/60">{hint ?? (href ? 'Click or press Enter to see them.' : 'Click or press Enter to open it.')}</span>
          )}
        </span>
      )}
    </>
  );
}
