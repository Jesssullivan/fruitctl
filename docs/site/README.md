# Public documentation build and hosting

Public docs and adoption artifacts are generated from this product repository.
Run the registered `just docs-check` and `just docs-build` recipes. The builder
uses Node.js 24 and no framework or third-party dependency; output is
`build-docs/` and is not tracked.

The generated site contains the reviewed Markdown pages, `agents.md`,
`llms.txt`, `install-prompt.md`, `adoption.json`, `adoption.toon`, and
`versions.json`, and `deployment.json`. `versions.json` is a curated list of public qualification
records, not a list inferred from package versions. The canonical agent/tool/skill
truth is `integrations/adoption.json` and `integrations/agents.json`; the site
exports those inputs with immutable source links and a small release-policy
overlay. An empty release list is deliberate
until a verified release exists. The build records source revision and content
hashes so a deployment can be related to the reviewed artifact.

## Hosting contract

- Canonical origin: `https://fruitctl.clients.xoxd.ai/`.
- Hosting: Cloudflare Pages Direct Upload from the public repository workflow.
- Allocated Pages project: `xoxd-ai-fruitctl`, production branch `main`.
- Actual Pages hostname: `xoxd-ai-fruitctl.pages.dev`.
- Domain association and Pages credential: separate Pages deployment surface.
- Zone CNAME: the Tinyland owner overlay's `xoxd-ai-edge` stack.
- Public audience: no login on the canonical documentation origin.

The workflow always builds and validates. Deployment occurs only on `main` or a
requested manual release when both Cloudflare secrets and the exact allocated
project variable exist. Missing configuration
produces an explicit “build only; hosting pending” summary. The workflow does not
create DNS records, allocate a Pages project, or imply a hostname is live.

Cloudflare allocated this project and accepted `fruitctl.clients.xoxd.ai` on
2026-10-05. The association is pending with “CNAME record not set”; no deployment
has been uploaded. The infrastructure
owner's reviewed route change must use the actual allocated CNAME target
`xoxd-ai-fruitctl.pages.dev`. A CNAME without a Pages custom-domain association
can return a 522 error. Check the exact custom hostname's TLS and anonymous
served content after owner apply; a successful upload is not that final route
proof.

`deployment.json` records the real allocation separately from the pending served
route. Update its status only with a real deployment and served-route receipt.
There is no
Sites project or VNC network service on this route.

## Immutable adoption

Moving website paths help discovery. Source and skill consumers pin full commit
SHAs. Binary consumers pin exact immutable releases and verify SHA-256 hashes.
Publish a complete draft release before locking it; do not replace signed bytes
after publication. The site never presents `main` or `latest` as an immutable
vendoring reference.
