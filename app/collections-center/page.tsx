'use client';
/**
 * Collections Center (wave2 sales C9) — who owes you money that is late (or about to be), with
 * their contact details, the invoices involved, and a running log of collection notes with a
 * follow-up date.
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
    if (!noteText.trim()) {
      toast('Type a note first.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/collections/notes', {
        customerId: noteFor.customerId,
        invoiceId: noteInvoice || null,
        note: noteText,
        followUpDate: followUp || null,
      });
      toast('Note saved.', 'success');
      await openNotes(noteFor);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the note.');
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
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Collections Center"
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
                  {c.lastNote && (
                    <div className="mt-1 text-xs text-navy/50">
                      Last note ({formatDate(c.lastNote.createdAt)}): {c.lastNote.note}
                    </div>
                  )}
                </div>
                <div className="ml-auto text-right">
                  <div className="text-xl font-bold text-navy tabular-nums">{formatCurrency(c.totalDue)}</div>
                  {c.nextFollowUp && <Badge tone="warning">Follow up {formatDate(c.nextFollowUp)}</Badge>}
                  <div className="mt-2">
                    <Button size="sm" variant="secondary" onClick={() => openNotes(c)}>
                      Notes
                    </Button>
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
                  </Tr>
                </thead>
                <tbody>
                  {c.invoices.map((i) => (
                    <Tr key={i.id}>
                      <Td>
                        #{i.number}
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
        title={`Collection notes — ${noteFor?.customerName ?? ''}`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNoteFor(null)}>Close</Button>
            <Button loading={saving} onClick={addNote}>Save note</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="cc-note">New note</Label>
            <Input id="cc-note" placeholder="e.g. Called, promised to pay Friday" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cc-inv">About invoice (optional)</Label>
              <Select id="cc-inv" value={noteInvoice} onChange={(e) => setNoteInvoice(e.target.value)}>
                <option value="">Whole account</option>
                {noteFor?.invoices.map((i) => (
                  <option key={i.id} value={i.id}>Invoice #{i.number}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="cc-follow">Follow up on</Label>
              <DateInput id="cc-follow" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
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
