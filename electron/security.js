// Electron hardening for Ironbooks (local-only data guarantee).
//
//  - Renderer windows can only load the app's own origin (the local server, or the multi-user
//    host the user explicitly connected to). Navigation to any other origin is blocked and logged
//    (never opened elsewhere: a script could otherwise send data out in the address). A link the
//    person clicks that opens a new window (target="_blank", window.open) opens in the system
//    browser instead, if it is a plain https link.
//  - Every network request in the window's session is filtered: same-origin and internal schemes
//    (data:, blob:, devtools:, the built-in PDF viewer) only. Everything else is cancelled and
//    logged — no CDNs, web fonts, analytics, telemetry or third-party bank widgets. Requests with
//    no window behind them (a service worker) get the same filter; only the update feed's hosts
//    are let through for them, read-only.
//  - Downloads never write a program, script, shortcut or other file that runs or carries code
//    (electron/saveTypes.js), checked on the name the file finally gets.
//  - No <webview>, no permission prompts (camera, mic, geolocation, notifications…), and the
//    spellchecker never downloads dictionaries: Windows/macOS use the OS checker, elsewhere the
//    download URL points at localhost (electron/spelling.js).
//
// The page itself also ships a strict Content-Security-Policy (next.config.js headers()).
// The decisions are pure functions below (exported for tests); install() wires them to Electron.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, session, shell, dialog, BrowserWindow } = require('electron');
const { configureSpellChecker } = require('./spelling');
const { downloadAllowed } = require('./saveTypes');

const INTERNAL_PROTOCOLS = new Set(['data:', 'blob:', 'devtools:', 'chrome-extension:', 'chrome:', 'about:']);
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/**
 * The release feed (package.json build.publish: GitHub) and the hosts its downloads redirect to.
 * electron-updater makes its requests in a session of its own ("electron-updater"), and the
 * Ollama download and the multi-user host probe use Node's fetch, so today nothing the main
 * process does goes through the window's session; these are let through (GET only) for requests
 * with no window behind them in case that changes, and never for a page.
 */
const UPDATE_FEED_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The origin of `o` ("http://localhost:51234"), or null. */
function originOf(o) {
  const u = o ? parse(o) : null;
  return u ? u.origin : null;
}

/** Same origin as the app (the local server, or the connected multi-user host). */
function isAppUrlFor(url, appOrigin) {
  const u = parse(url);
  const origin = originOf(appOrigin);
  return Boolean(u && origin && u.origin === origin);
}

/** May a page in the app's windows request `url`? */
function requestAllowedFor(url, appOrigin, isDev) {
  const u = parse(url);
  if (!u) return false;
  if (INTERNAL_PROTOCOLS.has(u.protocol)) return true;
  const origin = originOf(appOrigin);
  if (origin && u.origin === origin) return true;
  if (origin) {
    // Same host:port over ws(s) — `next dev` hot reload only.
    const o = new URL(origin);
    if (isDev && (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === o.host) return true;
  }
  return false;
}

/** A read from the update feed: https, one of its hosts, GET/HEAD. */
function isUpdateFeedRequest(url, method) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return false;
  if (!UPDATE_FEED_HOSTS.has(u.hostname.toLowerCase())) return false;
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * One request in the window's session ({ url, webContentsId, method } from webRequest). With no
 * webContents it came from a service worker (or the main process): the page filter, plus the
 * update feed.
 */
function sessionRequestAllowed(details, appOrigin, isDev) {
  const url = details && details.url;
  if (requestAllowedFor(url, appOrigin, isDev)) return true;
  if (details && details.webContentsId === undefined) return isUpdateFeedRequest(url, details.method);
  return false;
}

/** May a window navigate (or be redirected) to `url`? Anything else is blocked, not opened. */
function navigationAllowed(url, appOrigin) {
  if (isAppUrlFor(url, appOrigin)) return true;
  const u = parse(url);
  return Boolean(u && INTERNAL_PROTOCOLS.has(u.protocol));
}

/**
 * A new window (target="_blank", window.open): 'allow' for the app's own pop-ups (PDF preview,
 * printable forms), 'external' for a plain https link (the person's own browser), else 'deny'.
 */
function windowOpenAction(url, appOrigin) {
  if (isAppUrlFor(url, appOrigin)) return 'allow';
  const u = parse(url);
  return u && u.protocol === 'https:' ? 'external' : 'deny';
}

/**
 * @param {object} opts
 * @param {() => string|null} opts.getAppOrigin   origin the windows may load
 * @param {boolean} opts.isDev
 * @param {(msg: string) => void} [opts.log]
 */
function install(opts) {
  const log = opts.log || ((m) => console.warn(m));

  const appOrigin = () => {
    try {
      return originOf(opts.getAppOrigin());
    } catch {
      return null;
    }
  };

  const isAppUrl = (url) => isAppUrlFor(url, appOrigin());
  const requestAllowed = (url) => requestAllowedFor(url, appOrigin(), opts.isDev);

  function openExternally(url) {
    const u = parse(url);
    // Only plain https links (e.g. "Upload at fire.irs.gov") — the user's own browser, not ours.
    if (u && u.protocol === 'https:') shell.openExternal(u.toString()).catch(() => {});
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const action = windowOpenAction(url, appOrigin());
      if (action === 'allow') {
        // Same-origin pop-ups (PDF preview, printable forms): allowed, without the preload bridge.
        // They share the window's session, so its cookies (sign-in, launch pass) go along.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
          },
        };
      }
      // A link the person opened in a new window: their own browser (https only).
      if (action === 'external') openExternally(url);
      return { action: 'deny' };
    });

    // A navigation away from the app is only blocked: a script that set location.href (or a
    // redirect) is not a click, and opening its address elsewhere could carry data out in it.
    const guard = (event, url) => {
      if (navigationAllowed(url, appOrigin())) return;
      event.preventDefault();
      const u = parse(url);
      log(`[security] blocked navigation to ${u ? u.origin : 'invalid URL'}`);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Local-only spell check (on by default; My Preferences > Spelling can turn it off).
  configureSpellChecker(ses, process.platform, true);
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (sessionRequestAllowed(details, appOrigin(), opts.isDev)) return callback({});
    const u = parse(details.url);
    const from = details.webContentsId === undefined ? 'background' : 'renderer';
    log(`[security] blocked ${from} request to ${u ? u.origin : 'invalid URL'} (local-only policy)`);
    callback({ cancel: true });
  });

  // Downloads (exports, backups, attachments, a page's own blob files): anything but a file that
  // runs or carries code. The name is checked when the download starts and again on the path
  // chosen in the Save dialog, where a different name can be typed.
  let refusalShowing = false;
  const tellRefused = (contents, name) => {
    if (refusalShowing) return;
    refusalShowing = true;
    let win;
    try {
      win = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
    } catch {
      win = null;
    }
    const shown = String(name || 'This file').slice(0, 120);
    const box = {
      type: 'warning',
      noLink: true,
      message: `Ironbooks did not save ${shown}`,
      detail:
        'It is a program, script, shortcut or another kind of file that can run on this computer, and ' +
        'Ironbooks does not save those. Documents, pictures, spreadsheets and its own files save as usual.',
      buttons: ['OK'],
    };
    Promise.resolve(win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
      .catch(() => {})
      .finally(() => {
        refusalShowing = false;
      });
  };
  ses.on?.('will-download', (event, item, contents) => {
    const name = item.getFilename();
    if (!downloadAllowed(name)) {
      event.preventDefault();
      log('[security] refused a download: a kind of file that runs or carries code');
      tellRefused(contents, name);
      return;
    }
    // Checked again on the path chosen in the Save dialog: cancelled while it downloads, removed
    // if it finished first.
    let refused = false;
    const chosenRefused = () => {
      const chosen = item.getSavePath();
      if (!chosen || downloadAllowed(chosen)) return false;
      if (!refused) {
        refused = true;
        log('[security] refused a download saved as a kind of file that runs or carries code');
        tellRefused(contents, path.basename(chosen));
      }
      return true;
    };
    item.on('updated', () => {
      if (chosenRefused()) item.cancel();
    });
    item.once('done', (_e, state) => {
      if (state !== 'completed' || !chosenRefused()) return;
      try {
        fs.rmSync(item.getSavePath(), { force: true });
      } catch {
        /* already gone */
      }
    });
  });

  return { requestAllowed, isAppUrl };
}

module.exports = {
  install,
  UPDATE_FEED_HOSTS,
  isAppUrlFor,
  requestAllowedFor,
  isUpdateFeedRequest,
  sessionRequestAllowed,
  navigationAllowed,
  windowOpenAction,
};
