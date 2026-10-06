import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const repository = 'xoxd-ai/fruitctl';
export const releaseSchema = 'fruitctl.release.v1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateVersion(version) {
  if (!/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(version || '')) {
    throw new Error('An exact release tag is required; latest, branches and URLs are unsupported');
  }
  return version;
}

export function validateManifest(manifest, { version, platform, arch }) {
  if (!manifest || manifest.schema !== releaseSchema || manifest.repository !== repository || manifest.version !== version || !Array.isArray(manifest.assets)) throw new Error('Release manifest identity/version mismatch');
  const matches = manifest.assets.filter(asset => asset?.kind === 'runtime' && asset.os === platform && asset.arch === arch);
  if (matches.length !== 1) throw new Error(`No unique runtime artifact for ${platform}/${arch}; platform qualification is separate`);
  const asset = matches[0];
  const prefix = `https://github.com/${repository}/releases/download/${version}/`;
  if (asset.name !== `fruitctl-${version}-${platform}-${arch}.tar.gz` || asset.url !== prefix + asset.name || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('Invalid pinned runtime asset name, URL or checksum');
  return asset;
}

async function checkedFetch(url, fetchImpl, maxBytes = 512 * 1024 * 1024) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fruitctl-installer' }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Release download failed (${response.status}) at ${url}; this tag may not have published qualified assets`);
  if (Number(response.headers?.get('content-length')) > maxBytes) throw new Error('Release response is too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw new Error('Release response is too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

export async function resolveRelease({ version, platform, arch, offline }, { fetchImpl = globalThis.fetch } = {}) {
  validateVersion(version);
  let manifestBytes, digest, archive;
  if (offline) {
    // Explicit test/operator air-gap input still requires a separately supplied
    // manifest digest and the exact manifest artifact checksum.
    if (!/^[a-f0-9]{64}$/.test(offline.manifestSha256 || '')) throw new Error('Offline manifest requires its pinned SHA-256');
    manifestBytes = await fs.readFile(offline.manifestPath); digest = offline.manifestSha256;
  } else {
    const metadata = JSON.parse(await checkedFetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(version)}`, fetchImpl, 4 * 1024 * 1024));
    if (metadata.tag_name !== version || metadata.draft === true) throw new Error('GitHub release tag mismatch or draft');
    const manifests = metadata.assets?.filter(asset => asset.name === 'fruitctl-release.json') || [];
    if (manifests.length !== 1) throw new Error('This release has no unique Fruitctl runtime manifest; source-only tags are not installable');
    const item = manifests[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(item.digest || '')) throw new Error('GitHub did not provide the release manifest SHA-256; refusing unverified installation');
    const url = `https://github.com/${repository}/releases/download/${version}/fruitctl-release.json`;
    if (item.browser_download_url !== url) throw new Error('Unexpected release manifest URL');
    digest = item.digest.slice(7);
    manifestBytes = await checkedFetch(url, fetchImpl, 4 * 1024 * 1024);
  }
  if (sha256(manifestBytes) !== digest) throw new Error('Release manifest SHA-256 mismatch');
  const manifest = JSON.parse(manifestBytes);
  const asset = validateManifest(manifest, { version, platform, arch });
  archive = offline ? await fs.readFile(offline.archivePath) : await checkedFetch(asset.url, fetchImpl);
  if (sha256(archive) !== asset.sha256) throw new Error('Runtime archive SHA-256 mismatch');
  return { manifest, manifestSha256: digest, asset, archive };
}

export async function extractRuntime(release, destination) {
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(parent, '.fruitctl-stage-'));
  const archivePath = path.join(stage, 'runtime.tar.gz');
  const extracted = path.join(stage, 'runtime');
  try {
    await fs.writeFile(archivePath, release.archive, { mode: 0o600 });
    const { stdout } = await run('tar', ['-tzf', archivePath], { maxBuffer: 16 * 1024 * 1024 });
    const entries = stdout.trim().split('\n');
    const normalized = entries.map(name => name.replace(/^\.\//, '').replace(/\/$/, ''));
    if (!entries.length || entries.some((name, i) => !name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || normalized[i].includes('//') || normalized[i].split('/').includes('.') && normalized[i] !== '.' && normalized[i] !== '')) throw new Error('Unsafe runtime archive path');
    const names = normalized.filter(name => name && name !== '.');
    if (new Set(names).size !== names.length) throw new Error('Duplicate runtime archive path');
    const verbose = await run('tar', ['-tvzf', archivePath], { maxBuffer: 32 * 1024 * 1024 });
    if (verbose.stdout.split('\n').some(line => line && !['-', 'd'].includes(line[0]))) throw new Error('Runtime archive must contain regular files/directories only');
    await fs.mkdir(extracted, { mode: 0o700 });
    await run('tar', ['-xzf', archivePath, '-C', extracted, '--no-same-owner'], { maxBuffer: 1024 * 1024 });
    const files = {};
    for (const relative of ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md']) {
      const stat = await fs.lstat(path.join(extracted, relative));
      if (!stat.isFile()) throw new Error(`Runtime bundle missing regular ${relative}`);
      if (['bin/node', 'bin/fruitctl'].includes(relative) && !(stat.mode & 0o111)) throw new Error(`Runtime bundle has nonexecutable ${relative}`);
    }
    async function inventory(directory, relative = '') {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${item.name}` : item.name;
        const child = path.join(directory, item.name);
        if (childRelative === '.fruitctl-runtime.json') throw new Error('Archive may not supply installer runtime identity');
        if (item.isDirectory()) await inventory(child, childRelative);
        else if (item.isFile()) files[childRelative] = sha256(await fs.readFile(child));
        else throw new Error(`Runtime bundle contains a nonregular entry: ${childRelative}`);
      }
    }
    await inventory(extracted);
    const identity = { schema: 'fruitctl.runtime.v1', version: release.manifest.version, manifestSha256: release.manifestSha256, archiveSha256: release.asset.sha256, platform: release.asset.os, arch: release.asset.arch, files };
    await fs.writeFile(path.join(extracted, '.fruitctl-runtime.json'), JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
    try { await fs.rename(extracted, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Cached runtime destination is not a regular directory');
      const prior = JSON.parse(await fs.readFile(path.join(destination, '.fruitctl-runtime.json'), 'utf8'));
      if (prior.archiveSha256 !== identity.archiveSha256 || prior.manifestSha256 !== identity.manifestSha256) throw new Error('Immutable release directory already contains different bytes');
      for (const [relative, digest] of Object.entries(identity.files)) if (sha256(await fs.readFile(path.join(destination, relative))) !== digest) throw new Error(`Cached runtime file changed: ${relative}`);
    }
    return identity;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
