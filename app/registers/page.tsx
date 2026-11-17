'use client';
/**
 * Registers index — QB "Use Register" account picker.
 *
 * Lists every posting account with its current balance, grouped by category
 * (banks and cards first, then the rest of the balance sheet, equity, income and
 * expenses). Each row opens the account's register at /registers/<accountId>,
 * where new transactions can be typed straight into the register.
 */
import { SUBTYPE_LABELS } from '@/lib/accountTypes';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, BookOpen, ChevronRight, Trash2 } from 'lucide-react';
import { Card, ConfirmDialog, EmptyState, PageHeader, Spinner, Table, Th, Td, Tr, toast, toastError } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { HIDDEN_BALANCE_TITLE } from '@/lib/permissions/balances';

interface RegisterAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  balance: string;
  isActive: boolean;
}

const GROUPS: { title: string; match: (a: RegisterAccount) => boolean }[] = [
  { title: 'Bank Accounts', match: (a) => ['checking', 'savings'].includes(a.subtype) },
  { title: 'Credit Cards', match: (a) => a.subtype === 'credit_card' },
  { title: 'Accounts Receivable', match: (a) => a.subtype === 'accounts_receivable' },
  { title: 'Accounts Payable', match: (a) => a.subtype === 'accounts_payable' },
  { title: 'Other Current Assets', match: (a) => ['undeposited_funds', 'other_current_asset', 'inventory'].includes(a.subtype) },
  { title: 'Fixed & Other Assets', match: (a) => ['fixed_assets', 'other_asset'].includes(a.subtype) },
  { title: 'Other Liabilities', match: (a) => ['other_current_liability', 'long_term_liability'].includes(a.subtype) },
  { title: 'Equity', match: (a) => a.type === 'equity' },
  { title: 'Income', match: (a) => a.type === 'revenue' },
  { title: 'Expenses', match: (a) => a.type === 'expense' },
];

/** Accounts no group above claims still get listed (nothing in the chart is unreachable). */
const OTHER_GROUP = { title: 'Other Accounts', match: (a: RegisterAccount) => !GROUPS.some((g) => g.match(a)) };

function subtypeLabel(subtype: string): string {
  return SUBTYPE_LABELS[subtype as keyof typeof SUBTYPE_LABELS] ?? subtype;
}

export default function RegistersIndexPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<RegisterAccount[]>([]);
  const [loading, setLoading] = useState(true);
  // Make inactive (archive) or delete an account right from the list, as QuickBooks' Chart of Accounts.
  const [pending, setPending] = useState<{ account: RegisterAccount; action: 'inactive' | 'delete' } | null>(null);
  const [working, setWorking] = useState(false);
  function load() {
    return api
      .get<{ accounts: RegisterAccount[] }>('/api/registers')
      .then((data) => setAccounts(data.accounts))
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load accounts.', 'danger');
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    load();
  }, []);

  async function runPending() {
    if (!pending) return;
    setWorking(true);
    try {
      const { account, action } = pending;
      if (action === 'delete') {
        await api.del(`/api/accounts/${account.id}?permanent=1`);
        toast(`${account.name} was deleted.`, 'success');
      } else {
        await api.del(`/api/accounts/${account.id}`);
        toast(`${account.name} is inactive. Show it again from the Chart of Accounts.`, 'success');
      }
      setPending(null);
      await load();
    } catch (err) {
      toastError(err, pending.action === 'delete' ? 'Could not delete the account.' : 'Could not make the account inactive.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Account Registers" icon={BookOpen} />

      {loading && (
        <Card className="p-12">
          <div className="flex justify-center">
            <Spinner className="text-electric" />
          </div>
        </Card>
      )}

      {!loading && accounts.length === 0 && (
        <Card>
          <EmptyState
            icon={BookOpen}
            title="No accounts yet"
            message="Add accounts in the Chart of Accounts, then open any of them here as a register."
            action={
              <Link
                href="/accounts"
                className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-electric text-white hover:bg-electric/90 shadow-sm px-4 py-2 text-sm"
              >
                Open Chart of Accounts
              </Link>
            }
          />
        </Card>
      )}

      {!loading &&
        [...GROUPS, OTHER_GROUP].map((group) => {
          const rows = accounts.filter(group.match);
          if (rows.length === 0) return null;
          return (
            <div key={group.title} className="mb-8">
              <h2 className="text-lg font-bold text-navy mb-3">{group.title}</h2>
              <Card className="p-0 overflow-hidden">
                <Table>
                  <thead>
                    <tr>
                      <Th>Code</Th>
                      <Th>Account</Th>
                      <Th>Type</Th>
                      <Th numeric>Balance</Th>
                      <Th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <Tr
                        key={a.id}
                        data-register={`/registers/${a.id}`}
                        onClick={() => router.push(`/registers/${a.id}`)}
                        className="cursor-pointer group"
                      >
                        <Td className="font-mono text-xs text-navy/60">{a.code}</Td>
                        <Td className="font-medium">
                          <Link
                            href={`/registers/${a.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="block text-navy group-hover:text-electric transition-colors"
                          >
                            {a.name}
                          </Link>
                        </Td>
                        <Td className="text-navy/50 text-xs">{subtypeLabel(a.subtype)}</Td>
                        <Td
                          numeric
                          className={`font-semibold ${
                            Number(a.balance) < 0 ? 'text-red-600' : 'text-navy'
                          }`}
                        >
                          {/* QB View Balance: the server blanks balances the role may not see. */}
                          {(a as { balanceHidden?: boolean }).balanceHidden ? (
                            <span className="font-normal text-navy/40" title={HIDDEN_BALANCE_TITLE}>Hidden</span>
                          ) : (
                            formatCurrency(a.balance)
                          )}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              title={`Make ${a.name} inactive`}
                              aria-label={`Make ${a.name} inactive`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setPending({ account: a, action: 'inactive' });
                              }}
                              className="rounded p-1 text-navy/30 hover:bg-slate-100 hover:text-navy opacity-0 group-hover:opacity-100 focus:opacity-100"
                            >
                              <Archive className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              title={`Delete ${a.name}`}
                              aria-label={`Delete ${a.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setPending({ account: a, action: 'delete' });
                              }}
                              className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                            <ChevronRight className="h-4 w-4 text-navy/30 group-hover:text-electric" />
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          );
        })}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.action === 'delete' ? `Delete ${pending.account.name}?` : `Make ${pending?.account.name ?? ''} inactive?`}
        message={
          pending?.action === 'delete'
            ? 'Only an account that was never used can be deleted. If it has transactions, make it inactive instead. This cannot be undone.'
            : 'The account is hidden from lists and pickers but keeps its history. Its balance must be zero. You can make it active again from the Chart of Accounts (show inactive accounts).'
        }
        confirmLabel={pending?.action === 'delete' ? 'Delete Account' : 'Make Inactive'}
        tone={pending?.action === 'delete' ? 'danger' : undefined}
        loading={working}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      />
    </main>
  );
}
