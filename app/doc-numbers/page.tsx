'use client';
/**
 * Document Numbers — QB "Preferences > Sales & Customers / Purchases" next-number setup.
 *
 * Shows, per document type, the number the next new document will get and lets the user set a
 * starting number such as "INV-1001". Numbers may contain letters; the trailing digits count up
 * automatically (INV-1001, INV-1002, ...). Data: GET/PUT /api/doc-numbers (lib/services/docNumbers.ts).
 */
import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Button, Card, Input, PageHeader, Spinner, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';

interface DocNumberSetting {
  docType: string;
  label: string;
  startingNumber: string | null;
  nextNumber: string;
}

export default function DocNumbersPage() {
  const [rows, setRows] = useState<DocNumberSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.get<{ settings: DocNumberSetting[] }>('/api/doc-numbers');
      setRows(data.settings);
      setDrafts(Object.fromEntries(data.settings.map((s) => [s.docType, s.startingNumber ?? ''])));
    } catch (err) {
      toastError(err, 'Could not load document numbers.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save(docType: string) {
    setSaving(docType);
    try {
      const value = (drafts[docType] ?? '').trim();
      await api.put('/api/doc-numbers', { docType, startingNumber: value || null });
      toast(value ? `Next number set to ${value}.` : 'Numbering will continue from the last number used.', 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not save the starting number.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Document Numbers" icon={ListChecks} />
      <Card className="p-6">
        <p className="mb-4 text-sm text-navy/70 max-w-2xl">
          Each new invoice, estimate or order gets the next number automatically: the last number you
          used plus one. Numbers can include letters, like <strong>INV-1001</strong> — only the
          digits at the end count up. To start a new series, type the number the next document
          should get and save. You can still type any number on a form; using a number twice
          asks you to confirm first.
        </p>
        {loading ? (
          <div className="p-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Next number</Th>
                <Th>Start the next one at</Th>
                <Th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.docType}>
                  <Td className="font-medium text-navy">{r.label}</Td>
                  <Td className="font-mono text-sm">{r.nextNumber}</Td>
                  <Td>
                    <Input
                      aria-label={`${r.label} starting number`}
                      placeholder="Continue from the last number"
                      maxLength={50}
                      value={drafts[r.docType] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.docType]: e.target.value }))}
                    />
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="secondary"
                      onClick={() => save(r.docType)}
                      loading={saving === r.docType}
                      disabled={(drafts[r.docType] ?? '') === (r.startingNumber ?? '')}
                    >
                      Save
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
