'use client';

/**
 * One-line "what changed" summary at the top of a report (reportexplain).
 *
 * Always shows the deterministic sentence from /api/reports/summary/[report] (net income — or
 * equity, sales, expenses — vs the previous period and last year, with the three biggest
 * movers). "Compare with" switches the movers between the previous period and last year (kept
 * in the URL as `summaryVs`, so Back / reload keep it). When the company has an AI model set
 * up, "Say it in plain words" asks the AI router to phrase it — local models by default, cloud
 * only if the company opted in — and the reply is only shown if it kept every number.
 */
import { useEffect, useState } from 'react';
import { Sparkles, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { reportOptions, type ReportSummaryResult } from '@/lib/reports/drilldown';

export default function ReportSummaryBar({
  reportKey,
  params,
  vs,
  onVsChange,
}: {
  reportKey: string;
  params: Record<string, string>;
  vs: 'prior_period' | 'prior_year';
  onVsChange: (vs: 'prior_period' | 'prior_year') => void;
}) {
  const [data, setData] = useState<ReportSummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const qs = new URLSearchParams({ ...reportOptions(params), vs }).toString();

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .get<ReportSummaryResult>(`/api/reports/summary/${encodeURIComponent(reportKey)}?${qs}`)
      .then((d) => live && setData(d))
      .catch((err) => {
        if (!live) return;
        setData(null);
        setError(err instanceof ApiError ? err.message : 'The summary could not be worked out.');
      });
    return () => {
      live = false;
    };
  }, [reportKey, qs]);

  const phrase = async () => {
    setAiBusy(true);
    try {
      setData(await api.get<ReportSummaryResult>(`/api/reports/summary/${encodeURIComponent(reportKey)}?${qs}&ai=1`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The AI model could not answer.');
    } finally {
      setAiBusy(false);
    }
  };

  if (!data && !error) {
    return (
      <div className="mb-4 h-12 animate-pulse rounded-xl bg-white/70 print-hidden" role="status" aria-label="Working out the summary">
        <span className="sr-only">Working out the summary…</span>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="mb-4 text-xs text-navy/50 print-hidden" role="status">
        {error}
      </p>
    );
  }
  const sentence = data.ai?.text ?? data.text;
  return (
    <section aria-label="Report summary" className="mb-4 rounded-xl border border-electric/20 bg-white/80 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        {data.ai ? <Sparkles className="mt-0.5 h-5 w-5 text-electric shrink-0" aria-hidden="true" /> : <TrendingUp className="mt-0.5 h-5 w-5 text-electric shrink-0" aria-hidden="true" />}
        <p className="flex-1 min-w-[16rem] text-sm text-navy" aria-live="polite">
          {sentence}
        </p>
        <div className="flex items-center gap-2 print-hidden">
          <label htmlFor="summary-vs" className="text-xs text-navy/60">
            Compare with
          </label>
          <select
            id="summary-vs"
            value={vs}
            onChange={(e) => onVsChange(e.target.value === 'prior_year' ? 'prior_year' : 'prior_period')}
            className="rounded-lg border border-navy/15 bg-white px-2 py-1 text-xs text-navy"
          >
            <option value="prior_period">Previous period</option>
            <option value="prior_year">Same period last year</option>
          </select>
          {data.aiAvailable && !data.ai && (
            <Button type="button" variant="secondary" size="sm" onClick={phrase} loading={aiBusy}>
              <Sparkles className="h-4 w-4" />
              Say it in plain words
            </Button>
          )}
        </div>
      </div>
      {data.ai && (
        <p className="mt-1 text-xs text-navy/50">
          Worded by your {data.ai.locality === 'local' ? 'local' : 'cloud'} AI model{data.ai.redacted ? ' (names were hidden before sending)' : ''}. The numbers:{' '}
          {data.text}
        </p>
      )}
      {data.aiNotice && <p className="mt-1 text-xs text-navy/50">{data.aiNotice}</p>}
    </section>
  );
}
