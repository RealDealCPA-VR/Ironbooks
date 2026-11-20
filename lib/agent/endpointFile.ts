/**
 * How an agent's connector finds the running app without a new port (AGENT_ACCESS.md).
 *
 * The desktop shell starts the app's server on a random 127.0.0.1 port each launch and records it
 * nowhere. The connector (mcp/client.mjs) is a separate program, so it needs to learn that port,
 * and it must not hand its token to whatever else happens to be listening there.
 *
 * So, ONLY while the open company file has an active agent and a person has signed in to it, this
 * server writes one small file in the signed-in Windows user's own local app-data folder:
 *
 *     <local app data>/Ironbooks/agent-endpoints/<file tag>.json   { port, pid, check, tag }
 *
 * `check` is a random secret made for this run of the server. The connector reads the file, asks
 * GET /api/agent/hello?tag=&nonce= and compares the answer with HMAC(check, nonce | port | tag)
 * (the pattern of lib/net/internalToken.ts serverCheckProof). Only the server that wrote the file
 * can answer, so a stale file, or another program on that port, never sees the token.
 *
 * A file with no agents writes nothing and answers 404: the app behaves as it always has.
 *
 * Also kept here, in memory only: which data folders a person has signed in to during this run.
 * An agent works only after that (lib/agentContext.ts), which covers the file password, a file
 * protected with passwords and a plain file with one rule.
 */
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENDPOINT_DIR_ENV = 'IRONBOOKS_AGENT_ENDPOINT_DIR';
export const HELLO_LABEL = 'ironbooks-agent-hello';

interface Published {
  file: string;
  check: string;
  port: number;
}

interface State {
  /** Data folders a person signed in to during this run. */
  signedIn: Set<string>;
  /** Endpoint files this run wrote, by file tag. */
  published: Map<string, Published>;
  /** The port people's own requests arrived on, when the environment does not say. */
  seenPort: number | null;
  cleanup: boolean;
}

// Process-wide, like the open databases (Next.js loads a module once per route bundle in dev).
const g = globalThis as typeof globalThis & { __ironbooksAgentEndpoint?: State };
const state: State = (g.__ironbooksAgentEndpoint ??= { signedIn: new Set(), published: new Map(), seenPort: null, cleanup: false });

/** The folder the endpoint files live in. mcp/client.mjs resolves the same folder. */
export function endpointDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const override = env[ENDPOINT_DIR_ENV];
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ironbooks', 'agent-endpoints');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ironbooks', 'agent-endpoints');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ironbooks', 'agent-endpoints');
}

const TAG_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-f]{32,128}$/;

function portFromHost(host: string | null | undefined): number | null {
  const m = host ? /:(\d{1,5})$/.exec(host.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** The port this server listens on: the shell's PORT, else the one people's requests arrive on. */
export function serverPort(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number(env.PORT);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  return state.seenPort;
}

/**
 * A person's verified sign-in reached this data folder (lib/context.ts). Returns true the first
 * time for a folder, so the caller can publish the endpoint once.
 */
export function notePersonSignedIn(dataDir: string, hostHeader?: string | null): boolean {
  const port = portFromHost(hostHeader);
  if (port) state.seenPort = port;
  if (state.signedIn.has(dataDir)) return false;
  state.signedIn.add(dataDir);
  return true;
}

/** Has a person signed in to this data folder during this run of the app? */
export function personSignedIn(dataDir: string): boolean {
  return state.signedIn.has(dataDir);
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a leftover file fails the proof and is overwritten by the next run */
  }
}

/** Write (or keep) the endpoint file for a company file's tag. False when the port is unknown. */
export function publishEndpoint(tag: string): boolean {
  if (!TAG_RE.test(tag)) return false;
  const port = serverPort();
  if (!port) return false;
  const existing = state.published.get(tag);
  if (existing && existing.port === port && fs.existsSync(existing.file)) return true;
  const dir = endpointDir();
  const file = path.join(dir, `${tag}.json`);
  const check = existing?.check ?? randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'ironbooks-agent-endpoint/v1', tag, port, pid: process.pid, check }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    return false;
  }
  state.published.set(tag, { file, check, port });
  if (!state.cleanup) {
    state.cleanup = true;
    process.once('exit', () => {
      for (const p of state.published.values()) removeFile(p.file);
    });
  }
  return true;
}

/** Remove the endpoint file of a company file's tag (its last agent was removed). */
export function withdrawEndpoint(tag: string): void {
  const p = state.published.get(tag);
  if (!p) return;
  removeFile(p.file);
  state.published.delete(tag);
}

/** Whether this run has published an endpoint for the tag. */
export function endpointPublished(tag: string): boolean {
  return state.published.has(tag);
}

/** What a proof is computed over. mcp/client.mjs builds the same text. */
export function helloMessage(nonce: string, port: number, tag: string): string {
  return `${HELLO_LABEL}\n${nonce}\n${port}\n${tag}`;
}

/**
 * The answer to GET /api/agent/hello, or null when this run published nothing for that tag or the
 * question is malformed. Reveals nothing about `check`, and is useless for any other nonce.
 */
export function helloProof(tag: string | null | undefined, nonce: string | null | undefined): string | null {
  if (typeof tag !== 'string' || typeof nonce !== 'string' || !TAG_RE.test(tag) || !NONCE_RE.test(nonce)) return null;
  const p = state.published.get(tag);
  if (!p) return null;
  return createHmac('sha256', Buffer.from(p.check, 'hex')).update(helloMessage(nonce, p.port, tag)).digest('hex');
}

/** Tests: forget everything this run noted or published (files are removed). */
export function resetAgentEndpointState(): void {
  for (const p of state.published.values()) removeFile(p.file);
  state.published.clear();
  state.signedIn.clear();
  state.seenPort = null;
}
