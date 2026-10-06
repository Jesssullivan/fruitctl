# Fruitctl agent instructions

Fruitctl is the public, harness-independent VNC desktop-control product owned
by xoxd-ai. Canonical repository: https://github.com/xoxd-ai/fruitctl.
Canonical documentation: https://fruitctl.clients.xoxd.ai/.

## Working contract

- Read `git status --short --branch` before changes and preserve other lanes.
- Use the registered `just` recipes. Heavy builds do not run on Neo.
- Preserve upstream history, notices, legacy MCP tool/action names, executable
  aliases and compatible signed application identity.
- Keep credentials outside configuration and receipts. The Darwin controller
  owns credential providers; Linux attaches over SSH without receiving secrets.
- A target profile is configured by the operator. Tool arguments cannot redirect
  it. Cancel uncertain input; never replay it automatically.
- Signed release bytes are immutable inputs. Consumers do not patch or re-sign.
- A capture succeeds only with complete, correctly mapped pixels; test changing
  targets to qualify action-to-observation behavior.
- The purple indicator ships only on qualified capture modes. Window sharing
  flags alone do not prove exclusion. Do not mask pixels or hide it to capture.
- Existing fleet policies, host services and the proprietary Codex Aqua engine
  belong to their owning repositories. Do not restart another session's services.
- Public docs describe tested versions and observed capability. A rendered MCP
  entry or notarization receipt is not runtime acceptance.
- Private prompts, raw transcripts, host inventories and Linear payloads stay in
  private Lab. Publish distilled product decisions and redacted evidence.
- No GUI/agent binary probes, broad process cleanup, secret output, home-root
  deletion, instruction overrides, or in-repo archive trees.

## Parallel ownership

`stream | owner | paths | evidence | next` is the working handoff format.
Agents edit assigned paths only and report tests. The coordinating agent owns
root package metadata, shared broker integration, Git commits and publication.

## Product boundaries

`MCP -> shared relay -> Darwin broker -> VNC client -> target Screen Sharing`

Optional target AppKit/ScreenCaptureKit app supplies capture-neutral human
indication and filtered observations. The VNC input client remains on the seat.
Initial Linux support is the SSH bridge. Unsupported native/platform/frontend
combinations fail explicitly rather than claiming universal support.
