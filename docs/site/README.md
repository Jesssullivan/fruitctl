# Public documentation build and hosting

Public docs and adoption artifacts are generated from this product repository.
Run the registered `just docs-check` and `just docs-build` recipes. The builder
uses Node.js 24 and no framework or third-party dependency; output is
`build-docs/` and is not tracked.

The generated site contains the reviewed Markdown pages, `agents.md`,
`llms.txt`, `install-prompt.md`, `adoption.json`, `adoption.toon`, and
`versions.json`, `deployment.json`, and the public release schemas.
`versions.json` is a curated list of public qualification
records, not a list inferred from package versions. The canonical agent/tool/skill
truth is `integrations/adoption.json` and `integrations/agents.json`; the site
exports those inputs with immutable source links and a small release-policy
overlay. Scoped immutable runtime previews carry their passed and pending
scopes; the builder counts fully qualified product releases separately.
The build records source revision and content
hashes so a deployment can be related to the reviewed artifact.

## Hosting contract

- Canonical origin: `https://fruitctl.clients.xoxd.ai/`.
- Hosting: Cloudflare Pages Direct Upload from the public repository workflow.
- Allocated Pages project: `xoxd-ai-fruitctl`, production branch `main`.
- Actual Pages hostname: `xoxd-ai-fruitctl.pages.dev`.
- Domain association and Pages credential: separate Pages deployment surface.
- Zone CNAME: the Tinyland owner overlay's `xoxd-ai-edge` stack.
- Public audience: no login on the canonical documentation origin.

The workflow builds and validates when GitHub can start its job. Deployment occurs only on `main` or a
requested manual release when both Cloudflare secrets and the exact allocated
project variable exist. Missing configuration
produces an explicit “build only; hosting pending” summary. The workflow does not
create DNS records, allocate a Pages project, or imply a hostname is live.

Cloudflare allocated this project and accepted `fruitctl.clients.xoxd.ai` on
2026-10-05. The first reviewed production deployment succeeded on 2026-10-06
through a scoped Direct Upload fallback because GitHub Actions job startup was
unavailable; run `37401566199` had no steps. All 22 served files, including the build
manifest, matched their local SHA-256 hashes without authentication; TLS chain
and hostname checks passed. The infrastructure owner's exact one-record CNAME
apply completed at 02:23 UTC, and Pages reports the canonical custom domain
active. Canonical anonymous delivery, public DNS-over-HTTPS and hostname TLS
were verified at 02:30 UTC: all 22 files returned HTTP 200 and all 13 non-HTML
files matched exactly. Cloudflare added its JavaScript Detections script to
the nine HTML responses. The builder now emits `Cache-Control: no-transform`,
which [Cloudflare documents](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)
as preventing that injection. Complete canonical HTML hash acceptance requires
deployment of these headers; no zone security setting was changed.

`deployment.json` records allocation, Pages upload and canonical served-route
receipts separately. Update each claim only with its observed receipt.
There is no
Sites project or VNC network service on this route.

## Immutable adoption

Moving website paths help discovery. Source and skill consumers pin full commit
SHAs. Binary consumers pin exact immutable releases and verify SHA-256 hashes.
Publish a complete draft release before locking it; do not replace signed bytes
after publication. The site never presents `main` or `latest` as an immutable
vendoring reference.
