'use client';
/**
 * App-wide notice for an Accountant's Copy (PARITY I1), mounted once by the app shell:
 *  - client file with a copy out: "transactions on or before <date> are locked";
 *  - the accountant's working copy: "only work on or before <date>; send your changes".
 * Hidden when there is no copy, or when the member can't see the Accountant's Copy status.
 */
import * as React from 'react';
import Link from 'next/link';
import { ArrowRightLeft, Lock } from 'lucide-react';
import { niceDate } from '@/lib/accountantCopyClient';

interface Status {
  mode: 'none' | 'client' | 'accountant';
  current: { dividingDate: string } | null;
}

export default function AccountantCopyBanner({ pathname }: { pathname: string }) {
  const [status, setStatus] = React.useState<Status | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetch('/api/accountant-copy', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (!status?.current || status.mode === 'none') return null;
  const when = niceDate(status.current.dividingDate);
  const onPage = pathname.startsWith('/accountant/accountants-copy');

  if (status.mode === 'client') {
    return (
      <div role="status" className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm text-yellow-900">
        <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Your accountant has an Accountant&apos;s Copy: transactions dated on or before <strong>{when}</strong> are locked until you
          import their changes.
        </span>
        {!onPage && (
          <Link href="/accountant/accountants-copy" className="ml-auto font-semibold text-electric hover:underline">
            Import changes or cancel
          </Link>
        )}
      </div>
    );
  }
  return (
    <div role="status" className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-electric/30 bg-electric/5 px-4 py-2 text-sm text-navy">
      <ArrowRightLeft className="h-4 w-4 shrink-0 text-electric" aria-hidden="true" />
      <span>
        Accountant&apos;s Copy — you can work on transactions dated on or before <strong>{when}</strong>.
      </span>
      {!onPage && (
        <Link href="/accountant/accountants-copy" className="ml-auto font-semibold text-electric hover:underline">
          Send changes to your client
        </Link>
      )}
    </div>
  );
}
