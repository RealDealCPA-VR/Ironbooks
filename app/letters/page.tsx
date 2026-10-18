'use client';
/**
 * Letters, labels & envelopes (QB Company > Prepare Letters with Envelopes; File > Print Forms >
 * Labels). Pick who to write to (e.g. customers more than 30 days overdue), pick a letter (the
 * built-in collection letters or your own), preview the filled-in text, then print letters,
 * Avery 5160 mailing labels, or #10 envelopes as PDF.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Mail, Printer, Save, StickyNote } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

type RecipientType = 'customer' | 'vendor' | 'employee' | 'lead';
interface Recipient {
  id: string;
  name: string;
  company: string | null;
  addressLines: string[];
  balance: string | null;
  overdueBalance: string | null;
  daysOverdue: number | null;
}
interface LetterTemplate {
  id: string;
  category: string;
  name: string;
  body: string;
  builtIn: boolean;
}

const CATEGORY_FOR: Record<RecipientType, string[]> = {
  customer: ['collection', 'customer', 'other'],
  vendor: ['vendor', 'other'],
  employee: ['employee', 'other'],
  lead: ['lead', 'other'],
};

async function openPdf(url: string, body: unknown, filename: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not create the PDF');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export default function LettersPage() {
  const [type, setType] = useState<RecipientType>('customer');
  const [overdueOnly, setOverdueOnly] = useState(true);
  const [overdueDays, setOverdueDays] = useState('30');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<LetterTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [body, setBody] = useState('');
  const [signer, setSigner] = useState('');
  const [preview, setPreview] = useState<Array<{ recipientId: string; body: string }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [startPosition, setStartPosition] = useState('1');

  const loadRecipients = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ type });
      if (type === 'customer' && overdueOnly) qs.set('overdueDays', overdueDays || '0');
      const rows = await api.get<Recipient[]>(`/api/letters/recipients?${qs.toString()}`);
      setRecipients(rows);
      setChecked(new Set(rows.map((r) => r.id)));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the list', 'danger');
      setRecipients([]);
    } finally {
      setLoading(false);
    }
  }, [type, overdueOnly, overdueDays]);

  useEffect(() => {
    void loadRecipients();
  }, [loadRecipients]);

  useEffect(() => {
    api.get<LetterTemplate[]>('/api/letters/templates').then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const available = useMemo(() => templates.filter((t) => CATEGORY_FOR[type].includes(t.category)), [templates, type]);

  useEffect(() => {
    const first = available[0];
    if (first && !available.some((t) => t.id === templateId)) {
      setTemplateId(first.id);
      setBody(first.body);
    }
  }, [available, templateId]);

  const ids = recipients.filter((r) => checked.has(r.id)).map((r) => r.id);

  async function doPreview() {
    if (ids.length === 0) return toast('Pick at least one recipient', 'danger');
    setBusy('preview');
    try {
      setPreview(await api.post('/api/letters/prepare', { recipientType: type, recipientIds: ids, body, signer: signer || undefined, preview: true }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not prepare the letters', 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: 'letters' | 'labels' | 'envelopes') {
    if (ids.length === 0) return toast('Pick at least one recipient', 'danger');
    setBusy(kind);
    try {
      if (kind === 'letters') {
        await openPdf('/api/letters/prepare', { recipientType: type, recipientIds: ids, body, signer: signer || undefined }, 'letters.pdf');
      } else if (kind === 'labels') {
        await openPdf('/api/letters/labels', { recipientType: type, recipientIds: ids, startPosition: Number(startPosition) || 1 }, 'labels.pdf');
      } else {
        await openPdf('/api/letters/envelopes', { recipientType: type, recipientIds: ids }, 'envelopes.pdf');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the PDF', 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function saveAsTemplate() {
    const name = window.prompt('Name for this letter template?');
    if (!name?.trim()) return;
    try {
      const created = await api.post<LetterTemplate>('/api/letters/templates', {
        category: type === 'customer' ? (templates.find((t) => t.id === templateId)?.category ?? 'customer') : type,
        name: name.trim(),
        body,
      });
      setTemplates((t) => [...t, created]);
      setTemplateId(created.id);
      toast('Letter template saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the template', 'danger');
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Letters & Labels" icon={Mail} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="p-6">
          <h2 className="mb-3 text-base font-bold text-navy">1. Who are you writing to?</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="ltr-type">Send to</Label>
              <Select id="ltr-type" value={type} onChange={(e) => setType(e.target.value as RecipientType)}>
                <option value="customer">Customers</option>
                <option value="vendor">Vendors</option>
                <option value="employee">Employees</option>
                <option value="lead">Leads</option>
              </Select>
            </div>
            {type === 'customer' && (
              <>
                <label className="flex items-center gap-2 pb-2 text-sm text-navy">
                  <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Only overdue by at least
                </label>
                <div className="w-20">
                  <Input aria-label="Days overdue" value={overdueDays} disabled={!overdueOnly} onChange={(e) => setOverdueDays(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
                <span className="pb-2 text-sm text-navy/60">days</span>
              </>
            )}
          </div>
          <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-slate-100">
            {loading ? (
              <div className="flex justify-center py-6 text-electric">
                <Spinner className="h-5 w-5" />
              </div>
            ) : recipients.length === 0 ? (
              <p className="p-4 text-sm text-navy/50">Nobody matches.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-xs uppercase text-navy/50">
                    <th className="p-2">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={checked.size === recipients.length}
                        onChange={(e) => setChecked(e.target.checked ? new Set(recipients.map((r) => r.id)) : new Set())}
                      />
                    </th>
                    <th className="p-2">Name</th>
                    {type === 'customer' && <th className="p-2 text-right">Overdue</th>}
                    {(type === 'customer' || type === 'vendor') && <th className="p-2 text-right">Balance</th>}
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Include ${r.name}`}
                          checked={checked.has(r.id)}
                          onChange={(e) =>
                            setChecked((c) => {
                              const n = new Set(c);
                              if (e.target.checked) n.add(r.id);
                              else n.delete(r.id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="p-2 text-navy">
                        {r.name}
                        {r.addressLines.length === 0 && <span className="ml-2 text-xs text-amber-600">no address</span>}
                      </td>
                      {type === 'customer' && (
                        <td className="p-2 text-right tabular-nums">
                          {r.overdueBalance && Number(r.overdueBalance) > 0 ? `${formatCurrency(r.overdueBalance)} (${r.daysOverdue}d)` : '—'}
                        </td>
                      )}
                      {(type === 'customer' || type === 'vendor') && (
                        <td className="p-2 text-right tabular-nums">{r.balance !== null ? formatCurrency(r.balance) : ''}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="mt-2 text-xs text-navy/50">{ids.length} selected</p>
        </Card>

        <Card className="p-6">
          <h2 className="mb-3 text-base font-bold text-navy">2. Choose and adjust the letter</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="ltr-template">Letter</Label>
              <Select
                id="ltr-template"
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  setBody(templates.find((t) => t.id === e.target.value)?.body ?? '');
                }}
              >
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.builtIn ? '' : ' (yours)'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-48">
              <Label htmlFor="ltr-signer">Signed by</Label>
              <Input id="ltr-signer" value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Your name" />
            </div>
          </div>
          <textarea
            aria-label="Letter text"
            rows={14}
            spellCheck
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs leading-relaxed"
          />
          <p className="mt-1 text-xs text-navy/50">
            Fill-in fields like {'{{recipient.name}}'}, {'{{overdueBalance}}'}, {'{{daysOverdue}}'}, {'{{invoiceList}}'} and{' '}
            {'{{company.phone}}'} are replaced for each person.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void doPreview()} loading={busy === 'preview'}>
              <Eye className="h-4 w-4" /> Preview
            </Button>
            <Button onClick={() => void run('letters')} loading={busy === 'letters'}>
              <Printer className="h-4 w-4" /> Print letters
            </Button>
            <Button variant="ghost" onClick={() => void saveAsTemplate()}>
              <Save className="h-4 w-4" /> Save as my template
            </Button>
          </div>
          <div className="mt-6 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-bold text-navy">Labels &amp; envelopes</h3>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-36">
                <Label htmlFor="ltr-start">Start at label #</Label>
                <Input id="ltr-start" value={startPosition} onChange={(e) => setStartPosition(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} />
              </div>
              <Button variant="secondary" onClick={() => void run('labels')} loading={busy === 'labels'}>
                <StickyNote className="h-4 w-4" /> Mailing labels (Avery 5160)
              </Button>
              <Button variant="secondary" onClick={() => void run('envelopes')} loading={busy === 'envelopes'}>
                <Mail className="h-4 w-4" /> Envelopes (#10)
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {preview && (
        <Card className="mt-6 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold text-navy">Preview ({preview.length})</h2>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Close
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {preview.slice(0, 6).map((p) => (
              <pre key={p.recipientId} className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-100 bg-white p-4 font-serif text-sm text-navy">
                {p.body}
              </pre>
            ))}
          </div>
          {preview.length > 6 && <p className="mt-2 text-xs text-navy/50">Showing 6 of {preview.length}.</p>}
        </Card>
      )}
    </main>
  );
}
