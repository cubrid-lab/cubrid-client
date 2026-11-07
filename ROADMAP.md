# Roadmap

Updated: 2026-11-06. This is the plan for the **TypeScript/Node.js**
`cubrid-client` package. Issues are a work queue; the version labels below
are **targets, not a promise that the changes have shipped**.

## Release status: 1.2.0 tagged, not on npm

The release has two independent states, which must not be conflated:

- **GitHub:** [Release Please PR #123](https://github.com/cubrid-lab/cubrid-client/pull/123)
  was merged and [GitHub Release v1.2.0](https://github.com/cubrid-lab/cubrid-client/releases/tag/v1.2.0)
  exists (published 2026-11-07).
- **npm:** as of 2026-11-07 the registry still serves `1.1.0` as `latest`
  (`npm view cubrid-client version`). The
  [publish run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42315470123)
  for v1.2.0 passed its pre-publish validation jobs but its "Publish to npm"
  step failed. Do not treat 1.2.0 as installable from npm until the registry
  shows it.

Many fixes have merged to `main` after the v1.2.0 tag and are unreleased.
The open Release Please PR [#176](https://github.com/cubrid-lab/cubrid-client/pull/176)
proposes 1.3.0, and [#189](https://github.com/cubrid-lab/cubrid-client/issues/189)
tracks verifying npm publication before the next release is proposed. The
[release validation](https://github.com/cubrid-lab/cubrid-client/issues/106)
record is [docs/RELEASE_DECISION.md](docs/RELEASE_DECISION.md).

A successful offline Node.js matrix is **not** evidence of live CAS protocol
compatibility. The known type, fetch, transaction and LOB limitations must be
reviewed and disclosed; use a limited-scope hotfix path only if the maintainers
record the exact live smoke evidence and conditions in [#120](https://github.com/cubrid-lab/cubrid-client/issues/120).

## Correctness and evidence before broad feature expansion

| Work | Tracking |
| --- | --- |
| Required live CUBRID version matrix and accurate support claims | [#95](https://github.com/cubrid-lab/cubrid-client/issues/95), [support matrix](docs/SUPPORT_MATRIX.md) |
| Independently reviewed protocol bytes, literal type IDs, malformed frame cases | [#117](https://github.com/cubrid-lab/cubrid-client/issues/117) |
| Native-versus-legacy result behavior parity | [#118](https://github.com/cubrid-lab/cubrid-client/issues/118) |
| Production-readiness gate and postmortem controls | [#120](https://github.com/cubrid-lab/cubrid-client/issues/120), [#119](https://github.com/cubrid-lab/cubrid-client/issues/119) |
| Collection and JSON values, date/timezone stability | [#82](https://github.com/cubrid-lab/cubrid-client/issues/82), [#111](https://github.com/cubrid-lab/cubrid-client/issues/111), [#113](https://github.com/cubrid-lab/cubrid-client/issues/113) |
| Shared connection / FETCH ordering, manual transaction ownership | [#114](https://github.com/cubrid-lab/cubrid-client/issues/114), [#112](https://github.com/cubrid-lab/cubrid-client/issues/112), [#109](https://github.com/cubrid-lab/cubrid-client/issues/109) |
| Actual retry/logger behavior and errors | [#83](https://github.com/cubrid-lab/cubrid-client/issues/83), [#100](https://github.com/cubrid-lab/cubrid-client/issues/100), [#89](https://github.com/cubrid-lab/cubrid-client/issues/89) |

Safety fixes can be merged after reviews and CI even when broader live matrix
work remains open; they are **not release approval**. Record which acceptance
criteria are verified and which are still pending real broker tests.

## Proposed incremental public features (after correctness)

- Query/DML metadata and optional server-side binding:
  [#84](https://github.com/cubrid-lab/cubrid-client/issues/84),
  [#88](https://github.com/cubrid-lab/cubrid-client/issues/88),
  [#85](https://github.com/cubrid-lab/cubrid-client/issues/85).
- Verified LOB writes:
  [#103](https://github.com/cubrid-lab/cubrid-client/issues/103).
- Transaction configuration and server version:
  [#91](https://github.com/cubrid-lab/cubrid-client/issues/91),
  [#102](https://github.com/cubrid-lab/cubrid-client/issues/102).
- Pooling, batching and schema inspection after handle ownership
  and lifecycle testing:
  [#92](https://github.com/cubrid-lab/cubrid-client/issues/92),
  [#86](https://github.com/cubrid-lab/cubrid-client/issues/86),
  [#94](https://github.com/cubrid-lab/cubrid-client/issues/94).

## Compatibility and release policy

The current npm runtime contract is `node >=18` (CI tests Node 18, 20, 22, 24
and 26; Node 18 and 20 are deprecated and a removal candidate for 2.0, see
[Node.js support schedule](docs/API_STABILITY.md#nodejs-support-schedule)) and the public API is already
1.x. [API stability](docs/API_STABILITY.md) requires a MAJOR for incompatible
changes, including increasing the Node.js minimum. A build-tool upgrade
(e.g. `tsup`) does not by itself justify changing the consumer Node.js floor.

See the [TypeScript type mapping](docs/TYPES.md),
[verified support matrix](docs/SUPPORT_MATRIX.md) and
[release process](docs/RELEASE_PROCESS.md). Do not claim all features in this
roadmap are implemented or production-ready.
