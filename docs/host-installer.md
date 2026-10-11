# Independent Host installer

The developer Host installer manages a stable `FruitctlHost.app` separately
from the VNC controller and agent adapters. There is no current public Host
release. The public [alpha.7 runtime](install.md) excludes the Host; these
checkout commands are for an explicitly reviewed private native-only bundle.
They do not select a future release tag.

Use an ordinary user on Apple Silicon macOS with **Node.js 24 already
installed** and the macOS signing, Gatekeeper and `xcrun stapler` tools
available. This checkout interface does not bootstrap Node or install an agent.
Run it from the reviewed Fruitctl checkout; replace every placeholder below.

```sh
cd "/absolute/path/to/fruitctl"
FRUITCTL_HOST_TAG='<exact-version-from-reviewed-native-manifest>'
node bin/fruitctl-host-install.mjs install \
  --version "$FRUITCTL_HOST_TAG" --dry-run
node bin/fruitctl-host-install.mjs install \
  --version "$FRUITCTL_HOST_TAG" \
  --manifest-path "/absolute/path/fruitctl-release.json" \
  --manifest-sha256 "<reviewed-64-hex-manifest-sha256>" \
  --evidence-path "/absolute/path/native-evidence.json" \
  --archive-path "/absolute/path/FruitctlHost-stapled-distribution.zip"
node bin/fruitctl-host-install.mjs doctor
```

Offline installation requires all four pinned-input options. The exact version
must match the manifest; evidence and archive hashes must match its entries.
`--dry-run` reports a plan without downloading or authenticating the bundle.
Online installation accepts an explicit published native-only tag; it is
unavailable until such a Host release exists.

The default is a real app copy at `~/Applications/FruitctlHost.app`, with private
lock, receipts and verified caches in the adjacent
`.FruitctlHost.fruitctl-install` directory. Use `--app-path` on every command to
select another canonical absolute `FruitctlHost.app` path. Its parent must be
user-owned and not group/world writable. Foreign apps, symlinks, changed bytes
and conflicting locks are refused. Quit a running Host locally before changes;
the installer never signals it.

```sh
node bin/fruitctl-host-install.mjs rollback --dry-run
node bin/fruitctl-host-install.mjs uninstall --dry-run
```

Remove `--dry-run` for the chosen operation. Rollback restores the recorded
previous verified cache; uninstall removes only the owned app and retains
verified caches and removal history. Doctor checks receipts and file/cache
drift, exits nonzero for drift, and does not repeat Apple authentication.

Installation performs file and signing checks without launching the app,
changing services or granting [macOS permissions](permissions.md). First launch,
consent retention and physical capture/Stop remain separate qualification work.
