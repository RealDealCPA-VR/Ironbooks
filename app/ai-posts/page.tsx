'use client';

/**
 * What the AI posted — every bank-feed line the AI posted on its own, newest first, each with
 * one-click Undo (Bank Review's Unmatch: the AI's entry is voided and the line goes back to
 * "For review"; the AI will not post that line again). lib/services/aiPosts.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, Undo2 } from 'lucide-react';
import { Badge, Button, Card, PageHeader, PageSkeleton, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

interface AiPost {
  id: string;
  postedAt: string;
  date: string;
  description: string;
  amount: string;
  bankAccount: string;
  accountCode: string;
  accountName: string;
  confidence: string;
  state: 'posted' | 'undone';
}

export default function AiPostsPage() {
  const [posts, setPosts] = useState<AiPost[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPosts((await api.get<{ posts: AiPost[] }>('/api/ai/posts')).posts);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load what the AI posted.', 'danger');
      setPosts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function undo(p: AiPost) {
    setBusy(p.id);
    try {
      await api.post('/api/ai/posts', { action: 'undo', id: p.id });
      setPosts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, state: 'undone' } : x)) ?? prev);
      toast('Undone. The line is back in Bank Review, and the AI will leave it to you.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Undo failed.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  if (!posts) return <PageSkeleton />;
  const live = posts.filter((p) => p.state === 'posted').length;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="What the AI posted" icon={Sparkles} />
      <Card className="p-6 mb-6 bg-navy/[0.03]">
        <p className="text-sm text-navy/80 leading-relaxed">
          Bank lines the AI was sure enough about to post on its own (the threshold is under{' '}
          <Link href="/ai-settings" className="text-electric hover:underline">
            AI &amp; Automation
          </Link>
          ). Anything wrong? <strong>Undo</strong> voids the AI&apos;s entry and puts the line back in{' '}
          <Link href="/bank-review" className="text-electric hover:underline">
            Bank Review
          </Link>{' '}
          for you; the AI will not post that line again.
        </p>
      </Card>
      <Card className="p-0 overflow-hidden">
        {posts.length === 0 ? (
          <p className="p-8 text-center text-sm text-navy/60">The AI has not posted anything on its own yet.</p>
        ) : (
          <>
            <div className="px-4 py-3 text-xs text-navy/50 border-b border-slate-100">
              {live} still posted · {posts.length - live} undone
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-navy/50">
                  <tr>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Bank line</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2">Posted to</th>
                    <th className="px-4 py-2 text-right">Sure</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => (
                    <tr key={p.id} className={`border-t border-slate-100 ${p.state === 'undone' ? 'text-navy/40' : 'text-navy'}`}>
                      <td className="px-4 py-2 whitespace-nowrap">{formatDate(p.date)}</td>
                      <td className="px-4 py-2">
                        <div className="font-medium">{p.description || '—'}</div>
                        <div className="text-xs text-navy/50">{p.bankAccount}</div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatCurrency(p.amount)}</td>
                      <td className="px-4 py-2">
                        {p.accountCode} {p.accountName}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{Math.round(Number(p.confidence) * 100)}%</td>
                      <td className="px-4 py-2 text-right">
                        {p.state === 'posted' ? (
                          <Button variant="secondary" size="sm" loading={busy === p.id} onClick={() => undo(p)}>
                            <Undo2 className="h-4 w-4" /> Undo
                          </Button>
                        ) : (
                          <Badge tone="neutral">Undone</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
