// Agent service: Ironbooks started for an agent while nobody has the app open (AGENT_ACCESS.md).
//
// An agent an Admin allowed to work unattended may need the books while Ironbooks is closed. Its
// connector then starts the app with `--agent-service`. The app starts exactly as it always does
// (the same company file lock, the same working copy, the same server on 127.0.0.1) with ONE
// difference: its window is not shown. From there:
//
//   - A person who starts Ironbooks gets that same running app: the window appears and they sign
//     in as usual. Nothing is taken over and nothing is opened twice.
//   - Another computer that asks for the company file gets it at once: the hidden app saves,
//     closes the file and quits, as "Hand It Over" does.
//   - When no agent has worked for a while, it saves, closes the file and quits.
//   - It never asks a question. Anything a normal start would ask a person about (a file that
//     moved, a file in use elsewhere, unsaved work to sort out) makes it close again instead.
//   - It never opens a file protected with passwords: only a person's sign-in does that. The
//     server answers "no" (app/api/agent/service) and the app closes again.
//
// Without the flag nothing here is used: a normal start is unchanged.
//
// Pure helpers only (no Electron imports), so they can be tested directly. electron/main.js wires
// them in.

const FLAG = '--agent-service';
/** How long with no agent request before the hidden app closes the file and quits. */
const IDLE_MS = 10 * 60 * 1000;
/** How often the hidden app asks its server when an agent last worked. */
const POLL_MS = 60 * 1000;
/** Who the company file lock says has the file, while no person does. */
const LOCK_USER = 'an agent (no one is signed in)';

/** True when this launch (or a second launch's argv) asked for the agent service. */
function isAgentServiceLaunch(argv) {
  return Array.isArray(argv) && argv.some((a) => a === FLAG);
}

/** A command line without the flag: a relaunch is always a normal, visible start. */
function withoutFlag(args) {
  return (Array.isArray(args) ? args : []).filter((a) => a !== FLAG);
}

/**
 * Why a start with no window cannot go ahead, or null when it can. Only a company file that
 * would open by itself, on this computer, qualifies; everything else needs a person at the screen.
 * @param {object} cfg  the shell's config.json
 * @param {{ firstRun?: boolean, dataDirEnv?: boolean, fileArgument?: boolean }} [facts]
 */
function headlessBlocker(cfg, facts = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (facts.fileArgument) return 'a file was named on the command line';
  if (facts.dataDirEnv) return 'a data folder was set by hand';
  if (facts.firstRun) return 'Ironbooks has not been set up on this computer';
  if (c.companyClosed === true) return 'no company file is open (the last one was closed)';
  if (typeof c.remoteHost === 'string' && c.remoteHost) return 'this computer works in a company file hosted on another computer';
  if (c.sandbox) return 'a practice copy is open';
  if (typeof c.companyFile !== 'string' || !c.companyFile) return 'there is no company file to open';
  return null;
}

/** An options object as a caller writes one (`{ … }`): never a window, which is an object of a class. */
function plainObject(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const proto = Object.getPrototypeOf(a);
  return proto === Object.prototype || proto === null;
}

/**
 * The options of a dialog call, read as Electron reads its arguments: a plain object first is the
 * options; otherwise the first argument is the window (or null / undefined, for none) and the
 * options come second. Never picked by what an object holds (electron/agentShell.js dialogOptions).
 */
function dialogOptionsOf(args) {
  const list = Array.isArray(args) ? args : [];
  if (plainObject(list[0])) return list[0];
  return list[1] && typeof list[1] === 'object' && !Array.isArray(list[1]) ? list[1] : {};
}

/**
 * The answer a question gets while no window shows: the choice that changes nothing (its cancel
 * button; the first button when it has none, which for a plain notice is OK).
 * @param {unknown[]} args  the arguments of dialog.showMessageBox (window?, options)
 */
function quietDialogAnswer(args) {
  const options = dialogOptionsOf(args);
  return { response: Number.isInteger(options.cancelId) ? options.cancelId : 0, checkboxChecked: false };
}

/**
 * Has the hidden app been idle long enough to close? Idle is counted from the later of its start
 * and the last agent request.
 * @param {{ now: number, since: number, lastAgentUse?: string | number | Date | null, idleMs?: number }} t
 */
function idleTooLong({ now, since, lastAgentUse, idleMs = IDLE_MS }) {
  const used = lastAgentUse ? new Date(lastAgentUse).getTime() : NaN;
  const last = Number.isFinite(used) ? Math.max(used, since) : since;
  return now - last >= idleMs;
}

module.exports = { FLAG, IDLE_MS, POLL_MS, LOCK_USER, isAgentServiceLaunch, withoutFlag, headlessBlocker, quietDialogAnswer, idleTooLong };
