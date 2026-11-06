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
