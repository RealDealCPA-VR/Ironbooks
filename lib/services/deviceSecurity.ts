/**
 * Is the drive that holds the company file encrypted by Windows (BitLocker / Device Encryption)?
 * Company > Security shows one quiet line about it (lib/deviceSecurityText.ts): with no file
 * password, drive encryption is what protects the books on a lost or stolen computer.
 *
 * Asked without administrator rights: Windows PowerShell reads the shell property
 * System.Volume.BitLockerProtection of the drive (the value Explorer uses for its BitLocker
 * icons), with the drive letter passed as an argument after it has been checked to be one letter,
 * never written into the script. Anything that can't be answered for sure is 'unknown', and the
 * page then says nothing: another computer, not Windows, a network or removable drive, a path we
 * can't place on a drive letter, a slow or failed PowerShell, or a value we don't know the meaning
 * of. The answer is kept for the life of the server process (the company file doesn't move while
 * it is open), so PowerShell runs at most once per drive.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '@/lib/db';
import type { DriveEncryption } from '@/lib/deviceSecurityText';

export type { DriveEncryption } from '@/lib/deviceSecurityText';

/** Runs a program and gives back what it printed ('' when it failed or took too long). */
export type ProbeRunner = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<string>;

/** PowerShell starts in about a second; past this the answer is 'unknown'. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * The probe. Fixed text: the drive letter arrives as the script block's argument and is checked
 * again here. Prints the drive type (only a fixed drive is judged) and the property's raw value.
 */
export const PROBE_SCRIPT = [
  '& { param([string]$d)',
  "if ($d -notmatch '^[A-Za-z]$') { exit 2 }",
  'try {',
  "$t = (New-Object System.IO.DriveInfo ($d + ':')).DriveType;",
  "$p = (New-Object -ComObject Shell.Application).NameSpace($d + ':').Self.ExtendedProperty('System.Volume.BitLockerProtection');",
  "'type=' + $t;",
  "'bitlocker=' + $p",
  '} catch { exit 3 } }',
].join(' ');

/** Windows PowerShell by its full path (never found through PATH). */
export function powershellPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Exactly one letter A-Z (either case): the only thing ever passed to the probe. */
export function isDriveLetter(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z]$/.test(s);
}

/**
 * The drive letter of a Windows path ('C' for C:\Books\Acme.ironbooks), or null when it is not on
 * a lettered drive: a network share (\\server\share), a device path, or a relative path.
 */
export function driveLetterOf(p: string | null | undefined): string | null {
  if (typeof p !== 'string' || !p) return null;
  let s = p;
  // \\?\C:\... (a long-path prefix) is still drive C; \\?\UNC\... and other device paths are not.
  const long = /^[\\/]{2}[?.][\\/]([A-Za-z]:[\\/].*)$/.exec(s);
  if (long) s = long[1];
  const m = /^([A-Za-z]):[\\/]/.exec(s);
  return m ? m[1].toUpperCase() : null;
}

/**
 * System.Volume.BitLockerProtection as an answer. Microsoft does not document its values; the
 * ones every description of it agrees on are 1 (BitLocker on) and 2 (BitLocker off). Others are
 * described differently from one source to the next (encrypting, decrypting, suspended, locked,
 * and 0 or empty where BitLocker isn't available), so they are 'unknown': the page says nothing
 * rather than something that might be wrong.
 */
export function bitLockerState(raw: string | number | null | undefined): DriveEncryption {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (v === 1) return 'encrypted';
  if (v === 2) return 'not-encrypted';
  return 'unknown';
}

/** The probe's output as an answer: only a fixed (built-in) drive is judged. */
export function parseProbeOutput(stdout: string): DriveEncryption {
  const fields = new Map<string, string>();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  if (fields.get('type') !== 'Fixed') return 'unknown';
  return bitLockerState(fields.get('bitlocker'));
}

const runWithExecFile: ProbeRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) =>
        resolve(err ? '' : String(stdout ?? '')),
      );
    } catch {
      resolve('');
    }
  });

/** Ask Windows about one drive. Anything but a single letter is 'unknown' without running anything. */
export async function probeDrive(letter: string, runner: ProbeRunner = runWithExecFile): Promise<DriveEncryption> {
  if (!isDriveLetter(letter)) return 'unknown';
  try {
    const out = await runner(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT, letter.toUpperCase()],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    return parseProbeOutput(out);
  } catch {
    return 'unknown';
  }
}

/**
 * Where the company file is on this computer: the file the desktop shell opened
 * (BKA_COMPANY_FILE), else the data folder; with links and substituted drives followed to the
 * real location where possible.
 */
export function companyFileLocation(env: Record<string, string | undefined> = process.env): string {
  const p = env.BKA_COMPANY_FILE?.trim() || resolveDataDir();
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Answers per drive letter for the life of the process (one probe each, shared while running). */
function cache(): Map<string, Promise<DriveEncryption>> {
  const g = globalThis as unknown as { __bkaDriveEncryption?: Map<string, Promise<DriveEncryption>> };
  return (g.__bkaDriveEncryption ??= new Map());
}

/** Forget the answers (tests). */
export function resetDriveEncryptionCache(): void {
  cache().clear();
}

/**
 * Whether the drive holding the company file is encrypted by Windows. 'unknown' straight away,
 * without running anything, for a request from another computer (the answer is about this one)
 * and off Windows.
 */
export async function driveEncryption(opts: {
  remote: boolean;
  platform?: NodeJS.Platform;
  location?: string;
  runner?: ProbeRunner;
}): Promise<DriveEncryption> {
  if (opts.remote) return 'unknown';
  if ((opts.platform ?? process.platform) !== 'win32') return 'unknown';
  const letter = driveLetterOf(opts.location ?? companyFileLocation());
  if (!letter) return 'unknown';
  const answers = cache();
  let answer = answers.get(letter);
  if (!answer) {
    answer = probeDrive(letter, opts.runner);
    answers.set(letter, answer);
  }
  return answer;
}
