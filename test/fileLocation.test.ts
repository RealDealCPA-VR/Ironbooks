/**
 * electron/fileLocation.js — which company-file locations the desktop shell asks about before
 * opening: a temporary folder (an email attachment opened from Outlook, a browser download cache)
 * and cloud-sync folders (OneDrive, Dropbox, Google Drive, iCloud).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyCompanyFileLocation } = require('../electron/fileLocation.js');

const TMP = 'C:\\Users\\pat\\AppData\\Local\\Temp';

describe('company file locations', () => {
  it('an Outlook attachment or a file in the temp folder is temporary', () => {
    expect(
      classifyCompanyFileLocation('C:\\Users\\pat\\AppData\\Local\\Microsoft\\Windows\\INetCache\\Content.Outlook\\X1\\Books.ironbooks', { tmpdir: TMP }),
    ).toEqual({ kind: 'temp' });
    expect(classifyCompanyFileLocation(`${TMP}\\Books.ironbooks`, { tmpdir: TMP })).toEqual({ kind: 'temp' });
  });

  it('OneDrive is found by its environment folder and by name', () => {
    const env = { OneDrive: 'C:\\Users\\pat\\OneDrive - Smith CPA' };
    expect(classifyCompanyFileLocation('C:\\Users\\pat\\OneDrive - Smith CPA\\Documents\\Books.ironbooks', { env })).toEqual({
      kind: 'cloud',
      service: 'OneDrive',
    });
    expect(classifyCompanyFileLocation('D:\\OneDrive\\Books.ironbooks')).toEqual({ kind: 'cloud', service: 'OneDrive' });
  });

  it('Dropbox, Google Drive and iCloud Drive are cloud folders', () => {
    expect(classifyCompanyFileLocation('C:\\Users\\pat\\Dropbox\\Clients\\Books.ironbooks')).toEqual({ kind: 'cloud', service: 'Dropbox' });
    expect(classifyCompanyFileLocation('G:\\My Drive\\Books.ironbooks')).toEqual({ kind: 'cloud', service: 'Google Drive' });
    expect(classifyCompanyFileLocation('C:\\Users\\pat\\iCloudDrive\\Books.ironbooks')).toEqual({ kind: 'cloud', service: 'iCloud Drive' });
  });

  it('a local folder, a USB drive or the office file server is fine', () => {
    expect(classifyCompanyFileLocation('C:\\Users\\pat\\Documents\\Books.ironbooks', { tmpdir: TMP })).toBeNull();
    expect(classifyCompanyFileLocation('E:\\Books.ironbooks', { tmpdir: TMP })).toBeNull();
    expect(classifyCompanyFileLocation('\\\\SERVER\\Books\\Books.ironbooks', { tmpdir: TMP })).toBeNull();
    // A company merely named after a service is not a sync folder.
    expect(classifyCompanyFileLocation('C:\\Users\\pat\\Documents\\Dropbox Plumbing.ironbooks')).toBeNull();
  });
});
