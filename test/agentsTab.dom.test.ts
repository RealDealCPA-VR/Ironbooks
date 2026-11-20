/**
 * Agent access: Users & Roles > Agents on screen (app/users/AgentsTab.tsx), and the settings it
 * hands the Admin to paste into Claude Code or Claude Desktop.
 */
import { describe, expect, it } from 'vitest';
import { agentConnection } from '@/lib/agent/connection';
import { claudeCodeCommand, claudeDesktopConfig } from '@/app/users/AgentsTab';
import { TOKEN_ENV } from '../mcp/client.mjs';
import { expectAllPassed, runDomFile } from './domHarness';

const TOKEN = `ibka_0123abcd_${'T'.repeat(43)}`;

describe('the Agents tab', () => {
  it('lists agents without tokens, makes one and shows its token once, removes after asking, and only lists on another computer', async () => {
    expectAllPassed(await runDomFile('test/dom/agentsTab.dom.tsx'), [
      'the list shows each agent, its role and last use, and never a token',
      'New agent: name, role (never Admin) and mode are sent, and the token is shown once',
      'a refusal from the server is said in its own words, and the dialog stays',
      'Remove asks first, then takes the access away',
      'on another computer the tab only lists',
    ]);
  }, 180_000);
});

describe('where the connector is on this computer', () => {
  const none = () => false;

  it('the installed app runs the connector with its own program', () => {
    const shipped = 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs';
    const c = agentConnection({
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\Ironbooks.exe',
      serverScript: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\resources\\app\\server.js',
      cwd: 'C:\\somewhere\\else',
      fileExists: (p) => p === shipped,
    });
    expect(c).toEqual({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\Ironbooks.exe',
      args: [shipped],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      tokenEnv: 'IRONBOOKS_AGENT_TOKEN',
      installed: true,
    });
  });

  it('a source checkout runs it with node', () => {
    const local = 'C:\\src\\ironbooks\\mcp\\ironbooks-mcp.mjs';
    const c = agentConnection({ execPath: 'C:\\node\\node.exe', serverScript: 'C:\\src\\ironbooks\\node_modules\\next\\dist\\bin\\next', cwd: 'C:\\src\\ironbooks', fileExists: (p) => p === local });
    expect(c).toEqual({ command: 'node', args: [local], env: {}, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: false });
    expect(agentConnection({ execPath: 'x', serverScript: undefined, cwd: 'C:\\nowhere', fileExists: none })).toBeNull();
  });

  it('names the same token variable the connector reads, and ships the script it points at', () => {
    expect(agentConnection({ cwd: process.cwd(), serverScript: undefined })).toMatchObject({ command: 'node', tokenEnv: TOKEN_ENV, installed: false });
    const pkg = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));
    expect(pkg.build.extraResources).toContainEqual({ from: 'mcp', to: 'mcp', filter: ['*.mjs'] });
    // Nothing was added to what the app depends on.
    expect(Object.keys(pkg.dependencies).some((d) => /modelcontextprotocol/i.test(d))).toBe(false);
  });
});

describe('the settings to paste', () => {
  const installed = { command: 'C:\\Program Files\\Ironbooks\\Ironbooks.exe', args: ['C:\\Program Files\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: true };

  it('Claude Code: one command, paths with spaces quoted', () => {
    expect(claudeCodeCommand(installed, TOKEN)).toBe(
      `claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=${TOKEN} --env ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Ironbooks\\Ironbooks.exe" "C:\\Program Files\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs"`,
    );
    expect(claudeCodeCommand({ command: 'node', args: ['/src/mcp/ironbooks-mcp.mjs'], env: {}, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: false }, TOKEN)).toBe(
      `claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=${TOKEN} -- node /src/mcp/ironbooks-mcp.mjs`,
    );
  });

  it('Claude Desktop: a valid configuration entry', () => {
    expect(JSON.parse(claudeDesktopConfig(installed, TOKEN))).toEqual({
      mcpServers: { ironbooks: { command: installed.command, args: installed.args, env: { IRONBOOKS_AGENT_TOKEN: TOKEN, ELECTRON_RUN_AS_NODE: '1' } } },
    });
  });
});
