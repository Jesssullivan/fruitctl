# Release tooling

These commands produce reviewable files. The coordinator publishes releases
only after the relevant platform and installer checks pass. None of these
scripts discovers credentials, creates a signing profile, opens an application,
or publishes to GitHub.

`prepare_runtime.py --output-dir /absolute/new/stage-root` copies the declared
public runtime sources and installs production npm files directly from exact
locked archives. It runs no package scripts. `runtime-stage.json` records source
and dependency files; `npm-inputs/` retains the verified archive inputs.

`package_runtime.py --stage /absolute/stage-root/stage --stage-inventory
/absolute/stage-root/runtime-stage.json --npm-inputs /absolute/stage-root/npm-inputs
--version v0.1.0-alpha.1 --os linux --arch x64 --output-dir /absolute/assets`
verifies the entire prepared stage against those inputs, then bundles the
unchanged platform Node24.21.0 executable and complete notices. Darwin arm64,
Linux x64 and Linux arm64 have pinned Node inputs. This runtime requires an
explicit existing Darwin native controller; it does not install an unsigned
controller or bootstrap a desktop application.

`build-native.sh --output-dir /absolute/new/build --jobs 2` regenerates locked
OpenSSL and patched LibVNC inputs and builds the daemon, host app and offline
tests on Darwin arm64. An exported source snapshot needs `--source-revision
<full-commit>`; its actual native source hash is recorded separately. Native
controller linkage is GPL-3.0-or-later. The independent host app is MIT.
`--reuse-inputs /absolute/prior/build` verifies and reuses the prior task-owned
input archives, patches, source trees and read-only native inputs; it preserves
the original receipt and creates a separate result directory. No live VNC or
GUI capture test is part of this command.

`package_source.py` requires a passing native receipt, an explicit public
file/hash inventory, exact native output paths and unchanged dependency source.
It includes licenses, build/install scripts, patched LibVNC, OpenSSL, the pinned
Swift Argument Parser and Node source archive. The output links actual binary
hashes to corresponding source. A source package is required alongside any
native binary release; an old release's notarization cannot establish that link.
Receipts in the source package replace local staging paths with portable roots.
`snapshot_source.py --output /absolute/new/inventory.json` records that public
file/hash inventory from a clean Git checkout. `--allow-working-tree` is an
explicit review candidate; its dirty snapshot is never presented as a published
commit. Native source bytes must match the tested build in either case by
default.

For a package selecting only `claude-kvm-daemon`, the explicit option
`--tested-native-source-root /absolute/tested/source` permits a corrected
`FruitctlHost/README.md` in the reviewed public inventory. The complete tested
native source tree must still match the original build receipt, and its README
must also match the original Host bundle resource. Every other native input,
including code, project files, tests and other resources, must match exactly;
missing or extra native files are refused. The option refuses any selected Host
binary. It records both complete native input maps and their hashes in the
archive manifest and package receipt. The archive keeps the corrected public
README under `fruitctl/` and the tested README under
`build-evidence/tested-native-resource-docs/`, with both document hashes and the
excluded owning Host artifact recorded. The tested tree hash and original
receipt remain unchanged. This option grants no new runtime qualification.
The packager pins the initial native receipt bytes and SHA-256 for signing-chain
checks, portable archive evidence and its output receipt; replacing that input
file during packaging cannot substitute an unvalidated build.
Generated `__pycache__` trees are excluded, as in `snapshot_source.py`; they do
not become required source files or archive inputs. Authored release scripts and
license files remain required.
Copied dependency source maps are checked again before archiving, and each
binary descriptor is recorded from its validated observation without a second
read that could substitute another binary identity.
The native input manifest is pinned to its tested hash. Source-lock and
dependency metadata are pinned to the reviewed public inventory, and copied
upstream archives and patches must retain their validated hashes. The package
records the reviewed public inventory and original native manifest hashes.

The Apple rail uses `apple_distribution.py` phases in order:

1. `sign` on PZM requires the exact tested app, build receipt, an explicitly
   supplied Developer ID identity, existing keychain, expected certificate and
   team. `sign-tool` signs a private copy of the tested controller with its
   explicit stable identifier. Existing-keychain access can still prompt macOS
   approval; unattended signing is a separate admission and is not assumed.
   The current narrow app rail
   refuses embedded frameworks/plugins until their signing order is reviewed.
2. `archive` verifies signed bytes and creates a submission ZIP for transfer.
3. `notarize` on Neo requires that ZIP, its archive receipt and an existing
   operator-established keychain profile or explicit existing ASC material
   directory. A real Apple `Accepted` response and
   submission ID are required; failed submissions are not retried automatically.
4. `staple` on PZM requires the unchanged signed app and complete receipt chain,
   staples the actual accepted ticket and verifies the final signature.

The source packager accepts a matching staple receipt when signing changed
the app's executable bytes, or `--tool-sign-receipt` for the receipt-bound private
controller copy. The historical pinned signing rail remains intact.
Signing and notarization do not grant privacy permissions or prove capture
exclusion, input mapping, product SLOs or frontend compatibility.

`write_manifest.py` emits `fruitctl-release.json` and `SHA256SUMS` from actual
package receipts. `verify-release.py MANIFEST --assets-dir /absolute/assets`
checks exact canonical URLs, asset hashes, safe tar entries, installer files
and pinned Node bytes/notices. Its result is structural verification. Installer
execution, Linux/Darwin runtime checks and desktop qualification have their own
evidence; the installer fails explicitly when no qualifying release exists.
