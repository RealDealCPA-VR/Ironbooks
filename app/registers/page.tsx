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
import { BookOpen, ChevronRight } from 'lucide-react';
import { Card, EmptyState, PageHeader, Spinner, Table, Th, Td, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

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

  useEffect(() => {
    api
      .get<{ accounts: RegisterAccount[] }>('/api/registers')
      .then((data) => setAccounts(data.accounts))
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load accounts.', 'danger');
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
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
                          {formatCurrency(a.balance)}
                        </Td>
                        <Td>
                          <ChevronRight className="h-4 w-4 text-navy/30 group-hover:text-electric" />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          );
        })}
    </main>
  );
}
