'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';
import {
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  ScanSearch,
  Zap,
  CircleDot,
} from 'lucide-react';
import {
  Button,
  Card,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  toast,
} from '@/components/ui';
import { api } from '@/lib/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'critical' | 'high' | 'medium' | 'low';
type ErrorType = 'unbalanced' | 'duplicate' | 'missing_field' | 'unusual_pattern';

interface Detection {
  id: string;
  errorType: ErrorType;
  severity: Severity;
  description: string;
  detectedAt: string;
  resolvedAt: string | null;
  journalEntryId: string | null;
}

interface Suggestion {
  analysis: string;
  action: string;
  steps: string[];
  impact: string;
}

interface ProposedEntry {
  date: string;
  description: string;
  lines: Array<{
    accountId: string;
    accountCode?: string;
    accountName?: string;
    debit?: string | null;
    credit?: string | null;
    memo?: string | null;
  }>;
}

interface Correction {
  id: string;
  errorDetectionId: string;
  correctionType: string;
  correctionData: {
    action: string;
    changes: { steps: string[] };
    reasoning?: string;
    /** Proposed correcting journal entry — posted only when the user approves it. */
    entry?: ProposedEntry;
    /** The journal entry posted when the correction was applied. */
    postedEntryId?: string;
  } | null;
  llmReasoning: string | null;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  appliedAt: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityBadgeTone(s: Severity): 'danger' | 'warning' | 'neutral' {
  if (s === 'critical' || s === 'high') return 'danger';
  if (s === 'medium') return 'warning';
  return 'neutral';
}

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  unbalanced: 'Unbalanced Entry',
  duplicate: 'Duplicate Entry',
  missing_field: 'Missing Field',
  unusual_pattern: 'Unusual Pattern',
};

function parseSuggestion(correction: Correction): Suggestion | null {
  if (!correction.correctionData) return null;
  const cd = correction.correctionData;
  return {
    analysis: cd.reasoning ?? correction.llmReasoning ?? '',
    action: cd.action,
    steps: cd.changes?.steps ?? [],
    impact: '',
  };
}

// ---------------------------------------------------------------------------
// AI Insight Panel (expanded per-row)
// ---------------------------------------------------------------------------

interface InsightPanelProps {
  detectionId: string;
  onApplied: () => void;
}

function InsightPanel({ detectionId, onApplied }: InsightPanelProps) {
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      const res = await api.post<{ correction: Correction }>(
        `/api/errors/${detectionId}/analyze`,
      );
      setCorrection(res.correction);
      toast('AI analysis complete', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Analysis failed', 'danger');
    } finally {
      setAnalyzing(false);
    }
  }, [detectionId]);

  const handleApply = useCallback(async () => {
    if (!correction) return;
    setApplying(true);
    try {
      const entry = correction.correctionData?.entry;
      // The user clicking "Approve and post" IS the approval of the entry shown above.
      await api.post(`/api/errors/${detectionId}/apply`, {
        correctionId: correction.id,
        approved: Boolean(entry),
      });
      toast(entry ? 'Correcting entry posted and error resolved' : 'Correction applied and error resolved', 'success');
      onApplied();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Apply failed', 'danger');
    } finally {
      setApplying(false);
    }
  }, [correction, detectionId, onApplied]);

  const suggestion = correction ? parseSuggestion(correction) : null;
  const isApplied = correction?.status === 'applied';

  return (
    <div className="bg-electric/5 border border-electric/20 rounded-xl p-5 mt-2 space-y-4">
      {/* Header strip */}
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-electric" />
        <span className="text-xs font-bold text-electric uppercase tracking-widest">
          AI Insight
        </span>
        {correction && (
          <span
            className={`ml-auto text-xs font-semibold px-2.5 py-0.5 rounded-full ${
              isApplied
                ? 'bg-emerald/15 text-emerald'
                : 'bg-electric/10 text-electric'
            }`}
          >
            {isApplied ? 'Applied' : 'Pending'}
          </span>
        )}
      </div>

      {!correction && (
        <div className="flex flex-col items-center gap-3 py-4">
          <p className="text-sm text-navy/60 text-center max-w-sm">
            Run an AI-powered analysis to get a structured correction suggestion
            with step-by-step guidance.
          </p>
          <Button onClick={handleAnalyze} loading={analyzing} size="sm">
            {!analyzing && <Sparkles className="h-3.5 w-3.5" />}
            Analyze with AI
          </Button>
        </div>
      )}

      {correction && suggestion && (
        <div className="space-y-4">
          {/* Analysis */}
          <div>
            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wider mb-1">
              Analysis
            </p>
            <p className="text-sm text-navy leading-relaxed">{suggestion.analysis}</p>
          </div>

          {/* Action */}
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-gold shrink-0" />
            <span className="text-sm font-semibold text-navy">
              Recommended action:{' '}
              <code className="text-electric bg-electric/10 px-1.5 py-0.5 rounded text-xs">
                {suggestion.action}
              </code>
            </span>
          </div>

          {/* Steps */}
          {suggestion.steps.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-navy/50 uppercase tracking-wider mb-2">
                Steps to resolve
              </p>
              <ol className="space-y-1.5">
                {suggestion.steps.map((step, i) => (
                  <li key={i} className="flex gap-2 text-sm text-navy">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-electric/15 text-electric text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Impact */}
          {suggestion.impact && (
            <div className="bg-gold/10 border border-gold/25 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-gold uppercase tracking-wider mb-1">
                Impact if unresolved
              </p>
              <p className="text-sm text-navy/80">{suggestion.impact}</p>
            </div>
          )}

          {/* Proposed correcting entry (posted only when approved) */}
          {correction.correctionData?.entry && (
            <div>
              <p className="text-xs font-semibold text-navy/50 uppercase tracking-wider mb-1">
                Correcting journal entry {isApplied ? '(posted)' : '(will be posted when you approve)'}
              </p>
              <p className="text-sm text-navy mb-2">
                {correction.correctionData.entry.date} — {correction.correctionData.entry.description}
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-navy/50">
                    <th className="py-1">Account</th>
                    <th className="py-1 text-right">Debit</th>
                    <th className="py-1 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {correction.correctionData.entry.lines.map((l, i) => (
                    <tr key={i} className="border-t border-navy/10">
                      <td className="py-1">{[l.accountCode, l.accountName].filter(Boolean).join(' · ') || l.accountId}</td>
                      <td className="py-1 text-right font-mono">{l.debit ?? ''}</td>
                      <td className="py-1 text-right font-mono">{l.credit ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Actions row */}
          <div className="flex items-center gap-3 pt-1">
            {!isApplied && (
              <Button onClick={handleApply} loading={applying} size="sm">
                {!applying && <CheckCircle2 className="h-3.5 w-3.5" />}
                {correction.correctionData?.entry ? 'Approve and post entry' : 'Mark as fixed'}
              </Button>
            )}
            {isApplied && (
              <span className="flex items-center gap-1.5 text-sm text-emerald font-semibold">
                <CheckCircle2 className="h-4 w-4" /> Correction applied
              </span>
            )}
            {/* Re-analyze */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAnalyze}
              loading={analyzing}
              disabled={isApplied}
              className="text-electric"
            >
              {!analyzing && <Sparkles className="h-3.5 w-3.5" />}
              Re-analyze
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ErrorsPage() {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');

  // Always fetch the unfiltered list so the KPI cards reflect all detections;
  // the active tab filters client-side below.
  const fetchDetections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ detections: Detection[] }>('/api/errors');
      setDetections(res.detections);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load errors', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDetections();
  }, [fetchDetections]);

  // Deep link (Needs attention > See the fix): ?focus=<detection id> opens that finding.
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (focus) {
      setFilter('open');
      setExpandedId(focus);
    }
  }, []);

  const handleRunReview = async () => {
    setRunning(true);
    try {
      const res = await api.post<{ detections: Detection[]; count: number }>(
        '/api/errors',
      );
      toast(
        res.count > 0
          ? `AI Review found ${res.count} new issue${res.count > 1 ? 's' : ''}`
          : 'No new issues detected — books look clean!',
        res.count > 0 ? 'danger' : 'success',
      );
      await fetchDetections();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Review failed', 'danger');
    } finally {
      setRunning(false);
    }
  };

  // Summary counts (from the full, unfiltered list)
  const openCount = detections.filter((d) => !d.resolvedAt).length;
  const criticalCount = detections.filter(
    (d) => !d.resolvedAt && (d.severity === 'critical' || d.severity === 'high'),
  ).length;
  const resolvedCount = detections.filter((d) => d.resolvedAt).length;

  // Table rows for the active tab.
  const visibleDetections = detections.filter((d) =>
    filter === 'open' ? !d.resolvedAt : filter === 'resolved' ? !!d.resolvedAt : true,
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="AI Review"
        icon={ShieldAlert}
        action={
          <Button onClick={handleRunReview} loading={running}>
            {!running && <ScanSearch className="h-4 w-4" />}
            Run AI Review
          </Button>
        }
      />

      {/* Hero description */}
      <p className="text-navy/50 text-sm mb-6 -mt-2 max-w-xl">
        Ironbooks scans your journal for unbalanced entries, duplicates, missing
        fields, and statistical outliers — then suggests corrections with step-by-step
        guidance.
      </p>

      {/* Summary KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          {
            icon: ShieldAlert,
            label: 'Open Issues',
            value: openCount,
            accent: 'text-electric',
            bg: 'border-electric/30 bg-electric/5',
          },
          {
            icon: Zap,
            label: 'Critical / High',
            value: criticalCount,
            accent: 'text-red-500',
            bg: 'border-red-200 bg-red-100',
          },
          {
            icon: CheckCircle2,
            label: 'Resolved',
            value: resolvedCount,
            accent: 'text-emerald',
            bg: 'border-emerald/30 bg-emerald/5',
          },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <Card
              key={kpi.label}
              className={`flex items-center gap-4 px-5 py-4 border-2 ${kpi.bg} shadow-md`}
            >
              <Icon className={`h-8 w-8 ${kpi.accent} shrink-0`} />
              <div>
                <div className={`text-3xl font-extrabold tabular-nums ${kpi.accent}`}>
                  {kpi.value}
                </div>
                <div className="text-xs text-navy/50 font-medium mt-0.5">{kpi.label}</div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {(['all', 'open', 'resolved'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
              filter === f
                ? 'bg-electric text-white shadow'
                : 'bg-white text-navy/60 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-navy/40">
            <Loader2 className="h-6 w-6 animate-spin text-electric" />
            <span className="text-sm">Loading detections…</span>
          </div>
        ) : visibleDetections.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-navy/40">
            <CheckCircle2 className="h-12 w-12 text-emerald/60" />
            <div className="text-center">
              <p className="font-semibold text-navy/60">No issues found</p>
              <p className="text-sm mt-1">
                {filter === 'all'
                  ? 'Run AI Review to scan your journal for errors.'
                  : `No ${filter} issues to display.`}
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <thead>
              <tr className="bg-gradient-to-r from-navy/5 to-electric/5">
                <Th>Type</Th>
                <Th>Severity</Th>
                <Th className="w-1/2">Description</Th>
                <Th>Detected</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleDetections.map((det) => {
                const isExpanded = expandedId === det.id;
                const isResolved = !!det.resolvedAt;

                return (
                  <Fragment key={det.id}>
                    <Tr
                      className={
                        isResolved
                          ? 'opacity-60'
                          : isExpanded
                          ? 'bg-electric/5'
                          : undefined
                      }
                    >
                      {/* Error type */}
                      <Td>
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-navy">
                          <CircleDot className="h-3.5 w-3.5 text-electric shrink-0" />
                          {ERROR_TYPE_LABELS[det.errorType] ?? det.errorType}
                        </span>
                      </Td>

                      {/* Severity */}
                      <Td>
                        <Badge tone={severityBadgeTone(det.severity)}>
                          {det.severity.toUpperCase()}
                        </Badge>
                      </Td>

                      {/* Description */}
                      <Td className="text-sm text-navy/70 max-w-xs">
                        <span className="line-clamp-2">{det.description}</span>
                      </Td>

                      {/* Detected at */}
                      <Td className="text-xs text-navy/50 whitespace-nowrap">
                        {new Date(det.detectedAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </Td>

                      {/* Status */}
                      <Td>
                        {isResolved ? (
                          <Badge tone="success">Resolved</Badge>
                        ) : (
                          <Badge tone="info">Open</Badge>
                        )}
                      </Td>

                      {/* Actions */}
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!isResolved && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                setExpandedId(isExpanded ? null : det.id)
                              }
                              className="gap-1.5 text-electric border-electric/30 hover:bg-electric/5"
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              Analyze
                              {isExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>

                    {/* Expandable AI insight row */}
                    {isExpanded && !isResolved && (
                      <tr>
                        <td colSpan={6} className="px-4 pb-4 pt-0">
                          <InsightPanel
                            detectionId={det.id}
                            onApplied={() => {
                              setExpandedId(null);
                              fetchDetections();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
