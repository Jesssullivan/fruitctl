# Fruitctl-ready target profile

An agent sees the target through screenshots and acts through pointer and
keyboard input. macOS settings that move windows, change typed text, hide the
menu bar or add a second input owner make those actions less predictable.
The Fruitctl-ready target profile lists the settings an operator should set on
a macOS target. `fruitctl doctor --macos` reads each one and reports a
deviation as a warning with a stable code
([doctor](permissions.md#target-preflight)).

Doctor only reads. It never changes a setting, and an agent must not change one
either. The operator decides which deviations to accept for a target.

## How settings are read

The probe reads the console user's own preferences with `defaults read`. It
does so only when the SSH account is the console user, because another
account's preferences are not that user's live settings:

- SSH as a different account: every setting is `unknown` and doctor reports
  `target_profile_unverified`.
- No user at the console: the same, with a different message.
- A key that is unset in a readable domain has its macOS default value.
- A domain that cannot be read is `unknown`, never ready.

The result is `targetPreflight.targetProfile`. Each setting under `settings`
is `ready`, `deviation` or `unknown`. Every deviation also appears in
`warnings` with its code and a `setting` field.

## Settings

| Setting | Ready value | Warning code | Why it matters for agents |
| --- | --- | --- | --- |
| Stage Manager (`com.apple.WindowManager GloballyEnabled`) | Off | `stage_manager_enabled` | Stage Manager moves and shrinks windows between actions, so a coordinate from one screenshot may land on another window. |
| Spaces rearrange (`com.apple.dock mru-spaces`) | Off | `spaces_auto_rearrange_enabled` | Spaces reorder by recent use, so the Space an agent switched to may not be where it was. |
| Hot Corners (`com.apple.dock wvous-tl/tr/bl/br-corner`) | No action (0 or 1) in every corner | `hot_corner_enabled` | A pointer move into a corner starts Mission Control, Quick Note or the screen saver. The bottom-right corner defaults to Quick Note. |
| Click wallpaper to reveal desktop (`com.apple.WindowManager EnableStandardClickToShowDesktop`) | Only in Stage Manager (0) | `click_wallpaper_reveals_desktop` | A click on empty space hides every window. The default is on. |
| Menu bar (`NSGlobalDomain _HIHideMenuBar`, `AppleMenuBarVisibleInFullscreen`) | Never hidden | `menu_bar_auto_hides` | A hidden menu bar cannot be observed or clicked until the pointer reveals it. |
| Reduce Transparency (`com.apple.universalaccess reduceTransparency`) | On | `reduce_transparency_off` | Translucent sidebars and menus change with the content behind them, which makes screenshots and OCR less stable. |
| Appearance (`NSGlobalDomain AppleInterfaceStyle`) | Either | none (informational) | Reported as `light`, `dark` or `auto`. Automatic switching changes every pixel during a session. |
| Press and hold (`NSGlobalDomain ApplePressAndHoldEnabled`) | Off | `press_and_hold_enabled` | A held key opens the accent picker instead of repeating. |
| Smart quotes (`NSAutomaticQuoteSubstitutionEnabled`) | Off | `smart_quotes_enabled` | Typed straight quotes are replaced, so typed text no longer matches what was sent. |
| Smart dashes (`NSAutomaticDashSubstitutionEnabled`) | Off | `smart_dashes_enabled` | Typed hyphens are replaced. |
| Autocorrect (`NSAutomaticSpellingCorrectionEnabled`) | Off | `autocorrect_enabled` | Typed words, commands and identifiers are changed. |
| Auto-capitalise (`NSAutomaticCapitalizationEnabled`) | Off | `auto_capitalization_enabled` | The first letter of typed text is changed. |
| Double-space period (`NSAutomaticPeriodSubstitutionEnabled`) | Off | `auto_period_enabled` | Two typed spaces become a period. |
| Shake to locate (`NSGlobalDomain CGDisableCursorLocationMagnification`) | Disabled (1) | `shake_to_locate_enabled` | Fast pointer moves enlarge the cursor in screenshots. |
| Display sleep (`pmset displaysleep`) | 0 (never) | `display_sleep_enabled` | A sleeping display gives black captures. Not reported while a power assertion holds the display awake. |
| Handoff (ByHost `com.apple.coreservices.useractivityd ActivityAdvertisingAllowed`, `ActivityReceivingAllowed`) | Off | `handoff_enabled` | Nearby devices add Dock items, and Universal Clipboard can change the clipboard. |
| Input source (`com.apple.HIToolbox`) | The profile's `inputSource` | `input_source_mismatch` | Typed input is interpreted by the selected layout or input method, so the same keys can produce different characters. |
| RFB control under Remote Management (`/Library/Preferences/com.apple.RemoteManagement VNCLegacyConnectionsEnabled`) | 1, or plain Screen Sharing | `remote_management_vnc_control_disabled` | Input from third-party RFB clients was observed dropped with Remote Management on and this key 0. See [below](#remote-management-rfb-control). |
| All-local-users privileges (`com.apple.RemoteManagement ARD_AllLocalUsersPrivs`) | Control and Observe (0x02) set, Observe only (0x100) clear | `all_local_users_control_not_granted`, `all_local_users_observe_only` | Input is dropped for any user these privileges cover. |

## Remote Management RFB control

Doctor reads four system keys from `/Library/Preferences/com.apple.RemoteManagement`
and reports each under `targetPreflight.screenSharing.remoteManagementPrefs`:
`VNCLegacyConnectionsEnabled`, `ARD_AllLocalUsers`, `ARD_AllLocalUsersPrivs`
and `ScreenSharingReqPermEnabled`. Each is the value read, `absent` when the
domain was readable and the key unset, or `unknown`. Whether Remote Management
or plain Screen Sharing is active is `screenSharing.mode`, from the Remote
Management activation marker. These are system settings, read without sudo,
whoever the SSH account is.

- `remote_management_vnc_control_disabled` (`screenSharing.vncControl:
  disabled`): Remote Management is active and `VNCLegacyConnectionsEnabled` is
  0. Input from third-party RFB clients was observed dropped in this
  configuration on PZM on 2026-10-16. Causality is not isolated: a ~2.5 s
  post-auth input-ignore window, now handled by the controller's
  `--input-settle-ms`, confounded the test
  ([compatibility](compatibility.md#apple-screen-sharing-quirks-observed-2026-10-16)).
  Turning the key on also enables the legacy VNC password, which warns
  `legacy_vnc_password_enabled`. The operator decides which risk to accept.
- `all_local_users_control_not_granted` and `all_local_users_observe_only`
  (`screenSharing.allLocalUsersPrivileges: restricted`): `ARD_AllLocalUsersPrivs`
  lacks the Control and Observe bit (0x02) or has the Observe-only bit (0x100).
  When `ARD_AllLocalUsers` is on, the same value is the `remote_control_not_permitted`
  or `observe_only` failure instead, so it is not reported twice.
- Neither check applies under plain Screen Sharing (`vncControl:
  not_applicable`).
- An unreadable key, or an unknown mode, is `unknown`, never ready. Doctor
  lists `remote_management_vnc_control_unverified` in `unknowns`.

## Input source

Doctor reports the selected and enabled input sources under
`targetProfile.inputSource`. It reads `AppleCurrentKeyboardLayoutInputSourceID`,
`AppleSelectedInputSources` and `AppleEnabledInputSources` from
`com.apple.HIToolbox`. A selected input method, such as Japanese Romaji, is the
active source; its underlying layout is not.

Declare the expected source with the optional profile key `inputSource`. Use a
HIToolbox source ID such as `com.apple.keylayout.US`, an input mode ID, or an
ASCII layout name such as `U.S.`. The Home Manager option is
`targets.<profile>.inputSource` ([Home Manager](home-manager.md)). The value is
not secret.

- No `inputSource` in the profile: doctor reports the source and does not warn.
- A different selected source: `input_source_mismatch`.
- An unreadable source with `inputSource` declared: `input_source_unverified`
  in `unknowns`.

### Typing on a non-US source

`key_type` sends RFB key symbols, and the target's selected layout decides
which characters they produce. A declared `inputSource` other than
`com.apple.keylayout.US`, `com.apple.keylayout.ABC`,
`com.apple.keylayout.USExtended`, `U.S.`, `US` or `ABC` is not US-compatible.
On such a target `key_type` is refused before any key with code `-32011`,
reason `input_source_not_us`, unless paste routing is on. Return and Tab are
always keys. An undeclared source keeps the US assumption.

## Clipboard and paste routing

Clipboard text is UTF-8 when the server accepts the ExtendedClipboard
pseudo-encoding, which the controller advertises by default. Otherwise only
legacy Latin-1 cut text exists: `paste` of text that Latin-1 cannot carry is
refused before any write with `-32011` `clipboard_unicode_unsupported`, never
sent as mojibake. Profile keys (Home Manager uses the same names):

| Key | Default | Effect |
| --- | --- | --- |
| `clipboard.read` | `false` | Allows `clipboard_read`. Otherwise it is refused before admission as `clipboard_read_disabled`, and received clipboard text is never read. |
| `clipboard.maxBytes` | 16384 | Longest returned text in UTF-8 bytes; longer text is cut on a character boundary and marked `truncated`. |
| `clipboard.ttlMs` | none | `clipboard_read` refuses text older than this (`-32014` `clipboard_unavailable`). Requires `clipboard.read`. |
| `clipboard.extended` | `true` | `false` stops advertising ExtendedClipboard, leaving Latin-1 only. |
| `input.pasteUnmappable` | `false` | Paste routing for `key_type` (below). |

`clipboard_read` asks an ExtendedClipboard server for its text (`fresh: true`).
Without one it returns the last text the connection received from the server
or wrote itself, with its `age_ms`. The Darwin broker withholds the whole
value when it contains a declared secret, such as the target's VNC credential;
the result then carries `redacted: true` and no text. The journal never stores
clipboard text.

With `input.pasteUnmappable`, `key_type` types what the US keymap can type and
pastes the rest: it reads the target clipboard, sets the text, sends Cmd+V
(Ctrl+V on other servers), waits `paste_restore_ms` (default 300) and writes
the saved clipboard back, also after a failure or Stop. On a non-US source
every printable character is pasted. The result and journal record carry
`kind: "paste"`. If the current clipboard cannot be learned, `key_type` is
refused before any event as `clipboard_restore_unavailable`. `type_secret`
never uses this route.

## One input owner per Mac

Each Mac should have one remote input owner. Doctor warns
`remote_input_owner_other`, with an `owner` field, when another remote desktop
host is present:

| Owner | Exact process names |
| --- | --- |
| Chrome Remote Desktop | `remoting_me2me_host`, `ChromeRemoteDesktopHost` |
| TeamViewer | `TeamViewer`, `TeamViewer_Service`, `TeamViewer_Desktop` |
| AnyDesk | `AnyDesk` |
| Parsec | `parsecd`, only inside `Parsec.app` |
| Splashtop | `Splashtop Streamer`, `SRStreamer`, `SRServiceAgent` |
| RustDesk | `RustDesk`, `rustdesk` |
| Jump Desktop | `Jump Desktop Connect` |
| Sunshine | `Sunshine`, `sunshine` |

Names match exactly, never as substrings. Apple's own `parsecd` (CoreParsec,
Spotlight suggestions) is not Parsec. The evidence is a running process, a
power assertion holder, or a WindowServer input event that names the process.
The target filters its process list, so only matching paths reach the
controller. If the process list cannot be read, doctor reports
`remote_input_owner_unverified` in `unknowns`.

Apple Screen Sharing is reported separately as `screen_sharing_input_recent`,
because it may be Fruitctl's own session.

## Desktop-state sentinel

Before each batch that contains input (clicks, moves, scrolls, keys, typing,
paste, `type_secret`), the broker reads the target's desktop state over SSH and refuses the
batch if macOS is showing something that would block or capture that input.
Nothing is sent to the target in that case, and the lease is kept, so the
agent can retry after a human has dealt with it. A batch with no input
(`screenshot`, `health` and the other read actions) is never refused, and
only `health` waits for the probe (at most 1.5 s, within its deadline); a
batch that mixes observation and input is refused as a whole.

```json
"desktopState": { "ssh": "alex@office-desktop", "enabled": true }
```

`desktopState.ssh` is optional. Without it the sentinel uses `wake.ssh`, then
`hostHelper.sshHost`. With none of them, or with `enabled: false`, there is no
sentinel: every field is `unknown` (`reason: not_configured`) and nothing is
refused. An explicit invalid `ssh` stops the broker before it opens its socket.
The SSH account should be the console user: dialog windows and display sleep
are only readable from the console user's session, and are `unknown`
otherwise. The lock state is readable by any account.

The probe is one fixed read-only script: `stat` of `/dev/console`,
`ioreg` IOConsoleUsers, `pmset -g assertions`, a filtered `ps`, and
`osascript` reading the on-screen windows of a fixed list of dialog-owning
processes. It reads no window titles and no pixels, sends no input and never
answers a dialog. A result is cached for about 2 s; a failed probe is cached
for 10 s so an unreachable target is not re-probed per action. A probe that
does not answer within 4 s, or within half of what is left of the request's
deadline, reads as `unknown`, and the batch keeps the rest of its budget. A
screenshot reports the cached sample only while it is fresh; an older one is
`unknown` with `reason: stale`, never shown as the current state.

Health and screenshot results carry `desktop_state`:

| Field | Values | Refuses input |
| --- | --- | --- |
| `sentinel` | `ok`, or `unknown` with `reason` (`not_configured`, `pending`, `stale`, `probe_failed`, `probe_timeout`) | Never on its own |
| `locked` | `true` for the lock screen or the login window (`console: loginwindow`) | Yes, `-32015` `target_locked` |
| `display_asleep` | `true` when the main display is asleep | Yes, `display_asleep` |
| `consent_dialog` | `{ owner, kind }` for an on-screen window of a dialog owner, else `null` | Yes, `-32014` `human_consent_required` |
| `screen_saver` | `true` while ScreenSaverEngine has a window on screen | No; the first input dismisses it |
| `secure_input_holder` | Process holding Secure Input, else `null` | No; typed keys may be dropped |
| `other_input_owner` | `{ owner, evidence }` for another remote desktop host ([below](#one-input-owner-per-mac)), else `null` | No |

Any field can be `unknown`; an unknown field never refuses. When several
apply, the refusal is the lock first, then display sleep, then the dialog.
A `wake` hold starts with the lease, so the first input right after it can
still see the display asleep; take a screenshot and retry once the cache
(about 2 s) has expired.

Dialog owners and their `kind`:

| Process | `kind` | Typical dialog |
| --- | --- | --- |
| `UserNotificationCenter` | `system_alert` | Privacy (TCC) prompts raised by `tccd`, other system alerts |
| `universalAccessAuthWarn` | `accessibility_consent` | "would like to control this computer using accessibility features" |
| `SecurityAgent` | `authorization` | Administrator password, keychain access |
| `CoreServicesUIAgent` | `gatekeeper` | "downloaded from the Internet", unidentified developer |
| `SoftwareUpdateNotificationManager` | `software_update` | Install and restart countdowns |

Refusal errors carry `data.reason`; `human_consent_required` also carries
`data.owner` and `data.kind`, and `target_locked` carries `data.console`
(`locked` or `loginwindow`). `display_asleep` is the stable D28 code
([architecture](architecture.md#display-wake-hold)).

## Not covered

- The probe does not read another account's preferences, and it has no sudo.
- If macOS lets the domain be read but hides a protected key, that key reads
  as unset, which is the macOS default. For Reduce Transparency the default is
  a deviation, so this cannot hide a warning.
- macOS 27 has not been sampled for these keys yet.
