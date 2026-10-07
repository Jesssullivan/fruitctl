// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBroker } from '../lib/broker/server.mjs';

test('CLI MCP initialization reports the package version and preserves real tool names', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-cli-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  let broker;
  const client = new Client({ name: 'fruitctl-cli-version-fixture', version: '1' });
  t.after(async () => {
    try { await client.close(); }
    finally {
      try { await broker?.close(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  let nativeStarts = 0;
  broker = await createBroker({
    socketPath, config: { targets: { fixture: {} } },
    factory: async () => {
      nativeStarts++;
      throw new Error('Metadata discovery must not start a native controller');
    },
  });
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url)),
      'mcp', '--target', 'fixture', '--socket', socketPath],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: 'fruitctl', version: metadata.version });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ['vnc_command', 'action_queue', 'task_complete', 'task_failed']);
  assert.equal(nativeStarts, 0);
  assert.equal(stderr, '');
});
