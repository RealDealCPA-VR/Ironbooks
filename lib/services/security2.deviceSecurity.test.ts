/**
 * Security package G2 — Company > Security's line about Windows drive encryption
 * (lib/services/deviceSecurity.ts, lib/deviceSecurityText.ts, GET /api/device-security).
 *
 *  - the probe's answer: only BitLocker "on" (1) and "off" (2) on a fixed drive are judged;
 *    everything else is 'unknown' and the page says nothing;
 *  - only a single letter A-Z is ever passed to PowerShell, as an argument after a fixed script;
 *  - a request from another computer, or off Windows, is 'unknown' without running anything;
 *  - the answer is kept for the life of the process (one probe per drive);
 *  - the line: shown for encrypted, warned for not encrypted without a file password, else nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { REMOTE_ADDR_HEADER } from '@/lib/net/requestInfo';
import { apiRuleFor } from '@/lib/permissions/routes';
import { DRIVE_ENCRYPTED_TEXT, DRIVE_NOT_ENCRYPTED_TEXT, driveEncryptionLine } from '@/lib/deviceSecurityText';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import {
  PROBE_SCRIPT,
  bitLockerState,
  driveEncryption,
  driveLetterOf,
  isDriveLetter,
  parseProbeOutput,
  powershellPath,
  probeDrive,
  resetDriveEncryptionCache,
  type ProbeRunner,
} from './deviceSecurity';

const execFileSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileSpy };
});
let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as deviceGET } from '@/app/api/device-security/route';

const out = (type: string, value: string) => `type=${type}\r\nbitlocker=${value}\r\n`;

beforeEach(() => {
  resetDriveEncryptionCache();
  execFileSpy.mockReset();
});

describe('reading the answer', () => {
  it('BitLocker on (1) and off (2) are judged; every other value is unknown', () => {
    expect(bitLockerState('1')).toBe('encrypted');
    expect(bitLockerState(1)).toBe('encrypted');
    expect(bitLockerState('2')).toBe('not-encrypted');
    expect(bitLockerState(' 2 ')).toBe('not-encrypted');
    // Undocumented, and described differently from one source to another (encrypting, decrypting,
    // suspended, locked; 0 where BitLocker isn't available): say nothing rather than guess.
    for (const v of ['0', '3', '4', '5', '6', '7', '8', '', '-1', '1.5', 'On', null, undefined]) {
      expect(bitLockerState(v as string | null | undefined), String(v)).toBe('unknown');
    }
  });

  it('only a fixed drive is judged', () => {
    expect(parseProbeOutput(out('Fixed', '1'))).toBe('encrypted');
    expect(parseProbeOutput(out('Fixed', '2'))).toBe('not-encrypted');
    expect(parseProbeOutput('type=Fixed\nbitlocker=2')).toBe('not-encrypted');
    expect(parseProbeOutput(out('Fixed', '0'))).toBe('unknown'); // what this Windows 11 Home PC answers
    expect(parseProbeOutput(out('Fixed', ''))).toBe('unknown'); // no value
    for (const type of ['Removable', 'Network', 'CDRom', 'Ram', 'NoRootDirectory', 'Unknown']) {
      expect(parseProbeOutput(out(type, '1')), type).toBe('unknown');
    }
    expect(parseProbeOutput('')).toBe('unknown');
    expect(parseProbeOutput('bitlocker=1')).toBe('unknown');
    expect(parseProbeOutput('garbage')).toBe('unknown');
  });
});

describe('the drive letter', () => {
  it('is exactly one letter A-Z', () => {
    for (const ok of ['C', 'c', 'Z', 'a']) expect(isDriveLetter(ok), ok).toBe(true);
    for (const bad of ['', 'C:', 'CD', '1', ' C', 'C ', "C'; calc", 'Ä', '\\', null, undefined, 3]) {
      expect(isDriveLetter(bad), String(bad)).toBe(false);
    }
  });

  it('is read from a Windows path; network shares and device paths have none', () => {
    expect(driveLetterOf('C:\\Users\\Me\\Documents\\Acme.ironbooks')).toBe('C');
    expect(driveLetterOf('d:/Books/Acme.ironbooks')).toBe('D');
    expect(driveLetterOf('\\\\?\\E:\\Books\\Acme.ironbooks')).toBe('E');
    expect(driveLetterOf('\\\\server\\share\\Acme.ironbooks')).toBeNull();
    expect(driveLetterOf('//server/share/Acme.ironbooks')).toBeNull();
    expect(driveLetterOf('\\\\?\\UNC\\server\\share\\Acme.ironbooks')).toBeNull();
    expect(driveLetterOf('\\\\.\\PhysicalDrive0')).toBeNull();
    expect(driveLetterOf('Books\\Acme.ironbooks')).toBeNull();
    expect(driveLetterOf('C:relative')).toBeNull();
    expect(driveLetterOf('')).toBeNull();
    expect(driveLetterOf(null)).toBeNull();
  });

  it('only a checked letter reaches PowerShell, as an argument after the fixed script', async () => {
    const runner = vi.fn<ProbeRunner>(async () => out('Fixed', '1'));
    for (const bad of ['C:', "C'; Remove-Item x", 'CD', '']) {
      expect(await probeDrive(bad, runner)).toBe('unknown');
    }
    expect(runner).not.toHaveBeenCalled();
    expect(await probeDrive('c', runner)).toBe('encrypted');
    expect(runner).toHaveBeenCalledTimes(1);
    const [file, args, opts] = runner.mock.calls[0];
    expect(file).toBe(powershellPath());
    expect(file).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT, 'C']);
    expect(opts.timeoutMs).toBeLessThanOrEqual(10_000);
    // The script is fixed text: no letter written into it, no double quotes to escape.
    expect(PROBE_SCRIPT).not.toMatch(/"/);
    expect(PROBE_SCRIPT).toContain('param([string]$d)');
    expect(PROBE_SCRIPT).toContain("System.Volume.BitLockerProtection");
  });

  it('a failed or slow PowerShell is unknown', async () => {
    expect(await probeDrive('C', async () => '')).toBe('unknown');
    expect(await probeDrive('C', async () => Promise.reject(new Error('timed out')))).toBe('unknown');
  });

  it('uses the full path under the Windows folder', () => {
    expect(powershellPath({ SystemRoot: 'D:\\WINDOWS' })).toBe('D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('when to ask', () => {
  it('another computer: unknown, without running anything', async () => {
    const runner = vi.fn<ProbeRunner>(async () => out('Fixed', '1'));
    expect(await driveEncryption({ remote: true, platform: 'win32', location: 'C:\\Books\\A.ironbooks', runner })).toBe('unknown');
    expect(runner).not.toHaveBeenCalled();
  });

  it('not Windows, or a network share: unknown, without running anything', async () => {
    const runner = vi.fn<ProbeRunner>(async () => out('Fixed', '1'));
    expect(await driveEncryption({ remote: false, platform: 'darwin', location: 'C:\\Books\\A.ironbooks', runner })).toBe('unknown');
    expect(await driveEncryption({ remote: false, platform: 'win32', location: '\\\\nas\\books\\A.ironbooks', runner })).toBe('unknown');
    expect(runner).not.toHaveBeenCalled();
  });

  it('asks once per drive for the life of the process', async () => {
    const runner = vi.fn<ProbeRunner>(async () => out('Fixed', '2'));
    const ask = () => driveEncryption({ remote: false, platform: 'win32', location: 'D:\\Books\\A.ironbooks', runner });
    expect(await Promise.all([ask(), ask()])).toEqual(['not-encrypted', 'not-encrypted']);
    expect(await ask()).toBe('not-encrypted');
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('the line on Company > Security', () => {
  it('encrypted, not encrypted without a file password, otherwise nothing', () => {
    expect(driveEncryptionLine({ drive: 'encrypted', fileProtected: false })).toBe(DRIVE_ENCRYPTED_TEXT);
    expect(driveEncryptionLine({ drive: 'encrypted', fileProtected: true })).toBe(DRIVE_ENCRYPTED_TEXT);
    expect(driveEncryptionLine({ drive: 'not-encrypted', fileProtected: false })).toBe(DRIVE_NOT_ENCRYPTED_TEXT);
    // The file itself is encrypted: "someone could read your company file" would not be true.
    expect(driveEncryptionLine({ drive: 'not-encrypted', fileProtected: true })).toBeNull();
    expect(driveEncryptionLine({ drive: 'unknown', fileProtected: false })).toBeNull();
    expect(driveEncryptionLine({ drive: 'unknown', fileProtected: true })).toBeNull();
    expect(driveEncryptionLine(null)).toBeNull();
    expect(DRIVE_ENCRYPTED_TEXT).toBe('This drive is encrypted by Windows (BitLocker).');
    expect(DRIVE_NOT_ENCRYPTED_TEXT).toBe(
      'This drive is not encrypted. If this computer is lost or stolen, someone could read your company file. Turn on Device Encryption or BitLocker in Windows Settings, or set a file password above.',
    );
  });
});

describe('GET /api/device-security', () => {
  let t: TestCompany;
  beforeAll(async () => {
    t = await makeTestCompany('g2-device-security');
    routeCtx = t.ctx;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('is open to any signed-in member', () => {
    expect(apiRuleFor('/api/device-security', 'GET')).toBe('member');
  });

  it('a request from another computer gets unknown, and nothing is run', async () => {
    const res = await deviceGET(
      new NextRequest('http://localhost/api/device-security', { headers: { [REMOTE_ADDR_HEADER]: '100.64.0.9' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drive: 'unknown', fileProtected: false });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('on this computer it asks Windows (on Windows) and says whether the file has a file password', async () => {
    execFileSpy.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, so: string) => void) => {
      cb(null, out('Fixed', '1'));
    });
    const res = await deviceGET(new NextRequest('http://localhost/api/device-security'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileProtected).toBe(false);
    if (process.platform === 'win32') {
      expect(body.drive).toBe('encrypted');
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      expect(execFileSpy.mock.calls[0][1].slice(-1)[0]).toMatch(/^[A-Z]$/);
    } else {
      expect(body.drive).toBe('unknown');
      expect(execFileSpy).not.toHaveBeenCalled();
    }
  });
});
