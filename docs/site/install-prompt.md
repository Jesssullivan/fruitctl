# Copy the rendered prompt into your agent

This source file is an authored template. The documentation build renders its
tokens from the exact curated currentPreview metadata; the served
`https://fruitctl.clients.xoxd.ai/install-prompt.md` is the rendered prompt.
When reading the raw template, resolve its tokens from a full-SHA-pinned
`docs/site/adoption.json` and matching `docs/site/versions.json` before use.

Install Fruitctl from the canonical public producer
`https://github.com/xoxd-ai/fruitctl` for my current agent. Read its pinned
AGENTS.md, installation guide, compatibility matrix, and adoption manifest.
The current immutable runtime preview is `{{FRUITCTL_RELEASE_TAG}}`, source revision
`{{FRUITCTL_SOURCE_REVISION}}`. Verify the actual GitHub release is
published and immutable, verify its `fruitctl-release.json` asset digest and
archive checksums, and use those exact pins. Never treat main or latest as
immutable executable or skill bytes.
Fetch the source-pinned bootstrap with user curl configuration disabled
(`curl --disable`) or an equivalent verified HTTPS client.
Before execution, verify `scripts/install.sh` has SHA-256
`{{FRUITCTL_BOOTSTRAP_SHA256}}`.

If the canonical documentation origin rejects the client, use the frozen GitHub
raw source fallback below. Documentation revision `{{FRUITCTL_DOCS_REVISION}}`
is distinct from the runtime producer revision above:

- Install guide: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/{{FRUITCTL_DOCS_REVISION}}/docs/install.md`
- Curated release inventory: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/{{FRUITCTL_DOCS_REVISION}}/docs/site/versions.json`
- Canonical adoption contract: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/{{FRUITCTL_DOCS_REVISION}}/integrations/adoption.json`
- Release-policy overlay: `https://raw.githubusercontent.com/xoxd-ai/fruitctl/{{FRUITCTL_DOCS_REVISION}}/docs/site/adoption.json`

These are committed source inputs, not rendered site artifacts. Resolve the
preview from the policy overlay and matching inventory entry, then verify the
actual published release and manifest asset digest through GitHub's release API.
Do not change the client User-Agent to impersonate a browser or claim this
fallback repairs canonical-origin policy.

The matching release inventory entry records these verified scopes:

{{FRUITCTL_VERIFIED_SCOPES}}

Acceptance receipt platforms recorded in that same entry:

{{FRUITCTL_RECEIPT_PLATFORMS}}

The entry records these pending scopes:

{{FRUITCTL_PENDING_SCOPES}}

Preserve those exact scope and platform limits when reporting qualification.
Its macOS 15+ ARM64 runtime bundles the signed, Apple-notarized
controller as `bin/claude-kvm-daemon`; verify its recorded hash and Developer ID
signature without changing its bytes. Linux needs the SSH bridge to a
configured Darwin controller. A configuration receipt does not qualify a desktop
journey.

Inspect my agent version, seat OS and architecture, and supported MCP/skill
installation surface. Use the native Darwin controller on a supported Mac or
the SSH bridge from Linux. Keep the VNC target credentials on the Darwin
controller through its local credential provider. Preserve my unrelated agent
instructions, MCP servers, and existing installation.

Configure only an operator-selected named target profile. Explain any required
Screen Sharing or macOS consent step precisely and wait for the user to perform
that step. Do not claim signing, notarization, or an IDE plugin bypasses user
consent or proves this adapter works. The installer does not create profiles or
credentials, enable Screen Sharing, start services or launch a GUI. A bare
controller has no stapled ticket; Gatekeeper may use its online notarization
ticket and require normal user approval. Do not remove protections or re-sign
the controller to bypass approval.

If no compatible immutable preview asset or required controller exists, report the missing artifact or
qualification and stop before substituting an unreviewed source build. Once
installed, check capabilities and health, obtain a complete fresh frame, and
ask for a designated reversible test action if none is already authorized.
Verify the resulting observation and human stop control. Do not replay uncertain
input automatically.

Report the installed release, full source revision, agent adapter/version,
controller/target OS, capture mode, and observed test outcome without secrets,
private screen content, or invented success. Enable the optional FuzzyBot spell
indicator only when this exact capture mode has a recorded exclusion proof.
Host remains an unqualified source prototype and is absent from public runtime
payloads, installation and generated helper mappings. Do not install or enable
it as part of this preview. No Screen Capture grant or Apple capability approval
is provided by this installation.
