'use client';

/**
 * Estimates Follow-up page.
 *
 * Shows two sections:
 *  1. Estimates expiring within 7 days (actionable warning list).
 *  2. All estimates expiring within 30 days.
 *
 * Provides an "Expire Overdue Now" button that calls POST /api/estimates/expire.
 */

import { useEffect, useState, useCallback } from 'react';
import { Clock } from 'lucide-react';
import {
  Button,
  Card,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  Spinner,
  toast,
  type BadgeTone,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExpiringEstimate {
  id: string;
  estimateNumber: number;
  refNumber?: string | null;
  customerName: string;
  status: string;
  total: string;
  expirationDate: string;
}

interface Customer {
  id: string;
  displayName: string;
}

interface ExpiredSummary {
  expired: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysUntil(dateStr: string): number {
  const expDate = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  expDate.setHours(0, 0, 0, 0);
  return Math.round((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function expiryBadgeTone(
  days: number,
): 'danger' | 'warning' | 'info' {
  if (days <= 0) return 'danger';
  if (days <= 7) return 'warning';
  return 'info';
}

function statusBadgeTone(status: string): BadgeTone {
  switch (status) {
    case 'draft': return 'neutral';
    case 'open': return 'open';
    case 'accepted': return 'success';
    case 'rejected': return 'danger';
    case 'closed': return 'neutral';
    default: return 'neutral';
  }
}

/** "open" -> "Open", "accepted" -> "Accepted" */
function statusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EstimatesFollowupPage() {
  const [loadingExpiring, setLoadingExpiring] = useState(true);

  const [expiring7Days, setExpiring7Days] = useState<ExpiringEstimate[]>([]);
  const [expiring30, setExpiring30] = useState<ExpiringEstimate[]>([]);

  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  // Fetch estimates expiring within 30 days, resolving customer names from
  // /api/customers (the estimates list endpoint only carries customerId).
  const fetchExpiring = useCallback(async () => {
    setLoadingExpiring(true);
    try {
      const [all, customers] = await Promise.all([
        api.get<Array<{
          id: string;
          estimateNumber: number;
          refNumber?: string | null;
          status: string;
          total: string;
          expirationDate: string | null;
          customerId: string;
          companyId: string;
        }>>('/api/estimates'),
        api.get<Customer[]>('/api/customers'),
      ]);

      const custMap = new Map(customers.map((c) => [c.id, c.displayName]));

      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const cutoff30 = new Date(now);
      cutoff30.setDate(cutoff30.getDate() + 30);
      const cutoff7 = new Date(now);
      cutoff7.setDate(cutoff7.getDate() + 7);

      const actionable = ['draft', 'open', 'accepted'];

      const mapped: ExpiringEstimate[] = all
        .filter((e) => {
          if (!e.expirationDate) return false;
          if (!actionable.includes(e.status)) return false;
          const exp = new Date(e.expirationDate);
          return exp <= cutoff30;
        })
        .map((e) => ({
          id: e.id,
          estimateNumber: e.estimateNumber,
          refNumber: e.refNumber,
          customerName: custMap.get(e.customerId) ?? '—',
          status: e.status,
          total: e.total,
          expirationDate: e.expirationDate!,
        }));

      setExpiring30(mapped);
      setExpiring7Days(
        mapped.filter((e) => {
          const exp = new Date(e.expirationDate);
          return exp <= cutoff7;
        }),
      );
    } catch {
      toast('Failed to load expiring estimates.', 'danger');
    } finally {
      setLoadingExpiring(false);
    }
  }, []);

  useEffect(() => {
    fetchExpiring();
  }, [fetchExpiring]);

  async function handleExpireNow() {
    setRunning(true);
    try {
      const result = await api.post<ExpiredSummary>('/api/estimates/expire', {});
      setLastResult(result.expired);
      toast(
        result.expired > 0
          ? `${result.expired} estimate(s) marked as expired.`
          : 'No overdue estimates to expire.',
        result.expired > 0 ? 'success' : 'info',
      );
      // Refresh the list after expiring.
      await fetchExpiring();
    } catch (err) {
      toast(
        err instanceof ApiError ? err.message : 'Failed to expire estimates.',
        'danger',
      );
    } finally {
      setRunning(false);
    }
  }

  function renderRows(rows: ExpiringEstimate[]) {
    return rows.map((e) => {
      const days = daysUntil(e.expirationDate);
      return (
        <Tr key={e.id}>
          <Td className="font-bold">{e.refNumber || e.estimateNumber}</Td>
          <Td>{e.customerName}</Td>
          <Td>
            <Badge tone={statusBadgeTone(e.status)}>{statusLabel(e.status)}</Badge>
          </Td>
          <Td>
            <span className="mr-2 text-sm">{formatDate(e.expirationDate)}</span>
            <Badge tone={expiryBadgeTone(days)}>
              {days === 0
                ? 'Today'
                : days < 0
                ? `${Math.abs(days)}d overdue`
                : `${days}d left`}
            </Badge>
          </Td>
          <Td numeric>{formatCurrency(e.total)}</Td>
        </Tr>
      );
    });
  }

  const loadingBlock = (
    <div className="flex items-center justify-center gap-2 text-sm text-navy/50 py-4">
      <Spinner className="h-4 w-4" /> Loading…
    </div>
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Estimates Follow-up"
        icon={Clock}
        action={
          <Button onClick={handleExpireNow} loading={running} variant="danger">
            Expire Overdue Now
          </Button>
        }
      />

      {lastResult !== null && (
        <div className="mb-4 rounded-lg bg-emerald/10 border border-emerald/30 px-4 py-3 text-sm text-emerald font-medium">
          Last run expired {lastResult} estimate{lastResult !== 1 ? 's' : ''}.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Expiring within 7 days                                              */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-navy">
            Expiring Within 7 Days
            {expiring7Days.length > 0 && (
              <Badge tone="danger" className="ml-2">{expiring7Days.length}</Badge>
            )}
          </h2>
        </div>

        {loadingExpiring ? (
          loadingBlock
        ) : expiring7Days.length === 0 ? (
          <p className="text-sm text-navy/50 py-4 text-center">
            No estimates expiring in the next 7 days.
          </p>
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>#</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Expires</Th>
                <Th numeric>Total</Th>
              </Tr>
            </thead>
            <tbody>{renderRows(expiring7Days)}</tbody>
          </Table>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* All expiring within 30 days                                         */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-navy">
            Expiring Within 30 Days
          </h2>
          <span className="text-sm text-navy/50">
            {expiring30.length} estimate{expiring30.length !== 1 ? 's' : ''}
          </span>
        </div>

        {loadingExpiring ? (
          loadingBlock
        ) : expiring30.length === 0 ? (
          <p className="text-sm text-navy/50 py-4 text-center">
            No estimates expiring in the next 30 days.
          </p>
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>#</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Expires</Th>
                <Th numeric>Total</Th>
              </Tr>
            </thead>
            <tbody>{renderRows(expiring30)}</tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
