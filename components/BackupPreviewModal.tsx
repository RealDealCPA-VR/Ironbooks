'use client';
/**
 * "Look inside this backup" before restoring it (team backups). Shows what POST
 * /api/backups/preview found in the backup — opened read-only in a temporary folder — and only
 * then lets the person confirm the restore (existing restore path with its integrity checks).
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Modal, Table, Td, Th, Tr } from '@/components/ui';
import { formatCurrency } from '@/lib/money';

export interface BackupPreviewDto {
  backupDate: string | null;
  appVersion: string | null;
  label: string | null;
  sizeBytes: number;
  companies: Array<{
    name: string;
    transactions: number;
    invoices: number;
    bills: number;
    lastTransactionDate: string | null;
    trialBalance: { totalDebit: string; totalCredit: string; balanced: boolean } | null;
  }>;
  balanced: boolean;
  problems: string[];
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

function formatDate(ymd: string | null): string {
  if (!ymd) return 'No transactions';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function BackupPreviewModal({
  open,
  source,
  loading,
  preview,
  error,
  restoring,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** What is being previewed, e.g. the uploaded file name or "Automatic backup of Jun 3". */
  source: string;
  loading: boolean;
  preview: BackupPreviewDto | null;
  error: string | null;
  restoring: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blocked = Boolean(preview && preview.problems.length > 0);
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!restoring) onCancel();
      }}
      title="Check this backup before restoring"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={restoring}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            loading={restoring}
            disabled={loading || !preview || blocked}
          >
            Restore this backup
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm text-navy/80">
        <p>
          Backup: <span className="font-semibold text-navy break-all">{source}</span>
        </p>

        {loading && (
          <p role="status" className="text-navy/60">
            Opening the backup in a private temporary copy to look inside… Your current books are not touched.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
            {error}
          </p>
        )}

        {preview && (
          <>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs text-navy/50">Backup made</dt>
                <dd className="font-semibold text-navy">
                  {preview.backupDate ? new Date(preview.backupDate).toLocaleString('en-US') : 'Unknown'}
                </dd>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs text-navy/50">Made with Ironbooks version</dt>
                <dd className="font-semibold text-navy">{preview.appVersion ?? 'Unknown (older backup)'}</dd>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs text-navy/50">Size</dt>
                <dd className="font-semibold text-navy">{formatBytes(preview.sizeBytes)}</dd>
              </div>
            </dl>

            <div>
              <h3 className="font-semibold text-navy mb-1">
                Companies in this backup ({preview.companies.length})
              </h3>
              {preview.companies.length === 0 ? (
                <p className="text-navy/50">This backup has no companies in it.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Company</Th>
                      <Th numeric>Transactions</Th>
                      <Th>Latest transaction</Th>
                      <Th numeric>Debits</Th>
                      <Th numeric>Credits</Th>
                      <Th>Books balance?</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.companies.map((c) => (
                      <Tr key={c.name}>
                        <Td className="font-medium">{c.name}</Td>
                        <Td numeric>
                          {c.transactions.toLocaleString('en-US')}
                          <span className="block text-xs text-navy/50">
                            {c.invoices.toLocaleString('en-US')} invoices · {c.bills.toLocaleString('en-US')} bills
                          </span>
                        </Td>
                        <Td>{formatDate(c.lastTransactionDate)}</Td>
                        <Td numeric>{c.trialBalance ? formatCurrency(c.trialBalance.totalDebit) : '—'}</Td>
                        <Td numeric>{c.trialBalance ? formatCurrency(c.trialBalance.totalCredit) : '—'}</Td>
                        <Td>
                          {c.trialBalance?.balanced ? (
                            <Badge tone="success">
                              <CheckCircle2 aria-hidden="true" className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                              Balanced
                            </Badge>
                          ) : (
                            <Badge tone="danger">Does not balance</Badge>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>

            {blocked ? (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
                <p className="font-semibold flex items-center gap-2">
                  <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                  This backup cannot be restored — the books in it are damaged:
                </p>
                <ul className="list-disc pl-5 mt-1">
                  {preview.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p className="mt-1">Choose an earlier backup.</p>
              </div>
            ) : (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-800 flex items-center gap-2">
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
                The books in this backup passed the safety checks and can be restored.
              </p>
            )}

            <p className="text-red-600 font-medium">
              Restoring replaces ALL companies in the current company file with this backup. Anything entered
              after the backup was made will be gone. A safety copy of the current file is saved first.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
