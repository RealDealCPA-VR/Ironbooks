'use client';
/**
 * Bank Feeds page — connect live bank accounts via Plaid Link.
 *
 * Behaviour:
 *   - On mount: checks GET /api/plaid/status to see if Plaid is configured.
 *   - Configured: loads the Plaid Link JS from CDN, lets the user pick a
 *     bank account from the BookKeeper bank-account list, then opens Plaid
 *     Link. On success, exchanges the public token and runs a sync into the
 *     selected bank account.
 *   - Not configured: shows setup instructions (which env vars to set) with
 *     a clear, non-error UI.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Rss } from 'lucide-react';
import {
  Button,
  Card,
  Label,
  PageHeader,
  Select,
  Table,
  Th,
  Td,
  Tr,
  Badge,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { format, parseISO } from 'date-fns';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaidStatusResponse {
  configured: boolean;
  /** Privacy & Network policy verdict for the 'bank-feeds' purpose (cloud opt-in). */
  allowed?: boolean;
  reason?: string;
}

interface BankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  accountId: string;
}

interface LinkTokenResponse {
  linkToken: string;
}

interface ExchangeResponse {
  accessToken: string;
}

interface SyncResponse {
  imported: number;
  total: number;
}

interface SyncRecord {
  bankAccountId: string;
  bankName: string;
  importedAt: string;
  imported: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Plaid Link global types (CDN script injects window.Plaid)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    Plaid?: {
      create: (config: PlaidCreateConfig) => PlaidHandler;
    };
  }
}

interface PlaidCreateConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: unknown) => void;
  onExit: (err: unknown, metadata: unknown) => void;
  onLoad?: () => void;
}

interface PlaidHandler {
  open: () => void;
  destroy: () => void;
}

// ---------------------------------------------------------------------------
// Helper: load the Plaid Link CDN script once
// ---------------------------------------------------------------------------

const PLAID_CDN = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const PLAID_SCRIPT_ID = 'plaid-link-script';

function loadPlaidScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(PLAID_SCRIPT_ID)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = PLAID_SCRIPT_ID;
    script.src = PLAID_CDN;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Plaid Link script.'));
    document.body.appendChild(script);
  });
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function BankFeedsPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [policyBlock, setPolicyBlock] = useState<string | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncHistory, setSyncHistory] = useState<SyncRecord[]>([]);
  const plaidHandlerRef = useRef<PlaidHandler | null>(null);

  // ---- Check Plaid status on mount ----------------------------------------
  useEffect(() => {
    api
      .get<PlaidStatusResponse>('/api/plaid/status')
      .then((data) => {
        if (data.allowed === false) setPolicyBlock(data.reason ?? 'Bank feeds are turned off.');
        setConfigured(data.configured);
      })
      .catch(() => setConfigured(false));
  }, []);

  // ---- Load bank accounts when we know Plaid is configured ----------------
  useEffect(() => {
    if (!configured) return;
    api
      .get<BankAccount[]>('/api/bank-accounts')
      .then((rows) => {
        setBankAccounts(rows);
        if (rows.length > 0) setSelectedBankAccountId(rows[0].id);
      })
      .catch((err) => {
        toastError(err, 'Failed to load bank accounts.');
      });
  }, [configured]);

  // ---- Open Plaid Link flow -----------------------------------------------
  const handleConnect = useCallback(async () => {
    if (!selectedBankAccountId) {
      toast('Please select a bank account first.', 'danger');
      return;
    }

    setConnecting(true);
    try {
      // 1. Ensure the Plaid Link CDN script is loaded.
      await loadPlaidScript();

      if (!window.Plaid) {
        toast('Plaid Link failed to load. Check your network connection.', 'danger');
        setConnecting(false);
        return;
      }

      // 2. Get a fresh link token from our server.
      const { linkToken } = await api.post<LinkTokenResponse>('/api/plaid/link-token');

      // 3. Create and open the Link handler.
      const handler = window.Plaid.create({
        token: linkToken,

        onSuccess: async (publicToken: string) => {
          try {
            // 4. Exchange public token for access token.
            const { accessToken } = await api.post<ExchangeResponse>('/api/plaid/exchange', {
              publicToken,
            });

            // 5. Sync transactions into the selected bank account.
            const result = await api.post<SyncResponse>('/api/plaid/sync', {
              accessToken,
              bankAccountId: selectedBankAccountId,
            });

            const selectedAccount = bankAccounts.find((a) => a.id === selectedBankAccountId);
            setSyncHistory((prev) => [
              {
                bankAccountId: selectedBankAccountId,
                bankName: selectedAccount?.bankName ?? 'Unknown',
                importedAt: new Date().toISOString(),
                imported: result.imported,
                total: result.total,
              },
              ...prev,
            ]);

            toast(
              `Sync complete: ${result.imported} new transaction${result.imported !== 1 ? 's' : ''} imported (${result.total} from Plaid).`,
              'success',
            );
          } catch (err) {
            toastError(err, 'Sync failed. Please try again.');
          } finally {
            setConnecting(false);
            plaidHandlerRef.current?.destroy();
            plaidHandlerRef.current = null;
          }
        },

        onExit: (err: unknown) => {
          setConnecting(false);
          if (err) {
            toast('Plaid Link closed with an error. Please try again.', 'danger');
          }
          plaidHandlerRef.current?.destroy();
          plaidHandlerRef.current = null;
        },
      });

      plaidHandlerRef.current = handler;
      handler.open();
    } catch (err) {
      toastError(err, 'Failed to start bank connection.');
      setConnecting(false);
    }
  }, [selectedBankAccountId, bankAccounts]);

  // ---- Render: loading status --------------------------------------------
  if (configured === null) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader title="Live Bank Feeds" icon={Rss} />
        <Card className="p-8 text-center text-navy/40">Checking Plaid configuration…</Card>
      </main>
    );
  }

  // ---- Render: blocked by the Privacy & Network policy ---------------------
  if (policyBlock) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader title="Live Bank Feeds" icon={Rss} />
        <Card className="p-8 max-w-2xl">
          <h2 className="text-xl font-bold text-navy mb-2">Bank feeds are off for this company</h2>
          <p className="text-navy/60 text-sm mb-4">{policyBlock}</p>
          <p className="text-navy/60 text-sm mb-6">
            Live bank feeds connect to Plaid over the internet. BookKeeper AI keeps your books on this
            computer, so cloud bank feeds stay off until an admin opts in. You can always import bank
            files (OFX/QFX/CSV) instead — nothing leaves this machine.
          </p>
          <div className="flex gap-2">
            <Link href="/privacy">
              <Button variant="secondary">Privacy &amp; Network settings</Button>
            </Link>
            <Link href="/banking">
              <Button>Import a bank file</Button>
            </Link>
          </div>
        </Card>
      </main>
    );
  }

  // ---- Render: not configured --------------------------------------------
  if (!configured) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader title="Live Bank Feeds" icon={Rss} />

        {/* Offline alternative first: most users never need a live connection. */}
        <Card className="p-6 mb-6 max-w-2xl border-l-4 border-electric">
          <h2 className="text-lg font-bold text-navy mb-1">No live connection needed</h2>
          <p className="text-sm text-navy/60 mb-4">
            Download a statement file (CSV, OFX or QFX) from your bank&apos;s website and import it.
            Your data stays on this computer. Then review each transaction and choose where it belongs
            (its account in the chart of accounts <Help term="chart-of-accounts" side="bottom" />), and
            reconcile <Help term="reconcile" side="bottom" /> against the statement at month end.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/banking" className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-electric text-white hover:bg-electric/90 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1 px-4 py-2 text-sm">
              Import a statement file
            </Link>
            <Link href="/bank-review" className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-white text-navy border border-slate-200 hover:bg-slate-50 outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1 px-4 py-2 text-sm">
              Review downloaded transactions
            </Link>
          </div>
        </Card>

        <Card className="p-8 max-w-2xl">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gold/20 flex items-center justify-center text-gold text-2xl font-bold">
              !
            </div>
            <div>
              <h2 className="text-xl font-bold text-navy mb-2">Optional: live feeds (Plaid not configured)</h2>
              <p className="text-navy/60 text-sm mb-6">
                Live bank feeds use the Plaid API, an online service, and are usually set up by
                whoever installs BookKeeper for you. Set the following environment variables and
                restart the app to enable this feature.
              </p>

              <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 font-mono text-sm space-y-2 mb-6">
                <div>
                  <span className="text-electric font-bold">PLAID_CLIENT_ID</span>
                  <span className="text-navy/50 ml-2">= your_plaid_client_id</span>
                </div>
                <div>
                  <span className="text-electric font-bold">PLAID_SECRET</span>
                  <span className="text-navy/50 ml-2">= your_plaid_secret_key</span>
                </div>
                <div>
                  <span className="text-electric font-bold">PLAID_ENV</span>
                  <span className="text-navy/50 ml-2">= sandbox | development | production</span>
                  <span className="text-navy/30 ml-2">(default: sandbox)</span>
                </div>
              </div>

              <ol className="text-sm text-navy/70 space-y-2 list-decimal list-inside">
                <li>
                  Sign up at{' '}
                  <a
                    href="https://dashboard.plaid.com/signup"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-electric underline hover:no-underline"
                  >
                    dashboard.plaid.com
                  </a>{' '}
                  to get your credentials.
                </li>
                <li>
                  Copy your <strong>client_id</strong> and <strong>secret</strong> from the Plaid
                  Dashboard.
                </li>
                <li>
                  Add the variables to your <code className="bg-slate-100 px-1 rounded">.env.local</code> file (or your
                  deployment platform).
                </li>
                <li>Restart the development server and return to this page.</li>
              </ol>
            </div>
          </div>
        </Card>
      </main>
    );
  }

  // ---- Render: configured — show connect UI ------------------------------
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Live Bank Feeds" icon={Rss} />

      {/* Connection card */}
      <Card className="p-6 mb-6 max-w-2xl">
        <div className="flex items-center gap-2 mb-4">
          <Badge tone="success">Plaid connected</Badge>
          <span className="text-navy/40 text-xs">Sync your bank transactions automatically</span>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[220px]">
            <Label htmlFor="bank-account-select">
              Target bank account <Help term="reconcile" side="bottom" />
            </Label>
            {bankAccounts.length === 0 ? (
              <p className="text-sm text-navy/50 mt-1">
                No bank accounts found.{' '}
                <Link href="/banking" className="text-electric underline">
                  Create one in Banking first.
                </Link>
              </p>
            ) : (
              <Select
                id="bank-account-select"
                value={selectedBankAccountId}
                onChange={(e) => setSelectedBankAccountId(e.target.value)}
                disabled={connecting}
              >
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.bankName} — {a.accountNumber}
                  </option>
                ))}
              </Select>
            )}
          </div>

          <Button
            onClick={handleConnect}
            loading={connecting}
            disabled={bankAccounts.length === 0}
            className="flex-shrink-0"
          >
            Connect a Bank
          </Button>
        </div>

        <p className="mt-4 text-xs text-navy/40">
          Clicking "Connect a Bank" will open the Plaid Link dialog. Select your institution,
          authenticate, and your recent transactions will be imported automatically.
        </p>
      </Card>

      {/* Next step after a sync: downloaded lines still need a home. */}
      {syncHistory.length > 0 && (
        <Card className="p-4 mb-6 max-w-2xl flex flex-wrap items-center justify-between gap-3 border-l-4 border-emerald">
          <p className="text-sm text-navy/70">
            Next: review the downloaded transactions and match or categorize each one.
          </p>
          <Link href="/bank-review" className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-electric text-white hover:bg-electric/90 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1 px-3 py-1.5 text-sm">
            Review transactions
          </Link>
        </Card>
      )}

      {/* Sync history */}
      {syncHistory.length > 0 && (
        <Card className="p-0 overflow-hidden max-w-2xl">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-navy/70">Recent sync history (this session)</h2>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Bank</Th>
                <Th>Synced at</Th>
                <Th numeric>From Plaid</Th>
                <Th numeric>Imported</Th>
                <Th numeric>Duplicates Skipped</Th>
              </tr>
            </thead>
            <tbody>
              {syncHistory.map((r, i) => (
                <Tr key={i}>
                  <Td className="font-medium">{r.bankName}</Td>
                  <Td className="text-navy/50 text-xs whitespace-nowrap">
                    {format(parseISO(r.importedAt), 'MMM d, yyyy h:mm a')}
                  </Td>
                  <Td numeric>{r.total}</Td>
                  <Td numeric className="text-emerald font-semibold">{r.imported}</Td>
                  <Td numeric className="text-navy/40">{r.total - r.imported}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </main>
  );
}
