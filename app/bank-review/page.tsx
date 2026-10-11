'use client';

/**
 * Bank Review — QB Bank Feeds-style review screen for staged bank transactions.
 *
 * Per-row mode chooser (QB style):
 *  - Add:     categorize into a GL account (posts a NEW journal entry).
 *  - Match:   link to an EXISTING posted journal entry (no new posting) —
 *             ranked candidates with confidence, one-click confirm.
 *  - Exclude: drop the row from the review queue (duplicate / personal).
 *
 * Filters: To Review (unreviewed) / Matched / Excluded.
 * Auto-suggest: when exactly one HIGH-confidence match candidate exists for a
 * row, the row opens in Match mode with that candidate preselected.
 * Matched rows offer Unmatch (voids the entry only if categorize created it).
 *
 * AI (team ai): the local learned categorizer pre-selects an account for rows without a
 * rule suggestion and shows its calibrated confidence; low-confidence rows can "Ask AI"
 * (LLM router, existing accounts only, never auto-posted); "Auto-apply confident" posts
 * rows at/above the company threshold through the normal categorize service.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, CreditCard, Inbox, Link2, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Label,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface BankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  glAccountName: string;
  glAccountCode: string;
}

interface BankTransaction {
  id: string;
  date: string;
  description: string | null;
  payee: string | null;
  amount: string;
  matched: boolean;
  matchedEntryId: string | null;
  excluded: boolean;
  suggestedAccountId: string | null;
}

interface MatchCandidate {
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  sourceRef: string | null;
  amount: string;
  dateDiffDays: number;
  referenceMatch: boolean;
  confidence: 'high' | 'medium' | 'low';
  score: number;
}

interface AiSuggestion {
  bankTransactionId: string;
  accountId: string | null;
  confidence: number;
  source: 'rule' | 'model' | 'llm' | null;
  autoApplyEligible: boolean;
  reason?: string;
}

interface AiSuggestionsResponse {
  suggestions: AiSuggestion[];
  threshold: number;
  autoApplyEnabled: boolean;
}

type ReviewTab = 'unreviewed' | 'matched' | 'excluded';
type RowMode = 'add' | 'match';

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

function ConfidenceBadge({ c }: { c: MatchCandidate }) {
  const tone = c.confidence === 'high' ? 'success' : c.confidence === 'medium' ? 'info' : 'neutral';
  return (
    <Badge tone={tone}>
      {c.referenceMatch ? `Ref ${c.reference} · ` : ''}
      {c.confidence} ({c.score})
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function BankReviewPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState('');
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [tab, setTab] = useState<ReviewTab>('unreviewed');

  // Per-row state
  const [rowAccountId, setRowAccountId] = useState<Record<string, string>>({});
  const [rowMode, setRowMode] = useState<Record<string, RowMode>>({});
  const [rowCandidates, setRowCandidates] = useState<Record<string, MatchCandidate[]>>({});
  const [rowCandidateId, setRowCandidateId] = useState<Record<string, string>>({});

  const [loadingBankAccounts, setLoadingBankAccounts] = useState(true);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  // AI suggestions (learned categorizer / LLM second opinion)
  const [aiSugg, setAiSugg] = useState<Record<string, AiSuggestion>>({});
  const [aiMeta, setAiMeta] = useState<{ threshold: number; autoApplyEnabled: boolean }>({
    threshold: 0.95,
    autoApplyEnabled: false,
  });
  const [askingId, setAskingId] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------------

  const fetchBankAccounts = useCallback(async () => {
    setLoadingBankAccounts(true);
    try {
      const data = await api.get<BankAccount[]>('/api/bank-accounts');
      setBankAccounts(data);
      setSelectedBankAccountId((prev) => prev || data[0]?.id || '');
    } catch {
      toast('Failed to load bank accounts.', 'danger');
    } finally {
      setLoadingBankAccounts(false);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await api.get<Account[]>('/api/accounts');
      setAllAccounts(data);
    } catch {
      toast('Failed to load GL accounts.', 'danger');
    }
  }, []);

  const fetchTransactions = useCallback(async (bankAccountId: string) => {
    if (!bankAccountId) return;
    setLoadingTxns(true);
    try {
      const data = await api.get<BankTransaction[]>(
        `/api/bank-transactions?bankAccountId=${bankAccountId}&filter=all`,
      );
      setTransactions(data);

      // Pre-fill per-row account selections from suggestedAccountId.
      const initialAccounts: Record<string, string> = {};
      for (const txn of data) {
        if (txn.suggestedAccountId) initialAccounts[txn.id] = txn.suggestedAccountId;
      }
      setRowAccountId((prev) => ({ ...initialAccounts, ...prev }));

      // Learned-categorizer suggestions (best-effort — the page works without them).
      try {
        const ai = await api.get<AiSuggestionsResponse>(
          `/api/ai/bank-suggestions?bankAccountId=${bankAccountId}`,
        );
        const map: Record<string, AiSuggestion> = {};
        const aiAccounts: Record<string, string> = {};
        for (const sg of ai.suggestions) {
          map[sg.bankTransactionId] = sg;
          if (sg.source === 'model' && sg.accountId && sg.confidence >= 0.4) {
            aiAccounts[sg.bankTransactionId] = sg.accountId;
          }
        }
        setAiSugg(map);
        setAiMeta({ threshold: ai.threshold, autoApplyEnabled: ai.autoApplyEnabled });
        setRowAccountId((prev) => ({ ...aiAccounts, ...initialAccounts, ...prev }));
      } catch {
        setAiSugg({});
      }

      // Fetch match candidates for every unreviewed row (small desktop volumes).
      const unreviewed = data.filter((t) => !t.matched && !t.excluded);
      const results = await Promise.all(
        unreviewed.map(async (t) => {
          try {
            const candidates = await api.get<MatchCandidate[]>(
              `/api/bank-transactions/${t.id}/matches`,
            );
            return [t.id, candidates] as const;
          } catch {
            return [t.id, [] as MatchCandidate[]] as const;
          }
        }),
      );

      const candMap: Record<string, MatchCandidate[]> = {};
      const modeMap: Record<string, RowMode> = {};
      const candSel: Record<string, string> = {};
      for (const [id, candidates] of results) {
        candMap[id] = candidates;
        const high = candidates.filter((c) => c.confidence === 'high');
        if (high.length === 1) {
          // Auto-suggest: exactly one high-confidence match → preselect Match.
          modeMap[id] = 'match';
          candSel[id] = high[0].entryId;
        } else {
          modeMap[id] = 'add';
          if (candidates.length > 0) candSel[id] = candidates[0].entryId;
        }
      }
      setRowCandidates(candMap);
      setRowMode(modeMap);
      setRowCandidateId(candSel);
    } catch {
      toast('Failed to load transactions.', 'danger');
    } finally {
      setLoadingTxns(false);
    }
  }, []);

  useEffect(() => {
    fetchBankAccounts();
    fetchAccounts();
  }, [fetchBankAccounts, fetchAccounts]);

  useEffect(() => {
    if (selectedBankAccountId) {
      fetchTransactions(selectedBankAccountId);
    }
  }, [selectedBankAccountId, fetchTransactions]);

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
      await fetchTransactions(selectedBankAccountId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Action failed.', 'danger');
    } finally {
      setBusyId(null);
    }
  }

  const handleAdd = (txn: BankTransaction) => {
    const accountId = rowAccountId[txn.id];
    if (!accountId) {
      toast('Select an account first.', 'danger');
      return;
    }
    withBusy(txn.id, async () => {
      await api.post('/api/bank-transactions/categorize', {
        bankTransactionId: txn.id,
        accountId,
      });
      toast('Transaction added to register.', 'success');
    });
  };

  const handleMatch = (txn: BankTransaction) => {
    const journalEntryId = rowCandidateId[txn.id];
    if (!journalEntryId) {
      toast('Select a match candidate first.', 'danger');
      return;
    }
    withBusy(txn.id, async () => {
      await api.post('/api/bank-transactions/match', {
        bankTransactionId: txn.id,
        journalEntryId,
      });
      toast('Matched to existing transaction — nothing new was posted.', 'success');
    });
  };

  const handleExclude = (txn: BankTransaction) =>
    withBusy(txn.id, async () => {
      await api.post('/api/bank-transactions/exclude', { bankTransactionId: txn.id });
      toast('Transaction excluded from review.', 'success');
    });

  const handleRestore = (txn: BankTransaction) =>
    withBusy(txn.id, async () => {
      await api.post('/api/bank-transactions/exclude', {
        bankTransactionId: txn.id,
        restore: true,
      });
      toast('Transaction restored to the review queue.', 'success');
    });

  const handleUnmatch = (txn: BankTransaction) =>
    withBusy(txn.id, async () => {
      await api.post('/api/bank-transactions/unmatch', { bankTransactionId: txn.id });
      toast('Unmatched.', 'success');
    });

  async function handleAskAi(txn: BankTransaction) {
    setAskingId(txn.id);
    try {
      const r = await api.post<AiSuggestion & { reason: string }>('/api/ai/bank-suggestions', {
        action: 'llm',
        bankTransactionId: txn.id,
      });
      if (r.accountId) setRowAccountId((prev) => ({ ...prev, [txn.id]: r.accountId! }));
      setAiSugg((prev) => ({ ...prev, [txn.id]: { ...r, source: 'llm', autoApplyEligible: false } }));
      toast('AI suggestion selected — review it, then click Add.', 'info');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'AI suggestion failed.', 'danger');
    } finally {
      setAskingId(null);
    }
  }

  async function handleAutoApply() {
    if (!selectedBankAccountId) return;
    setBulkRunning(true);
    try {
      const r = await api.post<{ applied: unknown[]; skipped: unknown[] }>('/api/ai/bank-suggestions', {
        action: 'auto-apply',
        bankAccountId: selectedBankAccountId,
      });
      toast(
        `AI added ${r.applied.length} confident transaction(s) to the register` +
          (r.skipped.length ? ` (${r.skipped.length} skipped)` : '') +
          '. Undo any with Unmatch.',
        'success',
      );
      await fetchTransactions(selectedBankAccountId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Auto-apply failed.', 'danger');
    } finally {
      setBulkRunning(false);
    }
  }

  async function handleBulk(action: 'applyRules' | 'categorizeSuggested') {
    if (!selectedBankAccountId) return;
    setBulkRunning(true);
    try {
      const result = await api.post<{ count: number }>('/api/bank-transactions/bulk', {
        bankAccountId: selectedBankAccountId,
        action,
      });
      if (action === 'applyRules') {
        toast(`Rules applied: ${result.count} transaction(s) have a suggestion.`, 'success');
      } else {
        toast(`Auto-added ${result.count} transaction(s) to the register.`, 'success');
      }
      await fetchTransactions(selectedBankAccountId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Bulk action failed.', 'danger');
    } finally {
      setBulkRunning(false);
    }
  }

  // ------------------------------------------------------------------
  // Derived
  // ------------------------------------------------------------------

  const unreviewedRows = transactions.filter((t) => !t.matched && !t.excluded);
  const matchedRows = transactions.filter((t) => t.matched);
  const excludedRows = transactions.filter((t) => t.excluded && !t.matched);

  const visible =
    tab === 'unreviewed' ? unreviewedRows : tab === 'matched' ? matchedRows : excludedRows;

  const tabs: { key: ReviewTab; label: string; count: number }[] = [
    { key: 'unreviewed', label: 'To Review', count: unreviewedRows.length },
    { key: 'matched', label: 'Matched / Added', count: matchedRows.length },
    { key: 'excluded', label: 'Excluded', count: excludedRows.length },
  ];

  // ------------------------------------------------------------------
  // Row action cells
  // ------------------------------------------------------------------

  function renderActionCell(txn: BankTransaction) {
    if (tab === 'matched') {
      return (
        <Button
          variant="secondary"
          size="sm"
          loading={busyId === txn.id}
          onClick={() => handleUnmatch(txn)}
        >
          Unmatch
        </Button>
      );
    }
    if (tab === 'excluded') {
      return (
        <Button
          variant="secondary"
          size="sm"
          loading={busyId === txn.id}
          onClick={() => handleRestore(txn)}
        >
          Restore
        </Button>
      );
    }

    // Unreviewed: mode chooser + mode panel + exclude.
    const mode = rowMode[txn.id] ?? 'add';
    const candidates = rowCandidates[txn.id] ?? [];
    const busy = busyId === txn.id;
    const selectedCandidate =
      candidates.find((c) => c.entryId === rowCandidateId[txn.id]) ?? candidates[0];

    return (
      <div className="flex flex-col gap-2">
        {/* Mode chooser */}
        <div className="inline-flex rounded-md border border-navy/20 overflow-hidden w-fit text-xs">
          <button
            type="button"
            className={`px-3 py-1 font-semibold ${
              mode === 'add' ? 'bg-navy text-white' : 'bg-white text-navy/70 hover:bg-navy/5'
            }`}
            onClick={() => setRowMode((p) => ({ ...p, [txn.id]: 'add' }))}
          >
            Add
          </button>
          <button
            type="button"
            className={`px-3 py-1 font-semibold border-l border-navy/20 ${
              mode === 'match' ? 'bg-navy text-white' : 'bg-white text-navy/70 hover:bg-navy/5'
            }`}
            onClick={() => setRowMode((p) => ({ ...p, [txn.id]: 'match' }))}
          >
            Match{candidates.length > 0 ? ` (${candidates.length})` : ''}
          </button>
        </div>

        {/* Mode panel */}
        {mode === 'add' ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              className="min-w-[180px]"
              value={rowAccountId[txn.id] ?? ''}
              onChange={(e) =>
                setRowAccountId((prev) => ({ ...prev, [txn.id]: e.target.value }))
              }
            >
              <option value="">Select account…</option>
              {allAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              loading={busy}
              disabled={!rowAccountId[txn.id]}
              onClick={() => handleAdd(txn)}
            >
              Add
            </Button>
            {renderAiAssist(txn, busy)}
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleExclude(txn)}>
              Exclude
            </Button>
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-navy/50">
              No matching register transactions found (±14 days, same amount).
            </span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleExclude(txn)}>
              Exclude
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              className="min-w-[260px]"
              value={rowCandidateId[txn.id] ?? candidates[0].entryId}
              onChange={(e) =>
                setRowCandidateId((prev) => ({ ...prev, [txn.id]: e.target.value }))
              }
            >
              {candidates.map((c) => (
                <option key={c.entryId} value={c.entryId}>
                  #{c.entryNumber} · {formatDate(c.date)} · {c.description}
                  {c.reference ? ` · Ref ${c.reference}` : ''} · {c.confidence} match
                </option>
              ))}
            </Select>
            {selectedCandidate && <ConfidenceBadge c={selectedCandidate} />}
            <Button size="sm" loading={busy} onClick={() => handleMatch(txn)}>
              Confirm Match
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleExclude(txn)}>
              Exclude
            </Button>
          </div>
        )}
      </div>
    );
  }

  /** "Ask AI" for low-confidence rows, or the AI's one-line reason after it answered. */
  function renderAiAssist(txn: BankTransaction, busy: boolean) {
    const sg = aiSugg[txn.id];
    if (sg?.source === 'rule') return null;
    if (sg?.source === 'llm') {
      return sg.reason ? (
        <span className="text-xs text-navy/50 max-w-[220px] truncate" title={sg.reason}>
          AI: {sg.reason}
        </span>
      ) : null;
    }
    if (sg && sg.confidence >= aiMeta.threshold) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        loading={askingId === txn.id}
        disabled={busy}
        onClick={() => handleAskAi(txn)}
        title="Ask the AI model to pick an account (you still confirm)"
      >
        <Sparkles className="h-3.5 w-3.5" /> Ask AI
      </Button>
    );
  }

  function renderStatusCell(txn: BankTransaction) {
    if (txn.matched) {
      return (
        <span className="inline-flex items-center gap-1 text-emerald text-sm font-semibold">
          <CheckCircle className="h-4 w-4" />
          Matched
        </span>
      );
    }
    if (txn.excluded) return <Badge tone="neutral">Excluded</Badge>;
    const candidates = rowCandidates[txn.id] ?? [];
    const high = candidates.filter((c) => c.confidence === 'high');
    if (high.length === 1) {
      return (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-electric">
          <Link2 className="h-4 w-4" />
          Match found
        </span>
      );
    }
    if (txn.suggestedAccountId) return <Badge tone="info">Suggested</Badge>;
    const sg = aiSugg[txn.id];
    if (sg && sg.accountId && sg.source !== 'rule' && sg.confidence >= 0.4) {
      const tone =
        sg.confidence >= aiMeta.threshold ? 'success' : sg.confidence >= 0.6 ? 'info' : 'warning';
      return (
        <span
          title={
            sg.source === 'llm'
              ? 'Suggested by the AI model'
              : 'Learned from how you categorized similar transactions'
          }
        >
          <Badge tone={tone}>
            {sg.source === 'llm' ? 'AI pick' : `AI ${Math.round(sg.confidence * 100)}%`}
          </Badge>
        </span>
      );
    }
    return <Badge tone="warning">Review</Badge>;
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Bank Review" icon={CreditCard} />

      {/* ------------------------------------------------------------------ */}
      {/* Bank account selector + bulk actions                                 */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[240px]">
            <Label htmlFor="bank-account-select">Bank Account</Label>
            {loadingBankAccounts ? (
              <div className="py-2 flex">
                <Spinner className="text-electric" />
              </div>
            ) : (
              <Select
                id="bank-account-select"
                value={selectedBankAccountId}
                onChange={(e) => {
                  setSelectedBankAccountId(e.target.value);
                  setRowAccountId({});
                  setRowMode({});
                  setRowCandidates({});
                  setRowCandidateId({});
                  setAiSugg({});
                }}
              >
                {bankAccounts.length === 0 && (
                  <option value="">No bank accounts — add one in Banking.</option>
                )}
                {bankAccounts.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.bankName}
                    {ba.accountNumber ? ` (…${ba.accountNumber})` : ''} — {ba.glAccountCode}{' '}
                    {ba.glAccountName}
                  </option>
                ))}
              </Select>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              disabled={bulkRunning || !selectedBankAccountId}
              onClick={() => handleBulk('applyRules')}
            >
              Apply Rules
            </Button>
            <Button
              size="sm"
              disabled={bulkRunning || !selectedBankAccountId}
              onClick={() => handleBulk('categorizeSuggested')}
            >
              Auto-add Suggested
            </Button>
            {aiMeta.autoApplyEnabled && (
              <Button
                size="sm"
                variant="secondary"
                disabled={bulkRunning || !selectedBankAccountId}
                onClick={handleAutoApply}
                title="Post every line the learned categorizer is at least this confident about"
              >
                <Sparkles className="h-4 w-4" /> Auto-apply confident (≥
                {Math.round(aiMeta.threshold * 100)}%)
              </Button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        {transactions.length > 0 && (
          <div className="flex gap-2 mt-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-semibold border ${
                  tab === t.key
                    ? 'bg-navy text-white border-navy'
                    : 'bg-white text-navy/70 border-navy/20 hover:bg-navy/5'
                }`}
              >
                {t.label} ({t.count})
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Transactions table                                                   */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6">
        <h2 className="text-lg font-bold text-navy mb-4">
          {tabs.find((t) => t.key === tab)?.label ?? 'Transactions'}
        </h2>

        {loadingTxns ? (
          <div className="py-10 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : !selectedBankAccountId ? (
          <p className="text-sm text-navy/50 py-6 text-center">
            Select a bank account above to review transactions.
          </p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={
              tab === 'unreviewed'
                ? 'Nothing to review'
                : tab === 'matched'
                  ? 'No matched or added transactions yet'
                  : 'No excluded transactions'
            }
            message={
              tab === 'unreviewed'
                ? 'Import a bank file in the Banking page first.'
                : undefined
            }
            action={
              tab === 'unreviewed' ? (
                <Link
                  href="/banking"
                  className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-electric text-white hover:bg-electric/90 shadow-sm px-4 py-2 text-sm"
                >
                  Import Transactions
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Date</Th>
                <Th>Description / Payee</Th>
                <Th numeric>Amount</Th>
                <Th>{tab === 'unreviewed' ? 'Action — Add / Match / Exclude' : 'Action'}</Th>
                <Th className="text-center">Status</Th>
              </Tr>
            </thead>
            <tbody>
              {visible.map((txn) => {
                const amt = parseFloat(txn.amount);
                const amtPositive = amt >= 0;

                return (
                  <Tr key={txn.id} className={txn.matched ? 'opacity-70' : undefined}>
                    {/* Date */}
                    <Td className="whitespace-nowrap text-sm">{formatDate(txn.date)}</Td>

                    {/* Description */}
                    <Td>
                      <div className="text-sm font-medium">
                        {txn.payee || txn.description || '—'}
                      </div>
                      {txn.payee && txn.description && (
                        <div className="text-xs text-navy/50">{txn.description}</div>
                      )}
                    </Td>

                    {/* Amount */}
                    <Td numeric className="whitespace-nowrap">
                      <span
                        className={`text-sm font-semibold ${
                          amtPositive ? 'text-emerald' : 'text-red-500'
                        }`}
                      >
                        {formatCurrency(Math.abs(amt))}
                        <span className="ml-1 text-xs font-normal text-navy/40">
                          {amtPositive ? 'IN' : 'OUT'}
                        </span>
                      </span>
                    </Td>

                    {/* Action */}
                    <Td>{renderActionCell(txn)}</Td>

                    {/* Status */}
                    <Td className="text-center">{renderStatusCell(txn)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
