#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 *  █████╗ ██████╗  █████╗ ███████╗
 * ██╔══██╗██╔══██╗██╔══██╗██╔════╝
 * ███████║██████╔╝███████║███████╗
 * ██╔══██║██╔══██╗██╔══██║╚════██║
 * ██║  ██║██║  ██║██║  ██║███████║
 * ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝
 *
 * Copyright (c) 2026 Rıza Emre ARAS <r.emrearas@proton.me>
 *
 * This file is part of Claude KVM.
 * Released under the MIT License — see LICENSE for details.
 *
 * Legacy native MCP entrypoint and injectable Fruitctl executor exports.
 * The four compatible tools use PC requests over bounded stdin/stdout NDJSON.
 */

import { pathToFileURL } from 'node:url';
import { createNativeExecutor } from './lib/mcp/native.js';
import { startMcp } from './lib/mcp/server.js';

export { NativeExecutor, createNativeExecutor } from './lib/mcp/native.js';
export { createMcpServer, startMcp } from './lib/mcp/server.js';

function log(message) {
  const timestamp = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[MCP ${timestamp}] ${message}\n`);
}

export async function startNativeMcp(options = {}) {
  const { transport, name, version, timeoutMs, ...nativeOptions } = options;
  const executor = await createNativeExecutor({ log, ...nativeOptions });
  try {
    const application = await startMcp({ executor, transport, name, version, timeoutMs });
    log('MCP server connected on stdio');
    return application;
  } catch (error) {
    await executor.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startNativeMcp().then((application) => {
    const shutdown = () => {
      log('Shutting down...');
      application.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    log(`Fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
