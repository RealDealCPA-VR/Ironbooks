/**
 * Security package G2 — the screens and source-only changes (read as text, like lib/navRail.test.ts):
 *  - Back Up & Restore used from another computer: the backup folder is read-only text, the
 *    host-only "Use this folder on this computer" is gone, and the folder is never sent on save;
 *  - month-end close asks for the current closing date password when replacing or removing it
 *    needs it (a non-Admin, a password set), and sends it;
 *  - Company > Security shows the drive-encryption line;
 *  - the portable file download uses the shared file-name header helper;
 *  - lib/db/schema.ts no longer claims encryption the columns don't have.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

describe('Back Up & Restore from another computer', () => {
  const src = read('components/BackupCenter.tsx');

  it('shows the folder as read-only text with the host-only sentence', () => {
    expect(src).toContain('remote?: boolean;');
    expect(src).toContain('{data?.remote ? (');
    expect(src).toContain('The backup folder can only be changed on the computer that holds the company file.');
    // The editable field and "Use this folder on this computer" are only in the other branch.
    const remoteBranch = src.slice(src.indexOf('{data?.remote ? ('), src.indexOf(') : (', src.indexOf('{data?.remote ? (')));
    expect(remoteBranch).not.toContain('id="backup-folder"');
    expect(remoteBranch).not.toContain('Use this folder on this computer');
  });

  it('never sends the folder from another computer; schedule and copies kept still save', () => {
    expect(src).toContain('...(folderEdited && !data?.remote ? { folder: form.folder.trim() || null } : {}),');
    expect(src).toContain('schedule: form.schedule,');
    expect(src).toContain('keep: Number(form.keep),');
    expect(src).toContain("if (!data?.settings.folder || data.remote) return;");
  });
});

describe('month-end close: the current closing date password', () => {
  const src = read('app/month-end/page.tsx');

  it('asks for it only when replacing or removing the password needs it', () => {
    expect(src).toContain("const needsCurrent = checklist.currentPasswordRequired && (mode === 'set' || mode === 'remove');");
    expect(src).toContain('{needsCurrent && (');
    expect(src).toContain('Current closing date password');
    expect(src).toContain('autoComplete="current-password"');
  });

  it('sends it with the close and checks it was typed', () => {
    expect(src).toContain('if (needsCurrent) body.currentPassword = currentPw;');
    expect(src).toContain('if (needsCurrent && !currentPw) {');
  });
});

describe('Company > Security: drive encryption', () => {
  it('the page shows the line under the file password card, fetched on its own', () => {
    const page = read('app/security/page.tsx');
    expect(page).toContain("import { DriveEncryptionStatus } from '@/components/FileProtection';");
    expect(page.indexOf('<DriveEncryptionStatus />')).toBeGreaterThan(page.indexOf('<FileProtectionCard'));
    const comp = read('components/FileProtection.tsx');
    expect(comp).toContain('export function DriveEncryptionStatus()');
    expect(comp).toContain("fetch('/api/device-security', { cache: 'no-store' })");
    expect(comp).toContain('if (!line) return null;');
  });
});

describe('portable company file download', () => {
  it('uses the shared helper, not its own copy of the file-name header', () => {
    const src = read('app/api/portable/route.ts');
    expect(src).toContain("import { fileResponse } from '@/lib/fileDownload';");
    expect(src).not.toMatch(/function contentDisposition/);
    expect(src).not.toContain('encodeURIComponent');
  });
});

describe('lib/db/schema.ts comments', () => {
  it('say the SSN, tax id and account number columns are plain text, protected by the file password', () => {
    const src = read('lib/db/schema.ts');
    // (The file_protection table's comment rightly says a protected company file is encrypted at rest.)
    expect(src).not.toMatch(/\/\/ encrypted at rest/i);
    expect(src).not.toMatch(/Should be encrypted/i);
    for (const col of ["accountNumber: text('account_number')", "taxId: text('tax_id')", "ssn: text('ssn')"]) {
      const at = src.indexOf(col);
      expect(at, col).toBeGreaterThan(0);
      const comment = src.slice(src.lastIndexOf('/**', at), at);
      expect(comment, col).toMatch(/Plain text/);
      expect(comment, col).toMatch(/not encrypted on its own/);
      expect(comment, col).toMatch(/file password/);
      expect(comment, col).toMatch(/masked in API/);
    }
  });
});
