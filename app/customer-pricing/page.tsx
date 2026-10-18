'use client';

import { useEffect, useState, useCallback } from 'react';
import { HandCoins, Trash2, Plus } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Label,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
  companyName: string | null;
  isActive: boolean;
}

interface Item {
  id: string;
  name: string;
  sku: string | null;
  salesPrice: string | null;
  type: string;
}

interface CustomerPrice {
  id: string;
  customerId: string;
  itemId: string;
  price: string;
}

interface PriceRow {
  id: string;
  itemId: string;
  itemName: string;
  sku: string | null;
  customPrice: string;
  defaultPrice: string | null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CustomerPricingPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [priceRows, setPriceRows] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Add/edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formItemId, setFormItemId] = useState('');
  const [formPrice, setFormPrice] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<PriceRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---------------------------------------------------------------------------
  // Bootstrap data
  // ---------------------------------------------------------------------------

  useEffect(() => {
    Promise.all([
      api.get<Customer[]>('/api/customers'),
      api.get<{ items: Item[] }>('/api/items'),
    ])
      .then(([custs, itemsResp]) => {
        setCustomers((custs as Customer[]).filter((c) => c.isActive));
        setItems(itemsResp.items);
      })
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load data', 'danger');
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Load prices for selected customer
  // ---------------------------------------------------------------------------

  const loadPrices = useCallback(
    async (customerId: string) => {
      if (!customerId) {
        setPriceRows([]);
        return;
      }
      setLoading(true);
      try {
        const data = await api.get<{ prices: CustomerPrice[] }>(
          `/api/customer-prices?customerId=${customerId}`,
        );
        // Join with items to build display rows
        const rows: PriceRow[] = data.prices.map((cp) => {
          const item = items.find((i) => i.id === cp.itemId);
          return {
            id: cp.id,
            itemId: cp.itemId,
            itemName: item?.name ?? 'Unknown item',
            sku: item?.sku ?? null,
            customPrice: cp.price,
            defaultPrice: item?.salesPrice ?? null,
          };
        });
        // Sort by item name
        rows.sort((a, b) => a.itemName.localeCompare(b.itemName));
        setPriceRows(rows);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load prices', 'danger');
      } finally {
        setLoading(false);
      }
    },
    [items],
  );

  useEffect(() => {
    if (selectedCustomerId) {
      loadPrices(selectedCustomerId);
    } else {
      setPriceRows([]);
    }
  }, [selectedCustomerId, loadPrices]);

  // ---------------------------------------------------------------------------
  // Open modal for add or edit
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setEditingId(null);
    setFormItemId('');
    setFormPrice('');
    setModalOpen(true);
  }

  function openEditModal(row: PriceRow) {
    setEditingId(row.id);
    setFormItemId(row.itemId);
    setFormPrice(String(parseFloat(row.customPrice)));
    setModalOpen(true);
  }

  // ---------------------------------------------------------------------------
  // Save (upsert)
  // ---------------------------------------------------------------------------

  async function handleSave() {
    if (!selectedCustomerId) {
      toast('Select a customer first', 'danger');
      return;
    }
    if (!formItemId) {
      toast('Select an item', 'danger');
      return;
    }
    const priceNum = parseFloat(formPrice);
    if (isNaN(priceNum) || priceNum < 0) {
      toast('Enter a valid non-negative price', 'danger');
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/customer-prices', {
        customerId: selectedCustomerId,
        itemId: formItemId,
        price: formPrice,
      });
      toast(editingId ? 'Price updated' : 'Price set', 'success');
      setModalOpen(false);
      await loadPrices(selectedCustomerId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save price', 'danger');
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/customer-prices/${deleteTarget.id}`);
      toast(`Price removed for ${deleteTarget.itemName}`, 'success');
      setDeleteTarget(null);
      await loadPrices(selectedCustomerId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to remove price', 'danger');
    } finally {
      setDeleting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);

  // Items not yet having a custom price for this customer (for the add dropdown)
  const availableItems = items.filter(
    (i) => !priceRows.some((r) => r.itemId === i.id),
  );

  // When editing, also include the currently-edited item
  const itemsForModal = editingId
    ? items
    : availableItems;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Customer Pricing"
        icon={HandCoins}
        action={
          selectedCustomerId ? (
            <Button onClick={openAddModal} disabled={availableItems.length === 0}>
              <Plus className="h-4 w-4" />
              Set Price
            </Button>
          ) : undefined
        }
      />

      {/* ---- Customer picker ---- */}
      <Card className="mb-6 p-5">
        <div className="max-w-sm">
          <Label htmlFor="customerSelect">Customer</Label>
          <Select
            id="customerSelect"
            value={selectedCustomerId}
            onChange={(e) => setSelectedCustomerId(e.target.value)}
          >
            <option value="">-- select a customer --</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
                {c.companyName ? ` (${c.companyName})` : ''}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {/* ---- Price list ---- */}
      {selectedCustomer && (
        <Card>
          {loading ? (
            <div className="flex items-center justify-center py-20 text-navy/40">
              <Spinner className="h-6 w-6" />
            </div>
          ) : priceRows.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title="No custom prices yet"
              message={`All items will use their default sales price for ${selectedCustomer.displayName}.`}
              action={
                <Button onClick={openAddModal} disabled={availableItems.length === 0}>
                  <Plus className="h-4 w-4" /> Set Price
                </Button>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>SKU</Th>
                  <Th numeric>Default Price</Th>
                  <Th numeric>Custom Price</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {priceRows.map((row) => {
                  const savings =
                    row.defaultPrice != null
                      ? parseFloat(row.defaultPrice) - parseFloat(row.customPrice)
                      : null;
                  return (
                    <Tr key={row.id}>
                      <Td className="font-semibold text-navy">{row.itemName}</Td>
                      <Td className="text-navy/50 font-mono text-xs">{row.sku ?? '-'}</Td>
                      <Td numeric className="text-navy/60">
                        {row.defaultPrice != null ? formatCurrency(row.defaultPrice) : '-'}
                      </Td>
                      <Td numeric>
                        <span className="font-semibold text-navy">
                          {formatCurrency(row.customPrice)}
                        </span>
                        {savings != null && savings > 0 && (
                          <span className="ml-2 text-xs text-emerald font-semibold">
                            -{formatCurrency(savings)}
                          </span>
                        )}
                        {savings != null && savings < 0 && (
                          <span className="ml-2 text-xs text-gold font-semibold">
                            +{formatCurrency(Math.abs(savings))}
                          </span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditModal(row)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:bg-red-50"
                            onClick={() => setDeleteTarget(row)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {/* ---- Add / Edit price modal ---- */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Edit Custom Price' : 'Set Custom Price'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editingId ? 'Update Price' : 'Set Price'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="modalItem">Item</Label>
            <Select
              id="modalItem"
              value={formItemId}
              onChange={(e) => setFormItemId(e.target.value)}
              disabled={!!editingId}
              autoFocus={!editingId}
            >
              <option value="">-- select an item --</option>
              {itemsForModal.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.sku ? ` (${i.sku})` : ''}
                  {i.salesPrice ? ` — default ${formatCurrency(i.salesPrice)}` : ''}
                </option>
              ))}
            </Select>
            {editingId && (
              <p className="mt-1 text-xs text-navy/40">
                Item cannot be changed when editing. Remove and re-add to switch items.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="modalPrice">Custom Price (USD)</Label>
            <Input
              id="modalPrice"
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 9.99"
              value={formPrice}
              onChange={(e) => setFormPrice(e.target.value)}
            />
          </div>
          {formItemId && formPrice !== '' && !isNaN(parseFloat(formPrice)) && (
            <div className="rounded-lg bg-electric/5 border border-electric/20 px-4 py-3 text-sm text-navy/70">
              <span className="font-semibold text-navy">
                {selectedCustomer?.displayName}
              </span>{' '}
              will pay{' '}
              <span className="font-semibold text-electric">
                {formatCurrency(formPrice)}
              </span>{' '}
              for{' '}
              <span className="font-semibold text-navy">
                {items.find((i) => i.id === formItemId)?.name}
              </span>
              .
            </div>
          )}
        </div>
      </Modal>

      {/* ---- Delete confirm modal ---- */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove Custom Price"
        message={
          <>
            Remove the custom price for{' '}
            <strong className="text-navy">{deleteTarget?.itemName}</strong>? The default item
            sales price will be used instead.
          </>
        }
        confirmLabel="Remove"
        tone="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
