'use client';
/**
 * <AttentionInbox /> — the "Needs attention" list (team home): one prioritized list, most urgent
 * first, of what the signed-in person can act on (lib/services/attention.ts). Each item is fixed
 * in one click without leaving the list where that is possible:
 *  - bank lines: pick what it was for (the suggestion is preselected) and Save
 *  - overdue invoices: email a payment reminder (or copy it / open it in your own email program
 *    when email isn't set up on this computer)
 *  - to-dos: Done; backup: Back up now
 *  - bills / reconcile / payroll taxes / deposits / possible mistakes: open the right screen with
 *    the record already picked
 * Every item can be snoozed (tomorrow / next week) or dismissed, per person.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  FileText,
  HardDrive,
  Landmark,
  ListChecks,
  Mail,
  MoreHorizontal,
  PartyPopper,
  PiggyBank,
  Receipt,
  Scale,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import { Badge, Button, Card, Input, Label, Select, Spinner, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import {
  ATTENTION_CHANGED_EVENT,
  ATTENTION_KIND_LABELS,
  ATTENTION_KINDS,
  attentionAmountCurrency,
  type AttentionKind,
} from '@/lib/attentionKinds';
import { nextMenuIndex } from '@/lib/menuKeys';
import type { AttentionItem, AttentionResult } from '@/lib/services/attention';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<AttentionKind, React.ComponentType<{ className?: string }>> = {
  bank_txn: ListChecks,
  overdue_invoice: FileText,
  bill_due: Receipt,
  ai_error: ShieldAlert,
  reconcile: Scale,
  payroll_tax: Landmark,
  todo: ClipboardCheck,
  backup: HardDrive,
  undeposited: PiggyBank,
};

const SEVERITY: Record<AttentionItem['severity'], { label: string; tone: 'danger' | 'warning' | 'neutral'; bar: string }> = {
  urgent: { label: 'Urgent', tone: 'danger', bar: 'bg-red-500' },
  due: { label: 'Due now', tone: 'warning', bar: 'bg-gold' },
  upcoming: { label: 'Coming up', tone: 'neutral', bar: 'bg-slate-300' },
};

function notifyChanged() {
  try {
    window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
  } catch {
    /* no window (tests) */
  }
}

export default function AttentionInbox({ initial }: { initial?: AttentionResult | null }) {
  const [data, setData] = useState<AttentionResult | null>(initial ?? null);
  const [filter, setFilter] = useState<AttentionKind | 'all'>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [hidden, setHidden] = useState<AttentionItem[] | null>(null);
  // Items just handled: faded out right away, then dropped by the refresh.
  const [gone, setGone] = useState<Set<string>>(new Set());

  const refresh = useCallback(async (withHidden = showHidden) => {
    try {
      const r = await api.get<AttentionResult>(`/api/attention${withHidden ? '?hidden=1' : ''}`);
      setData(r);
      setHidden(r.hidden ?? null);
      setGone(new Set());
    } catch (err) {
      toastError(err, 'Could not load what needs attention.');
    }
  }, [showHidden]);

  useEffect(() => {
    if (!initial) refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** An item was handled: hide it now, refresh the list and the sidebar badge. */
  const done = useCallback(
    (key: string, message?: string) => {
      setGone((prev) => new Set(prev).add(key));
      if (message) toast(message, 'success');
      notifyChanged();
      refresh();
    },
    [refresh],
  );

  async function changeState(it: AttentionItem, action: 'snooze' | 'dismiss' | 'restore', days?: 1 | 7) {
    try {
      await api.post('/api/attention/state', { key: it.key, action, days });
      if (action === 'restore') {
        toast('Back in your list.', 'success');
        notifyChanged();
        refresh();
      } else {
        done(it.key, action === 'dismiss' ? 'Dismissed. It will not come back unless something changes.' : days === 7 ? 'Snoozed until next week.' : 'Snoozed until tomorrow.');
      }
    } catch (err) {
      toastError(err, 'Could not update that item.');
    }
  }

  const visible = useMemo(
    () => (data?.items ?? []).filter((i) => !gone.has(i.key) && (filter === 'all' || i.kind === filter)),
    [data, gone, filter],
  );

  if (!data) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Loading">
        <Spinner className="text-electric" />
      </div>
    );
  }

  const remaining = Math.max(data.total - gone.size, 0);
  const kindsWithItems = ATTENTION_KINDS.filter((k) => data.counts[k] > 0);

  return (
    <div className="max-w-4xl">
      <p className="mb-4 text-sm text-navy/60" aria-live="polite">
        {remaining === 0
          ? 'Nothing is waiting on you right now.'
          : `${remaining} ${remaining === 1 ? 'thing needs' : 'things need'} your attention, most urgent first.`}
      </p>

      {kindsWithItems.length > 1 && (
        <div role="group" aria-label="Show only" className="mb-4 flex flex-wrap gap-2">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="Everything" count={remaining} />
          {kindsWithItems.map((k) => (
            <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)} label={ATTENTION_KIND_LABELS[k]} count={data.counts[k]} />
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        filter === 'all' ? (
          <AllCaughtUp />
        ) : (
          <Card className="p-6 text-sm text-navy/60">
            Nothing left here.{' '}
            <button type="button" className="font-semibold text-electric hover:underline" onClick={() => setFilter('all')}>
              Show everything
            </button>
          </Card>
        )
      ) : (
        <ul aria-label="Needs attention" className="space-y-3">
          {visible.map((it) => (
            <li key={it.key}>
              <InboxItem item={it} data={data} onDone={done} onState={changeState} />
            </li>
          ))}
        </ul>
      )}

      {filter !== 'all' || data.items.length >= data.total ? null : (
        <p className="mt-3 text-xs text-navy/50">
          Showing the first {data.items.length}. Handle a few and the rest move up, or open the full screens from each item.
        </p>
      )}

      {data.hiddenCount > 0 && (
        <div className="mt-6">
          <button
            type="button"
            aria-expanded={showHidden}
            className="text-sm font-semibold text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
            onClick={() => {
              const next = !showHidden;
              setShowHidden(next);
              if (next) refresh(true);
            }}
          >
            {showHidden ? 'Hide' : 'Show'} snoozed and dismissed ({data.hiddenCount})
          </button>
          {showHidden && (
            <ul aria-label="Snoozed and dismissed" className="mt-3 space-y-2">
              {(hidden ?? []).map((it) => (
                <li key={it.key}>
                  <Card className="flex flex-wrap items-center justify-between gap-3 p-3 opacity-80">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-navy">{it.title}</div>
                      <div className="text-xs text-navy/50">
                        {it.hidden?.dismissed
                          ? 'Dismissed'
                          : it.hidden?.snoozedUntil
                            ? `Snoozed until ${new Date(it.hidden.snoozedUntil).toLocaleString()}`
                            : 'Hidden'}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => changeState(it, 'restore')} aria-label={`Bring back: ${it.title}`}>
                      <Undo2 className="h-4 w-4" aria-hidden="true" /> Bring back
                    </Button>
                  </Card>
                </li>
              ))}
              {hidden === null && (
                <li className="text-sm text-navy/50">
                  <Spinner className="inline h-4 w-4" /> Loading…
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50',
        active ? 'border-electric bg-electric text-white' : 'border-slate-200 bg-white text-navy/70 hover:border-electric/50 hover:text-electric',
      )}
    >
      {label} <span className={active ? 'text-white/80' : 'text-navy/40'}>{count}</span>
    </button>
  );
}

function AllCaughtUp() {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald/15 text-emerald">
        <PartyPopper className="h-8 w-8" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-extrabold text-navy">All caught up!</h2>
      <p className="mt-2 max-w-md text-sm text-navy/60">
        Nothing needs your attention right now: no overdue invoices, no bills about to be late, and your
        bank transactions are sorted. Nice work. New things will show up here as they come due.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

function InboxItem({
  item: it,
  data,
  onDone,
  onState,
}: {
  item: AttentionItem;
  data: AttentionResult;
  onDone: (key: string, message?: string) => void;
  onState: (it: AttentionItem, action: 'snooze' | 'dismiss', days?: 1 | 7) => void;
}) {
  const Icon = KIND_ICON[it.kind];
  const sev = SEVERITY[it.severity];
  const [open, setOpen] = useState(false); // inline action panel
  const [busy, setBusy] = useState(false);
  const titleId = `att-${it.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  let primary: React.ReactNode;
  switch (it.action.type) {
    case 'categorize':
      primary = (
        <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${titleId}-panel`}>
          Sort it
        </Button>
      );
      break;
    case 'email_reminder':
      primary = (
        <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${titleId}-panel`}>
          <Mail className="h-4 w-4" aria-hidden="true" /> Send reminder
        </Button>
      );
      break;
    case 'mark_done':
      primary = (
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            run(async () => {
              try {
                await api.patch(`/api/todos/${it.data.todoId}`, { done: true });
                onDone(it.key, 'To-do marked done.');
              } catch (err) {
                toastError(err, 'Could not mark the to-do done.');
              }
            })
          }
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Done
        </Button>
      );
      break;
    case 'backup_now':
      primary = (
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            run(async () => {
              try {
                const r = await api.post<{ filename: string; folder: string }>('/api/attention/backup');
                onDone(it.key, `Backed up. Saved ${r.filename} in ${r.folder}.`);
              } catch (err) {
                toastError(err, 'Could not back up.');
              }
            })
          }
        >
          <HardDrive className="h-4 w-4" aria-hidden="true" /> Back up now
        </Button>
      );
      break;
    case 'open':
      primary = (
        <Link
          href={it.action.href}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-electric px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-electric/90 outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1"
        >
          {it.action.label}
        </Link>
      );
      break;
  }

  return (
    <Card className="relative overflow-hidden" aria-labelledby={titleId} role="article">
      <span className={cn('absolute inset-y-0 left-0 w-1', sev.bar)} aria-hidden="true" />
      <div className="flex flex-wrap items-start gap-3 p-4 pl-5">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-electric/10 text-electric">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="text-sm font-semibold text-navy">
              {it.title}
            </h3>
            <Badge tone={sev.tone}>{sev.label}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-navy/60">{it.detail}</p>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-navy/30">{ATTENTION_KIND_LABELS[it.kind]}</p>
        </div>
        {it.amount && (
          <div className="shrink-0 text-right text-base font-semibold tabular-nums text-navy">
            {formatCurrency(it.amount, attentionAmountCurrency(it.data, data.homeCurrency ?? 'USD'))}
          </div>
        )}
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {primary}
          {it.action.type !== 'open' && (
            <Link href={it.href} className="text-sm font-semibold text-electric hover:underline rounded outline-none focus-visible:ring-2 focus-visible:ring-electric/50 px-1">
              Open
            </Link>
          )}
          <LaterMenu title={it.title} onSnooze={(d) => onState(it, 'snooze', d)} onDismiss={() => onState(it, 'dismiss')} />
        </div>
      </div>
      {open && it.action.type === 'categorize' && (
        <div id={`${titleId}-panel`} className="border-t border-slate-100 bg-slate-50/60 px-5 py-4">
          <CategorizePanel item={it} options={data.accountOptions} onDone={onDone} onCancel={() => setOpen(false)} />
        </div>
      )}
      {open && it.action.type === 'email_reminder' && (
        <div id={`${titleId}-panel`} className="border-t border-slate-100 bg-slate-50/60 px-5 py-4">
          <ReminderPanel item={it} emailConfigured={data.emailConfigured} onDone={onDone} onCancel={() => setOpen(false)} />
        </div>
      )}
    </Card>
  );
}

/**
 * Snooze (tomorrow / next week) and Dismiss, tucked behind one "Later" button. A real menu button
 * (WAI-ARIA): opening it moves focus to the first item, Up / Down / Home / End move between items,
 * Escape closes it and returns focus to the button, Tab closes it and moves on.
 */
function LaterMenu({ title, onSnooze, onDismiss }: { title: string; onSnooze: (days: 1 | 7) => void; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  // Which item to focus when the menu opens (Up arrow on the button opens at the last one).
  const [startAt, setStartAt] = useState<'first' | 'last'>('first');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const choices: Array<{ label: string; danger?: boolean; run: () => void }> = [
    { label: 'Remind me tomorrow', run: () => onSnooze(1) },
    { label: 'Remind me next week', run: () => onSnooze(7) },
    { label: 'Dismiss', danger: true, run: onDismiss },
  ];

  useEffect(() => {
    if (!open) return;
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    (startAt === 'last' ? items[items.length - 1] : items[0])?.focus();
  }, [open, startAt]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  function openAt(at: 'first' | 'last') {
    setStartAt(at);
    setOpen(true);
  }

  function onButtonKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  }

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const next = nextMenuIndex(e.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    }
  }

  const item = 'block w-full px-3 py-2 text-left text-sm text-navy hover:bg-electric/5 outline-none focus-visible:bg-electric/10 focus:bg-electric/10';
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Later or dismiss: ${title}`}
        title="Snooze or dismiss"
        onClick={() => (open ? setOpen(false) : openAt('first'))}
        onKeyDown={onButtonKey}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-navy/70 hover:bg-slate-50 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
      >
        Later <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Later or dismiss: ${title}`}
          onKeyDown={onMenuKey}
          className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-slate-100 bg-white py-1 shadow-xl"
        >
          {choices.map((c, i) => (
            <button
              key={c.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={c.danger ? cn(item, 'text-red-600') : item}
              onClick={() => {
                close(true);
                c.run();
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "What was it for?" — pick the account (suggestion preselected) and save to the books. */
function CategorizePanel({
  item: it,
  options,
  onDone,
  onCancel,
}: {
  item: AttentionItem;
  options: AttentionResult['accountOptions'];
  onDone: (key: string, message?: string) => void;
  onCancel: () => void;
}) {
  const suggested = (it.data.suggestedAccountId as string | null) ?? '';
  const [accountId, setAccountId] = useState(suggested);
  const [saving, setSaving] = useState(false);
  const choices = options.filter((a) => a.id !== it.data.bankGlAccountId);
  const suggestion = choices.find((a) => a.id === suggested);
  const selectId = `cat-${it.data.bankTransactionId as string}`;

  async function save(id: string) {
    if (!id) {
      toast('Choose what the money was for first.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/bank-transactions/categorize', { bankTransactionId: it.data.bankTransactionId, accountId: id });
      const name = choices.find((a) => a.id === id)?.name ?? 'that account';
      onDone(it.key, `Saved to ${name}.`);
    } catch (err) {
      toastError(err, 'Could not save the transaction.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      {suggestion && (
        <div className="w-full text-sm text-navy/70">
          Suggested: <span className="font-semibold text-navy">{suggestion.name}</span>
          <span className="text-navy/40">
            {' '}
            ({it.data.suggestionSource === 'rule' ? 'from your bank rules' : 'what you chose last time for this payee'})
          </span>
        </div>
      )}
      <div className="min-w-[240px] flex-1">
        <Label htmlFor={selectId}>What was it for?</Label>
        <Select id={selectId} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Choose an account…</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </Select>
      </div>
      {suggestion && accountId === suggested ? (
        <Button size="sm" loading={saving} onClick={() => save(suggested)}>
          Accept suggestion
        </Button>
      ) : (
        <Button size="sm" loading={saving} onClick={() => save(accountId)}>
          Save
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Payment reminder: email it, or (no email set up) copy it / open it in your own email program. */
function ReminderPanel({
  item: it,
  emailConfigured,
  onDone,
  onCancel,
}: {
  item: AttentionItem;
  emailConfigured: boolean;
  onDone: (key: string, message?: string) => void;
  onCancel: () => void;
}) {
  const reminder = it.data.reminder as { subject: string; body: string } | null;
  const [to, setTo] = useState((it.data.customerEmail as string | null) ?? '');
  const [sending, setSending] = useState(false);
  const toId = `to-${it.data.invoiceId as string}`;
  const mailto = reminder
    ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(reminder.subject)}&body=${encodeURIComponent(reminder.body)}`
    : null;

  async function send() {
    setSending(true);
    try {
      const r = await api.post<{ to: string }>('/api/attention/invoice-reminder', { invoiceId: it.data.invoiceId, to: to.trim() || undefined });
      // Sent: snooze it for a week so the customer has time to pay.
      await api.post('/api/attention/state', { key: it.key, action: 'snooze', days: 7 }).catch(() => undefined);
      onDone(it.key, `Reminder sent to ${r.to}. We'll show this invoice again in a week if it's still unpaid.`);
    } catch (err) {
      toastError(err, 'Could not send the reminder.');
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if (!reminder) return;
    try {
      await navigator.clipboard.writeText(`${reminder.subject}\n\n${reminder.body}`);
      toast('Reminder copied. Paste it into an email to the customer.', 'success');
    } catch {
      toast('Could not copy. Select the text below and copy it instead.', 'danger');
    }
  }

  return (
    <div className="space-y-3">
      {!emailConfigured && (
        <div className="rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm text-navy/80" role="note">
          <strong className="font-semibold">Email isn&apos;t set up on this computer yet.</strong> You can still send
          this reminder from your own email program, or copy it. To send straight from Ironbooks, whoever
          installed it adds the outgoing mail (SMTP) settings: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and
          SMTP_FROM. See{' '}
          <Link href="/privacy" className="font-semibold text-electric hover:underline">
            Privacy &amp; Network
          </Link>{' '}
          for which internet services Ironbooks may use.
        </div>
      )}
      <div className="max-w-sm">
        <Label htmlFor={toId}>Send to</Label>
        <Input id={toId} type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" />
      </div>
      {reminder && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-navy/70">Preview the reminder</summary>
          <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
            <div className="font-semibold text-navy">{reminder.subject}</div>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-navy/70">{reminder.body}</pre>
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {emailConfigured ? (
          <Button size="sm" loading={sending} onClick={send} disabled={!to.trim()}>
            <Mail className="h-4 w-4" aria-hidden="true" /> Email reminder with invoice attached
          </Button>
        ) : (
          mailto && (
            <a
              href={mailto}
              className="inline-flex items-center gap-2 rounded-lg bg-electric px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-electric/90 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
            >
              <Mail className="h-4 w-4" aria-hidden="true" /> Open in my email program
            </a>
          )
        )}
        <Button size="sm" variant="secondary" onClick={copy}>
          <Copy className="h-4 w-4" aria-hidden="true" /> Copy reminder
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
