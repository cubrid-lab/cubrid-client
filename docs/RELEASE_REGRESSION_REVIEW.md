# Native CAS driver release regression review

Reviewed source evidence: 2026-11-06. This is a **process and test-detection
analysis**, not a finding of intent, individual fault, or verified customer data
loss. Source, historical CI, and unknowns are separated below.

## Timeline and introduction

| UTC date | Evidence | Meaning |
| --- | --- | --- |
| 2026-03-14 12:42 | [Native CAS implementation commit](https://github.com/cubrid-lab/cubrid-client/commit/37525d0c53f2a2b976b9b1c5d60df0160337188a) | Replaced the default adapter; introduced an independent TypeScript CAS constant table with BIGINT 26, SET 33, MULTISET 34, SEQUENCE 35, and incorrect statement codes |
| 2026-03-14 13:25 | [v1.0.0 published release](https://github.com/cubrid-lab/cubrid-client/releases/tag/v1.0.0) | Published about 43 minutes after the implementation commit; the *original* release description cited 99.33% coverage and an integration test count |
| 2026-11-05/06 | [BIGINT/CAS type correction #126](https://github.com/cubrid-lab/cubrid-client/pull/126), [statement code correction #130](https://github.com/cubrid-lab/cubrid-client/pull/130) | Later review established official CCI/CAS literal codes and regression tests; targeted live-broker cases were reported, but full version matrix remains pending |
| 2026-11-06 | [FETCH fail-closed #137](https://github.com/cubrid-lab/cubrid-client/pull/137), [unsupported value handling #140](https://github.com/cubrid-lab/cubrid-client/pull/140) | Added defensive behavior to reject partial/unsupported values rather than fabricate normal results; final combined live verification is still required |

The initial source can be read at
[`src/protocol/constants.ts` in v1.0.0](https://github.com/cubrid-lab/cubrid-client/blob/v1.0.0/src/protocol/constants.ts).
It assigned `BIGINT = 26` although CCI uses 21, and collection/statement
IDs also differed from the CCI domains. The separate statement identifiers
`INSERT = 20`, `SELECT = 21`, `UPDATE = 22`, `DELETE = 23`
were already correct; do not infer all query operations were broken.

## Cause and missed detection

**Introduced defect:** the first native driver contained incorrect,
unindependently verified protocol constants. A code table that looks
self-consistent can still be incompatible with the broker.

**Test oracle coupling:** the old
[`tests/protocol.test.ts`](https://github.com/cubrid-lab/cubrid-client/blob/v1.0.0/tests/protocol.test.ts)
used `CUBRIDDataType` values in both packet construction and assertions.
That can pass even if a wrong wire value is used on both sides. Statement
coverage measures executed lines, not correctness of the protocol oracle.

**Unasserted runtime semantics:** the old
[`tests/integration.test.ts`](https://github.com/cubrid-lab/cubrid-client/blob/v1.0.0/tests/integration.test.ts)
created a table containing BIGINT, FLOAT, DOUBLE, DATE and DATETIME, but
asserted only `int_col` and `str_col` among selected values. A passing
test would not catch a wrong BIGINT, float or date result.

**Non-mandatory live checks:** the
[v1.0.0 CI workflow](https://github.com/cubrid-lab/cubrid-client/blob/v1.0.0/.github/workflows/ci.yml)
ran typecheck, offline coverage and build for Node 18/20/22. It provisioned
no CUBRID broker and did not run a required live round-trip job. The
integration suite could self-skip database-dependent cases without making
the normal release CI fail. A test name or count in commit/release prose is
not proof that it actually ran against a broker.

### Why did this escape? (five-whys summary)

1. Incorrect protocol values entered the first native constants module.
2. The tests validated those values against the same implementation-derived
   constants rather than official versioned CCI/CAS wire facts.
3. Live integration assertions did not cover the affected scalar values.
4. The release pipeline had no required, non-skippable real broker job or
   independent fixture gate.
5. Release communication emphasized counts/coverage without tying support
   claims to reproducible server-version, type and API evidence.

The near-term root cause is **wrong constants**; the systemic escape point is
**insufficiently independent oracle and required live validation**. Do not
merge these into a vague claim that code review was missing.

## Impact: confirmed versus unverified

- **Confirmed in source:** the historical constants differ from official
  CCI/CAS codes; affected values can be decoded with an incorrect type or
  become a fabricated `null`. The later BIGINT correction records a
  targeted live CUBRID 11.4 reproduction/verification.
- **Confirmed in checks:** historical CI did not require a real CUBRID server;
  some integration cases were skipped or insufficiently asserted.
- **Possible but unmeasured:** applications using affected types against
  affected brokers might have observed missing/wrong results. No production
  incident count, customer impact scope or historical data corruption has
  been established by this review.
- **Still unknown:** any separate manual live test/review session that did
  not leave an accessible audit trail, and whether release reviewers
  inspected the exact package tarball. The introducing commit is not
  associated with a returned GitHub PR by the commit-to-PR lookup, but that
  alone does **not** prove the absence of discussion or a code review.
  AI assistance mentioned in the commit is not a causal finding.

## Prevention and detection plan

| Control / release evidence | Tracking | Responsible role / sign-off |
| --- | --- | --- |
| Correct the defective wire codes and preserve a regression test using literal official numeric IDs | [#81](https://github.com/cubrid-lab/cubrid-client/issues/81), [#116](https://github.com/cubrid-lab/cubrid-client/issues/116) | Driver maintainer, source reviewer |
| Independent, versioned protocol fixtures; mutation should fail if BIGINT changes from 21 to 26 | [#117](https://github.com/cubrid-lab/cubrid-client/issues/117) | Protocol reviewer |
| Compare supported native/legacy results on the same CUBRID version and fixtures | [#118](https://github.com/cubrid-lab/cubrid-client/issues/118) | Compatibility tester |
| Required live CI matrix with non-skipping database tests and exact version/type reports | [#95](https://github.com/cubrid-lab/cubrid-client/issues/95) | CI/release maintainer |
| Review exported runtime/types changes and packaged consumer ESM/CJS imports | [#98](https://github.com/cubrid-lab/cubrid-client/issues/98), [API stability](API_STABILITY.md) | API reviewer |
| Human review of accurate release notes, tarball and limited-scope exception evidence | [#106](https://github.com/cubrid-lab/cubrid-client/issues/106), [#120](https://github.com/cubrid-lab/cubrid-client/issues/120) | Release approver |

Individual assignees and completion dates must be assigned **in the linked
issues by maintainers**. This review does not fabricate names or deadlines.
No green check here substitutes for the release gate and its evidence.

## Controls that exist on main (checked 2026-11-07)

The table above names the tracking issues. This table names what is in the
repository now, checked against `main` at `8ee7a10`, and what is still missing.

| Control | What exists now | Not in place yet |
| --- | --- | --- |
| Wire codes match the CCI/CAS source ([#81](https://github.com/cubrid-lab/cubrid-client/issues/81), [#116](https://github.com/cubrid-lab/cubrid-client/issues/116), closed) | Literal numeric IDs in `tests/protocol-oracles.test.ts` (for example BIGINT `21`), cited in [PROTOCOL_ORACLES.md](PROTOCOL_ORACLES.md); run by `npm test` and by the `CI` workflow | Coverage is limited to the listed types and packets; collection and JSON decoders are unimplemented ([#82](https://github.com/cubrid-lab/cubrid-client/issues/82), [#111](https://github.com/cubrid-lab/cubrid-client/issues/111)) |
| Live broker tests that cannot skip ([#95](https://github.com/cubrid-lab/cubrid-client/issues/95), closed) | `.github/workflows/live-cubrid.yml` fails when the broker does not start or the TAP output reports skipped tests; `live-cubrid-tls.yml` does the same for TLS | See the next two rows |
| Live job runs on every relevant change | `live-cubrid.yml` runs on pull requests and pushes to `main`, but only when `src/**`, `tests/integration.test.ts`, `package.json`, the lockfile or the workflow itself changes | A change confined to other test files or to `tests/protocol-oracles.test.ts` does not start it. The full 10.2/11.0/11.2/11.4 matrix runs for release validation, not on every pull request |
| Live job is a required check | Not verified from repository files | The GitHub API reports no branch protection on `main` (HTTP 404 on 2026-11-07), so no check, including the live one, is enforced by branch protection. Repository rulesets were not found either. Mandatory status checks need a maintainer setting |
| Offline CI still self-skips integration | The `CI` workflow runs typecheck, offline coverage, build and `npm run api:check`; its integration step prints a warning that database cases self-skip | Offline CI alone is still not live evidence |
| Public API and package contract ([#98](https://github.com/cubrid-lab/cubrid-client/issues/98), closed) | `npm run api:check` (`scripts/api-check.mjs`, baseline `api/index.d.ts`); packed ESM/CJS consumer smoke on Node 18/20/22 in `release-validation.yml` | The smoke test covers the named entry points only |
| Compare with the original driver ([#118](https://github.com/cubrid-lab/cubrid-client/issues/118), closed) | `tests/legacy-parity.test.ts`, run by `live-cubrid.yml`; scope in [LEGACY_PARITY.md](LEGACY_PARITY.md) | A small common SQL fixture only; not full parity |
| No-publish release validation and manual approval ([#106](https://github.com/cubrid-lab/cubrid-client/issues/106), [#120](https://github.com/cubrid-lab/cubrid-client/issues/120), open) | `release-validation.yml` (live matrix, TLS, `npm audit`, consumer smoke, a gate job that rejects skipped or cancelled jobs) is called by `publish.yml` before the `npm-publish` environment job; checklist in [RELEASE_DECISION.md](RELEASE_DECISION.md) | The human sign-off fields in RELEASE_DECISION.md are unfilled, and #120 stays open. As of 2026-11-07 the `v1.2.0` tag and GitHub Release exist, but npm still serves 1.1.0 because `npm publish` failed with E404 (see #106). Do not treat 1.2.0 as available on npm |
| Review checklist | "Protocol correctness review" in [CONTRIBUTING.md](../CONTRIBUTING.md) and the checklist below | It is guidance read by reviewers; no workflow checks that it was followed |

Still absent: a required-check setting for the live jobs, an independent
audit of the remaining wire areas (collections, LOBs, JSON, error codes), and
any recorded review of what the v1.0.0 reviewer inspected. Assignees and dates
remain with the linked issues.

## Verification notes

Checked directly against the `v1.0.0` tag, commit metadata and the Release:

- Implementation commit `37525d0` is dated 2026-03-14 12:42 UTC; the `v1.0.0`
  Release was published at 13:25 UTC (43 minutes). Confirmed.
- The commit message cites 99.33% statement coverage and 14 integration tests.
  The current Release body was rewritten on 2026-11-06, so what the original
  body said is **not verified** from this repository.
- `v1.0.0` CI (`.github/workflows/ci.yml`) has no broker; the `test` and
  `test:coverage` scripts list four offline test files; `tests/integration.test.ts`
  sets `skip: !available`. Confirmed.
- `tests/integration.test.ts` at the tag inserts `bigint_col`, `float_col`,
  `double_col`, `date_col` and `datetime_col` but asserts only `int_col` and
  `str_col`. Confirmed.
- `tests/protocol.test.ts` imports `CUBRIDDataType` from the implementation for
  its expected type IDs. Confirmed for the quoted assertions; the whole file
  was not audited line by line.
- Neither the implementation commit nor the merge commit is associated with a
  pull request in the GitHub API. This does not show whether review happened
  elsewhere: not verified.
- The commit credits an AI coding assistant. No causal conclusion is drawn.

## Release-review checklist

Before declaring a driver release production-ready, reviewers should be able
to answer:

- Are protocol bytes and enum domains checked against **independent, cited**
  CUBRID source versions, not an enum reused by the test?
- Do real broker tests assert **returned values** for all advertised types,
  boundaries, errors and concurrent/transaction behavior, rather than just
  row counts or return types?
- Did every claimed CUBRID version actually execute a required live job
  with **zero self-skipped database tests**? Are logs linked?
- Does the packed npm artifact work in ESM and CommonJS consumers on
  the advertised Node runtime matrix?
- Does the curated release note distinguish verified support, known gaps,
  historical behavior fixes and any targeted remediation exception?

Production-ready status is **evidence-gated**, not implied by major version,
statement coverage, test count or an automatically generated Release Please
PR. See [#120](https://github.com/cubrid-lab/cubrid-client/issues/120).
