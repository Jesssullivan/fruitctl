# Fruitctl Host source

This optional macOS 15+ Apple silicon app renders the purple human indicator
and captures its configured display through ScreenCaptureKit. The existing
LibVNC client and input writer remain on the controlling Darwin seat; the
target continues to serve Apple Screen Sharing. This app has no input service.

The indicator is allowed only for the owned ScreenCaptureKit observation path.
Each capture excludes the complete running Fruitctl Host application, identified
by process ID and bundle ID, so its border and centered text belong outside
that capture. Ordinary VNC viewers and native Apple Screen Sharing capture
have no exclusion guarantee. `raw_vnc_exclusion` is always `false`. No private
capture APIs, window-sharing exclusion assumptions, pixel masking, or temporary
indicator hiding are used.

The source is an implementation candidate. A successful compile and offline
lease tests do not qualify live exclusion, Retina mapping, fullscreen behavior,
TCC behavior, or crash cleanup. Those remain attended acceptance gates.

## Build and offline checks

Run the shared receipt-producing build rail on the designated Darwin ARM64
build host, with an exclusive output directory:

```sh
./scripts/build-host.sh --output-dir /absolute/task-owned/new-build --jobs 2 \
  --reuse-inputs /absolute/task-owned/verified-native-dependency-build
```

The wrapper selects only `FruitctlHost` and `FruitctlHostTests`. The shared rail
checks its pinned dependency carrier, records exact source and output hashes,
and rejects source changes during a build. Omit `--reuse-inputs` only when that
rail must regenerate the reviewed dependencies. The app itself links Apple
frameworks and has no LibVNC or OpenSSL code dependency. Source builds are
unsigned; release signing is a separate artifact step. These checks perform
no GUI launch or live capture, and do not grant screen-recording permission.

## Startup and permissions

The product app identity is `com.xoxd.fruitctl.host`. Release signing and
notarization apply to the complete bundle; they do not grant screen recording.
Capture is disabled by default. An attended launch must select
`--enable-capture`, optionally `--display-id <configured-display-id>`. Only an
attended `--enable-capture --request-screen-capture` launch may request permission.
`--help`, `--doctor`, and `--stdio` never initialize AppKit application UI or
request permission. The app cannot silently enable Screen Sharing or TCC.

The resident app provides a standard menu bar item with **Stop agent control**,
**Allow agent control**, and **Quit Fruitctl Host**. Stop immediately invalidates
the app's lease, hides panels, and latches begin/renew/capture unavailable. Only
the local menu's Allow action clears that latch; IPC and session/display wake
events cannot clear it. Allow establishes no lease and does not override other
readiness checks. The latch lasts for the resident process lifetime; restarting
the app is a new attended launch. The menu uses AppKit and requests no
Accessibility permission.

When the app and controlling broker are responsive, human stop makes the next
renewal fail and the broker's local input permit expires within one second.
This is no guarantee that a frozen broker or UI halts an already emitted remote
input instantly. These timing and stop-menu usability claims require the
attended run below; process-crash and hung-UI cases remain distinct.

`FruitctlHost.app/Contents/MacOS/FruitctlHost --stdio` is an attach shim for an
already running, same-user Aqua instance. It does not launch the app. Neo starts
the shim over its established SSH path. It forwards NDJSON to the app's private
Unix socket at `~/Library/Application Support/Fruitctl/run/host.sock`.
The runtime directory is mode 0700; the socket is 0600, same-user peers only.
An existing live listener is never taken over. Restart may remove only a socket
whose owner and inode remain unchanged after its local connection is refused.
There is no TCP listener, launch-agent installation, or process cleanup policy.

## Attach protocol

Requests use `{"action":"...","params":{...},"id":"request-id"}`; `method`
also accepts the legacy action field. IDs are strings or integers. Responses
are `{"id":"request-id","success":true,"result":{...}}`, or
`{"id":"request-id","success":false,"error":{"code":-32000,"message":"..."}}`.
Each request is one newline-terminated UTF-8 JSON record, at most 65,536 bytes.
Each connection is serialized, and at most eight same-user connections attach.

| Action | Parameters and behavior |
| --- | --- |
| `health` | Read-only capability/readiness and permission preflight; starts no capture. |
| `begin_activity` | `session_id`, positive integer `sequence`, `challenge`; optional `display_id` must match startup configuration, and `capture_backend` must be `owned_sck`. Reserves this connection's lease, verifies one complete excluded-app screenshot, then shows the indicator and acknowledges. |
| `renew_activity` | Same session/connection, strictly increasing `sequence`, fresh `challenge`; requires recent main-thread heartbeat and capture/UI readiness. |
| `release_activity` | `session_id`; releases only this connection's activity and hides the indicator. |
| `capture` / `screenshot` | `session_id`, optional `max_dimension` (256–4096; default 1280), same configured display. Requires a live ready lease. Returns a complete PNG with image and display mapping metadata. |

Unknown actions, including OCR, diff, baseline and custom input, fail explicitly
with `unsupported_host_action`. The seat's observation layer may derive supported
observations from returned PNGs; this app does not advertise those operations.
Other attached sessions cannot acquire, renew, release, or capture this lease.

Acknowledgements bind `instance_id`, `session_id`, `sequence`, `challenge`,
`displayGeneration`, `display_id`, `capture_backend`, `ready`, `capture_ready`,
`overlay_ready`, `ui_heartbeat_age_ms`, and `lease_remaining_ms`. Capture additionally
returns `image` (base64 PNG), `mimeType`, `nativeWidth`, `nativeHeight`,
`scaledWidth`, `scaledHeight`, `display_bounds`, `pixels_per_point_x/y`, and
`cursor_included`. Bounds use the Core Graphics global display coordinate space.
A display-change notification invalidates the lease, advances generation, and
rebuilds all display panels. A capture with changed/incomplete geometry fails.
`activity_eligible` reports the current owned console-session and awake-display
preflight; `ready` also requires that preflight and visible panels on all displays.
Panel visibility is an AppKit state check, not proof that another system surface
cannot occlude a panel. Physical qualification still supplies that evidence.
`human_stop_latched` reports the local human stop latch.

## Timing contract

Target leases expire 3,000 ms after the latest accepted renewal, using local
`ContinuousClock`. A 100 ms main-run-loop timer expires leases and pulses UI
readiness; accepted renewals require a UI heartbeat no older than 250 ms. EOF,
release, capture failure, display change, user-session resignation, and screen
or system sleep revoke activity and hide panels. There is no idle capture loop.
Fresh begin/renew/capture requests remain unavailable while an independent
session, screen-sleep, or system-sleep hold is active. Matching activation/wake
notifications clear only their own hold; they never restore a lease. Every
activity operation also checks public console-session ownership and drawable
displays, covering an inactive launch whose resignation notification preceded
observer registration. No private screen-lock notifications or TCC bypasses are
used; lock-screen behavior remains an attended qualification case.

The Neo broker must challenge every 500 ms during activity, reject acknowledgements
whose challenge round trip exceeds 500 ms, and allow no new input more than
1,000 ms after that challenge was sent. It must validate all acknowledgement
bindings and current VNC/display mapping. No remote timestamp can extend that
local deadline. Release/expiry stops new writes; uncertain input is never replayed.
Bounded input chunks are at most 250 ms and actions at most 2 seconds.

With an operating main run loop, the target's 3-second expiry plus inspection
and hide budgets is designed to clear a lost lease within 3.75 seconds. A process
crash relies on macOS removing its windows and still needs attended validation.
A hung AppKit main thread cannot supply a fresh acknowledgment, so Neo must stop
new input; this source makes no 5-second visual-clear claim for a hung UI thread.

## Attended acceptance gates

1. Establish the signed bundle's screen-recording permission in the logged-in
   Aqua session; verify capture-disabled, denied, and withdrawn permission fail
   without invisible input. Keep the first installer independent of this feature.
2. On each supported macOS build, compare a changing underlying desktop with
   the indicator continuously visible. Confirm complete PNGs exclude all app
   panels and retain underlying corner and center markers; never hide the overlay
   for the test. Record an ordinary VNC frame separately as outside the contract.
3. Confirm no focus change or interception of clicks, typing, scrolling, drag,
   Mission Control, fullscreen Spaces, or Stage Manager. Confirm all connected
   displays show the exact text and purple 72 BPM pulse; Reduce Motion stays static.
4. Qualify PNG-to-VNC coordinate mapping on Retina and non-Retina displays,
   scaled resolutions, rotated displays, and nonzero/negative display origins.
   Changing configured display or display generation cancels before input.
5. Disconnect SSH, release ownership, sleep/lock/switch user, remove a display,
   withdraw capture permission, and terminate only the owned app. Measure no new
   Neo writes after its 1-second permit expiry and no visible overlay after 5 seconds
   for disconnect/process-crash cases. Record hung-UI behavior separately.
6. Exercise stale/reordered acknowledgements, competing attach connections,
   malformed and oversized records, capture failure, blocked output, and partial
   input. Assert no takeover, auto replay, or success from incomplete pixels.

Use [the bounded qualification run](ATTENDED-QUALIFICATION.md) to record exact
artifact/version bindings, observations, latency samples, and pass/fail evidence.

Primary references: Apple's [application exclusion filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingapplications:exceptingwindows:)),
[ScreenCaptureKit capture](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
[legacy window-sharing warning](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none),
[floating overlay behavior](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallapplications),
[ContinuousClock](https://developer.apple.com/documentation/swift/continuousclock),
[current GUI session](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()),
[session resignation](https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidresignactivenotification),
and [sleeping display drawability](https://developer.apple.com/documentation/coregraphics/cgdisplayisasleep(_:)).
