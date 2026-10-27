/**
 * Reading a bank statement file (OFX / QFX / QBO / CSV) for Banking > Import, in the browser and
 * in the desktop app. Pure helpers (no React) so the rules are tested in bankFileClient.test.ts.
 *
 *  - Browser file picker: the bytes go through lib/textDecode (UTF-16 with a BOM, UTF-8, else
 *    Windows-1252). `file.text()` always read UTF-8, so a bank's Windows-1252 export lost every
 *    accented payee ("Café" became "Caf�"), which cannot be undone after import.
 *  - Desktop (Electron): window.bookkeeper.openFile(filters) — electron/main.js uses its argument
 *    as the dialog's filters list, and answers { filePath, content } (already decoded the same
 *    way). The page passed { filters: [...] } and read a `filename` the dialog never sends.
 */
import { decodeText } from './textDecode';

export type BankFileKind = 'ofx' | 'qbo' | 'csv';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenedBankFile {
  content: string;
  filename: string;
}

/** The desktop bridge's file dialog (electron/preload.js openFile). */
export interface OpenFileBridge {
  openFile?: (filters?: FileFilter[]) => Promise<{ filePath?: string; content?: string } | null | undefined>;
}

const EXTENSIONS: Record<BankFileKind, string[]> = {
  // .qfx is accepted everywhere .ofx is.
  ofx: ['ofx', 'qfx'],
  qbo: ['qbo'],
  csv: ['csv'],
};

/** Dialog filters for one kind of bank file. */
export function bankFileFilters(kind: BankFileKind | string): FileFilter[] {
  return [{ name: 'Bank file', extensions: EXTENSIONS[kind as BankFileKind] ?? ['*'] }];
}

/** File name of a Windows or POSIX path. */
export function fileNameOf(filePath: string | null | undefined): string {
  const name = (filePath ?? '').split(/[\\/]/).pop()?.trim();
  return name || 'bank file';
}

/** Text of a file picked in the browser, decoded like the desktop dialog decodes it. */
export async function readBankFileText(file: Blob): Promise<string> {
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}

/** Open a bank file with the desktop file dialog; null when cancelled. */
export async function openBankFileWithDialog(bridge: OpenFileBridge, kind: BankFileKind | string): Promise<OpenedBankFile | null> {
  if (!bridge.openFile) return null;
  const res = await bridge.openFile(bankFileFilters(kind));
  if (!res || typeof res.content !== 'string') return null;
  return { content: res.content, filename: fileNameOf(res.filePath) };
}
