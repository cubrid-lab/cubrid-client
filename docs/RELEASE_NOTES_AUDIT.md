# Release notes audit: published GitHub Release bodies

Audit for [#298](https://github.com/cubrid-lab/cubrid-client/issues/298), recorded 2026-11-18 against `main` at `fa2d582`. It covers the six published GitHub Releases (v0.1.0, v1.0.0, v1.1.0, v1.2.0, v1.3.0, v1.4.0) and the v0.2.0 tag, which has a source note and an npm version but no Release page. Version-specific npm safety guidance and deprecation are tracked separately in [#290](https://github.com/cubrid-lab/cubrid-client/issues/290) and the [literal-parameter advisory](advisories/literal-parameters-1.4.0.md); this audit does not repeat them.

Three things are checked **separately**, because one does not imply another:

1. **Published artifacts**: the Release metadata and the npm version agree with the immutable tag.
2. **Source/public equality**: each public Release body equals `docs/releases/<tag>.md`.
3. **Facts and editorial quality**: every claim in the source note is backed by the tag, and the note is concise and consistent. Byte equality does not prove good prose.

Nothing in this audit changed a GitHub Release, a tag or an npm artifact.

## Summary

| Version | Artifact check | Body = source before this change | Factual check | Source correction here | Public body sync needed |
| --- | --- | --- | --- | --- | --- |
| v0.1.0 | Pass | Yes | Pass (two bullets without a commit link) | None | No |
| v0.2.0 | Pass (no Release page by design) | n/a | Pass | None | n/a |
| v1.0.0 | Pass | Yes | Pass | None | No |
| v1.1.0 | **Exception**: npm `gitHead` is the parent of the tag commit | Yes | Pass | None | No |
| v1.2.0 | Pass (npm published 11.5 h after the Release, explained) | Yes | User-facing PRs and the only external contributor omitted | Three entries added | **Yes** |
| v1.3.0 | Pass | Yes | Pass | None | No |
| v1.4.0 | Pass | Yes | Pass; four Bug Fixes entries repeat Upgrade notes | Four entries merged into one | **Yes** |

## 1. Published artifacts

Release metadata from `gh api repos/cubrid-lab/cubrid-client/releases`; npm metadata from `npm view cubrid-client@<v> gitHead engines dist.integrity time`. No Release has assets, none is a draft or prerelease, and every title is `cubrid-client vX.Y.Z`. Every tag's `package.json` and every npm version declare `engines.node: ">=18"`.

| Version | Tag commit | npm `gitHead` | Release published (UTC) | npm published (UTC) | npm publisher | Release ID |
| --- | --- | --- | --- | --- | --- | --- |
| v0.1.0 | `379b3ff` | `379b3ff` | 2026-03-13 04:06:15 | 2026-03-13 04:06:13 | `yeongseon` | 296511491 |
| v0.2.0 | `b70ec20` | `b70ec20` | no Release | 2026-03-13 08:12:51 | `yeongseon` | n/a |
| v1.0.0 | `dbbd525` | `dbbd525` | 2026-03-14 13:25:03 | 2026-03-14 13:57:07 | `yeongseon` | 297003200 |
| v1.1.0 | `c01cbdb` | **`701cb35`** | 2026-03-17 04:45:56 | 2026-03-16 14:22:38 | `yeongseon` | 297771831 |
| v1.2.0 | `8ee7a10` | `8ee7a10` | 2026-11-07 00:02:31 | 2026-11-07 11:36:00 | GitHub Actions, SLSA provenance | 437195595 |
| v1.3.0 | `b2d5bec` | `b2d5bec` | 2026-11-07 15:34:58 | 2026-11-07 15:36:52 | GitHub Actions, SLSA provenance | 437663054 |
| v1.4.0 | `a92003e` | `a92003e` | 2026-11-12 09:11:14 | 2026-11-12 09:13:35 | GitHub Actions, SLSA provenance | 442711160 |

`dist-tags.latest` is `1.4.0`. The heading date of each source note is the Release publication date in UTC; v0.2.0, which has no Release, uses its tag and npm date (2026-03-13 UTC).

**Exceptions**

- **v1.1.0 `gitHead`.** npm records `701cb35`, the parent of the tag commit `c01cbdb`. `git diff 701cb35 c01cbdb` changes only the `version` field of `package.json` (`1.0.0` to `1.1.0`), so the package was published from a working tree with that edit uncommitted, before the version commit existed. The packaged code is the code of the tag. This predates [RELEASE_CRITERIA.md](RELEASE_CRITERIA.md) row 10, which now requires `gitHead` to equal the tag. The v1.1.0 Release page was published about 14 hours after npm. The artifact is immutable and is not corrected; the Release body does not need to mention it.
- **v1.2.0 npm delay.** The Release page preceded npm by 11.5 hours because the first publish run failed at its npm step, as recorded in [RELEASE_DECISION.md](RELEASE_DECISION.md). The later npm version matches the tag.
- **v0.1.0 to v1.1.0** were published from a maintainer account without provenance, before Trusted Publishing.
- **v0.2.0** has no Release page. Per [docs/releases/README.md](releases/README.md) none is created.
- **Generated changelog.** `CHANGELOG.md` dates 0.2.0 as 2026-03-12, but the tag commit and npm both date it 2026-03-13 (UTC). This is outside the Release bodies; correct it, if at all, in a separate changelog change.

## 2. Source/public equality

Each body was fetched with `gh api repos/cubrid-lab/cubrid-client/releases/tags/<tag> --jq .body` and compared with `docs/releases/<tag>.md` at `fa2d582` after trimming trailing whitespace. All six were equal (sizes 1,170 / 1,232 / 1,235 / 2,679 / 4,198 / 8,239 bytes for v0.1.0 to v1.4.0).

After this change, the v1.2.0 and v1.4.0 sources **differ** from their public bodies until a body-only sync is separately approved (see [Proposed body-only sync](#proposed-body-only-sync)).

## 3. Facts and editorial quality

Every PR link was checked with `gh api repos/cubrid-lab/cubrid-client/pulls/<n>` (merged state, author login, merge commit) and against `git log <previous>..<tag>`. Every commit link was checked with `git merge-base --is-ancestor <sha> <tag>` and not in the previous tag. All `by @user` credits equal the PR author or the GitHub commit author. Every Full Changelog link compares the previous tag with this tag (v0.1.0 links its commit list).

### v0.1.0

| Claim | Evidence at `v0.1.0` | Verdict |
| --- | --- | --- |
| Wraps `node-cubrid`, no native CAS | `dependencies: {"node-cubrid": "^11.0.0"}`; `src/adapters/node-cubrid.ts` only | Pass |
| Node.js 18 or newer | `engines.node: ">=18"` | Pass |
| `createClient()`, typed `query<T>()`, transaction callbacks, structured errors | `src/client/create-client.ts`, `client.ts` `transaction<T>()`, `ConnectionError` / `QueryError` / `TransactionError`; commit `2d8481f` by `yeongseon` | Pass |
| ESM and CommonJS entry points | `exports["."]` has `import` and `require` | Pass |
| [#1](https://github.com/cubrid-lab/cubrid-client/pull/1) by @Copilot | merged; author `Copilot`; merge `0403803` in tag | Pass |
| `379b3ff` CI test path | tag commit, author `yeongseon` | Pass |

Editorial: concise. The two feature entries have no commit link; `2d8481f` is their evidence. This is recorded here rather than changing a public body for a link alone.

### v0.2.0 (tag only)

`b70ec20` (DDL/DML routed to `execute()`) and `a2a2203` (badge sync) are the only two commits in `v0.1.0..v0.2.0`, both by `yeongseon`; `node-cubrid` is still the runtime dependency. Pass.

### v1.0.0

| Claim | Evidence at `v1.0.0` | Verdict |
| --- | --- | --- |
| `node-cubrid` runtime dependency removed | no `dependencies` in `package.json` | Pass |
| Native CAS adapter `37525d0`; transaction methods `0a7684a`; docs `3cabdcd`, `c58e4fc` | all in `v0.2.0..v1.0.0`, author `yeongseon` | Pass |
| Not covered by the later 10.2 to 11.4 live matrix | no live CUBRID workflow at the tag | Pass |

Editorial: concise; the migration caveat is appropriate.

### v1.1.0

| Claim | Evidence at `v1.1.0` | Verdict |
| --- | --- | --- |
| Connection-string parsing and query helpers are **not** in v1.1.0 | `df67d44` is in `v1.1.0..v1.2.0` | Pass |
| `6114499`, `4f842e2`, `45a18dd` by @yeongseon; `701cb35` by @sisyphus-dev-ai | all in `v1.0.0..v1.1.0`; GitHub authors match | Pass |
| "A focused **patch-level** update" | `v1.0.0..v1.1.0` contains only `fix`, `docs` and `chore` commits, no `feat` | Pass |

Observation only: the version number is a semver minor bump while the content is maintenance-level; the wording describes the content correctly and is not changed.

### v1.2.0

| Claim | Evidence | Verdict |
| --- | --- | --- |
| TLS [#55](https://github.com/cubrid-lab/cubrid-client/pull/55), escaping [#52](https://github.com/cubrid-lab/cubrid-client/pull/52), TLS read fix [#58](https://github.com/cubrid-lab/cubrid-client/pull/58) | merged; the `/pull/N` links resolve | Pass |
| PR history rewrite (not a defect) | the `/pull/N` links resolve; only the API `merge_commit_sha` of six PRs predates the 2026-11-05 history rewrite and is not an ancestor of the tag: #16 (`7d8406e`), #21 (`0333e95`), #52 (`2c21c07`), #55 (`0f6cba7`), #56 (`e5453d9`), #58 (`249e243`). Their rewritten commits `9fb440a`, `65d06ad`, `4b7c27b`, `f8082b1`, `8888cd3`, `aa14d87` are in `v1.1.0..v1.2.0` | Pass, recorded |
| `df67d44` connection string and helpers | `parseConnectionString`, `escapeIdentifier`, `buildWhere` exported | Pass |
| [#122](https://github.com/cubrid-lab/cubrid-client/pull/122), #126, #127, #128, #130, #137, #140, #143, #145 | merged into the tag, author `yeongseon` | Pass |
| String parameters use escaped literals; prepared binding is v1.3.0 | prepared binding is [#207](https://github.com/cubrid-lab/cubrid-client/pull/207) in `v1.2.0..v1.3.0` | Pass |
| Release process exercised CUBRID 10.2/11.0/11.2/11.4 and real TLS | `live-cubrid.yml` matrix `["10.2","11.0","11.2","11.4"]`; `live-cubrid-tls.yml` CUBRID 11.4 SSL=ON; Node 18/20/22 in `release-validation.yml` | Pass |
| Completeness | `git log v1.1.0..v1.2.0` and `CHANGELOG.md` 1.2.0 contain user-facing changes the note omits: [#16](https://github.com/cubrid-lab/cubrid-client/pull/16) by **@paikend** (the only external code contribution in the release), [#21](https://github.com/cubrid-lab/cubrid-client/pull/21) `ping()` and EPIPE handling, [#56](https://github.com/cubrid-lab/cubrid-client/pull/56) request serialization and `6f009cc` failed-connection cache reset. Code at the tag: `checkReconnectUnlocked()`, `ping()`, the per-connection `enqueue()` queue | **Corrected**: three entries added |

Editorial: #58 fixes a defect in #55 that never shipped on its own; it could be folded into the TLS entry, but it is left as is to keep the PR trace.

### v1.3.0

| Claim | Evidence | Verdict |
| --- | --- | --- |
| 28 PR links | every one merged into `v1.2.0..v1.3.0`, author `yeongseon`; no `feat`/`fix` PR in the range is omitted | Pass |
| Node 18 and newer; floor not raised | `engines.node: ">=18"` | Pass |
| CUBRID 10.2 to 11.4, real TLS, packaged ESM/CJS on Node 18/20/22 | `live-cubrid.yml`, `live-cubrid-tls.yml`; `publish.yml` and `release-validation.yml` Node `[18, 20, 22]` | Pass |
| Publication run 42386689234 verified npm 1.3.0 | run `Publish verified npm release`, `head_sha b2d5bec`, `success`, finished 15:37:16 UTC | Pass |

Editorial: within budget (4,198 bytes, 17 entries); grouped bullets keep it scannable.

### v1.4.0

| Claim | Evidence at `v1.4.0` | Verdict |
| --- | --- | --- |
| 31 PR links | every one merged into `v1.3.0..v1.4.0`, author `yeongseon`; no user-facing `feat`/`fix`/`perf` change in the range is omitted (`8a7004c` only touches PR templates) | Pass |
| Node 18 and newer; release checks add Node 24 and 26 | `engines.node: ">=18"`; `release-validation.yml` and `publish.yml` Node `[18, 20, 22, 24, 26]` ([#236](https://github.com/cubrid-lab/cubrid-client/pull/236)); at v1.3.0 only `ci.yml` ran 24/26 | Pass |
| Two fixes close SQL injection paths in literal parameters | [#258](https://github.com/cubrid-lab/cubrid-client/pull/258) fixes [#242](https://github.com/cubrid-lab/cubrid-client/issues/242) and [#243](https://github.com/cubrid-lab/cubrid-client/issues/243); consistent with the [advisory](advisories/literal-parameters-1.4.0.md) | Pass |
| Credentials over 31 UTF-8 bytes or with NUL refused | `src/types/client.ts` and `src/protocol/protocol.ts` | Pass |
| `connectionTimeout` 10 s default, `noDelay`, 60 s keepalive | `DEFAULT_CONNECTION_TIMEOUT_MS = 10_000`, `KEEP_ALIVE_INITIAL_DELAY_MS = 60_000`, `setNoDelay(true)` | Pass |
| `maxReplyBytes` 1 GiB and its new message | `DEFAULT_MAX_FRAME_LENGTH = 1024 * 1024 * 1024`; message in `src/protocol/connection.ts` | Pass |
| `Client is closed.`; deprecated manual methods; `zoned()`; BLOB/CLOB 128 KiB chunks; ADR 0009 and 0010 | present at the tag | Pass |
| Concision | 8,239 bytes, 39 entries. The Bug Fixes entries for #261, #265, #267/#269 and #271 restate the Credentials, Unobserved failures, `close()` and `lastInsertId` upgrade notes | **Corrected**: four entries merged into one that keeps every link and credit |

Kept on purpose: the Node runtime note, the literal-parameter and credential warnings, every migration note, the known limitations and the scoped compatibility statement. The Documentation entries for #272 and #282 overlap the Dates and Known limitations notes but record separate documentation PRs, so they stay. After the change: 7,988 bytes, 36 entries.

## Corrections in this change

| Note | Before | After |
| --- | --- | --- |
| v1.2.0 Features | (none) | `Check connection health with ping() and survive EPIPE socket errors instead of crashing the process (#21) by @yeongseon` |
| v1.2.0 Bug Fixes | (none) | `Reconnect when the broker releases the CAS process under KEEP_CONNECTION=AUTO (#16) by @paikend` |
| v1.2.0 Bug Fixes | (none) | `Serialize concurrent requests on one connection, and clear a failed cached connection attempt so the next call retries (#56, 6f009cc) by @yeongseon` |
| v1.4.0 Bug Fixes | four entries: `Refuse credentials ...` (#261); `Decide commit or rollback ...` (#265); `Wait for running transaction() callbacks ...` (#267, #269); `Never report a stale or guessed lastInsertId` (#271) | one entry: `Fix the credential truncation, transaction() commit/rollback, close() and lastInsertId defects whose behaviour changes are listed under Upgrade notes (#261, #265, #267, #269, #271) by @yeongseon` |

## Proposed body-only sync

After this change is reviewed and merged, the v1.2.0 and v1.4.0 Release bodies differ from their sources. Each needs its own **separately approved** body-only update; merging this change does not authorize it. For each tag:

1. **Backup**: `gh api repos/cubrid-lab/cubrid-client/releases/tags/<tag> > <tag>.before.json`; record `id`, `name`, `tag_name`, `draft`, `prerelease`, `published_at`, `target_commitish`, the asset count and the body SHA-256.
2. **Concurrency check**: immediately before editing, re-fetch and confirm the body still equals the backup (no edit since); stop if it changed.
3. **Body-only edit**: `gh release edit <tag> --title "cubrid-client <tag>" --notes-file docs/releases/<tag>.md`, as in [RELEASE_PROCESS.md](RELEASE_PROCESS.md#github-release-note-formatting). `--title` only restates the existing title; do not pass `--tag`, `--target`, `--draft`, `--prerelease` or `--latest`, and do not touch npm.
4. **Readback**: re-fetch; the body must equal the merged source (ignoring the trailing newline), and every field recorded in step 1 except the body must be unchanged.

## Reproduce

```sh
# Gates
node scripts/verify-release-notes.mjs
node scripts/verify-release-notes.mjs --candidate
node --test tests/release-notes-format.test.mjs

# 1. Artifacts
gh api repos/cubrid-lab/cubrid-client/releases --jq '.[] | [.tag_name,.name,.published_at,.draft,.prerelease,(.assets|length)] | @tsv'
for v in 0.1.0 0.2.0 1.0.0 1.1.0 1.2.0 1.3.0 1.4.0; do
  echo "v$v tag=$(git rev-list -n1 v$v) npm=$(npm view cubrid-client@$v gitHead) engines=$(npm view cubrid-client@$v engines.node)"
done
npm view cubrid-client time --json
git diff 701cb35 c01cbdb   # v1.1.0: only the package.json version

# 2. Source/public equality (on the commit being compared)
for t in v0.1.0 v1.0.0 v1.1.0 v1.2.0 v1.3.0 v1.4.0; do
  cmp -s <(gh api repos/cubrid-lab/cubrid-client/releases/tags/$t --jq .body) <(cat docs/releases/$t.md; echo) && echo "$t equal" || echo "$t differs"
done

# 3. References: PR state/author and tag containment
gh api repos/cubrid-lab/cubrid-client/pulls/16 --jq '[.merged,.user.login,.merge_commit_sha]'
git log --format='%h %an %s' --grep='(#16)' v1.1.0..v1.2.0
git merge-base --is-ancestor 6f009cc v1.2.0 && ! git merge-base --is-ancestor 6f009cc v1.1.0 && echo "6f009cc in v1.2.0 only"
```
