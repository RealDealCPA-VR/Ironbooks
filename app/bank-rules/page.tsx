'use client';

/**
 * Bank rules (team bankrules) — QB "Bank Feeds Rules", plus rules the app learns by itself.
 *
 *  - Learned offers at the top: "Always categorize SHELL OIL as Fuel?" (one click to create).
 *  - The rules list in the order they are checked: move up / down, switch on / off, edit, test,
 *    delete. The first matching rule wins.
 *  - Editor: conditions (text contains / starts with / is exactly / pattern, money in / out,
 *    amount equals or between, bank account) → actions (account or a split by %, class, payee,
 *    memo) → mode (suggest for review, or add automatically). "Test" shows which recent bank
 *    lines the rule would catch before saving.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, FlaskConical, Plus, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Label,
  Modal,
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

interface Account { id: string; code: string; name: string; type: string; isActive?: boolean }
interface ClassRow { id: string; name: string; isActive?: boolean }
interface BankAccount { id: string; bankName: string; accountNumber: string; glAccountName?: string }

interface Split { accountId: string; classId?: string | null; percent: string }

interface Rule {
  id: string;
  name: string;
  matchField: 'description' | 'payee' | 'any' | 'amount';
  matchOperator: 'contains' | 'starts_with' | 'equals' | 'pattern';
  matchValue: string;
  bankAccountId: string | null;
  direction: 'any' | 'in' | 'out';
  amountMin: string | null;
  amountMax: string | null;
  setAccountId: string | null;
  setClassId: string | null;
  setPayee: string | null;
  setMemo: string | null;
  splits: Split[] | null;
  mode: 'suggest' | 'auto';
  enabled: boolean;
  learned: boolean;
  priority: number;
  appliedCount: number;
  lastAppliedAt: string | null;
  updatedAt: string;
}

interface Offer {
  pattern: string;
  direction: 'in' | 'out';
  accountId: string;
  accountName: string;
  className: string | null;
  payee: string | null;
  count: number;
  question: string;
}

interface TestHit {
  bankTransactionId: string;
  date: string;
  description: string | null;
  payee: string | null;
  amount: string;
  status: 'to_review' | 'added' | 'excluded';
  shadowedBy: { id: string; name: string } | null;
}

type AmountKind = 'any' | 'equals' | 'between';

interface Draft {
  id: string | null;
  updatedAt: string | null;
  name: string;
  matchField: Rule['matchField'];
  matchOperator: Rule['matchOperator'];
  matchValue: string;
  direction: Rule['direction'];
  amountKind: AmountKind;
  amountMin: string;
  amountMax: string;
  bankAccountId: string;
  useSplit: boolean;
  setAccountId: string;
  setClassId: string;
  setPayee: string;
  setMemo: string;
  splits: Split[];
  mode: Rule['mode'];
  enabled: boolean;
}

const FIELD_LABEL: Record<Rule['matchField'], string> = {
  description: 'Bank description',
  payee: 'Payee',
  any: 'Description or payee',
  amount: 'Amount',
};
const OPERATOR_LABEL: Record<Rule['matchOperator'], string> = {
  contains: 'contains',
  starts_with: 'starts with',
  equals: 'is exactly',
  pattern: 'matches pattern',
};

function emptyDraft(): Draft {
  return {
    id: null,
    updatedAt: null,
    name: '',
    matchField: 'any',
    matchOperator: 'contains',
    matchValue: '',
    direction: 'any',
    amountKind: 'any',
    amountMin: '',
    amountMax: '',
    bankAccountId: '',
    useSplit: false,
    setAccountId: '',
    setClassId: '',
    setPayee: '',
    setMemo: '',
    splits: [
      { accountId: '', classId: '', percent: '50' },
      { accountId: '', classId: '', percent: '50' },
    ],
    mode: 'suggest',
    enabled: true,
  };
}

function draftFromRule(r: Rule): Draft {
  const amountKind: AmountKind =
    !r.amountMin && !r.amountMax ? 'any' : r.amountMin && r.amountMin === r.amountMax ? 'equals' : 'between';
  const hasSplit = !!r.splits && r.splits.length > 0;
  return {
    id: r.id,
    updatedAt: r.updatedAt,
    name: r.name,
    matchField: r.matchField,
    matchOperator: r.matchOperator,
    matchValue: r.matchValue ?? '',
    direction: r.direction,
    amountKind,
    amountMin: r.amountMin ?? '',
    amountMax: r.amountMax ?? '',
    bankAccountId: r.bankAccountId ?? '',
    useSplit: hasSplit,
    setAccountId: r.setAccountId ?? '',
    setClassId: r.setClassId ?? '',
    setPayee: r.setPayee ?? '',
    setMemo: r.setMemo ?? '',
    splits: hasSplit
      ? r.splits!.map((s) => ({ accountId: s.accountId, classId: s.classId ?? '', percent: String(s.percent) }))
      : emptyDraft().splits,
    mode: r.mode,
    enabled: r.enabled,
  };
}

function draftToBody(d: Draft) {
  return {
    name: d.name,
    matchField: d.matchField,
    matchOperator: d.matchOperator,
    matchValue: d.matchValue,
    direction: d.direction,
    amountMin: d.amountKind === 'any' ? null : d.amountMin || null,
    amountMax: d.amountKind === 'any' ? null : d.amountKind === 'equals' ? d.amountMin || null : d.amountMax || null,
    bankAccountId: d.bankAccountId || null,
    setAccountId: d.useSplit ? null : d.setAccountId || null,
    setClassId: d.setClassId || null,
    setPayee: d.setPayee || null,
    setMemo: d.setMemo || null,
    splits: d.useSplit
      ? d.splits.map((s) => ({ accountId: s.accountId, classId: s.classId || null, percent: s.percent }))
      : null,
    mode: d.mode,
    enabled: d.enabled,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BankRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classList, setClassList] = useState<ClassRow[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ checked: number; hits: TestHit[] } | null>(null);
  const [toDelete, setToDelete] = useState<Rule | null>(null);

  const acctName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.code} — ${a.name}`])), [accounts]);
  const className = useMemo(() => new Map(classList.map((c) => [c.id, c.name])), [classList]);
  const bankName = useMemo(
    () => new Map(bankAccounts.map((b) => [b.id, `${b.bankName}${b.accountNumber ? ` (…${b.accountNumber.slice(-4)})` : ''}`])),
    [bankAccounts],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, o] = await Promise.all([
        api.get<{ rules: Rule[] }>('/api/bank-rules'),
        api.get<{ offers: Offer[] }>('/api/bank-rules/offers').catch(() => ({ offers: [] as Offer[] })),
      ]);
      setRules(r.rules);
      setOffers(o.offers);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load rules.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => toast('Could not load accounts.', 'danger'));
    api.get<ClassRow[]>('/api/classes').then(setClassList).catch(() => setClassList([]));
    api.get<BankAccount[]>('/api/bank-accounts').then(setBankAccounts).catch(() => setBankAccounts([]));
  }, [load]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  const move = (index: number, delta: -1 | 1) =>
    run(`move-${index}`, async () => {
      const ids = rules.map((r) => r.id);
      const j = index + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[index], ids[j]] = [ids[j], ids[index]];
      const res = await api.post<{ rules: Rule[] }>('/api/bank-rules/reorder', { orderedIds: ids });
      setRules(res.rules);
    });

  const toggle = (r: Rule) =>
    run(`toggle-${r.id}`, async () => {
      const updated = await api.put<Rule>(`/api/bank-rules/${r.id}`, { enabled: !r.enabled, expectedUpdatedAt: r.updatedAt });
      setRules((prev) => prev.map((x) => (x.id === r.id ? updated : x)));
      toast(updated.enabled ? `"${r.name}" is on.` : `"${r.name}" is off — it will not be used.`, 'success');
    });

  const acceptOffer = (o: Offer, mode: 'suggest' | 'auto') =>
    run(`offer-${o.pattern}-${o.accountId}`, async () => {
      await api.post('/api/bank-rules/offers', { action: 'accept', pattern: o.pattern, accountId: o.accountId, direction: o.direction, mode });
      toast(`Rule created: ${o.pattern} → ${o.accountName}.`, 'success');
      await load();
    });

  const dismissOffer = (o: Offer) =>
    run(`offer-${o.pattern}-${o.accountId}`, async () => {
      await api.post('/api/bank-rules/offers', { action: 'dismiss', pattern: o.pattern, accountId: o.accountId });
      setOffers((prev) => prev.filter((x) => !(x.pattern === o.pattern && x.accountId === o.accountId)));
    });

  async function confirmDelete() {
    if (!toDelete) return;
    const r = toDelete;
    await run(`delete-${r.id}`, async () => {
      await api.del(`/api/bank-rules/${r.id}`);
      toast(`Rule "${r.name}" deleted.`, 'success');
      setToDelete(null);
      await load();
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const body = draftToBody(draft);
      if (draft.id) {
        await api.put(`/api/bank-rules/${draft.id}`, { ...body, expectedUpdatedAt: draft.updatedAt });
        toast('Rule saved.', 'success');
      } else {
        await api.post('/api/bank-rules', body);
        toast('Rule created. It is checked first; move it down if another rule should win.', 'success');
      }
      setDraft(null);
      setTestResult(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the rule.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function test(d: Draft) {
    setTesting(true);
    try {
      const res = await api.post<{ checked: number; hits: TestHit[] }>('/api/bank-rules/test', {
        ...draftToBody(d),
        id: d.id,
      });
      setTestResult(res);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not test the rule.', 'danger');
    } finally {
      setTesting(false);
    }
  }

  // ------------------------------------------------------------------
  // Summaries
  // ------------------------------------------------------------------

  function conditionSummary(r: Rule): string {
    const parts: string[] = [];
    if (r.matchValue) {
      parts.push(
        r.matchField === 'amount'
          ? `Amount is ${r.matchValue}`
          : `${FIELD_LABEL[r.matchField]} ${OPERATOR_LABEL[r.matchOperator]} “${r.matchValue}”`,
      );
    }
    if (r.direction === 'in') parts.push('Money in');
    if (r.direction === 'out') parts.push('Money out');
    if (r.amountMin && r.amountMax && r.amountMin === r.amountMax) parts.push(`Amount ${formatCurrency(r.amountMin)}`);
    else if (r.amountMin && r.amountMax) parts.push(`${formatCurrency(r.amountMin)}–${formatCurrency(r.amountMax)}`);
    else if (r.amountMin) parts.push(`At least ${formatCurrency(r.amountMin)}`);
    else if (r.amountMax) parts.push(`Up to ${formatCurrency(r.amountMax)}`);
    if (r.bankAccountId) parts.push(`Only ${bankName.get(r.bankAccountId) ?? 'one bank account'}`);
    return parts.join(' · ') || 'Every line';
  }

  function actionSummary(r: Rule): string {
    const parts: string[] = [];
    if (r.splits && r.splits.length > 0) {
      parts.push(
        'Split: ' + r.splits.map((s) => `${s.percent}% ${acctName.get(s.accountId) ?? '?'}`).join(' / '),
      );
    } else if (r.setAccountId) {
      parts.push(acctName.get(r.setAccountId) ?? 'Account');
    }
    if (r.setClassId) parts.push(`Class ${className.get(r.setClassId) ?? '?'}`);
    if (r.setPayee) parts.push(`Payee ${r.setPayee}`);
    if (r.setMemo) parts.push(`Memo “${r.setMemo}”`);
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Bank rules"
        icon={SlidersHorizontal}
        action={
          <Button
            onClick={() => {
              setTestResult(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus className="h-4 w-4" /> New rule
          </Button>
        }
      />

      <p className="text-sm text-navy/60 mb-6 max-w-3xl">
        A rule says where a bank line goes, for example “anything that contains SHELL goes to Fuel”. Rules are
        checked from the top down and the first one that fits is used. A rule can just <strong>suggest</strong> the
        account on the{' '}
        <Link href="/bank-review" className="text-electric underline">
          review screen
        </Link>{' '}
        or <strong>add the line automatically</strong>.
      </p>

      {offers.length > 0 && (
        <Card className="p-6 mb-6">
          <h2 className="text-lg font-bold text-navy mb-1 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-electric" aria-hidden="true" /> Rules we can make for you
          </h2>
          <p className="text-sm text-navy/50 mb-4">You put these bank lines in the same place more than once.</p>
          <ul className="divide-y divide-slate-100">
            {offers.map((o) => {
              const key = `offer-${o.pattern}-${o.accountId}`;
              return (
                <li key={`${o.pattern}|${o.direction}|${o.accountId}`} className="py-3 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[240px]">
                    <div className="text-sm font-semibold text-navy">{o.question}</div>
                    <div className="text-xs text-navy/50">
                      You chose this {o.count} times · money {o.direction === 'in' ? 'in' : 'out'}
                      {o.payee ? ` · payee ${o.payee}` : ''}
                    </div>
                  </div>
                  <Button size="sm" loading={busy === key} onClick={() => acceptOffer(o, 'suggest')}>
                    Yes, suggest it
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy === key} onClick={() => acceptOffer(o, 'auto')}>
                    Yes, add automatically
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === key} onClick={() => dismissOffer(o)}>
                    No thanks
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="p-6">
        <h2 className="text-lg font-bold text-navy mb-4">Your rules ({rules.length})</h2>
        {loading ? (
          <div className="py-10 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No rules yet"
            message="Create one, or keep categorizing on the review screen — when you repeat a choice we will offer to make the rule for you."
            action={
              <Button onClick={() => setDraft(emptyDraft())}>
                <Plus className="h-4 w-4" /> New rule
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Order</Th>
                <Th>When a bank line…</Th>
                <Th>Then put it in…</Th>
                <Th>How</Th>
                <Th numeric>Used</Th>
                <Th>On</Th>
                <Th>Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <Tr key={r.id} className={r.enabled ? undefined : 'opacity-60'}>
                  <Td className="whitespace-nowrap">
                    <span className="text-sm font-semibold text-navy mr-2">{i + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move "${r.name}" up`}
                      disabled={i === 0 || busy !== null}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move "${r.name}" down`}
                      disabled={i === rules.length - 1 || busy !== null}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </Td>
                  <Td>
                    <div className="text-sm font-semibold text-navy">
                      {r.name} {r.learned && <Badge tone="info">Learned</Badge>}
                    </div>
                    <div className="text-xs text-navy/60">{conditionSummary(r)}</div>
                  </Td>
                  <Td className="text-sm">{actionSummary(r)}</Td>
                  <Td>
                    {r.mode === 'auto' ? <Badge tone="success">Adds automatically</Badge> : <Badge tone="neutral">Suggests</Badge>}
                  </Td>
                  <Td numeric className="text-sm">
                    <span title={r.lastAppliedAt ? `Last used ${formatDate(r.lastAppliedAt)}` : 'Not used yet'}>{r.appliedCount}</span>
                  </Td>
                  <Td>
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={`Use rule "${r.name}"`}
                        checked={r.enabled}
                        disabled={busy === `toggle-${r.id}`}
                        onChange={() => toggle(r)}
                        className="h-4 w-4 accent-electric"
                      />
                      {r.enabled ? 'On' : 'Off'}
                    </label>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setTestResult(null);
                        setDraft(draftFromRule(r));
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Test rule "${r.name}" on recent bank lines`}
                      onClick={() => {
                        const d = draftFromRule(r);
                        setDraft(d);
                        test(d);
                      }}
                    >
                      <FlaskConical className="h-4 w-4" /> Test
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Delete rule "${r.name}"`} onClick={() => setToDelete(r)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {draft && (
        <RuleEditor
          draft={draft}
          setDraft={setDraft}
          accounts={accounts.filter((a) => a.isActive !== false)}
          classList={classList.filter((c) => c.isActive !== false)}
          bankAccounts={bankAccounts}
          saving={saving}
          testing={testing}
          testResult={testResult}
          onSave={save}
          onTest={() => test(draft)}
          onClose={() => {
            setDraft(null);
            setTestResult(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="Delete rule?"
        message={toDelete ? `"${toDelete.name}" will no longer be used. Transactions it already categorized stay as they are.` : undefined}
        confirmLabel="Delete rule"
        tone="danger"
        loading={!!toDelete && busy === `delete-${toDelete.id}`}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function RuleEditor({
  draft,
  setDraft,
  accounts,
  classList,
  bankAccounts,
  saving,
  testing,
  testResult,
  onSave,
  onTest,
  onClose,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  accounts: Account[];
  classList: ClassRow[];
  bankAccounts: BankAccount[];
  saving: boolean;
  testing: boolean;
  testResult: { checked: number; hits: TestHit[] } | null;
  onSave: () => void;
  onTest: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const splitTotal = draft.splits.reduce((sum, s) => sum + (Number.isFinite(Number(s.percent)) ? Math.round(Number(s.percent) * 10000) : 0), 0) / 10000;
  const setSplit = (i: number, patch: Partial<Split>) =>
    set('splits', draft.splits.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const accountOptions = (
    <>
      <option value="">Choose an account…</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.code} — {a.name}
        </option>
      ))}
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? 'Edit bank rule' : 'New bank rule'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" loading={testing} onClick={onTest}>
            <FlaskConical className="h-4 w-4" /> Test on recent lines
          </Button>
          <Button loading={saving} onClick={onSave}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <Label htmlFor="rule-name" required>
            Rule name
          </Label>
          <Input id="rule-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Fuel" />
        </div>

        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-sm font-bold text-navy">When a bank line…</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="rule-field">Look at</Label>
              <Select id="rule-field" value={draft.matchField} onChange={(e) => set('matchField', e.target.value as Draft['matchField'])}>
                <option value="any">Description or payee</option>
                <option value="description">Bank description</option>
                <option value="payee">Payee</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="rule-op">Condition</Label>
              <Select id="rule-op" value={draft.matchOperator} onChange={(e) => set('matchOperator', e.target.value as Draft['matchOperator'])}>
                <option value="contains">contains</option>
                <option value="starts_with">starts with</option>
                <option value="equals">is exactly</option>
                <option value="pattern">matches pattern</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="rule-value">Text</Label>
              <Input
                id="rule-value"
                value={draft.matchValue}
                onChange={(e) => set('matchValue', e.target.value)}
                placeholder={draft.matchOperator === 'pattern' ? 'SHELL*OIL' : 'SHELL OIL'}
                aria-describedby="rule-value-help"
              />
            </div>
          </div>
          <p id="rule-value-help" className="mt-1 text-xs text-navy/50">
            Capital letters do not matter. Store numbers, dates and card digits are ignored. In a pattern, * means
            “anything” and ? means “any one character”.
          </p>

          <div className="grid gap-3 sm:grid-cols-3 mt-3">
            <div>
              <Label htmlFor="rule-direction">Money</Label>
              <Select id="rule-direction" value={draft.direction} onChange={(e) => set('direction', e.target.value as Draft['direction'])}>
                <option value="any">In or out</option>
                <option value="out">Money out (spent)</option>
                <option value="in">Money in (received)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="rule-amount-kind">Amount</Label>
              <Select id="rule-amount-kind" value={draft.amountKind} onChange={(e) => set('amountKind', e.target.value as AmountKind)}>
                <option value="any">Any amount</option>
                <option value="equals">Is exactly</option>
                <option value="between">Is between</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="rule-bank">Bank account</Label>
              <Select id="rule-bank" value={draft.bankAccountId} onChange={(e) => set('bankAccountId', e.target.value)}>
                <option value="">Any bank account</option>
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bankName}
                    {b.accountNumber ? ` (…${b.accountNumber.slice(-4)})` : ''}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {draft.amountKind !== 'any' && (
            <div className="grid gap-3 sm:grid-cols-3 mt-3">
              <div>
                <Label htmlFor="rule-amount-min">{draft.amountKind === 'equals' ? 'Amount' : 'From'}</Label>
                <Input id="rule-amount-min" inputMode="decimal" value={draft.amountMin} onChange={(e) => set('amountMin', e.target.value)} placeholder="0.00" />
              </div>
              {draft.amountKind === 'between' && (
                <div>
                  <Label htmlFor="rule-amount-max">To</Label>
                  <Input id="rule-amount-max" inputMode="decimal" value={draft.amountMax} onChange={(e) => set('amountMax', e.target.value)} placeholder="0.00" />
                </div>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-sm font-bold text-navy">Then…</legend>
          <label className="inline-flex items-center gap-2 text-sm mb-3">
            <input type="checkbox" className="h-4 w-4 accent-electric" checked={draft.useSplit} onChange={(e) => set('useSplit', e.target.checked)} />
            Split it between several accounts by percentage
          </label>
          {!draft.useSplit ? (
            <div>
              <Label htmlFor="rule-account" required>
                Put it in account
              </Label>
              <Select id="rule-account" value={draft.setAccountId} onChange={(e) => set('setAccountId', e.target.value)}>
                {accountOptions}
              </Select>
            </div>
          ) : (
            <div className="space-y-2" role="group" aria-label="Split lines">
              {draft.splits.map((s, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_110px_auto] items-end">
                  <div>
                    <Label htmlFor={`split-acct-${i}`}>Account {i + 1}</Label>
                    <Select id={`split-acct-${i}`} value={s.accountId} onChange={(e) => setSplit(i, { accountId: e.target.value })}>
                      {accountOptions}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`split-class-${i}`}>Class</Label>
                    <Select id={`split-class-${i}`} value={s.classId ?? ''} onChange={(e) => setSplit(i, { classId: e.target.value })}>
                      <option value="">No class</option>
                      {classList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`split-pct-${i}`}>Percent</Label>
                    <Input id={`split-pct-${i}`} inputMode="decimal" value={s.percent} onChange={(e) => setSplit(i, { percent: e.target.value })} />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove split line ${i + 1}`}
                    disabled={draft.splits.length <= 2}
                    onClick={() => set('splits', draft.splits.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => set('splits', [...draft.splits, { accountId: '', classId: '', percent: '0' }])}
                >
                  <Plus className="h-4 w-4" /> Add split line
                </Button>
                <span className={`text-sm ${splitTotal === 100 ? 'text-emerald' : 'text-red-600'}`} role="status">
                  Total {splitTotal}% {splitTotal === 100 ? '' : '(must be 100%)'}
                </span>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3 mt-3">
            {!draft.useSplit && (
              <div>
                <Label htmlFor="rule-class">Class</Label>
                <Select id="rule-class" value={draft.setClassId} onChange={(e) => set('setClassId', e.target.value)}>
                  <option value="">No class</option>
                  {classList.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="rule-payee">Payee name</Label>
              <Input id="rule-payee" value={draft.setPayee} onChange={(e) => set('setPayee', e.target.value)} placeholder="e.g. Shell" />
            </div>
            <div>
              <Label htmlFor="rule-memo">Memo</Label>
              <Input id="rule-memo" value={draft.setMemo} onChange={(e) => set('setMemo', e.target.value)} />
            </div>
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-sm font-bold text-navy">How</legend>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="rule-mode" className="mt-1 accent-electric" checked={draft.mode === 'suggest'} onChange={() => set('mode', 'suggest')} />
              <span>
                <strong>Suggest</strong> — fill in the account on the review screen; you confirm each line.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="rule-mode" className="mt-1 accent-electric" checked={draft.mode === 'auto'} onChange={() => set('mode', 'auto')} />
              <span>
                <strong>Add automatically</strong> — add matching lines to your books without asking (you can still undo
                each one with Unmatch).
              </span>
            </label>
            <label className="flex items-center gap-2 pt-1">
              <input type="checkbox" className="h-4 w-4 accent-electric" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Rule is on
            </label>
          </div>
        </fieldset>

        {testResult && (
          <section aria-live="polite" className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-bold text-navy mb-2">
              Test: {testResult.hits.length} of the last {testResult.checked} bank lines match
            </h3>
            {testResult.hits.length === 0 ? (
              <p className="text-sm text-navy/50">Nothing matched. Try fewer words or “contains”.</p>
            ) : (
              <div className="max-h-64 overflow-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>Date</Th>
                      <Th>Bank line</Th>
                      <Th numeric>Amount</Th>
                      <Th>Status</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {testResult.hits.slice(0, 100).map((h) => (
                      <Tr key={h.bankTransactionId}>
                        <Td className="whitespace-nowrap text-sm">{formatDate(h.date)}</Td>
                        <Td className="text-sm">
                          {h.description || h.payee || '—'}
                          {h.shadowedBy && (
                            <div className="text-xs text-yellow-800">Rule “{h.shadowedBy.name}” is checked first and would win.</div>
                          )}
                        </Td>
                        <Td numeric className="text-sm whitespace-nowrap">
                          {formatCurrency(h.amount.replace(/^-/, ''))} {h.amount.startsWith('-') ? 'out' : 'in'}
                        </Td>
                        <Td>
                          <Badge tone={h.status === 'to_review' ? 'warning' : 'neutral'}>
                            {h.status === 'to_review' ? 'To review' : h.status === 'added' ? 'Added' : 'Excluded'}
                          </Badge>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
