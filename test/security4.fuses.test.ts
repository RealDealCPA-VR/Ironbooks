/**
 * Security plan 4.4: Electron's build-time switches ("fuses", package.json build.electronFuses,
 * flipped by electron-builder in the packaged Ironbooks.exe right before it is signed). Each
 * choice is pinned here with the reason, because a wrong one either stops the app from starting
 * or quietly reopens what it closes. Nothing here starts Electron.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build;
const fuses = build.electronFuses as Record<string, boolean>;
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const electronFiles = fs.readdirSync(path.join(root, 'electron')).filter((f) => f.endsWith('.js'));

describe('4.4: Electron fuses', () => {
  it('sets exactly the fuses chosen (electron-builder flips them, no hand-written hook)', () => {
    expect(fuses).toEqual({
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: true,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    });
    expect(build.afterPack).toBeUndefined();
  });

  it('runAsNode stays ON: the app starts its own server by running Ironbooks.exe as Node', () => {
    // electron/main.js starts the company server and every scratch server with
    // spawn(process.execPath, [<resources>/app/server.js], { env: { ELECTRON_RUN_AS_NODE: '1' } }).
    // With the fuse off, Electron ignores that variable and starts a second app window instead:
    // the books never open.
    expect(fuses.runAsNode).toBe(true);
    const main = read('electron/main.js');
    expect(main.match(/spawn(?:Scratch)?\(process\.execPath, \[/g)?.length).toBeGreaterThanOrEqual(2);
    expect(main.match(/ELECTRON_RUN_AS_NODE: '1'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("--inspect is off; NODE_OPTIONS stays at Electron's default so a company network's certificates keep working", () => {
    // --inspect / SIGUSR1 are debugging hooks the installed app never uses: off.
    //
    // The NODE_OPTIONS fuse is deliberately left ON. Turning it off also makes Ironbooks.exe drop
    // NODE_EXTRA_CA_CERTS (checked in the packaged app: the server child no longer saw it), which
    // an office behind its own certificate authority needs for AI and mail. It would add little:
    // the packaged app's own process only honours a short safe list of NODE_OPTIONS, the server
    // is never handed NODE_OPTIONS at all (inheritedServerEnv, checked below), and runAsNode has
    // to stay on anyway.
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(true);
    expect(fuses.enableNodeCliInspectArguments).toBe(false);
    const { inheritedServerEnv } = require(path.join(root, 'electron', 'localServer.js'));
    const env = inheritedServerEnv({ NODE_OPTIONS: '--require x', node_options: '--inspect', NODE_EXTRA_CA_CERTS: 'ca.pem', PATH: 'p' }, { packaged: true });
    expect(env).toEqual({ NODE_EXTRA_CA_CERTS: 'ca.pem', PATH: 'p' });
    for (const f of electronFiles) expect(read(`electron/${f}`), f).not.toMatch(/--inspect|execArgv/);
    // The desktop end-to-end tests drive the packaged app through Chromium's remote debugging
    // switch, which is not a Node inspect argument and keeps working.
    for (const s of ['scripts/e2e-desktop.mjs', 'scripts/e2e-keyboard.mjs', 'scripts/e2e-multiuser.mjs']) {
      const text = read(s);
      expect(text, s).toMatch(/--remote-debugging-port=/);
      expect(text, s).not.toMatch(/--inspect/);
    }
  });

  it('the app code loads only from a checked app.asar', () => {
    // electron-builder packs electron/** into resources/app.asar (asar is on: not turned off here)
    // and, on Windows, writes the archive's hash into Ironbooks.exe (asar integrity, not turned
    // off). Without onlyLoadAppFromAsar Electron would fall back to resources/app — which is where
    // extraResources puts the Next.js server — or default_app.asar.
    // The server child is unaffected: run as Node it is given an explicit script path
    // (resources/app/server.js) and never goes through the app search.
    expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
    expect(fuses.onlyLoadAppFromAsar).toBe(true);
    expect(build.asar).not.toBe(false);
    expect(build.disableAsarIntegrity).not.toBe(true);
    expect(build.win?.disableAsarIntegrity).not.toBe(true);
    expect(build.files).toContain('electron/**/*');
    expect(build.extraResources.find((r: { from: string }) => r.from === '.next/standalone')?.to).toBe('app');
  });

  it('file:// pages get no extra privileges: no window loads one', () => {
    // Windows load data: pages (prompts, the start-up screen) and the app's own http origin.
    expect(fuses.grantFileProtocolExtraPrivileges).toBe(false);
    for (const f of electronFiles) {
      const text = read(`electron/${f}`);
      expect(text, f).not.toMatch(/\.loadFile\(|loadURL\(\s*['"`]file:|pathToFileURL/);
    }
  });

  it('cookies on disk are encrypted with the Windows account (a one-way switch: never turn it back off)', () => {
    // Existing unencrypted cookies stay readable and are encrypted when next written (Electron's
    // fuse documentation), so a signed-in person stays signed in across the update. Turning the
    // fuse off again later would make the encrypted cookie store unreadable.
    expect(fuses.enableCookieEncryption).toBe(true);
  });
});
