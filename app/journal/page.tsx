'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import {
  NotebookPen,
  Plus,
  Trash2,
  Pencil,
  Undo2,
  PlusCircle,
  MinusCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  DateInput,
  Input,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
  toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { TypeaheadSelect } from '@/components/TypeaheadSelect';
import type { TypeaheadChoice } from '@/lib/typeahead';
import { computeJournalBalance, journalPayloadAmount } from '@/lib/journalBalance';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { useNewParam } from '@/lib/useFocusParam';
import EntryDetailModal from '@/components/EntryDetailModal';
// wave2 prefs: Preferences-driven labels/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { classWarningApplies, confirmTransactionDate } from '@/lib/formPrefs';
import { formatAccountLabel } from '@/lib/preferences';
import { nextJournalNumber } from '@/lib/prefBehaviors';
import MemorizeButton from '@/components/MemorizeButton';
import AttachmentPanel from '@/components/AttachmentPanel';
import { activeOrSelected, otherNameLabel, type OtherNameEntry } from '@/lib/lists/otherNameOptions';
import { useErrorFixes } from '@/components/ErrorFixPanel';
import { FieldError, fieldA11y } from '@/components/FieldError';
import { applyFixPatch, balanceFixes, formLineUpdates, missingClassCheck, missingClassFixes, type ErrorFix } from '@/lib/errorFixes';
import { collectErrors, dateMessage, requiredMessage } from '@/lib/fieldValidation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JournalEntry {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  sourceRef?: string | null;
  isAdjusting?: boolean;
  createdAt: string;
  voidedAt: string | null;
}

interface EntryDetailLine {
  id: string;
  accountId: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  classId: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

interface EntryDetail {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  sourceRef: string | null;
  isAdjusting?: boolean;
  lines: EntryDetailLine[];
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string;
}

/** A customer / vendor / employee / Other Names entry for the QB "Name" column. value = "<kind>:<id>". */
interface NameOption {
  value: string;
  label: string;
  kind: 'customer' | 'vendor' | 'employee' | 'other';
  /** Inactive entries are offered only on the line that already uses them. */
  inactive?: boolean;
}

const NAME_GROUP_LABEL: Record<NameOption['kind'], string> = {
  customer: 'Customers',
  vendor: 'Vendors',
  employee: 'Employees',
  other: 'Other Names',
};

interface ClassOption {
  id: string;
  name: string;
}

interface LineRow {
  id: number; // client-side key only
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  classId: string;
  /** "<kind>:<id>" or '' (QB Name column). */
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** QB default reversing date: the 1st of the month after the entry date. */
function nextMonthFirstISO(entryDateISO: string): string {
  const d = new Date(entryDateISO);
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const mm = String(next.getMonth() + 1).padStart(2, '0');
  return `${next.getFullYear()}-${mm}-01`;
}

function statusTone(status: string): 'success' | 'void' | 'neutral' {
  if (status === 'posted') return 'success';
  if (status === 'void') return 'void';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Entry form modal (create + edit)
// ---------------------------------------------------------------------------

function emptyLine(id: number): LineRow {
  return { id, accountId: '', debit: '', credit: '', memo: '', classId: '', name: '' };
}

let lineCounter = 0;

/** Body sent to /api/journal-entries (fix patches address its paths). */
interface JournalPayload {
  date: string;
  description: string;
  reference: string | null;
  isAdjusting: boolean;
  lines: Array<{
    accountId: string;
    debit: string | undefined;
    credit: string | undefined;
    memo: string | null;
    classId: string | null;
    entityType: string | null;
    entityId: string | null;
  }>;
}

interface EntryFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accounts: Account[];
  classes: ClassOption[];
  names: NameOption[];
  /** When set, the modal edits this entry (prefilled) instead of creating a new one. */
  editEntry: EntryDetail | null;
}

/** Which kind of name a line's account requires (QB: A/R needs a customer, A/P a vendor). */
const NAME_HINT = { customer: 'Customer', vendor: 'Vendor', employee: 'Employee', other: 'Other name' } as const;

function requiredNameKind(acct: Account | undefined): 'customer' | 'vendor' | null {
  if (!acct) return null;
  if (acct.type === 'asset' && acct.subtype === 'accounts_receivable') return 'customer';
  if (acct.type === 'liability' && acct.subtype === 'accounts_payable') return 'vendor';
  return null;
}

function EntryFormModal({ open, onClose, onSaved, accounts, classes, names, editEntry }: EntryFormModalProps) {
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [lines, setLines] = useState<LineRow[]>(() => [
    emptyLine(++lineCounter),
    emptyLine(++lineCounter),
  ]);
  const [saving, setSaving] = useState(false);
  const prefs = usePreferences();
  const fixer = useErrorFixes<JournalPayload>();
  /** Fields the user has left (inline messages show after the first visit, not while typing). */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  const editing = !!editEntry;

  // Reset / prefill on open
  useEffect(() => {
    if (!open) return;
    if (editEntry) {
      setDate(editEntry.date.slice(0, 10));
      setDescription(editEntry.description);
      setReference(editEntry.reference ?? '');
      setIsAdjusting(!!editEntry.isAdjusting);
      setLines(
        editEntry.lines.map((l) => ({
          id: ++lineCounter,
          accountId: l.accountId,
          debit: l.debit ?? '',
          credit: l.credit ?? '',
          memo: l.memo ?? '',
          classId: l.classId ?? '',
          name: l.entityType && l.entityId ? `${l.entityType}:${l.entityId}` : '',
        })),
      );
    } else {
      setDate(todayISO());
      setDescription('');
      setReference('');
      // Preferences > Accounting 'Automatically number journal entries': next Entry No.
      if (prefs.company.autoAssignJeNumbers) {
        api
          .get<{ entries: { reference: string | null }[] }>('/api/journal-entries')
          .then((d) => setReference((r) => r || nextJournalNumber(d.entries.map((e) => e.reference))))
          .catch(() => {});
      }
      setIsAdjusting(false);
      setLines([emptyLine(++lineCounter), emptyLine(++lineCounter)]);
    }
    setSaving(false);
    setTouched({});
    fixer.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editEntry]);

  const updateLine = (id: number, field: keyof LineRow, value: string) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        // Entering debit clears credit and vice versa
        if (field === 'debit' && value) return { ...l, debit: value, credit: '' };
        if (field === 'credit' && value) return { ...l, credit: value, debit: '' };
        return { ...l, [field]: value };
      }),
    );
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine(++lineCounter)]);
  const removeLine = (id: number) =>
    setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.id !== id) : prev));

  // Find-as-you-type pickers for the line grid (type a name or account number, then Tab).
  const accountChoices: TypeaheadChoice[] = accounts
    .filter((a) => a.subtype !== 'non_posting')
    .map((a) => ({ id: a.id, label: formatAccountLabel(a, prefs.company), terms: [a.code, a.name] }));
  const classChoices: TypeaheadChoice[] = classes.map((c) => ({ id: c.id, label: c.name }));
  /** A/R lines list only customers and A/P lines only vendors (as the server requires). */
  /** Inactive names are offered only on the line that already uses them (gapsa). */
  const nameChoicesFor = (need: 'customer' | 'vendor' | null, selected?: string | null): TypeaheadChoice[] =>
    activeOrSelected(names, selected)
      .filter((n) => !need || n.kind === need)
      .map((n) => ({ id: n.value, label: n.label, hint: NAME_HINT[n.kind] }));

  // Line-grid keyboard ergonomics: Ctrl+Insert add / Ctrl+Delete remove / Enter down.
  const grid = useGridKeys({
    addRow: addLine,
    removeRow: (idx) => {
      const line = lines[idx];
      if (line) removeLine(line.id);
    },
    disabled: saving,
  });

  // Live, decimal-exact balance check (lib/journalBalance.ts). Save stays disabled until
  // debits equal credits, so an UNBALANCED error never reaches the user.
  const bal = computeJournalBalance(lines);
  const missingHeader = !date ? 'Enter a date.' : !description.trim() ? 'Enter a description.' : null;
  // QB rule: lines on Accounts Receivable need a customer, lines on Accounts Payable a vendor.
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const nameProblemIdx = lines.findIndex((l) => {
    const need = requiredNameKind(accountById.get(l.accountId));
    return need !== null && !l.name.startsWith(`${need}:`);
  });
  const nameBlocker =
    nameProblemIdx >= 0
      ? `Line ${nameProblemIdx + 1} uses ${
          requiredNameKind(accountById.get(lines[nameProblemIdx].accountId)) === 'customer'
            ? 'Accounts Receivable — pick the customer'
            : 'Accounts Payable — pick the vendor'
        } in the Name column.`
      : null;
  const blocker = missingHeader ?? nameBlocker ?? bal.blocker;
  const canSubmit = bal.canSave && !missingHeader && !nameBlocker;

  // Inline field messages (lib/fieldValidation.ts), shown once the field has been visited.
  const fieldErrors = collectErrors({
    date: touched.date ? dateMessage(date, 'Date') : null,
    description: touched.description
      ? requiredMessage(description, 'Enter a description so you can find this entry later.')
      : null,
  });

  // Fix-it for an out-of-balance entry, right where the difference shows: the same builder the
  // server uses (lib/errorFixes.ts), applied to the form's own lines.
  const formBalanceFixes: ErrorFix[] =
    !bal.balanced && bal.invalidLines.length === 0 && Number(bal.difference) !== 0 ? balanceFixes(lines) : [];
  const applyFormBalanceFix = (fix: ErrorFix) => {
    setLines((prev) => applyFixPatch({ lines: prev }, fix.patch).lines);
  };

  // Which form line each payload line came from (the payload skips lines without an account).
  const payloadLineIds = lines.filter((l) => l.accountId).map((l) => l.id);

  /** Copy a fix's changes (request-body paths) back onto the form. */
  const applyToForm = (patched: JournalPayload, fix: ErrorFix) => {
    if ((fix.patch ?? []).some((op) => op.path === 'date') && typeof patched.date === 'string') setDate(patched.date);
    const updates = formLineUpdates<JournalPayload['lines'][number], number>(fix, patched, 'lines', payloadLineIds);
    if (updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.key, u.line]));
    setLines((prev) =>
      prev.map((l) => {
        const pl = byId.get(l.id);
        return pl
          ? { ...l, accountId: pl.accountId, debit: pl.debit ?? '', credit: pl.credit ?? '', classId: pl.classId ?? '' }
          : l;
      }),
    );
  };

  /** Post / update. Throws on failure (the fix presenter shows it). */
  const send = async (payload: JournalPayload) => {
    setSaving(true);
    try {
      if (editing && editEntry) {
        await api.patch(`/api/journal-entries/${editEntry.id}`, payload);
        toast('Journal entry updated', 'success');
      } else {
        await api.post('/api/journal-entries', payload);
        toast('Journal entry posted', 'success');
      }
      fixer.clear();
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    setTouched({ date: true, description: true });
    if (!canSubmit) return;
    // Preferences: date range warning.
    if (!confirmTransactionDate(date, prefs)) return;
    const payload: JournalPayload = {
      date,
      description: description.trim(),
      reference: reference.trim() || null,
      isAdjusting,
      lines: lines
        .filter((l) => l.accountId)
        .map((l) => {
          const [entityType, entityId] = l.name ? l.name.split(':') : [null, null];
          return {
            accountId: l.accountId,
            // Send exactly what the Save gate validated ("1,250.00 " -> "1250.00").
            debit: journalPayloadAmount(l.debit),
            credit: journalPayloadAmount(l.credit),
            memo: l.memo.trim() || null,
            classId: l.classId || null,
            entityType: entityType || null,
            entityId: entityId || null,
          };
        }),
    };
    const ctx = { payload, resubmit: send, applyToForm, fallback: 'Failed to save entry.' };
    // Class tracking "warn when a line has no class" (lib/formPrefs.ts): offer fixes instead of a
    // yes/no box — use the class already on another line, or save without one.
    const classless = classWarningApplies(null, prefs) ? missingClassCheck(payload.lines, classes) : null;
    if (classless) {
      fixer.offer(
        { title: 'Some lines have no class', message: classless.message },
        missingClassFixes(classless),
        ctx,
      );
      return;
    }
    try {
      await send(payload);
    } catch (err: unknown) {
      fixer.report(err, ctx);
    }
  };

  const diffIsZero = Number(bal.difference) === 0;

  const gridCols = 'grid-cols-[1fr_130px_110px_120px_92px_92px_28px]';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Edit Journal Entry #${editEntry?.entryNumber}` : 'New Journal Entry'}
      footer={
        <>
          <MemorizeButton
            docType="journal_entry"
            shortcut={open}
            defaultName={description.trim() || undefined}
            getTemplate={() => {
              if (!bal.canSave) return 'Balance the entry (debits = credits) before memorizing.';
              if (!description.trim()) return 'Enter a description before memorizing.';
              return {
                date,
                description: description.trim(),
                reference: reference.trim() || null,
                lines: lines
                  .filter((l) => l.accountId)
                  .map((l) => ({
                    accountId: l.accountId,
                    debit: journalPayloadAmount(l.debit),
                    credit: journalPayloadAmount(l.credit),
                    memo: l.memo.trim() || null,
                    classId: l.classId || null,
                  })),
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={saving}
            aria-describedby={blocker ? 'je-save-blocker' : undefined}
            title={blocker ?? undefined}
          >
            {editing ? 'Save Changes' : 'Post Entry'}
          </Button>
        </>
      }
    >
      {fixer.panel}
      {editing && (
        <p className="mb-4 rounded-lg bg-gold/10 border border-gold/30 px-3 py-2 text-xs text-navy/80">
          Saving voids the original entry and posts a corrected one; the audit trail keeps both
          versions.
        </p>
      )}

      {/* Header fields */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div>
          <Label htmlFor="je-date" required>Date</Label>
          <DateInput
            id="je-date"
            autoFocus
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onBlur={() => touch('date')}
            aria-required="true"
            {...fieldA11y('je', 'date', fieldErrors)}
          />
          <FieldError formId="je" name="date" errors={fieldErrors} />
        </div>
        <div>
          <Label htmlFor="je-ref">Reference (optional)</Label>
          <Input
            id="je-ref"
            placeholder="e.g. JE-001"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <Label htmlFor="je-desc" required>Description</Label>
          <Input
            id="je-desc"
            placeholder="Memo / narration"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => touch('description')}
            aria-required="true"
            {...fieldA11y('je', 'description', fieldErrors)}
          />
          <FieldError formId="je" name="description" errors={fieldErrors} />
        </div>
        <label className="col-span-2 inline-flex items-center gap-2 text-sm text-navy/80">
          <input
            type="checkbox"
            checked={isAdjusting}
            onChange={(e) => setIsAdjusting(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Adjusting entry <Help term="adjusting-entry" side="bottom" />
          <span className="text-xs text-navy/50">(year-end or accountant adjustment)</span>
        </label>
      </div>

      <p className="mb-4 flex items-start gap-1.5 rounded-lg bg-electric/5 px-3 py-2 text-xs text-navy/70">
        <span>
          Each line moves money into or out of an account. Put the amount in <strong>Debit</strong> or{' '}
          <strong>Credit</strong> &mdash; the totals must match before you can save.
        </span>
        <Help term="debit-credit" side="bottom" />
      </p>

      {/* Line items */}
      <div className="mb-3">
        <div className={`grid ${gridCols} gap-2 mb-1 px-1`}>
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Account</span>
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide inline-flex items-center gap-1">
            Name <Help term="name-on-journal-line" side="bottom" />
          </span>
          {/* Class fields are hidden while "Use class tracking" is off (QB); a saved class still shows. */}
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide inline-flex items-center gap-1">
            {prefs.company.classTrackingEnabled && (
              <>
                Class <Help term="class" side="bottom" />
              </>
            )}
          </span>
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Memo</span>
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide text-right">Debit</span>
          <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide text-right">Credit</span>
          <span />
        </div>

        <div className="flex flex-col gap-2" onKeyDown={grid.onKeyDown}>
          {lines.map((line, idx) => (
            <div key={line.id} data-grid-row className={`grid ${gridCols} gap-2 items-center`}>
              <TypeaheadSelect
                aria-label={`Line ${idx + 1} account`}
                placeholder="— Select account —"
                value={line.accountId}
                onChange={(id) => updateLine(line.id, 'accountId', id)}
                choices={accountChoices}
              />

              <TypeaheadSelect
                aria-label={`Line ${idx + 1} name`}
                aria-invalid={nameProblemIdx === idx || undefined}
                placeholder={
                  requiredNameKind(accountById.get(line.accountId)) === 'customer'
                    ? '— Pick customer —'
                    : requiredNameKind(accountById.get(line.accountId)) === 'vendor'
                      ? '— Pick vendor —'
                      : '— No name —'
                }
                value={line.name}
                onChange={(id) => updateLine(line.id, 'name', id)}
                choices={nameChoicesFor(requiredNameKind(accountById.get(line.accountId)), line.name)}
              />

              {prefs.company.classTrackingEnabled || line.classId ? (
                <TypeaheadSelect
                  aria-label={`Line ${idx + 1} class`}
                  placeholder="— No class —"
                  value={line.classId}
                  onChange={(id) => updateLine(line.id, 'classId', id)}
                  choices={classChoices}
                />
              ) : (
                <span />
              )}

              <Input
                aria-label={`Line ${idx + 1} memo`}
                placeholder="Line memo"
                value={line.memo}
                onChange={(e) => updateLine(line.id, 'memo', e.target.value)}
              />

              <AmountInput
                aria-label={`Line ${idx + 1} debit`}
                aria-invalid={bal.invalidLines.includes(idx + 1) || undefined}
                placeholder="0.00"
                value={line.debit}
                onChange={(e) => updateLine(line.id, 'debit', e.target.value)}
                className="text-right"
              />

              <AmountInput
                aria-label={`Line ${idx + 1} credit`}
                aria-invalid={bal.invalidLines.includes(idx + 1) || undefined}
                placeholder="0.00"
                value={line.credit}
                onChange={(e) => updateLine(line.id, 'credit', e.target.value)}
                className="text-right"
              />

              <button
                type="button"
                onClick={() => removeLine(line.id)}
                disabled={lines.length <= 2}
                className="text-red-400 hover:text-red-600 disabled:opacity-20 transition-colors"
                title="Remove line"
                aria-label={`Remove line ${idx + 1}`}
              >
                <MinusCircle className="h-5 w-5" />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addLine}
          className="mt-3 flex items-center gap-1.5 text-electric text-sm font-medium hover:text-electric/80 transition-colors"
        >
          <PlusCircle className="h-4 w-4" /> Add line
        </button>
      </div>

      {/* Totals + balance indicator */}
      <div className="border-t border-slate-100 pt-4 mt-2">
        <div className={`grid ${gridCols} gap-2 items-center`}>
          <span className="text-sm font-bold text-navy text-right">Totals</span>
          <span />
          <span />
          <span />
          <span className="text-sm font-bold text-navy text-right tabular-nums">
            {formatCurrency(bal.totalDebits)}
          </span>
          <span className="text-sm font-bold text-navy text-right tabular-nums">
            {formatCurrency(bal.totalCredits)}
          </span>
          <span />
        </div>
        {/* Live difference indicator, announced politely as amounts change. */}
        <div className="mt-3 flex flex-col items-end gap-1" aria-live="polite">
          {bal.balanced ? (
            <span className="flex items-center gap-1 text-emerald text-sm font-semibold">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Balanced &mdash; debits equal credits
            </span>
          ) : (
            <span
              className={`flex items-center gap-1 text-sm font-semibold ${
                diffIsZero ? 'text-navy/50' : 'text-red-500'
              }`}
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              Difference: <span className="tabular-nums">{formatCurrency(bal.difference)}</span>
            </span>
          )}
          {blocker && (
            <p id="je-save-blocker" className="text-xs text-navy/60 text-right max-w-md">
              {blocker}
            </p>
          )}
          {blocker === bal.blocker && formBalanceFixes.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2" role="group" aria-label="Ways to balance this entry">
              {formBalanceFixes.map((fix) => (
                <Button key={fix.id} type="button" size="sm" variant="secondary" onClick={() => applyFormBalanceFix(fix)}>
                  Fix: {fix.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
      {open && <AttachmentPanel className="mt-4" entityType="journal_entry" entityId={editEntry?.id} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reverse modal — one-click reversing entry (QB "Reverse" button)
// ---------------------------------------------------------------------------

interface ReverseModalProps {
  entry: JournalEntry | null;
  onClose: () => void;
  onReversed: () => void;
}

function ReverseModal({ entry, onClose, onReversed }: ReverseModalProps) {
  const [asOfDate, setAsOfDate] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (entry) {
      setAsOfDate(nextMonthFirstISO(entry.date));
      setLoading(false);
    }
  }, [entry]);

  const handleReverse = async () => {
    if (!entry || !asOfDate) return;
    setLoading(true);
    try {
      const data = await api.post<{ entry: JournalEntry }>(
        `/api/journal-entries/${entry.id}/reverse`,
        { asOfDate },
      );
      toast(`Reversing entry #${data.entry.entryNumber} posted`, 'success');
      onReversed();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to reverse entry.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={!!entry}
      onClose={onClose}
      title="Reverse Journal Entry"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleReverse} disabled={!asOfDate} loading={loading}>
            Post Reversing Entry
          </Button>
        </>
      }
    >
      <p className="text-navy/80 text-sm mb-4">
        Post the opposite of <span className="font-semibold">#{entry?.entryNumber}</span> — &ldquo;
        {entry?.description}&rdquo; (debits and credits swapped). The original entry stays posted;
        the reversal is referenced <span className="font-mono text-xs">REV of #{entry?.entryNumber}</span>.
      </p>
      <div>
        <Label htmlFor="rev-date">Reversal date</Label>
        <DateInput
          id="rev-date"
          value={asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)}
        />
        <p className="text-xs text-navy/40 mt-1">Defaults to the 1st of the next month.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function JournalPageContent() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [names, setNames] = useState<NameOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<EntryDetail | null>(null);
  const [voidTarget, setVoidTarget] = useState<JournalEntry | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const data = await api.get<{ entries: JournalEntry[] }>('/api/journal-entries');
      setEntries(data.entries);
    } catch (err: unknown) {
      toastError(err, 'Failed to load journal entries.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await api.get<Account[]>('/api/accounts');
      setAccounts(data);
    } catch {
      // non-fatal — modal will show empty account list
    }
  }, []);

  const fetchClasses = useCallback(async () => {
    try {
      const data = await api.get<ClassOption[]>('/api/classes');
      setClasses(data);
    } catch {
      // non-fatal — class column will show no options
    }
  }, []);

  // Names for the QB "Name" column. Each list is optional (permissions may hide one).
  const fetchNames = useCallback(async () => {
    const [cust, vend, emp, other] = await Promise.all([
      api.get<Array<{ id: string; displayName: string }>>('/api/customers').catch(() => []),
      api.get<Array<{ id: string; displayName: string }>>('/api/vendors').catch(() => []),
      api.get<Array<{ id: string; firstName: string; lastName: string }>>('/api/employees').catch(() => []),
      // QB "Other Names" (payees that are not customers, vendors or employees).
      api
        .get<{ entries: OtherNameEntry[] }>('/api/lists/other-names?includeInactive=true')
        .then((d) => d.entries)
        .catch(() => []),
    ]);
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    setNames([
      ...list(cust).map((c) => ({ value: `customer:${c.id}`, label: c.displayName, kind: 'customer' as const })),
      ...list(vend).map((v) => ({ value: `vendor:${v.id}`, label: v.displayName, kind: 'vendor' as const })),
      ...list(emp).map((e) => ({
        value: `employee:${e.id}`,
        label: `${e.firstName} ${e.lastName}`.trim(),
        kind: 'employee' as const,
      })),
      ...list(other).map((o: OtherNameEntry) => ({
        value: `other:${o.id}`,
        label: otherNameLabel(o),
        kind: 'other' as const,
        inactive: o.isActive === false,
      })),
    ]);
  }, []);

  useEffect(() => {
    fetchEntries();
    fetchAccounts();
    fetchClasses();
    fetchNames();
  }, [fetchEntries, fetchAccounts, fetchClasses, fetchNames]);

  // Quick Actions navigate here with ?new=1 — open the create modal.
  useNewParam(() => {
    setEditTarget(null);
    setShowForm(true);
  });

  const openEdit = async (entry: JournalEntry) => {
    try {
      const data = await api.get<{ entry: EntryDetail }>(`/api/journal-entries/${entry.id}`);
      if (data.entry.sourceRef && data.entry.sourceRef !== 'manual') {
        toast('This entry was posted by a source document — edit the document instead.', 'danger');
        return;
      }
      setEditTarget(data.entry);
      setShowForm(true);
    } catch (err: unknown) {
      toastError(err, 'Failed to load entry.');
    }
  };

  const handleVoid = async () => {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/journal-entries/${voidTarget.id}`);
      toast('Entry voided', 'success');
      setVoidTarget(null);
      fetchEntries();
    } catch (err: unknown) {
      toastError(err, 'Failed to void entry.');
    } finally {
      setVoiding(false);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Journal Entries"
        icon={NotebookPen}
        action={
          <Button
            onClick={() => {
              setEditTarget(null);
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4" /> New Journal Entry
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={NotebookPen}
            title="No journal entries yet"
            message="Journal entries are for adjustments and corrections. For everyday work, use Create Invoices, Enter Bills or Write Checks; they make the entries for you."
            action={
              <Button
                onClick={() => {
                  setEditTarget(null);
                  setShowForm(true);
                }}
              >
                <Plus className="h-4 w-4" /> New Journal Entry
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Tr
                  key={entry.id}
                  onClick={() => setDetailId(entry.id)}
                  className="cursor-pointer"
                  title="View entry detail"
                >
                  <Td className="font-mono text-xs text-navy/60">{entry.entryNumber}</Td>
                  <Td className="whitespace-nowrap">{formatDate(entry.date)}</Td>
                  <Td className="max-w-xs truncate" title={entry.description}>
                    {entry.description}
                    {entry.isAdjusting && (
                      <Badge tone="info" className="ml-2">
                        Adjusting
                      </Badge>
                    )}
                  </Td>
                  <Td className="text-navy/50 text-xs">{entry.reference ?? '—'}</Td>
                  <Td>
                    <Badge tone={statusTone(entry.status)}>
                      {entry.status === 'void'
                        ? 'Voided'
                        : entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    {entry.status === 'posted' && (
                      <span className="inline-flex items-center gap-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(entry);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-electric hover:text-electric/80 font-medium transition-colors"
                          title="Edit this entry"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReverseTarget(entry);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-gold hover:text-gold/80 font-semibold transition-colors"
                          title="Post a reversing entry (debits/credits swapped)"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          Reverse
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setVoidTarget(entry);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
                          title="Void this entry"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Void
                        </button>
                      </span>
                    )}
                    {entry.status === 'void' && (
                      <span className="text-xs text-navy/30 italic">Voided</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <EntryFormModal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditTarget(null);
        }}
        onSaved={fetchEntries}
        accounts={accounts}
        classes={classes}
        names={names}
        editEntry={editTarget}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void Journal Entry"
        message={
          <>
            Are you sure you want to void{' '}
            <span className="font-semibold">#{voidTarget?.entryNumber}</span> — &ldquo;
            {voidTarget?.description}&rdquo;? This will reverse all balance impacts and cannot be
            undone.
          </>
        }
        confirmLabel="Void Entry"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />

      <ReverseModal
        entry={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onReversed={fetchEntries}
      />

      <EntryDetailModal entryId={detailId} onClose={() => setDetailId(null)} />
    </main>
  );
}

export default function JournalPage() {
  return (
    <Suspense fallback={null}>
      <JournalPageContent />
    </Suspense>
  );
}
