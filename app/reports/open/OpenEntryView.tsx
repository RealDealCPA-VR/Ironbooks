'use client';

/** The transaction itself, for a report line whose entry has no form of its own. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileSearch } from 'lucide-react';
import EntryDetailModal from '@/components/EntryDetailModal';
import { EmptyState, PageHeader } from '@/components/ui';

export default function OpenEntryView({ entryId, back }: { entryId: string | null; back: string }) {
  const router = useRouter();
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Transaction" icon={FileSearch} />
      <Link href={back} className="mb-4 inline-flex items-center gap-1 text-sm text-electric hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the report
      </Link>
      {!entryId && <EmptyState title="Transaction not found" message="It may have been deleted, or it belongs to another company." />}
      {entryId && <EntryDetailModal entryId={entryId} onClose={() => router.push(back)} />}
    </main>
  );
}
