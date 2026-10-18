'use client';
/**
 * Change Item Prices — /lists/item-prices
 * Raise or lower sales prices for many items at once, by a percent or an amount, based on the
 * current price or on cost. Preview first; nothing changes until you press Apply.
 */
import { useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

interface Item {
  id: string;
  name: string;
  type: string;
  salesPrice: string | null;
  purchaseCost: string | null;
}
interface ChangeRow {
  id: string;
  name: string;
  currentPrice: string | null;
  newPrice: string | null;
  skipped?: string;
}

const PRICED = ['service', 'inventory', 'non_inventory', 'bundle', 'other_charge'];

export default function ChangeItemPricesPage() {
  const [itemsList, setItems] = useState<Item[]>([]);
  const [typeFilter, setTypeFilter] = useState('inventory');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [basis, setBasis] = useState<'price' | 'cost'>('price');
  const [adjustBy, setAdjustBy] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState('cent');
  const [preview, setPreview] = useState<ChangeRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ items: Item[] }>('/api/items')
      .then((d) => setItems(d.items.filter((i) => PRICED.includes(i.type))))
      .catch((err) => toastError(err, 'Could not load items.'));
  }, []);

  const shown = useMemo(() => itemsList.filter((i) => !typeFilter || i.type === typeFilter), [itemsList, typeFilter]);

  useEffect(() => {
    setSelected(new Set(shown.map((i) => i.id)));
    setPreview(null);
  }, [shown]);

  function body(dryRun: boolean) {
    return { itemIds: [...selected], basis, adjustBy, value, rounding, dryRun };
  }

  async function doPreview() {
    if (!value || selected.size === 0) return;
    setBusy(true);
    try {
      const r = await api.post<{ changes: ChangeRow[] }>('/api/items/change-prices', body(true));
      setPreview(r.changes);
    } catch (err) {
      toastError(err, 'Could not preview the new prices.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api.post<{ changed: number }>('/api/items/change-prices', body(false));
      toast(`Updated ${r.changed} price${r.changed === 1 ? '' : 's'}.`, 'success');
      const d = await api.get<{ items: Item[] }>('/api/items');
      setItems(d.items.filter((i) => PRICED.includes(i.type)));
      setPreview(null);
    } catch (err) {
      toastError(err, 'Could not change the prices.');
    } finally {
      setBusy(false);
    }
  }

  const previewById = new Map((preview ?? []).map((p) => [p.id, p]));

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Change Item Prices" icon={BadgeDollarSign} />
      <Card className="p-6">
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <Label htmlFor="cp-type">Item type</Label>
            <Select id="cp-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              <option value="inventory">Inventory parts</option>
              <option value="non_inventory">Non-inventory parts</option>
              <option value="service">Services</option>
              <option value="other_charge">Other charges</option>
              <option value="bundle">Groups</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="cp-basis">Start from</Label>
            <Select id="cp-basis" value={basis} onChange={(e) => { setBasis(e.target.value as 'price' | 'cost'); setPreview(null); }}>
              <option value="price">Current price</option>
              <option value="cost">Cost</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="cp-by">Change by</Label>
            <Select id="cp-by" value={adjustBy} onChange={(e) => { setAdjustBy(e.target.value as 'percent' | 'amount'); setPreview(null); }}>
              <option value="percent">Percent (%)</option>
              <option value="amount">Amount ($)</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="cp-value">{adjustBy === 'percent' ? 'Percent (use - to lower)' : 'Amount (use - to lower)'}</Label>
            <Input id="cp-value" type="number" step="any" value={value} onChange={(e) => { setValue(e.target.value); setPreview(null); }} placeholder={adjustBy === 'percent' ? 'e.g. 5' : 'e.g. 1.50'} />
          </div>
          <div>
            <Label htmlFor="cp-round">Round to</Label>
            <Select id="cp-round" value={rounding} onChange={(e) => { setRounding(e.target.value); setPreview(null); }}>
              <option value="cent">Nearest cent</option>
              <option value="dime">Nearest 10¢</option>
              <option value="dollar">Nearest dollar</option>
              <option value="up_99">Up to .99</option>
              <option value="none">No rounding (to the cent)</option>
            </Select>
          </div>
        </div>
        <div className="mb-4 flex gap-2">
          <Button variant="secondary" onClick={doPreview} loading={busy} disabled={!value || selected.size === 0}>
            Preview new prices
          </Button>
          <Button onClick={apply} loading={busy} disabled={!preview}>
            Apply to {selected.size} item{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
        <Table>
          <thead>
            <tr>
              <Th>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={shown.length > 0 && shown.every((i) => selected.has(i.id))}
                  onChange={(e) => { setSelected(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set()); setPreview(null); }}
                />
              </Th>
              <Th>Item</Th>
              <Th numeric>Cost</Th>
              <Th numeric>Current price</Th>
              <Th numeric>New price</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => {
              const p = previewById.get(i.id);
              return (
                <Tr key={i.id}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${i.name}`}
                      checked={selected.has(i.id)}
                      onChange={() => {
                        setSelected((prev) => {
                          const n = new Set(prev);
                          if (n.has(i.id)) n.delete(i.id);
                          else n.add(i.id);
                          return n;
                        });
                        setPreview(null);
                      }}
                    />
                  </Td>
                  <Td>{i.name}</Td>
                  <Td numeric>{i.purchaseCost != null ? formatCurrency(i.purchaseCost) : '—'}</Td>
                  <Td numeric>{i.salesPrice != null ? formatCurrency(i.salesPrice) : '—'}</Td>
                  <Td numeric>
                    {p ? p.skipped ? <Badge tone="warning">{p.skipped}</Badge> : <strong>{formatCurrency(p.newPrice ?? '0')}</strong> : ''}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </main>
  );
}
