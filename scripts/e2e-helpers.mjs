/**
 * Shared pieces of the desktop end-to-end scripts (scripts/e2e-desktop.mjs, e2e-keyboard.mjs,
 * e2e-multiuser.mjs): drive the packaged app's pages over the Chrome DevTools protocol, and click
 * its native message boxes with Windows UI Automation. Nothing here types through Windows'
 * keyboard (that would reach whatever window is in front), and a native click only happens when
 * the point under it really is the button (never another program's window).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy (or `ms` pass: null). */
export async function until(fn, ms = 60_000, step = 400) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

export function makeAssert() {
  const state = { failures: 0 };
  const assert = (cond, msg) => {
    if (cond) console.log(`  ✓ ${msg}`);
    else {
      state.failures++;
      console.error(`  ✗ ${msg}`);
    }
  };
  return { assert, state };
}

export function powershell(script, timeoutMs = 120_000) {
  return new Promise((resolve) =>
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, out) =>
      resolve({ ok: !err, out: String(out || '').trim() }),
    ),
  );
}

/** PowerShell selecting this test's own app processes (by executable path). */
export function ownProcs(exe) {
  return `Get-Process -Name Ironbooks -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }`;
}

export async function appCount(exe) {
  const r = await powershell(`(${ownProcs(exe)} | Measure-Object).Count`);
  return Number(r.out) || 0;
}

export async function stopApps(exe) {
  await powershell(`${ownProcs(exe)} | Stop-Process -Force`);
}

/** A page of the app over the DevTools protocol. */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60_000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }
  async shot(dir, name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  /** Press a key in the page (DevTools input, never the OS keyboard). */
  async press(k, { ctrl = false, shift = false, alt = false } = {}) {
    const VK = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Tab: 9, '+': 187, '-': 189 };
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift || k === '+' ? 8 : 0);
    const single = k.length === 1;
    const code = k === '+' ? 'Equal' : k === '-' ? 'Minus' : single ? `Key${k.toUpperCase()}` : k;
    const vk = VK[k] ?? (single ? k.toUpperCase().charCodeAt(0) : 0);
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (single && !ctrl && !alt) await this.send('Input.dispatchKeyEvent', { type: 'char', text: k, unmodifiedText: k, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(400);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

/** Connect to the page on DevTools `port` whose URL passes `test`. */
export async function connect(port, test, ms = 90_000) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && test(t.url));
  }, ms);
  if (!target) throw new Error(`no app window on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const page = new Page(ws);
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return page;
}

/**
 * Click the button named `name` in one of the app's native message boxes. Invoke when the button
 * offers it; otherwise a mouse click at its centre, only after bringing its window forward and
 * checking that the element at that point IS the button. Resolves true when clicked.
 */
export async function clickNativeButton(exe, name, timeoutSec = 40) {
  const r = await powershell(
    `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace IbNs -Name IbMouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
# UI Automation reports physical pixels: work in them too (scaled displays).
[IbNs.IbMouse]::SetProcessDPIAware() | Out-Null
$pids = @(${ownProcs(exe)} | ForEach-Object { $_.Id })
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name.replace(/'/g, "''")}')
$deadline = (Get-Date).AddSeconds(${timeoutSec})
while ((Get-Date) -lt $deadline) {
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    if ($pids -notcontains $w.Current.ProcessId) { continue }
    $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $b) { continue }
    try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); 'clicked'; exit 0 } catch { }
    $r = $b.Current.BoundingRectangle
    if ($r.Width -le 0) { continue }
    # Raise the window (and the message box it owns) above the others without taking the keyboard
    # focus from whoever has it: topmost, then back to normal.
    $hw = [IntPtr]$w.Current.NativeWindowHandle
    [IbNs.IbMouse]::SetWindowPos($hw, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null
    [IbNs.IbMouse]::SetWindowPos($hw, [IntPtr](-2), 0, 0, 0, 0, 0x0013) | Out-Null
    Start-Sleep -Milliseconds 400
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    $at = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y)))
    if (-not $at -or $at.Current.ProcessId -ne $w.Current.ProcessId -or $at.Current.Name -ne '${name.replace(/'/g, "''")}') { Start-Sleep -Milliseconds 400; continue }
    [IbNs.IbMouse]::SetCursorPos($x, $y) | Out-Null
    [IbNs.IbMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [IbNs.IbMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    'clicked'; exit 0
  }
  Start-Sleep -Milliseconds 400
}
'notfound'; exit 1`,
    (timeoutSec + 30) * 1000,
  );
  return r.ok && /clicked/.test(r.out);
}

/** True while one of the app's native windows shows a button named `name` (looks, never clicks). */
export async function nativeButtonShown(exe, name) {
  const r = await powershell(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$pids = @(${ownProcs(exe)} | ForEach-Object { $_.Id })
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name.replace(/'/g, "''")}')
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($pids -notcontains $w.Current.ProcessId) { continue }
  if ($w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)) { 'shown'; exit 0 }
}
'none'`);
  return /shown/.test(r.out);
}

/** The text of the app's native windows and message boxes (diagnostics when a step fails). */
export async function dumpWindows(exe) {
  const r = await powershell(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$pids = @(${ownProcs(exe)} | ForEach-Object { $_.Id })
$root = [System.Windows.Automation.AutomationElement]::RootElement
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($pids -notcontains $w.Current.ProcessId) { continue }
  "WINDOW [$($w.Current.Name)] pid=$($w.Current.ProcessId)"
  foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -match 'Text|Pane' -and $e.Current.Name -and $e.Current.Name.Length -gt 3) { "  $($e.Current.Name)" }
  }
}`);
  return r.out;
}

/**
 * E2E_UNC=1: put the "file server" folder behind this computer's own SMB server (the C$ share
 * of localhost, as a UNC path), so every read, write, lock and rename of the company file goes
 * over the same SMB protocol as an office file server.
 */
export function onFileServer(localPath) {
  if (!process.env.E2E_UNC) return localPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(localPath);
  return m ? `\\\\localhost\\${m[1].toUpperCase()}$\\${m[2]}` : localPath;
}
