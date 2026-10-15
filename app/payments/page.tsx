'use client';

import { Suspense, useEffect, useMemo, useState, useCallback } from 'react';
import { HandCoins, Plus } from 'lucide-react';
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
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  Spinner,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useNewParam } from '@/lib/useFocusParam';
import { isDepositTargetAccount } from '@/lib/accountTypes';
// wave2 prefs: Payments > auto-apply / auto-calculate / Undeposited Funds; date warnings
import { usePreferences } from '@/lib/usePreferences';
import { confirmTransactionDate } from '@/lib/formPrefs';
import { appliedExceedsReceived, autoApplyPayment, cashApplied, cashDue, moneyDec as dec, sumApplied, sumMoney } from '@/lib/paymentApply';
import { useErrorFixes, type FixContext } from '@/components/ErrorFixPanel';
import { FieldError, fieldA11y, focusFirstError } from '@/components/FieldError';
import {
  appliedExceedsPaymentFixes,
  fixMoney,
  getPath,
  overAppliedFixes,
  parseLinePath,
  type ErrorFix,
} from '@/lib/errorFixes';
import { amountMessage, collectErrors, dateMessage, hasErrors, requiredMessage, type FieldErrors } from '@/lib/fieldValidation';

/** Body sent to /api/payments (fix patches address its paths, e.g. "amount", "applications.0.amountApplied"). */
type PaymentBody = Record<string, unknown> & {
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount: string | null }>;
  journalItems: Array<{ journalLineId: string; amount: string }>;
};

/** What the API receives: only real applications (a fix may set one to 0.00). */
function cleanPaymentBody(body: PaymentBody): PaymentBody {
  return {
    ...body,
    applications: body.applications.filter((a) => dec(a.amountApplied).greaterThan(0) || dec(a.discountAmount).greaterThan(0)),
    journalItems: body.journalItems.filter((j) => dec(j.amount).greaterThan(0)),
  };
}
// cmdbar: "receive payment from Acme" opens Receive Payments with the customer picked.
import { usePrefill } from '@/lib/commands/usePrefill';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Payment {
  id: string;
  date: string;
  customerId: string;
  /** P1: returned by the paged list. */
  customerName?: string | null;
  method: string;
  amount: string;
  unapplied: string;
  reference: string | null;
  voidedAt: string | null;
  /** wave2 sales (F2): set when the check bounced. */
  bouncedAt?: string | null;
  currency?: string | null;
  exchangeRate?: string | null;
  /** P1: what the server will accept (see searchPayments). */
  canBounce?: boolean;
  deposited?: boolean;
  refunded?: boolean;
}

interface Customer {
  id: string;
  displayName: string;
  /** Present when customers carry a currency (multi-currency). */
  currency?: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
}

interface Invoice {
  id: string;
  invoiceNumber?: number;
  /** The document number users see ("INV-1001"); falls back to the legacy integer. */
  refNumber?: string | null;
  date: string;
  dueDate?: string | null;
  total: string;
  balanceDue: string;
  status: string;
  memo: string | null;
  currency?: string | null;
  exchangeRate?: string | null;
}

interface CurrencyRow {
  code: string;
  name?: string;
  rateToBase: string;
  isBase: boolean;
}

interface Application {
  invoiceId: string;
  amountApplied: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  credit_card: 'Credit Card',
  ach: 'ACH',
  bank_transfer: 'Bank Transfer',
  other: 'Other',
};

function methodBadgeTone(
  method: string,
): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (method) {
    case 'cash':
      return 'success';
    case 'check':
      return 'info';
    case 'credit_card':
      return 'warning';
    case 'ach':
    case 'bank_transfer':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** The invoice number users see everywhere else (typed ref number, else the legacy integer). */
function invNo(inv: { refNumber?: string | null; invoiceNumber?: number | null }): string {
  const typed = inv.refNumber?.trim();
  if (typed) return typed;
  return inv.invoiceNumber === undefined || inv.invoiceNumber === null ? '' : String(inv.invoiceNumber);
}

/** Format an amount in a document currency (home currency when null/blank). */
function money(v: string | number, currency?: string | null): string {
  if (!currency) return formatCurrency(v);
  try {
    return formatCurrency(v, currency);
  } catch {
    return `${currency} ${Number(v).toFixed(2)}`;
  }
}

// Sum the amountApplied values across all applications for display only (Number() per rules).
function sumApplications(apps: Application[]): number {
  return apps.reduce((acc, a) => acc + (Number(a.amountApplied) || 0), 0);
}

/** Accounts a payment can be deposited to / a refund paid from (bank, cash, Undeposited Funds). */
function depositTargets(accounts: Account[]): Account[] {
  return accounts.filter((a) => isDepositTargetAccount({ type: a.type, subtype: a.subtype ?? null }));
}

// ---------------------------------------------------------------------------
// Receive Payment Modal (new + edit) — cash, early-payment discounts, credits
// ---------------------------------------------------------------------------

interface PaymentDetail extends Payment {
  depositAccountId: string | null;
  discountAccountId: string | null;
  memo: string | null;
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount: string }>;
  credits: Array<{ id: string; creditMemoId: string; invoiceId: string; amount: string }>;
  /** I11: General Journal charges this payment paid / journal credits applied with it. */
  journalApplications?: Array<{ kind: string; journalLineId: string; invoiceId: string | null; amount: string }>;
  /** P1: General Journal credits it applied to General Journal charges. */
  journalOffsets?: Array<{ journalLineId: string; chargeLineId: string; amount: string }>;
  /** C1: the bank deposit this payment is in (edits must keep the amount, or take it out). */
  deposit?: { id: string; date: string; total: string } | null;
}

/** I11: an open General Journal A/R line (a charge to pay, or a credit to apply). */
interface JournalOpenRow {
  journalLineId: string;
  ref: string;
  date: string;
  memo: string | null;
  open: string;
}

interface AvailableCredit {
  /** 'journal_entry' = a General Journal A/R credit (id is the journal line). */
  kind: 'credit_memo' | 'payment' | 'journal_entry';
  id: string;
  ref: string;
  date: string;
  available: string;
}

interface DiscountSuggestion {
  invoiceId: string;
  eligible: boolean;
  suggested: string;
  discountDate: string | null;
}

interface ReceivePaymentModalProps {
  open: boolean;
  /** wave2 sales (C1): payment being edited (null = new). */
  editing?: PaymentDetail | null;
  onClose: () => void;
  onSaved: () => void;
  customers: Customer[];
  accounts: Account[];
  /** cmdbar: customer picked from the command bar for a NEW payment. */
  prefillCustomerId?: string | null;
}

/** "Apply to" targets in the credits table: an invoice id, or `je:<line id>` for a JE charge. */
const JE_PREFIX = 'je:';

function ReceivePaymentModal({ open, editing, onClose, onSaved, customers, accounts, prefillCustomerId = null }: ReceivePaymentModalProps) {
  const today = new Date().toISOString().slice(0, 10);
  const prefs = usePreferences();
  // Preferences > Payments: once the user edits one side by hand, stop recalculating it.
  const [amountTouched, setAmountTouched] = useState(false);
  const [appsTouched, setAppsTouched] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<string>('check');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [discountAccountId, setDiscountAccountId] = useState('');
  // P1: payment currency ('' = home) and exchange rate (home units per 1 unit).
  const [currency, setCurrency] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [currencyList, setCurrencyList] = useState<CurrencyRow[]>([]);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  // invoiceId -> cash / discount
  const [applicationAmounts, setApplicationAmounts] = useState<Record<string, string>>({});
  const [discountAmounts, setDiscountAmounts] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, DiscountSuggestion>>({});
  // credit id -> { invoiceId (or je:<charge line id>), amount }
  const [credits, setCredits] = useState<AvailableCredit[]>([]);
  const [creditUse, setCreditUse] = useState<Record<string, { invoiceId: string; amount: string }>>({});
  // I11: open General Journal charges (journal line id -> cash applied).
  const [journalCharges, setJournalCharges] = useState<JournalOpenRow[]>([]);
  const [journalAmounts, setJournalAmounts] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  // C1: editing a payment that is already in a bank deposit.
  const [removeFromDeposit, setRemoveFromDeposit] = useState(false);
  // Fix errors where they happen: fix suggestions (client checks + server) and inline messages.
  const fixer = useErrorFixes<PaymentBody>();
  const [showErrors, setShowErrors] = useState(false);

  const depositAccounts = depositTargets(accounts);
  const discountAccounts = accounts.filter((a) => a.type === 'revenue' || a.type === 'expense');
  const homeCode = (currencyList.find((c) => c.isBase)?.code ?? '').toUpperCase();
  /** '' for the home currency, else the upper-case code. */
  const normCur = useCallback(
    (c: string | null | undefined) => {
      const v = (c ?? '').trim().toUpperCase();
      return v === homeCode ? '' : v;
    },
    [homeCode],
  );
  const foreign = currency !== '';

  // Currency list (for the home code and default exchange rates). Not everyone can read it.
  useEffect(() => {
    if (!open) return;
    api
      .get<CurrencyRow[]>('/api/currencies')
      .then((rows) => setCurrencyList(Array.isArray(rows) ? rows : []))
      .catch(() => setCurrencyList([]));
  }, [open]);

  // Reset / prefill when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date.slice(0, 10));
      setMethod(editing.method);
      setAmount(String(Number(editing.amount)));
      setReference(editing.reference ?? '');
      setMemo(editing.memo ?? '');
      setDepositAccountId(editing.depositAccountId ?? '');
      setDiscountAccountId(editing.discountAccountId ?? '');
      setCurrency((editing.currency ?? '').toUpperCase());
      setExchangeRate(editing.currency && editing.exchangeRate ? String(Number(editing.exchangeRate)) : '');
    } else {
      setCustomerId(prefillCustomerId ?? '');
      setDate(today);
      setMethod('check');
      setAmount('');
      setReference('');
      setMemo('');
      setDepositAccountId('');
      setDiscountAccountId('');
      setCurrency('');
      setExchangeRate('');
    }
    setInvoices([]);
    setApplicationAmounts({});
    setDiscountAmounts({});
    setCredits([]);
    setCreditUse({});
    setJournalCharges([]);
    setJournalAmounts({});
    // Preferences > Payments auto-apply / auto-calculate never overwrite an edited payment's amounts.
    setAmountTouched(!!editing);
    setAppsTouched(!!editing);
    setRemoveFromDeposit(false);
    fixer.clear();
    setShowErrors(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, today, prefillCustomerId]);

  useEffect(() => {
    // Preferences > Payments: with Undeposited Funds off, a NEW payment starts on the default bank.
    if (!open || editing || prefs.company.useUndepositedFunds || depositAccountId) return;
    const def = prefs.company.defaultDepositAccountId;
    if (def && depositAccounts.some((a) => a.id === def)) setDepositAccountId(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefs.loaded, accounts]);

  // Fetch open invoices + available credits when the customer changes. A quick switch to another
  // customer cancels the earlier request so its results never land on the wrong customer.
  useEffect(() => {
    if (!open || !customerId) {
      setInvoices([]);
      setCredits([]);
      setJournalCharges([]);
      return;
    }
    let cancelled = false;
    setInvoicesLoading(true);
    const mine = editing && editing.customerId === customerId ? editing : null;
    Promise.all([
      api.get<Invoice[] | { invoices?: Invoice[] }>(`/api/invoices?customerId=${customerId}`),
      api.get<{ credits: AvailableCredit[] }>(`/api/payments/credits?customerId=${customerId}`),
      api.get<{ charges: JournalOpenRow[]; credits: JournalOpenRow[] }>(`/api/payments/journal-items?customerId=${customerId}`),
    ])
      .then(([rows, cred, journal]) => {
        if (cancelled) return;
        // I11: General Journal charges, with what this payment already paid / offset handed back.
        const myJournal = mine?.journalApplications ?? [];
        const myOffsets = mine?.journalOffsets ?? [];
        const paidByMe = new Map<string, number>();
        for (const j of myJournal.filter((j) => j.kind === 'payment')) {
          paidByMe.set(j.journalLineId, (paidByMe.get(j.journalLineId) ?? 0) + Number(j.amount));
        }
        const offsetOnCharge = new Map<string, number>();
        for (const o of myOffsets) offsetOnCharge.set(o.chargeLineId, (offsetOnCharge.get(o.chargeLineId) ?? 0) + Number(o.amount));
        const charges = (journal.charges ?? []).map((c) => ({
          ...c,
          open: (Number(c.open) + (paidByMe.get(c.journalLineId) ?? 0) + (offsetOnCharge.get(c.journalLineId) ?? 0)).toFixed(2),
        }));
        for (const lineId of new Set([...paidByMe.keys(), ...offsetOnCharge.keys()])) {
          if (!charges.some((c) => c.journalLineId === lineId)) {
            const amt = (paidByMe.get(lineId) ?? 0) + (offsetOnCharge.get(lineId) ?? 0);
            charges.push({ journalLineId: lineId, ref: 'General Journal', date: '', memo: null, open: amt.toFixed(2) });
          }
        }
        setJournalCharges(charges);
        setJournalAmounts(mine ? Object.fromEntries([...paidByMe].map(([id, amt]) => [id, String(amt)])) : {});
        const list = Array.isArray(rows) ? rows : (rows.invoices ?? []);
        // While editing, this payment's own applications are handed back to each invoice.
        const giveBack = new Map<string, number>();
        for (const a of mine?.applications ?? []) {
          giveBack.set(a.invoiceId, (giveBack.get(a.invoiceId) ?? 0) + Number(a.amountApplied) + Number(a.discountAmount ?? 0));
        }
        for (const c of mine?.credits ?? []) {
          giveBack.set(c.invoiceId, (giveBack.get(c.invoiceId) ?? 0) + Number(c.amount));
        }
        for (const j of myJournal.filter((j) => j.kind === 'invoice_credit' && j.invoiceId)) {
          giveBack.set(j.invoiceId!, (giveBack.get(j.invoiceId!) ?? 0) + Number(j.amount));
        }
        const openInv = list
          .map((inv) => ({ ...inv, balanceDue: (Number(inv.balanceDue) + (giveBack.get(inv.id) ?? 0)).toFixed(2) }))
          .filter((inv) => inv.status !== 'void' && inv.status !== 'draft' && Number(inv.balanceDue) > 0);
        setInvoices(openInv);
        // A new payment for a customer whose open invoices are all in one foreign currency starts in
        // that currency (QB: a foreign customer's payments are in the customer's currency).
        if (!mine) {
          const custCur = normCur(customers.find((c) => c.id === customerId)?.currency);
          const curs = [...new Set(openInv.map((i) => normCur(i.currency)))];
          setCurrency(custCur || (curs.length === 1 ? curs[0] : ''));
        }
        // Earlier unapplied payments can be used too — never the payment being edited itself.
        const usable = (cred.credits ?? []).filter((c) => !(mine && c.kind === 'payment' && c.id === mine.id));
        // Add back credit used by this payment so it can be re-applied when editing.
        const usedByMe = new Map<string, number>();
        for (const c of mine?.credits ?? []) usedByMe.set(c.creditMemoId, (usedByMe.get(c.creditMemoId) ?? 0) + Number(c.amount));
        const journalUsedByMe = new Map<string, number>();
        for (const j of myJournal.filter((j) => j.kind === 'invoice_credit')) {
          journalUsedByMe.set(j.journalLineId, (journalUsedByMe.get(j.journalLineId) ?? 0) + Number(j.amount));
        }
        for (const o of myOffsets) journalUsedByMe.set(o.journalLineId, (journalUsedByMe.get(o.journalLineId) ?? 0) + Number(o.amount));
        const merged = usable.map((c) => ({
          ...c,
          available: (Number(c.available) + ((c.kind === 'journal_entry' ? journalUsedByMe : usedByMe).get(c.id) ?? 0)).toFixed(2),
        }));
        for (const [id, amt] of usedByMe) {
          if (!merged.some((c) => c.id === id)) merged.push({ kind: 'credit_memo', id, ref: 'Credit memo', date: '', available: amt.toFixed(2) });
        }
        for (const [id, amt] of journalUsedByMe) {
          if (!merged.some((c) => c.id === id)) merged.push({ kind: 'journal_entry', id, ref: 'General Journal credit', date: '', available: amt.toFixed(2) });
        }
        setCredits(merged);
        if (mine) {
          setApplicationAmounts(Object.fromEntries(mine.applications.filter((a) => Number(a.amountApplied) > 0).map((a) => [a.invoiceId, String(Number(a.amountApplied))])));
          setDiscountAmounts(Object.fromEntries(mine.applications.filter((a) => Number(a.discountAmount) > 0).map((a) => [a.invoiceId, String(Number(a.discountAmount))])));
          setCreditUse(
            Object.fromEntries([
              ...mine.credits.map((c) => [c.creditMemoId, { invoiceId: c.invoiceId, amount: String(Number(c.amount)) }] as const),
              ...myJournal
                .filter((j) => j.kind === 'invoice_credit' && j.invoiceId)
                .map((j) => [j.journalLineId, { invoiceId: j.invoiceId!, amount: String(Number(j.amount)) }] as const),
              ...myOffsets.map((o) => [o.journalLineId, { invoiceId: JE_PREFIX + o.chargeLineId, amount: String(Number(o.amount)) }] as const),
            ]),
          );
        } else {
          setAppsTouched(false);
          setApplicationAmounts({});
          setDiscountAmounts({});
          setCreditUse({});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        toastError(err, 'Failed to load invoices.');
        setInvoices([]);
      })
      .finally(() => {
        if (!cancelled) setInvoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customerId, editing]);

  // Exchange rate defaults from the currency list when the currency changes (a new payment, or an
  // edit that switches currency). The user can type the rate the bank actually used.
  useEffect(() => {
    if (!open) return;
    if (!currency) {
      setExchangeRate('');
      return;
    }
    if (editing && (editing.currency ?? '').toUpperCase() === currency && editing.exchangeRate) return;
    const row = currencyList.find((c) => c.code.toUpperCase() === currency);
    setExchangeRate(row ? String(Number(row.rateToBase)) : '');
  }, [open, currency, currencyList, editing]);

  // Early-payment discount suggestions from the customer's terms, for the payment date.
  useEffect(() => {
    if (!open || !customerId || !date) {
      setSuggestions({});
      return;
    }
    let cancelled = false;
    api
      .get<{ discounts: DiscountSuggestion[] }>(`/api/payments/discounts?customerId=${customerId}&date=${date}`)
      .then((r) => {
        if (!cancelled) setSuggestions(Object.fromEntries((r.discounts ?? []).map((d) => [d.invoiceId, d])));
      })
      .catch(() => {
        if (!cancelled) setSuggestions({});
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId, date]);

  // Only invoices in the payment's currency can be paid by it (QB: one currency per payment).
  const visibleInvoices = useMemo(
    () => invoices.filter((inv) => normCur(inv.currency) === currency),
    [invoices, currency, normCur],
  );
  const currencyChoices = useMemo(
    () => [...new Set(['', ...invoices.map((i) => normCur(i.currency)), currency])],
    [invoices, currency, normCur],
  );
  // A2: currency fields only while Preferences > Multiple Currencies is on (or the payment is foreign).
  const showCurrency = currencyChoices.length > 1 && (prefs.company.multiCurrencyEnabled || currency !== '');
  // Credits and General Journal items are home-currency only.
  const shownCredits = foreign ? [] : credits;
  const shownCharges = foreign ? [] : journalCharges;

  const paymentCreditIds = new Set(credits.filter((c) => c.kind === 'payment').map((c) => c.id));
  const journalCreditIds = new Set(credits.filter((c) => c.kind === 'journal_entry').map((c) => c.id));
  const usedCredits = Object.entries(foreign ? {} : creditUse).filter(([, u]) => u.invoiceId && Number(u.amount) > 0);
  const toCharge = (target: string) => target.startsWith(JE_PREFIX);
  const creditApps = usedCredits
    .filter(([id, u]) => !paymentCreditIds.has(id) && !journalCreditIds.has(id) && !toCharge(u.invoiceId))
    .map(([creditMemoId, u]) => ({ creditMemoId, invoiceId: u.invoiceId, amount: u.amount }));
  const paymentCreditApps = usedCredits
    .filter(([id]) => paymentCreditIds.has(id))
    .map(([paymentId, u]) =>
      toCharge(u.invoiceId)
        ? { paymentId, journalLineId: u.invoiceId.slice(JE_PREFIX.length), amount: u.amount }
        : { paymentId, invoiceId: u.invoiceId, amount: u.amount },
    );
  // I11: General Journal A/R credits applied to invoices; P1: ... or to General Journal charges.
  const journalCreditApps = usedCredits
    .filter(([id, u]) => journalCreditIds.has(id) && !toCharge(u.invoiceId))
    .map(([journalLineId, u]) => ({ journalLineId, invoiceId: u.invoiceId, amount: u.amount }));
  const journalOffsets = usedCredits
    .filter(([id, u]) => journalCreditIds.has(id) && toCharge(u.invoiceId))
    .map(([journalLineId, u]) => ({ journalLineId, chargeLineId: u.invoiceId.slice(JE_PREFIX.length), amount: u.amount }));
  const allCreditApps = usedCredits.map(([, u]) => ({ invoiceId: u.invoiceId, amount: u.amount }));
  /** Credits entered against one invoice (or `je:<line>` charge). */
  const creditOn = (target: string) =>
    allCreditApps.filter((c) => c.invoiceId === target).reduce((s, c) => s + Number(c.amount), 0);
  /** The credit amounts on one target, as entered (summed with Decimal by the fix builders). */
  const creditPartsOn = (target: string) =>
    allCreditApps.filter((c) => c.invoiceId === target).map((c) => c.amount || '0');

  const applications = visibleInvoices
    .map((inv) => ({
      invoiceId: inv.id,
      amountApplied: applicationAmounts[inv.id] && Number(applicationAmounts[inv.id]) > 0 ? applicationAmounts[inv.id] : '0',
      discountAmount: discountAmounts[inv.id] && Number(discountAmounts[inv.id]) > 0 ? discountAmounts[inv.id] : null,
    }))
    .filter((a) => Number(a.amountApplied) > 0 || Number(a.discountAmount ?? 0) > 0);
  // I11: cash applied to General Journal charges.
  const journalItems = shownCharges
    .filter((c) => Number(journalAmounts[c.journalLineId] || 0) > 0)
    .map((c) => ({ journalLineId: c.journalLineId, amount: journalAmounts[c.journalLineId] }));

  const appliedTotal =
    applications.reduce((s, a) => s + Number(a.amountApplied), 0) + journalItems.reduce((s, j) => s + Number(j.amount), 0);
  const discountTotal = applications.reduce((s, a) => s + Number(a.discountAmount ?? 0), 0);
  const creditTotal = allCreditApps.reduce((s, c) => s + Number(c.amount), 0);
  const anyDiscount = discountTotal > 0;

  /**
   * C3: what cash still has to cover on each invoice — its balance less the discount and credits
   * already entered (QB lowers the payment due by the discount). Auto-apply works from this, so a
   * discount taken first can never make the save fail with "more than it owes".
   */
  const cashDueInvoices = (disc = discountAmounts, use = creditUse) => {
    const deductions: Record<string, number> = {};
    for (const inv of visibleInvoices) {
      const cred = Object.values(use)
        .filter((u) => u.invoiceId === inv.id)
        .reduce((s, u) => s + (Number(u.amount) || 0), 0);
      deductions[inv.id] = (Number(disc[inv.id]) || 0) + cred;
    }
    return cashDue(visibleInvoices, deductions);
  };

  const setAppAmount = (invoiceId: string, value: string) => {
    setAppsTouched(true);
    const next = { ...applicationAmounts, [invoiceId]: value };
    setApplicationAmounts(next);
    // "Automatically calculate payments": the amount received follows what is applied.
    if (prefs.company.autoCalculatePayments && !amountTouched) {
      const total = sumApplied(next);
      setAmount(total === '0.00' ? '' : total);
    }
  };

  const changeAmount = (value: string) => {
    setAmount(value);
    setAmountTouched(true);
    // "Automatically apply payments": spread it over open invoices, oldest due first.
    if (prefs.company.autoApplyPayments && !appsTouched) {
      setApplicationAmounts(autoApplyPayment(value, cashDueInvoices()));
    }
  };

  /** A discount or credit changed: re-spread an auto-applied amount over what is still due. */
  const reapply = (disc: Record<string, string>, use: Record<string, { invoiceId: string; amount: string }>) => {
    if (prefs.company.autoApplyPayments && !appsTouched && amount) {
      setApplicationAmounts(autoApplyPayment(amount, cashDueInvoices(disc, use)));
    }
  };
  const setDiscount = (invoiceId: string, value: string) => {
    const next = { ...discountAmounts, [invoiceId]: value };
    setDiscountAmounts(next);
    reapply(next, creditUse);
  };
  const setCredit = (creditId: string, value: { invoiceId: string; amount: string }) => {
    const next = { ...creditUse, [creditId]: value };
    setCreditUse(next);
    reapply(discountAmounts, next);
  };

  // A new payment for a customer whose invoices just loaded: auto-apply the amount already typed.
  useEffect(() => {
    if (!open || editing || appsTouched || !amount || !prefs.company.autoApplyPayments) return;
    setApplicationAmounts(autoApplyPayment(amount, cashDueInvoices()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleInvoices]);

  /** "Pay in full": fill cash for every invoice up to its balance (after discount/credits). */
  function payAll() {
    // The user chose the amounts: a later change of the amount must not re-spread them.
    setAppsTouched(true);
    const next: Record<string, string> = {};
    let left = Number(amount) || 0;
    for (const inv of visibleInvoices) {
      const due = Math.max(0, Number(inv.balanceDue) - Number(discountAmounts[inv.id] || 0) - creditOn(inv.id));
      const take = amount ? Math.min(due, left) : due;
      if (take > 0) next[inv.id] = take.toFixed(2);
      left -= take;
    }
    // Then the General Journal charges (I11), oldest first.
    const nextJournal: Record<string, string> = {};
    for (const c of shownCharges) {
      const due = Math.max(0, Number(c.open) - creditOn(JE_PREFIX + c.journalLineId));
      const take = amount ? Math.min(due, Math.max(0, left)) : due;
      if (take > 0) nextJournal[c.journalLineId] = take.toFixed(2);
      left -= take;
    }
    setApplicationAmounts(next);
    setJournalAmounts(nextJournal);
    if (!amount) {
      const all = [...Object.values(next), ...Object.values(nextJournal)];
      setAmount(all.reduce((s, v) => s + Number(v), 0).toFixed(2));
    }
  }

  /** Inline field messages (lib/fieldValidation.ts). */
  function validateForm(): FieldErrors {
    const nothing = !(Number(amount || 0) > 0) && creditTotal === 0 && discountTotal === 0;
    return collectErrors({
      customer: requiredMessage(customerId, 'Choose the customer who paid.'),
      date: dateMessage(date, 'Payment date'),
      amount:
        amountMessage(amount, { label: 'Amount received', allowZero: true }) ??
        (nothing ? 'Enter the amount received, or apply a credit or discount.' : null),
      rate: foreign && !(Number(exchangeRate) > 0)
        ? `Enter the exchange rate: how much 1 ${currency} is worth in your home currency.`
        : null,
      deposit: !prefs.company.useUndepositedFunds && !depositAccountId
        ? 'Choose the bank account this payment goes into.'
        : null,
    });
  }
  const fieldErrors: FieldErrors = showErrors ? validateForm() : {};

  /** Copy a fix's changes (request-body paths) back onto the form. */
  function applyToForm(patched: PaymentBody, fix: ErrorFix) {
    for (const op of fix.patch ?? []) {
      const value = getPath(patched, op.path);
      const str = typeof value === 'string' ? value : value == null ? '' : String(value);
      if (op.path === 'amount') {
        setAmount(str);
        setAmountTouched(true);
      } else if (op.path === 'date') setDate(str);
      else if (op.path === 'reference') setReference(str);
      else if (op.path === 'depositAccountId') setDepositAccountId(str);
      else if (op.path === 'removeFromDeposit') setRemoveFromDeposit(value === true); // C1
      else {
        const lp = parseLinePath(op.path);
        if (lp?.collection === 'applications' && lp.field === 'amountApplied') {
          const invoiceId = patched.applications[lp.index]?.invoiceId;
          if (invoiceId) {
            setAppsTouched(true);
            setApplicationAmounts((prev) => ({ ...prev, [invoiceId]: str === '0.00' ? '' : str }));
          }
        } else if (lp?.collection === 'journalItems' && lp.field === 'amount') {
          const lineId = patched.journalItems[lp.index]?.journalLineId;
          if (lineId) setJournalAmounts((prev) => ({ ...prev, [lineId]: str === '0.00' ? '' : str }));
        }
      }
    }
  }

  /** Save the payment. Throws on failure (the fix presenter shows it). */
  async function send(body: PaymentBody) {
    const clean = cleanPaymentBody(body);
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/payments/${editing.id}`, clean);
        toast('Payment updated.', 'success');
      } else {
        await api.post('/api/payments', clean);
        toast('Payment recorded successfully.', 'success');
      }
      fixer.clear();
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  /**
   * Over-application checks before saving, each with exact (Decimal) fixes from lib/errorFixes.ts:
   * apply exactly the balance due, raise the amount received, or trim the last application.
   * Returns true when it showed a problem.
   */
  function offerOverApplied(body: PaymentBody, ctx: FixContext<PaymentBody>): boolean {
    for (const [k, a] of body.applications.entries()) {
      const inv = visibleInvoices.find((i) => i.id === a.invoiceId);
      if (!inv) continue;
      const onInvoice = [a.amountApplied, a.discountAmount ?? 0, ...creditPartsOn(inv.id)];
      if (sumMoney(onInvoice).greaterThan(dec(inv.balanceDue))) {
        fixer.offer(
          {
            title: 'More than the invoice owes',
            message: `Invoice #${invNo(inv)} owes ${fixMoney(inv.balanceDue)}, but cash, discount and credits on it add up to more.`,
          },
          overAppliedFixes({
            path: `applications.${k}.amountApplied`,
            balanceDue: inv.balanceDue,
            otherApplied: [a.discountAmount ?? 0, ...creditPartsOn(inv.id)],
            label: `invoice #${invNo(inv)}`,
          }),
          ctx,
        );
        return true;
      }
    }
    for (const [k, j] of body.journalItems.entries()) {
      const c = shownCharges.find((x) => x.journalLineId === j.journalLineId);
      if (!c) continue;
      if (sumMoney([j.amount, ...creditPartsOn(JE_PREFIX + c.journalLineId)]).greaterThan(dec(c.open))) {
        fixer.offer(
          {
            title: 'More than what is still open',
            message: `${c.ref}: the payment and credits are more than what is still open (${formatCurrency(c.open)}).`,
          },
          overAppliedFixes({
            path: `journalItems.${k}.amount`,
            balanceDue: c.open,
            otherApplied: creditPartsOn(JE_PREFIX + c.journalLineId),
            label: c.ref,
          }),
          ctx,
        );
        return true;
      }
    }
    // Same exact Decimal comparison the server makes (no float tolerance).
    if (appliedExceedsReceived(body, amount)) {
      fixer.offer(
        {
          title: 'You applied more than you received',
          message: `The amounts applied (${formatCurrency(cashApplied(body).toFixed(2))}) are more than the amount received (${formatCurrency(amount || '0')}).`,
        },
        appliedExceedsPaymentFixes({
          paymentAmount: amount || '0',
          applications: [
            ...body.applications.map((a, k) => {
              const inv = visibleInvoices.find((i) => i.id === a.invoiceId);
              return { path: `applications.${k}.amountApplied`, amount: a.amountApplied, label: `invoice #${inv ? invNo(inv) : k + 1}` };
            }),
            ...body.journalItems.map((j, k) => ({
              path: `journalItems.${k}.amount`,
              amount: j.amount,
              label: shownCharges.find((c) => c.journalLineId === j.journalLineId)?.ref ?? 'the journal charge',
            })),
          ],
        }),
        ctx,
      );
      return true;
    }
    return false;
  }

  async function handleSubmit() {
    setShowErrors(true);
    const errs = validateForm();
    if (hasErrors(errs)) {
      focusFirstError('pm', errs);
      return;
    }
    // C1: a deposited payment keeps its amount / customer / currency unless taken out of the deposit.
    if (depositBlocked) {
      toast('This payment is in a bank deposit. Keep the amount, or tick "Take it out of the deposit" to save this change.', 'danger');
      return;
    }
    const amt = Number(amount || 0);
    for (const c of shownCredits) {
      const u = creditUse[c.id];
      if (u && Number(u.amount) > Number(c.available) + 0.005) {
        toast(`${c.ref}: only ${formatCurrency(c.available)} of this credit is left.`, 'danger');
        return;
      }
    }

    const body: PaymentBody = {
      customerId,
      date,
      method,
      amount: amt.toFixed(2),
      reference: reference.trim() || null,
      memo: memo.trim() || null,
      depositAccountId: depositAccountId || null,
      discountAccountId: anyDiscount && discountAccountId ? discountAccountId : null,
      currency: foreign ? currency : null,
      exchangeRate: foreign ? exchangeRate.trim() : null,
      applications,
      credits: creditApps,
      journalItems,
      journalCredits: journalCreditApps,
      journalOffsets,
      // C4: earlier unapplied payments, on a new payment AND while editing (no longer dropped).
      paymentCredits: paymentCreditApps,
      ...(depositChange && removeFromDeposit ? { removeFromDeposit: true } : {}),
    };
    const ctx: FixContext<PaymentBody> = {
      payload: cleanPaymentBody(body),
      resubmit: send,
      prepare: cleanPaymentBody,
      applyToForm,
      fallback: 'Failed to save payment',
    };
    if (offerOverApplied(body, ctx)) return;
    if (!confirmTransactionDate(date, prefs)) return;
    try {
      await send(body);
    } catch (err: unknown) {
      fixer.report(err, ctx);
    }
  }

  // C1: a deposited payment keeps its amount, customer, currency and Undeposited Funds; changing
  // any of them needs it taken out of the deposit first (done in the same save).
  const inDeposit = editing?.deposit ?? null;
  const depositChange =
    !!inDeposit &&
    !!editing &&
    (Number(amount || 0).toFixed(2) !== Number(editing.amount).toFixed(2) ||
      customerId !== editing.customerId ||
      currency !== (editing.currency ?? '').toUpperCase() ||
      (depositAccountId || '') !== (editing.depositAccountId ?? '') && !!depositAccountId);
  const depositBlocked = depositChange && !removeFromDeposit;

  const homeValue = foreign && Number(amount) > 0 && Number(exchangeRate) > 0 ? Number(amount) * Number(exchangeRate) : null;

  return (
    <Modal
      size="xl"
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Payment' : 'Receive Payment'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Record Payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {fixer.panel}
        {editing && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Saving changes re-posts this payment so your books stay balanced. Invoices get their old
            amounts back first, then the new amounts are applied.
          </div>
        )}
        {inDeposit && (
          <div
            role="status"
            className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-900 space-y-2"
          >
            <p>
              This payment is part of the bank deposit made on {inDeposit.date.slice(0, 10)}. You can
              apply it to different invoices and change the date (up to the deposit date), method,
              reference and memo. The amount must stay {formatCurrency(editing!.amount)}.
            </p>
            {depositChange && (
              <label className="flex items-start gap-2 font-medium">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={removeFromDeposit}
                  onChange={(e) => setRemoveFromDeposit(e.target.checked)}
                />
                <span>
                  Take it out of the deposit so this change can be saved. The deposit keeps its other
                  items (a deposit with nothing else in it is voided), and the payment goes back to
                  Undeposited Funds to be deposited again.
                </span>
              </label>
            )}
          </div>
        )}
        {/* Customer + currency */}
        <div className={showCurrency ? 'grid grid-cols-3 gap-3' : undefined}>
          <div className={showCurrency ? 'col-span-1' : undefined}>
            <Label htmlFor="pm-customer" required>Customer</Label>
            <Select
              id="pm-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              autoFocus
              aria-required="true"
              {...fieldA11y('pm', 'customer', fieldErrors)}
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
            <FieldError formId="pm" name="customer" errors={fieldErrors} />
          </div>
          {showCurrency && (
            <>
              <div>
                <Label htmlFor="pm-currency">Currency</Label>
                <Select
                  id="pm-currency"
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setApplicationAmounts({});
                    setDiscountAmounts({});
                  }}
                >
                  {currencyChoices.map((c) => (
                    <option key={c || 'home'} value={c}>
                      {c ? c : `${homeCode || 'Home'} (home currency)`}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="pm-rate" required={foreign}>
                  Exchange rate {foreign ? `(1 ${currency} = ? ${homeCode || 'home'})` : ''}
                </Label>
                <Input
                  id="pm-rate"
                  type="number"
                  min="0"
                  step="0.000001"
                  disabled={!foreign}
                  placeholder={foreign ? 'e.g. 1.10' : '1'}
                  value={foreign ? exchangeRate : '1'}
                  onChange={(e) => setExchangeRate(e.target.value)}
                  {...fieldA11y('pm', 'rate', fieldErrors)}
                />
                <FieldError formId="pm" name="rate" errors={fieldErrors} />
              </div>
            </>
          )}
        </div>
        {foreign && (
          <p className="text-xs text-navy/60">
            This payment is in {currency}. Amounts below are in {currency}. Any difference between this
            rate and the rate each invoice was billed at is posted as an exchange gain or loss.
            {homeValue !== null && <> Home-currency value: <strong>{formatCurrency(homeValue.toFixed(2))}</strong>.</>}
          </p>
        )}

        {/* Date + Method + Deposit-to */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="pm-date" required>Payment Date</Label>
            <DateInput
              id="pm-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-required="true"
              {...fieldA11y('pm', 'date', fieldErrors)}
            />
            <FieldError formId="pm" name="date" errors={fieldErrors} />
          </div>
          <div>
            <Label htmlFor="pm-method">Method</Label>
            <Select id="pm-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="credit_card">Credit Card</option>
              <option value="ach">ACH</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pm-deposit" required={!prefs.company.useUndepositedFunds}>
              Deposit to <Help term="undeposited-funds" />
            </Label>
            <Select
              id="pm-deposit"
              value={depositAccountId}
              onChange={(e) => setDepositAccountId(e.target.value)}
              {...fieldA11y('pm', 'deposit', fieldErrors)}
            >
              {/* Preferences > Payments: with Undeposited Funds off, a bank account must be picked. */}
              <option value="">
                {prefs.company.useUndepositedFunds ? 'Undeposited Funds (deposit later)' : 'Select a bank account…'}
              </option>
              {depositAccounts
                .filter((a) => a.code !== '1050')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
            </Select>
            <FieldError formId="pm" name="deposit" errors={fieldErrors} />
          </div>
        </div>

        {/* Amount + Reference + Memo */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="pm-amount" required>Amount Received{foreign ? ` (${currency})` : ''}</Label>
            <AmountInput
              id="pm-amount"
              placeholder="0.00"
              value={amount}
              onChange={(e) => changeAmount(e.target.value)}
              {...fieldA11y('pm', 'amount', fieldErrors)}
            />
            <FieldError formId="pm" name="amount" errors={fieldErrors} />
          </div>
          <div>
            <Label htmlFor="pm-ref">Reference / Check #</Label>
            <Input id="pm-ref" type="text" placeholder="Optional" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pm-memo">Memo</Label>
            <Input id="pm-memo" type="text" placeholder="Optional" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>

        {/* Open invoices */}
        {customerId && (
          <div>
            <div className="flex items-center justify-between">
              <Label>Apply to Open Invoices <Help term="ar" /></Label>
              {(visibleInvoices.length > 0 || shownCharges.length > 0) && (
                <Button variant="ghost" size="sm" onClick={payAll}>
                  Pay all
                </Button>
              )}
            </div>
            {invoicesLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-navy/50">
                <Spinner className="h-4 w-4" /> Loading invoices…
              </div>
            ) : visibleInvoices.length === 0 && shownCharges.length === 0 ? (
              <p className="text-sm text-navy/40 py-2 italic">
                {invoices.length > 0
                  ? `No open invoices in ${currency || homeCode || 'your home currency'} for this customer. Pick another currency above.`
                  : 'No open invoices for this customer.'}
              </p>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden mt-1">
                <Table>
                  <thead>
                    <tr className="bg-slate-50">
                      <Th>Number</Th>
                      <Th>Date</Th>
                      <Th numeric>Balance Due</Th>
                      <Th numeric>Early-pay discount <Help term="early-payment-discount" side="bottom" /></Th>
                      <Th numeric>Payment</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map((inv) => {
                      const sug = suggestions[inv.id];
                      return (
                        <Tr key={inv.id}>
                          <Td className="font-medium">Invoice #{invNo(inv)}</Td>
                          <Td>{formatDate(inv.date)}</Td>
                          <Td numeric className="font-semibold">{money(inv.balanceDue, currency)}</Td>
                          <Td numeric>
                            <AmountInput
                              placeholder="0.00"
                              aria-label={`Discount for invoice ${invNo(inv)}`}
                              value={discountAmounts[inv.id] ?? ''}
                              onChange={(e) => setDiscount(inv.id, e.target.value)}
                              className="text-right"
                            />
                            {sug?.eligible && Number(sug.suggested) > 0 && !discountAmounts[inv.id] && (
                              <button
                                type="button"
                                className="mt-1 text-xs text-electric hover:underline"
                                onClick={() => setDiscount(inv.id, sug.suggested)}
                              >
                                Take {money(sug.suggested, currency)} (paid by {formatDate(sug.discountDate)})
                              </button>
                            )}
                          </Td>
                          <Td numeric>
                            <AmountInput
                              placeholder="0.00"
                              aria-label={`Payment for invoice ${invNo(inv)}`}
                              value={applicationAmounts[inv.id] ?? ''}
                              onChange={(e) => setAppAmount(inv.id, e.target.value)}
                              className="text-right"
                            />
                          </Td>
                        </Tr>
                      );
                    })}
                    {/* I11: General Journal charges for this customer (journal entries to A/R). */}
                    {shownCharges.map((c) => (
                      <Tr key={c.journalLineId}>
                        <Td className="font-medium">
                          {c.ref}
                          {c.memo && <span className="block text-xs font-normal text-navy/50">{c.memo}</span>}
                        </Td>
                        <Td>{c.date ? formatDate(c.date) : ''}</Td>
                        <Td numeric className="font-semibold">{formatCurrency(c.open)}</Td>
                        <Td numeric />
                        <Td numeric>
                          <AmountInput
                            placeholder="0.00"
                            aria-label={`Payment for ${c.ref}`}
                            value={journalAmounts[c.journalLineId] ?? ''}
                            onChange={(e) => {
                              setAppsTouched(true);
                              setJournalAmounts((p) => ({ ...p, [c.journalLineId]: e.target.value }));
                            }}
                            className="text-right"
                          />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            {anyDiscount && (
              <div className="mt-2 grid grid-cols-2 gap-3 items-end">
                <div>
                  <Label htmlFor="pm-disc-acct">Discount account</Label>
                  <Select id="pm-disc-acct" value={discountAccountId} onChange={(e) => setDiscountAccountId(e.target.value)}>
                    <option value="">Sales Discounts (created if needed)</option>
                    {discountAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <p className="text-xs text-navy/50">
                  A discount reduces what the customer owes without any money changing hands.
                </p>
              </div>
            )}

            {/* Credits: credit memos, earlier payments, General Journal credits */}
            {shownCredits.length > 0 && (visibleInvoices.length > 0 || shownCharges.length > 0) && (
              <div className="mt-4">
                <Label>Use available credits</Label>
                <div className="border border-slate-200 rounded-lg overflow-hidden mt-1">
                  <Table>
                    <thead>
                      <tr className="bg-slate-50">
                        <Th>Credit</Th>
                        <Th numeric>Available</Th>
                        <Th>Apply to</Th>
                        <Th numeric>Amount</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownCredits.map((c) => {
                        const use = creditUse[c.id] ?? { invoiceId: '', amount: '' };
                        // General Journal charges can take a General Journal credit or an earlier
                        // payment (QB lets any open credit go against any open charge).
                        const canTakeCharges = c.kind === 'journal_entry' || c.kind === 'payment';
                        return (
                          <Tr key={c.id}>
                            <Td>{c.ref}</Td>
                            <Td numeric>{formatCurrency(c.available)}</Td>
                            <Td>
                              <Select
                                aria-label={`Apply ${c.ref} to`}
                                value={use.invoiceId}
                                onChange={(e) => setCredit(c.id, { ...use, invoiceId: e.target.value })}
                              >
                                <option value="">Don&apos;t use</option>
                                {visibleInvoices.map((inv) => (
                                  <option key={inv.id} value={inv.id}>
                                    Invoice #{invNo(inv)} ({formatCurrency(inv.balanceDue)})
                                  </option>
                                ))}
                                {canTakeCharges &&
                                  shownCharges.map((ch) => (
                                    <option key={ch.journalLineId} value={JE_PREFIX + ch.journalLineId}>
                                      {ch.ref} ({formatCurrency(ch.open)})
                                    </option>
                                  ))}
                              </Select>
                            </Td>
                            <Td numeric>
                              <AmountInput
                                placeholder="0.00"
                                aria-label={`Amount of ${c.ref}`}
                                value={use.amount}
                                onChange={(e) => setCredit(c.id, { ...use, amount: e.target.value })}
                                className="text-right"
                              />
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              </div>
            )}

            {/* Totals */}
            <div className="mt-3 space-y-1 px-1 text-sm">
              <div className="flex justify-between"><span className="text-navy/60">Payment applied</span><span className="font-semibold tabular-nums">{money(appliedTotal, currency)}</span></div>
              {discountTotal > 0 && (
                <div className="flex justify-between"><span className="text-navy/60">Discounts</span><span className="font-semibold tabular-nums">{money(discountTotal, currency)}</span></div>
              )}
              {creditTotal > 0 && (
                <div className="flex justify-between"><span className="text-navy/60">Credits used</span><span className="font-semibold tabular-nums">{formatCurrency(creditTotal)}</span></div>
              )}
              {Number(amount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-navy/60">Left over (kept as a credit for this customer)</span>
                  <span className={'font-semibold tabular-nums ' + (Number(amount) - appliedTotal > 0.005 ? 'text-gold' : 'text-emerald')}>
                    {money(Math.max(0, Number(amount) - appliedTotal), currency)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record Bounced Check (wave2 sales F2)
// ---------------------------------------------------------------------------

function BouncedCheckModal({
  payment,
  accounts,
  customerName,
  onClose,
  onDone,
}: {
  payment: Payment | null;
  accounts: Account[];
  customerName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [bankFee, setBankFee] = useState('');
  const [bankFeeAccountId, setBankFeeAccountId] = useState('');
  const [customerFee, setCustomerFee] = useState('');
  const [customerFeeAccountId, setCustomerFeeAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!payment) return;
    setDate(new Date().toISOString().slice(0, 10));
    setBankFee('');
    setBankFeeAccountId('');
    setCustomerFee('');
    setCustomerFeeAccountId('');
  }, [payment]);
  async function submit() {
    if (!payment) return;
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, {
        action: 'bounce',
        date,
        bankFee: bankFee || null,
        bankFeeAccountId: bankFeeAccountId || null,
        customerFee: customerFee || null,
        customerFeeAccountId: customerFeeAccountId || null,
      });
      toast('Bounced check recorded. The invoices it paid are open again.', 'success');
      onDone();
      onClose();
    } catch (err) {
      toastError(err, 'Could not record the bounced check.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={!!payment}
      onClose={onClose}
      title="Record Bounced Check"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="danger" loading={saving} onClick={submit}>Record bounced check</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-navy/70">
          The bank returned the <strong>{formatCurrency(payment?.amount ?? '0')}</strong> payment from{' '}
          <strong>{customerName}</strong>. We&apos;ll take the money back out of your bank account and
          reopen the invoices it paid, so the customer owes them again. <Help term="bounced-check" side="bottom" />
        </p>
        <div>
          <Label htmlFor="nsf-date">Date the bank returned it</Label>
          <DateInput id="nsf-date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="nsf-bank-fee">Fee your bank charged you</Label>
            <AmountInput id="nsf-bank-fee" placeholder="0.00" value={bankFee} onChange={(e) => setBankFee(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nsf-bank-acct">Expense account for that fee</Label>
            <Select id="nsf-bank-acct" value={bankFeeAccountId} onChange={(e) => setBankFeeAccountId(e.target.value)}>
              <option value="">Bank &amp; Merchant Fees</option>
              {accounts.filter((a) => a.type === 'expense').map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="nsf-cust-fee">Fee to charge the customer</Label>
            <AmountInput id="nsf-cust-fee" placeholder="0.00" value={customerFee} onChange={(e) => setCustomerFee(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nsf-cust-acct">Income account for that fee</Label>
            <Select id="nsf-cust-acct" value={customerFeeAccountId} onChange={(e) => setCustomerFeeAccountId(e.target.value)}>
              <option value="">Other Income</option>
              {accounts.filter((a) => a.type === 'revenue').map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-xs text-navy/50">A customer fee is added as a new invoice to this customer.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply Unapplied Modal — apply an overpaid/unapplied balance to open invoices
// ---------------------------------------------------------------------------

interface ApplyUnappliedModalProps {
  open: boolean;
  payment: Payment | null;
  onClose: () => void;
  onApplied: () => void;
}

function ApplyUnappliedModal({ open, payment, onClose, onApplied }: ApplyUnappliedModalProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [homeCode, setHomeCode] = useState('');

  useEffect(() => {
    if (!open || !payment) return;
    let cancelled = false;
    setAmounts({});
    setLoading(true);
    Promise.all([
      api.get<{ invoices?: Invoice[] } | Invoice[]>(`/api/invoices?customerId=${payment.customerId}`),
      api.get<CurrencyRow[]>('/api/currencies').catch(() => [] as CurrencyRow[]),
    ])
      .then(([rows, curs]) => {
        if (cancelled) return;
        const home = ((Array.isArray(curs) ? curs : []).find((c) => c.isBase)?.code ?? '').toUpperCase();
        setHomeCode(home);
        const norm = (c: string | null | undefined) => {
          const v = (c ?? '').toUpperCase();
          return v === home ? '' : v;
        };
        const list = Array.isArray(rows) ? rows : (rows as { invoices?: Invoice[] }).invoices ?? [];
        // Only what the server accepts: posted (not draft / void), still owing, same currency.
        setInvoices(
          list.filter(
            (inv) =>
              inv.status !== 'void' &&
              inv.status !== 'draft' &&
              Number(inv.balanceDue) > 0 &&
              norm(inv.currency) === norm(payment.currency),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) toast('Failed to load invoices.', 'danger');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, payment]);

  const applications: Application[] = Object.entries(amounts)
    .filter(([, v]) => v && Number(v) > 0)
    .map(([invoiceId, amountApplied]) => ({ invoiceId, amountApplied }));
  const appliedTotal = sumApplications(applications);
  const unapplied = Number(payment?.unapplied ?? 0);
  const cur = payment?.currency && payment.currency.toUpperCase() !== homeCode ? payment.currency : null;

  async function handleApply() {
    if (!payment) return;
    if (applications.length === 0) { toast('Enter an amount to apply.', 'danger'); return; }
    // Exact Decimal comparisons, like the server (no float tolerance).
    if (sumMoney(applications.map((a) => a.amountApplied)).greaterThan(dec(payment.unapplied))) {
      toast('Total applied exceeds the unapplied balance.', 'danger');
      return;
    }
    for (const a of applications) {
      const inv = invoices.find((i) => i.id === a.invoiceId);
      if (inv && dec(a.amountApplied).greaterThan(dec(inv.balanceDue))) {
        toast(`Invoice #${invNo(inv)} only owes ${money(inv.balanceDue, cur)}.`, 'danger');
        return;
      }
    }
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, { action: 'apply', applications });
      toast('Unapplied balance applied to invoices.', 'success');
      onApplied();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to apply payment.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title="Apply Unapplied Balance"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleApply} loading={saving} disabled={loading}>
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {payment && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied balance: </span>
            <span className="font-bold text-navy tabular-nums">
              {money(payment.unapplied, cur)}
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-navy/40">
            <Spinner className="h-4 w-4" /> Loading invoices…
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-navy/40 py-2 italic">No open invoices for this customer{cur ? ` in ${cur}` : ''}.</p>
        ) : (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <Table>
              <thead>
                <tr className="bg-slate-50">
                  <Th>Invoice</Th>
                  <Th>Date</Th>
                  <Th numeric>Balance Due</Th>
                  <Th numeric>Amount to Apply</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <Tr key={inv.id}>
                    <Td className="font-medium">#{invNo(inv)}</Td>
                    <Td>{formatDate(inv.date)}</Td>
                    <Td numeric className="font-semibold">
                      {money(inv.balanceDue, cur)}
                    </Td>
                    <Td numeric>
                      <AmountInput
                        placeholder="0.00"
                        aria-label={`Amount to apply to invoice ${invNo(inv)}`}
                        value={amounts[inv.id] ?? ''}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [inv.id]: e.target.value }))
                        }
                        className="text-right"
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {applications.length > 0 && (
          <div className="flex justify-between items-center px-1 text-sm">
            <span className="text-navy/60">Total to apply</span>
            <span
              className={
                'font-semibold tabular-nums ' +
                (appliedTotal > unapplied ? 'text-red-500' : 'text-navy')
              }
            >
              {money(appliedTotal, cur)}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Refund Modal — refund an unapplied balance back to the customer
// ---------------------------------------------------------------------------

interface RefundPaymentModalProps {
  open: boolean;
  payment: Payment | null;
  accounts: Account[];
  onClose: () => void;
  onRefunded: () => void;
}

function RefundPaymentModal({ open, payment, accounts, onClose, onRefunded }: RefundPaymentModalProps) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && payment) {
      setBankAccountId('');
      setAmount(Number(payment.unapplied).toFixed(2));
    }
  }, [open, payment]);

  // Refunds are paid from a bank or cash account (the server refuses A/R, inventory and the like);
  // Undeposited Funds is left out — a refund check is written on a bank account.
  const bankAccounts = depositTargets(accounts).filter((a) => a.code !== '1050' && a.subtype !== 'undeposited_funds');

  async function handleRefund() {
    if (!payment) return;
    if (!bankAccountId) { toast('Select a bank account.', 'danger'); return; }
    if (!amount || Number(amount) <= 0) { toast('Enter a valid refund amount.', 'danger'); return; }
    if (Number(amount) > Number(payment.unapplied) + 0.005) {
      toast(`Only ${formatCurrency(payment.unapplied)} of this payment is unapplied.`, 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, {
        action: 'refund',
        bankAccountId,
        amount,
      });
      toast('Refund recorded.', 'success');
      onRefunded();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to record refund.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refund Unapplied Payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleRefund} loading={saving}>
            Record Refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {payment && (
          <div className="rounded-lg bg-gold/10 border border-gold/30 px-4 py-3 text-sm text-navy/80">
            Unapplied balance available to refund:{' '}
            <span className="font-bold">{money(payment.unapplied, payment.currency)}</span>
          </div>
        )}

        <div>
          <Label htmlFor="rf-bank" required>Refund From (Bank Account)</Label>
          <Select
            id="rf-bank"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            autoFocus
          >
            <option value="">Select a bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="rf-amount" required>Refund Amount</Label>
          <AmountInput
            id="rf-amount"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

function PaymentsPageContent() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customerMap, setCustomerMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  // List filters (QB: date range, customer, find by number / amount).
  const [filterCustomer, setFilterCustomer] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [applyTarget, setApplyTarget] = useState<Payment | null>(null);
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null);
  const [voidTarget, setVoidTarget] = useState<Payment | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [editTarget, setEditTarget] = useState<PaymentDetail | null>(null);
  const [bounceTarget, setBounceTarget] = useState<Payment | null>(null);

  async function openEdit(p: Payment) {
    try {
      setEditTarget(await api.get<PaymentDetail>(`/api/payments/${p.id}`));
    } catch (err: unknown) {
      toastError(err, 'Could not open the payment.');
    }
  }

  // Search as you type, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  // Any filter change goes back to the first page.
  useEffect(() => setPage(0), [filterCustomer, filterFrom, filterTo, search]);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (filterCustomer) qs.set('customerId', filterCustomer);
      if (filterFrom) qs.set('from', filterFrom);
      if (filterTo) qs.set('to', filterTo);
      if (search) qs.set('search', search);
      const data = await api.get<{ payments: Payment[]; total?: number } | Payment[]>(`/api/payments?${qs.toString()}`);
      const list = Array.isArray(data) ? data : data.payments ?? [];
      setPayments(list);
      setTotal(Array.isArray(data) ? list.length : (data.total ?? list.length));
    } catch (err: unknown) {
      toastError(err, 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, [page, filterCustomer, filterFrom, filterTo, search]);

  const fetchCustomers = useCallback(async () => {
    try {
      const list = await api.get<Customer[]>('/api/customers');
      const arr = Array.isArray(list) ? list : [];
      setCustomers(arr);
      const map: Record<string, string> = {};
      arr.forEach((c) => { map[c.id] = c.displayName; });
      setCustomerMap(map);
    } catch {
      // Non-fatal; customer names will fall back to IDs.
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const list = await api.get<Account[]>('/api/accounts');
      setAccounts(Array.isArray(list) ? list : []);
    } catch {
      // Non-fatal; refund modal will show an empty account list.
    }
  }, []);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);
  useEffect(() => {
    fetchCustomers();
    fetchAccounts();
  }, [fetchCustomers, fetchAccounts]);

  // Quick Actions navigate here with ?new=1 — open the Receive Payment modal.
  useNewParam(() => setModalOpen(true));
  const [prefillCustomerId, setPrefillCustomerId] = useState<string | null>(null);
  usePrefill('payment', (p) => {
    setEditTarget(null);
    setPrefillCustomerId(p.customerId ?? null);
    setModalOpen(true);
  });

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/payments/${voidTarget.id}`);
      toast('Payment voided.', 'success');
      setVoidTarget(null);
      fetchPayments();
    } catch (err: unknown) {
      toastError(err, 'Failed to void payment.');
    } finally {
      setVoiding(false);
    }
  }

  const nameOf = (p: Payment) => p.customerName ?? customerMap[p.customerId] ?? '—';
  const filtered = Boolean(filterCustomer || filterFrom || filterTo || search);
  const firstRow = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastRow = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Receive Payments"
        icon={HandCoins}
        action={
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4" />
            Receive Payment
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <Label htmlFor="pf-search">Find</Label>
          <Input
            id="pf-search"
            type="search"
            placeholder="Check #, reference, customer or amount"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pf-customer">Customer</Label>
          <Select id="pf-customer" value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="pf-from">From</Label>
          <DateInput id="pf-from" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pf-to">To</Label>
          <DateInput id="pf-to" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : payments.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={HandCoins}
              title="No payments match"
              message="Try a different customer, date range or search."
            />
          ) : (
            <EmptyState
              icon={HandCoins}
              title="No payments recorded yet"
              message="When a customer pays an invoice, record it here. The money waits in Undeposited Funds until you record the bank deposit."
              action={
                <Button onClick={() => setModalOpen(true)}>
                  <Plus className="h-4 w-4" /> Receive Payment
                </Button>
              }
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Unapplied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <Tr key={p.id} className={p.voidedAt ? 'opacity-50' : undefined}>
                  <Td className="whitespace-nowrap text-navy/70">{formatDate(p.date)}</Td>
                  <Td className="font-medium text-navy">{nameOf(p)}</Td>
                  <Td>
                    <Badge tone={methodBadgeTone(p.method)}>
                      {METHOD_LABELS[p.method] ?? p.method}
                    </Badge>
                  </Td>
                  <Td className="text-navy/60 text-sm">{p.reference ?? '—'}</Td>
                  <Td numeric className="font-semibold">
                    {money(p.amount, p.currency)}
                  </Td>
                  <Td numeric>
                    {Number(p.unapplied) > 0 ? (
                      <span className="text-gold font-medium">
                        {money(p.unapplied, p.currency)}
                      </span>
                    ) : (
                      <span className="text-emerald font-medium">
                        {money(p.unapplied, p.currency)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {p.voidedAt ? (
                      <Badge tone="neutral">Void</Badge>
                    ) : p.bouncedAt ? (
                      <Badge tone="danger">Bounced</Badge>
                    ) : p.deposited ? (
                      <Badge tone="info">Deposited</Badge>
                    ) : (
                      <Badge tone="success">Posted</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    {!p.voidedAt && !p.bouncedAt && (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(p)} title="Edit this payment">
                          Edit
                        </Button>
                        {/* QB offers Record Bounced Check only for a check that reached the bank. */}
                        {p.canBounce && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setBounceTarget(p)}
                            title="The bank returned this check (NSF)"
                          >
                            Bounced
                          </Button>
                        )}
                        {Number(p.unapplied) > 0 && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setApplyTarget(p)}
                              title="Apply unapplied balance to open invoices"
                            >
                              Apply
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRefundTarget(p)}
                              title="Refund unapplied balance to the customer"
                            >
                              Refund
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoidTarget(p)}
                          className="text-red-500 hover:bg-red-50"
                          title="Void this payment"
                        >
                          Void
                        </Button>
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {total > 0 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm text-navy/60">
            <span>
              Showing {firstRow}–{lastRow} of {total} payment{total === 1 ? '' : 's'} (newest first)
            </span>
            <span className="inline-flex gap-2">
              <Button variant="ghost" size="sm" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Newer
              </Button>
              <Button variant="ghost" size="sm" disabled={lastRow >= total || loading} onClick={() => setPage((p) => p + 1)}>
                Older
              </Button>
            </span>
          </div>
        )}
      </Card>

      <ReceivePaymentModal
        open={modalOpen || !!editTarget}
        editing={editTarget}
        onClose={() => {
          setModalOpen(false);
          setEditTarget(null);
          setPrefillCustomerId(null);
        }}
        prefillCustomerId={editTarget ? null : prefillCustomerId}
        onSaved={fetchPayments}
        customers={customers}
        accounts={accounts}
      />

      <BouncedCheckModal
        payment={bounceTarget}
        accounts={accounts}
        customerName={bounceTarget ? nameOf(bounceTarget) : ''}
        onClose={() => setBounceTarget(null)}
        onDone={fetchPayments}
      />

      <ApplyUnappliedModal
        open={!!applyTarget}
        payment={applyTarget}
        onClose={() => setApplyTarget(null)}
        onApplied={fetchPayments}
      />

      <RefundPaymentModal
        open={!!refundTarget}
        payment={refundTarget}
        accounts={accounts}
        onClose={() => setRefundTarget(null)}
        onRefunded={fetchPayments}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void Payment"
        message={
          <>
            Are you sure you want to void the{' '}
            <strong>{money(voidTarget?.amount ?? '0', voidTarget?.currency)}</strong> payment from{' '}
            <strong>
              {voidTarget ? nameOf(voidTarget) : ''}
            </strong>
            ? This reverses the journal entry and restores the balance due on every invoice it was
            applied to. This cannot be undone.
          </>
        }
        confirmLabel="Void Payment"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={null}>
      <PaymentsPageContent />
    </Suspense>
  );
}
