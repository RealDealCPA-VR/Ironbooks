/**
 * Security work package E1 (SECURITY-PLAN 4.9): the list of mapped network drives comes from
 * Windows' own net.exe, run by its full path. Run by bare name, Windows looks in the CURRENT folder
 * first, where a planted net.exe would run instead. Nothing is run on other systems.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[] }>);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = vi.fn((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    return 'New connections will be remembered.\r\n\r\nStatus       Local     Remote\r\nOK           Q:        \\\\office-server\\books   Microsoft Windows Network\r\n';
  });
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import { isNetworkPath, setMappedDrivesForTests } from './backupHistory';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const systemRoot = process.env.SystemRoot;

function asPlatform<T>(name: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, 'platform', { ...platform, value: name });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

afterEach(() => {
  calls.length = 0;
  setMappedDrivesForTests(null);
  if (systemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = systemRoot;
});

describe('mapped network drives', () => {
  it('are listed by net.exe from the Windows folder, never a net.exe found by name', () => {
    process.env.SystemRoot = 'D:\\WinDir';
    setMappedDrivesForTests(null);
    expect(asPlatform('win32', () => isNetworkPath('Q:\\Books'))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).not.toBe('net');
    expect(calls[0].file.startsWith('D:\\WinDir')).toBe(true);
    expect(calls[0].file).toMatch(/System32[\\/]net\.exe$/);
    expect(calls[0].args).toEqual(['use']);
  });

  it('nothing is run on other systems', () => {
    setMappedDrivesForTests(null);
    expect(asPlatform('linux', () => isNetworkPath('Q:\\Books'))).toBe(false);
    expect(calls).toEqual([]);
  });
});
