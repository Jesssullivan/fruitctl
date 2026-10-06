# Validation

Run the offline proxy tests with Node.js:

```sh
npm ci --ignore-scripts
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" npm run test:offline
```

The scratch directory must be owned by the test user. Fixtures remove their
own files when they finish. The two credential tests cover framing, native child
launch, password exclusion from arguments, and proxy behavior under failures.
They use a fake native child and do not connect to a real desktop.

`credential-input-cases.py` and `CredentialInputHarness.swift` exercise native
credential input. `../Tests/VNCReconnectTests.swift` covers the Swift VNC
lifecycle and framebuffer readiness. [project.yml](../project.yml) declares
the native build inputs.

The provider-driven manual experiments were retired. Use
`git log -- test/integration.js` and `git log -- .env.example` for their history.
`just test` runs the current `*.test.js` suite with owned synthetic broker/native
fixtures; it does not start a provider turn or control a real desktop. The native
reconnect, behavior, and Host suites are declared in [project.yml](../project.yml).
`just test-observation-gate <daemon> <output_dir>` is the explicit Darwin-only
synthetic input-admission check. Offline and synthetic results do not establish
real frontend or desktop qualification.
