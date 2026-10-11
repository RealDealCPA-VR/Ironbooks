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
// wave2 prefs: default terms from Preferences + attachments on the record
import { usePreferences } from '@/lib/usePreferences';
import AttachmentPanel from '@/components/AttachmentPanel';
import { formatCurrency } from '@/lib/money';
import { useFocusParam } from '@/lib/useFocusParam';

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
}

interface VendorFormState {
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  terms: string;
  is1099: boolean;
  notes: string;
}

const EMPTY_FORM: VendorFormState = {
  displayName: '',
  companyName: '',
  email: '',
  phone: '',
  terms: 'net_30',
  is1099: false,
  notes: '',
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
  const prefs = usePreferences();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

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
  }, []);

  // ---- Open Add modal ----
  function openAdd() {
    setEditingVendor(null);
    // Preferences > Bills: default terms for new vendors.
    setForm({ ...EMPTY_FORM, terms: prefs.company.defaultVendorTerms });
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
      terms: vendor.terms ?? 'net_30',
      is1099: vendor.is1099,
      notes: vendor.notes ?? '',
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
        terms: form.terms || null,
        is1099: form.is1099,
        notes: form.notes.trim() || null,
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
                    <span className="text-sm text-navy/70">{termsLabel(v.terms)}</span>
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
            <Select
              id="terms"
              value={form.terms}
              onChange={(e) => setField('terms', e.target.value)}
            >
              {TERMS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

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
          {editingVendor && <AttachmentPanel entityType="vendor" entityId={editingVendor.id} />}
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
