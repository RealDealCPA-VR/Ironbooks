// Spell check for memos and descriptions (QB Preferences > Spelling), kept local-only.
//
//  - Windows and macOS use the operating system's own spell checker: no dictionary downloads.
//  - Elsewhere Chromium would download Hunspell dictionaries from Google; we point the download
//    URL at an unreachable localhost address so nothing leaves the machine (spell check is then
//    simply unavailable unless dictionaries are installed locally).
//  - Right-clicking a misspelled word offers suggestions and "Add to Dictionary".
//  - My Preferences > Spelling turns it on/off per user (IPC 'spellcheck:setEnabled').
//
// Pure helpers take the session / params as arguments so they can be unit-tested.

'use strict';

/** Where non-native platforms would fetch dictionaries from: nowhere (localhost discard port). */
const NO_DOWNLOAD_URL = 'http://127.0.0.1:9/';

/**
 * Configure a session's spell checker for local-only use.
 * @param {{ setSpellCheckerEnabled?: Function, setSpellCheckerDictionaryDownloadURL?: Function }} ses
 * @param {string} platform process.platform
 * @param {boolean} enabled
 */
function configureSpellChecker(ses, platform, enabled = true) {
  const nativeChecker = platform === 'win32' || platform === 'darwin';
  try {
    if (!nativeChecker && typeof ses.setSpellCheckerDictionaryDownloadURL === 'function') {
      ses.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD_URL);
    }
    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(Boolean(enabled));
  } catch {
    /* older Electron: spell checking stays at its default (off) */
  }
  return { nativeChecker };
}

/**
 * Context-menu template for a right-click (Electron 'context-menu' params).
 * @param {{ misspelledWord?: string, dictionarySuggestions?: string[], isEditable?: boolean,
 *           selectionText?: string, editFlags?: Record<string, boolean> }} params
 * @param {{ replace: (word: string) => void, addToDictionary: (word: string) => void }} actions
 */
function contextMenuTemplate(params, actions) {
  const items = [];
  if (params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 6);
    if (suggestions.length === 0) items.push({ label: 'No spelling suggestions', enabled: false });
    for (const s of suggestions) items.push({ label: s, click: () => actions.replace(s) });
    items.push({ type: 'separator' });
    items.push({ label: 'Add to Dictionary', click: () => actions.addToDictionary(params.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' });
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  } else if (params.selectionText) {
    items.push({ role: 'copy' });
  }
  return items;
}

/**
 * Attach the spelling-aware context menu to a window's webContents.
 * @param {import('electron').BrowserWindow} win
 * @param {typeof import('electron').Menu} Menu
 */
function attachContextMenu(win, Menu) {
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      replace: (word) => win.webContents.replaceMisspelling(word),
      addToDictionary: (word) => win.webContents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

module.exports = { configureSpellChecker, contextMenuTemplate, attachContextMenu, NO_DOWNLOAD_URL };
