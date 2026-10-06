#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Dependency-free public documentation and adoption-artifact builder.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) {
  throw new Error('Usage: node scripts/build-docs.mjs [--check]');
}
const output = path.join(root, 'build-docs');
const origin = 'https://fruitctl.clients.xoxd.ai';
const repository = 'https://github.com/xoxd-ai/fruitctl';
const pageNames = ['index', 'install', 'agents', 'architecture', 'compatibility', 'home-manager', 'licensing', 'product', 'slo'];
const labels = {
  index: 'Fruitctl', install: 'Install', agents: 'Agent adapters', architecture: 'Architecture',
  compatibility: 'Compatibility', product: 'Product', slo: 'Service objectives',
  'home-manager': 'Home Manager', licensing: 'Licensing',
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sources = new Map();
async function source(relative) {
  const value = await readFile(path.join(root, relative), 'utf8');
  sources.set(relative, sha256(value));
  return value;
}
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const revision = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Source revision must be a full Git commit SHA');
const sourceStatus = git('status', '--porcelain').length ? 'workspace' : 'committed';
const sourceBase = `${repository}/blob/${revision}/`;
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function linkTarget(raw, page) {
  if (/^https?:\/\//.test(raw) || raw.startsWith('#')) return raw;
  if (!/^[a-zA-Z0-9._/-]+(?:#[a-zA-Z0-9_-]+)?$/.test(raw)) {
    throw new Error(`Unsupported link in ${page}: ${raw}`);
  }
  const [filename, fragment = ''] = raw.split('#');
  const relative = path.posix.normalize(path.posix.join('docs', filename));
  if (relative === 'docs/site/install-prompt.md') return `/install-prompt.md${fragment ? `#${fragment}` : ''}`;
  const name = path.posix.basename(relative, '.md');
  if (path.posix.dirname(relative) === 'docs' && pageNames.includes(name)) {
    return `${name === 'index' ? '/' : `/${name}/`}${fragment ? `#${fragment}` : ''}`;
  }
  if (relative.startsWith('../') || relative.startsWith('/')) throw new Error(`Link escapes repository: ${raw}`);
  return `${sourceBase}${relative}${fragment ? `#${fragment}` : ''}`;
}

function inline(value, page) {
  const tokens = [];
  const token = (html) => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };
  const marked = value.replace(/`([^`]+)`/g, (_, content) => token(`<code>${escape(content)}</code>`))
    .replace(/<(https?:\/\/[^<>\s]+)>/g, (_, target) => token(`<a href="${escape(target)}">${escape(target)}</a>`))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
      const href = linkTarget(target, page);
      return token(`<a href="${escape(href)}">${escape(label)}</a>`);
    });
  return escape(marked).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function markdown(text, page) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const parts = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  let code = [];
  function flushParagraph() {
    if (paragraph.length) parts.push(`<p>${inline(paragraph.join(' '), page)}</p>`);
    paragraph = [];
  }
  function closeList() {
    if (list) parts.push(`</${list}>`);
    list = null;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushParagraph(); closeList();
      if (fence !== null) { parts.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = []; fence = null; }
      else fence = line.slice(3);
      continue;
    }
    if (fence !== null) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); closeList();
      const id = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      parts.push(`<h${heading[1].length} id="${id}">${inline(heading[2], page)}</h${heading[1].length}>`);
      continue;
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      flushParagraph(); closeList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      parts.push(`<div class="table-scroll"><table><thead><tr>${cells(line).map((cell) => `<th scope="col">${inline(cell, page)}</th>`).join('')}</tr></thead><tbody>`);
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        parts.push(`<tr>${cells(lines[i]).map((cell) => `<td>${inline(cell, page)}</td>`).join('')}</tr>`);
        i += 1;
      }
      i -= 1;
      parts.push('</tbody></table></div>');
      continue;
    }
    const item = /^(?:([-*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const type = item[2] ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; parts.push(`<${type}>`); }
      let content = item[3];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s+[-*]\s/.test(lines[i + 1])) content += ` ${lines[++i].trim()}`;
      parts.push(`<li>${inline(content, page)}</li>`);
      continue;
    }
    closeList(); paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (fence !== null) throw new Error(`Unclosed Markdown code fence in ${page}`);
  return parts.join('\n');
}

const pageSources = new Map();
for (const name of pageNames) {
  pageSources.set(name, await source(`docs/${name}.md`));
}
const deployment = JSON.parse(await source('docs/site/deployment.json'));
const canonicalAdoptionText = await source('integrations/adoption.json');
const canonicalAdoption = JSON.parse(canonicalAdoptionText);
const agentsText = await source('integrations/agents.json');
const agents = JSON.parse(agentsText);
const adoption = { ...canonicalAdoption, ...JSON.parse(await source('docs/site/adoption.json')) };
const versions = JSON.parse(await source('docs/site/versions.json'));
const installPrompt = await source('docs/site/install-prompt.md');
if (deployment.canonicalOrigin !== origin || adoption.documentation.replace(/\/$/, '') !== origin || adoption.repository !== repository) {
  throw new Error('Documentation, deployment, and adoption authority must agree');
}
if (deployment.status === 'pending' && deployment.receipt !== null) throw new Error('Pending deployment cannot carry a live receipt');
if (deployment.status !== 'pending' && (!deployment.receipt || !deployment.allocatedPagesHostname)) {
  throw new Error('Claimed hosting requires a Pages hostname and receipt');
}
if (deployment.allocatedProject && deployment.allocatedPagesHostname !== `${deployment.allocatedProject}.pages.dev`) {
  throw new Error('Allocated Pages project and observed hostname must agree');
}
if (!Array.isArray(versions.releases)) throw new Error('Curated release list must be explicit');
if (!Array.isArray(canonicalAdoption.frontends) || !canonicalAdoption.frontends.length || !agents.agents) {
  throw new Error('Canonical adoption and adapter registries are required');
}
for (const frontend of canonicalAdoption.frontends) {
  if (!agents.agents[frontend.id]) throw new Error(`No canonical adapter for ${frontend.id}`);
}
for (const release of versions.releases) {
  if (!/^[0-9a-f]{40}$/.test(release.sourceRevision || '') || release.qualification !== 'passed' || release.immutable !== true) {
    throw new Error('Curated public versions require passed qualification, immutable release, and full revision');
  }
}
if (adoption.releaseStatus === 'available' && !versions.releases.length) throw new Error('No verified public release is available');

const artifacts = new Map();
const navigation = pageNames.map((name) => `<a href="${name === 'index' ? '/' : `/${name}/`}">${labels[name]}</a>`).join('\n');
for (const [name, content] of pageSources) {
  const route = name === 'index' ? '/' : `/${name}/`;
  artifacts.set(name === 'index' ? 'index.html' : `${name}/index.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(labels[name])} · Fruitctl</title><meta name="description" content="Fruitctl agent VNC desktop control: installation, compatibility, and verified adoption.">
<link rel="canonical" href="${origin}${route}"><link rel="stylesheet" href="/site.css"></head>
<body><a class="skip" href="#content">Skip to content</a><header><a class="brand" href="/">Fruitctl<span>xoxd.ai</span></a><nav aria-label="Documentation">${navigation}</nav></header>
<main id="content">${markdown(content, name)}</main>
<footer><p>Public support: best effort. <a href="${repository}">Public source</a> · <a href="/agents.md">Agent instructions</a> · <a href="/adoption.json">Adoption manifest</a></p>
<p>Source: <code>${revision}</code> (${sourceStatus}). Hosting: ${escape(deployment.status)}.</p></footer></body></html>\n`);
}
artifacts.set('site.css', await source('docs/site/site.css'));
artifacts.set('install-prompt.md', installPrompt);
artifacts.set('agents.md', `# Fruitctl adoption\n\nCanonical repository: ${repository}\nCanonical documentation: ${origin}/\n\nUse adoption.json and versions.json to resolve a verified immutable release. Pin\nfull source SHAs and verify binary SHA-256 hashes. Preserve unrelated MCP/skill\nconfiguration. Use operator-selected profiles and controller-local credentials.\nCapture a complete fresh frame before input; stop without replay on uncertainty.\nQualify the installed adapter and capture mode. Enable the indicator only with\nrecorded exclusion proof. Public support is best effort.\n\nRead /install-prompt.md, /install/, /agents/, /compatibility/, /architecture/, and /slo/.\nSource revision: ${revision}; source status: ${sourceStatus}.\nRelease status: ${adoption.releaseStatus}; hosting status: ${deployment.status}.\n`);
artifacts.set('llms.txt', `# Fruitctl\n\n> Agent VNC desktop control. Resolve verified releases before installation.\n\n## Documentation\n${pageNames.map((name) => `- [${labels[name]}](${origin}${name === 'index' ? '/' : `/${name}/`})`).join('\n')}\n\n## Machine adoption\n- [Agent instructions](${origin}/agents.md)\n- [Install prompt](${origin}/install-prompt.md)\n- [Adoption JSON](${origin}/adoption.json)\n- [Adoption TOON](${origin}/adoption.toon)\n- [Curated versions](${origin}/versions.json)\n- [Public source](${repository})\n`);
const buildSource = { revision, status: sourceStatus, contentSha256: sha256(JSON.stringify([...sources].sort())) };
artifacts.set('integrations/adoption.json', canonicalAdoptionText);
artifacts.set('integrations/agents.json', agentsText);
artifacts.set('adoption.json', `${JSON.stringify({
  ...adoption,
  canonicalAdoption: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/${revision}/integrations/adoption.json`,
  adapterRegistry: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/${revision}/integrations/agents.json`,
  source: buildSource,
  hostingStatus: deployment.status,
  releases: versions.releases,
}, null, 2)}\n`);
artifacts.set('versions.json', `${JSON.stringify(versions, null, 2)}\n`);
artifacts.set('deployment.json', `${JSON.stringify(deployment, null, 2)}\n`);
artifacts.set('adoption.toon', `product: fruitctl\nrepository: ${JSON.stringify(repository)}\ndocumentation: ${JSON.stringify(origin)}\nreleaseStatus: ${adoption.releaseStatus}\nhostingStatus: ${deployment.status}\nruntimeBaseline: ${adoption.runtimeBaseline}\nsource:\n  revision: ${JSON.stringify(revision)}\n  status: ${sourceStatus}\n  contentSha256: ${JSON.stringify(buildSource.contentSha256)}\ncredentials: ${adoption.credentials}\ntargetSelection: ${adoption.targetSelection}\nuncertainInput: ${adoption.uncertainInput}\nindicatorPolicy: ${adoption.indicatorPolicy}\nsupport: ${adoption.support}\nfrontends[${canonicalAdoption.frontends.length}]{id,runtimeStatus}:\n${canonicalAdoption.frontends.map((frontend) => `  ${frontend.id},${frontend.runtimeStatus}`).join('\n')}\nqualifiedReleaseCount: ${versions.releases.length}\nreleaseManifest: ${JSON.stringify(`${origin}/versions.json`)}\n`);
artifacts.set('_headers', `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n\n/adoption.json\n  Cache-Control: no-cache\n\n/versions.json\n  Cache-Control: no-cache\n`);
artifacts.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
artifacts.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pageNames.map((name) => `<url><loc>${origin}${name === 'index' ? '/' : `/${name}/`}</loc></url>`).join('')}</urlset>\n`);
const receipts = [...artifacts].map(([file, value]) => ({ file, sha256: sha256(value) }));
artifacts.set('build-manifest.json', `${JSON.stringify({ product: 'fruitctl', source: buildSource, canonicalOrigin: origin, hostingStatus: deployment.status, files: receipts }, null, 2)}\n`);
for (const [file, content] of artifacts) {
  if (/\b(?:VNC_PASSWORD|CF_ACCESS_CLIENT_SECRET|CLOUDFLARE_API_TOKEN)\s*[:=]\s*[^\s"'}]/i.test(content)) {
    throw new Error(`Potential credential assignment in public artifact: ${file}`);
  }
  if (file.endsWith('.html') && /<(script|iframe)\b/i.test(content)) throw new Error(`Active embedding in static page: ${file}`);
}
if (!check) {
  const existing = await lstat(output).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing?.isSymbolicLink()) throw new Error('Refusing a symlink documentation output directory');
  await rm(output, { recursive: true, force: true });
  for (const [file, content] of artifacts) {
    const destination = path.join(output, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
console.log(`Fruitctl docs ${check ? 'checked' : 'built'}: ${pageSources.size} pages, ${artifacts.size} artifacts; releases ${versions.releases.length}; hosting ${deployment.status}.`);
