# macOS permissions

Install the Fruitctl runtime and agent adapter with the [installation guide](install.md).
The target owner enables [Apple Screen Sharing](https://support.apple.com/guide/mac-help/mh11848/mac)
and supplies access through the controller's credential provider. This VNC route
does not capture the controller's local screen or require Fruitctl Host.

The optional Fruitctl Host adds target-side capture and the purple human
indicator. It remains outside public runtime payloads and automatic installation.
The Host steps below are an onboarding specification for a separately delivered,
qualified Host release; they do not make the current preview a Host installer.
The source targets Apple silicon macOS 15 or later. Check the
[compatibility matrix](compatibility.md) before selecting a released combination.

## Which machine needs permission?

| Component | What to configure |
| --- | --- |
| Agent adapter or Linux SSH bridge | Install the matching adapter; keep credentials on the Darwin controller. |
| Darwin VNC controller | Configure the target profile and credential provider. It receives target pixels over VNC. |
| Target's Apple Screen Sharing | The target owner enables the service and chooses permitted users. |
| Optional Fruitctl Host on the target | The target user enables capture and grants that app Screen Capture access. |

The Host source supplies images and an indicator, with no local input service.
Its permission example therefore requests no Accessibility, event-posting, input
monitoring, microphone or Full Disk Access policy. VNC input remains with the
controller and the target's Screen Sharing service.

## Unmanaged target: attended Host setup

Once a qualified Host artifact is available, the target user completes these
steps in their logged-in desktop session:

1. Install the exact signed app bundle from the Host release. Keep its bytes and
   identity intact, and launch the app normally in the target's desktop session.
2. Choose **Fruitctl → Enable capture**. If macOS requests access, enable that
   exact app in **System Settings → Privacy & Security → Screen & System Audio
   Recording**. Follow Apple's requested **Quit & Reopen** step when shown.
   [Apple's recording access guide](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)
   describes the user's setting; its title does not mean Fruitctl captures audio.
3. Start one attended capture through the configured Host attachment. A later
   direct-capture alert can require a separate choice even when the ordinary
   recording preflight is true. If access is declined or a prompt remains
   unresolved, end the attempt and return when the user is ready; do not repeat
   prompts or report capture success from preflight alone.
4. Confirm the chosen display produces complete images, the purple indication
   stays visible locally and absent from agent images, and **Fruitctl → Stop
   agent control** ends control and clears the indication. Record the exact
   release and macOS version before treating that route as qualified.

The app's capture choice and macOS permission are separate. **Disable capture**
withdraws the app's opt-in. The user can revoke macOS access in the same Privacy
settings. Stop remains in force through reconnect and wake for that running
Host session; restarting the app resets Stop, while capture opt-in, macOS
consent and a fresh controller lease remain required.

Launch the app bundle through the normal desktop application mechanism. Running
its internal executable from an SSH shell can change the privacy-responsible
process and does not establish access for the resident app. See Apple's
[responsibility-tracking guidance](https://developer.apple.com/forums/thread/125438).

## Managed target: let the user grant access

Apple's [PPPC schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml)
requires the device channel of user-approved MDM and excludes manual profile
installation and User Enrollment. For Screen Capture, PPPC cannot grant access.
`AllowStandardUserToSetSystemService` lets a standard user make the permission
choice. The user still completes the attended setup above.

The [standard-user PPPC example](permissions/fruitctl-standard-user.mobileconfig.example)
contains only that Screen Capture policy. It is a template with unresolved
identity and profile fields, not a ready-to-deploy grant. An MDM administrator
prepares it for the exact signed Host release. Read the delivered bundle's
signing identity and designated requirement without launching it:

```sh
codesign --display --verbose=4 '/absolute/path/to/FruitctlHost.app'
codesign --display --requirements - '/absolute/path/to/FruitctlHost.app'
```

Then complete the profile and attended setup:

1. Verify the release's checksum, signature, bundle ID and Developer ID team.
   The Host source uses `com.xoxd.fruitctl.host`; confirm the delivered app matches.
2. Replace every `REPLACE_WITH_` field. Copy the actual requirement expression,
   excluding the output prefix `designated =>`, into `CodeRequirement`, preserving
   its constraints and XML-escaping special characters. Match its team constraint
   to the verified release team; do not derive a weaker rule from the bundle ID.
   Assign organization-specific profile identifiers and two distinct UUIDs.
3. Validate the completed profile through the MDM owner's normal process and
   deliver it through the device channel.
4. Have the target user enable capture, make the recording choice and complete
   the attended capture/Stop check. Profile delivery is not evidence that
   permission or capture succeeded.

The example has one `ScreenCapture` entry using `Authorization`; it does not
include `Allowed` or any other service. Additional input services belong to a
separately justified input component, not this image-only Host.

Apple's [Restrictions schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.applicationaccess.yaml)
also defines `forceBypassScreenCaptureAlert` from macOS 15.1. It is an MDM
presentation policy, unavailable through manual installation or User Enrollment.
It is omitted from this least-permission example and does not supply Screen
Capture access. A management owner may evaluate it separately for a qualified
capture route; no unmanaged equivalent is supplied here.

## Signing, updates and diagnosis

Developer ID signing and [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
establish artifact identity and distribution checks. They do not grant Screen
Capture consent. Keep the bundle ID, verified team and compatible designated
requirement stable across releases, and check each new artifact against the
deployed policy. Apple's [code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
explains how a designated requirement identifies code; each subsystem makes its
own policy decision. Existing consent surviving an update must be observed on
the supported macOS version, not assumed from signature validity.

`fruitctl doctor` reports installed runtime and adapter configuration. Its
`configured` result does not test the target connection, Host consent or screen
capture. For a separately installed resident Host, distinguish these results:

| Observation | What it establishes |
| --- | --- |
| Release checksum and signature match | The artifact matches the selected release. |
| Host capture enabled | The app's local capture opt-in is on. |
| Host health reports `screen_capture_permission: true` | Ordinary permission preflight was true for that running process at that sample. |
| Fresh complete images from the configured display | The tested capture route worked for that episode. |
| Simultaneous human view, agent images and local Stop | Evidence for indicator exclusion and Stop behavior on the tested route. |

Capture refusals retain a matched request UUID, stable reason and, for supported
Apple framework failures, a bounded phase/domain/code diagnostic. Those values
can help locate a failure without exposing raw Apple error text or private
paths. A code alone is not permission status. A retired input lane remains
unavailable after a refusal; repair the known cause and establish a fresh
session rather than replaying uncertain actions.

## Persistent Content Capture: operator request checklist

Apple's [Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
is a separate VNC capability available from macOS 14.4. Apple requires permission
before adding it to the app's Xcode profile. Fruitctl has a prepared request
draft, with no submission or approval established. The public preview includes
neither this entitlement nor a signed Host distribution.

The developer-program owner can use this checklist to finish the request:

1. Confirm the team, explicit Host App ID, program membership and submitting
   Account Holder. Read the actual capability's eligibility and terms; do not
   assume a particular enterprise program or permitted distribution channel.
   Apple's [capability request process](https://developer.apple.com/help/account/capabilities/capability-requests)
   requires the Account Holder role and describes team submission.
2. Prepare the VNC rationale: the proposed Host captures a user-configured target
   display for authorized agent sessions while excluding its locally visible
   activity indicator; input stays on VNC. Describe user opt-in, local Stop,
   lease expiry and session/display-change revocation. Separate implemented
   design from physically qualified behavior. Use synthetic demonstration data,
   not private desktops, credentials or agent conversations.
3. Submit through Apple's [Persistent Content Capture request form](https://developer.apple.com/contact/request/persistent-content-capture/).
   Ask for the exact Developer ID distribution eligibility, profile instructions
   and remaining user-consent requirements. Record the actual response privately;
   this guide does not establish those terms or promise prompt-free access.
4. If approved, follow the assigned conditions for a new producer-built Host
   artifact. Verify the entitlement, authorized profile, team and designated
   requirement together, then sign, notarize and qualify that exact release.
   Apple's [managed-capability provisioning guide](https://developer.apple.com/help/account/reference/provisioning-with-managed-capabilities/)
   explains profile inclusion and distribution-specific eligibility. Consumers
   never add an entitlement to or re-sign an existing released binary.

Publishing this guide, an example or a request draft does not establish Apple
approval, MDM deployment, retained consent after an upgrade, or physical Host
acceptance. Those remain separately recorded release outcomes.
