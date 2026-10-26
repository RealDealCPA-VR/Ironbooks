'use client';

import { Suspense, useEffect, useState } from 'react';
import {
  Package,
  Plus,
  Pencil,
  PowerOff,
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
import { formatCurrency } from '@/lib/money';
import { isInventoryAssetAccount } from '@/lib/accountTypes';
import { useFocusParam } from '@/lib/useFocusParam';
import { usePreferences } from '@/lib/usePreferences';
import Link from 'next/link';
import { Help } from '@/components/Help';

// ── Types ─────────────────────────────────────────────────────────────────────

type ItemType =
  | 'service' | 'inventory' | 'non_inventory' | 'bundle'
  | 'other_charge' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

interface Item {
  id: string;
  name: string;
  sku: string | null;
  type: ItemType;
  description: string | null;
  salesPrice: string | null;
  purchaseCost: string | null;
  reorderPoint: string | null;
  taxable: boolean;
  isActive: boolean;
  unitOfMeasure: string | null;
  quantityOnHand: string | null;
  averageCost: string | null;
  incomeAccountId: string | null;
  expenseAccountId: string | null;
  assetAccountId: string | null;
  barcode?: string | null;
  trackingMode?: string | null;
  weight?: string | null;
  preferredVendorId?: string | null;
  salesTaxCodeId?: string | null;
  uomSetId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Wave-2 lists: pick-list entries (vendors, sales tax codes, U/M sets). */
interface PickOption {
  id: string;
  label: string;
  taxable?: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
}

interface FormState {
  name: string;
  type: ItemType;
  description: string;
  salesPrice: string;
  purchaseCost: string;
  reorderPoint: string;
  sku: string;
  unitOfMeasure: string;
  taxable: boolean;
  incomeAccountId: string;
  expenseAccountId: string;
  assetAccountId: string;
  // Advanced Inventory
  barcode: string;
  trackingMode: 'none' | 'serial' | 'lot';
  weight: string;
  // Wave-2 lists
  preferredVendorId: string;
  salesTaxCodeId: string;
  uomSetId: string;
  openingQuantity: string;
  openingValue: string;
  openingAsOf: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'service',
  description: '',
  salesPrice: '',
  purchaseCost: '',
  reorderPoint: '',
  sku: '',
  unitOfMeasure: '',
  taxable: true,
  incomeAccountId: '',
  expenseAccountId: '',
  assetAccountId: '',
  barcode: '',
  trackingMode: 'none',
  weight: '',
  preferredVendorId: '',
  salesTaxCodeId: '',
  uomSetId: '',
  openingQuantity: '',
  openingValue: '',
  openingAsOf: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ItemType, string> = {
  service: 'Service',
  inventory: 'Inventory',
  non_inventory: 'Non-Inventory',
  bundle: 'Bundle',
  other_charge: 'Other Charge',
  discount: 'Discount',
  subtotal: 'Subtotal',
  payment: 'Payment',
  sales_tax: 'Sales Tax',
};

const TYPE_TONES: Record<ItemType, 'info' | 'success' | 'warning' | 'neutral' | 'danger'> = {
  service: 'info',
  inventory: 'success',
  non_inventory: 'warning',
  bundle: 'neutral',
  other_charge: 'info',
  discount: 'danger',
  subtotal: 'neutral',
  payment: 'success',
  sales_tax: 'warning',
};

/** Special line-helper types never carry prices/accounts the same way. */
const NON_POSTING_TYPES: ItemType[] = ['subtotal'];
const NO_ACCOUNT_TYPES: ItemType[] = ['subtotal', 'payment'];

// ── Page ──────────────────────────────────────────────────────────────────────

function ItemsPageContent() {
  const { company: prefs } = usePreferences();
  const [items, setItems] = useState<Item[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Pick lists for preferred vendor, sales tax code and U/M set (wave-2 lists)
  const [vendorOptions, setVendorOptions] = useState<PickOption[]>([]);
  const [taxCodeOptions, setTaxCodeOptions] = useState<PickOption[]>([]);
  const [uomOptions, setUomOptions] = useState<PickOption[]>([]);
  useEffect(() => {
    api
      .get<Array<{ id: string; displayName: string }>>('/api/vendors')
      .then((v) => setVendorOptions(v.map((x) => ({ id: x.id, label: x.displayName }))))
      .catch(() => {});
    api
      .get<{ entries: Array<{ id: string; code: string; taxable: boolean }> }>('/api/lists/sales-tax-codes')
      .then((d) => setTaxCodeOptions(d.entries.map((x) => ({ id: x.id, label: x.code, taxable: x.taxable }))))
      .catch(() => {});
    api
      .get<{ sets: Array<{ id: string; name: string; baseUnitName: string }> }>('/api/uom-sets')
      .then((d) => setUomOptions(d.sets.map((x) => ({ id: x.id, label: `${x.name} (${x.baseUnitName})` }))))
      .catch(() => {});
  }, []);

  // Deactivate confirmation
  const [confirmItem, setConfirmItem] = useState<Item | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  async function fetchItems() {
    setLoading(true);
    try {
      const [data, acctList] = await Promise.all([
        api.get<{ items: Item[] }>('/api/items'),
        api.get<Account[]>('/api/accounts'),
      ]);
      setItems(data.items);
      setAccounts(acctList);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load items.', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchItems();
  }, []);

  const incomeAccounts = accounts.filter((a) => a.type === 'revenue');
  const expenseAccounts = accounts.filter((a) => a.type === 'expense');
  // QB: an inventory item's Asset Account is an Other Current Asset (never a bank / Undeposited Funds).
  const assetAccounts = accounts.filter((a) => isInventoryAssetAccount(a));

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function openCreate() {
    setEditingItem(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(item: Item) {
    setEditingItem(item);
    setForm({
      name: item.name,
      type: item.type,
      description: item.description ?? '',
      salesPrice: item.salesPrice ?? '',
      purchaseCost: item.purchaseCost ?? '',
      reorderPoint: item.reorderPoint ?? '',
      sku: item.sku ?? '',
      unitOfMeasure: item.unitOfMeasure ?? '',
      taxable: item.taxable,
      incomeAccountId: item.incomeAccountId ?? '',
      expenseAccountId: item.expenseAccountId ?? '',
      assetAccountId: item.assetAccountId ?? '',
      barcode: item.barcode ?? '',
      trackingMode: (item.trackingMode as FormState['trackingMode']) ?? 'none',
      weight: item.weight != null ? String(Number(item.weight)) : '',
      preferredVendorId: item.preferredVendorId ?? '',
      salesTaxCodeId: item.salesTaxCodeId ?? '',
      uomSetId: item.uomSetId ?? '',
      openingQuantity: '',
      openingValue: '',
      openingAsOf: '',
    });
    setModalOpen(true);
  }

  // Auto-open the edit modal when arriving via global search (?focus=<id>)
  useFocusParam(items, loading, openEdit);

  function closeModal() {
    setModalOpen(false);
    setEditingItem(null);
    setForm(EMPTY_FORM);
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // ── Submit (create / edit) ─────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast('Item name is required.', 'danger');
      return;
    }

    const nonPosting = NON_POSTING_TYPES.includes(form.type);
    const noAccounts = NO_ACCOUNT_TYPES.includes(form.type);
    const payload = {
      name: form.name.trim(),
      type: form.type,
      description: form.description.trim() || null,
      salesPrice: nonPosting ? null : form.salesPrice.trim() || null,
      purchaseCost: nonPosting ? null : form.purchaseCost.trim() || null,
      reorderPoint: form.type === 'inventory' ? form.reorderPoint.trim() || null : null,
      sku: form.sku.trim() || null,
      unitOfMeasure: form.unitOfMeasure.trim() || null,
      taxable: form.taxable,
      incomeAccountId: noAccounts ? null : form.incomeAccountId || null,
      expenseAccountId: noAccounts ? null : form.expenseAccountId || null,
      assetAccountId:
        form.type === 'inventory' ? form.assetAccountId || null : null,
      barcode: form.barcode.trim() || null,
      trackingMode: form.type === 'inventory' ? form.trackingMode : 'none',
      weight: form.weight.trim() || null,
      preferredVendorId: form.preferredVendorId || null,
      salesTaxCodeId: form.salesTaxCodeId || null,
      uomSetId: form.uomSetId || null,
      // Opening quantity on hand: new inventory items only (posts vs Opening Balance Equity).
      ...(!editingItem && form.type === 'inventory' && form.openingQuantity.trim()
        ? {
            openingQuantity: form.openingQuantity.trim(),
            openingValue: form.openingValue.trim() || null,
            openingAsOf: form.openingAsOf ? new Date(form.openingAsOf).toISOString() : undefined,
          }
        : {}),
    };

    setSaving(true);
    try {
      if (editingItem) {
        await api.patch(`/api/items/${editingItem.id}`, payload);
        toast('Item updated.', 'success');
      } else {
        await api.post('/api/items', payload);
        toast('Item created.', 'success');
      }
      closeModal();
      await fetchItems();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  // ── Deactivate ─────────────────────────────────────────────────────────────

  async function handleDeactivate() {
    if (!confirmItem) return;
    setDeactivating(true);
    try {
      await api.del(`/api/items/${confirmItem.id}`);
      toast(`"${confirmItem.name}" deactivated.`, 'success');
      setConfirmItem(null);
      await fetchItems();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Deactivation failed.', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const showAccountPickers = !NO_ACCOUNT_TYPES.includes(form.type);
  const showPrices = !NON_POSTING_TYPES.includes(form.type);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Products & Services"
        icon={Package}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => window.open('/api/export/items.csv', '_blank')}
              title="Export the item list to CSV"
            >
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Link href="/lists/item-prices">
              <Button variant="secondary" title="Raise or lower many prices at once">Change Prices</Button>
            </Link>
            <Link href="/lists/multiple?list=items">
              <Button variant="secondary" title="Add or edit many items at once (paste from Excel)">Add/Edit Multiple</Button>
            </Link>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> Add Item
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No items yet"
            message="Add your first product or service to get started."
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" /> Add Item
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>SKU</Th>
                <Th>Type</Th>
                <Th>Unit</Th>
                <Th numeric>Sales Price</Th>
                <Th numeric>Purchase Cost</Th>
                <Th numeric>On Hand</Th>
                <Th numeric>Avg Cost</Th>
                <Th className="text-center">Taxable</Th>
                <Th className="text-center">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <Tr key={item.id}>
                  <Td className="font-semibold text-navy">
                    <span title={item.description ?? undefined}>{item.name}</span>
                  </Td>
                  <Td className="text-navy/50 text-sm">{item.sku ?? '—'}</Td>
                  <Td>
                    <Badge tone={TYPE_TONES[item.type] ?? 'neutral'}>
                      {TYPE_LABELS[item.type] ?? item.type}
                    </Badge>
                  </Td>
                  <Td className="text-navy/60 text-sm">{item.unitOfMeasure ?? '—'}</Td>
                  <Td numeric>
                    {item.salesPrice ? formatCurrency(item.salesPrice) : '—'}
                  </Td>
                  <Td numeric>
                    {item.purchaseCost ? formatCurrency(item.purchaseCost) : '—'}
                  </Td>
                  <Td numeric className="text-navy/70">
                    {item.type === 'inventory' ? Number(item.quantityOnHand ?? 0) : '—'}
                  </Td>
                  <Td numeric className="text-navy/70">
                    {item.type === 'inventory' && item.averageCost
                      ? formatCurrency(Number(item.averageCost).toFixed(2))
                      : '—'}
                  </Td>
                  <Td className="text-center">
                    {item.taxable ? (
                      <Badge tone="success">Yes</Badge>
                    ) : (
                      <Badge tone="neutral">No</Badge>
                    )}
                  </Td>
                  <Td className="text-center">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Edit item"
                        onClick={() => openEdit(item)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Deactivate item"
                        onClick={() => setConfirmItem(item)}
                        className="text-red-400 hover:text-red-600 hover:bg-red-50"
                      >
                        <PowerOff className="h-4 w-4" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingItem ? 'Edit Item' : 'Add Item'}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={saving}>
              {editingItem ? 'Save Changes' : 'Create Item'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="item-name">Name *</Label>
            <Input
              id="item-name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="e.g. Consulting Hour"
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="item-type">Type</Label>
              <Select
                id="item-type"
                value={form.type}
                onChange={(e) => setField('type', e.target.value as ItemType)}
              >
                <option value="service">Service</option>
                {/* QB hides Inventory Part while "Track inventory" is off (the server refuses it too). */}
                {(prefs.inventoryEnabled || editingItem?.type === 'inventory') && (
                  <option value="inventory">Inventory</option>
                )}
                <option value="non_inventory">Non-Inventory</option>
                <option value="bundle">Bundle (group)</option>
                <option value="other_charge">Other Charge</option>
                <option value="discount">Discount</option>
                <option value="subtotal">Subtotal</option>
                <option value="payment">Payment</option>
                {(prefs.salesTaxEnabled || editingItem?.type === 'sales_tax') && (
                  <option value="sales_tax">Sales Tax</option>
                )}
              </Select>
            </div>
            <div>
              <Label htmlFor="item-uom">Unit of Measure</Label>
              <Input
                id="item-uom"
                value={form.unitOfMeasure}
                onChange={(e) => setField('unitOfMeasure', e.target.value)}
                placeholder="e.g. hr, ea, box"
                maxLength={50}
              />
            </div>
          </div>

          {form.type === 'subtotal' && (
            <p className="text-xs text-navy/50 rounded-lg bg-navy/5 px-3 py-2">
              Subtotal items are non-posting: on a sales form the row shows the
              running total of the lines above it. No price or account applies.
            </p>
          )}
          {form.type === 'discount' && (
            <p className="text-xs text-navy/50 rounded-lg bg-navy/5 px-3 py-2">
              Discount items subtract from the invoice. On the form you can enter a
              flat amount or a percentage of the preceding lines. Posts a debit to
              the discount (income) account selected below.
            </p>
          )}
          {form.type === 'payment' && (
            <p className="text-xs text-navy/50 rounded-lg bg-navy/5 px-3 py-2">
              Payment items record money already received on the invoice itself:
              Dr Undeposited Funds / Cr Accounts Receivable. No account links apply.
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="item-sku">SKU / Product Code</Label>
              <Input
                id="item-sku"
                value={form.sku}
                onChange={(e) => setField('sku', e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div>
              <Label htmlFor="item-barcode">Barcode</Label>
              <Input
                id="item-barcode"
                value={form.barcode}
                onChange={(e) => setField('barcode', e.target.value)}
                onKeyDown={(e) => {
                  // A keyboard-wedge scanner ends with Enter — keep it from submitting the form.
                  if (e.key === 'Enter') e.preventDefault();
                }}
                placeholder="Scan or type (optional)"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="item-description">Description</Label>
            <Input
              id="item-description"
              value={form.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="Optional short description"
            />
          </div>

          {showPrices && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="item-sales-price">
                  {form.type === 'discount' ? 'Default Discount Amount' : 'Sales Price'}
                </Label>
                <Input
                  id="item-sales-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.salesPrice}
                  onChange={(e) => setField('salesPrice', e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label htmlFor="item-purchase-cost">Purchase Cost</Label>
                <Input
                  id="item-purchase-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchaseCost}
                  onChange={(e) => setField('purchaseCost', e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}

          {showAccountPickers && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="item-income-acct">
                  {form.type === 'discount' ? 'Discount Account' : 'Income Account'}
                </Label>
                <Select
                  id="item-income-acct"
                  value={form.incomeAccountId}
                  onChange={(e) => setField('incomeAccountId', e.target.value)}
                >
                  <option value="">Default (4000 Sales Income)</option>
                  {incomeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="item-expense-acct">Expense / COGS Account</Label>
                <Select
                  id="item-expense-acct"
                  value={form.expenseAccountId}
                  onChange={(e) => setField('expenseAccountId', e.target.value)}
                >
                  <option value="">None</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          {form.type === 'inventory' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="item-asset-acct">Inventory Asset Account</Label>
                <Select
                  id="item-asset-acct"
                  value={form.assetAccountId}
                  onChange={(e) => setField('assetAccountId', e.target.value)}
                >
                  <option value="">Default (1300 Inventory Asset)</option>
                  {assetAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="item-reorder-point">Reorder Point</Label>
                <Input
                  id="item-reorder-point"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={form.reorderPoint}
                  onChange={(e) => setField('reorderPoint', e.target.value)}
                  placeholder="e.g. 10"
                />
              </div>
            </div>
          )}

          {form.type === 'inventory' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="item-tracking">Serial / Lot Tracking</Label>
                <Select
                  id="item-tracking"
                  value={form.trackingMode}
                  disabled={!!editingItem && Number(editingItem.quantityOnHand ?? 0) !== 0}
                  onChange={(e) => setField('trackingMode', e.target.value as FormState['trackingMode'])}
                >
                  <option value="none">None</option>
                  <option value="serial">Serial numbers (one per unit)</option>
                  <option value="lot">Lot numbers (with expiration)</option>
                </Select>
                {!!editingItem && Number(editingItem.quantityOnHand ?? 0) !== 0 && (
                  <p className="mt-1 text-xs text-navy/50">Can only change while nothing is on hand.</p>
                )}
              </div>
              <div>
                <Label htmlFor="item-weight">Unit Weight</Label>
                <Input
                  id="item-weight"
                  type="number"
                  min="0"
                  step="any"
                  value={form.weight}
                  onChange={(e) => setField('weight', e.target.value)}
                  placeholder="For landed cost by weight"
                />
              </div>
            </div>
          )}

          {form.type !== 'subtotal' && form.type !== 'payment' && (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="item-pref-vendor">Preferred vendor</Label>
                <Select id="item-pref-vendor" value={form.preferredVendorId} onChange={(e) => setField('preferredVendorId', e.target.value)}>
                  <option value="">—</option>
                  {vendorOptions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="item-tax-code">Sales tax code</Label>
                <Select
                  id="item-tax-code"
                  value={form.salesTaxCodeId}
                  onChange={(e) => {
                    setField('salesTaxCodeId', e.target.value);
                    const code = taxCodeOptions.find((t) => t.id === e.target.value);
                    if (code) setField('taxable', !!code.taxable);
                  }}
                >
                  <option value="">—</option>
                  {taxCodeOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} — {t.taxable ? 'taxable' : 'not taxable'}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="item-uom">Unit of measure set</Label>
                <Select id="item-uom" value={form.uomSetId} onChange={(e) => setField('uomSetId', e.target.value)}>
                  <option value="">Single unit</option>
                  {uomOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          {!editingItem && form.type === 'inventory' && (
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-semibold text-navy">
                Already have some in stock? <Help term="opening-balance-equity" />
              </p>
              <p className="mb-3 text-xs text-navy/60">
                Enter what you have on hand and what it is worth. It is added to your inventory value with the other side
                recorded in Opening Balance Equity.
              </p>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="item-open-qty">Quantity on hand</Label>
                  <Input id="item-open-qty" type="number" min="0" step="any" value={form.openingQuantity} onChange={(e) => setField('openingQuantity', e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="item-open-value">Total value</Label>
                  <Input id="item-open-value" type="number" min="0" step="0.01" value={form.openingValue} onChange={(e) => setField('openingValue', e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="item-open-asof">As of</Label>
                  <Input id="item-open-asof" type="date" value={form.openingAsOf} onChange={(e) => setField('openingAsOf', e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {editingItem && editingItem.type === 'inventory' && (
            <div className="grid grid-cols-2 gap-4 rounded-lg bg-navy/5 px-3 py-2">
              <div className="text-xs text-navy/60">
                <span className="block font-semibold text-navy/70">Quantity on Hand</span>
                {Number(editingItem.quantityOnHand ?? 0)} (read-only — changes via
                bills, invoices &amp; adjustments)
              </div>
              <div className="text-xs text-navy/60">
                <span className="block font-semibold text-navy/70">Average Cost</span>
                {editingItem.averageCost
                  ? formatCurrency(Number(editingItem.averageCost).toFixed(2))
                  : '—'}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-navy/70 select-none">
            <input
              type="checkbox"
              checked={form.taxable}
              onChange={(e) => setField('taxable', e.target.checked)}
              className="accent-electric"
            />
            Taxable by default on sales forms
          </label>
        </form>
      </Modal>

      {/* Deactivate Confirmation Modal */}
      <ConfirmDialog
        open={!!confirmItem}
        title="Deactivate Item"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <span className="font-semibold text-navy">{confirmItem?.name}</span>? It will be hidden
            from active lists but preserved on historical documents. You can reactivate it later.
          </>
        }
        confirmLabel="Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setConfirmItem(null)}
      />
    </main>
  );
}

export default function ItemsPage() {
  return (
    <Suspense fallback={null}>
      <ItemsPageContent />
    </Suspense>
  );
}
