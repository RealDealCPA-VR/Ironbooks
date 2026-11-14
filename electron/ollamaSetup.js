/**
 * "Set up free AI" — install Ollama for the person, so a free model on this computer is one click
 * (AI & Automation). Windows: download Ollama's official installer, check its Authenticode
 * signature (valid, signed by Ollama), then run it — the person sees Ollama's own installer.
 * macOS / Linux: open Ollama's download page (their installers are a drag-to-Applications app
 * and a shell script, which Ironbooks does not run for you).
 *
 * Pure logic with injected effects (fetch, signature check, launch) so it is testable; the IPC
 * handler in main.js adds the confirmation dialog and the Privacy & Network check.
 */
const fs = require('node:fs');
const path = require('node:path');

const OLLAMA_DOWNLOAD_PAGE = 'https://ollama.com/download';
const OLLAMA_WINDOWS_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe';
/**
 * Where the installer may come from after redirects: ollama.com, Ollama's own GitHub releases,
 * and GitHub's download hosts those releases redirect to. Not any GitHub user's release.
 */
function allowedUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'ollama.com' || host.endsWith('.ollama.com')) return true;
    if (host === 'github.com') return /^\/ollama\/ollama\/releases\//i.test(url.pathname);
    return host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com';
  } catch {
    return false;
  }
}

/** No data for this long during the download: give up (a dropped connection must not hang forever). */
const STALL_MS = 60_000;

/** Download `url` to `dest`, reporting { received, total }. Refuses a redirect off the allowed hosts. */
async function downloadTo(url, dest, { fetchImpl = fetch, onProgress, signal, stallMs = STALL_MS } = {}) {
  if (!allowedUrl(url)) throw new Error('That download address is not Ollama’s.');
  // Our own controller: aborted by the caller's signal (Cancel) or when no data arrives for a while.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let stall = setTimeout(() => ac.abort(), stallMs);
  const kick = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ac.abort(), stallMs);
  };
  try {
    return await downloadInner(url, dest, { fetchImpl, onProgress, signal: ac.signal, kick });
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error(signal?.aborted ? 'The Ollama download was cancelled.' : 'The Ollama download stopped (no data for a minute). Check the connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(stall);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function downloadInner(url, dest, { fetchImpl, onProgress, signal, kick }) {
  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (res.url && !allowedUrl(res.url)) throw new Error('The download was redirected somewhere other than Ollama.');
  if (!res.ok || !res.body) throw new Error(`Ollama’s download answered HTTP ${res.status}.`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      kick();
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      onProgress?.({ received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (total && received !== total) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The Ollama download was cut off. Try again.');
  }
  fs.renameSync(tmp, dest);
  return { received };
}

/** The signer's organization (O=) is exactly Ollama's — not just a name that starts with it. */
const OLLAMA_ORGS = new Set(['ollama inc.', 'ollama inc', 'ollama, inc.', 'ollama']);
function signedByOllama(subject) {
  // Split the distinguished name on commas outside quotes: O="Ollama, Inc." stays one field.
  const fields = [];
  let cur = '';
  let quoted = false;
  for (const ch of String(subject)) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      fields.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields.some((f) => {
    const m = /^O=(.*)$/i.exec(f);
    return !!m && OLLAMA_ORGS.has(m[1].replace(/^"|"$/g, '').trim().toLowerCase());
  });
}

/**
 * Windows Authenticode check via PowerShell's Get-AuthenticodeSignature. Resolves
 * { ok, status, subject }; ok only for a Valid signature whose signer names Ollama.
 */
function checkSignature(file, { run } = {}) {
  // The path travels in an environment variable, never inside the command text (no quoting or
  // injection issues; -Command does not pass extra arguments to the script anyway).
  const exec =
    run ??
    ((args, env) =>
      new Promise((resolve) => {
        const { execFile } = require('node:child_process');
        // By full path: a bare name is looked up in the current folder first on Windows.
        const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        execFile(ps, args, { windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } }, (err, stdout) =>
          resolve(err ? '' : String(stdout)),
        );
      }));
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:IB_SIG_FILE; ' +
    '[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
  return Promise.resolve(exec(['-NoProfile', '-NonInteractive', '-Command', script], { IB_SIG_FILE: file })).then((out) => {
    let parsed = {};
    try {
      parsed = JSON.parse(String(out).trim() || '{}');
    } catch {
      /* unreadable */
    }
    const status = String(parsed.status ?? '');
    const subject = String(parsed.subject ?? '');
    return { ok: status === 'Valid' && signedByOllama(subject), status, subject };
  });
}

/**
 * Install Ollama. Resolves { done: 'installer-started' | 'page-opened' } or throws a plain-words
 * Error. `deps`: { platform, tmpDir, fetchImpl, checkSig, launch, openPage, onProgress, signal }.
 */
async function installOllama(deps) {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    await deps.openPage(OLLAMA_DOWNLOAD_PAGE);
    return { done: 'page-opened' };
  }
  fs.mkdirSync(deps.tmpDir, { recursive: true });
  const file = path.join(deps.tmpDir, 'OllamaSetup.exe');
  fs.rmSync(file, { force: true });
  await downloadTo(OLLAMA_WINDOWS_INSTALLER, file, { fetchImpl: deps.fetchImpl, onProgress: deps.onProgress, signal: deps.signal, stallMs: deps.stallMs });
  const sig = await (deps.checkSig ?? checkSignature)(file);
  if (!sig.ok) {
    fs.rmSync(file, { force: true });
    throw new Error(
      `The downloaded installer is not signed by Ollama (${sig.status || 'no signature'}), so Ironbooks did not run it. ` +
        'You can install Ollama yourself from ollama.com/download.',
    );
  }
  await deps.launch(file);
  return { done: 'installer-started' };
}

module.exports = { OLLAMA_DOWNLOAD_PAGE, OLLAMA_WINDOWS_INSTALLER, allowedUrl, downloadTo, checkSignature, signedByOllama, installOllama };
