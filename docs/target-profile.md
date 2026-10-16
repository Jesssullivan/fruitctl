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

## Not covered

- The probe does not read another account's preferences, and it has no sudo.
- If macOS lets the domain be read but hides a protected key, that key reads
  as unset, which is the macOS default. For Reduce Transparency the default is
  a deviation, so this cannot hide a warning.
- macOS 27 has not been sampled for these keys yet.
