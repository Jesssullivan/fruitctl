# Prospective Host qualification

Status: optional mode unqualified. Earlier attended attempts captured frames but
failed strict scene acceptance, including displaced marker geometry and gray
contamination of a marker sample. Complete PNGs, failed proofs and human
observations remain immutable private evidence. A new diagnostic cannot turn
that record into a pass.

This protocol authorizes no GUI launch, lease, capture, consent change, process
signal or service change. Confirm applicable bounded attended authorization for
an exact reviewed, tested, signed artifact before execution. Existing applicable
authorization persists; do not repeatedly ask for the same grant. Source/offline
tests and signing/notarization are independent of live acceptance. The Host is
absent from public release/install payloads until required gates pass.

## Prepare the identity and consent episode

Bind source/native-tree revision, full signed bundle inventory/executable hash,
designated requirement, bundle/team identity, entitlements, installed stable
path, notarization/stapling status, controller/broker/helper hashes, OS product
and build, UID/console ownership, display IDs/bounds/native pixels/scale/rotation,
color conversion, Space/fullscreen mode and Reduce Motion. Compare attended and
publication bytes explicitly. Installers must not patch or re-sign signed bytes.

Capture intent defaults false on a fresh profile. Only explicit startup/local
Enable persists it; a grant never enables it. Record actual no-argument restart
intent and a fresh instance without an old lease. Fresh-profile/Disable tests
use isolated suites; never erase the user's preferences or TCC database.

Before a fixture trial, the person identifies each Apple prompt by its visible
app name, body/options, choice and time. Ordinary preflight=true does not prove
that direct capture will avoid a picker-bypass alert or other consent episode.
IPC never invokes an ordinary consent request; ScreenCaptureKit may still show
system UI. No settings automation, TCC database edits, unrelated window titles,
or silent PPPC pregrant. Apple entitlement approval, management policy, initial
human consent and stable identity remain separate provisioning facts.

A prompt during the controlled frame interval fails that scene trial. Preserve
the entire frame and unresolved attribution. Resolve prompts only outside an
ended trial with separately authorized human action. Never label a later warmed
capture as the first cold acquisition. A baseline export itself warms capture.
The cold first-begin ≤500 ms gate therefore requires a separately planned first
activity on an unwarmed process; do not infer its pass from idle-reference timing.

## Versioned fixture and offline scene diagnostics

Generate a new self-contained fixture for each prospective episode. It creates
a fresh 128-bit run ID and refuses to overwrite an existing output:

```sh
node test/qualification/generate.mjs "$QUALIFICATION_OUTPUT/scene.html"
```

Prepare that generated page within the authorized workflow. Set browser zoom to
100%, choose **Start full-screen markers**, and park the visible pointer at 50%
across and 82% down. The pointer remains included in capture. The page enters
actual document fullscreen before drawing; losing fullscreen or changing native
geometry ends the changing scene. A reused page keeps its old run ID, so generate
a new file instead of relabeling an old tab as the current episode.

New pages declare a 50 ms marker schedule (20 Hz). At each animation callback,
the sequence selects the current elapsed-time slot; missed paints skip slots
instead of replaying them. This supports prospective 100 ms capture spacing
for the separate 600-frame/60-second gate, while the 30-frame/at-least-30-second
episode below stays unchanged. Browser throttling or an unchanged painted
sequence still fails the oracle. The schedule is not a measured browser paint
rate or Host capture SLO. Freeze the new page's hash and declared cadence;
earlier 250 ms pages and their results remain historical.

The `fruitctl.scene.v1` format uses seven fixed-position, native-pixel markers.
Every marker binds format, marker ID, run ID, dimensions and changing sequence
with CRC32. Freeze the expected display dimensions and run ID independently of
the captured image. The decoder does not search for displaced markers or derive
accepted geometry from a captured toolbar. Analyze complete original PNGs in
capture order, supplying the generated ID and prepared native dimensions:

```sh
node test/qualification/oracle.mjs "$RUN_ID" "$NATIVE_WIDTH" "$NATIVE_HEIGHT" \
  "$QUALIFICATION_OUTPUT/frame-01.png" "$QUALIFICATION_OUTPUT/frame-02.png"
```

The offline decoder verifies PNG chunk CRCs and completeness, accepts only
non-interlaced 8-bit RGB/RGBA, and reads encoded RGB samples without color-profile
conversion. Its deliberately narrow policy also refuses PLTE and chunk names
with the reserved bit set, even where a general PNG decoder could accept them.
Input is bounded to 128 MiB and 4096 chunks before expensive decoding; file reads
require a stable regular file and check its size before allocation. Unsupported
PNG formats fail explicitly. It rejects stale format or
run IDs, nonadvancing/mixed sequences, displaced geometry, contaminated marker
samples, unexpected background pixels and chromatic/transparent residuals.
All original pixels remain untouched; a 3×3 sample cannot average away a cursor.

Two outcomes stay separate. `strictRasterEqual` requires exact fixture bytes
with zero residual pixels. `sceneValid` allows the format's predeclared 96×96
blank pointer zone to contain one opaque grayscale residual with bounds no
larger than 64×80 and at most 4096 out-of-tolerance pixels. Grayscale requires
equal encoded RGB channels; palette brightness tolerance is ±16, which never
counts as exact raster equality. The report counts and
locates those pixels and explicitly leaves their attribution unknown. Chromatic
residuals fail even inside this zone; marker overlap always fails. This fixed
allowance needs independent review before a new live trial. It was not learned
from a failed frame and cannot waive or relabel the historical strict oracle.
Neither outcome alone proves indicator exclusion, physical heartbeat, local Stop,
consent, input mapping or product qualification.

## Optional diagnostic: export one naturally idle reference

Ordinary bounded capture and local Stop do not require Arm or an idle-reference
export. Skip this section unless the episode explicitly includes that diagnostic;
a missing Arm/reference cannot block ordinary capture readiness. A reference is
useful for investigating residuals, and is not a workaround for a failed scene.

Prepare the owned synthetic fixture, pointer position and permission episode
before the local menu action. Confirm no competing input owner. While the Host
has no lease/readiness/visible panels, the person chooses **Arm one idle reference
export (60s)**. Over an already authorized same-user attachment, read health and
send exactly one `export_idle_reference` with its current `instance_id` and
`reference_id`, fixed display/backend. There is no automatic retry.

Verify the full-native `reference.png` and final `receipt.json` hashes, 0700/0600
ownership, same exact running artifact/instance/display/filter and cursor/color
conversion. The receipt must classify `idle_reference`, report no ready lease
or input observation, and bind monotonic start/completion. Any Stop/Disable,
permission failure, owner disconnect or display/session/sleep transition during
acquisition invalidates it even if eligibility subsequently returns. Retain
failed or partial private outputs; do not repair them or claim a baseline pass.
Descriptor-bound ACL checks must reject extended allow entries, including
inherited entries despite 0700/0600 modes; retain that refusal without repairing
the directory. Deny-only ACLs and verified absence do not add disclosure rights.
Real offline Unix socket tests cover a full-close during suspended acquisition
and continued response delivery after intentional input-only `SHUT_WR`. A peer
closure after the final liveness check during synchronous writing has no atomic
rollback guarantee. A stored receipt alone does not prove continuous attachment
or runtime acceptance; retain any failed or partial private outputs separately.

Collect title-free public window metadata (PID/windowID/bounds/layer/alpha) while
naturally idle, active and released. System-window ownership is established
separately from captured pixel causation. Prior corner windows were present
before activity and owned by WindowServer; their pixels' origin and the center
obstruction's cause were not established. A matching rectangle alone does not
attribute pixels. Preserve normally captured system UI and evaluate every
region; never exclude WindowServer/Control Center, crop, mask, move markers away
from a failed region, hide an active panel or invoke private APIs.

The historical strict oracle remains all210 marker CRC/geometry results and
zero unexplained gray failures. References may support prospective attribution,
not waive that oracle. If legitimate system UI makes it impossible, mark that
compatibility row unsupported. Any new complete-scene oracle needs a separate
review before new images, accounts for all pixels, and cannot relabel old proofs.
Active/reference comparisons require identical native/scaled geometry and color
conversion. The full-native diagnostic does not expand public `max_dimension`.

## One capture-and-human-Stop episode

Proposed budget: one explicitly approved 180 second activity, with ordinary
release initiated by 150 seconds unless human Stop has already ended it. Prepare
camera/operator instructions and Stop before begin. Do not extend the absolute
cutoff, queue later renewals or silently rebegin. Preserve actual send/ack times
and scheduling/network overhead. The previous 300 second release's25ms polling
overshoot remains recorded; the planning margin is prospective.

1. Start independent physical recording/logging before the accepted begin.
   Seven changing CRC-bound markers cover corners, center and two interiors.
   Freeze fixture version/run ID, decoder/color expectations, fixed pointer zone
   and exact output geometry first. Arm/export is optional and remains a separate
   diagnostic, not a prerequisite for this ordinary capture episode.
2. Begin once, binding instance/session/challenge/sequence/display generation.
   Record controlling-seat monotonic RTT and cold/warm preparation. A rejected
   cold begin remains rejected; no fallback or silent warm retry.
3. Retain 30 complete unmodified PNGs over at least 30 seconds while the indicator
   remains continuously present and renewal continues every 500 ms across agent
   thinking gaps. Bind every image/hash and challenge to the exact geometry,
   generation and signed artifact. A prompt, missing marker, incomplete image,
   changed geometry or unexplained colored region fails the image trial; retain
   it and stop collecting further images. A preplanned Stop may end that same
   authorized lease for a separate Stop result; it cannot repair image failure.
4. Physical evidence covers the exact frame interval on every display, with
   deep purple feathered edges and exact centered text
   `Machine under FuzzyBot spell, courtesy xoxd.ai)`. An external 60 fps camera
   aligned to fixture sequence can measure the intended72BPM and uncertainty;
   the waveform's double flash is one heartbeat. Human logs confirm visible
   pulse/text only, not measured BPM. Reduce Motion is a separate static row.
5. The person selects **Fruitctl → Stop agent control** while the same lease is
   still active. Record its activation time bracket, physical last-visible and
   first-clear brackets, final accepted renewal and first refused renewal/health.
   Require `human_stop_latched:true`, lease 0 and all readiness false. Over a fresh
   read-only attachment, begin/renew/capture/export remain refused; wake and
   reconnect cannot clear Stop. A scheduled release or late Stop is not this gate.
   Compare `health.last_human_stop_event.event_id` with initial health: require a
   fresh event bound to the same instance, PID, display ID/generation and session,
   with `active_lease_at_stop:true`, matching final accepted lease sequence and
   positive `active_lease.lease_remaining_ms`. Bracket `invoked_monotonic_ms` with
   `observed_monotonic_ms` readings from that same Host instance; never compare
   clocks across launches. An event retained after Allow is not a new Stop.
   The invocation diagnostic does not prove physical-clear timing; physical
   evidence must establish that independently.
6. Finish with the owned attachment's clean release/close and final health,
   title-free panel metadata and physical clear evidence. Do not signal another
   session or restart Screen Sharing to pass cleanup. Main-thread hang is a
   separate attended fault trial; no 5 second physical-clear guarantee exists
   for a frozen UI. Responsive broker input-stop ≤1 second requires its own actual
   native writer evidence; this capture-only episode supplies none.

Accepted readiness RTT ≤500 ms, UI heartbeat age ≤250 ms, target lease 3 seconds and
seat permit ≤1000 ms from challenge send remain unchanged. Captured images and idle
references never extend or create an input permit. A rejected/permitted exchange
must retain exact sequence/challenge/owner bindings; no uncertain-input replay.

## Subsequent independent input and compatibility gates

Actual authenticated RFB/native input is separate. Screen Sharing descriptor
exhaustion and EOF before a banner are not authentication or mapping evidence,
and grant no authority to clean up other sessions. The VNC writer stays on the
controlling Darwin seat. Require current native allocation/connection generation,
fixed SCK bounds/native/scaled dimensions and the broker's private
`adopt_observation` acknowledgment followed by a fresh ready challenge. A receipt
name string is insufficient.

Under separate owned synthetic-input authorization, qualify a 5×5 grid including
corners/center with ≤2native-pixel error, typing/drag/scroll, local click-through
and focus, thinking-gap indication and native clean-release acknowledgment.
Any session/display/allocation change invalidates mapping before a write.

Record independent rows for macOS build, Retina/scaled/rotated/multiple displays,
ordinary/fullscreen Spaces, Mission Control, Stage Manager, Reduce Motion,
permission withdrawal, reconnect, sleep/wake/user switch, crash and UI hang.
Missing hardware or unexecuted variants stay untested. One successful row never
qualifies all supported configurations.

## Decision receipt

Keep private raw frames/prompts/camera logs. Emit separate statuses for capture
transport, complete scene, Fruitctl pixel exclusion, system-UI attribution,
physical pulse/text continuity, measured rate, local Stop, seat write-stop,
input mapping, consent readiness, artifact/privacy inventory and cleanup. Bind
all source/artifact/fixture/decoder/reference hashes, timestamps, sample counts,
latency/error bounds and unresolved causes. Failed/pending/unsupported mandatory
fields prevent an input-qualified mapping or Host publication claim.
