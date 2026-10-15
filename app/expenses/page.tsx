'use client';

/**
 * Write Checks / Expenses — QB-style direct spend entry.
 *
 * Records non-bill spend straight against expense accounts:
 *   - Check (with auto-next check number, or "Print Later" → Print Checks queue)
 *   - Cash
 *   - Credit Card Charge / Credit Card Credit (refund)
 *
 * Form posts to /api/expenses; the service posts Dr expense lines / Cr payment
 * account (flipped for CC credits) through the central posting engine.
 *
 * wave2 purchases: Items tab per line (inventory items receive stock), Edit of a saved
 * check/charge (PATCH /api/expenses/:id), duplicate check-number warning with override,
 * the vendor's own pre-fill accounts, and foreign-currency checks (exchange rate).
 */

import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';
import { Suspense, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Banknote, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  Modal,
  toast, toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api, ApiError } from '@/lib/client';
import { fetchVendorPrefill, PREFILL_SOURCE_LABEL } from '@/lib/aiClient';
import { Money, formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { useNewParam } from '@/lib/useFocusParam';
import { type PurchaseVendor, saveWithDuplicateCheck, vendorPrefillAccountIds } from '@/lib/purchasesClient';
// wave2 prefs: Preferences-driven defaults/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { confirmTransactionDate, confirmUniqueNumber, findDuplicateNumber } from '@/lib/formPrefs';
import MemorizeButton from '@/components/MemorizeButton';
import AttachmentPanel from '@/components/AttachmentPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Expense {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  /** B3: payee from the Other Names list. */
  otherNameId?: string | null;
  otherName?: string | null;
  payeeName: string | null;
  date: string;
  method: string;
  reference: string | null;
  paymentAccountId: string;
  paymentAccountName: string | null;
  total: string;
  memo: string | null;
  toPrint: boolean;
  voidedAt: string | null;
  currency?: string | null;
  exchangeRate?: string | null;
}

interface ExpenseDetail extends Expense {
  lines: Array<{
    accountId: string;
    itemId: string | null;
    quantity: string | null;
    unitCost: string | null;
    description: string | null;
    amount: string;
    classId: string | null;
    customerId: string | null;
  }>;
}

type Vendor = PurchaseVendor;

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  currency?: string | null;
}

interface Item {
  id: string;
  name: string;
  type: string;
  purchaseCost: string | null;
}

interface ClassRow {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  displayName: string;
}

interface LineRow {
  /** 'expense' = Expenses tab (account), 'item' = Items tab. */
  mode: 'expense' | 'item';
  accountId: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  description: string;
  amount: string;
  classId: string;
  customerId: string;
}

/** UI entry type → service method + refund flag. */
type EntryType = 'check' | 'cash' | 'cc_charge' | 'cc_credit';

const ENTRY_LABEL: Record<EntryType, string> = {
  check: 'Check',
  cash: 'Cash',
  cc_charge: 'CC Charge',
  cc_credit: 'CC Credit',
};

const OTHER_PAYEE = '__other__';
/** Payee select values for Other Names entries are "other:<id>" (vendors use the bare id). */
const OTHER_NAME_PREFIX = 'other:';

interface OtherNameOption {
  id: string;
  name: string;
  accountNumber?: string | null;
}

/** Decode the payee select (+ typed name) into the API's vendorId / otherNameId / payeeName. */
function payeeFields(sel: string, typed: string): { vendorId?: string; otherNameId?: string; payeeName?: string } {
  if (!sel) return {};
  if (sel === OTHER_PAYEE) return typed.trim() ? { payeeName: typed.trim() } : {};
  if (sel.startsWith(OTHER_NAME_PREFIX)) return { otherNameId: sel.slice(OTHER_NAME_PREFIX.length) };
  return { vendorId: sel };
}

function emptyLine(mode: LineRow['mode'] = 'expense'): LineRow {
  return { mode, accountId: '', itemId: '', quantity: '', unitCost: '', description: '', amount: '', classId: '', customerId: '' };
}

/** Display amount of a line (qty x cost on the Items tab). */
function lineTotal(l: LineRow): number {
  const dec = (v: string) => {
    try {
      const d = Money.of(v || '0');
      return d.isFinite() ? d : Money.zero();
    } catch {
      return Money.zero();
    }
  };
  if (l.mode === 'item' && !l.amount) return Money.round2(dec(l.quantity).times(dec(l.unitCost))).toNumber();
  return Money.round2(dec(l.amount)).toNumber();
}

/** Checks and cash expenses come from a Bank account (QB parity; lib/accountTypes.ts). */
function isBankish(a: Account): boolean {
  return isBankAccount(a);
}

function isCreditCard(a: Account): boolean {
  return isCreditCardAccount(a);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ExpensesPageContent() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [otherNames, setOtherNames] = useState<OtherNameOption[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  /** Set while the form edits a saved transaction. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<Expense | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Form state
  const [entryType, setEntryType] = useState<EntryType>('check');
  const [payeeSel, setPayeeSel] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  /** Shown under the payee after accounts were pre-filled (QB vendor pre-fill). */
  const [prefillNote, setPrefillNote] = useState('');
  const prefs = usePreferences();
  const [attachFor, setAttachFor] = useState<string | null>(null);
  // My Preferences > Checking: "Start with payee field on check" (else the bank account).
  useEffect(() => {
    if (!prefs.loaded || typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.getElementById(prefs.my.startWithPayee ? 'exp-payee' : 'exp-account')?.focus();
  }, [prefs.loaded, prefs.my.startWithPayee]);

  const isCC = entryType === 'cc_charge' || entryType === 'cc_credit';
  const paymentAccounts = accounts.filter((a) => (isCC ? isCreditCard(a) : isBankish(a)));
  const lineAccounts = accounts.filter((a) => a.id !== paymentAccountId);

  // ── data loading ──────────────────────────────────────────────────────────

  const fetchExpenses = useCallback(async () => {
    try {
      const data = await api.get<{ expenses: Expense[] }>('/api/expenses?includeVoided=true');
      setExpenses(data.expenses);
    } catch (err) {
      toastError(err, 'Failed to load expenses');
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [expData, vendorData, accountData, classData, customerData] = await Promise.all([
          api.get<{ expenses: Expense[] }>('/api/expenses?includeVoided=true'),
          api.get<Vendor[]>('/api/vendors'),
          api.get<Account[]>('/api/accounts'),
          api.get<ClassRow[]>('/api/classes').catch(() => [] as ClassRow[]),
          api.get<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        ]);
        api
          .get<{ items: Item[] }>('/api/items')
          .then((d) => setItems(d.items ?? []))
          .catch(() => setItems([]));
        // QB "Other Names" can be payees too (optional: the list may be hidden by permissions).
        api
          .get<{ entries: OtherNameOption[] }>('/api/lists/other-names')
          .then((d) => setOtherNames(d.entries ?? []))
          .catch(() => setOtherNames([]));
        setExpenses(expData.expenses);
        setVendors(vendorData);
        setAccounts(accountData);
        setClasses(classData);
        setCustomers(customerData);
      } catch (err) {
        toastError(err, 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Preferences > Checking: default bank account for Write Checks.
  useEffect(() => {
    const def = prefs.company.defaultCheckAccountId;
    if (!def || paymentAccountId || isCC) return;
    const acc = accounts.find((a) => a.id === def);
    if (acc && isBankish(acc)) setPaymentAccountId(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, prefs.loaded, isCC]);

  // Clear an incompatible payment account when switching entry type.
  useEffect(() => {
    setPaymentAccountId((prev) => {
      if (!prev) return prev;
      const acc = accounts.find((a) => a.id === prev);
      if (!acc) return '';
      const ok = isCC ? isCreditCard(acc) : isBankish(acc);
      return ok ? prev : '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCC]);

  // Auto-suggest the next check number for checks not queued for printing.
  useEffect(() => {
    let cancelled = false;
    async function loadNext() {
      if (entryType !== 'check' || toPrint || !paymentAccountId || editingId) return;
      try {
        const data = await api.get<{ next: string }>(
          `/api/check-numbers/next?paymentAccountId=${paymentAccountId}`,
        );
        if (!cancelled) setReference(data.next);
      } catch {
        /* non-fatal — the user can type a number */
      }
    }
    loadNext();
    return () => {
      cancelled = true;
    };
  }, [entryType, toPrint, paymentAccountId, editingId]);

  // ── line helpers ──────────────────────────────────────────────────────────

  function updateLine(index: number, field: keyof LineRow, value: string) {
    setLines((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }
  function removeLine(index: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert add / Ctrl+Delete remove / Enter down.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: submitting });

  // Ctrl+E / Quick Actions navigate here with ?new=1 — the entry form is always
  // visible, so jump focus to the start of it (the payee field).
  useNewParam(() => {
    document.getElementById('exp-payee')?.focus();
  });

  const runningTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const selectedVendor = vendors.find((v) => v.id === payeeSel);
  const payAccount = accounts.find((a) => a.id === paymentAccountId);
  const docCurrency = payAccount?.currency || selectedVendor?.currency || '';

  function pickItem(index: number, itemId: string) {
    const item = items.find((it) => it.id === itemId);
    setLines((prev) =>
      prev.map((row, i) =>
        i === index
          ? { ...row, itemId, quantity: row.quantity || '1', unitCost: row.unitCost || (item?.purchaseCost ?? ''), description: row.description || item?.name || '' }
          : row,
      ),
    );
  }

  /** Load a saved check / charge into the form for editing. */
  async function startEdit(e: Expense) {
    try {
      const d = await api.get<ExpenseDetail>(`/api/expenses/${e.id}`);
      setEditingId(e.id);
      const isCredit = d.method === 'credit_card' && Number(d.total) < 0;
      setEntryType(d.method === 'cash' ? 'cash' : d.method === 'credit_card' ? (isCredit ? 'cc_credit' : 'cc_charge') : 'check');
      setPayeeSel(d.vendorId ?? (d.otherNameId ? `${OTHER_NAME_PREFIX}${d.otherNameId}` : OTHER_PAYEE));
      setPayeeName(d.vendorId || d.otherNameId ? '' : (d.payeeName ?? ''));
      setPaymentAccountId(d.paymentAccountId);
      setDate(d.date.slice(0, 10));
      setReference(d.reference ?? '');
      setToPrint(d.toPrint);
      setMemo(d.memo ?? '');
      setExchangeRate(d.currency && d.exchangeRate ? String(Number(d.exchangeRate)) : '');
      setLines(
        d.lines.map((l) =>
          l.itemId
            ? { ...emptyLine('item'), itemId: l.itemId, quantity: String(Number(l.quantity ?? 1)), unitCost: l.unitCost ? String(Number(l.unitCost)) : '', amount: String(Math.abs(Number(l.amount)).toFixed(2)), description: l.description ?? '', classId: l.classId ?? '', customerId: l.customerId ?? '' }
            : { ...emptyLine('expense'), accountId: l.accountId, amount: isCredit ? String(Math.abs(Number(l.amount)).toFixed(2)) : l.amount, description: l.description ?? '', classId: l.classId ?? '', customerId: l.customerId ?? '' },
        ),
      );
      setPrefillNote('');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toastError(err, 'Failed to load the transaction.');
    }
  }

  function resetForm() {
    setEditingId(null);
    setExchangeRate('');
    setPayeeSel('');
    setPayeeName('');
    setReference('');
    setToPrint(false);
    setMemo('');
    setLines([emptyLine()]);
    setPrefillNote('');
  }

  /**
   * Payee chosen while the lines are still blank: pre-fill accounts (vendor default → last
   * transaction → learned categorizer). Never overwrites anything the user typed.
   */
  async function prefillFor(q: { vendorId?: string; payee?: string }) {
    setPrefillNote('');
    const blank = (ls: LineRow[]) => ls.every((l) => !l.accountId && !l.itemId && !l.amount && !l.description);
    if (!blank(lines) || editingId) return;
    // The vendor's own pre-fill accounts (up to 3) win over learned suggestions.
    const own = vendorPrefillAccountIds(vendors.find((v) => v.id === q.vendorId));
    if (own.length > 0) {
      setLines(own.map((accountId) => ({ ...emptyLine(), accountId })));
      setPrefillNote("Accounts pre-filled from the vendor's pre-fill accounts.");
      return;
    }
    // Preferences > Checking: "Autofill payee account number / last account used" gates the
    // last-transaction / learned suggestions (the vendor's own pre-fill accounts always apply).
    // My Preferences > General 'Recall the last transaction for a name' must be on too.
    if (!prefs.company.autofillPayeeAccount || !prefs.my.autoRecallLastTransaction) return;
    const pf = await fetchVendorPrefill(q);
    if (!pf) return;
    setLines((prev) => {
      if (!blank(prev)) return prev; // user started typing while we fetched
      return pf.lines.map((l) => ({
        ...emptyLine(),
        accountId: l.accountId,
        classId: l.classId ?? '',
        customerId: l.customerId ?? '',
      }));
    });
    setPrefillNote(`Accounts pre-filled ${PREFILL_SOURCE_LABEL[pf.source]}.`);
  }

  // ── submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    const payee = payeeFields(payeeSel, payeeName);
    if (!payee.vendorId && !payee.otherNameId && !payee.payeeName) {
      toast('Select a payee or enter a payee name.', 'danger');
      return;
    }
    if (!paymentAccountId) {
      toast(isCC ? 'Select a credit card account.' : 'Select a bank account.', 'danger');
      return;
    }
    if (!date) {
      toast('Date is required.', 'danger');
      return;
    }
    for (const [i, line] of lines.entries()) {
      if (line.mode === 'item') {
        if (!line.itemId) {
          toast(`Line ${i + 1}: select an item.`, 'danger');
          return;
        }
        if (!line.quantity || Number(line.quantity) <= 0) {
          toast(`Line ${i + 1}: quantity must be greater than zero.`, 'danger');
          return;
        }
        if (lineTotal(line) <= 0) {
          toast(`Line ${i + 1}: enter a cost.`, 'danger');
          return;
        }
        continue;
      }
      if (!line.accountId) {
        toast(`Line ${i + 1}: select an expense account.`, 'danger');
        return;
      }
      if (!line.amount || Number(line.amount) <= 0) {
        toast(`Line ${i + 1}: amount must be greater than zero.`, 'danger');
        return;
      }
    }

    if (!confirmTransactionDate(date, prefs)) return;
    // Preferences > Checking: "Warn about duplicate check numbers" (same bank account).
    if (entryType === 'check' && !toPrint) {
      const dupCheck = findDuplicateNumber(reference, expenses, (e) => e.reference, {
        sameScope: (e) => e.method === 'check' && e.paymentAccountId === paymentAccountId && !e.voidedAt,
      });
      if (!confirmUniqueNumber(prefs.company.warnDuplicateCheckNumbers, 'Check number', dupCheck, reference)) return;
    }

    setSubmitting(true);
    try {
      const body = {
        ...payee,
        date,
        method: entryType === 'cash' ? 'cash' : isCC ? 'credit_card' : 'check',
        isRefund: entryType === 'cc_credit',
        // Send the typed reference for every entry type except print-later checks
        // (those get their number assigned when printed).
        reference:
          entryType === 'check' && toPrint
            ? undefined
            : reference.trim() || undefined,
        toPrint: entryType === 'check' ? toPrint : false,
        paymentAccountId,
        memo: memo.trim() || undefined,
        exchangeRate: docCurrency && exchangeRate.trim() ? exchangeRate.trim() : undefined,
        lines: lines.map((l) =>
          l.mode === 'item'
            ? {
                itemId: l.itemId,
                quantity: l.quantity,
                unitCost: l.unitCost || undefined,
                amount: l.unitCost ? undefined : l.amount || undefined,
                description: l.description.trim() || undefined,
                classId: l.classId || undefined,
                customerId: l.customerId || undefined,
              }
            : {
                accountId: l.accountId,
                description: l.description.trim() || undefined,
                amount: l.amount,
                classId: l.classId || undefined,
                customerId: l.customerId || undefined,
              },
        ),
      };
      // Duplicate check numbers: warn and let the user keep the number (QB behaviour).
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        editingId
          ? api.patch(`/api/expenses/${editingId}`, { ...body, allowDuplicateNumber })
          : api.post('/api/expenses', { ...body, allowDuplicateNumber }),
      );
      if (saved === null) return;
      toast(
        editingId
          ? 'Changes saved.'
          : entryType === 'check' && toPrint
            ? 'Check saved and added to the print queue.'
            : `${ENTRY_LABEL[entryType]} recorded.`,
        'success',
      );
      resetForm();
      await fetchExpenses();
    } catch (err) {
      toastError(err, 'Failed to save expense.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── void ──────────────────────────────────────────────────────────────────

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/expenses/${id}`);
      toast('Expense voided.', 'success');
      setPendingVoid(null);
      await fetchExpenses();
    } catch (err) {
      toastError(err, 'Failed to void expense.');
    } finally {
      setVoidingId(null);
    }
  }

  // ── render helpers ────────────────────────────────────────────────────────

  function methodBadge(e: Expense) {
    if (e.method === 'credit_card') {
      return Number(e.total) < 0 ? (
        <Badge tone="success">CC Credit</Badge>
      ) : (
        <Badge tone="info">CC Charge</Badge>
      );
    }
    if (e.method === 'cash') return <Badge tone="neutral">Cash</Badge>;
    return <Badge tone="info">Check</Badge>;
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Write Checks / Expenses" icon={Banknote} />

      {/* ------------------------------------------------------------------ */}
      {/* Entry form                                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">
            {editingId ? 'Edit Transaction' : 'New Transaction'}
            {editingId && (
              <button type="button" onClick={resetForm} className="ml-3 text-xs font-semibold text-electric hover:underline">
                Cancel edit
              </button>
            )}
          </h2>
          {/* Entry type toggle */}
          <div className="flex gap-1 rounded-lg bg-navy/5 p-1">
            {(Object.keys(ENTRY_LABEL) as EntryType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setEntryType(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  entryType === t
                    ? 'bg-white text-navy shadow-sm'
                    : 'text-navy/50 hover:text-navy'
                }`}
              >
                {ENTRY_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Payee + payment account + date */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="exp-payee" required>Pay to the Order of</Label>
            <Select
              id="exp-payee"
              value={payeeSel}
              onChange={(e) => {
                const v = e.target.value;
                setPayeeSel(v);
                if (v && v !== OTHER_PAYEE && !v.startsWith(OTHER_NAME_PREFIX)) prefillFor({ vendorId: v });
                else if (v.startsWith(OTHER_NAME_PREFIX)) {
                  const o = otherNames.find((x) => `${OTHER_NAME_PREFIX}${x.id}` === v);
                  if (o) prefillFor({ payee: o.name });
                }
              }}
            >
              <option value="">Select payee…</option>
              <optgroup label="Vendors">
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </optgroup>
              {otherNames.length > 0 && (
                <optgroup label="Other Names">
                  {otherNames.map((o) => (
                    <option key={o.id} value={`${OTHER_NAME_PREFIX}${o.id}`}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={OTHER_PAYEE}>Someone else (type a name)…</option>
            </Select>
            <p className="mt-1 text-xs text-navy/50">
              Paying someone who is not a vendor? Add them to the{' '}
              <Link href="/lists?list=other-names" className="text-electric hover:underline">Other Names list</Link>.
            </p>
            {payeeSel === OTHER_PAYEE && (
              <Input
                className="mt-2"
                placeholder="Payee name"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
                onBlur={() => payeeName.trim() && prefillFor({ payee: payeeName })}
              />
            )}
            {prefillNote && <p className="mt-1 text-xs text-electric">{prefillNote}</p>}
          </div>

          <div>
            <Label htmlFor="exp-account" required>
              {isCC ? 'Credit Card Account' : 'Bank Account'} <Help term="reconcile" side="bottom" />
            </Label>
            <Select
              id="exp-account"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} – {a.name}
                </option>
              ))}
            </Select>
            {isCC && paymentAccounts.length === 0 && (
              <p className="mt-1 text-xs text-navy/40">
                No credit-card accounts found. Add one (liability / credit card) in the chart of
                accounts.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="exp-date" required>Date</Label>
            <DateInput id="exp-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        {/* Check number + print later (checks only) + memo */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {entryType === 'check' && (
            <div>
              <Label htmlFor="exp-checkno">Check No.</Label>
              <Input
                id="exp-checkno"
                placeholder="auto"
                value={toPrint ? '' : reference}
                disabled={toPrint}
                onChange={(e) => setReference(e.target.value)}
              />
              <label className="mt-2 flex items-center gap-2 text-sm text-navy/70 select-none">
                <input
                  type="checkbox"
                  checked={toPrint}
                  onChange={(e) => setToPrint(e.target.checked)}
                  className="h-4 w-4 accent-electric"
                />
                Print later (number assigned when printed)
              </label>
            </div>
          )}
          {entryType !== 'check' && (
            <div>
              <Label htmlFor="exp-ref">Reference No.</Label>
              <Input
                id="exp-ref"
                placeholder="optional"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          )}
          <div className="md:col-span-2">
            <Label htmlFor="exp-memo">Memo</Label>
            <Input
              id="exp-memo"
              placeholder="Optional note"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>

        {editingId && (
          <p className="text-xs text-navy/50 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
            Changing only the payee, memo or number keeps the original entry. Changing amounts,
            accounts or the date replaces the entry (not allowed once the check is reconciled).
          </p>
        )}

        {docCurrency && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-lg border border-electric/20 bg-electric/5 p-3">
            <p className="md:col-span-2 text-xs text-navy/70">
              This is a <strong>{docCurrency}</strong> transaction. Enter amounts in {docCurrency}; the books
              record them in your home currency at the exchange rate.
            </p>
            <div>
              <Label htmlFor="exp-fx">Exchange rate (home per 1 {docCurrency})</Label>
              <Input id="exp-fx" inputMode="decimal" placeholder="Use the rate from Currencies" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} />
            </div>
          </div>
        )}

        {/* Lines grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0" required>
              {entryType === 'cc_credit' ? 'Refunded Expense Lines' : 'Expense Lines'}{' '}
              <Help term="chart-of-accounts" />
            </Label>
            <span className="flex items-center gap-3">
              <button
                type="button"
                onClick={addLine}
                className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> Expense Line
              </button>
              {entryType !== 'cc_credit' && (
                <button
                  type="button"
                  onClick={() => setLines((prev) => [...prev, emptyLine('item')])}
                  className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
                  title="Items tab: buy items (inventory items go into stock)"
                >
                  <Plus className="h-3 w-3" /> Item Line
                </button>
              )}
            </span>
          </div>

          {/* Header row */}
          <div className="hidden md:grid grid-cols-[2fr_2fr_1fr_1.5fr_1.5fr_24px] gap-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-navy/40 px-1">
            <span>Account</span>
            <span>Description</span>
            <span>Amount</span>
            {/* Class fields are hidden while "Use class tracking" is off (QB); a saved class still shows. */}
            <span>{prefs.company.classTrackingEnabled ? 'Class' : ''}</span>
            <span>Billable Customer</span>
            <span />
          </div>

          <div className="space-y-2" onKeyDown={grid.onKeyDown}>
            {lines.map((line, idx) => (
              <div
                key={idx}
                data-grid-row
                className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr_1.5fr_1.5fr_24px] gap-2 items-start"
              >
                {line.mode === 'item' ? (
                  <Select value={line.itemId} onChange={(e) => pickItem(idx, e.target.value)} aria-label="Item">
                    <option value="">Item…</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                        {it.type === 'inventory' ? ' (stock)' : ''}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select
                    value={line.accountId}
                    onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                  >
                    <option value="">Account…</option>
                    {lineAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} – {a.name}
                      </option>
                    ))}
                  </Select>
                )}

                {line.mode === 'item' ? (
                  <div className="grid grid-cols-2 gap-1">
                    <Input
                      placeholder="Qty"
                      inputMode="decimal"
                      aria-label="Quantity"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                    />
                    <Input
                      placeholder="Cost each"
                      inputMode="decimal"
                      aria-label="Cost each"
                      value={line.unitCost}
                      onChange={(e) => updateLine(idx, 'unitCost', e.target.value)}
                    />
                  </div>
                ) : (
                  <Input
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => updateLine(idx, 'description', e.target.value)}
                  />
                )}

                {line.mode === 'item' ? (
                  <div className="px-3 py-2 text-sm tabular-nums text-navy/70">{formatCurrency(lineTotal(line).toFixed(2))}</div>
                ) : (
                  <AmountInput
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) => updateLine(idx, 'amount', e.target.value)}
                  />
                )}

                {prefs.company.classTrackingEnabled || line.classId ? (
                  <Select
                    value={line.classId}
                    onChange={(e) => updateLine(idx, 'classId', e.target.value)}
                  >
                    <option value="">Class…</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span />
                )}

                <Select
                  value={line.customerId}
                  onChange={(e) => updateLine(idx, 'customerId', e.target.value)}
                >
                  <option value="">Customer…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </Select>

                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  disabled={lines.length === 1}
                  className="mt-2 text-red-400 hover:text-red-600 disabled:opacity-20 disabled:pointer-events-none"
                  title="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="text-sm text-navy/50">
              {entryType === 'cc_credit' ? 'Total credit:' : 'Total:'}
            </span>
            <span className="text-sm font-bold text-navy tabular-nums">
              {formatCurrency(runningTotal.toFixed(2))}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <MemorizeButton
            docType={entryType === 'check' ? 'check' : 'expense'}
            defaultName={
              payeeSel === OTHER_PAYEE
                ? payeeName
                : payeeSel.startsWith(OTHER_NAME_PREFIX)
                  ? otherNames.find((o) => `${OTHER_NAME_PREFIX}${o.id}` === payeeSel)?.name
                  : vendors.find((v) => v.id === payeeSel)?.displayName
            }
            getTemplate={() => {
              const payee = payeeFields(payeeSel, payeeName);
              if (!payee.vendorId && !payee.otherNameId && !payee.payeeName) return 'Pick a payee before memorizing.';
              if (!paymentAccountId) return 'Pick the account you pay from before memorizing.';
              const rows = lines.filter((l) => l.accountId && Number(l.amount) > 0);
              if (rows.length === 0) return 'Add at least one line before memorizing.';
              return {
                ...payee,
                date,
                method: entryType === 'cash' ? 'cash' : isCC ? 'credit_card' : 'check',
                isRefund: entryType === 'cc_credit',
                toPrint: entryType === 'check' ? toPrint : false,
                paymentAccountId,
                memo: memo.trim() || undefined,
                lines: rows.map((l) => ({
                  accountId: l.accountId,
                  description: l.description.trim() || undefined,
                  amount: l.amount,
                  classId: l.classId || undefined,
                  customerId: l.customerId || undefined,
                })),
              };
            }}
          />
          <Button onClick={handleSubmit} loading={submitting}>
            {editingId ? 'Save Changes' : `Save ${ENTRY_LABEL[entryType]}`}
          </Button>
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Expense list                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading expenses…
          </div>
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="No checks or expenses yet"
            message="Paid for something right away (check, debit card, cash or credit card)? Record it here. For bills you will pay later, use Enter Bills."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>No.</Th>
                <Th>Payee</Th>
                <Th>Account</Th>
                <Th>Type</Th>
                <Th numeric>Amount</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <Tr key={e.id}>
                  <Td>{e.date ? formatDate(e.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td className="font-mono text-sm">
                    {e.reference ?? (
                      <span className="text-navy/30 italic">{e.toPrint ? 'to print' : '—'}</span>
                    )}
                  </Td>
                  <Td className="font-medium">{e.vendorName ?? e.otherName ?? e.payeeName ?? '—'}</Td>
                  <Td>{e.paymentAccountName ?? '—'}</Td>
                  <Td>{methodBadge(e)}</Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(e.total)}
                    {e.currency && <span className="ml-1 text-xs text-navy/50">{e.currency}</span>}
                  </Td>
                  <Td>
                    {e.voidedAt ? (
                      <Badge tone="danger">Void</Badge>
                    ) : e.toPrint ? (
                      <Badge tone="warning">To Print</Badge>
                    ) : (
                      <Badge tone="success">Recorded</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setAttachFor(e.id)} title="Receipts and files">
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    {!e.voidedAt && (
                      <Button variant="ghost" size="sm" onClick={() => startEdit(e)} title="Edit this transaction">
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    )}
                    {!e.voidedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === e.id}
                        onClick={() => setPendingVoid(e)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!attachFor} onClose={() => setAttachFor(null)} title="Receipts & files" size="md">
        <AttachmentPanel entityType="expense" entityId={attachFor} />
      </Modal>

      {/* Void confirm */}
      <ConfirmDialog
        open={!!pendingVoid}
        title="Void transaction?"
        message={`Void this transaction for ${formatCurrency(pendingVoid?.total ?? '0')} to ${pendingVoid?.vendorName ?? pendingVoid?.otherName ?? pendingVoid?.payeeName ?? 'the payee'}? This reverses the posted entry and cannot be undone.`}
        confirmLabel="Void"
        tone="danger"
        loading={!!pendingVoid && voidingId === pendingVoid.id}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid.id)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

export default function ExpensesPage() {
  return (
    <Suspense fallback={null}>
      <ExpensesPageContent />
    </Suspense>
  );
}
