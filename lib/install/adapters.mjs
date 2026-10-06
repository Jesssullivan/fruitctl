import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const agentManifest = JSON.parse(readFileSync(new URL('../../integrations/agents.json', import.meta.url), 'utf8'));

export function resolveAdapter({ agent, scope = 'user', home, projectDir, env = process.env }) {
  const definition = Object.hasOwn(agentManifest.agents, agent || '') ? agentManifest.agents[agent] : undefined;
  if (!definition) throw new Error(`Unknown agent ${agent}; choose ${Object.keys(agentManifest.agents).join(', ')}`);
  if (!['user', 'project'].includes(scope)) throw new Error('Scope must be user or project');
  let root = scope === 'user' ? home : projectDir;
  let config = path.resolve(root, definition.config[scope]);
  let skill = path.resolve(root, definition.skill[scope]);
  if (scope === 'user' && agent === 'claude' && env.CLAUDE_CONFIG_DIR) skill = path.resolve(env.CLAUDE_CONFIG_DIR, 'skills/fruitctl');
  if (scope === 'user' && agent === 'opencode') {
    config = env.OPENCODE_CONFIG ? path.resolve(env.OPENCODE_CONFIG) : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'opencode.json');
  }
  if (scope === 'user' && agent === 'kimi') config = path.join(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'mcp.json');
  if (scope === 'user' && agent === 'codex' && env.CODEX_HOME) config = path.resolve(env.CODEX_HOME, 'config.toml');
  if (scope === 'user' && agent === 'pi' && env.PI_CODING_AGENT_DIR) config = path.resolve(env.PI_CODING_AGENT_DIR, 'mcp.json');
  if (agent === 'opencode' && !env.OPENCODE_CONFIG && existsSync(config.replace(/\.json$/, '.jsonc'))) {
    if (existsSync(config)) throw new Error('Both OpenCode JSON and JSONC configs exist; set OPENCODE_CONFIG explicitly');
    config = config.replace(/\.json$/, '.jsonc');
  }
  return { ...definition, agent, scope, configPath: config, skillPath: skill };
}

export function serverEntry({ agent, executable, target, existing, configPath }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target || '')) throw new Error('Target must be a configured profile name, not a host or credential');
  const args = ['mcp', '--target', target];
  if (agent === 'opencode') {
    // Honor a user's explicit disabled state on upgrades.
    return { type: 'local', command: [executable, ...args], enabled: typeof existing?.enabled === 'boolean' ? existing.enabled : true, ...(configPath ? { environment: { FRUITCTL_CONFIG_PATH: path.resolve(configPath) } } : {}) };
  }
  const entry = { command: executable, args };
  if (configPath) entry.env = { FRUITCTL_CONFIG_PATH: path.resolve(configPath) };
  if (agent === 'claude' || agent === 'vscode') entry.type = 'stdio';
  // Junie stores mutable connection state in its server entry. Never turn a
  // deliberately disabled server back on while updating owned launch fields.
  if (agent === 'junie') {
    for (const key of ['enabled', 'disabled']) if (typeof existing?.[key] === 'boolean') entry[key] = existing[key];
  }
  return entry;
}

export function renderIntegration({ agent, executable, target, existing, configPath }) {
  const entry = serverEntry({ agent, executable, target, existing, configPath });
  if (agent === 'codex') return `[mcp_servers.fruitctl]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n${configPath ? `env = { FRUITCTL_CONFIG_PATH = ${JSON.stringify(path.resolve(configPath))} }\n` : ''}`;
  const container = agentManifest.agents[agent]?.config.container;
  if (!container) throw new Error(`Unknown agent ${agent}`);
  let result = { fruitctl: entry };
  for (const key of [...container].reverse()) result = { [key]: result };
  return JSON.stringify(result, null, 2) + '\n';
}
