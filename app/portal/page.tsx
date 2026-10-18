'use client';
import { useEffect, useState } from 'react';
import { UserSquare, Download, LogOut, FileText } from 'lucide-react';
import { Button, Card, Badge, EmptyState, Spinner, Table, Th, Td, Tr } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

interface Paycheck {
  id: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossPay: string;
  netPay: string;
}
interface Me {
  employee: { id: string; name: string; email: string | null; payType: string };
  paychecks: Paycheck[];
}

export default function PortalPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Me>('/api/portal/me')
      .then(setMe)
      .catch(() => {
        window.location.href = '/portal/login';
      })
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    try {
      await fetch('/api/portal/logout', { method: 'POST' });
    } finally {
      window.location.href = '/portal/login';
    }
  }

  if (loading)
    return (
      <main className="min-h-screen grid place-items-center text-navy/40">
        <span className="inline-flex items-center gap-2">
          <Spinner className="h-5 w-5" /> Loading…
        </span>
      </main>
    );
  if (!me) return null;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <div className="flex items-center justify-between mb-8 max-w-3xl">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald h-12 w-12 flex items-center justify-center">
            <UserSquare className="text-white h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-navy">{me.employee.name}</h1>
            <p className="text-sm text-navy/50">{me.employee.email}</p>
          </div>
        </div>
        <Button variant="ghost" onClick={logout}>
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>

      <Card className="p-6 max-w-3xl">
        <h2 className="text-lg font-bold text-navy mb-4">My Pay Stubs</h2>
        {me.paychecks.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No paychecks yet"
            message="Your pay stubs will appear here after your first payroll run."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pay Date</Th>
                <Th>Period</Th>
                <Th numeric>Gross</Th>
                <Th numeric>Net</Th>
                <Th numeric>Stub</Th>
              </tr>
            </thead>
            <tbody>
              {me.paychecks.map((p) => (
                <Tr key={p.id} className="hover:bg-emerald/5">
                  <Td className="whitespace-nowrap">{formatDate(p.payDate)}</Td>
                  <Td className="text-navy/60 text-sm">
                    {p.periodStart ? `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}` : '—'}
                  </Td>
                  <Td numeric>{formatCurrency(p.grossPay)}</Td>
                  <Td numeric className="font-semibold text-emerald">
                    {formatCurrency(p.netPay)}
                  </Td>
                  <Td numeric>
                    <button
                      onClick={() => window.open(`/api/payroll/paystub?paycheckId=${p.id}`, '_blank')}
                      className="text-electric hover:underline inline-flex items-center gap-1 text-sm"
                    >
                      <Download className="h-3.5 w-3.5" /> PDF
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="mt-4">
          <Badge tone="info">Read-only employee view</Badge>
        </div>
      </Card>
    </main>
  );
}
