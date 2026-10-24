# Contributing

Follow the live draft 0.2 [specification](https://personalagentprotocol.org/docs/0.2/spec)
and [guides](https://personalagentprotocol.org/docs/0.2/guides). Tests/snapshots are
supporting evidence. Demo/business workflows and individual extensions are excluded.
Code is [MIT](LICENSE); confirm rights for third-party contributions.

Use Node 24.12.0, TypeScript 5.9.3 and @types/node 24.10.0.
Install the exact client candidate tarball plus the pinned dev tools; CI reads full
SDK SHAs/versions from .github/*-candidate.json. No sibling checkout is required.

CI first builds the universal macOS Keychain helper on a macOS runner using its
installed Apple toolchain. `scripts/build-native.mjs` signs ad-hoc, verifies both
architectures and the 11.0 deployment target, and records source/binary hashes.
`scripts/check-native.mjs` binds those bytes to this checkout before Linux packs
them. Users never compile at installation. Packaged Windows/macOS jobs exercise
the exact tarball, synthetic credentials and a disposable Keychain. Actual human
upgrade approval remains a separate check, never inferred from fixture tests.

```sh
npm run typecheck
npm run build
npm run typecheck:tests
npm test
npm run check:docs
```

First-party tests/workers/verification helpers are canonical `.mts`. The existing
compiler checks the whole strict program before emitting ignored adjacent `.mjs`.
Failed builds remove stale outputs; no loader/type stripping substitutes for checking.
Run `npm run build:tests` before `node scripts/run-checks.mjs GROUP` (unit, contracts,
integration, validation). Groups are exhaustive/disjoint. LF source bytes are enforced
by Git attributes. Generated test code is outside the npm allowlist; production tests
import built/installed JavaScript. Release/build tools and examples may remain JS.

`npm run coverage` builds production and checked tests, then writes native Node
line/branch/function reports under `coverage/` (summary.txt, lcov.info, report.json,
raw/). Metrics cover loaded first-party dist JS: no production source maps or TS
remapping; node_modules excluded, unloaded modules listed. Raw subprocess reports
are retained, but arbitrary children may not merge and killed workers may not flush.
Installed/OS/host checks are separate evidence; no percentage proves conformance.

Include callers, meaningful regression evidence and docs with behavior changes.
Preserve credential/destination validation, private errors and persisted data.
Report checks actually run and limits. Use Issues for non-sensitive defects and
[SECURITY.md](SECURITY.md) for vulnerabilities. Follow [RELEASING.md](RELEASING.md)
before tagging/publishing; obtain explicit owner authorization.
