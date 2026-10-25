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
 *  - File / Help > Try It on a Copy -> make the sandbox copy (lib/sandboxClient.ts)
 *  - app updates (electron/main.js) -> "Update available" banner: Download & install, progress,
 *    then "Restart & install now"
 *
 * Renders nothing in the browser (window.bookkeeper is absent outside Electron) and
 * nothing in the desktop shell until a newer version has been published.
 */
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Download, RefreshCw, X } from 'lucide-react';
import { Button, toast, toastError } from '@/components/ui';
import { startSandbox } from '@/lib/sandboxClient';
import { savePortableCompanyFile, saveShareableLedger } from '@/lib/companyFileClient';

type Unsubscribe = (() => void) | void;
/** Mirrors updateState in electron/main.js. */
interface UpdateState {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  /** Set when the user asked again (Help > Check for Updates). */
  reshow?: boolean;
}
interface DesktopBridgeApi {
  isDesktop?: boolean;
  onMenu?: (cb: (action: string) => void) => Unsubscribe;
  onNavigate?: (cb: (route: string) => void) => Unsubscribe;
  quitAndInstall?: () => Promise<boolean>;
  updates?: {
    status?: () => Promise<UpdateState>;
    onChange?: (cb: (state: UpdateState) => void) => Unsubscribe;
    download?: () => Promise<boolean>;
  };
  company?: { newFile?: () => Promise<unknown>; open?: () => Promise<unknown> };
  spellcheck?: { setEnabled?: (enabled: boolean) => Promise<unknown> };
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
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' });
  // The banner state the user dismissed with "Later" (shown again only when something changes).
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const pathname = usePathname();
  const myPrefsApplied = useRef(false);

  // My Preferences in the desktop shell: spell checking on/off, and "Show the Reminders list
  // when I open the company" (once per app session). Raw fetch on purpose: before sign-in it
  // just fails quietly (no redirect), and we retry on the next navigation.
  useEffect(() => {
    const b = bridge();
    if (!b?.isDesktop || myPrefsApplied.current) return;
    if (pathname?.startsWith('/portal') || ['/login', '/signup', '/unlock', '/reset-password'].includes(pathname ?? '')) return;
    let cancelled = false;
    fetch('/api/preferences/my', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((my: { spellCheckEnabled?: boolean; showRemindersAtStartup?: boolean } | null) => {
        if (!my || cancelled) return;
        myPrefsApplied.current = true;
        void b.spellcheck?.setEnabled?.(my.spellCheckEnabled !== false);
        try {
          if (my.showRemindersAtStartup && !sessionStorage.getItem('bka:reminders-shown')) {
            sessionStorage.setItem('bka:reminders-shown', '1');
            if (pathname !== '/reminders') router.push('/reminders');
          }
        } catch {
          /* storage unavailable: skip the startup reminder */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  useEffect(() => {
    const b = bridge();
    if (!b?.isDesktop) return;

    // Updates found before this page loaded (e.g. on the sign-in screen) are picked up here.
    b.updates?.status?.().then((s) => s && setUpdate(s)).catch(() => {});
    const offUpdate = b.updates?.onChange?.((s) => {
      setUpdate(s);
      // Help > Check for Updates re-sends the current state: show the banner again.
      if (s.reshow) setDismissed(null);
    });

    const offMenu = b.onMenu?.((action) => {
      // New/Open Company open native folder dialogs (the company-file model lives in the shell).
      if (action === 'new-company') {
        b.company?.newFile?.();
        return;
      }
      if (action === 'open-company') {
        b.company?.open?.();
        return;
      }
      // File > Save Company File Now finished.
      if (action === 'company-file-saved') {
        toast('Company file saved.', 'success');
        return;
      }
      // File / Help > Try It on a Copy: one click makes the copy and the shell relaunches into it.
      if (action === 'sandbox-start') {
        toast('Making a copy of your company file…', 'info');
        startSandbox().catch((err) => {
          toastError(err, 'The sandbox copy could not be made.');
          router.push('/sandbox');
        });
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
      if (typeof offUpdate === 'function') offUpdate();
      if (typeof offMenu === 'function') offMenu();
      if (typeof offNavigate === 'function') offNavigate();
    };
  }, [router]);

  const visible = ['available', 'downloading', 'ready', 'error'].includes(update.state);
  const key = `${update.state}:${update.version ?? ''}`;
  if (!visible || dismissed === key) return null;

  async function download() {
    try {
      const started = await bridge()?.updates?.download?.();
      if (started === false) toast('Could not start the download. Try Help > Check for Updates.', 'danger');
    } catch {
      toast('Could not start the download. Try Help > Check for Updates.', 'danger');
    }
  }

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

  const current = process.env.NEXT_PUBLIC_APP_VERSION;
  const newVersion = update.version ? `Ironbooks ${update.version}` : 'A new version of Ironbooks';
  const later = () => setDismissed(key);

  let title: string;
  let body: string;
  if (update.state === 'available') {
    title = 'Update available';
    body = `${newVersion} is available${current ? ` (you have ${current})` : ''}. Download and install it now?`;
  } else if (update.state === 'downloading') {
    title = 'Downloading update…';
    body = `${newVersion} is downloading. You can keep working.`;
  } else if (update.state === 'ready') {
    title = 'Update ready';
    body = `${newVersion} has been downloaded. Restart now, or it installs the next time you close the app.`;
  } else {
    title = 'Update failed';
    body = `${newVersion} could not be downloaded${update.message ? `: ${update.message}` : '.'}`;
  }

  return (
    <div className="fixed bottom-4 left-4 z-[200] max-w-sm" role="status" aria-live="polite">
      <div className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-2xl">
        <div className="mt-0.5 rounded-lg bg-electric/10 p-2">
          {update.state === 'ready' ? (
            <RefreshCw className="h-5 w-5 text-electric" />
          ) : (
            <Download className="h-5 w-5 text-electric" />
          )}
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-navy">{title}</p>
          <p className="mt-0.5 text-sm text-navy/60">{body}</p>
          {update.state === 'downloading' && (
            <div
              className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={update.percent ?? 0}
            >
              <div className="h-full bg-electric transition-all" style={{ width: `${update.percent ?? 0}%` }} />
            </div>
          )}
          {update.state !== 'downloading' && (
            <div className="mt-3 flex items-center gap-2">
              {update.state === 'ready' ? (
                <Button size="sm" onClick={applyUpdate} loading={installing}>
                  Restart &amp; install now
                </Button>
              ) : (
                <Button size="sm" onClick={download}>
                  {update.state === 'error' ? 'Try again' : 'Download & install'}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={later} disabled={installing}>
                Later
              </Button>
            </div>
          )}
        </div>
        <button
          aria-label="Dismiss"
          onClick={later}
          disabled={installing}
          className="text-navy/30 hover:text-navy disabled:pointer-events-none"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
