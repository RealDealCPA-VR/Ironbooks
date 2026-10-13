/**
 * "This company file is damaged — restore a backup" screen (QB refuses to open a damaged file).
 * Used by app/damaged-file/page.tsx and app/error.tsx. Plain language, one clear way out.
 */
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

export default function DamagedFileNotice({ problems = [] }: { problems?: string[] }) {
  return (
    <main className="min-h-[60vh] flex items-center justify-center p-8 font-sans">
      <div className="max-w-xl w-full rounded-2xl bg-white shadow-xl border-b-4 border-red-500 p-8">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-500" />
        <h1 className="mt-4 text-2xl font-extrabold text-navy text-center">
          This company file is damaged
        </h1>
        <p className="mt-3 text-sm text-navy/70">
          BookKeeper checked the books when it opened this file and found problems it can&apos;t
          safely work with (for example, entries that don&apos;t balance). To protect your records,
          the file won&apos;t open until it is replaced.
        </p>
        <p className="mt-3 text-sm font-semibold text-navy">
          Restore your most recent backup to get back to work.
        </p>
        <p className="mt-1 text-sm text-navy/70">
          On the same screen you can first make a backup of this damaged file, so it can be looked at
          later.
        </p>
        {problems.length > 0 && (
          <details className="mt-4 text-xs text-navy/60">
            <summary className="cursor-pointer font-semibold">What was found</summary>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/backup"
            className="inline-flex items-center rounded-lg bg-electric text-white text-sm font-semibold px-4 py-2 shadow hover:bg-electric/90"
          >
            Restore a backup
          </Link>
        </div>
      </div>
    </main>
  );
}
