'use client';

/**
 * Merge Duplicates page — /merge
 *
 * Lets the user select a record type (customer, vendor, or account), choose a
 * "From" (duplicate to fold away) and a "To" (master to keep), review a
 * prominent warning, then confirm the irreversible merge.
 *
 * The merge service handles all reassignment and deactivation in a single
 * database transaction. Customer/vendor merges never touch the GL; account
 * merges re-point the journal lines themselves and recompute the survivor's
 * cached balance (same-type accounts only).
 */
import { useEffect, useState, useCallback } from 'react';
import { GitMerge, AlertTriangle } from 'lucide-react';
import {
  Button,
  Card,
  Label,
  Select,
  PageHeader,
  Modal,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
  companyName: string | null;
  isActive: boolean;
}

interface Vendor {
  id: string;
  displayName: string;
  companyName: string | null;
  isActive: boolean;
}

interface GLAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
}

type RecordType = 'customer' | 'vendor' | 'account' | 'item' | 'class' | 'employee' | 'other_name';

const TYPE_LABEL: Record<RecordType, string> = {
  customer: 'customer',
  vendor: 'vendor',
  account: 'account',
  item: 'item',
  class: 'class',
  employee: 'employee',
  other_name: 'other name',
};

const TYPE_PLURAL: Record<RecordType, string> = {
  customer: 'Customers',
  vendor: 'Vendors',
  account: 'Accounts',
  item: 'Items',
  class: 'Classes',
  employee: 'Employees',
  other_name: 'Other Names',
};

/** Wave-2 lists: the extra mergeable lists and how to load them. */
const EXTRA_SOURCES: Partial<Record<RecordType, { url: string; pick: (data: unknown) => RecordOption[] }>> = {
  item: {
    url: '/api/items',
    pick: (d) =>
      ((d as { items: Array<{ id: string; name: string; type: string }> }).items ?? []).map((i) => ({
        id: i.id,
        label: `${i.name} (${i.type.replace('_', ' ')})`,
        accountType: i.type,
      })),
  },
  class: {
    url: '/api/classes',
    pick: (d) => ((d as Array<{ id: string; name: string; isActive: boolean }>) ?? []).filter((c) => c.isActive).map((c) => ({ id: c.id, label: c.name })),
  },
  employee: {
    url: '/api/employees',
    pick: (d) =>
      ((d as Array<{ id: string; firstName: string; lastName: string; isActive: boolean }>) ?? [])
        .filter((e) => e.isActive)
        .map((e) => ({ id: e.id, label: `${e.firstName} ${e.lastName}` })),
  },
  other_name: {
    url: '/api/lists/other-names',
    pick: (d) => ((d as { entries: Array<{ id: string; name: string }> }).entries ?? []).map((o) => ({ id: o.id, label: o.name })),
  },
};

interface MergeResult {
  deactivatedId: string;
  reassigned: Record<string, number>;
  /** Account merges only: the survivor's recomputed balance. */
  newBalance?: string;
}

/** Uniform option shape across the three record types. */
interface RecordOption {
  id: string;
  label: string;
  /** GL account type (asset/liability/...) — undefined for customers/vendors. */
  accountType?: string;
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function ConfirmMergeModal({
  open,
  onClose,
  onConfirm,
  type,
  fromName,
  toName,
  merging,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  type: RecordType;
  fromName: string;
  toName: string;
  merging: boolean;
}) {
  const entity = TYPE_LABEL[type];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm Merge"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={merging}>
            Yes, Merge
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Warning banner */}
        <div className="flex items-start gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700">
            <p className="font-semibold mb-1">This action cannot be undone.</p>
            <p>
              All documents belonging to the <strong>From</strong> {entity} will be permanently
              reassigned to the <strong>To</strong> {entity}. The From {entity} will be
              deactivated.
            </p>
          </div>
        </div>

        {/* Summary table */}
        <div className="rounded-lg border border-slate-200 overflow-hidden text-sm">
          <div className="grid grid-cols-2 divide-x divide-slate-200">
            <div className="p-4 bg-red-50/50">
              <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">
                From (will be deactivated)
              </p>
              <p className="font-medium text-navy">{fromName}</p>
            </div>
            <div className="p-4 bg-emerald/10">
              <p className="text-xs font-semibold text-emerald uppercase tracking-wide mb-1">
                To (master record)
              </p>
              <p className="font-medium text-navy">{toName}</p>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

function ResultSummary({ result, type }: { result: MergeResult; type: RecordType }) {
  const entries = Object.entries(result.reassigned).filter(([, count]) => count > 0);
  return (
    <div className="rounded-lg border border-emerald/30 bg-emerald/10 px-4 py-3 text-sm text-emerald space-y-1">
      <p className="font-semibold">Merge complete.</p>
      {entries.length > 0 ? (
        <ul className="list-disc list-inside space-y-0.5">
          {entries.map(([key, count]) => (
            <li key={key}>
              {count} {key.replace(/([A-Z])/g, ' $1').toLowerCase()} reassigned
            </li>
          ))}
        </ul>
      ) : (
        <p>No linked documents found — {type} deactivated with nothing to reassign.</p>
      )}
      {result.newBalance !== undefined && (
        <p>
          Surviving account balance recomputed: <strong>{formatCurrency(result.newBalance)}</strong>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MergePage() {
  const [recordType, setRecordType] = useState<RecordType>('customer');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [glAccounts, setGlAccounts] = useState<GLAccount[]>([]);
  const [loading, setLoading] = useState(false);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');

  const [showConfirm, setShowConfirm] = useState(false);
  const [merging, setMerging] = useState(false);
  const [lastResult, setLastResult] = useState<MergeResult | null>(null);
  const [extraRecords, setExtraRecords] = useState<RecordOption[]>([]);

  const fetchExtra = useCallback(async (type: RecordType) => {
    const src = EXTRA_SOURCES[type];
    if (!src) return;
    setLoading(true);
    try {
      setExtraRecords(src.pick(await api.get<unknown>(src.url)));
    } catch {
      toast(`Failed to load ${TYPE_PLURAL[type].toLowerCase()}.`, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Customer[]>('/api/customers');
      setCustomers(data);
    } catch {
      toast('Failed to load customers.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Vendor[]>('/api/vendors');
      setVendors(data);
    } catch {
      toast('Failed to load vendors.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchGlAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<GLAccount[]>('/api/accounts');
      setGlAccounts(data.filter((a) => a.isActive));
    } catch {
      toast('Failed to load accounts.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCustomers();
    fetchVendors();
    fetchGlAccounts();
  }, [fetchCustomers, fetchVendors, fetchGlAccounts]);

  // Reset selections when type changes.
  useEffect(() => {
    setFromId('');
    setToId('');
    setLastResult(null);
    setExtraRecords([]);
    void fetchExtra(recordType);
  }, [recordType, fetchExtra]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const records: RecordOption[] = EXTRA_SOURCES[recordType]
    ? extraRecords
    : recordType === 'account'
      ? glAccounts.map((a) => ({
          id: a.id,
          label: `${a.code} · ${a.name} (${a.type})`,
          accountType: a.type,
        }))
      : (recordType === 'customer' ? customers : vendors).map((r) => ({
          id: r.id,
          label:
            r.companyName && r.companyName !== r.displayName
              ? `${r.displayName} — ${r.companyName}`
              : r.displayName,
        }));

  function nameFor(id: string) {
    return records.find((r) => r.id === id)?.label ?? id;
  }

  function accountTypeFor(id: string) {
    return records.find((r) => r.id === id)?.accountType;
  }

  /** Account merges require matching GL types (asset↔asset, expense↔expense, …). */
  const typeMismatch =
    (recordType === 'account' || recordType === 'item') &&
    !!fromId &&
    !!toId &&
    fromId !== toId &&
    accountTypeFor(fromId) !== accountTypeFor(toId);

  function canMerge() {
    return fromId && toId && fromId !== toId && !typeMismatch;
  }

  // ---------------------------------------------------------------------------
  // Merge action
  // ---------------------------------------------------------------------------

  async function handleMerge() {
    setMerging(true);
    try {
      const result = await api.post<MergeResult>('/api/merge', {
        type: recordType,
        fromId,
        toId,
      });
      setLastResult(result);
      toast(
        `Merge complete. "${nameFor(fromId)}" has been deactivated.`,
        'success',
      );
      setShowConfirm(false);
      setFromId('');
      setToId('');
      // Refresh lists so the deactivated record disappears.
      if (recordType === 'customer') {
        fetchCustomers();
      } else if (recordType === 'vendor') {
        fetchVendors();
      } else if (EXTRA_SOURCES[recordType]) {
        fetchExtra(recordType);
      } else {
        fetchGlAccounts();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Merge failed.', 'danger');
    } finally {
      setMerging(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Merge Duplicates" icon={GitMerge} />

      <Card className="p-6 max-w-xl">
        <p className="text-sm text-navy/60 mb-6">
          Merge a duplicate customer, vendor, GL account, item, class, employee or other name into
          its master record. Everything that used the duplicate (invoices, bills, payments, price
          lists, notes...) moves to the master. Account merges also move the journal history and
          require both accounts to be the same type; items must be the same type and keep their
          value in the same inventory account. The duplicate will be made inactive. This cannot be
          undone.
        </p>

        {/* Record type */}
        <div className="mb-5">
          <Label htmlFor="merge-type">Record Type</Label>
          <Select
            id="merge-type"
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as RecordType)}
          >
            <option value="customer">Customer</option>
            <option value="vendor">Vendor</option>
            <option value="account">Account</option>
            <option value="item">Item</option>
            <option value="class">Class</option>
            <option value="employee">Employee</option>
            <option value="other_name">Other name</option>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-navy/40 py-6">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : (
          <>
            {/* From */}
            <div className="mb-5">
              <Label htmlFor="merge-from">
                From{' '}
                <span className="text-red-500 font-normal">(duplicate — will be deactivated)</span>
              </Label>
              <Select
                id="merge-from"
                value={fromId}
                onChange={(e) => {
                  setFromId(e.target.value);
                  setLastResult(null);
                }}
              >
                <option value="">Select {recordType}…</option>
                {records
                  .filter((r) => r.id !== toId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
              </Select>
            </div>

            {/* To */}
            <div className="mb-6">
              <Label htmlFor="merge-to">
                To{' '}
                <span className="text-emerald font-normal">(master — will be kept)</span>
              </Label>
              <Select
                id="merge-to"
                value={toId}
                onChange={(e) => {
                  setToId(e.target.value);
                  setLastResult(null);
                }}
              >
                <option value="">Select {recordType}…</option>
                {records
                  .filter((r) => r.id !== fromId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
              </Select>
            </div>

            {/* Account merges require matching GL types */}
            {typeMismatch && (
              <p className="text-sm text-red-500 mb-5">
                {recordType === 'item' ? 'Items' : 'Accounts'} must be the same type to merge ({accountTypeFor(fromId)} vs{' '}
                {accountTypeFor(toId)}).
              </p>
            )}

            {/* Inline warning when selections are made */}
            {fromId && toId && fromId !== toId && !typeMismatch && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800 mb-5">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <span>
                  <strong>{nameFor(fromId)}</strong> will be merged into{' '}
                  <strong>{nameFor(toId)}</strong> and then deactivated. All linked documents will
                  move to <strong>{nameFor(toId)}</strong>.
                </span>
              </div>
            )}

            {fromId === toId && fromId !== '' && (
              <p className="text-sm text-red-500 mb-5">
                From and To must be different {recordType}s.
              </p>
            )}

            <Button
              variant="danger"
              disabled={!canMerge()}
              onClick={() => setShowConfirm(true)}
            >
              <GitMerge className="h-4 w-4" />
              Merge {TYPE_PLURAL[recordType]}
            </Button>

            {/* Result summary */}
            {lastResult && (
              <div className="mt-5">
                <ResultSummary result={lastResult} type={recordType} />
              </div>
            )}
          </>
        )}
      </Card>

      {/* Confirmation dialog */}
      <ConfirmMergeModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleMerge}
        type={recordType}
        fromName={nameFor(fromId)}
        toName={nameFor(toId)}
        merging={merging}
      />
    </main>
  );
}
