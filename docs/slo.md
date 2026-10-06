# Fruitctl Lab service objectives

These are **provisional Lab targets**, adopted October 5, 2026. They are not
claims of measured attainment. Public support is best effort. Every result
identifies the release, frontend, controller/target platform, capture mode,
sample count, and measurement interval.

xoxd-ai's product lead owns the objectives and promotion decisions. The core
maintainer owns capture, startup, input and process measurements; the Host
maintainer owns physical indicator, exclusion and Stop evidence. Each receipt
names its responsible maintainer, and current assignments live in the
[product delivery project](https://linear.app/tinyland/project/fruitctl-060da6f7dff9).
The product lead reviews missing evidence and exhausted budgets at the weekly
planning review. These initial thresholds are engineering targets pending a
live baseline, not estimates derived from the offline test results.

## Indicators and budgets

| Indicator | Initial target | Measurement |
| --- | --- | --- |
| Capture reliability | At least 99% over rolling 28 days | Complete, fresh, correctly mapped screenshots divided by eligible screenshot attempts. Timeouts, dropped calls, and errors remain in the denominator. |
| Warm capture latency | At least 95% within 5 seconds | Eligible screenshots returning a correct image within 5 seconds divided by eligible attempts on an established session. Also report latency percentiles for successes and the failure count. |
| Startup | At least 95% ready within 90 seconds | Successful startup attempts within 90 seconds divided by attempts after documented target/network/authentication prerequisites are satisfied. |
| Operation lifetime | 30-second operation deadline | Enforce an end-to-end deadline including queue wait and cancellation. Record terminal-response overhead; long-running text/batches require explicit bounded handling rather than silently extending the deadline. |
| Input ownership | One active input owner per host; stop accepting input within 1 second of revoke/abort | Contention, expiry, cancellation, and disconnect tests against a configured target. This behavior requires qualification. |
| Process lifecycle | No accumulating owned transport/daemon children after 100 lifecycle cycles | Return to the documented idle process set after connect/disconnect/cancel cycles; record child counts and RSS after warmup and teardown. |
| Indicator lifecycle | Visible within 1 second of the first admitted command; visible throughout the owned session; clear within 5 seconds of release/expiry/connection loss | Observe the physical display while recording the control lease and harness capture, including thinking gaps between commands. Applies only to qualified indicator modes. |

The indicator starts with the first admitted command and persists while that
client owns the target, including pauses between observations and input.
The broker's 60-second idle ownership lease, explicit release, task completion
or failure, disconnect, and helper failure bound this lifetime. A 500-millisecond
helper heartbeat renews its three-second target lease across command boundaries;
returning a healthy command result does not clear the indicator. Qualification
must demonstrate both visibility during a thinking gap and cleanup after each
ownership-ending event.
Measure the intended 72 BPM pulse on the physical display with a stated timing
uncertainty and check the exact text; test reduced-motion static indication
separately. A successful helper heartbeat is readiness evidence, not a
measurement of the visible pulse.

The five-second clear target assumes a responsive AppKit renderer. A frozen UI
thread cannot currently promise visual cleanup within that interval; qualify
and report that failure mode separately. Helper readiness loss must still
revoke input. Helper-backed source now checks an absolute one-second permit
at the native writer, using its own monotonic challenge and current session /
display binding. Owned synthetic broker-suspension tests demonstrate expiry
without a running broker event loop when the native writer remains responsive.
They do not qualify a real desktop. Held-state neutralization may follow expiry;
an already blocked native write or suspended native process is outside that
proof. Record those limits and UI-hang results explicitly. Neither synthetic
expiry nor successful source checks establish this production SLO.

An eligible capture has valid arguments and an admitted session for a supported
combination. Preconditions are checked before admission. A network or desktop
failure after admission still counts as a failed capture; it must not be removed
from the denominator. Rejected startup/preflight attempts are recorded
separately with reasons. Report results per supported combination so aggregation
cannot conceal a broken mode.

Capture correctness is a promotion invariant: **zero accepted stale, partial,
wrong-host, or incorrectly scaled observations** in qualification. Input sent
to the wrong host or mapped using obsolete geometry also blocks promotion.
For the human indicator, **zero indicator pixels in qualified harness images**
is required. Rejecting an unprovable frame preserves correctness but consumes
the capture reliability budget.

## Qualification and evidence

Run at least **100 changing-marker captures per supported
controller/target/capture-mode combination**, with unique marker values and a
complete-frame check. Frontend adapters additionally need an end-to-end
observation/input/observation journey and lifecycle receipt; transport
benchmarks need not be duplicated for every frontend.

Include partial or missing framebuffer updates, reconnect, resize, sleep/wake,
occupied queues, permission denial, authentication failure, cancellation, and
uncertain input outcomes. Test keyboard/button release on abort. Perform 100
connect/disconnect/cancel cycles and prove that the owned process set does not
grow. Indicator evidence must pair physical visibility with full harness
captures during the pulse, including display reconfiguration and client death.
Verify the host's human Stop control revokes readiness during a thinking gap,
prevents successor input, and stays latched until the human allows activity.

Use monotonic timestamps at the client boundary. Receipts contain release/source
identity, pseudonymous test-target identity, OS/architecture, frontend version,
mode, operation, elapsed time, outcome, marker identity, and lifecycle counts.
Keep passwords, tokens, real desktop contents, and raw conversations out of
public evidence. Offline results, historical observations, and live receipts
must be labeled separately.

Publish an initial seven-day baseline and its denominators on October 26.
If qualification starts too late for seven days of measurements, publish the
actual interval, pending combinations and a dated baseline reforecast.
Until a 28-day interval exists, report the available interval without implying
28-day attainment. The product lead reviews targets after the baseline;
changes are dated and explain the user impact. Good events divided by eligible
attempts follows the [Google SRE measurement approach](https://sre.google/workbook/implementing-slos/).

## Promotion and response

The capture reliability error budget is **1% of eligible attempts** over 28
days. Exhausting it pauses feature promotion on the affected combination and
prioritizes remediation. Correctness, target ownership, credential isolation,
or indicator exclusion failures block promotion immediately, regardless of
the remaining budget. Repairs need a new qualification receipt. Broader
platform support requires new matrix entries and evidence.

Internal maintainer response objectives use **Monday–Friday,
09:00–17:00 America/New_York**:

| Priority | Examples | Acknowledge | Next outcome |
| --- | --- | --- | --- |
| Urgent | Wrong-host input, accepted stale frames, credential exposure, uncontrolled process growth | Within 4 business hours | Contain or disable the affected product path within 1 business day. |
| High | A supported installation or control journey is unusable | Within 1 business day | Diagnosis and mitigation or dated reforecast within 3 business days. |
| Normal | Nonblocking defects and improvements | Within 3 business days | Disposition at the next weekly planning review. |

Acknowledgement is a timestamped maintainer response, not an automated issue
receipt. Public reports are handled best effort and do not inherit Lab response
objectives. Track acknowledgement timestamps and containment issues separately.
Linear's native SLA measures issue completion and requires Business or
Enterprise; applying it replaces an issue's due date. Use due dates and an
explicit response ledger until that workspace capability is confirmed.
[Linear SLA documentation](https://linear.app/docs/sla)
