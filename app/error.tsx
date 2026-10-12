'use client';
/**
 * Route-level error boundary (App Router). Catches render/data errors thrown by any
 * page or server component below the root layout and shows a friendly recovery UI
 * inside the AppShell instead of Next's unstyled default error screen. A damaged company file
 * gets its own plain "restore a backup" screen (components/DamagedFileNotice.tsx).
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import DamagedFileNotice from '@/components/DamagedFileNotice';
import { isDamagedFileMessage } from '@/lib/client';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error in the console / main-process logs for debugging.
    console.error('[route-error]', error);
  }, [error]);

  // Damaged company file: not a glitch to retry — the way out is restoring a backup. (Server
  // pages are normally redirected to /damaged-file first; this covers anything that slips by.)
  if (isDamagedFileMessage(error?.message)) return <DamagedFileNotice />;

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-8 font-sans">
      <div className="max-w-lg w-full rounded-2xl bg-white shadow-xl border-b-4 border-electric p-8 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-gold" />
        <h1 className="mt-4 text-2xl font-extrabold text-navy">Something went wrong</h1>
        <p className="mt-2 text-sm text-navy/60">
          This screen hit an unexpected error. Your company file is safe — nothing was
          posted. You can retry, or head back to the dashboard.
        </p>
        {error?.digest && (
          <p className="mt-2 text-xs text-navy/40 font-mono">Error reference: {error.digest}</p>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 rounded-lg bg-electric text-white text-sm font-semibold px-4 py-2 shadow hover:bg-electric/90 transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center rounded-lg border border-navy/20 text-navy text-sm font-semibold px-4 py-2 hover:bg-slate-50 transition-colors"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
