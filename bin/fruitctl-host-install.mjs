#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { parseArgs } from 'node:util';
import { install, doctor, rollback, uninstall } from '../lib/install/native.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    version: { type: 'string' }, 'app-path': { type: 'string' }, 'dry-run': { type: 'boolean' },
    'manifest-path': { type: 'string' }, 'manifest-sha256': { type: 'string' }, 'evidence-path': { type: 'string' }, 'archive-path': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Fruitctl Host installer (Node.js 24, Apple Silicon Darwin, ordinary user)\n' +
      '  install --version EXACT_TAG [--app-path ABSOLUTE/FruitctlHost.app] [--dry-run]\n' +
      '  doctor|rollback|uninstall [--app-path ABSOLUTE/FruitctlHost.app] [--dry-run]\n' +
      '  Offline install: --manifest-path FILE --manifest-sha256 SHA --evidence-path FILE --archive-path FILE\n' +
      'Default: ~/Applications/FruitctlHost.app. Private state/cache/lock are adjacent.\n' +
      'No launch, TCC grant, signing, service changes or capture qualification. Doctor exits 1 for drift.\n');
  } else {
    if (positionals.length !== 1 || !['install', 'doctor', 'rollback', 'uninstall'].includes(positionals[0])) throw new Error('Choose exactly one command: install, doctor, rollback or uninstall');
    const command = positionals[0], offlineKeys = ['manifest-path', 'manifest-sha256', 'evidence-path', 'archive-path'];
    const supplied = offlineKeys.filter(key => values[key] !== undefined);
    if ((values.version !== undefined || supplied.length) && command !== 'install') throw new Error('Release and offline inputs apply only to install');
    if (supplied.length && supplied.length !== offlineKeys.length) throw new Error('Offline installation requires all four explicitly pinned input options');
    const options = { version: values.version, appPath: values['app-path'], dryRun: !!values['dry-run'], ...(supplied.length ? { offline: { manifestPath: values['manifest-path'], manifestSha256: values['manifest-sha256'], evidencePath: values['evidence-path'], archivePath: values['archive-path'] } } : {}) };
    const result = await ({ install, doctor, rollback, uninstall })[command](options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'drift') process.exitCode = 1;
  }
} catch (error) { process.stderr.write(`fruitctl-host-install: ${error.message}\n`); process.exitCode = 1; }
