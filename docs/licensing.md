# Licensing and corresponding source

Fruitctl keeps the original [MIT copyright and grant](../LICENSE) for Claude
KVM authored source. New VNC controller releases distribute the combined
executable under **GPL-3.0-or-later**, retaining every component's notices. The
independent FruitctlHost app, JavaScript proxy, installer and documentation
retain MIT licensing. FruitctlHost uses Apple system frameworks and does not
link LibVNCClient, OpenSSL or Swift Argument Parser. The
[component inventory](../LICENSES/dependency-provenance.json) and
[third-party notices](../THIRD_PARTY_NOTICES.md) describe these boundaries.

## Why the native distribution uses GPLv3

The client statically links LibVNCClient, whose license permits GPL version 2 or
later. LibVNC's own [linking guidance](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/README.md#frequently-asked-questions)
covers both its server and client libraries. The new baseline uses OpenSSL
3.5.9 under Apache-2.0. Apache-2.0 is compatible with GPLv3, while GPLv2-only
does not provide that combination; LibVNC's later-version permission supplies
the GPLv3 route. See the [ASF compatibility statement](https://www.apache.org/licenses/GPL-compatibility.html)
and [OpenSSL's license](https://openssl-library.org/source/license/index.html).
Swift Argument Parser's complete Apache license includes its Swift runtime
exception, and that text is retained unchanged.

This distribution choice leaves original permissive grants and attribution
intact. It does not label every independent repository file GPL. Changing from
static to dynamic LibVNC linking would not remove the library's stated linking
requirements.

## Pinned source baseline

The inventory pins LibVNCClient 0.9.15 at
`9b54b1ec32731bd23158ca014dc18014db4194c3`, OpenSSL 3.5.9 at
`45e844fa2a14ec92d146bd8f5778ac130b6625fb`, and the existing Swift Argument
Parser revision. Archive bytes and license texts were downloaded and hashed.

Three upstream client fixes belong in the new LibVNC source baseline:

- `009008e2f4d5a54dd71f422070df3af7b3dbc931`: UltraZip subrectangle bounds.
- `5b270544b85233668b98161323297d418a8f5fd1`: Tight gradient width bounds.
- `540332be3e0acc566fa64da6f1b4680c72c724dd`: Tight decompressed-row bounds.

The manifest associates each fix with its advisory, touched files and downloaded
patch hash. A release records the actual patch application and resulting source
tree. These are selected inputs, not a native qualification result. The separate
LibVNC HTTP-server advisory concerns a server component excluded from this
client-only build.

The existing `vendor/libvnc/prebuilt/libvncclient.a` has a checksum and a 0.9.15
version marker, but these do not establish its exact corresponding source.
Historical signed daemon releases and their receipts stay byte intact. The new
baseline must not be presented as their corresponding source without build
evidence matching those artifacts.

## Source package required with a native release

The release source packager consumes `LICENSES/dependency-provenance.json`.
Each linked VNC controller release must retain these contents beside its binary.
An aggregate release may include the separate host app in the same archive;
its component license remains MIT.

1. An archive of the exact Fruitctl source revision and native modules.
2. Exact dependency source trees, applied patches, original copyright/license
   files and any applicable NOTICE files.
3. Scripts used to compile and install the executable, declared build options,
   dependency versions and toolchain versions.
4. A manifest binding source revision, original/adapted patch hashes, build
   configuration, binary SHA-256 and corresponding-source archive SHA-256.
5. Root MIT attribution, the combined native GPL license, component license
   texts and third-party notices.

Publish this matching source archive in the same immutable GitHub Release as the
binary, with equivalent download access. This uses source accompaniment rather
than a written source offer. Source archives include the preferred editable
forms, not only generated headers or prebuilt archives. Apple system frameworks
normally supplied by macOS are outside the redistributed dependency sources.
The relevant terms are in [GPLv3 sections 1 and 6](../LICENSES/GPL-3.0-or-later.txt).

For an npm-containing package, include the exact notices for its distributed
runtime dependencies. `LICENSES/npm-dependencies.json` binds them to the lock's
dependency entries. Regenerate with `python3 LICENSES/refresh-npm-notices.py`
after changing dependencies; package archives are integrity-checked and no
package scripts execute. A wrapper-only package need not copy notices for
dependencies it does not contain.

Fruitctl runtime archives also aggregate a separate Node.js 24.21.0 executable.
Its [pinned inventory](../LICENSES/node-runtime-provenance.json) records official
archive checksums, executable hashes and a matching Node source archive. Preserve
the [complete upstream Node license](../LICENSES/Node-24.21.0-LICENSE.txt), which
includes bundled dependency terms, with every runtime archive. Only `bin/node`
is copied; npm and Corepack are excluded. The matching official Node source
archive accompanies runtime releases under Fruitctl's publication policy. This
source-delivery policy is separate from the native executable's GPL obligations.
See the [official Node release](https://nodejs.org/en/blog/release/v24.21.0) and
[checksums](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt).

## Release review

Verify all source and notice hashes, confirm patched native inputs match the
build receipt, and inspect the extracted binary and corresponding-source
archives. Confirm source and license links work without authentication. Keep
the release's dependency inventory with its artifacts so a later pin update
cannot rewrite what the earlier release contained.
