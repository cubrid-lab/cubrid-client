# Release criteria for cubrid-client 1.x

This document defines what a 1.x release must prove before it is published, and
which automated check proves each item. It applies to every release, whether the
tag comes from a merged Release Please PR or from the manual recovery path
([#120](https://github.com/cubrid-lab/cubrid-client/issues/120)).
[RELEASE_PROCESS.md](RELEASE_PROCESS.md) describes the mechanics.

## Automated gate

`release-validation.yml` runs on every Release Please PR. `publish.yml` runs it
again on the exact commit it is about to tag. Its final job, **All reviewed
release checks passed**, rejects a required job that failed, was skipped, was
cancelled or is missing. No tag is created and nothing is published unless that
job succeeds.

| # | Criterion | Enforced by | A failure looks like |
| --- | --- | --- | --- |
| 1 | The live broker matrix the docs claim | `live-cubrid.yml` with `full_matrix: true`: CUBRID 10.2, 11.0, 11.2 and 11.4, `CUBRID_LIVE_REQUIRED=1`, at least 20 assertions, no skips | An unreachable broker, a skipped suite or a failing test. [#149](https://github.com/cubrid-lab/cubrid-client/pull/149) proves an absent broker fails instead of self-skipping |
| 2 | Supported types read and written correctly | The live suite's type round trips, the independent wire oracles in `tests/protocol-oracles.test.ts`, and the JDBC comparison | A wrong value. The BIGINT 21→26 mutation in CI proves the oracles catch a wrong type code ([#147](https://github.com/cubrid-lab/cubrid-client/pull/147)) |
| 3 | Unsupported non-NULL values fail explicitly | Offline and live tests of `UnsupportedValueError` (OID, unknown codes, zero dates) | A value silently returned as `null` |
| 4 | Results agree with the official driver | `jdbc-parity.yml` with `full_matrix: true`: the same corpus through `org.cubrid:cubrid-jdbc` (pinned by hash) and cubrid-client on all four servers ([#118](https://github.com/cubrid-lab/cubrid-client/issues/118)) | Any difference that is not declared in `tests/jdbc-parity/corpus.json`, or fewer than 30 cases run |
| 5 | Stable public API | `npm run api:check` against `api/index.d.ts` before tagging | Any consumer-visible declaration change without a reviewed snapshot update |
| 6 | Advertised options work | Their offline and live tests. Options that are documented but not implemented are listed as limitations in the release notes | — |
| 7 | Transactions, concurrency and TLS | The live suite (transaction ownership, lock timeouts, concurrent queries) and `live-cubrid-tls.yml` (SSL=ON with a trusted CA, plus rejection of an untrusted certificate and a wrong host) | A failing live case |
| 8 | The package works as installed | The packed `npm pack` tarball is installed and imported as CJS and ESM on Node 18, 20, 22, 24 and 26 | An import failure on any supported Node line |
| 9 | No known high-severity dependency | `npm audit --audit-level=high` before tagging | An advisory at or above high |
| 10 | The npm artifact is the reviewed commit | `publish.yml` publishes through Trusted Publishing with provenance, then checks that the exact version exists on npm | npm `gitHead` differs from the tag commit, or the version is missing |

Test counts, coverage percentages, a pushed tag or a green ordinary PR run are
**not** release evidence on their own.

## Claims

- Claim compatibility only for the CUBRID versions in criterion 1 and the Node
  lines in criterion 8, and only for behavior those runs exercise.
- A difference recorded as a defect or limitation in the JDBC corpus must appear
  in the release notes while it is open.
- Node 18 and 20 stay supported throughout 1.x
  ([ADR 0006](adr/0006-node-18-support-through-1x.md)).

## Human approval

A maintainer merges the Release Please PR only after:

- reading the generated version and changelog against the merged commits;
- seeing **All reviewed release checks passed** succeed on the PR head;
- checking that the curated `docs/releases/vX.Y.Z.md` discloses open limitations.

The protected `npm-publish` environment can also require a reviewer before
publication. Merging the Release Please PR is the recorded approval.

## Limited-scope hotfix

A hotfix goes through the same gate, which cannot be bypassed. If a criterion
cannot pass for reasons outside the fix, for example a broker version that is
temporarily unavailable, the release notes must name the missing evidence and
the reason. The maintainer who approves the release records that decision in
the Release PR. A hotfix is not called production-ready for the evidence it
lacks. [RELEASE_DECISION.md](RELEASE_DECISION.md) is the worked v1.2.0 example.
