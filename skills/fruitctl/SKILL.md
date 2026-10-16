---
name: fruitctl
description: Install, diagnose, or use Fruitctl MCP to observe and control an operator-configured VNC desktop from an agent. Use for Fruitctl desktop workflows, not generic browser automation or unrelated host administration.
---

# Fruitctl

Use the operator-configured target profile and the installed Fruitctl MCP
server. Read [installation](references/installation.md) for setup, upgrade,
diagnosis, or removal. Read [operation](references/operation.md) when controlling
the desktop. [contract.toon](references/contract.toon) is the compact shared
contract; it describes the workflow, not a replacement MCP wire protocol.

The real MCP tools are `vnc_command`, `action_queue`, `task_complete`, and
`task_failed`. Use their discovered schemas. Frontends may prefix these names;
do not invent computer-use tools or infer capabilities from another agent.

## Doctor

Before controlling a macOS target, run `fruitctl doctor --macos --target
<profile>`, or add `--target-ssh <user@host>` for a raw VNC profile. It runs
read-only checks of the target over SSH.

- Any typed `targetPreflight.failures` entry means stop and report it. Examples
  are a macOS version other than 26.6.1+ or 27, Screen Sharing off, observe-only
  access, a High Performance session, the login window or a locked screen.
- Report each `warnings` entry and each `unknowns` entry as-is. Do not change
  target settings or grants yourself.

## Control

Observe with `vnc_command` action `health`, then `screenshot`. Every result's
`route` and `indicator` say which route answered. The raw route always reports
`indicator: absent`. A failed result adds an `error` object with `message` and,
for typed failures, `code` and `data`; code `-32010` (`stale_screen`) means no
fresh pixels were captured, so take a new screenshot before any input. Inspect the current
image and its scaled coordinates, perform authorized bounded input, and obtain
a new screenshot to verify the result. OCR, a process health response, or an
input acknowledgement alone does not prove that the requested desktop change
occurred.

If target identity, pixels, geometry, or an input outcome is uncertain, pause
input and report what remains unverified. Never replay uncertain input
automatically. A target change belongs to operator configuration, not tool
arguments. Credentials belong to the controller's configured provider; never
put them in prompts, MCP arguments, generated config, logs, or receipts.

The purple human indicator is optional and available only on qualified modes.
Do not claim it is running or excluded from captures without evidence. Finish
the owned session with `task_complete` or `task_failed`; report any unconfirmed
release. Provide a concise observed result and any incomplete part of the
user's request.
