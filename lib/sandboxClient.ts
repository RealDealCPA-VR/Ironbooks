/**
 * Renderer side of sandbox mode ("Try it on a copy", lib/services/sandbox.ts), shared by the
 * Sandbox page, the banner and the desktop menu bridge (components/DesktopBridge.tsx).
 *
 * The server makes the copy and switches its active company file. In the desktop app the shell
 * is then told (window.bookkeeper.sandbox.entered / left) so it records the switch with its
 * sandbox flag and relaunches into the right file; in a browser the page simply reloads on the
 * new file.
 */
import { api } from '@/lib/client';

export interface SandboxBannerStatus {
  active: boolean;
  kind: 'sandbox' | 'training' | null;
  text: string | null;
}

export interface LeftoverSandbox {
  id: string;
  sourceName: string;
  createdAt: string;
}

export interface SandboxStatus {
  active: boolean;
  kind: 'sandbox' | 'training' | null;
  sourceName: string | null;
  createdAt: string | null;
  trainingName: string | null;
  realFileFound: boolean | null;
  leftovers: LeftoverSandbox[];
}

interface SandboxBridge {
  isDesktop?: boolean;
  sandbox?: {
    entered: (dir: string) => Promise<boolean>;
    left: (opts: { trainingDir?: string | null }) => Promise<boolean>;
  };
}

function bridge(): SandboxBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: SandboxBridge }).bookkeeper;
}

/** The public banner flag (works on the sign-in page too). */
export async function fetchSandboxBanner(): Promise<SandboxBannerStatus | null> {
  try {
    const res = await fetch('/api/sandbox/status', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as SandboxBannerStatus) : null;
  } catch {
    return null;
  }
}

/** Reload the app on whichever file the server now has open. */
function reloadOnNewFile(): void {
  window.location.assign('/dashboard');
}

async function handOffToShell(enteredDir: string | null, trainingDir?: string | null): Promise<void> {
  const b = bridge()?.sandbox;
  if (b) {
    const ok = enteredDir ? await b.entered(enteredDir) : await b.left({ trainingDir: trainingDir ?? null });
    if (ok) return; // the desktop shell relaunches into the right file
  }
  reloadOnNewFile();
}

/** One click: copy the company file and open the app on the copy. */
export async function startSandbox(): Promise<void> {
  const r = await api.post<{ dir: string }>('/api/sandbox');
  await handOffToShell(r.dir);
}

/** Re-open a copy left over from an earlier sandbox. */
export async function resumeLeftoverSandbox(id: string): Promise<void> {
  const r = await api.post<{ dir: string }>(`/api/sandbox/leftovers/${encodeURIComponent(id)}`);
  await handOffToShell(r.dir);
}

/** Delete the copy and go back to the real books. */
export async function discardSandbox(): Promise<void> {
  await api.post('/api/sandbox/discard');
  await handOffToShell(null);
}

/** Keep the copy as a training file (never merged back) and go back to the real books. */
export async function keepSandbox(name: string): Promise<{ name: string }> {
  const r = await api.post<{ trainingDir: string; name: string }>('/api/sandbox/keep', { name });
  await handOffToShell(null, r.trainingDir);
  return { name: r.name };
}
