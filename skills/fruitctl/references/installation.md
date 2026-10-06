# Installation and diagnosis

The canonical documentation origin is <https://fruitctl.clients.xoxd.ai/>;
until a served deployment is recorded, use `docs/install.md` in the pinned
release source at <https://github.com/xoxd-ai/fruitctl>. If no compatible verified
release is listed, stop and report that prerequisite rather than substituting
a source build. Inspect the
installed `fruitctl --help` and subcommand help before using flags; the adapter
registry is `integrations/agents.json` in the release source.

The installer interface is:

```text
fruitctl install --agent <agent> --scope <user|project> --version <exact-tag> --target <profile> --dry-run
fruitctl doctor --agent <agent> --scope <user|project>
fruitctl uninstall --agent <agent> --scope <user|project>
fruitctl rollback --agent <agent> --scope <user|project>
```

Supported adapter identifiers are `claude`, `codex`, `pi`, `junie`, `opencode`,
`vscode`, and `kimi`. A documented adapter is runtime experimental until the
release's matrix links a qualification receipt. Junie CLI and the JetBrains
IDE integration require separate receipts. The project scope uses the current
project; confirm the intended scope and dry-run output before installation.
Perform the user's requested installation by removing `--dry-run` once its
concrete changes match the request. Keep unrelated agent configuration intact.

The initial native controller is Darwin. A Linux agent uses the configured SSH
bridge to a Darwin broker; it does not receive the target's VNC secrets. Native
Linux and additional target/server combinations are experimental unless the
release matrix explicitly qualifies them.

Have the operator configure the target profile and credential provider. If
macOS requires a user grant or desktop setting, give the exact action from the
release's installation instructions and wait for it. Do not promise a fully
headless permission grant or work around a refused permission.

For generic Home Manager installation, use the release's pinned signed
artifact/module. Preserve the signed bytes and application identity. Consumer
installation does not patch, rebuild, or re-sign the native client.

For failures, run the scoped doctor and distinguish missing artifacts,
configuration, credential-provider access, SSH connectivity, target Screen
Sharing, capture freshness, frontend image rendering, and input contention.
Report the failing stage and redact secrets. Do not restart unrelated services
or terminate another session as an installation repair. Rollback/uninstall
apply only to the Fruitctl-owned installation recorded by the installer.
