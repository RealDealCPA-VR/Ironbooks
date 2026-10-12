'use client';

import { Suspense, useEffect, useState } from 'react';
import {
  Truck,
  Pencil,
  Trash2,
  Plus,
  Phone,
  Mail,
  Download,
} from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { useFocusParam } from '@/lib/useFocusParam';
import { EntityNotes } from '@/components/lists/EntityNotes';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  terms: string | null;
  is1099: boolean;
  balance: string;
  isActive: boolean;
  notes: string | null;
  termsId?: string | null;
  /** wave2 purchases: check / pre-fill / currency fields. */
  printOnCheckAs?: string | null;
  accountNumber?: string | null;
  currency?: string | null;
  prefillAccountIds?: string[] | null;
}

interface TermsOption {
  id: string;
  name: string;
  isActive: boolean;
}

interface AccountOption {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
}

interface CurrencyOption {
  code: string;
  name: string;
  isBase: boolean;
}

interface VendorFormState {
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  terms: string;
  termsId: string;
  is1099: boolean;
  notes: string;
  printOnCheckAs: string;
  accountNumber: string;
  currency: string;
  /** Always three slots; '' = unused. */
  prefillAccountIds: [string, string, string];
}

const EMPTY_FORM: VendorFormState = {
  displayName: '',
  companyName: '',
  email: '',
  phone: '',
  terms: 'net_30',
  termsId: '',
  is1099: false,
  notes: '',
  printOnCheckAs: '',
  accountNumber: '',
  currency: '',
  prefillAccountIds: ['', '', ''],
};

const TERMS_OPTIONS = [
  { value: 'due_on_receipt', label: 'Due on Receipt' },
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_45', label: 'Net 45' },
  { value: 'net_60', label: 'Net 60' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function termsLabel(terms: string | null): string {
  if (!terms) return '';
  const found = TERMS_OPTIONS.find((o) => o.value === terms);
  return found ? found.label : terms;
}

function balanceTone(balance: string): 'danger' | 'neutral' {
  return Number(balance) > 0 ? 'danger' : 'neutral';
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function VendorsPageContent() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [currencyOptions, setCurrencyOptions] = useState<CurrencyOption[]>([]);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Terms list (wave-2 lists)
  const [termsList, setTermsList] = useState<TermsOption[]>([]);
  useEffect(() => {
    api
      .get<{ entries: TermsOption[] }>('/api/lists/terms?includeInactive=true')
      .then((d) => setTermsList(d.entries))
      .catch(() => {});
  }, []);

  // Deactivate confirm
  const [deactivateTarget, setDeactivateTarget] = useState<Vendor | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // ---- Fetch ----
  async function fetchVendors() {
    setLoading(true);
    try {
      const data = await api.get<Vendor[]>('/api/vendors');
      setVendors(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load vendors';
      toast(message, 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchVendors();
    // Lists for the pre-fill account and currency pickers (non-fatal if unavailable).
    api
      .get<AccountOption[]>('/api/accounts')
      .then((rows) => setAccountOptions(rows.filter((a) => a.isActive !== false)))
      .catch(() => setAccountOptions([]));
    api
      .get<CurrencyOption[]>('/api/currencies')
      .then(setCurrencyOptions)
      .catch(() => setCurrencyOptions([]));
  }, []);

  // ---- Open Add modal ----
  function openAdd() {
    setEditingVendor(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  // ---- Open Edit modal ----
  function openEdit(vendor: Vendor) {
    setEditingVendor(vendor);
    setForm({
      displayName: vendor.displayName,
      companyName: vendor.companyName ?? '',
      email: vendor.email ?? '',
      phone: vendor.phone ?? '',
      terms: vendor.terms ?? '',
      termsId: vendor.termsId ?? '',
      is1099: vendor.is1099,
      notes: vendor.notes ?? '',
      printOnCheckAs: vendor.printOnCheckAs ?? '',
      accountNumber: vendor.accountNumber ?? '',
      currency: vendor.currency ?? '',
      prefillAccountIds: [0, 1, 2].map((i) => vendor.prefillAccountIds?.[i] ?? '') as [string, string, string],
    });
    setModalOpen(true);
  }

  // Auto-open the edit modal when arriving via global search (?focus=<id>)
  useFocusParam(vendors, loading, openEdit);

  function closeModal() {
    setModalOpen(false);
    setEditingVendor(null);
    setForm(EMPTY_FORM);
  }

  // ---- Field change handler ----
  function setField<K extends keyof VendorFormState>(key: K, value: VendorFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setPrefill(index: number, accountId: string) {
    setForm((prev) => {
      const next = [...prev.prefillAccountIds] as [string, string, string];
      next[index] = accountId;
      return { ...prev, prefillAccountIds: next };
    });
  }

  const foreignCurrencies = currencyOptions.filter((c) => !c.isBase);

  // ---- Save (create or update) ----
  async function handleSave() {
    if (!form.displayName.trim()) {
      toast('Display name is required.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        displayName: form.displayName.trim(),
        companyName: form.companyName.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        // Terms change only when a Terms list entry is picked (an older setting is kept otherwise).
        ...(form.termsId ? { termsId: form.termsId } : {}),
        is1099: form.is1099,
        notes: form.notes.trim() || null,
        printOnCheckAs: form.printOnCheckAs.trim() || null,
        accountNumber: form.accountNumber.trim() || null,
        currency: form.currency || null,
        prefillAccountIds: [...new Set(form.prefillAccountIds.filter(Boolean))],
      };

      if (editingVendor) {
        await api.patch(`/api/vendors/${editingVendor.id}`, payload);
        toast('Vendor updated.', 'success');
      } else {
        await api.post('/api/vendors', payload);
        toast('Vendor created.', 'success');
      }

      closeModal();
      await fetchVendors();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save vendor';
      toast(message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  // ---- Deactivate ----
  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.del(`/api/vendors/${deactivateTarget.id}`);
      toast(`"${deactivateTarget.displayName}" deactivated.`, 'success');
      setDeactivateTarget(null);
      await fetchVendors();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to deactivate vendor';
      toast(message, 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Vendors"
        icon={Truck}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => window.open('/api/export/vendors.csv', '_blank')}
              title="Export the vendor list to CSV"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Link href="/lists/multiple?list=vendors">
              <Button variant="secondary" title="Add or edit many vendors at once (paste from Excel)">
                Add/Edit Multiple
              </Button>
            </Link>
            <Button onClick={openAdd}>
              <Plus className="h-4 w-4" />
              Add Vendor
            </Button>
          </div>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40 text-sm gap-2">
            <Spinner className="h-5 w-5 text-electric" />
            Loading vendors...
          </div>
        ) : vendors.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No vendors yet"
            message="Add the businesses you buy from to start entering bills and expenses."
            action={
              <Button variant="secondary" size="sm" onClick={openAdd}>
                <Plus className="h-4 w-4" />
                Add your first vendor
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Terms</Th>
                <Th>1099</Th>
                <Th numeric>Balance</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <Tr key={v.id}>
                  <Td>
                    <div className="font-semibold text-navy">{v.displayName}</div>
                    {v.companyName && (
                      <div className="text-xs text-navy/50 mt-0.5">{v.companyName}</div>
                    )}
                  </Td>
                  <Td>
                    {v.email ? (
                      <a
                        href={`mailto:${v.email}`}
                        className="inline-flex items-center gap-1 text-electric hover:underline text-sm"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        {v.email}
                      </a>
                    ) : (
                      <span className="text-navy/30 text-sm">—</span>
                    )}
                  </Td>
                  <Td>
                    {v.phone ? (
                      <span className="inline-flex items-center gap-1 text-sm text-navy/70">
                        <Phone className="h-3.5 w-3.5 text-navy/40" />
                        {v.phone}
                      </span>
                    ) : (
                      <span className="text-navy/30 text-sm">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-sm text-navy/70">
                      {(v.termsId ? termsList.find((t) => t.id === v.termsId)?.name : undefined) ?? termsLabel(v.terms)}
                    </span>
                  </Td>
                  <Td>
                    {v.is1099 ? (
                      <Badge tone="warning">1099</Badge>
                    ) : (
                      <span className="text-navy/30 text-sm">—</span>
                    )}
                  </Td>
                  <Td numeric>
                    <span
                      className={
                        Number(v.balance) > 0
                          ? 'font-semibold text-red-500'
                          : 'text-navy/60'
                      }
                    >
                      {formatCurrency(v.balance)}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(v)}
                        title="Edit vendor"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-600 hover:bg-red-50"
                        onClick={() => setDeactivateTarget(v)}
                        title="Deactivate vendor"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Add / Edit Modal ---- */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingVendor ? 'Edit Vendor' : 'Add Vendor'}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editingVendor ? 'Save Changes' : 'Create Vendor'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Display Name */}
          <div>
            <Label htmlFor="displayName">
              Display Name <span className="text-red-400">*</span>
            </Label>
            <Input
              id="displayName"
              autoFocus
              placeholder="e.g. Acme Supplies"
              value={form.displayName}
              onChange={(e) => setField('displayName', e.target.value)}
            />
          </div>

          {/* Company Name */}
          <div>
            <Label htmlFor="companyName">Company Name</Label>
            <Input
              id="companyName"
              placeholder="e.g. Acme Corp LLC"
              value={form.companyName}
              onChange={(e) => setField('companyName', e.target.value)}
            />
          </div>

          {/* Email & Phone side-by-side */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="vendor@example.com"
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 000-0000"
                value={form.phone}
                onChange={(e) => setField('phone', e.target.value)}
              />
            </div>
          </div>

          {/* Payment Terms */}
          <div>
            <Label htmlFor="terms">Payment Terms</Label>
            <Select id="terms" value={form.termsId} onChange={(e) => setField('termsId', e.target.value)}>
              <option value="">{form.terms && !form.termsId ? `${termsLabel(form.terms)} (old setting)` : '—'}</option>
              {termsList
                .filter((t) => t.isActive || t.id === form.termsId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
            <p className="mt-1 text-xs text-navy/50">
              Edit the choices on the <Link href="/lists?list=terms" className="text-electric hover:underline">Terms list</Link>.
            </p>
          </div>

          {/* Check printing (QB "Print on check as" + account number on the memo line) */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="printOnCheckAs">Print on check as</Label>
              <Input
                id="printOnCheckAs"
                placeholder={form.displayName.trim() || 'Same as display name'}
                value={form.printOnCheckAs}
                onChange={(e) => setField('printOnCheckAs', e.target.value)}
              />
              <p className="text-xs text-navy/50 mt-1">The name printed on the &quot;Pay to the order of&quot; line.</p>
            </div>
            <div>
              <Label htmlFor="accountNumber">Account no. (printed on check memo)</Label>
              <Input
                id="accountNumber"
                placeholder="Your account number with this vendor"
                value={form.accountNumber}
                onChange={(e) => setField('accountNumber', e.target.value)}
              />
              <p className="text-xs text-navy/50 mt-1">Shown on the memo line when a check has no memo.</p>
            </div>
          </div>

          {/* Pre-fill accounts */}
          <div>
            <Label>Pre-fill accounts</Label>
            <p className="text-xs text-navy/50 mb-2">
              Up to three accounts filled in automatically when you enter a bill, check or card charge for
              this vendor.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <Select
                  key={i}
                  aria-label={`Pre-fill account ${i + 1}`}
                  value={form.prefillAccountIds[i]}
                  onChange={(e) => setPrefill(i, e.target.value)}
                >
                  <option value="">— none —</option>
                  {accountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} – {a.name}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          </div>

          {/* Currency (multi-currency) */}
          {foreignCurrencies.length > 0 && (
            <div>
              <Label htmlFor="currency">Currency</Label>
              <Select
                id="currency"
                value={form.currency}
                onChange={(e) => setField('currency', e.target.value)}
              >
                <option value="">Home currency</option>
                {foreignCurrencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} – {c.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-navy/50 mt-1">
                Bills and checks for this vendor are entered in this currency. It can&apos;t be changed once
                the vendor has transactions.
              </p>
            </div>
          )}

          {/* 1099 Contractor */}
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 bg-slate-50">
            <input
              id="is1099"
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-electric accent-electric cursor-pointer"
              checked={form.is1099}
              onChange={(e) => setField('is1099', e.target.checked)}
            />
            <div>
              <label
                htmlFor="is1099"
                className="text-sm font-medium text-navy cursor-pointer select-none"
              >
                1099 Contractor
              </label>
              <p className="text-xs text-navy/50 mt-0.5">
                Mark this vendor as a 1099-MISC contractor for year-end reporting.
              </p>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              rows={3}
              placeholder="Internal notes about this vendor…"
              value={form.notes}
              onChange={(e) => setField('notes', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30 placeholder:text-navy/30 resize-none"
            />
          </div>
          {editingVendor && <EntityNotes entityType="vendor" entityId={editingVendor.id} />}
        </div>
      </Modal>

      {/* ---- Deactivate Confirm ---- */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Vendor"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <strong>{deactivateTarget?.displayName}</strong>? The vendor will be hidden
            from active lists but existing bills and expenses will be preserved.
          </>
        }
        confirmLabel="Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </main>
  );
}

export default function VendorsPage() {
  return (
    <Suspense fallback={null}>
      <VendorsPageContent />
    </Suspense>
  );
}
