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

export interface KeepSandboxOutcome {
  name: string;
  /** null when the server left the sandbox but could not move the copy (see `warning`). */
  trainingDir: string | null;
  warning: string | null;
}

function alertWarning(warning: string): void {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(warning);
}

/**
 * Keep the copy as a training file (never merged back) and go back to the real books.
 *
 * The server may answer with a `warning` instead of a training folder: it is back on the real
 * file, but the copy could not be moved (it is then listed as left over). The leave still
 * happened, so the shell is told just the same (`left` with no training file) — otherwise the
 * desktop app would relaunch into the copy while the server is on the real file. `onWarning`
 * shows the warning first (default: an alert), since the hand-off reloads or relaunches the app.
 */
export async function keepSandbox(
  name: string,
  opts: { onWarning?: (warning: string) => Promise<void> | void } = {},
): Promise<KeepSandboxOutcome> {
  const r = await api.post<{ trainingDir: string | null; name: string; warning?: string | null }>('/api/sandbox/keep', { name });
  const trainingDir = r.trainingDir ?? null;
  const warning = r.warning ?? null;
  if (warning) await (opts.onWarning ?? alertWarning)(warning);
  await handOffToShell(null, trainingDir);
  return { name: r.name, trainingDir, warning };
}

/** True inside the desktop app (Electron), where File > Open Company can switch company files. */
export function isDesktopApp(): boolean {
  return Boolean(bridge()?.isDesktop);
}

/** Help under the "Keep as a training file" name field: how the kept file is opened later. */
export function keepTrainingHelp(isDesktop: boolean): string {
  const where = 'It is saved next to your real company file (as "<name>.ironbooks").';
  const practice = 'It stays a practice copy: emails and bank feeds stay off there too.';
  return isDesktop
    ? `${where} It opens like any other company file (File > Open Company or Recent Companies). ${practice}`
    : `${where} In the browser version the Ironbooks server has one company file open at a time and cannot switch to another one from here: to open the training file, restart the server with BKA_DATA_DIR set to that folder. ${practice}`;
}

/** Inside a training file: how to get back to the real books. */
export function leaveTrainingHelp(isDesktop: boolean): string {
  return isDesktop
    ? 'To go back to your real books, open your real company file from the Company File page or File > Open Company (or Recent Companies).'
    : "In the browser version the Ironbooks server has one company file open at a time and cannot switch files from here: to go back to your real books, restart the server with BKA_DATA_DIR set to your real company file's folder (or unset, if it is the default one).";
}
