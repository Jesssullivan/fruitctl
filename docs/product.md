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
remain stable. Fruitctl's workflow does not depend on proprietary computer-use
engines in any one frontend.

## Compatibility and evidence

The inherited native build targets **Apple Silicon and macOS 15 or newer**.
That is a build configuration, not qualification of every macOS release.
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

## Delivery milestones

Dates are initial forecasts in **America/New_York**. Weekly implementation work
uses the existing Tuesday-to-Tuesday delivery cadence. Research and
specification precede implementation; release promotion requires evidence.

| Milestone | Forecast | Acceptance |
| --- | --- | --- |
| Authority and specification | October 5, 2026, 23:59 | Public repo authority, source consolidation manifest, private prompt preservation, complete architecture/install/overlay specification, product tracking, and documentation route established. Existing signed releases and unqualified source are distinguished. |
| Reproducible core | October 12, 2026, 17:00 | Dependency provenance, consolidated source, fresh-frame/geometry correctness, broker target boundaries, bounded calls and session/process lifetimes, reproducible candidate, and rollback established. |
| Qualified installation preview | October 19, 2026, 17:00 | Independently verified pinned artifacts; generic Home Manager and direct installation receipts; clean install, upgrade, rollback, and uninstall; supported controller/target/mode matrix qualified. |
| Agent adoption and dogfood | October 26, 2026, 17:00 | Frontend-specific install and end-to-end receipts, live docs, seven-day Lab measurements, explicit experimental combinations, and next-cycle disposition of remaining defects. |

The purple human indicator is a parallel lane: capture-exclusion feasibility
proof on **October 6**, preview on **October 12**, and supported-mode
qualification on **October 19**. Its intended appearance is an edge-feathered
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
