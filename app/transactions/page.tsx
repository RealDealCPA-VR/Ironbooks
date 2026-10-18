'use client';
/**
 * Transactions list — the 200 most recent journal entries.
 *
 * txn-history: rows are clickable and open EntryDetailModal, which shows the
 * entry's lines plus the QB "Transaction History" linked-transactions tree
 * (GET /api/journal-entries/:id/history).
 */
import { useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  PageSkeleton,
  Table,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';
import EntryDetailModal from '@/components/EntryDetailModal';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/utils';

const STATUS_TONE: Record<string, BadgeTone> = {
  posted: 'success',
  draft: 'warning',
  void: 'void',
};

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

interface EntryRow {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  status: string;
}

export default function TransactionsPage() {
  const [entries, setEntries] = useState<EntryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ entries: EntryRow[] }>('/api/journal-entries?limit=200')
      .then((data) => {
        if (!cancelled) setEntries(data.entries);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load transactions.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Transactions"
        icon={TrendingUp}
        action={
          <Link href="/journal">
            <Button>New Journal Entry</Button>
          </Link>
        }
      />
      <Card className="p-6">
        {error ? (
          <div className="py-10 text-center text-sm text-red-500">{error}</div>
        ) : entries === null ? (
          <PageSkeleton rows={8} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No transactions yet"
            message="Create invoices, bills, payments, or journal entries to get started."
            action={
              <Link href="/journal">
                <Button>Add Journal Entry</Button>
              </Link>
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th>Reference</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Tr
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className="cursor-pointer hover:bg-electric/5"
                  >
                    <Td className="text-navy/60 tabular-nums">{e.entryNumber}</Td>
                    <Td className="whitespace-nowrap">{formatDate(e.date)}</Td>
                    <Td>{e.description}</Td>
                    <Td className="text-navy/60">{e.reference ?? ''}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{statusLabel(e.status)}</Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-4 text-sm text-navy/40">
              Showing the {Math.min(entries.length, 200)} most recent entries. Click a row for
              detail and transaction history.{' '}
              <Link href="/journal" className="text-electric hover:underline">
                Add a journal entry →
              </Link>
            </div>
          </>
        )}
      </Card>

      <EntryDetailModal entryId={selectedId} onClose={() => setSelectedId(null)} />
    </main>
  );
}
