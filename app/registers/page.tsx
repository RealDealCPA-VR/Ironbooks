'use client';
/**
 * Registers index — QB "Use Register" account picker.
 *
 * Lists bank (checking/savings), credit-card, A/R and A/P accounts with their
 * current balances, grouped by category. Each row opens the account's register
 * at /registers/<accountId>.
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

const GROUPS: { title: string; subtypes: string[] }[] = [
  { title: 'Bank Accounts', subtypes: ['checking', 'savings'] },
  { title: 'Credit Cards', subtypes: ['credit_card'] },
  { title: 'Accounts Receivable', subtypes: ['accounts_receivable'] },
  { title: 'Accounts Payable', subtypes: ['accounts_payable'] },
  { title: 'Other Current Assets', subtypes: ['undeposited_funds', 'other_current_asset', 'inventory'] },
  { title: 'Fixed & Other Assets', subtypes: ['fixed_assets', 'other_asset'] },
  { title: 'Other Liabilities', subtypes: ['other_current_liability', 'long_term_liability'] },
];

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
            title="No register accounts found"
            message="Create bank, credit card, A/R or A/P accounts in the Chart of Accounts to use registers."
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
        GROUPS.map((group) => {
          const rows = accounts.filter((a) => group.subtypes.includes(a.subtype));
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
