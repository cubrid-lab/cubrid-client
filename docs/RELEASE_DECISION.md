# Reviewed release decision: cubrid-client v1.2.0

Record prepared: 2026-11-07. **Distribution state, as of 2026-11-07:**
[GitHub Release v1.2.0](https://github.com/cubrid-lab/cubrid-client/releases/tag/v1.2.0)
exists, but npm still serves `1.1.0`: the
[v1.2.0 publish run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42315470123)
failed at its npm publish step. The sections below are the **historical
pre-release sign-off record**, kept as written; they do not record a
maintainer approval, a successful npm publication or a full
production-ready certification. This record distinguishes the already
observed results from approvals that still must be supplied by a maintainer.

## Decision scope

This is a limited-scope **correctness/remediation** release from the
currently published v1.1.0, not a claim of complete CUBRID compatibility.
Issue [#106](https://github.com/cubrid-lab/cubrid-client/issues/106)
owns the candidate; [#123](https://github.com/cubrid-lab/cubrid-client/pull/123)
is the reviewable release PR. Existing 1.0/1.1 tags and npm versions are
immutable. [API_STABILITY.md](API_STABILITY.md) defines the public Node/npm
SemVer commitments.

## Verified repository evidence (not publication approval)

| Gate | Existing evidence | Precise scope / limitation |
| --- | --- | --- |
| Live CUBRID versions | [main integration matrix](https://github.com/cubrid-lab/cubrid-client/actions/runs/42216017228) | Core 23/23 tests, no skips, on each of 10.2/11.0/11.2/11.4 |
| Native vs original Node SQL results | [main cross-driver comparison](https://github.com/cubrid-lab/cubrid-client/actions/runs/42308157513), [matrix](LEGACY_PARITY.md) | On the same four server versions, the small common SQL fixture passed for integers, strings, SQL NULL, cross-driver writes, errors and query recovery; not full parity |
| Actual TLS security | [main SSL=ON broker run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42217503095) | CUBRID 11.4: trusted CA/hostname round trip and rejection of untrusted/wrong-host certificates; not SSL testing of every version |
| Independent protocol oracle | [PR #147](https://github.com/cubrid-lab/cubrid-client/pull/147) and [source table](PROTOCOL_ORACLES.md) | Literal code and packet tests include a BIGINT 21->26 mutation that must fail; does not cover every wire extension |
| No silent live-test bypass | [PR #149](https://github.com/cubrid-lab/cubrid-client/pull/149) | Required live mode fails with an unreachable broker instead of self-skipping |
| Package/API/security gate | [PR #146](https://github.com/cubrid-lab/cubrid-client/pull/146), [validation workflow](../.github/workflows/release-validation.yml) | Automated pre-tag dependency, Node 18/20/22 packed ESM/CJS smoke, live DB/TLS; final **candidate SHA** must still pass an explicit full dry run |

A successful earlier branch/main run **does not** prove the final release
candidate passes after subsequent changes. Copy the final immutable commit
SHA and its corresponding run URL into the sign-off section below.

## Known limits that must accompany the release

- Unsupported non-NULL collection/JSON (and other unknown) values reject
  the query instead of being returned as SQL NULL. Collection/JSON decoders
  remain unimplemented ([#82](https://github.com/cubrid-lab/cubrid-client/issues/82),
  [#111](https://github.com/cubrid-lab/cubrid-client/issues/111)).
- BLOB and CLOB reads load complete content, bounded by `maxLobBytes`, with the
  [limitations listed in the type guide](TYPES.md#blob-and-clob-columns). LOB
  writes through a handle are not implemented
  ([#103](https://github.com/cubrid-lab/cubrid-client/issues/103)).
- `query()` is not a server-side prepared binding API; the opt-in
  `queryPrepared()` family is
  ([#85](https://github.com/cubrid-lab/cubrid-client/issues/85)). DML
  affected-row counts and generated ids are not part of its Promise result;
  `execute()` returns them
  ([#84](https://github.com/cubrid-lab/cubrid-client/issues/84)).
- `maxConnectionRetryCount` retries only a failed TCP connect; it does not
  retry rejected credentials, requests or transactions, and there is no host
  fallback ([#83](https://github.com/cubrid-lab/cubrid-client/issues/83)). The `logger`
  option now emits redacted diagnostics
  ([#100](https://github.com/cubrid-lab/cubrid-client/issues/100)).
- CUBRID DATE/DATETIME have no embedded timezone; decoding is
  process-timezone-sensitive by default, and `timezone: "utc"` opts into
  TZ-independent decoding ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)).
- Query-scoped deadline/AbortSignal, full transaction ownership and full
  LOB/collection/error parity remain future work
  ([#150](https://github.com/cubrid-lab/cubrid-client/issues/150),
  [#112](https://github.com/cubrid-lab/cubrid-client/issues/112),
  [#118](https://github.com/cubrid-lab/cubrid-client/issues/118)).
- The CUBRID 10.2/11.0/11.2/11.4 matrix verifies **the named tests only**.
  A 1.x version number does not imply production readiness.

## Human approval and publication checklist

These were unchecked when this record was prepared and have not been updated. Complete them before using the manual
`PUBLISH` input. Do not prefill a person's name or claim an audit result
from an earlier commit.

- [ ] The exact v1.2.0 release PR commit, package.json, lockfile, manifest
      and generated changelog all agree on the version and release scope.
- [ ] Reviewer reads the [curated emoji-free release notes](releases/v1.2.0.md),
      [support matrix](SUPPORT_MATRIX.md), [types](TYPES.md) and outstanding
      limitations above.
- [ ] **Final candidate SHA** is validated with the no-publish
      [Reviewed release validation workflow](../.github/workflows/release-validation.yml):
      all four live database versions, real SSL=ON, negative gate behavior,
      no skipped jobs, Node 18/20/22 package ESM/CJS smoke, API diff, audit.
- [ ] Reviewer examines the exact npm tarball file list and included
      TypeScript declarations/ESM and CommonJS exports; no undeclared runtime
      dependencies or wrong Node.js minimum.
- [ ] Security reviewer checks current high/critical advisory status and
      documents how any open security-release issue was dispositioned.
- [ ] Maintainer explicitly chooses **limited-scope remediation** rather
      than `production-ready` and accepts the limitations in the release
      announcement, with a recorded approval URL.
- [ ] The npm-publish environment is authorized for npm trusted (OIDC)
      publishing as configured in `.github/workflows/publish.yml`; a manual
      `PUBLISH` run uses the exact merged main candidate.
- [ ] Only after a successful npm publication is confirmed, decide whether to
      mark `cubrid-client@<=1.1.0` deprecated with an accurate upgrade advisory.

**Fill before sign-off**

| Field | Value |
| --- | --- |
| Candidate commit SHA | Pending review |
| Final no-publish run URL and result | Not yet recorded |
| npm tarball / API consumer evidence | Not yet recorded for candidate |
| Security acceptance / outstanding exceptions | Not yet recorded |
| Maintainer name and date | No approval recorded |
| Decision | Not approved / not published |

## Release decision categories

**Full production-ready:** blocked until all publicly advertised runtime,
type/LOB/transaction/fault contracts have corresponding real broker and
independent coverage, and all exposed options are functional or safely
versioned. A version-matrix smoke alone cannot satisfy this.

**Limited-scope 1.2.0 remediation:** possible *only* after the explicit
candidate-specific CI and human review checklist above. Its release body must
clearly say what was tested and what remains unsupported. There is no
automation path that silently upgrades it to production-ready.

See the [release process](RELEASE_PROCESS.md) for the manually approved
tag/npm sequence and [#120](https://github.com/cubrid-lab/cubrid-client/issues/120)
for the remaining release-gate acceptance criteria.
