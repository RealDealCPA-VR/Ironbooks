'use client';
/**
 * Renderer-side bridge for the Electron shell. Mounted once in app/layout.tsx.
 *
 * Subscribes to the main-process IPC channels exposed by electron/preload.js
 * (window.bookkeeper.onMenu / onNavigate) so the native application menu actually works:
 *  - Reports submenu        -> client-side navigation to the report page
 *  - File > Import Bank File -> /banking (import flow lives there)
 *  - File > Backup Company   -> /backup
 *  - File > New/Open Company -> /companies (company management/switcher)
 *  - File > Create Portable Company File / Export Shareable Ledger -> fetch + native Save
 *  - File > View Transaction Log -> /transaction-log
 *  - auto-updater 'update-ready' -> an actionable "Restart & install now" banner
 *
 * Renders nothing in the browser (window.bookkeeper is absent outside Electron) and
 * nothing in the desktop shell until an update has finished downloading.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, X } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { savePortableCompanyFile, saveShareableLedger } from '@/lib/companyFileClient';

type Unsubscribe = (() => void) | void;
interface DesktopBridgeApi {
  isDesktop?: boolean;
  onMenu?: (cb: (action: string) => void) => Unsubscribe;
  onNavigate?: (cb: (route: string) => void) => Unsubscribe;
  quitAndInstall?: () => Promise<boolean>;
  company?: { newFile?: () => Promise<unknown>; open?: () => Promise<unknown> };
}

function bridge(): DesktopBridgeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: DesktopBridgeApi }).bookkeeper;
}

const MENU_ROUTES: Record<string, string> = {
  import: '/banking',
  backup: '/backup',
  'transaction-log': '/transaction-log',
};

/** File-menu exports that fetch from the local server (with the session) and save natively. */
const MENU_EXPORTS: Record<string, { run: () => Promise<string | null>; done: string }> = {
  'portable-create': { run: savePortableCompanyFile, done: 'Portable company file saved' },
  'shareable-xlsx': { run: () => saveShareableLedger('xlsx'), done: 'Shareable ledger (Excel) saved' },
  'shareable-pdf': { run: () => saveShareableLedger('pdf'), done: 'Shareable ledger (PDF) saved' },
};

export default function DesktopBridge() {
  const router = useRouter();
  const [updateReady, setUpdateReady] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const b = bridge();
    if (!b?.isDesktop) return;

    const offMenu = b.onMenu?.((action) => {
      if (action === 'update-ready') {
        setUpdateReady(true);
        toast('Update downloaded — restart to apply it.', 'info');
        return;
      }
      // New/Open Company open native folder dialogs (the company-file model lives in the shell).
      if (action === 'new-company') {
        b.company?.newFile?.();
        return;
      }
      if (action === 'open-company') {
        b.company?.open?.();
        return;
      }
      const exp = MENU_EXPORTS[action];
      if (exp) {
        toast('Preparing the file…', 'info');
        exp
          .run()
          .then((saved) => saved && toast(`${exp.done}: ${saved}`, 'success'))
          .catch((err) => toast(err instanceof Error ? err.message : 'Export failed.', 'danger'));
        return;
      }
      const route = MENU_ROUTES[action];
      if (route) router.push(route);
    });
    const offNavigate = b.onNavigate?.((route) => {
      if (route) router.push(route);
    });

    return () => {
      if (typeof offMenu === 'function') offMenu();
      if (typeof offNavigate === 'function') offNavigate();
    };
  }, [router]);

  if (!updateReady) return null;

  async function applyUpdate() {
    setInstalling(true);
    try {
      const staged = await bridge()?.quitAndInstall?.();
      if (staged === false) {
        setInstalling(false);
        toast('No update is staged — please restart the app manually.', 'danger');
      }
      // On success the app quits to install; no further UI needed.
    } catch {
      setInstalling(false);
      toast('Could not start the update. Please restart the app manually.', 'danger');
    }
  }

  return (
    <div className="fixed bottom-4 left-4 z-[200] max-w-sm">
      <div className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-2xl">
        <div className="mt-0.5 rounded-lg bg-electric/10 p-2">
          <RefreshCw className="h-5 w-5 text-electric" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-navy">Update ready</p>
          <p className="mt-0.5 text-sm text-navy/60">
            A new version of BookKeeper AI has been downloaded.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={applyUpdate} loading={installing}>
              Restart &amp; install now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setUpdateReady(false)}
              disabled={installing}
            >
              Later
            </Button>
          </div>
        </div>
        <button
          aria-label="Dismiss"
          onClick={() => setUpdateReady(false)}
          disabled={installing}
          className="text-navy/30 hover:text-navy disabled:pointer-events-none"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
