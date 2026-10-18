/**
 * Shown when the open company file is damaged (lib/db ledger health check refused it on open):
 * getPageContext redirects server-rendered pages here, lib/client.ts sends client pages here,
 * and app/error.tsx shows the same message. QuickBooks likewise refuses to open a damaged file;
 * the way out is to restore a backup (or open another company file).
 */
import Link from 'next/link';
import { getLedgerDamage } from '@/lib/db';
import DamagedFileNotice from '@/components/DamagedFileNotice';

export const dynamic = 'force-dynamic';

export default async function DamagedFilePage() {
  let problems: string[] = [];
  let damaged = true;
  try {
    const damage = await getLedgerDamage();
    damaged = Boolean(damage?.length);
    problems = (damage ?? []).map((p) => p.detail);
  } catch {
    // Could not even open the file: treat it as damaged.
  }
  if (!damaged) {
    return (
      <main className="min-h-[60vh] flex items-center justify-center p-8 font-sans">
        <div className="max-w-lg w-full rounded-2xl bg-white shadow-xl p-8 text-center">
          <h1 className="text-2xl font-bold text-navy">Your company file is fine</h1>
          <p className="mt-2 text-sm text-navy/60">No damage was found when the file was opened.</p>
          <Link href="/dashboard" className="mt-6 inline-block text-sm font-semibold text-electric hover:underline">
            Go to the dashboard
          </Link>
        </div>
      </main>
    );
  }
  return <DamagedFileNotice problems={problems} />;
}
