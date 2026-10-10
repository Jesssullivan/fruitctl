#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { defaultConfigPath, defaultSocketPath, loadConfig } from '../lib/broker/paths.mjs';

let values, positionals, command, socketPath, configPath;

async function packageVersion() {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return metadata.version;
}

function lifecycle(service) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await service.close(); } catch {
      process.stderr.write('Fruitctl: owned session cleanup unconfirmed; reconcile the target before restarting\n');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

try {
  ({ values, positionals } = parseArgs({ allowPositionals: true, options: {
  target: { type: 'string', default: 'default' }, socket: { type: 'string' },
  config: { type: 'string' }, bridge: { type: 'string' },
  'remote-socket': { type: 'string' }, 'remote-command': { type: 'string' },
  agent: { type: 'string' }, scope: { type: 'string' }, version: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'project-dir': { type: 'string' }, 'install-root': { type: 'string' },
  mux: { type: 'boolean' }, stdio: { type: 'boolean' }, json: { type: 'boolean' },
  help: { type: 'boolean' }, 'manifest-url': { type: 'string' },
} }));
command = positionals[0];
socketPath = values.socket || defaultSocketPath();
configPath = values.config || defaultConfigPath();

  if (positionals.length > 1) throw new Error('Unexpected positional arguments; use --help');
  if (values['install-root'] !== undefined && !['install', 'doctor', 'rollback', 'uninstall'].includes(command)) {
    throw new Error('--install-root is supported only by install, doctor, rollback and uninstall');
  }
  if (command === 'install' && values['install-root'] !== undefined && !['user', 'project'].includes(values.scope)) {
    throw new Error('Installation with --install-root requires explicit --scope user|project');
  }
  if (values.help || !command) {
    process.stdout.write('Fruitctl\n\nCommands: mcp, broker, relay, attach, install, doctor, rollback, uninstall\n' +
      '  mcp --target PROFILE [--socket PATH]\n' +
      '  broker [--config PATH] [--socket PATH]\n' +
      '  relay --bridge USER@HOST [--socket PATH] [--remote-socket PATH]\n' +
      '  install --agent AGENT --scope user|project --version TAG --target PROFILE [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY] [--dry-run]\n' +
      '  doctor [--agent AGENT] [--scope user|project] [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY] --json\n' +
      '  rollback|uninstall --agent AGENT [--scope user|project] [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY]\n' +
      '\n--install-root selects Fruitctl runtime/state/launcher storage; registration still follows scope and project/user configuration.\n' +
      'Repeat the selected root for doctor, rollback and uninstall. Explicit-root installation requires explicit scope; omitted root preserves legacy paths.\n' +
      'Install requires explicit --version TAG. Doctor writes JSON: exit 1 for drift, 0 for configured or not-installed.\n');
  } else if (command === 'broker') {
    const { createBroker } = await import('../lib/broker/server.mjs');
    const config = await loadConfig(configPath);
    lifecycle(await createBroker({ socketPath, config }));
    process.stderr.write('Fruitctl broker ready\n');
  } else if (command === 'relay') {
    const { createRelay } = await import('../lib/broker/relay.mjs');
    const service = await createRelay({ socketPath, bridge: values.bridge,
      remoteSocket: values['remote-socket'], remoteCommand: values['remote-command'] });
    lifecycle(service);
    process.stderr.write('Fruitctl relay ready\n');
    service.failure.catch(async error => {
      process.stderr.write(`${error.message}\n`);
      try { await service.close(); } catch {
      process.stderr.write('Fruitctl: owned session cleanup unconfirmed; reconcile the target before restarting\n');
      process.exitCode = 1;
    }
      process.exitCode = 1;
    });
  } else if (command === 'attach') {
    if (!values.mux) throw new Error('Attach requires --mux; agents use mcp --target PROFILE');
    const { attachMux } = await import('../lib/broker/relay.mjs');
    await attachMux({ socketPath });
  } else if (command === 'mcp') {
    const { BrokerExecutor } = await import('../lib/broker/client.mjs');
    const { startMcp } = await import('../lib/mcp/server.js');
    const version = await packageVersion();
    const executor = new BrokerExecutor({ socketPath, target: values.target });
    await executor.opened;
    const server = await startMcp({ executor, name: 'fruitctl', version });
    lifecycle({ close: async () => { await server.close(); await executor.close(); } });
    process.stdin.once('end', () => executor.close());
  } else if (['install', 'doctor', 'uninstall', 'rollback'].includes(command)) {
    if (command === 'install' && !values.version) {
      throw new Error('Installation requires explicit --version TAG; use the exact published release tag');
    }
    const installer = await import('../lib/install/index.mjs');
    const result = await installer[command]({ agent: values.agent, scope: values.scope,
      version: values.version || await packageVersion(), target: values.target,
      dryRun: Boolean(values['dry-run']), projectDir: values['project-dir'],
      installRoot: values['install-root'],
      configPath: values.config || process.env.FRUITCTL_CONFIG_PATH,
      manifestUrl: values['manifest-url'] });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (command === 'doctor' && result.status === 'drift') process.exitCode = 1;
  } else throw new Error('Unknown Fruitctl command; use --help');
} catch (error) {
  process.stderr.write(`Fruitctl: ${error.message}\n`);
  process.exitCode = 1;
}
