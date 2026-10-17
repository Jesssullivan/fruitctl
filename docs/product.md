# Fruitctl product charter

Fruitctl gives agents a shared VNC desktop-control interface with explicit
target ownership, fresh observations, bounded operation lifetimes, and
reviewable installation. xoxd-ai owns the public product and its releases.

| Authority | Location |
| --- | --- |
| Source and releases | <https://github.com/xoxd-ai/fruitctl> |
| Documentation and installation | <https://fruitctl.clients.xoxd.ai/> |
| Product delivery | [Fruitctl in Linear](https://linear.app/tinyland/project/fruitctl-060da6f7dff9) |
| Agent workflow | [Shared Fruitctl skill](../skills/fruitctl/SKILL.md) |
| Reliability targets | [Lab SLOs](slo.md) |

## Product shape

Fruitctl is efficient, business-level agent control of Macs over VNC. An
agent sees a Mac's screen and drives its keyboard and mouse through Apple
Screen Sharing, under one operator-configured target profile per Mac.

- **Controllers from enterprise environments.** Agents run on Linux seats,
  especially Rocky Linux, or on macOS. A Linux seat reaches the Darwin broker
  through the SSH relay and never holds a VNC credential. A macOS seat uses the
  broker directly.
- **Secrets from real sources, vault-agnostic.** The Darwin broker reads the
  target credential, and any value an agent types with `type_secret {ref}`,
  from what the operator already runs: a file materialized by sops-nix or
  Ansible, a vault CLI, or the login keychain. Refs are allowlisted per target.
  Values never reach the agent, tool arguments, the Linux seat, logs or the
  journal, and are never used to answer a TCC consent prompt.
- **Mac quirks handled.** Fruitctl expects TCC and system dialogs on the
  desktop, the input dead time after Screen Sharing authentication, mid-answer
  capture stalls, display sleep, other remote-input owners, and Remote
  Management/VNC settings. It waits, refuses with a typed error, or reports
  them through `fruitctl doctor` instead of guessing. Input is authorized only
  by a fresh frame, and uncertain input is never replayed.
- **Delivered the way the fleet is already managed.** Pinned, signed and
  notarized releases; a Home Manager module with federated environments; and
  `doctor` checks for a Fruitctl-ready target.

Accessibility and Screen Recording grants for the optional Host are the
expected adoption posture. Claude Code and Codex are the qualified agent
frontends; other adapters are best effort and labelled unqualified.

### Non-goals

- Hardware KVM (betterkvmd/Comet); a separate post-GA initiative.
- Windows or Linux desktops as targets, Intel Macs, and VNC servers other than
  Apple Screen Sharing until each is qualified.
- Native Linux VNC control without a Darwin broker.
- Generic browser automation or a proprietary computer-use engine.
- A secret store of its own, or secrets passed through prompts, tool
  arguments or MCP configuration.
- Granting TCC consent, managed or headless Screen Capture grants, or MDM.
- Cached frames, automatic input replay, or an automatic human-activity pause
  (the human Stop latch is the control).
- Session recording (opt-in RFB recording is post-GA), a Guacamole listener,
  and any feature outside VNC/KVM control of Macs.

## Authority

The repository owns the specification. Linear tracks owners, work, dates, and
acceptance evidence. Public pages are built from the repository; a release's
installation instructions must resolve to that release's immutable revision.
Moving documentation may explain the current product but must not silently
change a pinned installation. Raw prompts, transcripts, inventories, and
unredacted operating evidence stay outside this public repository.

## Product boundary

The initial architecture is `agent MCP -> shared relay -> Darwin broker ->
VNC client -> target Screen Sharing`. The controller selects an operator-defined
target profile. Tool arguments cannot choose another host or supply credentials.
The Darwin controller owns credential providers. Linux controllers attach over
SSH without receiving VNC secrets. The optional target application supplies
human indication and observations on individually qualified capture modes.

The root CLI is the operator interface: `fruitctl mcp`, `fruitctl install`,
`fruitctl doctor`, `fruitctl uninstall`, and `fruitctl rollback`. Installation
uses a pinned product release and one canonical skill shared by frontend
adapters. Generic Home Manager integration consumes immutable signed Darwin
release bytes; activation does not rebuild or re-sign them. Client and target
prerequisites remain explicit, including user-granted macOS permissions where
required.

Existing MCP names `vnc_command`, `action_queue`, `task_complete`, and
`task_failed`, native application identity, and compatible executable aliases
remain stable. The additional `computer` tool only accepts Anthropic and OpenAI
computer-use action shapes and translates them to these Fruitctl actions.
Fruitctl's workflow does not depend on proprietary computer-use engines in any
one frontend.

## Compatibility and evidence

Fruitctl supports **macOS 26 (26.6.1 or later) and macOS 27** on Apple
Silicon; `fruitctl doctor --macos` enforces that floor on targets and earlier
releases are unsupported. See [macOS target support](compatibility.md#macos-target-support).
The inherited native build still sets a macOS 15.0 deployment target. That is
a build configuration, not a support claim or qualification of any release.
Initial Linux support is the SSH controller bridge to a Darwin broker, including
the intended Rocky Linux controller route. Native Linux execution, Intel
Darwin binaries, and additional VNC servers require their own qualification.

The adapter registry is [integrations/agents.json](../integrations/agents.json).
The shared adoption contract is [integrations/adoption.json](../integrations/adoption.json).
Use these evidence labels consistently:

| Label | Meaning |
| --- | --- |
| Configuration documented | An adapter has concrete installation/configuration guidance. |
| Configuration checked | Its configuration and installer checks passed; this does not prove images or input. |
| Runtime experimental | End-to-end release qualification is incomplete. |
| Runtime qualified | An exact release, frontend version, platform, and mode have linked observation/input/lifecycle receipts. |
| Supported | The qualified combination is in the maintained release support matrix. |

Claude Code, Codex, Pi, Junie, OpenCode, VS Code, and Kimi adapters begin as
runtime experimental. Junie CLI and Junie inside a JetBrains IDE are separate
qualification surfaces. Generating MCP configuration, passing an offline test,
or obtaining Apple notarization does not promote an adapter to supported.

## Two delivery goals

| Goal | Deliverable | Acceptance boundary |
| --- | --- | --- |
| G1: Production native control | Immutable native controller with fresh observations, current input mapping, bounded cancellation and process cleanup; independently qualified Host indication and capture | Qualify the installed release on each declared controller/target/mode. Host additionally needs simultaneous physical heartbeat/text and complete indicator-free observations, local human Stop, permission and input-mapping evidence. Source tests, signing and notarization cover only their recorded scopes. |
| G2: Reviewable adoption and delivery | Pinned installers, one canonical skill, generic Home Manager consumption and the canonical public documentation route | Verify clean installation, upgrade, rollback, uninstall and preservation of unrelated configuration. Record reviewed source and immutable runtime identities separately. Tool/skill installation needs no desktop connection; real frontend rendering and the Linux SSH journey require their own receipts. |

Native source lives in `ClaudeKVM-Daemon/` and `FruitctlHost/`; shared control
and installation live in `lib/broker/` and `lib/install/`. The canonical skill
is `skills/fruitctl/`, frontend contracts are in `integrations/`, and consumer
configuration uses `nix/home-manager.nix`. Release schemas and the curated
[release inventory](site/versions.json) describe artifacts and evidence;
[public pages](site/README.md) are built from these repository sources.
Fleet host configuration and activation remain consumer responsibilities.

## Delivery milestones

Dates are forecasts in **America/New_York**. The original M1-M3 dates
(October 12, 19 and 26) were reforecast on October 14 and October 16, 2026,
when the installation-preview milestone was split into M2a and M2b. Research and
specification precede implementation; release promotion requires evidence.
Dates do not establish completed acceptance. Missing evidence keeps the
affected combination experimental and requires a dated reforecast without
weakening the qualification criteria.

| Milestone | Forecast | Acceptance |
| --- | --- | --- |
| M0: Authority and specification | October 5, 2026, 23:59 (met) | Public repo authority, source consolidation manifest, private prompt preservation, complete architecture/install/overlay specification, product tracking, and documentation route established. Existing signed releases and unqualified source are distinguished. |
| M1′: Reliable core and indicator preview | October 21, 2026, 17:00 | Dependency provenance, consolidated source, fresh-frame/geometry correctness, broker target boundaries, bounded calls and session/process lifetimes, reproducible candidate, and rollback established; indicator preview. |
| M2a: Host route, core parity, clipboard, relay | October 28, 2026, 17:00 | Host route as the standard installation, with display mapping and the exclusion gate; macOS VM qualification target; relay; core input parity with mouse holds scoped to one `action_queue`; UTF-8 clipboard; display-sleep handling. Carries the installation preview: independently verified pinned artifacts, generic Home Manager and direct installation receipts, clean install/upgrade/rollback/uninstall, adapters and doctor. |
| M2b: Accessibility grounding, observation v2, keymaps | November 4, 2026, 17:00 | Host accessibility grounding under the same lease; observation v2 (zoom, diff regions and masks, stability waits, queue expectations); keymaps, input source and typing canary with per-target paste routing; computer-use tool alias layer. |
| M3′: Adoption, dogfood, measured release acceptance | November 18, 2026, 17:00 | Exact release provenance, license and source; fresh approved installation; frontend-specific install and end-to-end receipts; supported image, input, release and reconnect journeys; hash-chained journal and latency telemetry; explicit experimental combinations; next-cycle disposition of remaining defects. Its seven-day baseline opens the 28-day [SLO](slo.md) window. |

The purple human indicator is a parallel lane: capture-exclusion feasibility
proof on **October 6**, preview with M1′ on **October 21**, and supported-mode
qualification with the M2a Host route exclusion gate on **October 28**. Its intended appearance is an edge-feathered
deep-purple heartbeat pulse with centered text,
“Machine under FuzzyBot spell, courtesy xoxd.ai)”. It indicates agent ownership
of that target throughout the session, including pauses between commands.
Physical display visibility and absence from the
harness image must be demonstrated together. Window-sharing flags alone are
insufficient; masking pixels or hiding the indicator during extraction does
not meet the requirement. The core release and indicator have independent
promotion decisions.

## Acceptance and maintenance

Maintain three implementation workstreams: core reliability;
distribution/adapters/docs; and the human indicator. Each has an accountable
owner and one primary active issue. A milestone closes only when its acceptance
receipts are linked, remaining work has an explicit successor or deferral, and
the release/support matrix reflects the result.

Ship complete changing-frame observations; verify input through subsequent
observation; never replay uncertain input automatically. Qualify cancellation,
reconnect, display changes, unauthorized targets, process cleanup, and
credential separation. [Lab SLOs](slo.md) define measurable initial targets and
the promotion policy. Public support is best effort through
[GitHub issues](https://github.com/xoxd-ai/fruitctl/issues).
