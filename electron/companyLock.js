// "Someone is in this company file": the lock next to a single-file company file on a shared drive.
//
// QuickBooks keeps a .ND / .LCK file next to the .QBW so a second workstation knows the file is
// open and by whom. Ironbooks does the same with a small folder next to the company file:
//
//   ABC Company.ironbooks
//   ABC Company.ironbooks.lock/        (hidden on Windows; only there while the file is open)
//     owner.json                       who has it open, on which computer, since when, a heartbeat,
//                                      unsaved-changes flag and (in multi-user mode) where to join
//     requests/<id>.json               another workstation asking to come in
//     responses/<id>.json              the answer: let them in (multi-user), hand it over, or not now
//
// Creating the folder is the lock: mkdir is atomic on local disks and on Windows / Samba / NAS
// shares, so of two computers opening the file at the same moment exactly one gets it. The
// holder rewrites owner.json every HEARTBEAT_MS; its modification time — stamped by the file
// server, so clocks on different computers don't matter — tells everyone else whether the holder
// is still there. A lock whose holder stopped (crash, power cut, a laptop that slept) is reported
// as stale; the person opening the file decides whether to take it over (electron/main.js).
//
// Pure Node so it can be unit-tested (test/companyLock.test.ts).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const LOCK_SUFFIX = '.lock';
const OWNER_FILE = 'owner.json';
const LOCK_SCHEMA = 'ironbooks-lock/v1';
const HEARTBEAT_MS = 10_000;
/** No heartbeat for this long: the holder is gone (or asleep / off the network). */
const STALE_MS = 2 * 60_000;
/** Access requests nobody answered within this long are dropped. */
const REQUEST_TTL_MS = 5 * 60_000;

function lockDirFor(companyFile) {
  return `${companyFile}${LOCK_SUFFIX}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  // Write-then-rename so a reader never sees half a file (rename within one folder is atomic).
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** "Now" as the file server sees it: the mtime of a probe file written in `dir`. */
function folderNow(dir) {
  const probe = path.join(dir, `.clock-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    fs.writeFileSync(probe, '');
    return fs.statSync(probe).mtimeMs;
  } catch {
    return Date.now();
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** Hide the lock folder in Explorer, like QuickBooks' .ND files are easy to overlook. Best effort. */
function hideOnWindows(dir) {
  if (process.platform !== 'win32') return;
  try {
    execFile('attrib', ['+h', dir], { windowsHide: true }, () => {});
  } catch {
    /* not important */
  }
}

/** This workstation, as other people will see it named. */
function whoAmI(extra = {}) {
  let osUser = '';
  try {
    osUser = os.userInfo().username;
  } catch {
    /* no user info (rare) */
  }
  return { computer: os.hostname(), osUser, pid: process.pid, ...extra };
}

/**
 * The current holder of a company file: { owner, ageMs, stale, sameComputer } or null when the
 * file is not open anywhere. `owner` is owner.json (null while it is being written / unreadable,
 * then the folder's own age decides).
 */
function readHolder(companyFile) {
  const dir = lockDirFor(companyFile);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const ownerPath = path.join(dir, OWNER_FILE);
  const owner = readJson(ownerPath);
  let mtimeMs = st.mtimeMs;
  try {
    mtimeMs = fs.statSync(ownerPath).mtimeMs;
  } catch {
    /* no owner file yet: judge by the folder */
  }
  const ageMs = Math.max(0, folderNow(dir) - mtimeMs);
  const sameComputer = Boolean(owner && owner.computer === os.hostname());
  let stale = ageMs > STALE_MS;
  // On this computer we can do better than waiting: a holder process that no longer runs is gone.
  if (owner && sameComputer && !pidAlive(owner.pid)) stale = true;
  // A folder left without an owner file for a while (a crash between mkdir and the first write).
  if (!owner && ageMs > HEARTBEAT_MS * 3) stale = true;
  return { owner, ageMs, stale, sameComputer };
}

/**
 * Try to lock the company file for this workstation.
 * Returns { ok: true, lock } or { ok: false, holder } (holder = readHolder()).
 * `info` is merged into owner.json (appVersion, …).
 */
function acquire(companyFile, info = {}) {
  const dir = lockDirFor(companyFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const holder = readHolder(companyFile);
        if (!holder) continue; // released meanwhile
        return { ok: false, holder };
      }
      if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
        // Read-only location (a CD, a share without write access): the file can only be read.
        const e = new Error(
          `Ironbooks can't write in ${path.dirname(companyFile)}, so it can't open this company file for changes. Copy the file to a folder you can write to, or ask your network administrator for write access.`,
        );
        e.code = 'READ_ONLY_LOCATION';
        throw e;
      }
      throw err;
    }
    const now = new Date().toISOString();
    const owner = {
      schema: LOCK_SCHEMA,
      token: crypto.randomBytes(16).toString('hex'),
      ...whoAmI(),
      appUser: null,
      openedAt: now,
      heartbeatAt: now,
      mode: 'single',
      host: null,
      joinPolicy: 'ask',
      unsavedSince: null,
      lastSavedAt: null,
      ...info,
    };
    try {
      fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'responses'), { recursive: true });
      writeJson(path.join(dir, OWNER_FILE), owner);
    } catch (err) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
    hideOnWindows(dir);
    return { ok: true, lock: { companyFile, dir, token: owner.token, owner } };
  }
  return { ok: false, holder: readHolder(companyFile) };
}

/**
 * Take over a stale lock (the person opening the file agreed). Only removes the lock when it is
 * still the one that was judged stale (same token), so a holder that came back meanwhile keeps it.
 */
function takeOver(companyFile, staleHolder, info = {}) {
  const dir = lockDirFor(companyFile);
  const current = readHolder(companyFile);
  if (current) {
    const sameLock = (current.owner && current.owner.token) === (staleHolder && staleHolder.owner && staleHolder.owner.token);
    if (!sameLock || !current.stale) return { ok: false, holder: current };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return acquire(companyFile, info);
}

/** Still ours? { held: true } or { held: false, holder } when someone else has it now. */
function checkHeld(lock) {
  const owner = readJson(path.join(lock.dir, OWNER_FILE));
  if (owner && owner.token === lock.token) return { held: true, owner };
  return { held: false, holder: readHolder(lock.companyFile) };
}

/**
 * Heartbeat: refresh owner.json (merging `patch`). If the lock folder vanished (someone deleted
 * it, the share came back empty) it is recreated; if another workstation holds it now, returns
 * { lost: true, holder } and leaves it alone.
 */
function heartbeat(lock, patch = {}) {
  const ownerPath = path.join(lock.dir, OWNER_FILE);
  const owner = readJson(ownerPath);
  if (owner && owner.token !== lock.token) return { lost: true, holder: readHolder(lock.companyFile) };
  if (!owner && fs.existsSync(lock.dir) && fs.existsSync(ownerPath)) {
    // owner.json exists but is unreadable for a moment (being replaced): try next beat.
    return { lost: false };
  }
  if (!owner && !fs.existsSync(lock.dir)) {
    try {
      fs.mkdirSync(lock.dir);
      fs.mkdirSync(path.join(lock.dir, 'requests'), { recursive: true });
      fs.mkdirSync(path.join(lock.dir, 'responses'), { recursive: true });
      hideOnWindows(lock.dir);
    } catch (err) {
      if (err && err.code === 'EEXIST') return { lost: true, holder: readHolder(lock.companyFile) };
      return { lost: false, error: err }; // share unreachable: try again next beat
    }
  }
  const next = { ...(lock.owner || {}), ...(owner || {}), ...patch, token: lock.token, heartbeatAt: new Date().toISOString() };
  try {
    writeJson(ownerPath, next);
    lock.owner = next;
  } catch (err) {
    return { lost: false, error: err };
  }
  return { lost: false, owner: next };
}

/** Release the lock (only our own). */
function release(lock) {
  if (!lock) return;
  const owner = readJson(path.join(lock.dir, OWNER_FILE));
  if (owner && owner.token !== lock.token) return;
  try {
    fs.rmSync(lock.dir, { recursive: true, force: true });
  } catch {
    /* share gone: the heartbeat stops, so others see it as stale */
  }
}

// ---------------------------------------------------------------------------
// Access requests ("Mary has ABC Company open — ask Mary to let you in")
// ---------------------------------------------------------------------------

/** Ask the holder for access. Returns the request id. */
function requestAccess(companyFile, requester = {}) {
  const dir = lockDirFor(companyFile);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const req = { id, ...whoAmI(), ...requester, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  writeJson(path.join(dir, 'requests', `${id}.json`), req);
  return id;
}

/** Withdraw a request (the person stopped waiting). */
function cancelRequest(companyFile, id) {
  const dir = lockDirFor(companyFile);
  for (const sub of ['requests', 'responses']) {
    try {
      fs.rmSync(path.join(dir, sub, `${safeId(id)}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }
}

function safeId(id) {
  return String(id).replace(/[^a-z0-9-]/gi, '').slice(0, 64);
}

/** The holder's answer to request `id`, or null while there is none. */
function readResponse(companyFile, id) {
  return readJson(path.join(lockDirFor(companyFile), 'responses', `${safeId(id)}.json`));
}

/** Open requests for the holder, oldest first (expired ones are cleared away). */
function pendingRequests(lock) {
  const reqDir = path.join(lock.dir, 'requests');
  let names = [];
  try {
    names = fs.readdirSync(reqDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const now = folderNow(lock.dir);
  const out = [];
  for (const n of names) {
    const file = path.join(reqDir, n);
    const req = readJson(file);
    let mtime = now;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!req || now - mtime > REQUEST_TTL_MS) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    out.push(req);
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Answer a request: { decision: 'multi' | 'handoff' | 'deny', host?, message? }.
 * The request file is removed so it is answered once.
 */
function respond(lock, id, response) {
  const sid = safeId(id);
  writeJson(path.join(lock.dir, 'responses', `${sid}.json`), {
    id: sid,
    ...response,
    by: { computer: os.hostname(), appUser: (lock.owner && lock.owner.appUser) || null },
    at: new Date().toISOString(),
  });
  try {
    fs.rmSync(path.join(lock.dir, 'requests', `${sid}.json`), { force: true });
  } catch {
    /* ignore */
  }
}

/** "Mary on FRONT-DESK" / "FRONT-DESK" for messages. */
function describeOwner(owner) {
  if (!owner) return 'another computer';
  const who = owner.appUser || owner.osUser;
  return who ? `${who} on ${owner.computer || 'another computer'}` : owner.computer || 'another computer';
}

module.exports = {
  LOCK_SUFFIX,
  OWNER_FILE,
  HEARTBEAT_MS,
  STALE_MS,
  REQUEST_TTL_MS,
  lockDirFor,
  readHolder,
  acquire,
  takeOver,
  checkHeld,
  heartbeat,
  release,
  requestAccess,
  cancelRequest,
  readResponse,
  pendingRequests,
  respond,
  describeOwner,
  whoAmI,
};
