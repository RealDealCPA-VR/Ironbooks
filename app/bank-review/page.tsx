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
 *
 * Bank rules (team bankrules): every row shows ONE suggestion with a confidence % and the reason
 * (rule > your history > AI, see /api/bank-transactions/suggestions). Tick rows and "Accept
 * selected", or "Accept all high-confidence (>=90%)" — each line posts through the normal
 * categorize service in its own transaction; failures are listed and skipped. Repeating a choice
 * triggers "Always categorize SHELL OIL as Fuel?" which creates a rule in one click. Rules set to
 * "Add automatically" run when the account is opened.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, CreditCard, Inbox, Link2, SlidersHorizontal, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
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
  /** p1 fx: account currency (null = home); feed amounts are in it. */
  currency?: string | null;
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

/** bankrules: one merged suggestion per line (rule > history > AI) with confidence + reason. */
interface LineSuggestion {
  bankTransactionId: string;
  pattern: string;
  accountId: string | null;
  accountName: string | null;
  classId: string | null;
  payee: string | null;
  memo: string | null;
  splits: { accountId: string; classId?: string | null; percent: string }[] | null;
  confidence: number;
  reason: string;
  source: 'rule' | 'history' | 'ai' | null;
  ruleId: string | null;
  ruleName: string | null;
}

interface RuleOffer {
  pattern: string;
  direction: 'in' | 'out';
  accountId: string;
  accountName: string;
  count: number;
  question: string;
}

interface BulkResult {
  accepted: { bankTransactionId: string }[];
  failed: { bankTransactionId: string; reason: string }[];
  offers: RuleOffer[];
}

interface ClassRow {
  id: string;
  name: string;
  isActive?: boolean;
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
  // bankrules: merged suggestions, selection for bulk accept, learning offers, classes.
  const [sugg, setSugg] = useState<Record<string, LineSuggestion>>({});
  const [highConfidence, setHighConfidence] = useState(90);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [offers, setOffers] = useState<RuleOffer[]>([]);
  const [bulkFailures, setBulkFailures] = useState<BulkResult['failed']>([]);
  const [classList, setClassList] = useState<ClassRow[]>([]);
  const [rowClassId, setRowClassId] = useState<Record<string, string>>({});
  const [askingAll, setAskingAll] = useState(false);
  // p1 fx: exchange rate for adding feed lines of a foreign-currency account (blank = list rate).
  const [fxRate, setFxRate] = useState('');
  const feedCurrency = bankAccounts.find((b) => b.id === selectedBankAccountId)?.currency ?? null;

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

  const fetchSuggestions = useCallback(async (bankAccountId: string, ai = false) => {
    try {
      const res = await api.get<{ suggestions: LineSuggestion[]; highConfidence: number }>(
        `/api/bank-transactions/suggestions?bankAccountId=${bankAccountId}${ai ? '&ai=1' : ''}`,
      );
      const map: Record<string, LineSuggestion> = {};
      const accts: Record<string, string> = {};
      const cls: Record<string, string> = {};
      for (const sg of res.suggestions) {
        map[sg.bankTransactionId] = sg;
        if (sg.accountId && (sg.source === 'rule' || sg.confidence >= 40)) accts[sg.bankTransactionId] = sg.accountId;
        if (sg.classId) cls[sg.bankTransactionId] = sg.classId;
      }
      setSugg(map);
      setHighConfidence(res.highConfidence);
      // Suggestions fill in rows the user has not touched yet (an AI re-ask may update them).
      setRowAccountId((prev) => (ai ? { ...prev, ...accts } : { ...accts, ...prev }));
      setRowClassId((prev) => ({ ...cls, ...prev }));
    } catch {
      setSugg({});
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
      setSelected(new Set());

      // bankrules: merged rule / history / AI suggestion with confidence for every row.
      await fetchSuggestions(bankAccountId);

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
        setRowAccountId((prev) => ({ ...aiAccounts, ...prev }));
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
  }, [fetchSuggestions]);

  const fetchOffers = useCallback(async () => {
    try {
      const res = await api.get<{ offers: RuleOffer[] }>('/api/bank-rules/offers');
      setOffers(res.offers);
    } catch {
      setOffers([]);
    }
  }, []);

  useEffect(() => {
    fetchBankAccounts();
    fetchAccounts();
    fetchOffers();
    api
      .get<ClassRow[]>('/api/classes')
      .then((rows) => setClassList(rows.filter((c) => c.isActive !== false)))
      .catch(() => setClassList([]));
  }, [fetchBankAccounts, fetchAccounts, fetchOffers]);

  useEffect(() => {
    if (!selectedBankAccountId) return;
    let cancelled = false;
    (async () => {
      // bankrules: rules set to "Add automatically" run when the account is opened.
      try {
        const auto = await api.post<{ applied: unknown[]; skipped: unknown[] }>('/api/bank-rules/run', {
          bankAccountId: selectedBankAccountId,
        });
        if (!cancelled && auto.applied.length > 0) {
          toast(
            `Your rules added ${auto.applied.length} transaction(s) automatically` +
              (auto.skipped.length ? ` (${auto.skipped.length} could not be added)` : '') +
              '. See Matched / Added.',
            'success',
          );
        }
      } catch {
        // Read-only users or nothing to run — review continues normally.
      }
      if (!cancelled) await fetchTransactions(selectedBankAccountId);
    })();
    return () => {
      cancelled = true;
    };
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
    const sg = sugg[txn.id];
    const keepsSuggestion = !!sg && sg.accountId === accountId;
    const classId = rowClassId[txn.id] || null;
    withBusy(txn.id, async () => {
      const res = await api.post<{ ruleOffer: RuleOffer | null }>('/api/bank-transactions/categorize', {
        bankTransactionId: txn.id,
        accountId,
        ...(classId ? { classId } : {}),
        // bankrules: keep the suggestion's payee / memo / split when the user kept its account.
        ...(keepsSuggestion && sg.payee ? { payee: sg.payee } : {}),
        ...(keepsSuggestion && sg.memo ? { memo: sg.memo } : {}),
        ...(keepsSuggestion && sg.splits && !classId ? { splits: sg.splits } : {}),
        // p1 fx: a foreign-currency account posts at the stated rate (blank = currency list rate).
        ...(feedCurrency && fxRate.trim() ? { exchangeRate: fxRate.trim() } : {}),
      });
      toast('Transaction added to register.', 'success');
      if (res?.ruleOffer) {
        const offer = res.ruleOffer;
        setOffers((prev) => [offer, ...prev.filter((o) => !(o.pattern === offer.pattern && o.direction === offer.direction))]);
      }
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

  // ------------------------------------------------------------------
  // bankrules: bulk accept + learning offers
  // ------------------------------------------------------------------

  async function runBulkAccept(body: Record<string, unknown>, what: string) {
    setBulkRunning(true);
    setBulkFailures([]);
    try {
      const r = await api.post<BulkResult>('/api/bank-transactions/bulk-accept', {
        ...body,
        ...(feedCurrency && fxRate.trim() ? { exchangeRate: fxRate.trim() } : {}),
      });
      toast(
        `${what}: added ${r.accepted.length} transaction(s)` +
          (r.failed.length ? `, ${r.failed.length} could not be added (listed above the table)` : '') +
          '.',
        r.failed.length && !r.accepted.length ? 'danger' : 'success',
      );
      setBulkFailures(r.failed);
      if (r.offers) setOffers(r.offers);
      await fetchTransactions(selectedBankAccountId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Bulk accept failed.', 'danger');
    } finally {
      setBulkRunning(false);
    }
  }

  function handleAcceptSelected() {
    const ids = [...selected].filter((id) => unreviewedIds.has(id));
    if (ids.length === 0) {
      toast('Tick the transactions to accept first.', 'danger');
      return;
    }
    const missing = ids.filter((id) => !rowAccountId[id]);
    if (missing.length) {
      toast(`${missing.length} selected transaction(s) have no account yet — choose one or untick them.`, 'danger');
      return;
    }
    const items = ids.map((id) => {
      const sg = sugg[id];
      const accountId = rowAccountId[id];
      const classId = rowClassId[id] || null;
      const keeps = !!sg && sg.accountId === accountId;
      return {
        bankTransactionId: id,
        accountId,
        classId,
        payee: keeps ? sg.payee : null,
        memo: keeps ? sg.memo : null,
        splits: keeps && sg.splits && !classId ? sg.splits : null,
      };
    });
    runBulkAccept({ items }, 'Accept selected');
  }

  function handleAcceptHighConfidence() {
    if (!selectedBankAccountId) return;
    runBulkAccept({ bankAccountId: selectedBankAccountId, allHighConfidence: true }, 'Accept all high-confidence');
  }

  async function handleAskAiAll() {
    if (!selectedBankAccountId) return;
    setAskingAll(true);
    try {
      await fetchSuggestions(selectedBankAccountId, true);
      toast('Asked the AI model about the least certain lines (only if one is set up in Settings).', 'info');
    } finally {
      setAskingAll(false);
    }
  }

  async function handleOffer(o: RuleOffer, action: 'accept' | 'auto' | 'dismiss') {
    try {
      if (action === 'dismiss') {
        await api.post('/api/bank-rules/offers', { action: 'dismiss', pattern: o.pattern, accountId: o.accountId });
      } else {
        await api.post('/api/bank-rules/offers', {
          action: 'accept',
          pattern: o.pattern,
          accountId: o.accountId,
          direction: o.direction,
          mode: action === 'auto' ? 'auto' : 'suggest',
        });
        toast(`Rule created: ${o.pattern} goes to ${o.accountName}.`, 'success');
        if (selectedBankAccountId) await fetchSuggestions(selectedBankAccountId);
      }
      setOffers((prev) => prev.filter((x) => !(x.pattern === o.pattern && x.accountId === o.accountId)));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that.', 'danger');
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
  const unreviewedIds = new Set(unreviewedRows.map((t) => t.id));
  const highCount = unreviewedRows.filter(
    (t) => !!sugg[t.id]?.accountId && (sugg[t.id]?.confidence ?? 0) >= highConfidence,
  ).length;
  const selectedCount = [...selected].filter((id) => unreviewedIds.has(id)).length;
  const allSelected = unreviewedRows.length > 0 && selectedCount === unreviewedRows.length;
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

        {/* bankrules: the merged suggestion and why */}
        {mode === 'add' && renderSuggestionNote(txn)}

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
            {classList.length > 0 && (
              <Select
                aria-label="Class"
                className="min-w-[120px] w-auto"
                value={rowClassId[txn.id] ?? ''}
                onChange={(e) => setRowClassId((prev) => ({ ...prev, [txn.id]: e.target.value }))}
              >
                <option value="">No class</option>
                {classList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
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

  /** bankrules: "Fuel · 95% sure · Matched rule "Shell"" under the account picker. */
  function renderSuggestionNote(txn: BankTransaction) {
    const sg = sugg[txn.id];
    if (!sg || !sg.accountId) return null;
    const differs = rowAccountId[txn.id] && rowAccountId[txn.id] !== sg.accountId;
    return (
      <div className="text-xs text-navy/60 max-w-[460px]">
        <span className="font-semibold text-navy/80">Suggested: {sg.accountName ?? 'account'}</span>
        {sg.splits ? ' (split)' : ''} · {sg.confidence}% sure · <span title={sg.reason}>{sg.reason}</span>
        {differs && (
          <>
            {' '}
            <button
              type="button"
              className="text-electric underline"
              onClick={() => setRowAccountId((prev) => ({ ...prev, [txn.id]: sg.accountId! }))}
            >
              Use suggestion
            </button>
          </>
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
    const merged = sugg[txn.id];
    if (merged && merged.accountId && !aiSugg[txn.id]?.reason) {
      const tone = merged.confidence >= highConfidence ? 'success' : merged.confidence >= 60 ? 'info' : 'warning';
      const label =
        merged.source === 'rule' ? 'Rule' : merged.source === 'history' ? 'History' : 'AI';
      return (
        <span title={merged.reason}>
          <Badge tone={tone}>
            {label} {merged.confidence}%
          </Badge>
          <span className="sr-only">: {merged.reason}</span>
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
      <PageHeader
        title="Bank Review"
        icon={CreditCard}
        action={
          <Link
            href="/bank-rules"
            className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-white text-navy border border-slate-200 hover:bg-slate-50 px-3 py-1.5 text-sm"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Bank rules
          </Link>
        }
      />

      {/* bankrules: learning offers ("Always categorize SHELL OIL as Fuel?") */}
      {offers.length > 0 && (
        <Card className="p-4 mb-6" aria-live="polite">
          <h2 className="text-sm font-bold text-navy mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-electric" aria-hidden="true" /> Make it automatic?
          </h2>
          <ul className="divide-y divide-slate-100">
            {offers.slice(0, 5).map((o) => (
              <li key={`${o.pattern}|${o.direction}|${o.accountId}`} className="py-2 flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-[220px] text-sm text-navy">
                  {o.question} <span className="text-xs text-navy/50">(you chose it {o.count} times)</span>
                </span>
                <Button size="sm" onClick={() => handleOffer(o, 'accept')}>
                  Yes, create rule
                </Button>
                <Button size="sm" variant="secondary" onClick={() => handleOffer(o, 'auto')}>
                  Yes, and add automatically
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleOffer(o, 'dismiss')}>
                  No thanks
                </Button>
              </li>
            ))}
          </ul>
          {offers.length > 5 && (
            <Link href="/bank-rules" className="text-xs text-electric underline">
              {offers.length - 5} more on the Bank rules page
            </Link>
          )}
        </Card>
      )}

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
                  setSugg({});
                  setRowClassId({});
                  setSelected(new Set());
                  setBulkFailures([]);
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
              size="sm"
              disabled={bulkRunning || !selectedBankAccountId || highCount === 0}
              onClick={handleAcceptHighConfidence}
              title="Add every line whose suggestion is at least this sure, each through the normal review step"
            >
              <CheckCircle className="h-4 w-4" /> Accept all high-confidence (≥{highConfidence}%) ({highCount})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={bulkRunning || selectedCount === 0}
              onClick={handleAcceptSelected}
            >
              Accept selected ({selectedCount})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={askingAll}
              disabled={bulkRunning || !selectedBankAccountId}
              onClick={handleAskAiAll}
              title="Ask the AI model you set up (Settings → AI & Automation) about the least certain lines"
            >
              <Sparkles className="h-4 w-4" /> Ask AI about unsure lines
            </Button>
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
          <>
          {bulkFailures.length > 0 && tab === 'unreviewed' && (
            <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <div className="font-semibold mb-1">These lines could not be added — fix them one by one:</div>
              <ul className="list-disc pl-5">
                {bulkFailures.map((f) => {
                  const t = transactions.find((x) => x.id === f.bankTransactionId);
                  return (
                    <li key={f.bankTransactionId}>
                      {t ? `${formatDate(t.date)} ${t.payee || t.description || ''}` : 'Transaction'}: {f.reason}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {feedCurrency && tab === 'unreviewed' && (
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-100 text-sm text-navy/70">
              <span>
                This account is in <span className="font-semibold">{feedCurrency}</span>. Amounts below are in {feedCurrency};
                adding a line records its home-currency value at
              </span>
              <Input
                aria-label="Exchange rate"
                className="w-36"
                type="number"
                step="0.00000001"
                min="0.00000001"
                placeholder="today's list rate"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
              />
              <span className="text-xs text-navy/40">(home units per 1 {feedCurrency}; leave blank to use the Currencies list)</span>
            </div>
          )}
          <Table>
            <thead>
              <Tr>
                {tab === 'unreviewed' && (
                  <Th>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-electric"
                      aria-label="Select all transactions to review"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(unreviewedRows.map((t) => t.id)))}
                    />
                  </Th>
                )}
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
                    {tab === 'unreviewed' && (
                      <Td>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-electric"
                          aria-label={`Select ${txn.payee || txn.description || 'transaction'} ${formatDate(txn.date)}`}
                          checked={selected.has(txn.id)}
                          onChange={() => toggleRow(txn.id)}
                        />
                      </Td>
                    )}
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
                        {formatCurrency(Math.abs(amt), feedCurrency ?? undefined)}
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
          </>
        )}
      </Card>
    </main>
  );
}
