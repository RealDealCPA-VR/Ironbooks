'use client';
/**
 * QuickBooks' Product Information window, mounted once by components/AppShell.tsx:
 *
 *   F2 / Ctrl+1     open it: the version, the company file (location, size) and what it holds
 *                   (accounts, names, items, transactions — GET /api/product-info)
 *   F3 (in it)      the technical details (QuickBooks: F2, then F3 = Tech Help)
 *   Ctrl+Alt+Y      (in it) Payroll Setup > year-to-date amounts, as in QuickBooks
 *   Esc             close
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, Spinner } from '@/components/ui';
import { globalShortcutFor, isEditableTarget, navigateGuarded } from '@/lib/shortcuts';

/** Window event that opens Product Information (Help > Product Information in the desktop menus). */
export const OPEN_PRODUCT_INFO_EVENT = 'ironbooks:product-info';

interface Info {
  version: string | null;
  node: string;
  database: string;
  singleFile: boolean;
  fileName: string;
  location: string | null;
  dataFolder: string | null;
  sizeBytes: number | null;
  remote: boolean;
  counts: {
    transactions: number;
    accounts: number;
    customers: number;
    vendors: number;
    employees: number;
    otherNames: number;
    names: number;
    items: number;
    classes: number;
  };
}

/** 1536 → "1.5 KB", 5_400_000 → "5.1 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'Unknown';
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-navy/55">{label}</dt>
      <dd className="min-w-0 break-all text-right font-medium text-navy tabular-nums">{value}</dd>
    </div>
  );
}

export default function ProductInfo() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [tech, setTech] = React.useState(false);
  const [info, setInfo] = React.useState<Info | null>(null);
  const [failed, setFailed] = React.useState(false);
  const openRef = React.useRef(false);
  openRef.current = open;

  const show = React.useCallback(() => {
    setTech(false);
    setFailed(false);
    setInfo(null);
    setOpen(true);
    fetch('/api/product-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Info) => setInfo(d))
      .catch(() => setFailed(true));
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (openRef.current) {
        // In the window: F3 technical details, Ctrl+Alt+Y payroll year-to-date amounts.
        if (e.key === 'F3' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setTech((t) => !t);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.altKey && (e.code === 'KeyY' || e.key.toLowerCase() === 'y')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setOpen(false);
          navigateGuarded('/employees/setup', (h) => router.push(h));
          return;
        }
      }
      if (globalShortcutFor(e, isEditableTarget(e.target))?.command === 'product-info') {
        e.preventDefault();
        show();
      }
    }
    // Capture: in the window F3 is the technical details, not Search.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(OPEN_PRODUCT_INFO_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(OPEN_PRODUCT_INFO_EVENT, show);
    };
  }, [router, show]);

  const c = info?.counts;
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Product Information"
      footer={
        <>
          <Button variant="secondary" onClick={() => setTech((t) => !t)} aria-keyshortcuts="F3">
            {tech ? 'Hide technical details' : 'Technical details (F3)'}
          </Button>
          <Button onClick={() => setOpen(false)}>OK</Button>
        </>
      }
    >
      <dl className="text-sm" data-product-info>
        <Row label="Product" value={`Ironbooks ${info?.version ?? process.env.NEXT_PUBLIC_APP_VERSION ?? ''}`.trim()} />
        <Row label="License" value="Open source (MIT)" />
      </dl>
      {!info && !failed && (
        <div className="flex justify-center py-6">
          <Spinner className="text-electric" />
        </div>
      )}
      {failed && <p className="mt-3 text-sm text-navy/60">Open a company to see its file information.</p>}
      {info && c && (
        <>
          <h3 className="mt-4 mb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">File information</h3>
          <dl className="text-sm">
            <Row label="Company file" value={info.fileName} />
            {info.location && <Row label="Location" value={info.location} />}
            {info.remote && <Row label="Location" value="On the computer hosting the company file" />}
            {!info.remote && <Row label="Total size" value={formatBytes(info.sizeBytes)} />}
            <Row label="Format" value={info.singleFile ? 'Single company file' : 'Company folder (older format)'} />
            <Row label="Number of transactions" value={c.transactions.toLocaleString('en-US')} />
          </dl>
          <h3 className="mt-4 mb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">List information</h3>
          <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
            <Row label="Total accounts" value={c.accounts.toLocaleString('en-US')} />
            <Row label="Total names" value={c.names.toLocaleString('en-US')} />
            <Row label="Customers" value={c.customers.toLocaleString('en-US')} />
            <Row label="Vendors" value={c.vendors.toLocaleString('en-US')} />
            <Row label="Employees" value={c.employees.toLocaleString('en-US')} />
            <Row label="Other names" value={c.otherNames.toLocaleString('en-US')} />
            <Row label="Items" value={c.items.toLocaleString('en-US')} />
            <Row label="Classes" value={c.classes.toLocaleString('en-US')} />
          </dl>
        </>
      )}
      {tech && (
        <div data-product-tech>
          <h3 className="mt-4 mb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">Technical details</h3>
          <dl className="text-sm">
            <Row label="Database" value={info?.database ?? 'PostgreSQL (PGlite, embedded)'} />
            {info?.node && <Row label="Server (Node.js)" value={info.node} />}
            {info?.dataFolder && <Row label="Working folder" value={info.dataFolder} />}
            <Row label="Window" value={typeof navigator !== 'undefined' ? navigator.userAgent : ''} />
          </dl>
        </div>
      )}
      <p className="mt-4 text-xs text-navy/45">Ctrl+Alt+Y here: payroll year-to-date amounts (Payroll Setup).</p>
    </Modal>
  );
}
