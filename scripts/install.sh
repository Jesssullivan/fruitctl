#!/bin/sh
# Rootless, exact-tag bootstrap. This executes Fruitctl's bundled Node runtime;
# it never launches an agent, IDE, GUI, sudo, or a package-manager install hook.
set -eu

fail() { printf '%s\n' "fruitctl: $*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: install.sh --agent AGENT --version EXACT_TAG --target PROFILE [--scope user|project] [--dry-run]'; }
agent='' version='' target='' scope='user' dry_run='false'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent|--version|--target|--scope)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in --agent) agent=$2;; --version) version=$2;; --target) target=$2;; --scope) scope=$2;; esac
      shift 2;;
    --dry-run) dry_run='true'; shift;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown argument $1";;
  esac
done
case "$agent" in claude|codex|pi|junie|opencode|vscode|kimi) ;; *) fail 'Choose --agent claude, codex, pi, junie, opencode, vscode or kimi';; esac
case "$scope" in user|project) ;; *) fail 'Scope must be user or project';; esac
printf '%s\n' "$version" | LC_ALL=C awk 'NR==1 && /^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$/ { ok=1 } END { exit !(ok && NR==1) }' || fail 'An exact release tag is required; latest and branches are unsupported'
printf '%s\n' "$target" | LC_ALL=C awk 'NR==1 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/ && length($0)<=128 { ok=1 } END { exit !(ok && NR==1) }' || fail 'Target must be a configured profile name'
case "$(uname -s)" in Darwin) platform='darwin';; Linux) platform='linux';; *) fail 'Only Darwin and Linux SSH-bridge controllers are supported';; esac
case "$(uname -m)" in arm64|aarch64) arch='arm64';; x86_64|amd64) arch='x64';; *) fail 'Only arm64 and x64 controllers are supported';; esac
asset="fruitctl-${version}-${platform}-${arch}.tar.gz"
base="https://github.com/xoxd-ai/fruitctl/releases/download/${version}"
if [ "$dry_run" = 'true' ]; then
  printf '%s\n' "Planned exact-tag bootstrap: ${base}/${asset}" "Agent: ${agent}; scope: ${scope}; target profile: ${target}" 'No release download, installation or agent launch performed.'
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
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "$1" -o "$2" || fail "Release asset unavailable at $1; source-only or unpublished tags cannot be installed"
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
"$work_dir/runtime/bin/node" --input-type=module - "$work_dir/runtime" "$version" "$agent" "$scope" "$target" "$PWD" "$work_dir/$asset" <<'FRUITCTL_BOOTSTRAP'
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [bundle, version, agent, scope, target, projectDir, archivePath] = process.argv.slice(2);
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Release bundle must use qualified Node 24');
const { install } = await import(pathToFileURL(`${bundle}/lib/install/index.mjs`));
const artifact = `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/fruitctl-${version}-${process.platform}-${process.arch}.tar.gz`;
const fetchImpl = async (url, options) => url === artifact ? new Response(await fs.readFile(archivePath)) : fetch(url, options);
const result = await install({ version, agent, scope, target, projectDir }, { fetchImpl });
console.log(JSON.stringify(result, null, 2));
if (result.status === 'declarative-required') console.error('Managed configuration retained. Apply the generated snippet through Home Manager or the owning configuration.');
FRUITCTL_BOOTSTRAP
