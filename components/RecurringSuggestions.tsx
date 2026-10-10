'use client';

/**
 * "We noticed you pay these regularly — memorize them?" Detected locally from the company's
 * own bills/expenses (GET /api/ai/recurring). Memorizing creates a remind-only template via
 * the normal recurring-template service; nothing posts without the user.
 */
import * as React from 'react';
import { Sparkles, X } from 'lucide-react';
import { Badge, Button, Card, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

interface Suggestion {
  key: string;
  payee: string;
  docType: 'bill' | 'expense';
  sourceDocId: string;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  occurrences: number;
  lastDate: string;
  nextDate: string;
  typicalAmount: string;
  amountVaries: boolean;
  confidence: number;
  suggestedName: string;
}

export default function RecurringSuggestions({ onMemorized }: { onMemorized?: () => void }) {
  const [items, setItems] = React.useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await api.get<{ suggestions: Suggestion[] }>('/api/ai/recurring');
      setItems(r.suggestions);
    } catch {
      setItems([]);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function memorize(s: Suggestion) {
    setBusy(s.key);
    try {
      await api.post('/api/ai/recurring', {
        docType: s.docType,
        sourceDocId: s.sourceDocId,
        frequency: s.frequency,
        nextRunDate: s.nextDate,
        name: s.suggestedName,
        autoEnter: false,
      });
      toast(`Memorized “${s.suggestedName}” — you'll be reminded when it's due.`, 'success');
      await load();
      onMemorized?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not memorize.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  const visible = items.filter((s) => !dismissed.has(s.key));
  if (visible.length === 0) return null;

  return (
    <Card className="p-5 mb-6 border-electric/20">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-electric" />
        <h2 className="font-bold text-navy">Looks recurring — memorize?</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {visible.slice(0, 6).map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <div className="flex-1 min-w-[220px]">
              <div className="font-semibold text-navy">{s.payee}</div>
              <div className="text-xs text-navy/50">
                {s.occurrences} {s.docType === 'bill' ? 'bills' : 'payments'}, {s.frequency}
                {' · '}
                {s.amountVaries ? 'about ' : ''}
                {formatCurrency(s.typicalAmount)} · last {formatDate(s.lastDate)} · next ≈ {formatDate(s.nextDate)}
              </div>
            </div>
            <Badge tone={s.confidence >= 0.7 ? 'success' : 'info'}>{Math.round(s.confidence * 100)}% sure</Badge>
            <Button size="sm" loading={busy === s.key} disabled={!!busy} onClick={() => memorize(s)}>
              Memorize (remind me)
            </Button>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-navy/30 hover:text-navy"
              onClick={() => setDismissed((d) => new Set(d).add(s.key))}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
