/**
 * Bank file loading for Banking > Import (purchbank leftovers): Windows-1252 statement files keep
 * their accented payees in the browser path, and the Electron file dialog gets its filters the
 * way electron/main.js reads them (the argument IS the filters list) and its result's file name.
 */
import { describe, it, expect } from 'vitest';
import { bankFileFilters, fileNameOf, openBankFileWithDialog, readBankFileText } from './bankFileClient';

describe('readBankFileText (browser file picker)', () => {
  it('decodes a Windows-1252 CSV (file.text() read it as UTF-8 and lost the accents)', async () => {
    // "Café Olé,12.50" in Windows-1252: é = 0xE9.
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x4f, 0x6c, 0xe9, 0x2c, 0x31, 0x32, 0x2e, 0x35, 0x30]);
    expect(await readBankFileText(new Blob([bytes]))).toBe('Café Olé,12.50');
  });

  it('reads UTF-8 (with a byte-order mark) as UTF-8', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Crème brûlée')]);
    expect(await readBankFileText(new Blob([bytes]))).toBe('Crème brûlée');
  });
});

describe('openBankFileWithDialog (Electron)', () => {
  it('passes the filters list itself (main.js uses its argument as the dialog filters)', async () => {
    const calls: unknown[] = [];
    const bridge = {
      openFile: async (filters?: unknown) => {
        calls.push(filters);
        return { filePath: 'C:\\Users\\me\\Downloads\\march.ofx', content: 'OFXHEADER:100' };
      },
    };
    const opened = await openBankFileWithDialog(bridge, 'ofx');
    expect(Array.isArray(calls[0])).toBe(true);
    expect(calls[0]).toEqual([{ name: 'Bank file', extensions: ['ofx', 'qfx'] }]);
    // The dialog answers { filePath, content }: the page used result.filename (undefined).
    expect(opened).toEqual({ content: 'OFXHEADER:100', filename: 'march.ofx' });
  });

  it('a cancelled dialog is null', async () => {
    expect(await openBankFileWithDialog({ openFile: async () => null }, 'csv')).toBeNull();
  });

  it('filters per kind and file names from either path style', () => {
    expect(bankFileFilters('qbo')).toEqual([{ name: 'Bank file', extensions: ['qbo'] }]);
    expect(bankFileFilters('csv')).toEqual([{ name: 'Bank file', extensions: ['csv'] }]);
    expect(fileNameOf('/home/me/stmt.csv')).toBe('stmt.csv');
    expect(fileNameOf('C:\\a\\b\\stmt.qbo')).toBe('stmt.qbo');
    expect(fileNameOf('')).toBe('bank file');
  });
});
