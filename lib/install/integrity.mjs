import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recordInstallerFileCheck } from './timings.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function statMaybe(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Callers retain capability/identity checks and their existing guard boundaries.
// This is a sequential path audit, not an atomic tree or held-FD snapshot.
export async function auditRuntimeFiles({ prefix, files, modes, policy, beforeFile, onCheck }) {
  if (!['doctor', 'rollback', 'cache'].includes(policy)) throw new Error('Invalid runtime audit policy');
  for (const [relative, digest] of Object.entries(files)) {
    recordInstallerFileCheck('cacheFileAudit');
    if (policy === 'doctor' && (path.isAbsolute(relative) || relative.split('/').includes('..') || path.normalize(relative) !== relative || !/^[a-f0-9]{64}$/.test(digest || ''))) {
      throw new Error('Invalid runtime file inventory');
    }
    if (policy === 'rollback' && (path.isAbsolute(relative) || relative.split('/').includes('..'))) throw new Error('Invalid runtime receipt path');
    const file = path.join(prefix, relative);
    if (beforeFile) await beforeFile(file);
    const stat = policy === 'cache' ? await fs.lstat(file) : await statMaybe(file);
    if (policy === 'doctor') {
      const regular = stat?.isFile() === true;
      const modeMatches = modes === undefined || (stat?.mode & 0o777) === modes[relative];
      onCheck({ name: relative, ok: regular && modeMatches && digest === sha256(await fs.readFile(file)) });
    } else {
      if (!stat?.isFile() || (policy === 'cache' || modes !== undefined) && (stat.mode & 0o777) !== modes[relative] || sha256(await fs.readFile(file)) !== digest) {
        throw new Error(policy === 'rollback'
          ? `Previous runtime file is missing or changed: ${relative}; refusing rollback`
          : `Cached runtime file changed: ${relative}`);
      }
    }
  }
}
