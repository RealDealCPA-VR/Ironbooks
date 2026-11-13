/**
 * Home page "AI" card (server component): what the AI did and what it needs from you, each count
 * linking to the screen that finishes the job (lib/services/aiActivity.ts). With no AI connected
 * it is a one-line invitation to connect one.
 */
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui';
import type { AiActivity } from '@/lib/services/aiActivity';

function Row({ href, n, text, tone = 'navy' }: { href: string; n: number; text: string; tone?: 'navy' | 'electric' }) {
  return (
    <li>
      <Link href={href} className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 hover:bg-navy/[.04]">
        <span className={`w-10 shrink-0 text-right text-lg font-bold tabular-nums ${tone === 'electric' ? 'text-electric' : 'text-navy'}`}>{n}</span>
        <span className="text-sm text-navy/75">{text}</span>
      </Link>
    </li>
  );
}

export default function AiActivityCard({ a }: { a: AiActivity }) {
  // Auto-posting runs on the learned categorizer, with or without an AI connected: what it did
  // is always shown; the invitation alone only when there is nothing to report.
  const activity = a.autoPostedLast7Days + a.bankLinesToReview + a.pendingProposals + a.ruleOffers;
  if (a.connected === 'none' && activity === 0) {
    return (
      <Card className="mt-8 flex max-w-3xl flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-electric" aria-hidden="true" />
          <p className="text-sm text-navy/70">
            Sign in with your ChatGPT plan or add a free model on this computer to categorize bank lines, answer questions
            and draft entries for your approval.
          </p>
        </div>
        <Link href="/ai-settings" className="rounded-lg bg-electric px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110">
          Connect your AI
        </Link>
      </Card>
    );
  }
  const rows: Array<{ href: string; n: number; text: string; tone?: 'navy' | 'electric' }> = [];
  if (a.autoPostedLast7Days > 0) {
    rows.push({ href: '/ai-posts', n: a.autoPostedLast7Days, text: 'bank lines the AI posted this week (see them and undo any in one click)' });
  }
  if (a.bankLinesToReview > 0) {
    rows.push({
      href: '/bank-review',
      n: a.bankLinesToReview,
      text: `bank lines to review${a.bankLinesWithSuggestion ? ` — ${a.bankLinesWithSuggestion} already have a suggested account` : ''}`,
      tone: 'electric',
    });
  }
  if (a.pendingProposals > 0) rows.push({ href: '/dashboard?assistant=1', n: a.pendingProposals, text: 'entries the assistant drafted, waiting for your approval (Ask AI)', tone: 'electric' });
  if (a.ruleOffers > 0) rows.push({ href: '/bank-rules', n: a.ruleOffers, text: 'learned payee rules ready to turn on', tone: 'electric' });
  return (
    <Card className="mt-8 max-w-3xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <Sparkles className="h-5 w-5 text-electric" aria-hidden="true" /> AI
        </h2>
        <Link href="/ai-settings" className="text-sm font-semibold text-electric hover:underline">
          AI &amp; Automation
        </Link>
      </div>
      {rows.length ? (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <Row key={r.href + r.text} {...r} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-navy/60">Nothing waiting for you. New bank lines will be categorized as they come in.</p>
      )}
      {a.connected === 'none' && (
        <p className="mt-3 text-sm text-navy/70">
          <Link href="/ai-settings" className="font-semibold text-electric hover:underline">
            Connect your AI
          </Link>{' '}
          (sign in with your ChatGPT plan, or a free model on this computer) to answer questions and draft entries for your
          approval.
        </p>
      )}
      <p className="mt-3 text-xs text-navy/45">
        {a.connected === 'cloud' ? 'Cloud AI' : a.connected === 'local' ? 'AI on your own computers' : 'Learned categorizer on this computer'}
        {a.connected === 'cloud' ? ` · ${a.cloudCallsToday}${a.cloudDailyCap > 0 ? ` of ${a.cloudDailyCap}` : ''} cloud calls today` : ''}
        {a.autoApplyEnabled ? ' · auto-posting confident bank lines is on' : ' · auto-posting is off (turn it on in AI & Automation)'}
      </p>
    </Card>
  );
}
