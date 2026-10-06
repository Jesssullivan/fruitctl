# Third-party notices

Fruitctl preserves the [MIT origin notice](LICENSE) of Claude KVM by Rıza Emre
ARAS. The root license covers authored source under that grant; it does not
replace the licenses of linked libraries or describe the complete native binary.
New Fruitctl VNC controller distributions combine that source with LibVNCClient
and Apache-licensed dependencies under **GPL-3.0-or-later**. The independent
FruitctlHost app, proxy, installer and documentation retain their stated licenses.

## Native components

| Component | Pinned source | License and retained notice |
|---|---|---|
| Claude KVM authored source | ARAS proxy `0b4669ee`, native `51a8cb0c` | [MIT copyright and grant](LICENSE) |
| LibVNCClient 0.9.15 | `9b54b1ec32731bd23158ca014dc18014db4194c3`, with recorded client fixes | [GPL-2.0-or-later](LICENSES/GPL-2.0-or-later.txt), [authors](LICENSES/LibVNC-0.9.15-AUTHORS.txt) |
| OpenSSL 3.5.9 | `45e844fa2a14ec92d146bd8f5778ac130b6625fb` | [Apache-2.0](LICENSES/OpenSSL-3.5.9-Apache-2.0.txt) |
| Swift Argument Parser | `c8ed701b513cf5177118a175d85fbbbcd707ab41` | [Apache-2.0 with Swift runtime exception](LICENSES/Swift-Argument-Parser-Apache-2.0.txt) |
| FruitctlHost authored source | `FruitctlHost/`, separate application target | [Root MIT grant](LICENSE); Apple system frameworks only |

The [GPL-3.0-or-later text](LICENSES/GPL-3.0-or-later.txt) accompanies the
combined VNC controller work. Upstream file notices, including the permissive notices
embedded in individual LibVNC headers, remain in the corresponding source.
Apple OS frameworks are not redistributed. Runtime archives separately bundle
the unchanged Node.js executable with its complete aggregate upstream license.

## Bundled runtime

Node.js **24.21.0** is pinned to upstream revision
`955266bfdd854cd280dffd47548673914484e4c0`. The
[runtime inventory](LICENSES/node-runtime-provenance.json) records the official
Darwin arm64 and Linux x64/arm64 archive checksums, independently downloaded
archive and executable hashes, and the matching official source archive.
The [full Node license](LICENSES/Node-24.21.0-LICENSE.txt) retains the MIT grant
for Node authored code and all included dependency terms. The inventory uses
`LicenseRef-Nodejs-24.21.0` for that aggregate, rather than reducing the entire
executable to its authored-code MIT grant.

Fruitctl runtime packaging copies only `bin/node` from the Node release archive;
it does not redistribute that archive's npm or Corepack installations. Node is a
separate executable in the distribution. It does not replace the native GPL
license or the JavaScript proxy's permissive licenses. Its upstream
[release checksums](LICENSES/Node-24.21.0-SHASUMS256.txt) and
[checksum signature](LICENSES/Node-24.21.0-SHASUMS256.txt.asc) are retained;
this inventory records hash verification and does not claim local verification
of that signature. Platform release qualification is separate from these source
and notice checks.

[Dependency provenance](LICENSES/dependency-provenance.json) records source
archive hashes, patch revisions and the distinction between historical opaque
archives and the new source baseline. [Licensing and source delivery](docs/licensing.md)
defines release contents.

## Locked npm dependencies

These are exact license/notice files copied from npm archives whose bytes matched
`package-lock.json` integrity values. Development entries support builds and tests;
release packages retain notices for the runtime packages they actually distribute.
The [npm inventory](LICENSES/npm-dependencies.json) records archive URLs, integrity,
SHA-256 and notice hashes. Regenerate after dependency changes with
`python3 LICENSES/refresh-npm-notices.py`; this command does not install or execute
packages.

| Package | Version | Use | SPDX license | Exact upstream notice |
|---|---|---|---|---|
| `@hono/node-server` | 1.19.17 | runtime | MIT | [notice](LICENSES/npm/_hono_node-server@1.19.17/LICENSE) |
| `@modelcontextprotocol/sdk` | 1.32.1 | runtime | MIT | [notice](LICENSES/npm/_modelcontextprotocol_sdk@1.32.1/LICENSE) |
| `@types/node` | 25.2.3 | development | MIT | [notice](LICENSES/npm/_types_node@25.2.3/LICENSE) |
| `accepts` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/accepts@2.0.0/LICENSE) |
| `ajv` | 8.18.0 | runtime | MIT | [notice](LICENSES/npm/ajv@8.18.0/LICENSE) |
| `ajv-formats` | 3.0.1 | runtime | MIT | [notice](LICENSES/npm/ajv-formats@3.0.1/LICENSE) |
| `body-parser` | 2.3.0 | runtime | MIT | [notice](LICENSES/npm/body-parser@2.3.0/LICENSE) |
| `content-type` | 2.1.0 | runtime | MIT | [notice](LICENSES/npm/content-type@2.1.0/LICENSE) |
| `bytes` | 3.1.2 | runtime | MIT | [notice](LICENSES/npm/bytes@3.1.2/LICENSE) |
| `call-bind-apply-helpers` | 1.0.2 | runtime | MIT | [notice](LICENSES/npm/call-bind-apply-helpers@1.0.2/LICENSE) |
| `call-bound` | 1.0.4 | runtime | MIT | [notice](LICENSES/npm/call-bound@1.0.4/LICENSE) |
| `content-disposition` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/content-disposition@1.0.1/LICENSE) |
| `content-type` | 1.0.5 | runtime | MIT | [notice](LICENSES/npm/content-type@1.0.5/LICENSE) |
| `cookie` | 0.7.2 | runtime | MIT | [notice](LICENSES/npm/cookie@0.7.2/LICENSE) |
| `cookie-signature` | 1.2.2 | runtime | MIT | [notice](LICENSES/npm/cookie-signature@1.2.2/LICENSE) |
| `cors` | 2.8.6 | runtime | MIT | [notice](LICENSES/npm/cors@2.8.6/LICENSE) |
| `cross-spawn` | 7.0.6 | runtime | MIT | [notice](LICENSES/npm/cross-spawn@7.0.6/LICENSE) |
| `debug` | 4.4.3 | runtime | MIT | [notice](LICENSES/npm/debug@4.4.3/LICENSE) |
| `depd` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/depd@2.0.0/LICENSE) |
| `dunder-proto` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/dunder-proto@1.0.1/LICENSE) |
| `ee-first` | 1.1.1 | runtime | MIT | [notice](LICENSES/npm/ee-first@1.1.1/LICENSE) |
| `encodeurl` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/encodeurl@2.0.0/LICENSE) |
| `es-define-property` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/es-define-property@1.0.1/LICENSE) |
| `es-errors` | 1.3.0 | runtime | MIT | [notice](LICENSES/npm/es-errors@1.3.0/LICENSE) |
| `es-object-atoms` | 1.1.2 | runtime | MIT | [notice](LICENSES/npm/es-object-atoms@1.1.2/LICENSE) |
| `escape-html` | 1.0.3 | runtime | MIT | [notice](LICENSES/npm/escape-html@1.0.3/LICENSE) |
| `etag` | 1.8.1 | runtime | MIT | [notice](LICENSES/npm/etag@1.8.1/LICENSE) |
| `eventsource` | 3.0.7 | runtime | MIT | [notice](LICENSES/npm/eventsource@3.0.7/LICENSE) |
| `eventsource-parser` | 3.0.6 | runtime | MIT | [notice](LICENSES/npm/eventsource-parser@3.0.6/LICENSE) |
| `express` | 5.2.1 | runtime | MIT | [notice](LICENSES/npm/express@5.2.1/LICENSE) |
| `express-rate-limit` | 8.5.2 | runtime | MIT | [notice](LICENSES/npm/express-rate-limit@8.5.2/license.md) |
| `fast-deep-equal` | 3.1.3 | runtime | MIT | [notice](LICENSES/npm/fast-deep-equal@3.1.3/LICENSE) |
| `fast-uri` | 3.1.8 | runtime | BSD-3-Clause | [notice](LICENSES/npm/fast-uri@3.1.8/LICENSE) |
| `finalhandler` | 2.1.1 | runtime | MIT | [notice](LICENSES/npm/finalhandler@2.1.1/LICENSE) |
| `forwarded` | 0.2.0 | runtime | MIT | [notice](LICENSES/npm/forwarded@0.2.0/LICENSE) |
| `fresh` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/fresh@2.0.0/LICENSE) |
| `function-bind` | 1.1.2 | runtime | MIT | [notice](LICENSES/npm/function-bind@1.1.2/LICENSE) |
| `get-intrinsic` | 1.3.0 | runtime | MIT | [notice](LICENSES/npm/get-intrinsic@1.3.0/LICENSE) |
| `get-proto` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/get-proto@1.0.1/LICENSE) |
| `gopd` | 1.2.0 | runtime | MIT | [notice](LICENSES/npm/gopd@1.2.0/LICENSE) |
| `has-symbols` | 1.1.0 | runtime | MIT | [notice](LICENSES/npm/has-symbols@1.1.0/LICENSE) |
| `hasown` | 2.0.4 | runtime | MIT | [notice](LICENSES/npm/hasown@2.0.4/LICENSE) |
| `hono` | 4.13.7 | runtime | MIT | [notice](LICENSES/npm/hono@4.13.7/LICENSE) |
| `http-errors` | 2.0.1 | runtime | MIT | [notice](LICENSES/npm/http-errors@2.0.1/LICENSE) |
| `iconv-lite` | 0.7.2 | runtime | MIT | [notice](LICENSES/npm/iconv-lite@0.7.2/LICENSE) |
| `inherits` | 2.0.4 | runtime | ISC | [notice](LICENSES/npm/inherits@2.0.4/LICENSE) |
| `ip-address` | 10.7.3 | runtime | MIT | [notice](LICENSES/npm/ip-address@10.7.3/LICENSE) |
| `ipaddr.js` | 1.9.1 | runtime | MIT | [notice](LICENSES/npm/ipaddr.js@1.9.1/LICENSE) |
| `is-promise` | 4.0.0 | runtime | MIT | [notice](LICENSES/npm/is-promise@4.0.0/LICENSE) |
| `isexe` | 2.0.0 | runtime | ISC | [notice](LICENSES/npm/isexe@2.0.0/LICENSE) |
| `jose` | 6.1.3 | runtime | MIT | [notice](LICENSES/npm/jose@6.1.3/LICENSE.md) |
| `json-schema-traverse` | 1.0.0 | runtime | MIT | [notice](LICENSES/npm/json-schema-traverse@1.0.0/LICENSE) |
| `json-schema-typed` | 8.0.2 | runtime | BSD-2-Clause | [notice](LICENSES/npm/json-schema-typed@8.0.2/LICENSE.md) |
| `math-intrinsics` | 1.1.0 | runtime | MIT | [notice](LICENSES/npm/math-intrinsics@1.1.0/LICENSE) |
| `media-typer` | 1.1.0 | runtime | MIT | [notice](LICENSES/npm/media-typer@1.1.0/LICENSE) |
| `merge-descriptors` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/merge-descriptors@2.0.0/license) |
| `mime-db` | 1.54.0 | runtime | MIT | [notice](LICENSES/npm/mime-db@1.54.0/LICENSE) |
| `mime-types` | 3.0.2 | runtime | MIT | [notice](LICENSES/npm/mime-types@3.0.2/LICENSE) |
| `ms` | 2.1.3 | runtime | MIT | [notice](LICENSES/npm/ms@2.1.3/license.md) |
| `negotiator` | 1.0.0 | runtime | MIT | [notice](LICENSES/npm/negotiator@1.0.0/LICENSE) |
| `object-assign` | 4.1.1 | runtime | MIT | [notice](LICENSES/npm/object-assign@4.1.1/license) |
| `object-inspect` | 1.13.4 | runtime | MIT | [notice](LICENSES/npm/object-inspect@1.13.4/LICENSE) |
| `on-finished` | 2.4.1 | runtime | MIT | [notice](LICENSES/npm/on-finished@2.4.1/LICENSE) |
| `once` | 1.4.0 | runtime | ISC | [notice](LICENSES/npm/once@1.4.0/LICENSE) |
| `parseurl` | 1.3.3 | runtime | MIT | [notice](LICENSES/npm/parseurl@1.3.3/LICENSE) |
| `path-key` | 3.1.1 | runtime | MIT | [notice](LICENSES/npm/path-key@3.1.1/license) |
| `path-to-regexp` | 8.4.2 | runtime | MIT | [notice](LICENSES/npm/path-to-regexp@8.4.2/LICENSE) |
| `pkce-challenge` | 5.0.1 | runtime | MIT | [notice](LICENSES/npm/pkce-challenge@5.0.1/LICENSE) |
| `proxy-addr` | 2.0.8 | runtime | MIT | [notice](LICENSES/npm/proxy-addr@2.0.8/LICENSE) |
| `qs` | 6.16.0 | runtime | BSD-3-Clause | [notice](LICENSES/npm/qs@6.16.0/LICENSE.md) |
| `range-parser` | 1.2.1 | runtime | MIT | [notice](LICENSES/npm/range-parser@1.2.1/LICENSE) |
| `raw-body` | 3.0.2 | runtime | MIT | [notice](LICENSES/npm/raw-body@3.0.2/LICENSE) |
| `require-from-string` | 2.0.2 | runtime | MIT | [notice](LICENSES/npm/require-from-string@2.0.2/license) |
| `router` | 2.2.0 | runtime | MIT | [notice](LICENSES/npm/router@2.2.0/LICENSE) |
| `safer-buffer` | 2.1.2 | runtime | MIT | [notice](LICENSES/npm/safer-buffer@2.1.2/LICENSE) |
| `send` | 1.2.1 | runtime | MIT | [notice](LICENSES/npm/send@1.2.1/LICENSE) |
| `serve-static` | 2.2.1 | runtime | MIT | [notice](LICENSES/npm/serve-static@2.2.1/LICENSE) |
| `setprototypeof` | 1.2.0 | runtime | ISC | [notice](LICENSES/npm/setprototypeof@1.2.0/LICENSE) |
| `shebang-command` | 2.0.0 | runtime | MIT | [notice](LICENSES/npm/shebang-command@2.0.0/license) |
| `shebang-regex` | 3.0.0 | runtime | MIT | [notice](LICENSES/npm/shebang-regex@3.0.0/license) |
| `side-channel` | 1.1.1 | runtime | MIT | [notice](LICENSES/npm/side-channel@1.1.1/LICENSE) |
| `side-channel-list` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/side-channel-list@1.0.1/LICENSE) |
| `side-channel-map` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/side-channel-map@1.0.1/LICENSE) |
| `side-channel-weakmap` | 1.0.2 | runtime | MIT | [notice](LICENSES/npm/side-channel-weakmap@1.0.2/LICENSE) |
| `statuses` | 2.0.2 | runtime | MIT | [notice](LICENSES/npm/statuses@2.0.2/LICENSE) |
| `toidentifier` | 1.0.1 | runtime | MIT | [notice](LICENSES/npm/toidentifier@1.0.1/LICENSE) |
| `type-is` | 2.1.0 | runtime | MIT | [notice](LICENSES/npm/type-is@2.1.0/LICENSE) |
| `content-type` | 2.1.0 | runtime | MIT | [notice](LICENSES/npm/content-type@2.1.0/LICENSE) |
| `undici-types` | 7.16.0 | development | MIT | [notice](LICENSES/npm/undici-types@7.16.0/LICENSE) |
| `unpipe` | 1.0.0 | runtime | MIT | [notice](LICENSES/npm/unpipe@1.0.0/LICENSE) |
| `vary` | 1.1.2 | runtime | MIT | [notice](LICENSES/npm/vary@1.1.2/LICENSE) |
| `which` | 2.0.2 | runtime | ISC | [notice](LICENSES/npm/which@2.0.2/LICENSE) |
| `wrappy` | 1.0.2 | runtime | ISC | [notice](LICENSES/npm/wrappy@1.0.2/LICENSE) |
| `zod` | 4.3.6 | runtime | MIT | [notice](LICENSES/npm/zod@4.3.6/LICENSE) |
| `zod-to-json-schema` | 3.25.1 | runtime | ISC | [notice](LICENSES/npm/zod-to-json-schema@3.25.1/LICENSE) |
