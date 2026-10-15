/**
 * /attention — "Needs attention": one prioritized list of everything waiting on the signed-in
 * person (lib/services/attention.ts), fixable in one click from the list. Also the first tab of
 * Home (/dashboard?tab=attention), which Simple mode opens by default.
 */
import { Inbox } from 'lucide-react';
import { getPageContext } from '@/lib/context';
import { getAttention } from '@/lib/services/attention';
import AttentionInbox from '@/components/AttentionInbox';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AttentionPage() {
  const ctx = await getPageContext('/attention');
  const data = await getAttention(ctx);
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Needs attention" iconNode={<Inbox className="text-electric h-8 w-8" aria-hidden="true" />} />
      <AttentionInbox initial={data} />
    </main>
  );
}
