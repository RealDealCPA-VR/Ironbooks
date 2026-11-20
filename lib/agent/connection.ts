/**
 * What a connector needs to start on THIS computer (AGENT_ACCESS.md): the command that runs the
 * MCP server shipped with the app (mcp/ironbooks-mcp.mjs). Shown to an Admin at the computer that
 * holds the company file, never to another computer (it is a path on this one), and it holds no
 * secret: the token is added by the person, once, when the agent is made.
 *
 *  - Installed app: the app's own program runs the script as Node (ELECTRON_RUN_AS_NODE=1, the way
 *    the desktop shell starts this server), so nothing else has to be installed.
 *  - Source checkout (`npm run dev`): `node mcp/ironbooks-mcp.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_TOKEN_ENV = 'IRONBOOKS_AGENT_TOKEN';
/** Lets the connector start Ironbooks when it is closed (mcp/client.mjs START_ENV). */
export const AGENT_START_ENV = 'IRONBOOKS_AGENT_START';
export const MCP_SCRIPT = 'ironbooks-mcp.mjs';

export interface AgentConnection {
  command: string;
  args: string[];
  /** Environment the command needs besides the token. */
  env: Record<string, string>;
  /** The name of the environment variable the token goes in. */
  tokenEnv: string;
  /** True when the command is the installed app's own program. */
  installed: boolean;
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The settings for an agent an Admin allowed to work while nobody is signed in: the same command,
 * plus the switch that lets the connector start Ironbooks when it is closed. Only the installed
 * app can be started that way; a source checkout's settings are left as they are.
 */
export function forUnattended(c: AgentConnection | null): AgentConnection | null {
  if (!c || !c.installed) return c;
  return { ...c, env: { ...c.env, [AGENT_START_ENV]: '1' } };
}

export function agentConnection(
  opts: { execPath?: string; serverScript?: string | undefined; cwd?: string; fileExists?: (p: string) => boolean } = {},
): AgentConnection | null {
  const execPath = opts.execPath ?? process.execPath;
  const serverScript = 'serverScript' in opts ? opts.serverScript : process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const has = opts.fileExists ?? exists;
  // Installed: <resources>/app/server.js runs this server; the connector is <resources>/mcp/.
  if (serverScript) {
    const shipped = path.join(path.dirname(path.dirname(path.resolve(serverScript))), 'mcp', MCP_SCRIPT);
    if (has(shipped)) {
      return { command: execPath, args: [shipped], env: { ELECTRON_RUN_AS_NODE: '1' }, tokenEnv: AGENT_TOKEN_ENV, installed: true };
    }
  }
  const local = path.join(cwd, 'mcp', MCP_SCRIPT);
  if (has(local)) return { command: 'node', args: [local], env: {}, tokenEnv: AGENT_TOKEN_ENV, installed: false };
  return null;
}
