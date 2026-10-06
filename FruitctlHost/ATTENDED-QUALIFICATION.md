# Bounded host qualification run

Status: prepared; no live acceptance has run. Allocate one attended 75-minute
session per exact macOS build and signed artifact. Stop after a failing mandatory
gate, record the failure, and keep helper input unqualified. The first installer
does not depend on completing this optional mode. This document authorizes no
GUI launch, consent change, service change, or process signal by itself.

Before starting, bind the operator-approved target profile, signed host bundle
SHA-256 and bundle/team identity, controlling-seat native client SHA-256, runtime
revision, macOS product/build versions, and the exact display IDs, bounds, pixel
sizes, scale, rotation, Space mode, and Screen Sharing configuration. Keep private
host aliases, credentials, raw desktop contents, and session transcripts outside
the public repository. Use an operator-approved synthetic desktop only.

The baseline build receipt before the lifecycle correction had 62 offline native
tests (40 reconnect, 14 native behavior, 8 host), zero failures, and source-tree
SHA-256 `1baa3db7d2a952bc9af5bee962d013142519e7cb7e5916bdc12e2bceefc05ac5`.
That receipt does not qualify the corrected source or desktop behavior. Obtain
the final rebuilt receipt and artifact hashes before this run.

| Budget | Gate | Measured evidence and pass requirement |
| --- | --- | --- |
| 0–10 min | Identity, permission and startup | Verify exact signed/stapled bytes. Operator launches capture-disabled app, then explicitly opts into configured capture and the OS screen-recording consent if needed. `health` must expose fixed display/backend, `raw_vnc_exclusion:false`, and no ready lease. Denied or withdrawn permission produces no new input and no invisible ready acknowledgment. Stdio without resident app fails and never launches it. |
| 10–25 min | Continuous indicator exclusion | Put independently changing, numbered markers in all four corners, the center, and two interior positions. Keep purple panels and exact centered text visibly present throughout 30 owned SCK frames. An external camera or attended human log confirms simultaneous physical visibility. Every frame retains all underlying markers with current sequence values and excludes border/text pixels without masking or hiding panels. Save sanitized crops/hashes plus marker decode results and timestamps. Raw VNC images are explicitly outside this contract. |
| 25–35 min | Readiness latency | Measure 30 `begin_activity` round trips and 120 sequential renewal round trips using controlling-seat monotonic time; report min/p50/p95/max, not only averages. All accepted acks must match instance/session/sequence/challenge/display generation and backend, report UI age at most 250 ms, and arrive within 500 ms. Any slower ack grants no permit. Cold acquisition failure is a feature qualification failure, with no fallback to raw capture. |
| 35–50 min | Displays, Spaces and input mapping | On each connected display, verify the click-through pulse and exact text while a human clicks/types/drags/scrolls a synthetic test window; record no focus change/interception. Visit fullscreen Space, ordinary Space, Mission Control and Stage Manager; verify physical indicator persistence. Reduce Motion must show static indication. On each declared display layout, map a 5×5 grid including corners/center from scaled SCK coordinates to VNC input, with observed position error at most two native pixels. Require the unchanged qualified bounds/dimensions and current native allocation/generation before any input. A missing panel or mismatched mapping fails the layout. |
| 50–65 min | Human stop, loss and lifecycle | Use the menu's Stop agent control during a synthetic operation; verify lease cleared, panels hidden, human_stop_latched:true, and begin/renew/capture refused. Exercise wake/activation and an IPC reconnect: none may clear that latch. A person selects Allow agent control; only a fresh activity may resume, and other session/display holds still apply. Individually disconnect the owned SSH attach, release activity, sleep/wake displays, switch user and return, remove/re-add a display, withdraw/regrant permission, and terminate only the explicitly owned helper process under attended authorization. Record the last accepted challenge send, last RFB write, and physical overlay-clear time. With responsive UI/broker, new writes must stop by the 1,000 ms permit expiry; disconnect/process crash must clear all panels within 5,000 ms. Fresh begin during inactive/asleep state must fail. Wake/return requires new activity, never old-lease restoration. Display generation change rejects old mapping before input. |
| 65–75 min | Negative transport and release | Inject stale/reordered/mismatched mock receipts, malformed/oversized/partial request lines, a competing same-user attachment, blocked output, and failed capture. No session takeover, permit extension by captured images, auto reconnect/replay, or success with incomplete pixels. Clean release requires target UI/capture false plus the controlling native writer's release acknowledgment. Record sanitized errors and native write counts. |

If hardware lacks a second display, a rotated display, or a requested macOS build,
mark that exact matrix row untested; do not generalize another row's result.
If the run reaches its time limit, preserve completed evidence and mark remaining
gates pending. A public `qualificationReceipt` must bind the passed artifact and
specific fixed display mapping; a nonempty string alone does not prove a pass.

Main-thread suspension is a separate attended fault experiment on a disposable
test session. Suspending only the owned app may leave visible windows present;
this implementation has no claim that a hung UI clears within five seconds.
The controlling seat must still reject missing/future/stale main-thread readiness
and cease new writes at permit expiry. Do not signal another process or install
a watchdog to make this experiment pass. Record suspension and process-crash
results separately.
Human stop is a local AppKit action, not a guarantee of instantaneous interruption
of already emitted input or of a frozen controlling broker. Record those limits
alongside the responsive-path stop measurement.

Store the redacted acceptance record with: artifact hashes and identity,
source-tree hash, OS build, display-layout binding, each gate's status and sample
count, maximum acknowledgement/write-stop/overlay-clear durations, image marker
evidence hashes, mapping error distribution, known untested rows, operator name,
and timestamp. A failed or incomplete record grants no input-qualified mapping.
