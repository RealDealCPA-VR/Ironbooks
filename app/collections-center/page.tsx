'use client';
/**
 * Collections Center (wave2 sales C9) — who owes you money that is late (or about to be), with
 * their contact details, the invoices involved, and a running log of collection notes with a
 * follow-up date. Actions (salesar C9): log a call / visit / note (optionally on the To Do list
 * and the customer's Notes), email the overdue invoices or a statement through the app's email,
 * print a collection letter, and Receive Payment per invoice; "last contacted" shows on each card.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PhoneCall } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DateInput,
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
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { receivePaymentHref } from '@/app/payments/deepLink';

/** How a contact was made (lib/services/collections.ts CONTACT_METHODS). */
const METHODS: Array<{ value: string; label: string }> = [
  { value: 'call', label: 'Phone call' },
  { value: 'email', label: 'Email' },
  { value: 'letter', label: 'Letter' },
  { value: 'visit', label: 'Visit' },
  { value: 'other', label: 'Other contact' },
];
const METHOD_LABEL: Record<string, string> = {
  call: 'phone call',
  email: 'email',
  letter: 'letter',
  statement: 'statement',
  visit: 'visit',
  other: 'other contact',
};

/** The built-in collection letters (lib/services/letters.ts), used when the template list can't load. */
const BUILTIN_COLLECTION_LETTERS = [
  { id: 'builtin:collection-friendly', name: 'Friendly reminder (slightly overdue)' },
  { id: 'builtin:collection-firm', name: 'Firm reminder (more than 30 days)' },
  { id: 'builtin:collection-final', name: 'Final notice (seriously overdue)' },
];

type ActionMode = 'note' | 'email' | 'letter';

interface CInvoice {
  id: string;
  number: number;
  date: string;
  dueDate: string;
  balanceDue: string;
  daysPastDue: number;
  isStatementCharge: boolean;
}
interface CCustomer {
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  totalDue: string;
  invoices: CInvoice[];
  lastNote: { note: string; createdAt: string; followUpDate: string | null } | null;
  lastContact?: { at: string; method: string; note: string } | null;
  nextFollowUp: string | null;
}
interface Center {
  asOf: string;
  almostDueDays: number;
  overdue: CCustomer[];
  almostDue: CCustomer[];
}
interface Note {
  id: string;
  note: string;
  invoiceId: string | null;
  followUpDate: string | null;
  done: boolean;
  createdAt: string;
  contactMethod?: string | null;
}

export default function CollectionsCenterPage() {
  const [tab, setTab] = useState<'overdue' | 'almostDue'>('overdue');
  const [days, setDays] = useState('7');
  const [data, setData] = useState<Center | null>(null);
  const [loading, setLoading] = useState(true);
  const [noteFor, setNoteFor] = useState<CCustomer | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [noteInvoice, setNoteInvoice] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [saving, setSaving] = useState(false);
  // salesar C9: what the modal does, and its extra fields.
  const [mode, setMode] = useState<ActionMode>('note');
  const [method, setMethod] = useState('');
  const [addTodo, setAddTodo] = useState(false);
  const [addCustomerNote, setAddCustomerNote] = useState(false);
  const [emailWhat, setEmailWhat] = useState<'invoices' | 'statement'>('invoices');
  const [emailTo, setEmailTo] = useState('');
  const [letters, setLetters] = useState(BUILTIN_COLLECTION_LETTERS);
  const [letterId, setLetterId] = useState(BUILTIN_COLLECTION_LETTERS[0].id);

  // Collection letter templates (built-in + the company's own); the built-ins when the list can't load.
  useEffect(() => {
    api
      .get<Array<{ id: string; name: string; category: string }>>('/api/letters/templates')
      .then((list) => {
        const mine = (Array.isArray(list) ? list : []).filter((t) => t.category === 'collection');
        if (mine.length) setLetters(mine.map((t) => ({ id: t.id, name: t.name })));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<Center>(`/api/collections?almostDueDays=${days}`));
    } catch (err) {
      toastError(err, 'Could not load the Collections Center.');
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => {
    load();
  }, [load]);

  /** Open the follow-up window for a customer: log a contact / note, email, or print a letter. */
  async function openAction(c: CCustomer, m: ActionMode) {
    setMode(m);
    setMethod(m === 'note' ? 'call' : '');
    setAddTodo(false);
    setAddCustomerNote(false);
    setEmailWhat('invoices');
    setEmailTo(c.email ?? '');
    await openNotes(c);
  }

  async function openNotes(c: CCustomer) {
    setNoteFor(c);
    setNoteText('');
    setNoteInvoice('');
    setFollowUp('');
    try {
      const r = await api.get<{ notes: Note[] }>(`/api/collections/notes?customerId=${c.customerId}`);
      setNotes(r.notes ?? []);
    } catch (err) {
      toastError(err, 'Could not load notes.');
      setNotes([]);
    }
  }

  async function addNote() {
    if (!noteFor) return;
    if (!method && !noteText.trim()) {
      toast('Type a note first.', 'danger');
      return;
    }
    if (addTodo && !followUp) {
      toast('Pick a follow-up date to add it to the To Do list.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/collections/contacts', {
        customerId: noteFor.customerId,
        method: method || null,
        invoiceId: noteInvoice || null,
        note: noteText,
        followUpDate: followUp || null,
        addTodo,
        addCustomerNote,
      });
      toast(method ? 'Contact recorded.' : 'Note saved.', 'success');
      await openNotes(noteFor);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  }

  /** Email the overdue invoices or a statement through the app's email, recorded as a contact. */
  async function sendEmail() {
    if (!noteFor) return;
    if (addTodo && !followUp) {
      toast('Pick a follow-up date to add it to the To Do list.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ sent: Array<{ label: string }>; failed: Array<{ label: string; error: string }> }>(
        '/api/collections/email',
        { customerId: noteFor.customerId, what: emailWhat, to: emailTo || null, followUpDate: followUp || null, addTodo },
      );
      toast(`Emailed ${r.sent.map((s) => s.label).join(', ')}.`, 'success');
      if (r.failed.length) toast(`${r.failed[0].label} was not sent: ${r.failed[0].error}`, 'danger');
      setNoteFor(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not send the email.');
    } finally {
      setSaving(false);
    }
  }

  /** Print a collection letter (PDF) for the customer, recorded as a letter contact. */
  async function printLetter() {
    if (!noteFor) return;
    if (addTodo && !followUp) {
      toast('Pick a follow-up date to add it to the To Do list.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/collections/letter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: noteFor.customerId, templateId: letterId, followUpDate: followUp || null, addTodo }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not create the letter.');
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.download = 'collection-letter.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      toast('Collection letter ready — recorded as a contact.', 'success');
      setNoteFor(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not create the letter.');
    } finally {
      setSaving(false);
    }
  }

  async function markDone(n: Note) {
    try {
      await api.patch(`/api/collections/notes/${n.id}`, { done: !n.done });
      setNotes((prev) => prev.map((x) => (x.id === n.id ? { ...x, done: !n.done } : x)));
      await load();
    } catch (err) {
      toastError(err, 'Could not update the note.');
    }
  }

  const list = tab === 'overdue' ? (data?.overdue ?? []) : (data?.almostDue ?? []);
  const total = list.reduce((s, c) => s + Number(c.totalDue), 0);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Collect overdue payments (Collections Center)"
        icon={PhoneCall}
        action={
          <Link href="/income-tracker" className="text-sm font-semibold text-electric hover:underline">
            Income Tracker
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant={tab === 'overdue' ? 'primary' : 'secondary'} onClick={() => setTab('overdue')}>
          Overdue ({data?.overdue.length ?? 0})
        </Button>
        <Button variant={tab === 'almostDue' ? 'primary' : 'secondary'} onClick={() => setTab('almostDue')}>
          Almost due ({data?.almostDue.length ?? 0})
        </Button>
        {tab === 'almostDue' && (
          <label className="flex items-center gap-2 text-sm text-navy/70">
            due within
            <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-24" aria-label="Days">
              {['3', '7', '14', '30'].map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </Select>
          </label>
        )}
        <span className="ml-auto text-sm text-navy/60">
          Total: <strong className="text-navy">{formatCurrency(total.toFixed(2))}</strong>
        </span>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-navy/40">
          <Spinner className="h-6 w-6" />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={PhoneCall}
            title={tab === 'overdue' ? 'Nobody is late paying you' : 'Nothing coming due soon'}
            message="Customers show up here when an invoice is past due (or about to be)."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <Card key={c.customerId} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div>
                  <div className="text-lg font-bold text-navy">{c.customerName}</div>
                  <div className="text-sm text-navy/60">
                    {c.phone ? <span className="mr-3">{c.phone}</span> : null}
                    {c.email ? <a className="text-electric hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : null}
                    {!c.phone && !c.email ? 'No phone or email on file' : null}
                  </div>
                  <div className="mt-1 text-xs text-navy/60">
                    {c.lastContact
                      ? `Last contacted ${formatDate(c.lastContact.at)} by ${METHOD_LABEL[c.lastContact.method] ?? c.lastContact.method}: ${c.lastContact.note}`
                      : 'Not contacted yet'}
                  </div>
                  {c.lastNote && (
                    <div className="mt-1 text-xs text-navy/50">
                      Last note ({formatDate(c.lastNote.createdAt)}): {c.lastNote.note}
                    </div>
                  )}
                </div>
                <div className="ml-auto text-right">
                  <div className="text-xl font-bold text-navy tabular-nums">{formatCurrency(c.totalDue)}</div>
                  {c.nextFollowUp && <Badge tone="warning">Follow up {formatDate(c.nextFollowUp)}</Badge>}
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openAction(c, 'note')}>
                      Log contact / note
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openAction(c, 'email')}>
                      Email
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openAction(c, 'letter')}>
                      Collection letter
                    </Button>
                    <Link
                      href={receivePaymentHref(c.customerId)}
                      className="inline-flex items-center rounded-lg px-2 text-sm font-semibold text-electric hover:underline"
                    >
                      Receive payment
                    </Link>
                  </div>
                </div>
              </div>
              <Table>
                <thead>
                  <Tr>
                    <Th>Invoice</Th>
                    <Th>Date</Th>
                    <Th>Due</Th>
                    <Th numeric>Balance</Th>
                    <Th>{tab === 'overdue' ? 'Late by' : 'Due in'}</Th>
                    <Th>Action</Th>
                  </Tr>
                </thead>
                <tbody>
                  {c.invoices.map((i) => (
                    <Tr key={i.id}>
                      <Td>
                        <Link href={`/invoices?focus=${i.id}`} className="text-electric hover:underline">
                          #{i.number}
                        </Link>
                        {i.isStatementCharge ? <span className="ml-1 text-xs text-navy/40">(statement charge)</span> : null}
                      </Td>
                      <Td>{formatDate(i.date)}</Td>
                      <Td>{formatDate(i.dueDate)}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(i.balanceDue)}</Td>
                      <Td>
                        {i.daysPastDue > 0 ? (
                          <Badge tone="danger">{i.daysPastDue} days</Badge>
                        ) : (
                          <Badge tone="info">{i.daysPastDue === 0 ? 'today' : `${-i.daysPastDue} days`}</Badge>
                        )}
                      </Td>
                      <Td>
                        <Link
                          href={receivePaymentHref(c.customerId, i.id)}
                          className="whitespace-nowrap text-sm font-semibold text-electric hover:underline"
                        >
                          Receive payment
                        </Link>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={!!noteFor}
        onClose={() => setNoteFor(null)}
        title={`${mode === 'email' ? 'Email' : mode === 'letter' ? 'Collection letter' : 'Follow up'} — ${noteFor?.customerName ?? ''}`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNoteFor(null)}>Close</Button>
            {mode === 'email' ? (
              <Button loading={saving} onClick={sendEmail}>Send email</Button>
            ) : mode === 'letter' ? (
              <Button loading={saving} onClick={printLetter}>Print letter</Button>
            ) : (
              <Button loading={saving} onClick={addNote}>{method ? 'Record contact' : 'Save note'}</Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          <div role="radiogroup" aria-label="What to do" className="flex flex-wrap gap-2">
            {(
              [
                ['note', 'Log contact / note'],
                ['email', 'Email invoices or statement'],
                ['letter', 'Collection letter'],
              ] as Array<[ActionMode, string]>
            ).map(([m, label]) => (
              <Button
                key={m}
                size="sm"
                role="radio"
                aria-checked={mode === m}
                variant={mode === m ? 'primary' : 'secondary'}
                onClick={() => setMode(m)}
              >
                {label}
              </Button>
            ))}
          </div>

          {mode === 'note' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="cc-method">How did you reach them?</Label>
                  <Select id="cc-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="">Just a note (no contact)</option>
                    {METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="cc-inv">About invoice (optional)</Label>
                  <Select id="cc-inv" value={noteInvoice} onChange={(e) => setNoteInvoice(e.target.value)}>
                    <option value="">Whole account</option>
                    {noteFor?.invoices.map((i) => (
                      <option key={i.id} value={i.id}>Invoice #{i.number}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="cc-note">{method ? 'What happened' : 'New note'}</Label>
                <Input id="cc-note" placeholder="e.g. Called, promised to pay Friday" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
              </div>
            </>
          )}

          {mode === 'email' && (
            <>
              <div role="radiogroup" aria-label="What to email" className="flex flex-wrap gap-4 text-sm text-navy">
                <label className="flex items-center gap-2">
                  <input type="radio" name="cc-what" checked={emailWhat === 'invoices'} onChange={() => setEmailWhat('invoices')} />
                  The overdue invoices (one PDF each)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="cc-what" checked={emailWhat === 'statement'} onChange={() => setEmailWhat('statement')} />
                  A statement
                </label>
              </div>
              <div>
                <Label htmlFor="cc-to">Send to</Label>
                <Input id="cc-to" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="customer@example.com" />
                <p className="text-xs text-navy/50 mt-1">Sent with the app&apos;s email settings and recorded as a contact.</p>
              </div>
            </>
          )}

          {mode === 'letter' && (
            <div>
              <Label htmlFor="cc-letter">Letter</Label>
              <Select id="cc-letter" value={letterId} onChange={(e) => setLetterId(e.target.value)}>
                {letters.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Select>
              <p className="text-xs text-navy/50 mt-1">
                Filled in with the overdue balance and invoices, printed on your letterhead (edit the wording under{' '}
                <Link href="/letters" className="text-electric hover:underline">Letters</Link>).
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-follow">Follow up on</Label>
              <DateInput id="cc-follow" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
            </div>
            <div className="flex flex-col justify-end gap-1 text-sm text-navy/80">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={addTodo} onChange={(e) => setAddTodo(e.target.checked)} />
                Add the follow-up to the To Do list
              </label>
              {mode === 'note' && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={addCustomerNote} onChange={(e) => setAddCustomerNote(e.target.checked)} />
                  Also save on the customer&apos;s Notes
                </label>
              )}
            </div>
          </div>
          <div className="border-t border-slate-100 pt-3">
            {notes.length === 0 ? (
              <p className="text-sm text-navy/40 italic">No notes yet.</p>
            ) : (
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={n.done} onChange={() => markDone(n)} aria-label="Follow-up done" />
                    <div className={n.done ? 'text-navy/40 line-through' : 'text-navy'}>
                      <div>{n.note}</div>
                      <div className="text-xs text-navy/40">
                        {formatDate(n.createdAt)}
                        {n.contactMethod ? ` · ${METHOD_LABEL[n.contactMethod] ?? n.contactMethod}` : ''}
                        {n.followUpDate ? ` · follow up ${formatDate(n.followUpDate)}` : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>
    </main>
  );
}
