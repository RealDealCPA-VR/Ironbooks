'use client';
/**
 * Company > System Accounts: the accounts Ironbooks posts to on its own — Accounts Payable,
 * Inventory Asset, Cost of Goods Sold, Sales Tax Payable and Payroll Liabilities — and why each
 * one was picked. A chart converted from QuickBooks numbers its accounts its own way; here the
 * bookkeeper sees which account each role uses and chooses another (lib/services/accountRoles.ts).
 * Keyboard: every row's account picker is a native select (Tab / arrows), Save with Enter.
 */
import { useEffect, useState } from 'react';
import { KeySquare } from 'lucide-react';
import { Badge, Button, Card, PageHeader, Select, Spinner, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

interface Acct {
  id: string;
  code: string;
  name: string;
  balance: string;
}
interface RoleRow {
  role: string;
  label: string;
  usedFor: string;
  usualNumber: string;
  account: Acct | null;
  source: 'chosen' | 'number' | 'detected' | 'number_other_kind' | 'missing';
  candidates: Acct[];
  notes: string[];
  canChange: boolean;
}

const SOURCE_TEXT: Record<RoleRow['source'], { text: string; tone: 'success' | 'info' | 'warning' | 'danger' }> = {
  chosen: { text: 'Chosen by you', tone: 'success' },
  number: { text: 'Usual number', tone: 'info' },
  detected: { text: 'Found by its kind', tone: 'info' },
  number_other_kind: { text: 'Needs your choice', tone: 'warning' },
  missing: { text: 'Missing', tone: 'danger' },
};

export default function SystemAccountsPage() {
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.get<RoleRow[]>('/api/account-roles');
      setRows(r);
      setPick(Object.fromEntries(r.map((x) => [x.role, x.source === 'chosen' ? x.account?.id ?? '' : ''])));
    } catch (err) {
      toastError(err, 'Could not load the system accounts.');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(row: RoleRow) {
    setBusy(row.role);
    try {
      const accountId = pick[row.role] || null;
      await api.patch('/api/account-roles', { role: row.role, accountId });
      toast(accountId ? `${row.label} now posts to the account you chose.` : `${row.label} is chosen automatically again.`, 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not change that account.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="System Accounts" icon={KeySquare} />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Ironbooks posts some amounts on its own: what you owe vendors, the value of inventory, the cost of what you sell,
        sales tax you collect and payroll withholdings. Each goes to the account shown here. A company converted from
        QuickBooks may number these accounts differently — check each one and choose the right account if needed.
      </p>
      {!rows ? (
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      ) : (
        <Card className="p-4">
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Posts to now</Th>
                <Th>How it was picked</Th>
                <Th>Use this account</Th>
                <Th>
                  <span className="sr-only">Save</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const changed = (pick[r.role] || '') !== (r.source === 'chosen' ? r.account?.id ?? '' : '');
                return (
                  <Tr key={r.role}>
                    <Td className="align-top">
                      <div className="font-semibold text-navy">{r.label}</div>
                      <div className="text-xs text-navy/50">{r.usedFor}</div>
                      {r.notes.map((n, i) => (
                        <p key={i} className="mt-1 max-w-md text-xs text-yellow-800">
                          {n}
                        </p>
                      ))}
                    </Td>
                    <Td className="align-top">
                      {r.account ? (
                        <>
                          <div>
                            {r.account.code} · {r.account.name}
                          </div>
                          <div className="text-xs tabular-nums text-navy/50">Balance {formatCurrency(r.account.balance)}</div>
                        </>
                      ) : (
                        <span className="text-navy/40">None</span>
                      )}
                    </Td>
                    <Td className="align-top">
                      <Badge tone={SOURCE_TEXT[r.source].tone}>{SOURCE_TEXT[r.source].text}</Badge>
                    </Td>
                    <Td className="align-top">
                      <Select
                        aria-label={`Account for ${r.label}`}
                        value={pick[r.role] ?? ''}
                        disabled={!r.canChange}
                        onChange={(e) => setPick((p) => ({ ...p, [r.role]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && changed) void save(r);
                        }}
                      >
                        <option value="">Choose automatically</option>
                        {r.candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} · {c.name} ({formatCurrency(c.balance)})
                          </option>
                        ))}
                      </Select>
                      {!r.canChange && (
                        <p className="mt-1 max-w-xs text-xs text-navy/50">
                          The account used now has a balance. Merge it into the new account first (Merge Records), then choose it here.
                        </p>
                      )}
                    </Td>
                    <Td className="align-top">
                      <Button size="sm" disabled={!changed || !r.canChange} loading={busy === r.role} onClick={() => save(r)}>
                        Save
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </main>
  );
}
