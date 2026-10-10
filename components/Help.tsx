'use client';
/**
 * <Help term="ar" /> — a small "?" button that explains an accounting term in plain language.
 *
 * Accessible tooltip/disclosure: opens on hover, keyboard focus or click/tap; Escape closes;
 * the trigger has an aria-label ("What is Accounts Receivable (A/R)?") and points at the
 * bubble with aria-describedby while it is open. Definitions live in lib/glossary.ts; the
 * bubble links to the full entry on /help.
 *
 *   <Label>Deposit to <Help term="undeposited-funds" /></Label>
 *   <Help term="ar">A/R</Help>   // renders the text with a dotted underline + the "?" icon
 */
import * as React from 'react';
import Link from 'next/link';
import { HelpCircle } from 'lucide-react';
import { GLOSSARY, glossaryAnchor, type GlossaryEntry, type GlossaryKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';

export function Help({
  term,
  children,
  className,
  side = 'top',
}: {
  term: GlossaryKey;
  /** Optional inline text shown before the icon (dotted underline). */
  children?: React.ReactNode;
  className?: string;
  /** Which side of the trigger the bubble opens on. */
  side?: 'top' | 'bottom';
}) {
  const entry: GlossaryEntry = GLOSSARY[term];
  const [open, setOpen] = React.useState(false);
  // Click "pins" the bubble open (touch devices have no hover); hover/focus show it transiently.
  const [pinned, setPinned] = React.useState(false);
  const id = React.useId();
  const wrapRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Close the bubble without also closing an enclosing modal.
        e.stopPropagation();
        setOpen(false);
        setPinned(false);
      }
    }
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={cn('relative inline-flex items-center gap-1 align-middle', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => !pinned && setOpen(false)}
    >
      {children && (
        <span className="underline decoration-dotted decoration-navy/30 underline-offset-2">
          {children}
        </span>
      )}
      <button
        type="button"
        aria-label={`What is ${entry.term}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Keep open while focus moves into the bubble (its "Learn more" link).
          if (!pinned && !wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
        onClick={(e) => {
          // Inside a <label>, a click would otherwise focus/toggle the labelled control.
          e.preventDefault();
          e.stopPropagation();
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-navy/40 hover:text-electric focus-visible:text-electric outline-none focus-visible:ring-2 focus-visible:ring-electric/40"
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'absolute left-1/2 z-[60] w-72 max-w-[80vw] -translate-x-1/2 rounded-xl bg-navy px-4 py-3 text-left text-xs font-normal normal-case tracking-normal leading-relaxed text-white shadow-xl',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          <span className="block font-semibold text-sm mb-1">{entry.term}</span>
          <span className="block text-white/85">{entry.short}</span>
          <Link
            href={`/help#${glossaryAnchor(term)}`}
            className="mt-2 inline-block font-semibold text-sky-300 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60 rounded"
            onBlur={(e) => {
              if (!pinned && !wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
            }}
          >
            Learn more
          </Link>
        </span>
      )}
    </span>
  );
}

export default Help;
