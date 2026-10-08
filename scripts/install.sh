#!/bin/sh
# Rootless, exact-tag bootstrap. This executes Fruitctl's bundled Node runtime;
# it never launches an agent, IDE, GUI, sudo, or a package-manager install hook.
set -eu

fail() { printf '%s\n' "fruitctl: $*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: install.sh --agent AGENT --version EXACT_TAG --target PROFILE [--scope user|project] [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY] [--dry-run]' \
    '--install-root selects Fruitctl storage only; registration follows scope and project/user configuration.' \
    'Explicit-root installation requires explicit --scope. Repeat the root for doctor, rollback and uninstall.'
}
agent='' version='' target='' scope='user' scope_set='false' dry_run='false'
install_root='' install_root_set='false' project_dir="$PWD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent|--version|--target|--scope|--project-dir|--install-root)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --agent) agent=$2;; --version) version=$2;; --target) target=$2;;
        --scope) scope=$2; scope_set='true';;
        --project-dir) project_dir=$2;;
        --install-root) install_root=$2; install_root_set='true';;
      esac
      shift 2;;
    --install-root=*) install_root=${1#--install-root=}; install_root_set='true'; shift;;
    --project-dir=*) project_dir=${1#--project-dir=}; shift;;
    --dry-run) dry_run='true'; shift;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown argument $1";;
  esac
done
case "$agent" in claude|codex|pi|junie|opencode|vscode|kimi) ;; *) fail 'Choose --agent claude, codex, pi, junie, opencode, vscode or kimi';; esac
case "$scope" in user|project) ;; *) fail 'Scope must be user or project';; esac
if [ "$install_root_set" = 'true' ]; then
  case "$install_root" in /*) ;; *) fail '--install-root must be a nonempty absolute directory';; esac
  [ "$scope_set" = 'true' ] || fail 'Installation with --install-root requires explicit --scope user|project'
fi
printf '%s\n' "$version" | LC_ALL=C awk 'NR==1 && /^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$/ { ok=1 } END { exit !(ok && NR==1) }' || fail 'An exact release tag is required; latest and branches are unsupported'
printf '%s\n' "$target" | LC_ALL=C awk 'NR==1 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/ && length($0)<=128 { ok=1 } END { exit !(ok && NR==1) }' || fail 'Target must be a configured profile name'
case "$(uname -s)" in Darwin) platform='darwin';; Linux) platform='linux';; *) fail 'Only Darwin and Linux SSH-bridge controllers are supported';; esac
case "$(uname -m)" in arm64|aarch64) arch='arm64';; x86_64|amd64) arch='x64';; *) fail 'Only arm64 and x64 controllers are supported';; esac
asset="fruitctl-${version}-${platform}-${arch}.tar.gz"
base="https://github.com/xoxd-ai/fruitctl/releases/download/${version}"
if [ "$dry_run" = 'true' ]; then
  printf '%s\n' "Planned exact-tag bootstrap: ${base}/${asset}" "Agent: ${agent}; scope: ${scope}; target profile: ${target}" 'No release download, installation or agent launch performed.'
  printf '%s\n' "Registration project: ${project_dir}"
  if [ "$install_root_set" = 'true' ]; then printf '%s\n' "Fruitctl storage root: ${install_root}; requires a capability-enabled release"; fi
  exit 0
fi
for required in curl tar awk mktemp; do command -v "$required" >/dev/null 2>&1 || fail "Required utility missing: $required"; done
if command -v sha256sum >/dev/null 2>&1; then checksum_tool='sha256sum'
elif command -v shasum >/dev/null 2>&1; then checksum_tool='shasum'
else fail 'SHA-256 utility missing (sha256sum or shasum)'; fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/fruitctl-bootstrap.XXXXXXXX") || fail 'Cannot create bootstrap directory'
case "$work_dir" in ''|/|"$HOME") fail 'Unsafe bootstrap directory';; esac
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 130' HUP INT TERM
download() {
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "$1" -o "$2" || fail "Release asset unavailable at $1; source-only or unpublished tags cannot be installed"
}
download "$base/SHA256SUMS" "$work_dir/SHA256SUMS"
expected=$(LC_ALL=C awk -v asset="$asset" '$2==asset || $2=="*" asset { if(length($1)!=64 || $1 !~ /^[0-9a-f]+$/) exit 2; value=$1; count++ } END { if(count!=1) exit 1; print value }' "$work_dir/SHA256SUMS") || fail "No unique valid checksum for $asset"
download "$base/$asset" "$work_dir/$asset"
if [ "$checksum_tool" = 'sha256sum' ]; then actual=$(sha256sum "$work_dir/$asset" | awk '{print $1}')
else actual=$(shasum -a 256 "$work_dir/$asset" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || fail 'Runtime archive SHA-256 mismatch'

tar -tzf "$work_dir/$asset" > "$work_dir/entries" || fail 'Invalid runtime archive'
LC_ALL=C awk '
  /^\// || /\\/ || /(^|\/)\.\.(\/|$)/ { exit 1 }
  { name=$0; sub(/^\.\//,"",name); sub(/\/$/,"",name); if(name=="" || name==".") next; if(name ~ /(^|\/)\.(\/|$)/ || name ~ /\/\// || seen[name]++) exit 1 }
' "$work_dir/entries" || fail 'Unsafe or duplicate runtime archive path'
tar -tvzf "$work_dir/$asset" > "$work_dir/details" || fail 'Cannot inspect runtime archive'
LC_ALL=C awk 'length($0) && substr($0,1,1)!="-" && substr($0,1,1)!="d" { exit 1 }' "$work_dir/details" || fail 'Runtime archive contains links or unsupported entry types'
mkdir "$work_dir/runtime"
tar -xzf "$work_dir/$asset" -C "$work_dir/runtime" --no-same-owner || fail 'Cannot extract runtime archive'
[ -x "$work_dir/runtime/bin/node" ] || fail 'Runtime archive has no executable bundled Node'
[ -f "$work_dir/runtime/lib/install/index.mjs" ] || fail 'Runtime archive has no installer'

# SHA256SUMS and the script are authenticated by TLS to the exact public release.
# Before any persistent write, the Node installer separately checks GitHub's
# asset digest for fruitctl-release.json, its identity, and the archive checksum.
"$work_dir/runtime/bin/node" --input-type=module - "$work_dir/runtime" "$version" "$agent" "$scope" "$target" "$project_dir" "$work_dir/$asset" "$install_root_set" "$install_root" <<'FRUITCTL_BOOTSTRAP'
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [bundle, version, agent, scope, target, projectDir, archivePath, rootSelected, installRoot] = process.argv.slice(2);
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Release bundle must use qualified Node 24');
if (rootSelected === 'true') {
  const metadata = JSON.parse(await fs.readFile(`${bundle}/package.json`, 'utf8'));
  if (metadata.fruitctlInstallerCapabilities?.installRoot !== 1) {
    throw new Error('Release package does not support --install-root; choose a capability-enabled exact release');
  }
}
const installer = await import(pathToFileURL(`${bundle}/lib/install/index.mjs`));
if (rootSelected === 'true' && installer.installerCapabilities?.installRoot !== 1) {
  throw new Error('Release installer API does not support --install-root; refusing legacy storage fallback');
}
const artifact = `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/fruitctl-${version}-${process.platform}-${process.arch}.tar.gz`;
const fetchImpl = async (url, options) => url === artifact ? new Response(await fs.readFile(archivePath)) : fetch(url, options);
const options = { version, agent, scope, target, projectDir };
if (rootSelected === 'true') options.installRoot = installRoot;
const result = await installer.install(options, { fetchImpl });
console.log(JSON.stringify(result, null, 2));
if (result.status === 'declarative-required') console.error('Managed configuration retained. Apply the generated snippet through Home Manager or the owning configuration.');
FRUITCTL_BOOTSTRAP
