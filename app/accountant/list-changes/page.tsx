'use client';

import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { BackToCenter, monthsAgo } from '../_shared';

interface Change {
  auditLogId: string;
  list: string;
  entityType: string;
  action: string;
  label: string;
  changedFields: string[];
  changedBy: string | null;
  changedAt: string;
  reviewed: boolean;
  reviewedBy: string | null;
}

const LISTS: Array<[string, string]> = [
  ['', 'All lists'],
  ['account', 'Chart of Accounts'],
  ['item', 'Items'],
  ['customer', 'Customers'],
  ['vendor', 'Vendors'],
  ['employee', 'Employees'],
  ['payroll_item', 'Payroll Items'],
  ['tax_rate', 'Sales Tax Items'],
  ['class', 'Classes'],
];

const ACTION_LABEL: Record<string, string> = { create: 'Added', update: 'Changed', delete: 'Deleted', void: 'Voided' };

export default function ListChangesPage() {
  const [since, setSince] = useState(monthsAgo(3));
  const [entityType, setEntityType] = useState('');
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [rows, setRows] = useState<Change[] | null>(null);
  const [unreviewed, setUnreviewed] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ since, ...(entityType ? { entityType } : {}), ...(includeReviewed ? { includeReviewed: '1' } : {}) });
      const res = await api.get<{ rows: Change[]; unreviewed: number }>(`/api/accountant/list-changes?${qs}`);
      setRows(res.rows);
      setUnreviewed(res.unreviewed);
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Could not load list changes.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mark(reviewed: boolean, ids: string[]) {
    try {
      const res = await api.post<{ updated: number }>('/api/accountant/list-changes', { auditLogIds: ids, reviewed });
      toast(reviewed ? `Marked ${res.updated} change(s) reviewed.` : `Marked ${res.updated} change(s) not reviewed.`, 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not update the review status.');
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Review List Changes" icon={ListChecks} action={<Badge tone={unreviewed ? 'warning' : 'success'}>{unreviewed} not reviewed</Badge>} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Everything that was added, changed or deleted in your lists since a date, with who did it and which fields changed.
        Mark changes reviewed once you have checked them.
      </p>
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="lc-since">Changed since</Label>
            <Input id="lc-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="lc-list">List</Label>
            <Select id="lc-list" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {LISTS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-navy">
            <input type="checkbox" checked={includeReviewed} onChange={(e) => setIncludeReviewed(e.target.checked)} />
            Show reviewed changes too
          </label>
          <Button variant="secondary" loading={loading} onClick={load}>Show changes</Button>
        </div>
      </Card>
      {rows !== null && (
        <Card className="p-6">
          {rows.length === 0 ? (
            <EmptyState icon={ListChecks} title="Nothing to review" message="No list changes match these filters." />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === rows.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.auditLogId)) : new Set())}
                      />
                    </Th>
                    <Th>When</Th>
                    <Th>List</Th>
                    <Th>Name</Th>
                    <Th>What happened</Th>
                    <Th>By</Th>
                    <Th>Reviewed</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.auditLogId}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Select change to ${r.label}`}
                          checked={selected.has(r.auditLogId)}
                          onChange={() => {
                            const n = new Set(selected);
                            if (n.has(r.auditLogId)) n.delete(r.auditLogId);
                            else n.add(r.auditLogId);
                            setSelected(n);
                          }}
                        />
                      </Td>
                      <Td className="whitespace-nowrap">{r.changedAt.slice(0, 16).replace('T', ' ')}</Td>
                      <Td>{r.list}</Td>
                      <Td>{r.label}</Td>
                      <Td>
                        {ACTION_LABEL[r.action] ?? r.action}
                        {r.changedFields.length > 0 && <span className="block text-xs text-navy/50">{r.changedFields.join(', ')}</span>}
                      </Td>
                      <Td>{r.changedBy ?? '—'}</Td>
                      <Td>{r.reviewed ? <Badge tone="success">Reviewed{r.reviewedBy ? ` by ${r.reviewedBy}` : ''}</Badge> : <Badge tone="warning">Not yet</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" disabled={selected.size === 0} onClick={() => mark(false, [...selected])}>Mark not reviewed</Button>
                <Button disabled={selected.size === 0} onClick={() => mark(true, [...selected])}>Mark reviewed</Button>
              </div>
            </>
          )}
        </Card>
      )}
    </main>
  );
}
