'use client';

import { Suspense, useEffect, useState } from 'react';
import { Users, Pencil, UserX, Plus, Download, ListPlus, PlusCircle, MinusCircle } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
// wave2 prefs: default terms from Preferences + attachments on the record
import { usePreferences } from '@/lib/usePreferences';
import AttachmentPanel from '@/components/AttachmentPanel';
import { formatCurrency } from '@/lib/money';
import { useFocusParam } from '@/lib/useFocusParam';
import { EntityNotes } from '@/components/lists/EntityNotes';
import { Help } from '@/components/Help';
import Link from 'next/link';
import { ShipToEditor, shipToRowsFrom, shipToRowsPayload, type ShipToRow } from '@/components/sales/ShipToEditor';
import type { ShipToAddress } from '@/lib/shipTo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  balance: string;
  isActive: boolean;
  terms: string | null;
  notes: string | null;
  customFields?: Record<string, string> | null;
  termsId?: string | null;
  salesTaxCodeId?: string | null;
  resaleNumber?: string | null;
  taxExemptionReason?: string | null;
  /** Default sales tax item (QB "Tax Item"). */
  taxRateId?: string | null;
  shipToAddresses?: ShipToAddress[] | null;
}

interface TaxRateOption {
  id: string;
  name: string;
  rate: string;
}

/** Terms / Sales Tax Code list entries (wave-2 lists). */
interface ListOption {
  id: string;
  name?: string;
  code?: string;
  description?: string | null;
  taxable?: boolean;
  isActive: boolean;
}

/** Custom-field definitions map from GET /api/custom-fields. */
interface CustomFieldDefs {
  customer: Array<{ name: string }>;
  vendor: Array<{ name: string }>;
  item: Array<{ name: string }>;
  invoice: Array<{ name: string }>;
}

const MAX_CUSTOM_FIELDS = 7;

interface CustomerFormState {
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  terms: string;
  termsId: string;
  salesTaxCodeId: string;
  resaleNumber: string;
  taxExemptionReason: string;
  taxRateId: string;
  notes: string;
}

const EMPTY_FORM: CustomerFormState = {
  displayName: '',
  companyName: '',
  email: '',
  phone: '',
  terms: 'net_30',
  termsId: '',
  salesTaxCodeId: '',
  resaleNumber: '',
  taxExemptionReason: '',
  taxRateId: '',
  notes: '',
};

function termsLabelFor(val: string | null) {
  return TERMS_OPTIONS.find((o) => o.value === val)?.label ?? val ?? '-';
}

const TERMS_OPTIONS = [
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_60', label: 'Net 60' },
  { value: 'net_90', label: 'Net 90' },
  { value: 'due_on_receipt', label: 'Due on Receipt' },
];

// ---------------------------------------------------------------------------
// Customer form (shared by add + edit modal)
// ---------------------------------------------------------------------------

function CustomerForm({
  form,
  onChange,
  customFieldNames,
  customValues,
  onCustomChange,
  termsList,
  taxCodes,
  taxRates,
  shipTos,
  onShipTosChange,
}: {
  form: CustomerFormState;
  onChange: (field: keyof CustomerFormState, value: string) => void;
  termsList: ListOption[];
  taxCodes: ListOption[];
  taxRates: TaxRateOption[];
  shipTos: ShipToRow[];
  onShipTosChange: (rows: ShipToRow[]) => void;
  /** Company-defined custom field names for customers (may be empty). */
  customFieldNames: string[];
  customValues: Record<string, string>;
  onCustomChange: (name: string, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="displayName">Display Name *</Label>
        <Input
          id="displayName"
          placeholder="e.g. Acme Corp"
          value={form.displayName}
          onChange={(e) => onChange('displayName', e.target.value)}
          required
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="companyName">Company Name</Label>
        <Input
          id="companyName"
          placeholder="e.g. Acme Corporation Ltd."
          value={form.companyName}
          onChange={(e) => onChange('companyName', e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="billing@example.com"
            value={form.email}
            onChange={(e) => onChange('email', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            type="tel"
            placeholder="(555) 123-4567"
            value={form.phone}
            onChange={(e) => onChange('phone', e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="terms">Payment Terms</Label>
          <Select id="terms" value={form.termsId} onChange={(e) => onChange('termsId', e.target.value)}>
            <option value="">{form.terms && !form.termsId ? `${termsLabelFor(form.terms)} (old setting)` : '—'}</option>
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
        <div>
          <Label htmlFor="taxCode">
            Sales tax code <Help term="sales-tax" />
          </Label>
          <Select id="taxCode" value={form.salesTaxCodeId} onChange={(e) => onChange('salesTaxCodeId', e.target.value)}>
            <option value="">—</option>
            {taxCodes
              .filter((t) => t.isActive || t.id === form.salesTaxCodeId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.taxable ? 'taxable' : 'not taxable'}
                </option>
              ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="taxItem">Tax item</Label>
        <Select id="taxItem" value={form.taxRateId} onChange={(e) => onChange('taxRateId', e.target.value)}>
          <option value="">—</option>
          {taxRates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-navy/50">New invoices and other sales forms for this customer use this tax.</p>
      </div>
      {form.salesTaxCodeId && taxCodes.find((t) => t.id === form.salesTaxCodeId)?.taxable === false && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="resaleNumber">Resale certificate no.</Label>
            <Input id="resaleNumber" maxLength={50} value={form.resaleNumber} onChange={(e) => onChange('resaleNumber', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="exemptReason">Why is this customer not taxed?</Label>
            <Input
              id="exemptReason"
              maxLength={100}
              placeholder="e.g. Reseller, Non-profit"
              value={form.taxExemptionReason}
              onChange={(e) => onChange('taxExemptionReason', e.target.value)}
            />
          </div>
        </div>
      )}
      <ShipToEditor rows={shipTos} onChange={onShipTosChange} />
      <div>
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          rows={3}
          placeholder="Internal notes about this customer..."
          value={form.notes}
          onChange={(e) => onChange('notes', e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30 placeholder:text-navy/30 resize-none"
        />
      </div>

      {customFieldNames.length > 0 && (
        <div className="border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-navy/50 mb-3">
            Custom Fields
          </p>
          <div className="grid grid-cols-2 gap-3">
            {customFieldNames.map((name) => (
              <div key={name}>
                <Label htmlFor={`cf-${name}`}>{name}</Label>
                <Input
                  id={`cf-${name}`}
                  value={customValues[name] ?? ''}
                  onChange={(e) => onCustomChange(name, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Define Custom Fields modal (QB "Define Fields" — customer list)
// ---------------------------------------------------------------------------

function DefineFieldsModal({
  open,
  onClose,
  initialNames,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initialNames: string[];
  onSaved: (names: string[]) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setNames(initialNames.length > 0 ? [...initialNames] : ['']);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSave() {
    const cleaned = names.map((n) => n.trim()).filter(Boolean);
    const lower = cleaned.map((n) => n.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      toast('Custom field names must be unique.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const defs = await api.patch<CustomFieldDefs>('/api/custom-fields', {
        customer: cleaned.map((name) => ({ name })),
      });
      toast('Custom fields updated.', 'success');
      onSaved(defs.customer.map((d) => d.name));
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save custom fields', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Define Custom Fields (Customers)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Save Fields</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-navy/70">
          Define up to {MAX_CUSTOM_FIELDS} custom fields for customers (e.g. Account Rep,
          Region, Referral Source). They appear on the customer form and as optional list
          columns. Removing a name hides the field; stored values are kept.
        </p>
        {names.map((name, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Input
              placeholder={`Field ${idx + 1} name`}
              value={name}
              maxLength={31}
              onChange={(e) =>
                setNames((prev) => prev.map((n, i) => (i === idx ? e.target.value : n)))
              }
            />
            <button
              type="button"
              onClick={() => setNames((prev) => prev.filter((_, i) => i !== idx))}
              disabled={names.length === 1}
              className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors"
              aria-label="Remove field"
            >
              <MinusCircle className="h-4 w-4" />
            </button>
          </div>
        ))}
        {names.length < MAX_CUSTOM_FIELDS && (
          <button
            type="button"
            onClick={() => setNames((prev) => [...prev, ''])}
            className="text-electric hover:text-electric/80 flex items-center gap-1 text-sm font-medium"
          >
            <PlusCircle className="h-4 w-4" /> Add field
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function CustomersPageContent() {
  const prefs = usePreferences();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Custom fields (definitions + per-modal values)
  const [customFieldNames, setCustomFieldNames] = useState<string[]>([]);
  const [showCustomCols, setShowCustomCols] = useState(false);
  const [defineOpen, setDefineOpen] = useState(false);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [addCustom, setAddCustom] = useState<Record<string, string>>({});
  const [addSaving, setAddSaving] = useState(false);

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [editForm, setEditForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [editCustom, setEditCustom] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);

  // Terms + Sales Tax Code lists (wave-2 lists)
  const [termsList, setTermsList] = useState<ListOption[]>([]);
  const [taxCodes, setTaxCodes] = useState<ListOption[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRateOption[]>([]);
  const [addShipTos, setAddShipTos] = useState<ShipToRow[]>([]);
  const [editShipTos, setEditShipTos] = useState<ShipToRow[]>([]);
  useEffect(() => {
    api
      .get<TaxRateOption[]>('/api/tax-rates')
      .then((d) => setTaxRates(Array.isArray(d) ? d : []))
      .catch(() => {});
    api
      .get<{ entries: ListOption[] }>('/api/lists/terms?includeInactive=true')
      .then((d) => setTermsList(d.entries))
      .catch(() => {});
    api
      .get<{ entries: ListOption[] }>('/api/lists/sales-tax-codes?includeInactive=true')
      .then((d) => setTaxCodes(d.entries))
      .catch(() => {});
  }, []);

  // Deactivate confirm modal
  const [deactivateTarget, setDeactivateTarget] = useState<Customer | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchCustomers() {
    setLoading(true);
    try {
      const url = includeInactive
        ? '/api/customers?includeInactive=true'
        : '/api/customers';
      const data = await api.get<Customer[]>(url);
      setCustomers(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load customers', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive]);

  // Load company-defined custom fields for customers (once).
  useEffect(() => {
    api
      .get<CustomFieldDefs>('/api/custom-fields')
      .then((defs) => setCustomFieldNames(defs.customer.map((d) => d.name)))
      .catch(() => {
        /* non-fatal — page works without custom fields */
      });
  }, []);

  /** Persist custom-field values for a customer (no-op when none defined). */
  async function saveCustomValues(
    customerId: string,
    values: Record<string, string>,
    opts?: { includeEmpty?: boolean },
  ) {
    if (customFieldNames.length === 0) return;
    const payload: Record<string, string> = {};
    for (const name of customFieldNames) {
      const v = (values[name] ?? '').trim();
      if (v !== '' || opts?.includeEmpty) payload[name] = v;
    }
    if (Object.keys(payload).length === 0) return;
    await api.post('/api/custom-fields/values', {
      entity: 'customer',
      id: customerId,
      values: payload,
    });
  }

  // ---------------------------------------------------------------------------
  // Add customer
  // ---------------------------------------------------------------------------

  function openAddModal() {
    // Preferences > Sales & Customers: default terms for new customers.
    setAddForm({ ...EMPTY_FORM, terms: prefs.company.defaultCustomerTerms });
    setAddShipTos([]);
    setAddCustom({});
    setAddOpen(true);
  }

  function updateAddForm(field: keyof CustomerFormState, value: string) {
    setAddForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleAdd() {
    if (!addForm.displayName.trim()) {
      toast('Display name is required', 'danger');
      return;
    }
    setAddSaving(true);
    try {
      const created = await api.post<Customer>('/api/customers', {
        displayName: addForm.displayName.trim(),
        companyName: addForm.companyName.trim() || undefined,
        email: addForm.email.trim() || undefined,
        phone: addForm.phone.trim() || undefined,
        termsId: addForm.termsId || undefined,
        salesTaxCodeId: addForm.salesTaxCodeId || undefined,
        resaleNumber: addForm.resaleNumber.trim() || undefined,
        taxExemptionReason: addForm.taxExemptionReason.trim() || undefined,
        taxRateId: addForm.taxRateId || undefined,
        shipToAddresses: shipToRowsPayload(addShipTos),
        notes: addForm.notes.trim() || undefined,
      });
      try {
        await saveCustomValues(created.id, addCustom);
      } catch (cfErr) {
        toast(
          cfErr instanceof ApiError
            ? `Customer created, but custom fields failed: ${cfErr.message}`
            : 'Customer created, but custom fields failed to save',
          'danger',
        );
      }
      toast('Customer created', 'success');
      setAddOpen(false);
      await fetchCustomers();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create customer', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit customer
  // ---------------------------------------------------------------------------

  function openEditModal(customer: Customer) {
    setEditTarget(customer);
    setEditForm({
      displayName: customer.displayName,
      companyName: customer.companyName ?? '',
      email: customer.email ?? '',
      phone: customer.phone ?? '',
      terms: customer.terms ?? '',
      termsId: customer.termsId ?? '',
      salesTaxCodeId: customer.salesTaxCodeId ?? '',
      resaleNumber: customer.resaleNumber ?? '',
      taxExemptionReason: customer.taxExemptionReason ?? '',
      taxRateId: customer.taxRateId ?? '',
      notes: customer.notes ?? '',
    });
    setEditShipTos(shipToRowsFrom(customer.shipToAddresses));
    setEditCustom({ ...(customer.customFields ?? {}) });
    setEditOpen(true);
  }

  // Auto-open the edit modal when arriving via global search (?focus=<id>)
  useFocusParam(customers, loading, openEditModal);

  function updateEditForm(field: keyof CustomerFormState, value: string) {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleEdit() {
    if (!editTarget) return;
    if (!editForm.displayName.trim()) {
      toast('Display name is required', 'danger');
      return;
    }
    setEditSaving(true);
    try {
      await api.patch(`/api/customers/${editTarget.id}`, {
        displayName: editForm.displayName.trim(),
        companyName: editForm.companyName.trim() || null,
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        // Terms change only when a Terms list entry is picked (an older setting is kept otherwise).
        ...(editForm.termsId ? { termsId: editForm.termsId } : {}),
        salesTaxCodeId: editForm.salesTaxCodeId || null,
        resaleNumber: editForm.resaleNumber.trim() || null,
        taxExemptionReason: editForm.taxExemptionReason.trim() || null,
        taxRateId: editForm.taxRateId || null,
        shipToAddresses: shipToRowsPayload(editShipTos),
        notes: editForm.notes.trim() || null,
      });
      try {
        // includeEmpty so cleared fields are removed from the stored map.
        await saveCustomValues(editTarget.id, editCustom, { includeEmpty: true });
      } catch (cfErr) {
        toast(
          cfErr instanceof ApiError
            ? `Customer updated, but custom fields failed: ${cfErr.message}`
            : 'Customer updated, but custom fields failed to save',
          'danger',
        );
      }
      toast('Customer updated', 'success');
      setEditOpen(false);
      setEditTarget(null);
      await fetchCustomers();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update customer', 'danger');
    } finally {
      setEditSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Deactivate customer
  // ---------------------------------------------------------------------------

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.del(`/api/customers/${deactivateTarget.id}`);
      toast(`${deactivateTarget.displayName} deactivated`, 'success');
      setDeactivateTarget(null);
      await fetchCustomers();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to deactivate customer', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const termsLabel = (c: Customer) =>
    (c.termsId ? termsList.find((t) => t.id === c.termsId)?.name : undefined) ?? termsLabelFor(c.terms);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Customers"
        icon={Users}
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-navy/60 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-slate-300 text-electric focus:ring-electric/40"
              />
              Show inactive
            </label>
            {customFieldNames.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-navy/60 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showCustomCols}
                  onChange={(e) => setShowCustomCols(e.target.checked)}
                  className="rounded border-slate-300 text-electric focus:ring-electric/40"
                />
                Show custom fields
              </label>
            )}
            <Button
              variant="secondary"
              onClick={() => setDefineOpen(true)}
              title="Define up to 7 custom fields for customers"
            >
              <ListPlus className="h-4 w-4" />
              Custom Fields
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open('/api/export/customers.csv', '_blank')}
              title="Export the customer list to CSV"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Link href="/lists/multiple?list=customers">
              <Button variant="secondary" title="Add or edit many customers at once (paste from Excel)">
                <ListPlus className="h-4 w-4" />
                Add/Edit Multiple
              </Button>
            </Link>
            <Button onClick={openAddModal}>
              <Plus className="h-4 w-4" />
              Add Customer
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title={includeInactive ? 'No customers found' : 'No customers yet'}
            message={
              includeInactive
                ? 'There are no customers, active or inactive.'
                : 'Add your first customer to get started.'
            }
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> Add Customer
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Terms</Th>
                {showCustomCols &&
                  customFieldNames.map((name) => <Th key={name}>{name}</Th>)}
                <Th numeric>Balance</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-semibold text-navy">{c.displayName}</Td>
                  <Td className="text-navy/70">{c.companyName ?? '-'}</Td>
                  <Td className="text-navy/70">
                    {c.email ? (
                      <a
                        href={`mailto:${c.email}`}
                        className="text-electric hover:underline"
                      >
                        {c.email}
                      </a>
                    ) : (
                      '-'
                    )}
                  </Td>
                  <Td className="text-navy/70">{c.phone ?? '-'}</Td>
                  <Td className="text-navy/70">{termsLabel(c)}</Td>
                  {showCustomCols &&
                    customFieldNames.map((name) => (
                      <Td key={name} className="text-navy/70">
                        {c.customFields?.[name] || '-'}
                      </Td>
                    ))}
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(c.balance)}
                  </Td>
                  <Td>
                    {c.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditModal(c)}
                        title="Edit customer"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      {c.isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeactivateTarget(c)}
                          title="Deactivate customer"
                          className="text-red-500 hover:bg-red-50"
                        >
                          <UserX className="h-3.5 w-3.5" />
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Add customer modal ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Customer"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Customer
            </Button>
          </>
        }
      >
        <CustomerForm
          form={addForm}
          onChange={updateAddForm}
          termsList={termsList}
          taxCodes={taxCodes}
          taxRates={taxRates}
          shipTos={addShipTos}
          onShipTosChange={setAddShipTos}
          customFieldNames={customFieldNames}
          customValues={addCustom}
          onCustomChange={(name, value) => setAddCustom((prev) => ({ ...prev, [name]: value }))}
        />
      </Modal>

      {/* ---- Edit customer modal ---- */}
      <Modal
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditTarget(null); }}
        title={`Edit: ${editTarget?.displayName ?? ''}`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => { setEditOpen(false); setEditTarget(null); }}
              disabled={editSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleEdit} loading={editSaving}>
              Save Changes
            </Button>
          </>
        }
      >
        <CustomerForm
          form={editForm}
          onChange={updateEditForm}
          termsList={termsList}
          taxCodes={taxCodes}
          taxRates={taxRates}
          shipTos={editShipTos}
          onShipTosChange={setEditShipTos}
          customFieldNames={customFieldNames}
          customValues={editCustom}
          onCustomChange={(name, value) => setEditCustom((prev) => ({ ...prev, [name]: value }))}
        />
        {editTarget && <EntityNotes entityType="customer" entityId={editTarget.id} />}
        <AttachmentPanel className="mt-4" entityType="customer" entityId={editTarget?.id} />
      </Modal>

      {/* ---- Define custom fields modal ---- */}
      <DefineFieldsModal
        open={defineOpen}
        onClose={() => setDefineOpen(false)}
        initialNames={customFieldNames}
        onSaved={(names) => {
          setCustomFieldNames(names);
          fetchCustomers();
        }}
      />

      {/* ---- Deactivate confirm modal ---- */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Customer"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <strong className="text-navy">{deactivateTarget?.displayName}</strong>? They will no
            longer appear in active customer lists, but all historical invoices and payments will
            be preserved.
          </>
        }
        confirmLabel="Yes, Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </main>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageContent />
    </Suspense>
  );
}
