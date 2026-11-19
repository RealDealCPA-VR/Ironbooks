/**
 * "Set up free AI" — install Ollama for the person, so a free model on this computer is one click
 * (AI & Automation). Windows: download Ollama's official installer into a fresh private folder,
 * check its Authenticode signature (valid, signed by Ollama), check it is still the same file,
 * then run it — the person sees Ollama's own installer.
 * macOS / Linux: open Ollama's download page (their installers are a drag-to-Applications app
 * and a shell script, which Ironbooks does not run for you).
 *
 * Pure logic with injected effects (fetch, signature check, launch) so it is testable; the IPC
 * handler in main.js adds the confirmation dialog and the Privacy & Network check.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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

/**
 * Download `url` to `dest`, reporting { received, total }. Refuses a redirect off the allowed hosts.
 * Resolves { received, sha256 }: the SHA-256 of the bytes as they were written.
 */
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
  // Hashed as it is written, so later checks compare the file on disk with what was downloaded.
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      kick();
      received += value.length;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
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
  return { received, sha256: hash.digest('hex') };
}

/**
 * Ollama's legal name as its code-signing certificate's organization (O=) field holds it,
 * written with or without the comma or the final period (certificate authorities differ on
 * punctuation, and refusing the real installer over a period would break "Set up free AI");
 * letter case is ignored. Only these whole names count: not "Ollama" alone, and not any other
 * name that merely contains the word, because a certificate authority can issue those to other
 * companies.
 */
const OLLAMA_ORGS = new Set(['ollama inc.', 'ollama, inc.', 'ollama inc', 'ollama, inc']);
/** One distinguished-name value: surrounding quotes removed, doubled quotes ("") made single. */
function dnValue(raw) {
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}
/** True only when the subject has exactly one organization (O=) and it is Ollama's, in full. */
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
  const orgs = fields.map((f) => /^O=(.*)$/i.exec(f)).filter(Boolean);
  return orgs.length === 1 && OLLAMA_ORGS.has(dnValue(orgs[0][1]).toLowerCase());
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

/** SHA-256 of a file, read as a stream (the installer is about 1 GB: never all in memory). */
function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * True when `file` still holds exactly the bytes whose SHA-256 is `sha256` (as returned by
 * verifyInstaller). Call it immediately before starting the installer: a file swapped after the
 * signature check is then never run. False for a missing or unreadable file or a malformed hash.
 */
async function stillSameFile(file, sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return false;
  try {
    return (await sha256OfFile(file)) === sha256;
  } catch {
    return false;
  }
}

/**
 * Check a downloaded installer before it may run. Resolves { ok, status, subject, path, sha256 }:
 * ok only for a Valid Authenticode signature whose signer is Ollama (decided here, whatever the
 * injected `checkSig` says). `sha256` identifies the file that was checked: the hash taken while
 * downloading when the caller passes it, otherwise one taken just before the check. The caller
 * re-checks it with stillSameFile right before starting the file.
 */
async function verifyInstaller(file, { checkSig = checkSignature, sha256 } = {}) {
  const expected = sha256 ?? (await sha256OfFile(file));
  const sig = (await checkSig(file)) ?? {};
  const status = String(sig.status ?? '');
  const subject = String(sig.subject ?? '');
  const ok = sig.ok === true && status === 'Valid' && signedByOllama(subject);
  return { ok, status, subject, path: file, sha256: expected };
}

/** The installer's file name inside its download folder. */
const INSTALLER_NAME = 'OllamaSetup.exe';
/** A folder made by fs.mkdtemp: the prefix, then six random letters and digits. */
function isDownloadFolder(entry, name) {
  return entry === name || (entry.startsWith(`${name}-`) && /^[A-Za-z0-9]{6}$/.test(entry.slice(name.length + 1)));
}
/**
 * Remove earlier downloads: the fixed folder older versions used and the random folders of
 * previous installs. Only real folders (never a link or junction someone put there), and one
 * still in use (its installer still running) is simply left for next time.
 */
function removeOldDownloads(base, name) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !isDownloadFolder(e.name, name)) continue;
    try {
      fs.rmSync(path.join(base, e.name), { recursive: true, force: true });
    } catch {
      /* in use: removed by a later install */
    }
  }
}

/**
 * Install Ollama. Resolves { done: 'installer-started' | 'page-opened' } or throws a plain-words
 * Error. `deps`: { platform, tmpDir, fetchImpl, checkSig, launch, openPage, onProgress, signal }.
 * `launch(file, { sha256 })` starts the checked installer; it may call stillSameFile itself.
 */
async function installOllama(deps) {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    await deps.openPage(OLLAMA_DOWNLOAD_PAGE);
    return { done: 'page-opened' };
  }
  // Each download goes into a new folder with a random name next to `tmpDir` (main.js passes
  // %TEMP%\ironbooks-ollama, the fixed folder older versions used; the new ones are
  // %TEMP%\ironbooks-ollama-XXXXXX). mkdtemp creates the folder itself and never reuses one that
  // exists, so nothing can be planted in it or found there by a predictable name.
  const tmpDir = deps.tmpDir ?? path.join(os.tmpdir(), 'ironbooks-ollama');
  const base = path.dirname(tmpDir);
  const name = path.basename(tmpDir);
  fs.mkdirSync(base, { recursive: true });
  removeOldDownloads(base, name);
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  const file = path.join(dir, INSTALLER_NAME);
  try {
    const { sha256 } = await downloadTo(OLLAMA_WINDOWS_INSTALLER, file, {
      fetchImpl: deps.fetchImpl,
      onProgress: deps.onProgress,
      signal: deps.signal,
      stallMs: deps.stallMs,
    });
    const checked = await verifyInstaller(file, { checkSig: deps.checkSig, sha256 });
    if (!checked.ok) {
      throw new Error(
        `The downloaded installer is not signed by Ollama (${checked.status || 'no signature'}), so Ironbooks did not run it. ` +
          'You can install Ollama yourself from ollama.com/download.',
      );
    }
    // Last look right before it starts: still exactly the bytes that were downloaded and checked.
    if (!(await stillSameFile(checked.path, checked.sha256))) {
      throw new Error(
        'The downloaded installer changed after it was checked, so Ironbooks did not run it. ' +
          'You can install Ollama yourself from ollama.com/download.',
      );
    }
    await deps.launch(checked.path, { sha256: checked.sha256 });
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* removed by the next install */
    }
    throw err;
  }
  return { done: 'installer-started' };
}

module.exports = {
  OLLAMA_DOWNLOAD_PAGE,
  OLLAMA_WINDOWS_INSTALLER,
  allowedUrl,
  downloadTo,
  checkSignature,
  signedByOllama,
  verifyInstaller,
  stillSameFile,
  installOllama,
};
