'use client';

import { useEffect, useState } from 'react';
import { CalendarRange, Lock, LockOpen, Plus } from 'lucide-react';
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
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/format';

// ---- Types ----------------------------------------------------------------

interface FiscalPeriod {
  id: string;
  periodStart: string;
  periodEnd: string;
  isClosed: boolean;
  closedAt: string | null;
}

// ---- Helpers ---------------------------------------------------------------

// Period start/end are calendar days: formatDate (lib/format.ts) shows them without the UTC
// off-by-one that `new Date(iso).toLocaleDateString()` had in US time zones.

// ---- Close Period Modal -----------------------------------------------------

interface ClosePeriodModalProps {
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}

function ClosePeriodModal({ open, onClose, onClosed }: ClosePeriodModalProps) {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPeriodStart('');
      setPeriodEnd('');
    }
  }, [open]);

  async function handleSubmit() {
    if (!periodStart || !periodEnd) {
      toast('Both start and end dates are required.', 'danger');
      return;
    }
    if (periodStart > periodEnd) {
      toast('Start date must be on or before the end date.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/fiscal-periods', { periodStart, periodEnd });
      toast('Period closed.', 'success');
      onClosed();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to close period.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close a Period"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            Close Period
          </Button>
        </>
      }
    >
      <p className="text-navy/60 text-sm mb-4">
        Closing a period locks it: no journal entries can be posted or voided within the closed
        date range until the period is reopened.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="fp-start">Period Start *</Label>
          <Input
            id="fp-start"
            type="date"
            autoFocus
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fp-end">Period End *</Label>
          <Input
            id="fp-end"
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---- Main Page ----------------------------------------------------------------

export default function FiscalPeriodsPage() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<FiscalPeriod | null>(null);
  const [reopening, setReopening] = useState(false);

  async function fetchPeriods() {
    try {
      const data = await api.get<FiscalPeriod[]>('/api/fiscal-periods');
      data.sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
      setPeriods(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load fiscal periods.', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPeriods();
  }, []);

  async function handleReopen() {
    if (!reopenTarget) return;
    setReopening(true);
    try {
      await api.patch(`/api/fiscal-periods/${reopenTarget.id}`);
      toast('Period reopened.', 'success');
      setReopenTarget(null);
      fetchPeriods();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to reopen period.', 'danger');
    } finally {
      setReopening(false);
    }
  }

  return (
    <>
      <main className="min-h-screen bg-offwhite p-8 font-sans">
        <PageHeader
          title="Fiscal Periods"
          icon={CalendarRange}
          action={
            <Button onClick={() => setCloseOpen(true)}>
              <Plus className="h-4 w-4" />
              Close a Period
            </Button>
          }
        />

        {loading ? (
          <Card className="p-12 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </Card>
        ) : periods.length === 0 ? (
          <Card>
            <EmptyState
              icon={CalendarRange}
              title="No closed periods yet"
              message="Close a period to lock its books — no entries can be posted or voided within a closed period."
              action={
                <Button onClick={() => setCloseOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Close a Period
                </Button>
              }
            />
          </Card>
        ) : (
          <Card className="p-6">
            <Table>
              <thead>
                <tr>
                  <Th>Period Start</Th>
                  <Th>Period End</Th>
                  <Th className="w-28 text-center">Status</Th>
                  <Th className="w-28 text-center">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <Tr key={period.id}>
                    <Td className="whitespace-nowrap">{formatDate(period.periodStart)}</Td>
                    <Td className="whitespace-nowrap">{formatDate(period.periodEnd)}</Td>
                    <Td className="text-center">
                      {period.isClosed ? (
                        <Badge tone="warning">Closed</Badge>
                      ) : (
                        <Badge tone="success">Open</Badge>
                      )}
                    </Td>
                    <Td className="text-center">
                      {period.isClosed ? (
                        <button
                          className="inline-flex items-center gap-1 text-xs text-navy/60 hover:text-navy font-medium transition-colors"
                          title="Reopen this period"
                          onClick={() => setReopenTarget(period)}
                        >
                          <LockOpen className="h-3.5 w-3.5" />
                          Reopen
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-navy/30">
                          <Lock className="h-3.5 w-3.5" />
                          —
                        </span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        <ClosePeriodModal
          open={closeOpen}
          onClose={() => setCloseOpen(false)}
          onClosed={fetchPeriods}
        />

        <ConfirmDialog
          open={!!reopenTarget}
          title="Reopen Period"
          message={
            <>
              Reopen the period{' '}
              <span className="font-semibold text-navy">
                {reopenTarget
                  ? `${formatDate(reopenTarget.periodStart)} – ${formatDate(reopenTarget.periodEnd)}`
                  : ''}
              </span>
              ? Entries dated within it can be posted and voided again. Use with care if the period
              has already been reported on.
            </>
          }
          confirmLabel="Reopen"
          tone="danger"
          loading={reopening}
          onConfirm={handleReopen}
          onClose={() => setReopenTarget(null)}
        />
      </main>
    </>
  );
}
