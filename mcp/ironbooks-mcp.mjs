#!/usr/bin/env node
/**
 * The Ironbooks connector for AI agents: a Model Context Protocol server over stdio.
 *
 * A client such as Claude Code or Claude Desktop starts this script and talks to it on its
 * standard input and output. The script reads the books through the Ironbooks app running on this
 * computer, with the access token an Ironbooks Admin made for the agent (AGENT_ACCESS.md). It
 * opens no port and reaches nothing but 127.0.0.1. What the agent may do (run on its own, ask a
 * person, or not at all) is decided by Ironbooks, by the agent's role and policy, not here.
 *
 * Its tools (mcp/tools.mjs TOOLS): the named reads and changes, every standard report by its key,
 * and the generic door to every other operation. Besides them it serves the guide for the agent
 * (resource ironbooks://guide, prompt ironbooks_guide), the agent's requests and staged files as
 * resources, and a notice when a request it waited for is decided.
 *
 * Run it with Node 18 or newer:        node mcp/ironbooks-mcp.mjs
 * or with the installed app's program: Ironbooks.exe <resources>\mcp\ironbooks-mcp.mjs
 *                                      (with ELECTRON_RUN_AS_NODE=1)
 *
 * The token comes from IRONBOOKS_AGENT_TOKEN, or from the file named in
 * IRONBOOKS_AGENT_TOKEN_FILE. It is never printed.
 */
import path from 'node:path';
import { IronbooksClient } from './client.mjs';
import { createServer, serve } from './protocol.mjs';
import { INSTRUCTIONS, PROMPTS, RESOURCES, TOOLS } from './tools.mjs';

/**
 * 1.2.0: the entry tools (estimates, purchase orders, receiving, credits, time, inventory, sales tax) and every report by key.
 * 1.3.0: every tool that changes the books takes a reason for the approval card; edits, voids and
 * making inactive send the version last read; an approved report read comes back as run_report gives it.
 */
export const SERVER_INFO = { name: 'ironbooks', version: '1.3.0' };

/** The server as shipped: the tools, the guide (resource and prompt), the agent's requests and files. */
export function createIronbooksServer(client) {
  return createServer({ tools: TOOLS, client, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS, resources: RESOURCES, prompts: PROMPTS });
}

export function main(io = { input: process.stdin, output: process.stdout }) {
  const client = new IronbooksClient();
  return serve(createIronbooksServer(client), io).finally(() => client.close());
}

// Started as a program (not imported by a test): the script named on the command line is this one.
const startedDirectly = path.basename(process.argv[1] ?? '') === 'ironbooks-mcp.mjs';

if (startedDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[ironbooks-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
