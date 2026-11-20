#!/usr/bin/env node
/**
 * The Ironbooks connector for AI agents: a Model Context Protocol server over stdio.
 *
 * A client such as Claude Code or Claude Desktop starts this script and talks to it on its
 * standard input and output. The script reads the books through the Ironbooks app running on this
 * computer, with the access token an Ironbooks Admin made for the agent (AGENT_ACCESS.md). It
 * opens no port and reaches nothing but 127.0.0.1. What the agent may do (read, propose, enter)
 * is decided by Ironbooks, not here.
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
import { INSTRUCTIONS, TOOLS } from './tools.mjs';

export const SERVER_INFO = { name: 'ironbooks', version: '1.0.0' };

export function main(io = { input: process.stdin, output: process.stdout }) {
  const client = new IronbooksClient();
  const server = createServer({ tools: TOOLS, client, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  return serve(server, io).finally(() => client.close());
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
