'use client';

import { useEffect, useState } from 'react';
import { Briefcase, Plus, TrendingUp } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  EmptyState,
  Select,
  Spinner,
  toast,
} from '@/components/ui';
import Link from 'next/link';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  name: string;
  status: string;
  customerId: string | null;
  budget: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string;
  /** B4: Job Type list entry. */
  jobTypeId?: string | null;
}

/** B4: Job Type list entry (GET /api/lists/job-types). */
interface JobTypeOption {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

/** "Parent:Child" name of a Job Type. */
function jobTypeName(id: string | null | undefined, all: JobTypeOption[]): string {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let cur = all.find((t) => t.id === id); cur && !seen.has(cur.id); cur = cur.parentId ? all.find((t) => t.id === cur!.parentId) : undefined) {
    seen.add(cur.id);
    path.unshift(cur.name);
  }
  return path.join(':');
}

/** Job Type picker: active types (plus the current one), "Parent:Child" names, sorted. */
function JobTypeSelect({
  id,
  value,
  types,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  types: JobTypeOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {types
        .filter((t) => t.isActive || t.id === value)
        .map((t) => ({ t, name: jobTypeName(t.id, types) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ t, name }) => (
          <option key={t.id} value={t.id}>
            {name}
            {t.isActive ? '' : ' — inactive'}
          </option>
        ))}
    </Select>
  );
}

interface JobSummaryRow extends Job {
  customerName: string | null;
  /** null when the row came from the bare list (inactive jobs have no summary). */
  revenue: string | null;
  cost: string | null;
  profit: string | null;
}

interface Customer {
  id: string;
  displayName: string;
}

interface ProfitabilityLine {
  source: 'invoice_line' | 'credit_memo_line' | 'bill_line' | 'expense_line';
  id: string;
  description: string | null;
  amount: string;
}

interface JobProfitability {
  jobId: string;
  jobName: string;
  budget: string | null;
  revenue: string;
  cost: string;
  profit: string;
  budgetVariance: string | null;
  lines: ProfitabilityLine[];
}

interface JobFormState {
  name: string;
  budget: string;
  startDate: string;
  endDate: string;
  jobTypeId: string;
}

const EMPTY_FORM: JobFormState = {
  name: '',
  budget: '',
  startDate: '',
  endDate: '',
  jobTypeId: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profitTone(profit: string): 'success' | 'danger' | 'neutral' {
  const n = parseFloat(profit);
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return 'neutral';
}

function sourceLabel(source: ProfitabilityLine['source']): string {
  switch (source) {
    case 'invoice_line': return 'Revenue';
    case 'credit_memo_line': return 'Credit Memo';
    case 'bill_line': return 'Bill Cost';
    case 'expense_line': return 'Direct Expense';
  }
}

function sourceTone(source: ProfitabilityLine['source']): 'success' | 'danger' {
  return source === 'invoice_line' || source === 'credit_memo_line' ? 'success' : 'danger';
}

// ---------------------------------------------------------------------------
// New Job form (inside modal)
// ---------------------------------------------------------------------------

function JobForm({
  form,
  onChange,
  jobTypes,
}: {
  form: JobFormState;
  onChange: (field: keyof JobFormState, value: string) => void;
  jobTypes: JobTypeOption[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="name">Job Name *</Label>
        <Input
          id="name"
          autoFocus
          placeholder="e.g. Roof Replacement — 42 Oak St"
          value={form.name}
          onChange={(e) => onChange('name', e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="jobType">Job type</Label>
        <JobTypeSelect id="jobType" value={form.jobTypeId} types={jobTypes} onChange={(v) => onChange('jobTypeId', v)} />
        <p className="mt-1 text-xs text-navy/50">
          Groups jobs (New Construction, Repair…) so job reports can be filtered by type. Edit the choices on the{' '}
          <Link href="/lists?list=job-types" className="text-electric hover:underline">Job Types list</Link>.
        </p>
      </div>
      <div>
        <Label htmlFor="budget">Budget ($)</Label>
        <Input
          id="budget"
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={form.budget}
          onChange={(e) => onChange('budget', e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="startDate">Start Date</Label>
          <Input
            id="startDate"
            type="date"
            value={form.startDate}
            onChange={(e) => onChange('startDate', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="endDate">End Date</Label>
          <Input
            id="endDate"
            type="date"
            value={form.endDate}
            onChange={(e) => onChange('endDate', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profitability panel — built on the kit Modal (Escape, focus trap, aria-modal)
// ---------------------------------------------------------------------------

function ProfitabilityPanel({
  jobId,
  onClose,
  jobTypes,
  onJobTypeChanged,
}: {
  jobId: string;
  onClose: () => void;
  jobTypes: JobTypeOption[];
  onJobTypeChanged: () => void;
}) {
  const [data, setData] = useState<(Job & { profitability: JobProfitability }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeSaving, setTypeSaving] = useState(false);

  // B4: change the job's Job Type (saved right away, like QB's Edit Job > Job Info).
  async function saveJobType(jobTypeId: string) {
    if (!data) return;
    setTypeSaving(true);
    try {
      await api.patch(`/api/jobs/${jobId}`, { jobTypeId: jobTypeId || null });
      setData({ ...data, jobTypeId: jobTypeId || null });
      toast('Job type saved', 'success');
      onJobTypeChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save the job type', 'danger');
    } finally {
      setTypeSaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await api.get<Job & { profitability: JobProfitability }>(
          `/api/jobs/${jobId}?profitability=true`,
        );
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof ApiError ? err.message : 'Failed to load job details', 'danger');
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, onClose]);

  const p = data?.profitability;
  // Credit memo lines (returns, write-offs) are negative revenue of the job.
  const isRevenue = (l: ProfitabilityLine) => l.source === 'invoice_line' || l.source === 'credit_memo_line';
  const revLines = p?.lines.filter(isRevenue) ?? [];
  const costLines = p?.lines.filter((l) => !isRevenue(l)) ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={p ? `${p.jobName} — Job P&L` : 'Job P&L'}
    >
      {loading || !p ? (
        <div className="flex items-center justify-center gap-2 text-navy/40 text-sm py-8">
          <Spinner className="h-4 w-4" /> Loading...
        </div>
      ) : (
        <>
          {/* Job type (B4) */}
          <div className="mb-4 flex items-center gap-3">
            <Label htmlFor="panelJobType" className="mb-0 whitespace-nowrap">Job type</Label>
            <div className="w-64">
              <JobTypeSelect
                id="panelJobType"
                value={data?.jobTypeId ?? ''}
                types={jobTypes}
                disabled={typeSaving}
                onChange={(v) => void saveJobType(v)}
              />
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="rounded-xl bg-emerald/10 p-4 text-center">
              <p className="text-xs text-emerald font-semibold uppercase tracking-wide mb-1">Revenue</p>
              <p className="text-lg font-bold text-emerald">{formatCurrency(p.revenue)}</p>
            </div>
            <div className="rounded-xl bg-red-50 p-4 text-center">
              <p className="text-xs text-red-500 font-semibold uppercase tracking-wide mb-1">Cost</p>
              <p className="text-lg font-bold text-red-500">{formatCurrency(p.cost)}</p>
            </div>
            <div
              className={`rounded-xl p-4 text-center ${
                parseFloat(p.profit) >= 0 ? 'bg-electric/10' : 'bg-gold/20'
              }`}
            >
              <p
                className={`text-xs font-semibold uppercase tracking-wide mb-1 ${
                  parseFloat(p.profit) >= 0 ? 'text-electric' : 'text-gold'
                }`}
              >
                Profit
              </p>
              <p
                className={`text-lg font-bold ${
                  parseFloat(p.profit) >= 0 ? 'text-electric' : 'text-gold'
                }`}
              >
                {formatCurrency(p.profit)}
              </p>
            </div>
          </div>

          {/* Budget row */}
          {p.budget !== null && (
            <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-navy/70">Budget</span>
              <span className="font-semibold text-navy">{formatCurrency(p.budget)}</span>
              {p.budgetVariance !== null && (
                <span
                  className={`text-sm font-medium ${
                    parseFloat(p.budgetVariance) >= 0 ? 'text-emerald' : 'text-red-500'
                  }`}
                >
                  {parseFloat(p.budgetVariance) >= 0 ? '+' : ''}
                  {formatCurrency(p.budgetVariance)} vs. budget
                </span>
              )}
            </div>
          )}

          {/* Line items */}
          {p.lines.length === 0 ? (
            <div className="py-8 text-center text-navy/40 text-sm">
              No line items tagged to this job yet.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {revLines.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald mb-2">
                    Revenue Lines
                  </p>
                  <div className="rounded-xl border border-slate-100 overflow-hidden">
                    <Table>
                      <thead>
                        <tr>
                          <Th>Description</Th>
                          <Th numeric>Amount</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {revLines.map((l) => (
                          <Tr key={l.id}>
                            <Td className="text-navy/80">{l.description ?? '—'}</Td>
                            <Td numeric className="text-emerald font-medium">
                              {formatCurrency(l.amount)}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </div>
              )}

              {costLines.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-500 mb-2">
                    Cost Lines
                  </p>
                  <div className="rounded-xl border border-slate-100 overflow-hidden">
                    <Table>
                      <thead>
                        <tr>
                          <Th>Description</Th>
                          <Th>Type</Th>
                          <Th numeric>Amount</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {costLines.map((l) => (
                          <Tr key={l.id}>
                            <Td className="text-navy/80">{l.description ?? '—'}</Td>
                            <Td>
                              <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                                {sourceLabel(l.source)}
                              </span>
                            </Td>
                            <Td numeric className="text-red-500 font-medium">
                              {formatCurrency(l.amount)}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<JobFormState>(EMPTY_FORM);
  const [addSaving, setAddSaving] = useState(false);

  // Profitability panel
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // B4: Job Type list (non-fatal: the picker is just empty)
  const [jobTypes, setJobTypes] = useState<JobTypeOption[]>([]);
  useEffect(() => {
    api
      .get<{ entries: JobTypeOption[] }>('/api/lists/job-types?includeInactive=true')
      .then((d) => setJobTypes(Array.isArray(d.entries) ? d.entries : []))
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchJobs() {
    setLoading(true);
    try {
      // Always load the summary so active jobs keep customer + revenue/cost/profit.
      // When showing inactive jobs, merge in the bare list (inactive jobs carry no
      // summary figures — those render as "—" instead of fake zeros).
      const summary = await api.get<JobSummaryRow[]>('/api/jobs?summary=true');
      if (!includeInactive) {
        setJobs(summary);
        return;
      }
      const [list, customers] = await Promise.all([
        api.get<Job[]>('/api/jobs?includeInactive=true'),
        api.get<Customer[]>('/api/customers'),
      ]);
      const summaryById = new Map(summary.map((s) => [s.id, s]));
      const custMap = new Map(customers.map((c) => [c.id, c.displayName]));
      setJobs(
        list.map(
          (j) =>
            summaryById.get(j.id) ?? {
              ...j,
              customerName: j.customerId ? (custMap.get(j.customerId) ?? null) : null,
              revenue: null,
              cost: null,
              profit: null,
            },
        ),
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load jobs', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive]);

  // ---------------------------------------------------------------------------
  // Add job
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setAddForm(EMPTY_FORM);
    setAddOpen(true);
  }

  function updateAddForm(field: keyof JobFormState, value: string) {
    setAddForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleAdd() {
    if (!addForm.name.trim()) {
      toast('Job name is required', 'danger');
      return;
    }
    setAddSaving(true);
    try {
      await api.post('/api/jobs', {
        name: addForm.name.trim(),
        budget: addForm.budget ? addForm.budget : undefined,
        startDate: addForm.startDate || undefined,
        endDate: addForm.endDate || undefined,
        jobTypeId: addForm.jobTypeId || undefined,
      });
      toast('Job created', 'success');
      setAddOpen(false);
      await fetchJobs();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create job', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Jobs & Projects"
        icon={Briefcase}
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-navy/60 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-slate-300 text-electric focus:ring-electric/40"
              />
              Show inactive
            </label>
            <Button onClick={openAddModal}>
              <Plus className="h-4 w-4" />
              New Job
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading jobs...
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title={includeInactive ? 'No jobs found' : 'No active jobs'}
            message="Create a job to start tracking project profitability."
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" />
                New Job
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job Name</Th>
                <Th>Customer</Th>
                <Th>Job Type</Th>
                <Th>Status</Th>
                <Th>Start</Th>
                <Th>End</Th>
                <Th numeric>Budget</Th>
                <Th numeric>Revenue</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Profit</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <Tr
                  key={j.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedJobId(j.id)}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 text-electric flex-shrink-0" />
                      <span className="font-semibold text-navy hover:text-electric transition-colors">
                        {j.name}
                      </span>
                    </div>
                  </Td>
                  <Td className="text-navy/70">{j.customerName ?? '-'}</Td>
                  <Td className="text-navy/70">{jobTypeName(j.jobTypeId, jobTypes) || '-'}</Td>
                  <Td>
                    {j.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td className="text-navy/60 text-sm">{j.startDate ? formatDate(j.startDate) : '-'}</Td>
                  <Td className="text-navy/60 text-sm">{j.endDate ? formatDate(j.endDate) : '-'}</Td>
                  <Td numeric className="text-navy/70 text-sm">
                    {j.budget ? formatCurrency(j.budget) : '-'}
                  </Td>
                  <Td numeric className="font-semibold text-emerald">
                    {j.revenue !== null ? formatCurrency(j.revenue) : '—'}
                  </Td>
                  <Td numeric className="font-semibold text-red-500">
                    {j.cost !== null ? formatCurrency(j.cost) : '—'}
                  </Td>
                  <Td numeric>
                    {j.profit !== null ? (
                      <Badge tone={profitTone(j.profit)}>
                        {formatCurrency(j.profit)}
                      </Badge>
                    ) : (
                      <span className="text-navy/40 text-sm">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Add job modal ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="New Job / Project"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button type="submit" form="new-job-form" loading={addSaving}>
              Create Job
            </Button>
          </>
        }
      >
        <form
          id="new-job-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <JobForm form={addForm} onChange={updateAddForm} jobTypes={jobTypes} />
        </form>
      </Modal>

      {/* ---- Profitability panel ---- */}
      {selectedJobId && (
        <ProfitabilityPanel
          jobId={selectedJobId}
          onClose={() => setSelectedJobId(null)}
          jobTypes={jobTypes}
          onJobTypeChanged={() => void fetchJobs()}
        />
      )}
    </main>
  );
}
