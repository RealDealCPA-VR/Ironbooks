'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { Banknote, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
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
  Modal,
  PageHeader,
  toast, toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { TypeaheadSelect } from '@/components/TypeaheadSelect';
import type { TypeaheadChoice } from '@/lib/typeahead';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { fetchVendorPrefill, PREFILL_SOURCE_LABEL } from '@/lib/aiClient';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  invFromLine,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import {
  TERMS_CHOICES,
  type PurchaseVendor,
  vendorPrefillAccountIds,
} from '@/lib/purchasesClient';
import { useErrorFixes } from '@/components/ErrorFixPanel';
import { FieldError, fieldA11y, focusFirstError } from '@/components/FieldError';
import { getPath, missingClassCheck, missingClassFixes, parseLinePath, type ErrorFix } from '@/lib/errorFixes';
import { amountMessage, collectErrors, dateMessage, requiredMessage, type FieldErrors } from '@/lib/fieldValidation';

/** Body sent to /api/bills (fix patches address its paths, e.g. "billNumber", "lines.0.accountId"). */
type BillBody = Record<string, unknown>;
// wave2 prefs: Preferences-driven defaults/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { classWarningApplies, confirmTransactionDate } from '@/lib/formPrefs';
import { fetchDueDateForTerms, useTermsChoices, withCurrentTerms } from '@/lib/termsClient';
import MemorizeButton from '@/components/MemorizeButton';
import { TransactionNav, compareDocNumbers } from '@/components/TransactionNav';
import type Decimal from 'decimal.js';
import { billItemLineAmount, sumLineAmounts, typedLineAmount } from '@/lib/purchaseLineMath';
import { recallNote, useSmartDefaults } from '@/lib/useSmartDefaults';
import { billRowFromRecall, lineClassOverride } from '@/lib/smartDefaults';
import AttachmentPanel from '@/components/AttachmentPanel';
// cmdbar: forms accept a prefill from the Ctrl+K command bar.
import { usePrefill } from '@/lib/commands/usePrefill';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bill {
  id: string;
  vendorId: string;
  billNumber: string | null;
  date: string;
  dueDate: string | null;
  total: string;
  amountPaid: string;
  amountCredited: string;
  balanceDue: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  memo: string | null;
  terms?: string | null;
  classId?: string | null;
  currency?: string | null;
  exchangeRate?: string | null;
}

interface BillDetailLine {
  id: string;
  accountId: string;
  itemId: string | null;
  description: string | null;
  quantity: string;
  amount: string;
  /** Stored as the line's own class, or the bill's class when the line had none. */
  classId?: string | null;
  /** Billable customer (+ job) for invoice passthrough. */
  customerId?: string | null;
  jobId?: string | null;
  // Advanced Inventory detail (present only when stored for the line)
  siteId?: string | null;
  binId?: string | null;
  serialNumbers?: string[] | null;
  lotNumber?: string | null;
  lotExpiration?: string | null;
}

/** A bill can be edited while nothing has been applied against it. */
function isEditable(bill: Bill): boolean {
  return (
    bill.status !== 'void' &&
    Number(bill.amountPaid) === 0 &&
    Number(bill.amountCredited) === 0
  );
}

type Vendor = PurchaseVendor;

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface ClassRow {
  id: string;
  name: string;
}

interface CustomerRow {
  id: string;
  displayName: string;
}

interface Item {
  id: string;
  name: string;
  type: 'service' | 'inventory' | 'non_inventory' | 'bundle';
  purchaseCost: string | null;
  quantityOnHand: string | null;
  trackingMode?: string | null;
}

type LineMode = 'expense' | 'item';

interface LineRow {
  mode: LineMode;
  // Expense-mode fields
  accountId: string;
  amount: string;
  // Item-mode fields (QB "Items tab")
  itemId: string;
  quantity: string;
  unitCost: string;
  // Shared
  description: string;
  /** The line's own class ('' = the bill's class). */
  classId: string;
  /** Billable customer ('' = not billable) and its job (kept from recall / edit). */
  customerId: string;
  jobId: string;
  /** Advanced Inventory: receiving site / bin / serials / lot (inventory item lines). */
  inv?: InvDetail;
  /**
   * Item lines loaded for edit: the stored amount and the quantity / unit cost shown for it.
   * The shown unit cost is rounded (amount / qty), so while they are untouched the line saves
   * (and displays) the stored amount instead of qty x rounded cost.
   */
  loaded?: { itemId: string; quantity: string; unitCost: string; amount: string };
}

/** The stored amount of an item line loaded for edit, while its item / qty / cost are untouched. */
function loadedItemAmount(line: LineRow): string | null {
  const l = line.loaded;
  if (!l || line.mode !== 'item') return null;
  return line.itemId === l.itemId && line.quantity === l.quantity && line.unitCost === l.unitCost ? l.amount : null;
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function statusTone(status: Bill['status']): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  switch (status) {
    case 'paid':
      return 'success';
    case 'partial':
      return 'warning';
    case 'void':
      return 'danger';
    default:
      return 'info';
  }
}

function statusLabel(status: Bill['status']): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'partial':
      return 'Partial';
    case 'paid':
      return 'Paid';
    case 'void':
      return 'Void';
  }
}

// ---------------------------------------------------------------------------
// Empty line factory
// ---------------------------------------------------------------------------

function emptyLine(mode: LineMode = 'expense'): LineRow {
  return {
    mode,
    accountId: '',
    amount: '',
    itemId: '',
    quantity: '',
    unitCost: '',
    description: '',
    classId: '',
    customerId: '',
    jobId: '',
  };
}

/**
 * Display amount for a line: explicit amount (expense) or qty x cost (item), rounded to cents the
 * way lib/services/bills.ts saves it (lib/purchaseLineMath.ts): 3 × 1.335 is $4.01, not $4.00.
 */
function lineAmountDec(line: LineRow): Decimal {
  if (line.mode === 'item') {
    const kept = loadedItemAmount(line);
    if (kept != null) return typedLineAmount(kept);
    return billItemLineAmount(line.quantity, line.unitCost);
  }
  return typedLineAmount(line.amount);
}

function lineAmount(line: LineRow): number {
  return lineAmountDec(line).toNumber();
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function BillsPage() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const prefs = usePreferences();
  // Smart defaults: recall the vendor's last bill, default date (lib/useSmartDefaults.ts).
  const smart = useSmartDefaults('bill');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  /** Customers for billable lines (empty when the user cannot read customers). */
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state — editingId set means the modal is editing an existing bill.
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Fix errors where they happen: server fix suggestions + inline field messages.
  const fixer = useErrorFixes<BillBody>();
  const [showErrors, setShowErrors] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Bumped each time a bill (or a blank form) is loaded: the toolbar re-reads the form then. */
  const [loadCount, setLoadCount] = useState(0);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);

  // Form fields
  const [vendorId, setVendorId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [date, setDate] = useState(() => todayISO());
  const [dueDate, setDueDate] = useState('');
  const [terms, setTerms] = useState('');
  // Terms list entries (custom and date-driven terms included); the built-in set until it loads.
  const termsChoices = useTermsChoices(TERMS_CHOICES);
  const [memo, setMemo] = useState('');
  const [classId, setClassId] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  /** The vendor the form currently shows (guards late recall responses). */
  const vendorRef = useRef('');
  /** Shown under the vendor picker after accounts were pre-filled (QB vendor pre-fill). */
  const [prefillNote, setPrefillNote] = useState('');

  // Advanced Inventory (sites / bins / serial & lot) for item lines.
  const adv = useAdvancedInventory(modalOpen);

  // Void confirm
  const [pendingVoid, setPendingVoid] = useState<Bill | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchBills = useCallback(async () => {
    try {
      const data = await api.get<Bill[]>('/api/bills');
      setBills(data);
    } catch (err) {
      toastError(err, 'Failed to load bills');
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [billData, vendorData, accountData, itemData, classData] = await Promise.all([
          api.get<Bill[]>('/api/bills'),
          api.get<Vendor[]>('/api/vendors'),
          api.get<Account[]>('/api/accounts'),
          api.get<{ items: Item[] }>('/api/items'),
          api.get<ClassRow[]>('/api/classes').catch(() => [] as ClassRow[]),
        ]);
        setBills(billData);
        setClasses(classData);
        setVendors(vendorData);
        setAccounts(accountData);
        setItems(itemData.items ?? []);
        api
          .get<CustomerRow[]>('/api/customers')
          .then(setCustomers)
          .catch(() => setCustomers([]));
      } catch (err) {
        toastError(err, 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // cmdbar: "bill from Staples 120 office supplies" opens a NEW bill filled in (once the
  // vendor/account lists have loaded); the user reviews and saves it as usual.
  usePrefill(
    'bill',
    (p) => {
      openModal();
      const vendor = vendors.find((v) => v.id === p.vendorId);
      // A date typed in the command, else the smart default date (as openModal just set it).
      const billDate = p.date ?? smart.defaultDate();
      if (p.vendorId) setVendorId(p.vendorId);
      setDate(billDate);
      if (p.memo) setMemo(p.memo);
      if (vendor) {
        setTerms(vendor.terms ?? '');
        void fetchDueDateForTerms(billDate, vendor.terms || prefs.company.defaultVendorTerms).then((due) => {
          if (due) setDueDate(due);
        });
      }
      if (p.lines.length) {
        setLines(
          p.lines.map((l) =>
            l.itemId
              ? { ...emptyLine('item'), itemId: l.itemId, quantity: l.quantity ?? '1', unitCost: l.rate ?? '', description: l.description ?? '' }
              : { ...emptyLine('expense'), accountId: l.accountId ?? '', amount: l.amount ?? '', description: l.description ?? '' },
          ),
        );
      }
      setPrefillNote(p.note ?? '');
    },
    !loading,
  );

  // ---------------------------------------------------------------------------
  // ID -> Name lookup helpers
  // ---------------------------------------------------------------------------

  function vendorName(id: string): string {
    return vendors.find((v) => v.id === id)?.displayName ?? '—';
  }

  // ---------------------------------------------------------------------------
  // Modal helpers
  // ---------------------------------------------------------------------------

  function openModal() {
    fixer.clear();
    setShowErrors(false);
    setEditingId(null);
    setVendorId('');
    vendorRef.current = '';
    setBillNumber('');
    // My Preferences > General "Default date": today, or the last bill date entered this session.
    setDate(smart.defaultDate());
    setDueDate('');
    setTerms('');
    setMemo('');
    setClassId('');
    setExchangeRate('');
    setLines([emptyLine()]);
    setPrefillNote('');
    setModalOpen(true);
    setLoadCount((n) => n + 1);
  }

  /**
   * Vendor picked on a NEW bill whose lines are still blank: pre-fill the expense accounts
   * (vendor default → last bill/check → learned categorizer). Never overwrites typed lines.
   */
  /** Terms picked: the due date follows them (Terms list, Standard or Date-Driven). */
  function handleTermsChange(value: string) {
    setTerms(value);
    const vendor = vendors.find((v) => v.id === vendorId);
    const ref = value || vendor?.terms || prefs.company.defaultVendorTerms;
    void fetchDueDateForTerms(date, ref).then((due) => {
      if (due) setDueDate(due);
    });
  }

  async function handleVendorChange(id: string) {
    setVendorId(id);
    vendorRef.current = id;
    setPrefillNote('');
    if (!id || editingId) return;
    const vendor = vendors.find((v) => v.id === id);
    setTerms(vendor?.terms ?? '');
    // Due date from the vendor's terms on the Terms list (else Preferences > Bills default terms).
    void fetchDueDateForTerms(date, vendor?.terms || prefs.company.defaultVendorTerms).then((due) => {
      if (due && vendorRef.current === id) setDueDate(due);
    });
    const blank = (ls: LineRow[]) =>
      ls.every((l) => l.mode === 'expense' && !l.accountId && !l.amount && !l.description);
    // My Preferences > General 'Recall the last transaction for a name' (QB auto-fill): the
    // vendor's last bill gives the terms, class, memo and lines (null when the preference is off).
    const recalled = await smart.recall(id);
    if (vendorRef.current !== id) return; // another vendor was picked meanwhile
    if (recalled) {
      const h = recalled.header;
      if (h.terms) {
        const t = h.terms;
        setTerms(t);
        void fetchDueDateForTerms(date, t).then((due) => {
          if (due && vendorRef.current === id) setDueDate(due);
        });
      }
      if (h.classId) setClassId((prev) => prev || h.classId || '');
      if (h.memo) setMemo((prev) => prev || h.memo || '');
    }
    if (!blank(lines)) return;
    // The vendor's own pre-fill accounts (up to 3) win over recalled / learned lines.
    const own = vendorPrefillAccountIds(vendor);
    if (own.length > 0) {
      setLines(own.map((accountId) => ({ ...emptyLine('expense'), accountId })));
      setPrefillNote("Accounts pre-filled from the vendor's pre-fill accounts.");
      return;
    }
    if (recalled && recalled.lines.length > 0) {
      // Each line keeps its own class (when it differs from the bill's) and billable customer:job.
      setLines((prev) => (blank(prev) ? recalled.lines.map((l) => billRowFromRecall(l, recalled.header.classId)) : prev));
      setPrefillNote(recallNote(recalled));
      return;
    }
    if (recalled) setPrefillNote(recallNote(recalled));
    if (!prefs.my.autoRecallLastTransaction) return;
    // Nothing usable on file for this vendor: the learned categorizer's suggestion (local model).
    const pf = await fetchVendorPrefill({ vendorId: id });
    if (!pf || vendorRef.current !== id) return;
    setLines((prev) => {
      if (!blank(prev)) return prev; // user started typing while we fetched
      return pf.lines.map((l) => ({ ...emptyLine('expense'), accountId: l.accountId }));
    });
    setPrefillNote(`Accounts pre-filled ${PREFILL_SOURCE_LABEL[pf.source]}.`);
  }

  /** Prefill the form from a saved bill and open the modal in edit mode. */
  async function openEditModal(bill: Bill) {
    setLoadingEditId(bill.id);
    try {
      const detail = await api.get<Bill & { lines: BillDetailLine[] }>(`/api/bills/${bill.id}`);
      setEditingId(bill.id);
      setVendorId(detail.vendorId);
      vendorRef.current = detail.vendorId;
      setBillNumber(detail.billNumber ?? '');
      setDate(detail.date.slice(0, 10));
      setDueDate(detail.dueDate ? detail.dueDate.slice(0, 10) : '');
      setTerms(detail.terms ?? '');
      setMemo(detail.memo ?? '');
      setClassId(detail.classId ?? '');
      setExchangeRate(detail.currency && detail.exchangeRate ? String(Number(detail.exchangeRate)) : '');
      setLines(
        detail.lines.length === 0
          ? [emptyLine()]
          : detail.lines.map((l) => {
              const dims = {
                classId: lineClassOverride(l.classId, detail.classId),
                customerId: l.customerId ?? '',
                jobId: l.customerId ? (l.jobId ?? '') : '',
              };
              if (l.itemId) {
                const qty = Number(l.quantity) || 1;
                const unitCost = Number(l.amount) / qty;
                const shown = { quantity: String(qty), unitCost: String(parseFloat(unitCost.toFixed(4))) };
                return {
                  mode: 'item' as LineMode,
                  accountId: '',
                  amount: '',
                  itemId: l.itemId,
                  ...shown,
                  description: l.description ?? '',
                  ...dims,
                  inv: invFromLine(l),
                  loaded: { itemId: l.itemId, ...shown, amount: l.amount },
                };
              }
              return {
                mode: 'expense' as LineMode,
                accountId: l.accountId,
                amount: l.amount,
                itemId: '',
                quantity: '',
                unitCost: '',
                description: l.description ?? '',
                ...dims,
              };
            }),
      );
      setModalOpen(true);
      setLoadCount((n) => n + 1);
    } catch (err) {
      toastError(err, 'Failed to load bill.');
    } finally {
      setLoadingEditId(null);
    }
  }

  function closeModal() {
    if (!submitting) setModalOpen(false);
  }

  // QB Previous / Next: bills in date order (Previous from a new bill opens the latest).
  const navOrder = useMemo(
    () => [...bills].sort((a, b) => a.date.localeCompare(b.date) || compareDocNumbers(a.billNumber, b.billNumber)),
    [bills],
  );
  const navIndex = editingId ? navOrder.findIndex((b) => b.id === editingId) : -1;
  const navPrev = editingId ? (navIndex > 0 ? navOrder[navIndex - 1] : null) : navOrder[navOrder.length - 1] ?? null;
  const navNext = editingId && navIndex >= 0 && navIndex < navOrder.length - 1 ? navOrder[navIndex + 1] : null;
  const editingBill = editingId ? bills.find((b) => b.id === editingId) ?? null : null;

  // Line row mutations
  function updateLine(index: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /** Item picked on an item-mode line: default the cost from the item's purchase cost. */
  function pickItem(index: number, itemId: string) {
    const item = items.find((it) => it.id === itemId);
    setLines((prev) =>
      prev.map((row, i) =>
        i === index
          ? {
              ...row,
              itemId,
              unitCost: row.unitCost || (item?.purchaseCost ?? ''),
              quantity: row.quantity || '1',
            }
          : row,
      ),
    );
  }

  function addLine(mode: LineMode = 'expense') {
    setLines((prev) => [...prev, emptyLine(mode)]);
  }

  /** Scan-to-add: a scanned item becomes an item line (fills an empty line when there is one). */
  function addScannedItem(it: { id: string; purchaseCost?: string | null }) {
    setLines((prev) => {
      const row: LineRow = { ...emptyLine('item'), itemId: it.id, quantity: '1', unitCost: it.purchaseCost ?? '' };
      const emptyIdx = prev.findIndex((l) => !l.itemId && !l.accountId && !l.amount && !l.quantity);
      if (emptyIdx >= 0) return prev.map((l, i) => (i === emptyIdx ? row : l));
      return [...prev, row];
    });
  }

  function removeLine(index: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert adds a line (same mode as the
  // last line), Ctrl+Delete removes the focused row, Enter moves down.
  // Find-as-you-type pickers for the line grid (type a name or account number, then Tab).
  const accountChoices: TypeaheadChoice[] = accounts.map((a) => ({ id: a.id, label: `${a.code} – ${a.name}`, terms: [a.code, a.name] }));
  const itemChoices: TypeaheadChoice[] = items.map((it) => ({
    id: it.id,
    label: it.name,
    hint: it.type === 'inventory' ? `${Number(it.quantityOnHand ?? 0)} on hand` : undefined,
  }));

  const grid = useGridKeys({
    addRow: () => setLines((prev) => [...prev, emptyLine(prev[prev.length - 1]?.mode ?? 'expense')]),
    removeRow: removeLine,
    disabled: submitting,
  });

  // Running total for display: the sum of the lines rounded as the bill saves them.
  const runningTotal = sumLineAmounts(lines.map(lineAmountDec)).toNumber();
  const selectedVendor = vendors.find((v) => v.id === vendorId);

  // ---------------------------------------------------------------------------
  // Submit new bill
  // ---------------------------------------------------------------------------

  /**
   * Inline field messages (lib/fieldValidation.ts). A line with no account is reported but does
   * not block the save: the server answers with a "Use <default account>" fix.
   */
  function validateForm(): { errors: FieldErrors; blocking: boolean } {
    const entries: Record<string, string | null> = {
      vendor: requiredMessage(vendorId, 'Choose the vendor who sent this bill.'),
      date: dateMessage(date, 'Bill date'),
      due: dateMessage(dueDate, 'Due date', { required: false, notBefore: date ? { value: date, what: 'the bill date' } : undefined }),
    };
    lines.forEach((line, i) => {
      const n = i + 1;
      if (line.mode === 'item') {
        entries[`line-${i}-item`] = requiredMessage(line.itemId, `Line ${n}: choose an item.`);
        entries[`line-${i}-qty`] = Number(line.quantity) > 0 ? null : `Line ${n}: the quantity must be more than zero.`;
        // 0 is a cost too (items received at no charge, e.g. a no-charge line of a purchase order).
        entries[`line-${i}-cost`] =
          String(line.unitCost ?? '').trim() !== '' && Number(line.unitCost) >= 0 ? null : `Line ${n}: enter what each one cost (0 for no charge).`;
        return;
      }
      entries[`line-${i}-account`] = requiredMessage(line.accountId, `Line ${n}: choose an account.`);
      entries[`line-${i}-amount`] = amountMessage(line.amount, { label: `Line ${n} amount`, required: true, allowZero: true });
    });
    const errors = collectErrors(entries);
    return { errors, blocking: Object.keys(errors).some((k) => !/^line-\d+-account$/.test(k)) };
  }
  const fieldErrors: FieldErrors = showErrors ? validateForm().errors : {};

  /** Copy a fix's changes (request-body paths) back onto the form. */
  function applyToForm(patched: BillBody, fix: ErrorFix) {
    for (const op of fix.patch ?? []) {
      const value = getPath(patched, op.path);
      if (op.path === 'date' && typeof value === 'string') setDate(value);
      else if (op.path === 'billNumber') setBillNumber(typeof value === 'string' ? value : '');
      else {
        const lp = parseLinePath(op.path);
        if (lp?.collection === 'lines' && (lp.field === 'accountId' || lp.field === 'amount' || lp.field === 'classId')) {
          updateLine(lp.index, { [lp.field]: typeof value === 'string' ? value : '' });
        }
      }
    }
  }

  /** Save the bill. Throws on failure (the fix presenter shows it). */
  async function send(body: BillBody) {
    setSubmitting(true);
    try {
      await (editingId ? api.patch(`/api/bills/${editingId}`, body) : api.post('/api/bills', body));
      // Smart default date: the date this new bill was saved with (a "move the date" fix included).
      if (!editingId) smart.rememberDate(typeof body.date === 'string' ? body.date : date);
      toast(editingId ? 'Bill updated.' : 'Bill created.', 'success');
      fixer.clear();
      setModalOpen(false);
      await fetchBills();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    setShowErrors(true);
    const check = validateForm();
    if (check.blocking) {
      focusFirstError('bill', check.errors);
      return;
    }

    if (!confirmTransactionDate(date, prefs)) return;
    // Duplicate vendor reference numbers (Preferences > Bills) are caught by the server, which
    // offers a "Keep it anyway" fix.

    {
      const payload: BillBody = {
        vendorId,
        billNumber: billNumber.trim() || undefined,
        date,
        dueDate: dueDate || undefined,
        terms: terms || undefined,
        memo: memo.trim() || undefined,
        classId: classId || (editingId ? null : undefined),
        exchangeRate: selectedVendor?.currency && exchangeRate.trim() ? exchangeRate.trim() : undefined,
        lines: lines.map((l) => {
          // Blank class = the bill's class (the service fills it in).
          const dims = {
            classId: l.classId || null,
            customerId: l.customerId || null,
            jobId: (l.customerId && l.jobId) || null,
          };
          // An untouched loaded item line re-sends its stored amount (the server derives the
          // exact unit cost from it) — the shown cost is rounded, and qty x rounded cost can
          // differ from the stored amount by a cent or more.
          const keptAmount = loadedItemAmount(l);
          return l.mode === 'item'
            ? {
                itemId: l.itemId,
                quantity: l.quantity,
                ...(keptAmount != null ? { amount: keptAmount } : { unitCost: l.unitCost }),
                description: l.description.trim() || undefined,
                ...dims,
                ...inventoryLinePayload(l.inv),
              }
            : {
                accountId: l.accountId,
                description: l.description.trim() || undefined,
                amount: l.amount,
                ...dims,
              };
        }),
      };
      const ctx = {
        payload,
        resubmit: send,
        applyToForm,
        fallback: editingId ? 'Failed to update bill.' : 'Failed to create bill.',
      };
      // Class tracking "warn when a transaction has no class" (lib/formPrefs.ts): offer fixes
      // instead of a yes/no box — use the class already on another line (or the only class), or
      // save without one. A bill-level class covers every line left blank (the service fills it).
      const classless = classWarningApplies(classId || null, prefs)
        ? missingClassCheck(payload.lines as { classId?: string | null }[], classes)
        : null;
      if (classless) {
        fixer.offer({ title: classless.title, message: classless.message }, missingClassFixes(classless), ctx);
        return;
      }
      try {
        await send(payload);
      } catch (err) {
        fixer.report(err, ctx);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Void bill
  // ---------------------------------------------------------------------------

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/bills/${id}`);
      toast('Bill voided.', 'success');
      setPendingVoid(null);
      await fetchBills();
    } catch (err) {
      toastError(err, 'Failed to void bill.');
    } finally {
      setVoidingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Bills"
        icon={Receipt}
        action={
          <span className="flex items-center gap-2">
            <Link href="/pay-bills">
              <Button variant="secondary">
                <Banknote className="h-4 w-4" />
                Pay Bills
              </Button>
            </Link>
            <Button onClick={openModal}>
              <Plus className="h-4 w-4" />
              New Bill
            </Button>
          </span>
        }
      />

      <p className="-mt-4 mb-4 text-sm text-navy/60">
        A bill is money you owe a vendor. Until you pay it, it sits in Accounts Payable{' '}
        <Help term="ap" side="bottom" />. Pay it from{' '}
        <Link href="/pay-bills" className="text-electric underline">Pay Bills</Link>.
      </p>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading bills…
          </div>
        ) : bills.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No bills yet"
            message="Got a bill you will pay later? Enter it here so you know what you owe (Accounts Payable). When you pay it, use Pay Bills."
            action={
              <Button onClick={openModal}>
                <Plus className="h-4 w-4" /> New Bill
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Bill #</Th>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>Due Date</Th>
                <Th numeric>Total</Th>
                <Th numeric>Balance Due</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => (
                <Tr key={bill.id}>
                  <Td className="font-mono text-sm">{bill.billNumber ?? <span className="text-navy/30 italic">—</span>}</Td>
                  <Td className="font-medium">{vendorName(bill.vendorId)}</Td>
                  <Td>{bill.date ? formatDate(bill.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td>{bill.dueDate ? formatDate(bill.dueDate, 'MMM d, yyyy') : <span className="text-navy/30">—</span>}</Td>
                  <Td numeric>
                    {formatCurrency(bill.total)}
                    {bill.currency && <span className="ml-1 text-xs text-navy/50">{bill.currency}</span>}
                  </Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(bill.balanceDue)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(bill.status)}>{statusLabel(bill.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    {isEditable(bill) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={loadingEditId === bill.id}
                        loading={loadingEditId === bill.id}
                        onClick={() => openEditModal(bill)}
                        title="Edit this bill (re-posts the GL entry)"
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    )}
                    {bill.status !== 'void' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === bill.id}
                        onClick={() => setPendingVoid(bill)}
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

      {/* New / Edit Bill Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingId ? 'Edit Bill' : 'New Bill'}
        size="lg"
        footer={
          <>
            <MemorizeButton
              docType="bill"
              shortcut={modalOpen}
              defaultName={vendors.find((v) => v.id === vendorId)?.displayName}
              getTemplate={() => {
                if (!vendorId) return 'Pick a vendor before memorizing.';
                const rows = lines.filter((l) => (l.mode === 'item' ? l.itemId : l.accountId));
                if (rows.length === 0) return 'Add at least one line before memorizing.';
                return {
                  vendorId,
                  date,
                  dueDate: dueDate || undefined,
                  lines: rows.map((l) =>
                    l.mode === 'item'
                      ? { itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, description: l.description.trim() || undefined }
                      : { accountId: l.accountId, description: l.description.trim() || undefined, amount: l.amount },
                  ),
                };
              }}
            />
            <Button variant="secondary" onClick={closeModal} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={submitting}>
              {editingId ? 'Save Changes' : 'Save Bill'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <TransactionNav
            sourceRef={editingId ? `bill:${editingId}` : null}
            onPrevious={navPrev ? () => void openEditModal(navPrev) : null}
            onNext={navNext ? () => void openEditModal(navNext) : null}
            onRevert={() => (editingBill ? void openEditModal(editingBill) : openModal())}
            loadKey={`${loadCount}:${editingId ?? 'new'}`}
          />
          {fixer.panel}
          {editingId && (
            <p className="text-xs text-navy/50 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              Saving re-posts the bill&apos;s journal entry on the new date and re-receives any
              inventory item lines. Editing is only possible while no payments or credits are applied.
            </p>
          )}
          {/* Vendor */}
          <div>
            <Label htmlFor="bill-vendor" required>Vendor <Help term="ap" /></Label>
            <Select
              id="bill-vendor"
              autoFocus
              value={vendorId}
              onChange={(e) => handleVendorChange(e.target.value)}
              aria-required="true"
              {...fieldA11y('bill', 'vendor', fieldErrors)}
            >
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
            <FieldError formId="bill" name="vendor" errors={fieldErrors} />
            {prefillNote && <p className="mt-1 text-xs text-electric">{prefillNote}</p>}
          </div>

          {/* Bill Number + Date row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bill-number">Bill # (optional)</Label>
              <Input
                id="bill-number"
                placeholder="e.g. INV-1001"
                value={billNumber}
                onChange={(e) => setBillNumber(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="bill-date" required>Bill Date</Label>
              <DateInput
                id="bill-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-required="true"
                {...fieldA11y('bill', 'date', fieldErrors)}
              />
              <FieldError formId="bill" name="date" errors={fieldErrors} />
            </div>
          </div>

          {/* Terms + Due Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bill-terms">Terms</Label>
              <Select id="bill-terms" value={terms} onChange={(e) => handleTermsChange(e.target.value)}>
                <option value="">Vendor&apos;s terms</option>
                {withCurrentTerms(termsChoices, terms).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="bill-due">Due Date (optional)</Label>
              <DateInput
                id="bill-due"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                {...fieldA11y('bill', 'due', fieldErrors)}
              />
              <FieldError formId="bill" name="due" errors={fieldErrors} />
              <p className="mt-1 text-xs text-navy/40">Leave blank to work it out from the terms.</p>
            </div>
          </div>

          {/* Foreign-currency vendor */}
          {selectedVendor?.currency && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-electric/20 bg-electric/5 p-3">
              <p className="text-xs text-navy/70">
                This vendor bills in <strong>{selectedVendor.currency}</strong>. Enter the amounts in{' '}
                {selectedVendor.currency}; the books record them in your home currency at the exchange rate.
              </p>
              <div>
                <Label htmlFor="bill-fx">Exchange rate (home per 1 {selectedVendor.currency})</Label>
                <Input
                  id="bill-fx"
                  inputMode="decimal"
                  placeholder="Use the rate from Currencies"
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className={prefs.company.classTrackingEnabled || classId ? 'grid grid-cols-2 gap-3' : ''}>
            <div>
              <Label htmlFor="bill-memo">Memo</Label>
              <Input id="bill-memo" placeholder="Optional note" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            {(prefs.company.classTrackingEnabled || classId) && (
              <div>
                <Label htmlFor="bill-class">Class (optional)</Label>
                <Select id="bill-class" value={classId} onChange={(e) => setClassId(e.target.value)}>
                  <option value="">No class</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="mb-0" required>Line Items</Label>
              <span className="flex items-center gap-3">
                <BarcodeScanInput onItem={addScannedItem} />
                <button
                  type="button"
                  onClick={() => addLine('expense')}
                  className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" /> Expense Line
                </button>
                <button
                  type="button"
                  onClick={() => addLine('item')}
                  className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" /> Item Line
                </button>
              </span>
            </div>

            <div className="space-y-2" onKeyDown={grid.onKeyDown}>
              {lines.map((line, idx) => (
                <div key={idx} data-grid-row className="space-y-1">
                <div className="flex gap-2 items-start">
                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
                    {(['expense', 'item'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => updateLine(idx, { mode: m })}
                        className={`px-2 py-2 text-[10px] font-semibold uppercase transition-colors ${
                          line.mode === m
                            ? 'bg-electric text-white'
                            : 'bg-white text-navy/50 hover:bg-slate-50'
                        }`}
                        title={m === 'expense' ? 'Expense (account) line' : 'Item line'}
                      >
                        {m === 'expense' ? 'Acct' : 'Item'}
                      </button>
                    ))}
                  </div>

                  {line.mode === 'item' ? (
                    <>
                      {/* Item */}
                      <div className="flex-1 min-w-0">
                        <TypeaheadSelect
                          aria-label={`Line ${idx + 1} item`}
                          placeholder="Item…"
                          value={line.itemId}
                          onChange={(id) => pickItem(idx, id)}
                          choices={itemChoices}
                          {...fieldA11y('bill', `line-${idx}-item`, fieldErrors)}
                        />
                      </div>

                      {/* Qty */}
                      <div className="w-16 shrink-0">
                        <AmountInput
                          placeholder="Qty"
                          aria-label={`Line ${idx + 1} quantity`}
                          {...fieldA11y('bill', `line-${idx}-qty`, fieldErrors)}
                          value={line.quantity}
                          onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        />
                      </div>

                      {/* Unit cost */}
                      <div className="w-24 shrink-0">
                        <AmountInput
                          placeholder="Cost"
                          aria-label={`Line ${idx + 1} cost each`}
                          {...fieldA11y('bill', `line-${idx}-cost`, fieldErrors)}
                          value={line.unitCost}
                          onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                        />
                      </div>

                      {/* Computed amount */}
                      <div className="w-20 shrink-0 pt-2 text-right text-xs font-semibold text-navy/70 tabular-nums">
                        {formatCurrency(lineAmount(line).toFixed(2))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Account */}
                      <div className="flex-1 min-w-0">
                        <TypeaheadSelect
                          aria-label={`Line ${idx + 1} account`}
                          placeholder="Account…"
                          value={line.accountId}
                          onChange={(id) => updateLine(idx, { accountId: id })}
                          choices={accountChoices}
                          {...fieldA11y('bill', `line-${idx}-account`, fieldErrors)}
                        />
                      </div>

                      {/* Description */}
                      <div className="flex-1 min-w-0">
                        <Input
                          placeholder="Description"
                          value={line.description}
                          onChange={(e) => updateLine(idx, { description: e.target.value })}
                        />
                      </div>

                      {/* Amount */}
                      <div className="w-24 shrink-0">
                        <AmountInput
                          placeholder="0.00"
                          aria-label={`Line ${idx + 1} amount`}
                          {...fieldA11y('bill', `line-${idx}-amount`, fieldErrors)}
                          value={line.amount}
                          onChange={(e) => updateLine(idx, { amount: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="mt-1 text-red-400 hover:text-red-600 disabled:opacity-20 disabled:pointer-events-none"
                    title="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {(prefs.company.classTrackingEnabled || line.classId || customers.length > 0 || line.customerId) && (
                  <div className="flex gap-2 pl-[4.5rem] pr-6">
                    {(prefs.company.classTrackingEnabled || line.classId) && (
                      <div className="flex-1 min-w-0">
                        <Select
                          aria-label={`Line ${idx + 1} class`}
                          value={line.classId}
                          onChange={(e) => updateLine(idx, { classId: e.target.value })}
                        >
                          <option value="">{classId ? 'Bill class' : 'No class'}</option>
                          {classes.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {(customers.length > 0 || line.customerId) && (
                      <div className="flex-1 min-w-0">
                        <Select
                          aria-label={`Line ${idx + 1} billable customer`}
                          value={line.customerId}
                          onChange={(e) => updateLine(idx, { customerId: e.target.value, jobId: '' })}
                        >
                          <option value="">Not billable</option>
                          {line.customerId && !customers.some((c) => c.id === line.customerId) && (
                            <option value={line.customerId}>(customer)</option>
                          )}
                          {customers.map((c) => (
                            <option key={c.id} value={c.id}>
                              Billable to {c.displayName}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                {line.mode === 'item' && (
                  <InventoryLineFields
                    adv={adv}
                    item={items.find((it) => it.id === line.itemId)}
                    quantity={line.quantity}
                    direction="in"
                    value={line.inv}
                    onChange={(inv) => updateLine(idx, { inv })}
                  />
                )}
                </div>
              ))}
            </div>
            {/* Line messages (each input points at its own message via aria-describedby). */}
            {Object.keys(fieldErrors)
              .filter((k) => k.startsWith('line-'))
              .map((k) => (
                <FieldError key={k} formId="bill" name={k} errors={fieldErrors} />
              ))}

            {/* Running total */}
            <div className="mt-3 flex justify-end">
              <span className="text-sm text-navy/50 mr-2">Total:</span>
              <span className="text-sm font-bold text-navy tabular-nums">
                {formatCurrency(runningTotal.toFixed(2))}
              </span>
            </div>
          </div>
          <AttachmentPanel entityType="bill" entityId={editingId} />
        </div>
      </Modal>

      {/* Void confirm */}
      <ConfirmDialog
        open={!!pendingVoid}
        title="Void bill?"
        message={`Void bill ${pendingVoid?.billNumber ? `#${pendingVoid.billNumber}` : `for ${pendingVoid ? vendorName(pendingVoid.vendorId) : ''}`} (${formatCurrency(pendingVoid?.total ?? '0')})? This reverses the posted entry and cannot be undone.`}
        confirmLabel="Void"
        tone="danger"
        loading={!!voidingId}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid.id)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}
