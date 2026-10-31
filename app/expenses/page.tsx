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
import { Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { Banknote, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  DocNumberInput,
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
import { TypeaheadSelect } from '@/components/TypeaheadSelect';
import { NameField } from '@/components/NameField';
import type { TypeaheadChoice } from '@/lib/typeahead';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { fetchVendorPrefill, PREFILL_SOURCE_LABEL } from '@/lib/aiClient';
import { Money, formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { useFocusParam, useNewParam } from '@/lib/useFocusParam';
import { type PurchaseVendor, vendorPrefillAccountIds } from '@/lib/purchasesClient';
import { useErrorFixes } from '@/components/ErrorFixPanel';
import { FieldError, fieldA11y, focusFirstError } from '@/components/FieldError';
import { getPath, missingClassCheck, missingClassFixes, parseLinePath, type ErrorFix } from '@/lib/errorFixes';
import { amountMessage, collectErrors, dateMessage, requiredMessage, type FieldErrors } from '@/lib/fieldValidation';
// wave2 prefs: Preferences-driven defaults/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { classWarningApplies, confirmTransactionDate } from '@/lib/formPrefs';
import MemorizeButton from '@/components/MemorizeButton';
import { TransactionNav, compareDocNumbers } from '@/components/TransactionNav';
import AttachmentPanel from '@/components/AttachmentPanel';
import { visibleOtherNames, type OtherNameEntry } from '@/lib/lists/otherNameOptions';
import { recallNote, useSmartDefaults } from '@/lib/useSmartDefaults';
import type { SmartForm, SmartLine } from '@/lib/smartDefaults';
// cmdbar: forms accept a prefill from the Ctrl+K command bar.
import { usePrefill } from '@/lib/commands/usePrefill';

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
  /**
   * Item lines loaded for edit: the stored amount and the item / qty / unit cost shown with it.
   * The stored unit cost is rounded to 4 places, so while those are untouched the line re-sends
   * the stored amount instead of letting the server recompute qty x rounded cost.
   */
  loaded?: { itemId: string; quantity: string; unitCost: string; amount: string };
}

/** The stored amount of an item line loaded for edit, while its item / qty / cost are untouched. */
function loadedItemAmount(l: LineRow): string | null {
  const o = l.loaded;
  if (!o || l.mode !== 'item') return null;
  return l.itemId === o.itemId && l.quantity === o.quantity && l.unitCost === o.unitCost ? o.amount : null;
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

type OtherNameOption = OtherNameEntry;

/** Decode the payee select (+ typed name) into the API's vendorId / otherNameId / payeeName. */
function payeeFields(sel: string, typed: string): { vendorId?: string; otherNameId?: string; payeeName?: string } {
  if (!sel) return {};
  if (sel === OTHER_PAYEE) return typed.trim() ? { payeeName: typed.trim() } : {};
  if (sel.startsWith(OTHER_NAME_PREFIX)) return { otherNameId: sel.slice(OTHER_NAME_PREFIX.length) };
  return { vendorId: sel };
}

/** Body sent to /api/expenses (fix patches address its paths, e.g. "reference", "lines.0.accountId"). */
type ExpenseBody = Record<string, unknown>;

function emptyLine(mode: LineRow['mode'] = 'expense'): LineRow {
  return { mode, accountId: '', itemId: '', quantity: '', unitCost: '', description: '', amount: '', classId: '', customerId: '' };
}

/** Entry type → the smart-defaults form whose history is recalled (a card credit recalls charges). */
const ENTRY_SMART_FORM: Record<EntryType, SmartForm> = {
  check: 'check',
  cash: 'expense',
  cc_charge: 'credit_card',
  cc_credit: 'credit_card',
};

/** Entry type → the form key its "last date entered" is remembered under (lib/smartDefaults). */
const ENTRY_DATE_KEY: Record<EntryType, string> = {
  check: 'check',
  cash: 'expense',
  cc_charge: 'credit_card',
  cc_credit: 'credit_card_credit',
};

/** A recalled line (smart defaults) as a form row. */
function rowFromRecall(l: SmartLine): LineRow {
  const shared = { description: l.description ?? '', classId: l.classId ?? '', customerId: l.customerId ?? '' };
  if (l.kind === 'item' && l.itemId) {
    return {
      ...emptyLine('item'),
      ...shared,
      itemId: l.itemId,
      quantity: l.quantity ?? '1',
      unitCost: l.rate ?? '',
      amount: l.rate ? '' : l.amount,
    };
  }
  return { ...emptyLine('expense'), ...shared, accountId: l.accountId ?? '', amount: l.amount };
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
  if (l.mode === 'item') {
    // Mirrors what Save sends: the stored amount of an untouched loaded line, else qty x cost
    // when a cost is entered, else the typed amount.
    const kept = loadedItemAmount(l);
    if (kept != null) return Money.round2(dec(kept)).toNumber();
    if (l.unitCost || !l.amount) return Money.round2(dec(l.quantity).times(dec(l.unitCost))).toNumber();
  }
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
  /** Bumped each time a transaction (or a blank form) is loaded: the toolbar re-reads the form then. */
  const [loadCount, setLoadCount] = useState(0);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [otherNames, setOtherNames] = useState<OtherNameOption[]>([]);
  /** The Other Names list has answered (a command-bar prefill waits for it to match a payee). */
  const [otherNamesReady, setOtherNamesReady] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  /** Set while the form edits a saved transaction. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Fix errors where they happen: server fix suggestions + inline field messages.
  const fixer = useErrorFixes<ExpenseBody>();
  const [showErrors, setShowErrors] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<Expense | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Form state
  const [entryType, setEntryType] = useState<EntryType>('check');
  const [payeeSel, setPayeeSel] = useState('');
  // Active Other Names, plus the saved payee when it has since been made inactive.
  const payeeOtherNames = visibleOtherNames(
    otherNames,
    payeeSel.startsWith(OTHER_NAME_PREFIX) ? payeeSel.slice(OTHER_NAME_PREFIX.length) : null,
  );
  const [payeeName, setPayeeName] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [date, setDate] = useState(() => todayISO());
  /** The user typed a date on this new entry (smart default dates leave it alone then). */
  const dateTouched = useRef(false);
  /** Bumped after each save so the next check number is looked up again. */
  const [checkNoTick, setCheckNoTick] = useState(0);
  /** The payee the form currently shows (guards late recall responses). */
  const payeeRef = useRef('');
  const [reference, setReference] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  /** Shown under the payee after accounts were pre-filled (QB vendor pre-fill). */
  const [prefillNote, setPrefillNote] = useState('');
  const prefs = usePreferences();
  // Smart defaults (lib/useSmartDefaults.ts): recall the payee's last check / expense / card
  // charge, next check number per bank account, default date per form type.
  const smart = useSmartDefaults(ENTRY_SMART_FORM[entryType], ENTRY_DATE_KEY[entryType]);
  const [attachFor, setAttachFor] = useState<string | null>(null);
  // My Preferences > General "Default date": today, or the last date entered on this kind of
  // entry this session — on a new entry whose date the user has not typed.
  useEffect(() => {
    if (!prefs.loaded || editingId || dateTouched.current) return;
    setDate(smart.defaultDate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.loaded, entryType, smart.defaultDate]);
  // My Preferences > Checking: "Start with payee field on check" (else the bank account).
  useEffect(() => {
    if (!prefs.loaded || typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.getElementById(prefs.my.startWithPayee ? 'exp-payee' : 'exp-account')?.focus();
  }, [prefs.loaded, prefs.my.startWithPayee]);

  const isCC = entryType === 'cc_charge' || entryType === 'cc_credit';
  const paymentAccounts = accounts.filter((a) => (isCC ? isCreditCard(a) : isBankish(a)));
  const paymentAccountChoices = paymentAccounts.map((a) => ({ id: a.id, label: a.code ? `${a.code} – ${a.name}` : a.name, terms: [a.name, a.code ?? ''].filter(Boolean) }));
  // Pay to the Order of: vendors, Other Names, and the one-time payee typed on this check.
  const payeeChoices = [
    ...vendors.map((v) => ({ id: v.id, label: v.displayName, hint: 'Vendor' })),
    ...payeeOtherNames.map((o) => ({ id: `${OTHER_NAME_PREFIX}${o.id}`, label: o.label, hint: 'Other Name' })),
    ...(payeeSel === OTHER_PAYEE && payeeName.trim() ? [{ id: OTHER_PAYEE, label: payeeName.trim(), hint: 'This check only' }] : []),
  ];
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
          .get<{ entries: OtherNameOption[] }>('/api/lists/other-names?includeInactive=true')
          .then((d) => setOtherNames(d.entries ?? []))
          .catch(() => setOtherNames([]))
          .finally(() => setOtherNamesReady(true));
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

  // Auto-suggest the next check number for the bank account (checks not queued for printing):
  // the highest number used on that account + 1 (lib/smartDefaults nextCheckNumberFrom).
  const { nextCheckNumber } = smart;
  useEffect(() => {
    let cancelled = false;
    if (entryType !== 'check' || toPrint || !paymentAccountId || editingId) return;
    void nextCheckNumber(paymentAccountId).then((next) => {
      if (!cancelled && next) setReference(next); // null: non-fatal — the user can type a number
    });
    return () => {
      cancelled = true;
    };
  }, [entryType, toPrint, paymentAccountId, editingId, checkNoTick, nextCheckNumber]);

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
  // Find-as-you-type pickers for the line grid (type a name or account number, then Tab).
  const lineAccountChoices: TypeaheadChoice[] = lineAccounts.map((a) => ({ id: a.id, label: `${a.code} – ${a.name}`, terms: [a.code, a.name] }));
  const itemChoices: TypeaheadChoice[] = items.map((it) => ({ id: it.id, label: it.name, hint: it.type === 'inventory' ? 'stock' : undefined }));
  const classChoices: TypeaheadChoice[] = classes.map((c) => ({ id: c.id, label: c.name }));
  const customerChoices: TypeaheadChoice[] = customers.map((c) => ({ id: c.id, label: c.displayName }));

  // Ctrl+W (QB Write Checks) / Quick Actions navigate here with ?new=1 — the entry form is always
  // visible, so jump focus to the start of it (the payee field).
  useNewParam(() => {
    document.getElementById('exp-payee')?.focus();
  });

  // Links such as the Inventory Center's item history (/expenses?focus=<id>) open that check /
  // charge in the form, as double-clicking a transaction does in QB. A void one stays in the list.
  useFocusParam(expenses, loading, (e) => {
    if (!e.voidedAt) void startEdit(e);
  });

  // cmdbar: "check to Shell $45 fuel" fills in a NEW check / expense (once the lists have
  // loaded); the user reviews it and clicks Save.
  usePrefill(
    'expense',
    (p) => {
      resetForm();
      const pay = accounts.find((a) => a.id === p.paymentAccountId);
      if (pay) {
        setEntryType(isCreditCard(pay) ? 'cc_charge' : 'check');
        setPaymentAccountId(pay.id);
      }
      if (p.vendorId) setPayeeSel(p.vendorId);
      else if (p.payeeName) {
        // gapsa Other Names: a typed payee that IS an active Other Name is picked from that list
        // (saved with its otherNameId, like choosing it in the payee field); else a one-off payee.
        const typed = p.payeeName.trim().toLowerCase();
        const other = otherNames.find((o) => o.isActive !== false && o.name.trim().toLowerCase() === typed);
        if (other) {
          setPayeeSel(`${OTHER_NAME_PREFIX}${other.id}`);
        } else {
          setPayeeSel(OTHER_PAYEE);
          setPayeeName(p.payeeName);
        }
      }
      if (p.date) {
        // A date typed in the command wins over the smart default date (which would otherwise
        // re-apply when the entry type switches to a card charge just above).
        dateTouched.current = true;
        setDate(p.date);
      }
      if (p.memo) setMemo(p.memo);
      if (p.lines.length) {
        setLines(
          p.lines.map((l) =>
            l.itemId
              ? { ...emptyLine('item'), itemId: l.itemId, quantity: l.quantity ?? '1', unitCost: l.rate ?? '', amount: l.amount ?? '', description: l.description ?? '' }
              : { ...emptyLine('expense'), accountId: l.accountId ?? '', amount: l.amount ?? '', description: l.description ?? '' },
          ),
        );
      }
      setPrefillNote(p.note ?? '');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => document.getElementById('exp-payee')?.focus(), 50);
    },
    !loading && otherNamesReady,
  );

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
            ? (() => {
                const shown = {
                  itemId: l.itemId,
                  quantity: String(Number(l.quantity ?? 1)),
                  unitCost: l.unitCost ? String(Number(l.unitCost)) : '',
                  amount: String(Math.abs(Number(l.amount)).toFixed(2)),
                };
                return { ...emptyLine('item'), ...shown, description: l.description ?? '', classId: l.classId ?? '', customerId: l.customerId ?? '', loaded: shown };
              })()
            : { ...emptyLine('expense'), accountId: l.accountId, amount: isCredit ? String(Math.abs(Number(l.amount)).toFixed(2)) : l.amount, description: l.description ?? '', classId: l.classId ?? '', customerId: l.customerId ?? '' },
        ),
      );
      setPrefillNote('');
      setLoadCount((n) => n + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toastError(err, 'Failed to load the transaction.');
    }
  }

  function resetForm() {
    fixer.clear();
    setShowErrors(false);
    setEditingId(null);
    setExchangeRate('');
    setPayeeSel('');
    payeeRef.current = '';
    setPayeeName('');
    dateTouched.current = false;
    setDate(smart.defaultDate());
    setCheckNoTick((n) => n + 1);
    setReference('');
    setToPrint(false);
    setMemo('');
    setLines([emptyLine()]);
    setPrefillNote('');
    setLoadCount((n) => n + 1);
  }

  // QB Previous / Next: checks and charges in date order (Previous from a new one opens the latest).
  const navOrder = useMemo(
    () => [...expenses].sort((a, b) => a.date.localeCompare(b.date) || compareDocNumbers(a.reference, b.reference)),
    [expenses],
  );
  const navIndex = editingId ? navOrder.findIndex((x) => x.id === editingId) : -1;
  const navPrev = editingId ? (navIndex > 0 ? navOrder[navIndex - 1] : null) : navOrder[navOrder.length - 1] ?? null;
  const navNext = editingId && navIndex >= 0 && navIndex < navOrder.length - 1 ? navOrder[navIndex + 1] : null;
  const editingExpense = editingId ? expenses.find((x) => x.id === editingId) ?? null : null;

  /**
   * Payee chosen while the lines are still blank: pre-fill accounts (vendor default → last
   * transaction → learned categorizer). Never overwrites anything the user typed.
   */
  async function prefillFor(q: { vendorId?: string; payee?: string }) {
    setPrefillNote('');
    const key = q.vendorId ?? `payee:${q.payee ?? ''}`;
    payeeRef.current = key;
    const blank = (ls: LineRow[]) => ls.every((l) => !l.accountId && !l.itemId && !l.amount && !l.description);
    if (editingId) return;
    // Preferences > Checking: "Autofill payee account number / last account used" gates the
    // last-transaction / learned suggestions (the vendor's own pre-fill accounts always apply).
    // My Preferences > General 'Recall the last transaction for a name' must be on too.
    const recallOn = prefs.company.autofillPayeeAccount && prefs.my.autoRecallLastTransaction;
    // QB auto-fill: the vendor's last check / expense / card charge (lines, class, memo).
    const recalled = recallOn && q.vendorId ? await smart.recall(q.vendorId) : null;
    if (payeeRef.current !== key) return; // another payee was picked meanwhile
    if (recalled?.header.memo) {
      const m = recalled.header.memo;
      setMemo((prev) => prev || m);
    }
    if (!blank(lines)) return;
    // The vendor's own pre-fill accounts (up to 3) win over recalled / learned suggestions.
    const own = vendorPrefillAccountIds(vendors.find((v) => v.id === q.vendorId));
    if (own.length > 0) {
      setLines(own.map((accountId) => ({ ...emptyLine(), accountId })));
      setPrefillNote("Accounts pre-filled from the vendor's pre-fill accounts.");
      return;
    }
    if (recalled && recalled.lines.length > 0) {
      setLines((prev) => (blank(prev) ? recalled.lines.map(rowFromRecall) : prev));
      setPrefillNote(recallNote(recalled));
      return;
    }
    if (recalled) setPrefillNote(recallNote(recalled));
    if (!recallOn) return;
    // Nothing usable on file (or a typed payee): the learned categorizer's suggestion.
    const pf = await fetchVendorPrefill(q);
    if (!pf || payeeRef.current !== key) return;
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

  // ── inline validation (lib/fieldValidation.ts) ───────────────────────────

  /**
   * Plain messages next to each field. A line with no account is reported but does not block the
   * save: the server answers with a "Use <default account>" fix (vendor / Preferences default).
   */
  function validateForm(): { errors: FieldErrors; blocking: boolean } {
    const entries: Record<string, string | null> = {
      payee: payeeSel === OTHER_PAYEE
        ? requiredMessage(payeeName, 'Type the payee name.')
        : requiredMessage(payeeSel, 'Choose who you paid (or pick Other and type a name).'),
      account: requiredMessage(paymentAccountId, isCC ? 'Choose the credit card account.' : 'Choose the bank account the money came from.'),
      date: dateMessage(date, 'Date'),
    };
    lines.forEach((line, i) => {
      const n = i + 1;
      if (line.mode === 'item') {
        entries[`line-${i}-item`] = requiredMessage(line.itemId, `Line ${n}: choose an item.`);
        entries[`line-${i}-qty`] = !(Number(line.quantity) > 0)
          ? `Line ${n}: the quantity must be more than zero.`
          : lineTotal(line) <= 0
            ? `Line ${n}: enter what each one cost.`
            : null;
        return;
      }
      entries[`line-${i}-account`] = requiredMessage(line.accountId, `Line ${n}: choose an account.`);
      entries[`line-${i}-amount`] = amountMessage(line.amount, { label: `Line ${n} amount`, required: true });
    });
    const errors = collectErrors(entries);
    const blocking = Object.keys(errors).some((k) => !/^line-\d+-account$/.test(k));
    return { errors, blocking };
  }
  const fieldErrors: FieldErrors = showErrors ? validateForm().errors : {};

  /** Copy a fix's changes (request-body paths) back onto the form. */
  function applyToForm(patched: ExpenseBody, fix: ErrorFix) {
    for (const op of fix.patch ?? []) {
      const value = getPath(patched, op.path);
      if (op.path === 'date' && typeof value === 'string') {
        dateTouched.current = true; // a fixed date is kept (the smart default date leaves it alone)
        setDate(value);
      } else if (op.path === 'reference') setReference(typeof value === 'string' ? value : '');
      else if (op.path === 'paymentAccountId' && typeof value === 'string') setPaymentAccountId(value);
      else {
        const lp = parseLinePath(op.path);
        if (lp?.collection === 'lines' && (lp.field === 'accountId' || lp.field === 'amount' || lp.field === 'classId')) {
          updateLine(lp.index, lp.field, typeof value === 'string' ? value : '');
        }
      }
    }
  }

  /** Save the check / charge. Throws on failure (the fix presenter shows it). */
  async function send(body: ExpenseBody) {
    setSubmitting(true);
    try {
      await (editingId ? api.patch(`/api/expenses/${editingId}`, body) : api.post('/api/expenses', body));
      // Smart default date: the date this new entry was saved with (a "move the date" fix included).
      if (!editingId) smart.rememberDate(typeof body.date === 'string' ? body.date : date);
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
    } finally {
      setSubmitting(false);
    }
  }

  // ── submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    // gapsa Other Names: vendor, Other Name or a typed one-off payee.
    const payee = payeeFields(payeeSel, payeeName);
    setShowErrors(true);
    const check = validateForm();
    if (check.blocking) {
      focusFirstError('exp', check.errors);
      return;
    }

    if (!confirmTransactionDate(date, prefs)) return;
    // Duplicate check numbers (Preferences > Checking) are caught by the server, which offers
    // "Use the next free check number" / "Keep it anyway" fixes.

    {
      const bodyLines = lines.map((l) =>
        l.mode === 'item'
          ? {
              itemId: l.itemId,
              quantity: l.quantity,
              // An untouched loaded line re-sends its stored amount (the server derives the cost).
              ...(loadedItemAmount(l) != null
                ? { amount: loadedItemAmount(l)! }
                : { unitCost: l.unitCost || undefined, amount: l.unitCost ? undefined : l.amount || undefined }),
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
      );
      const body: ExpenseBody = {
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
        lines: bodyLines,
      };
      const ctx = { payload: body, resubmit: send, applyToForm, fallback: 'Failed to save expense.' };
      // Class tracking "warn when a transaction has no class" (lib/formPrefs.ts): offer fixes
      // instead of a yes/no box — use the class already on another line (or the only class), or
      // save without one.
      const classless = classWarningApplies(null, prefs) ? missingClassCheck(bodyLines, classes) : null;
      if (classless) {
        fixer.offer({ title: classless.title, message: classless.message }, missingClassFixes(classless), ctx);
        return;
      }
      try {
        await send(body);
      } catch (err) {
        fixer.report(err, ctx);
      }
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
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Write Checks / Expenses" icon={Banknote} />

      {/* ------------------------------------------------------------------ */}
      {/* Entry form                                                          */}
      {/* ------------------------------------------------------------------ */}
      {/* data-shortcut-scope: the form keys (Ctrl+S, Alt+S, Alt+A, Esc) act on this form. */}
      <Card className="p-6 mb-8 space-y-5" data-shortcut-scope data-qb-tab-order="exp-account exp-checkno exp-date exp-payee">
        <TransactionNav
          sourceRef={editingId ? `expense:${editingId}` : null}
          onPrevious={navPrev ? () => void startEdit(navPrev) : null}
          onNext={navNext ? () => void startEdit(navNext) : null}
          onRevert={() => (editingExpense ? void startEdit(editingExpense) : resetForm())}
          loadKey={`${loadCount}:${editingId ?? 'new'}`}
        />
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

        {fixer.panel}
        {/* Payee + payment account + date */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="exp-payee" required>Pay to the Order of</Label>
            <NameField
              id="exp-payee"
              nameType="vendor"
              types={['vendor', 'other']}
              value={payeeSel}
              choices={payeeChoices}
              onChange={(v) => {
                setPayeeSel(v);
                if (v && v !== OTHER_PAYEE && !v.startsWith(OTHER_NAME_PREFIX)) prefillFor({ vendorId: v });
                else if (v.startsWith(OTHER_NAME_PREFIX)) {
                  const o = otherNames.find((x) => `${OTHER_NAME_PREFIX}${x.id}` === v);
                  if (o && o.isActive !== false) prefillFor({ payee: o.name });
                }
              }}
              onAdded={(n) => {
                if (n.type === 'other') {
                  setOtherNames((prev) => [...prev, { id: n.id, name: n.label, isActive: true }]);
                  return `${OTHER_NAME_PREFIX}${n.id}`;
                }
                setVendors((prev) => [...prev, { id: n.id, displayName: n.label }]);
                return n.id;
              }}
              onUseOnce={(text) => {
                setPayeeName(text);
                setPayeeSel(OTHER_PAYEE);
                prefillFor({ payee: text });
              }}
              placeholder="Type a payee name…"
              aria-required="true"
              {...fieldA11y('exp', 'payee', fieldErrors)}
            />
            <p className="mt-1 text-xs text-navy/50">
              Type a name and press Tab. A name that is not on a list can be added, or used just this once.
            </p>
            <FieldError formId="exp" name="payee" errors={fieldErrors} />
            {prefillNote && <p className="mt-1 text-xs text-electric">{prefillNote}</p>}
          </div>

          <div>
            <Label htmlFor="exp-account" required>
              {isCC ? 'Credit Card Account' : 'Bank Account'} <Help term="reconcile" side="bottom" />
            </Label>
            <TypeaheadSelect
              id="exp-account"
              value={paymentAccountId}
              choices={paymentAccountChoices}
              onChange={setPaymentAccountId}
              placeholder="Type an account name or number…"
              aria-required="true"
              {...fieldA11y('exp', 'account', fieldErrors)}
            />
            <FieldError formId="exp" name="account" errors={fieldErrors} />
            {isCC && paymentAccounts.length === 0 && (
              <p className="mt-1 text-xs text-navy/40">
                No credit-card accounts found. Add one (liability / credit card) in the chart of
                accounts.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="exp-date" required>Date</Label>
            <DateInput
              id="exp-date"
              value={date}
              onChange={(e) => {
                dateTouched.current = true;
                setDate(e.target.value);
              }}
              aria-required="true"
              {...fieldA11y('exp', 'date', fieldErrors)}
            />
            <FieldError formId="exp" name="date" errors={fieldErrors} />
          </div>
        </div>

        {/* Check number + print later (checks only) + memo */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {entryType === 'check' && (
            <div>
              <Label htmlFor="exp-checkno">Check No.</Label>
              <DocNumberInput
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
                  <TypeaheadSelect
                    aria-label={`Line ${idx + 1} item`}
                    placeholder="Item…"
                    value={line.itemId}
                    onChange={(id) => pickItem(idx, id)}
                    choices={itemChoices}
                    {...fieldA11y('exp', `line-${idx}-item`, fieldErrors)}
                  />
                ) : (
                  <TypeaheadSelect
                    aria-label={`Line ${idx + 1} account`}
                    placeholder="Account…"
                    value={line.accountId}
                    onChange={(id) => updateLine(idx, 'accountId', id)}
                    choices={lineAccountChoices}
                    {...fieldA11y('exp', `line-${idx}-account`, fieldErrors)}
                  />
                )}

                {line.mode === 'item' ? (
                  <div className="grid grid-cols-2 gap-1">
                    <Input
                      placeholder="Qty"
                      inputMode="decimal"
                      aria-label={`Line ${idx + 1} quantity`}
                      {...fieldA11y('exp', `line-${idx}-qty`, fieldErrors)}
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
                  <div>
                    <AmountInput
                      placeholder="0.00"
                      aria-label={`Line ${idx + 1} amount`}
                      {...fieldA11y('exp', `line-${idx}-amount`, fieldErrors)}
                      value={line.amount}
                      onChange={(e) => updateLine(idx, 'amount', e.target.value)}
                    />
                  </div>
                )}

                {prefs.company.classTrackingEnabled || line.classId ? (
                  <TypeaheadSelect
                    aria-label={`Line ${idx + 1} class`}
                    placeholder="Class…"
                    value={line.classId}
                    onChange={(id) => updateLine(idx, 'classId', id)}
                    choices={classChoices}
                  />
                ) : (
                  <span />
                )}

                <TypeaheadSelect
                  aria-label={`Line ${idx + 1} customer`}
                  placeholder="Customer…"
                  value={line.customerId}
                  onChange={(id) => updateLine(idx, 'customerId', id)}
                  choices={customerChoices}
                />

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
          {/* Line messages (each input points at its own message via aria-describedby). */}
          {Object.keys(fieldErrors)
            .filter((k) => k.startsWith('line-'))
            .map((k) => (
              <FieldError key={k} formId="exp" name={k} errors={fieldErrors} />
            ))}

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
