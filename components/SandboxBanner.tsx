'use client';
/**
 * The unmistakable sandbox bar ("Try it on a copy", lib/services/sandbox.ts): a striped orange
 * strip pinned to the top of EVERY page — including sign-in / unlock and printed pages — while
 * the open company file is a sandbox copy (or a kept training file). Mounted once in
 * app/layout.tsx. Renders nothing in the real books.
 */
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { fetchSandboxBanner, type SandboxBannerStatus } from '@/lib/sandboxClient';

export default function SandboxBanner() {
  const pathname = usePathname();
  const [status, setStatus] = React.useState<SandboxBannerStatus | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetchSandboxBanner().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [pathname]);

  React.useEffect(() => {
    // Also mark the document so print styles / screenshots can tell (and for assistive tech).
    const root = document.documentElement;
    if (status?.active) root.dataset.sandbox = status.kind ?? 'sandbox';
    else delete root.dataset.sandbox;
  }, [status]);

  if (!status?.active) return null;
  const training = status.kind === 'training';
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-[60] w-full border-b-2 border-orange-700 text-black shadow-md print:static print:shadow-none"
      style={{
        backgroundColor: '#fb923c',
        backgroundImage:
          'repeating-linear-gradient(135deg, rgba(0,0,0,0.10) 0 14px, rgba(255,255,255,0) 14px 28px)',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
      data-testid="sandbox-banner"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-1.5 text-sm">
        <span className="flex items-center gap-2 font-extrabold tracking-wide">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
          {training ? (
            <>
              TRAINING FILE <span className="font-semibold normal-case tracking-normal">— a practice copy, not your real books</span>
            </>
          ) : (
            <>
              SANDBOX <span className="font-semibold normal-case tracking-normal">— changes here don&apos;t affect your real books</span>
            </>
          )}
        </span>
        {!training && pathname !== '/sandbox' && (
          <Link
            href="/sandbox"
            className="rounded-full bg-black/80 px-3 py-0.5 text-xs font-bold text-white hover:bg-black outline-none focus-visible:ring-2 focus-visible:ring-white print:hidden"
          >
            Leave sandbox…
          </Link>
        )}
      </div>
    </div>
  );
}
