# Explicit Host launch developer utility

`launch_host_once.m` is a source developer qualification tool for an already
reviewed Fruitctl Host bundle on macOS 15+ Apple silicon. It is absent from
runtime release bundles and is not called by the installer or broker. The
broker's `--stdio` shim continues to attach to a resident app.

The helper reads a private runtime request, so changing the transaction, app
installation or previously observed PID does not require editing its source.
It never terminates an instance, enables capture, grants permission or supplies
arguments to Host. It refuses a registered running `com.xoxd.fruitctl.host`
instance. The caller owns any preceding attended shutdown and fresh process
checks; a bundle registry census is not a kernel census.

## Build and pure checks

Select installed Apple clang, a canonical installed macOS SDK and an existing
Python 3.9+ interpreter explicitly. Do not use the macOS `/usr/bin/python3`
installer stub. Use an exclusive output directory under an existing owned
canonical parent, and the fleet's existing build placement/custody rules.

```sh
just build-host-launcher \
  /absolute/owned/new-launcher-build \
  /absolute/verified/existing/python3 \
  /absolute/verified/Apple/clang \
  /absolute/canonical/MacOSX.sdk
```

The wrapper runs compiler version metadata, syntax (10 seconds), one link
(20 seconds) and `--offline-self-test` (2 seconds), within a cooperative
37-second productive and 3-second cleanup budget after Python starts. It
records input/output hashes, direct child metadata and dedicated-group closure.
Output limits are checked after capture, not hard memory bounds. If ownership,
reaping or descendant closure cannot be established, it reports failure and
retains the recorded pending scope for its caller; it never signals a foreign
process or assumes a compiler's exit closes its descendants. The caller must
supervise the invocation, including interpreter startup and any pending scope.
Fleet bench custody belongs to the existing operator rail, not this public tool.

The offline branch executes the real request and completion predicates using
value fixtures before any UID, file, process, console, app registry or workspace
access. It covers multiple paths, spaces, runtime previous PIDs, PID reuse,
strict JSON types, bounds, expiry and unexpected fields. Compilation and these
pure checks do not qualify an actual launch, TCC, capture or the purple overlay.

## Runtime request

The caller must construct the request from its **operator-configured target
and verified artifact**, never from an MCP tool's target/path arguments. Before
dispatch, verify the complete payload and expected signing/designated identity
and exclude other writers. `sourceBindingSha256` and `authoritySha256` below
are correlation references to that caller's records; this helper checks their
format and does not authenticate those records or perform signature verification.

Create a fresh canonical directory owned by the current user with mode 0700,
and a regular, single-link mode-0600 `launch-request.json`. Every field below
is required; unknown fields are rejected. This abbreviated example replaces
each placeholder with the actual lowercase 64-digit SHA-256/nonce value and
fresh **target-clock** times before use:

```json
{
  "schema": "fruitctl.launchservices-native-request.v2",
  "appPath": "/Applications/FruitctlHost.app",
  "executablePath": "/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost",
  "bundleIdentifier": "com.xoxd.fruitctl.host",
  "arguments": [],
  "oldPid": null,
  "nonce": "<64 lowercase hex digits>",
  "sourceBindingSha256": "<64 lowercase hex digits>",
  "authoritySha256": "<64 lowercase hex digits>",
  "issuedAtUnix": 100,
  "expiresAtUnix": 108
}
```

`appPath` must be an absolute canonical existing `.app` directory, and
`executablePath` must be its exact `Contents/MacOS/FruitctlHost` executable.
The bundle's identifier and declared executable must match. Spaces and Unicode
names are supported; dot/parent/empty components, control characters and
symlinks are refused. App/executable ownership must be the current user or root,
with no group/other write bit. These metadata checks do not prove signed bytes
or prevent a simultaneous writer; the caller's artifact checks remain required.

`oldPid` is either null (no previously excluded PID) or a positive integral PID
greater than one. It is an exclusion supplied by the caller, not proof of
process ownership or permission to terminate anything. A callback with that
same numeric PID is conservatively unknown even if the number may have been
reused. Post-launch kernel birth/image/user checks still establish real custody.
Booleans and numeric strings are not numbers in this protocol.

Request times must be finite, positive, ordered, already issued and not expired;
their interval is at most 10 seconds. Different machine clocks are not assumed
synchronized. The native callback deadline uses monotonic elapsed time and is
at most 8 seconds, shortened to the request's remaining lifetime.

Only an explicitly authorized attended launch uses:

```sh
/absolute/owned/new-launcher-build/fruitctl-host-launch-once \
  --request /absolute/owned/new-transaction/launch-request.json
```

The current user must also own the console session. The request directory is
held by an open descriptor; the request is opened without following symlinks,
and descriptor/named identity is renewed. The helper consumes the request once
into exclusive `native-launch-consumed.json` before its single NSWorkspace
call. Host always receives an empty argument array and fixed minimal launch
environment. Existing consumption is refused, including after an earlier error.

The helper sets new-instance=true, substitution=false, prompts=false and
activation=false explicitly. Apple's API delivers its callback on a concurrent
queue; the helper serializes it and its timer on the main queue. Exact callback
bundle/executable paths, bundle identifier, integral PID, non-terminated state
and launch date are required. `native-launch-result.json` is exclusive and
records a nonce, status, callback metadata and `retryAllowed:false`. Errors and
timeouts remain unknown: the app may exist even if completion was rejected.
Never automatically replay the request or switch to an opener. No callback
metadata alone proves payload signature, process custody, health, permission or
capture readiness. Renew kernel identity and app health independently before
any later activity. `promptsUserIfNeeded=false` controls this API's UI; it does
not disable prompts that the launched app or macOS may independently present.

Apple's primary API contracts: [openApplication](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:)),
[new instance](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/createsnewapplicationinstance),
[substitution](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/allowsrunningapplicationsubstitution),
[prompts](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/promptsuserifneeded),
[running app metadata](https://developer.apple.com/documentation/appkit/nsrunningapplication),
and [launch date](https://developer.apple.com/documentation/appkit/nsrunningapplication/launchdate).
