'use client';
/**
 * Advanced Inventory UI kit (team inventory) shared by the transaction forms:
 *   - useAdvancedInventory()   loads sites + bins once; tells a form whether site pickers matter
 *   - <InventoryLineFields>    per-line site / bin / serial-number / lot entry (renders nothing
 *                              for single-site companies and untracked items)
 *   - inventoryLinePayload()   the optional API fields for a line
 *   - <BarcodeScanInput>       scan-to-add box: keyboard-wedge scanners type the code + Enter
 */
import * as React from 'react';
import { ScanBarcode, X } from 'lucide-react';
import { Input, Select, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';

export interface InventorySite {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface InventoryBin {
  id: string;
  siteId: string;
  name: string;
  isActive: boolean;
}

/** Per-line Advanced Inventory detail kept in form state. */
export interface InvDetail {
  siteId?: string;
  binId?: string;
  serialNumbers?: string[];
  lotNumber?: string;
  /** yyyy-mm-dd */
  lotExpiration?: string;
}

export interface AdvancedInventoryState {
  sites: InventorySite[];
  bins: InventoryBin[];
  defaultSiteId: string | null;
  /** True when the company uses more than one site (site pickers are worth showing). */
  multiSite: boolean;
  loaded: boolean;
}

/** Load the company's sites and bins (once per form). */
export function useAdvancedInventory(enabled = true): AdvancedInventoryState {
  const [state, setState] = React.useState<AdvancedInventoryState>({
    sites: [],
    bins: [],
    defaultSiteId: null,
    multiSite: false,
    loaded: false,
  });
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([
      api.get<InventorySite[]>('/api/inventory-sites'),
      api.get<InventoryBin[]>('/api/inventory-sites/bins'),
    ])
      .then(([sites, bins]) => {
        if (cancelled) return;
        setState({
          sites,
          bins,
          defaultSiteId: sites.find((s) => s.isDefault)?.id ?? null,
          multiSite: sites.length > 1 || bins.length > 0,
          loaded: true,
        });
      })
      .catch(() => {
        // Advanced Inventory is optional — forms keep working with the default site.
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

/** Split pasted/scanned serial text into a clean list (newline, comma or tab separated). */
export function parseSerials(text: string): string[] {
  return text
    .split(/[\n,\t;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** API fields for a line — only keys the user actually set, so edits keep stored detail. */
export function inventoryLinePayload(d: InvDetail | undefined | null): Record<string, unknown> {
  if (!d) return {};
  const out: Record<string, unknown> = {};
  if (d.siteId) out.siteId = d.siteId;
  if (d.binId) out.binId = d.binId;
  if (d.serialNumbers && d.serialNumbers.length > 0) out.serialNumbers = d.serialNumbers;
  if (d.lotNumber?.trim()) out.lotNumber = d.lotNumber.trim();
  if (d.lotExpiration) out.lotExpiration = new Date(d.lotExpiration).toISOString();
  return out;
}

/** Stored detail returned on a saved document's lines (GET …/:id) → form state. */
export function invFromLine(l: {
  siteId?: string | null;
  binId?: string | null;
  serialNumbers?: string[] | null;
  lotNumber?: string | null;
  lotExpiration?: string | null;
}): InvDetail | undefined {
  if (!l.siteId && !l.binId && !l.serialNumbers?.length && !l.lotNumber && !l.lotExpiration) return undefined;
  return {
    siteId: l.siteId ?? undefined,
    binId: l.binId ?? undefined,
    serialNumbers: l.serialNumbers ?? undefined,
    lotNumber: l.lotNumber ?? undefined,
    lotExpiration: l.lotExpiration ? l.lotExpiration.slice(0, 10) : undefined,
  };
}

/** True when a line for this item needs Advanced Inventory input. */
export function needsInventoryFields(
  adv: AdvancedInventoryState,
  item: { type?: string; trackingMode?: string | null } | undefined,
): boolean {
  if (!item || item.type !== 'inventory') return false;
  return adv.multiSite || (item.trackingMode != null && item.trackingMode !== 'none');
}

interface InStockSerial {
  serialNumber: string;
  siteId: string;
  binName: string | null;
}
interface InStockLot {
  lotNumber: string;
  siteId: string;
  quantity: string;
  expirationDate: string | null;
}

/**
 * Inline site / bin / serial / lot entry for one document line. `direction` 'out' (sales,
 * transfers-from) offers the serials/lots currently in stock at the chosen site; 'in'
 * (receipts, returns) captures new serials and the lot expiration date.
 */
export function InventoryLineFields({
  adv,
  item,
  quantity,
  direction,
  value,
  onChange,
  className,
  siteLocked = false,
}: {
  adv: AdvancedInventoryState;
  item: { id: string; name?: string; type?: string; trackingMode?: string | null } | undefined;
  quantity: string | number;
  direction: 'in' | 'out';
  value: InvDetail | undefined;
  onChange: (next: InvDetail) => void;
  className?: string;
  /** The site is chosen elsewhere (e.g. a transfer header): hide the site picker, keep bins. */
  siteLocked?: boolean;
}) {
  const v = value ?? {};
  const tracking = item?.trackingMode ?? 'none';
  const siteId = v.siteId || adv.defaultSiteId || '';
  const siteBins = adv.bins.filter((b) => b.siteId === siteId && b.isActive);
  const [serialText, setSerialText] = React.useState((v.serialNumbers ?? []).join('\n'));
  const [stockSerials, setStockSerials] = React.useState<InStockSerial[]>([]);
  const [stockLots, setStockLots] = React.useState<InStockLot[]>([]);

  // Keep the textarea in sync when the parent resets the line.
  const joined = (v.serialNumbers ?? []).join('\n');
  React.useEffect(() => {
    if (parseSerials(serialText).join('\n') !== joined) setSerialText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  // What is in stock at the chosen site (outbound lines of tracked items).
  React.useEffect(() => {
    if (!item?.id || direction !== 'out' || tracking === 'none') return;
    let cancelled = false;
    const qs = new URLSearchParams({ report: 'serial-lot', itemId: item.id });
    if (siteId) qs.set('siteId', siteId);
    api
      .get<{ serials: InStockSerial[]; lots: InStockLot[] }>(`/api/inventory-sites/reports?${qs}`)
      .then((r) => {
        if (cancelled) return;
        setStockSerials(r.serials);
        setStockLots(r.lots);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item?.id, direction, tracking, siteId]);

  const showSite = adv.multiSite && !siteLocked;
  const visible = siteLocked
    ? item?.type === 'inventory' && (tracking !== 'none' || siteBins.length > 0)
    : needsInventoryFields(adv, item);
  if (!visible) return null;

  const qty = Math.round(Number(quantity) || 0);
  const serials = v.serialNumbers ?? [];
  const set = (patch: Partial<InvDetail>) => onChange({ ...v, ...patch });

  return (
    <div className={cn('flex flex-wrap items-start gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs', className)}>
      {showSite && (
        <label className="flex items-center gap-1">
          <span className="text-navy/50">Site</span>
          <Select
            aria-label="Inventory site"
            className="h-8 py-0 text-xs w-40"
            value={siteId}
            onChange={(e) => set({ siteId: e.target.value, binId: undefined })}
          >
            {adv.sites
              .filter((s) => s.isActive || s.id === siteId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.isDefault ? ' (default)' : ''}
                </option>
              ))}
          </Select>
        </label>
      )}
      {siteBins.length > 0 && (
        <label className="flex items-center gap-1">
          <span className="text-navy/50">Bin</span>
          <Select
            aria-label="Bin"
            className="h-8 py-0 text-xs w-32"
            value={v.binId ?? ''}
            onChange={(e) => set({ binId: e.target.value || undefined })}
          >
            <option value="">{direction === 'out' ? 'Any' : 'None'}</option>
            {siteBins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {tracking === 'serial' && (
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-navy/50">Serial numbers (one per line or comma-separated)</span>
            <span className={cn('font-semibold', serials.length === qty ? 'text-emerald' : 'text-red-500')}>
              {serials.length} / {qty}
            </span>
          </div>
          <textarea
            aria-label="Serial numbers"
            rows={Math.min(4, Math.max(1, qty))}
            className="w-full rounded-md border border-slate-200 px-2 py-1 font-mono text-xs text-navy outline-none focus:border-electric"
            value={serialText}
            onChange={(e) => {
              setSerialText(e.target.value);
              set({ serialNumbers: parseSerials(e.target.value) });
            }}
          />
          {direction === 'out' && stockSerials.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-navy/40">In stock:</span>
              {stockSerials
                .filter((s) => !serials.includes(s.serialNumber))
                .slice(0, 30)
                .map((s) => (
                  <button
                    type="button"
                    key={s.serialNumber}
                    className="rounded bg-white px-1.5 py-0.5 font-mono text-navy ring-1 ring-slate-200 hover:ring-electric"
                    onClick={() => {
                      const next = [...serials, s.serialNumber];
                      setSerialText(next.join('\n'));
                      set({ serialNumbers: next });
                    }}
                    title={s.binName ? `Bin ${s.binName}` : undefined}
                  >
                    {s.serialNumber}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {tracking === 'lot' && (
        <>
          <label className="flex items-center gap-1">
            <span className="text-navy/50">Lot</span>
            <Input
              aria-label="Lot number"
              className="h-8 py-0 text-xs w-32"
              list={item ? `lots-${item.id}-${siteId}` : undefined}
              value={v.lotNumber ?? ''}
              onChange={(e) => set({ lotNumber: e.target.value })}
            />
            {direction === 'out' && item && (
              <datalist id={`lots-${item.id}-${siteId}`}>
                {stockLots.map((l) => (
                  <option key={`${l.lotNumber}-${l.siteId}`} value={l.lotNumber}>
                    {`${Number(l.quantity)} on hand${l.expirationDate ? `, exp ${l.expirationDate.slice(0, 10)}` : ''}`}
                  </option>
                ))}
              </datalist>
            )}
          </label>
          {direction === 'in' && (
            <label className="flex items-center gap-1">
              <span className="text-navy/50">Expires</span>
              <Input
                aria-label="Lot expiration date"
                type="date"
                className="h-8 py-0 text-xs w-36"
                value={v.lotExpiration ?? ''}
                onChange={(e) => set({ lotExpiration: e.target.value || undefined })}
              />
            </label>
          )}
        </>
      )}
    </div>
  );
}

export interface ScannedItem {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  salesPrice?: string | null;
  purchaseCost?: string | null;
  trackingMode?: string | null;
}

/**
 * Scan-to-add box. Keyboard-wedge scanners "type" the barcode and press Enter; the code is
 * resolved via /api/items/barcode and handed to `onItem`. The box clears and keeps focus so
 * the next scan can follow immediately.
 */
export function BarcodeScanInput({
  onItem,
  className,
  placeholder = 'Scan barcode…',
}: {
  onItem: (item: ScannedItem) => void;
  className?: string;
  placeholder?: string;
}) {
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);

  async function lookup() {
    const value = code.trim();
    if (!value) return;
    setBusy(true);
    try {
      const item = await api.get<ScannedItem>(`/api/items/barcode?code=${encodeURIComponent(value)}`);
      onItem(item);
      setCode('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Item not found for that barcode.', 'danger');
      ref.current?.select();
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }

  return (
    <div className={cn('relative flex items-center', className)}>
      <ScanBarcode className="pointer-events-none absolute left-2 h-4 w-4 text-navy/40" />
      <Input
        ref={ref}
        aria-label="Scan barcode to add an item"
        className="h-8 py-0 pl-7 pr-7 text-xs w-48"
        placeholder={placeholder}
        value={code}
        disabled={busy}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            void lookup();
          }
        }}
      />
      {code && (
        <button
          type="button"
          aria-label="Clear"
          className="absolute right-2 text-navy/40 hover:text-navy"
          onClick={() => setCode('')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
