/**
 * Company > Security: the quiet line about Windows drive encryption under the file password card
 * (app/security/page.tsx, components/FileProtection.tsx DriveEncryptionStatus). Pure: shared by the
 * page and the server (lib/services/deviceSecurity.ts, GET /api/device-security).
 *
 * With no file password a company file is an ordinary file, so what protects it from someone who
 * takes the computer is Windows drive encryption (BitLocker / Device Encryption).
 */

/** Whether the drive holding the company file is encrypted by Windows; 'unknown' says nothing. */
export type DriveEncryption = 'encrypted' | 'not-encrypted' | 'unknown';

/** GET /api/device-security. */
export interface DeviceSecurityDto {
  drive: DriveEncryption;
  /** The company file is protected with passwords (encrypted itself, filecrypto). */
  fileProtected: boolean;
}

export const DRIVE_ENCRYPTED_TEXT = 'This drive is encrypted by Windows (BitLocker).';
export const DRIVE_NOT_ENCRYPTED_TEXT =
  'This drive is not encrypted. If this computer is lost or stolen, someone could read your company file. Turn on Device Encryption or BitLocker in Windows Settings, or set a file password above.';

/**
 * The line to show, or null for nothing. Nothing when the state is not known (another computer,
 * not Windows, a network or removable drive, an answer we can't read), and no warning when the
 * file has a file password: the file itself is encrypted then, so "someone could read your company
 * file" would not be true.
 */
export function driveEncryptionLine(s: DeviceSecurityDto | null | undefined): string | null {
  if (!s) return null;
  if (s.drive === 'encrypted') return DRIVE_ENCRYPTED_TEXT;
  if (s.drive === 'not-encrypted' && !s.fileProtected) return DRIVE_NOT_ENCRYPTED_TEXT;
  return null;
}
