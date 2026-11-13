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
/** Where the installer may come from after redirects (ollama.com hands off to GitHub releases). */
const ALLOWED_HOSTS = /(^|\.)(ollama\.com|github\.com|githubusercontent\.com)$/i;

function allowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** Download `url` to `dest`, reporting { received, total }. Refuses a redirect off the allowed hosts. */
async function downloadTo(url, dest, { fetchImpl = fetch, onProgress, signal } = {}) {
  if (!allowedUrl(url)) throw new Error('That download address is not Ollama’s.');
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
        execFile('powershell.exe', args, { windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } }, (err, stdout) =>
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
    return { ok: status === 'Valid' && /\bO=Ollama\b|CN=Ollama\b/i.test(subject), status, subject };
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
  await downloadTo(OLLAMA_WINDOWS_INSTALLER, file, { fetchImpl: deps.fetchImpl, onProgress: deps.onProgress, signal: deps.signal });
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

module.exports = { OLLAMA_DOWNLOAD_PAGE, OLLAMA_WINDOWS_INSTALLER, allowedUrl, downloadTo, checkSignature, installOllama };
