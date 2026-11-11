# Reviewed npm release process

This TypeScript/npm library uses Release Please's **node** release type, not a
Python release strategy. The GitHub Release and npm publish steps are separate.

## Baseline and Release PRs

- Bootstrap from the already published v1.1.0 tag. The manifest starts at
  1.1.0, matching package.json; never recreate historical release tags.
- On push to main, release-please creates/updates a **reviewable Release PR**
  containing version bumps (package.json, package-lock.json, manifest) and the
  CHANGELOG. Conventional Commits: fix: patch, feat: minor, feat!: major.
- The first proposed changelog must reconcile the pre-existing manually
  populated [Unreleased] section and restore the v1.0.0/v1.1.0 history (#106);
  review it, do not accept duplicate or misleading release notes.
- This workflow is intentionally PR-only (skip-github-release: true).
  **Merging it does not create a GitHub Release or publish npm.**
- Configure a narrowly scoped RELEASE_PLEASE_TOKEN PAT secret for generated
  PRs to trigger CI, or modify this workflow to mint a short-lived GitHub App
  installation token on each run. Do not store an expiring App token as a
  long-lived secret. The default GITHUB_TOKEN fallback creates
  PRs but its events do not trigger pull_request Actions; maintainers must
  manually obtain and inspect CI checks on those generated PRs.
- Ensure repository Actions settings permit workflow-created pull requests.

A release PR that modifies `.release-please-manifest.json` or `CHANGELOG.md`
automatically runs the **full Reviewed release validation gate**. It uses the
four CUBRID 10.2/11.0/11.2/11.4 broker images rather than only the routine
11.4 PR lane, plus real SSL=ON and Node 18/20/22 packaged consumer
verification. Do not confuse the PR's proposed merge SHA with the final
post-merge commit: the manual publish workflow revalidates that exact commit
before tagging. Ordinary source PRs retain the existing faster 11.4 smoke
and their own CI.


The [v1.2.0 release decision record](RELEASE_DECISION.md) lists the
exact evidence, supported scope and unresolved **maintainer sign-off** needed
before this candidate can be published. Its approval checklist is not
automatically satisfied by a passing PR, version bump, or test count.

## GitHub Release note formatting

Write each paragraph as one logical Markdown source line, separated by a
blank line from the next paragraph. Write each bullet and its associated
issue/PR links on the **same source line**. Let GitHub wrap text to the
reader's screen width instead of adding hard line breaks in the middle
of a sentence or putting the citation on a continuation line.
Check the **published GitHub Release page**, not only the Markdown file,
after updating an existing release. `publish.yml` publishes the curated
`docs/releases/vX.Y.Z.md` as the Release description of each new version. To
correct an already published description after a reviewed merge of its source
note, run `gh release edit vX.Y.Z --title "cubrid-client vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md`;
this changes no tag or npm package. (The one-time historical synchronization
workflow finished its job on 2026-11-07 and was removed in
[#226](https://github.com/cubrid-lab/cubrid-client/issues/226).) The v0.2.0 tag
exists but has no historical GitHub Release page: its curated source note is
retained and no Release is created for it.

## Automated publication and recovery

1. Release Please proposes a reviewable PR that bumps `package.json`,
   `package-lock.json`, `.release-please-manifest.json`, and `CHANGELOG.md`.
   A version is **not published** merely because the PR exists.
2. Review the candidate notes and supported/unsupported behavior. The release
   PR automatically runs the **full four-version CUBRID matrix**, real
   CUBRID 11.4 SSL=ON certificate checks, Node 18/20/22 packed ESM/CJS
   smoke, API declaration verification, offline tests and security scans.
   Never merge while a required check has failed, been skipped or is absent.
3. **Merging the reviewed Release Please PR into `main` automatically
   triggers `Publish verified npm release`**. The workflow first verifies
   the version, package lockfile and manifest match, the curated note exists,
   a matching Release Please PR was merged, and no version tag or npm
   artifact already exists. It is idempotent: an existing GitHub Release
   is not generated twice.
4. The same automatic job repeats Node 18/20/22 preflight checks, high
   severity dependency audit and the complete four-version live database,
   TLS and packed npm consumer validation on the **exact main commit**.
   Any failure blocks tag creation and npm publication.
5. After every gate succeeds, the protected `npm-publish` environment
   creates the exact version tag from the validated main commit using
   `gh release create` and publishes npm. **Release Please remains the
   version/changelog PR generator**, while the publication job independently
   checks the reviewed PR/title and version files. This avoids relying on the
   mutable explanatory text of a human-reviewed Release Please PR.
   Use **npm Trusted Publishing (OIDC)** rather than a long-lived
   `NPM_TOKEN`: an npm package maintainer must first register the publisher
   for organization `cubrid-lab`, repository `cubrid-client`, workflow
   filename `publish.yml`, and environment `npm-publish`, with direct
   `npm publish` permission (not just staging). The publish job uses Node
   22, an npm 11 CLI supporting OIDC and existing `id-token: write`
   GitHub permissions. The published package's GitHub source must match
   this repository. **If the environment requires reviewers, GitHub still
   requests approval**; the automated trigger does not bypass protection.
6. The release job checks out the immutable tag and re-verifies the
   versions, API declarations, tests, package and audited dependencies,
   publishes the emoji-free curated Release notes under the title
   `cubrid-client vX.Y.Z`, then publishes the package. Finally it verifies
   that the exact version appears both in GitHub Releases and npm.
7. If npm publication fails **after a tag was created**, investigate the
   cause and use **Actions → Publish verified npm release → Run workflow**,
   `confirmation=PUBLISH`, `recovery_tag=vX.Y.Z`. The workflow validates
   that immutable tag instead of creating another release or changing tag
   history. This manual path is for recovery, not the standard release.
8. Release Please does **not** propose the following version until the
   current `package.json` version has both a GitHub Release and the **exact
   corresponding public npm version**. Missing or unavailable registry data
   fails closed; check the existing immutable tag and use explicit publication
   recovery instead of skipping a version. The new-release candidate gate also
   checks that the immediately preceding changelog version exists in npm. The old v1.3.0 proposal generated before v1.2.0 was
   tagged was closed without publishing.

The [v1.2.0 decision record](RELEASE_DECISION.md) and issues
[#106](https://github.com/cubrid-lab/cubrid-client/issues/106) and
[#120](https://github.com/cubrid-lab/cubrid-client/issues/120) document the
limited-scope release decision. Approval of a remediation release is
**not** a claim of universal production readiness.

The separate [release validation workflow](../.github/workflows/release-validation.yml)
is safe to run without publishing. Production-ready certification remains a
**distinct maintainer decision**: the existing 23 live cases do not prove every
CUBRID type, fault path, TLS version, transaction state or independent test
oracle. The workflow addresses mandatory database/TLS/npm packaging evidence,
but #117/#118/#120 and explicit human approval remain open.

The previous automatic v* tag-push publish trigger has been removed to avoid
unreviewed distribution and GITHUB_TOKEN tag event pitfalls. Provenance is
tracked separately in #101. Do not treat v1.2.0 or any 1.x release as
production-ready based only on version number: support and stability claims
must follow verified evidence, and limitations (#81/#82/#110/#116) must be
disclosed. v1.2.0 is a scoped remediation release (#106) until full gates exist.

The closed PR #67 (tsup v9) requires Node >=22.18 for the **build tool**, while runtime
Node support and current CI Node 18/20/22/24/26 are separate decisions. Review it
independently.

## npm registry authentication and failed-publication recovery

GitHub Releases and npm are separate registries. The existence of a
`vX.Y.Z` tag and a green database/TLS matrix **does not mean npm
published that version**; the final `npm view cubrid-client@X.Y.Z version`
check is mandatory.

For v1.2.0, the initial GitHub Release existed, but the npm publish step
failed with `E404` on `PUT https://registry.npmjs.org/cubrid-client`.
A read-only follow-up diagnostic (a temporary workflow, since removed) also
demonstrated that the previous `NPM_TOKEN` failed `npm whoami`:
[release run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42315470123),
[auth diagnostic](https://github.com/cubrid-lab/cubrid-client/actions/runs/42320289488).
Never create a different version to work around a registry credential failure.

An **npm package maintainer** must configure the Trusted Publisher under
npmjs.com → package `cubrid-client` → Settings → Trusted Publishing.
Set the provider to GitHub Actions, organization/user `cubrid-lab`,
repository `cubrid-client`, workflow `publish.yml`, environment
`npm-publish`, and enable direct `npm publish`. The package owner must
perform this one-time external-account operation. See the
[official npm setup](https://docs.npmjs.com/trusted-publishers/).

After that setup, use the existing Actions → Publish verified npm release
manual recovery with `confirmation=PUBLISH` and
`recovery_tag=v1.2.0`. This checks and republishes **the original
immutable tag** without creating or modifying another GitHub Release.
Confirm the actual npm registry version after the workflow succeeds.
This recovery was completed: v1.2.0 and v1.3.0 were published by
`publish.yml` through Trusted Publishing (npm publisher
`npm-oidc-no-reply@github.com`, SLSA provenance, `gitHead` equal to the tag
commit); see [#166](https://github.com/cubrid-lab/cubrid-client/issues/166).
No workflow reads `NPM_TOKEN` any more, so a maintainer may delete that secret.

## Release-note ownership and style

Release Please owns the generated `CHANGELOG.md` and semantic version bump.
Contributors describe user-visible changes in their PRs; **do not hand-add
Unreleased entries** to CHANGELOG because Release Please will also generate
entries from merged Conventional Commit titles. Review the generated release
PR against actual commits, rather than an anticipated issue milestone.

**Use concise, contributor-credited GitHub Release notes.** For all tagged versions, write `## vX.Y.Z (YYYY-MM-DD)`, optional `### Upgrade notes`, `### Features`, `### Bug Fixes` and other nonempty change sections, and end with `**Full Changelog:** vPREVIOUS...vCURRENT`. Each change or closely related group ends with `by @username`, using the verified PR author or tagged commit author (a bot receives plain attribution only, never a first-contribution celebration). Welcome a first-time contributor inline as `by @username (first contribution 🎉)` instead of adding a separate contributors section. Each change should appear once, not in both a Highlights list and a generated commit list.

Use one Markdown source line per change and do not insert hard wraps. Decorative emoji are disallowed in curated release notes and generated CHANGELOG content, except for the exact inline first-contribution celebration. The validation script enforces section order, attribution and duplicate PR references for all versioned source notes, including historical releases. GitHub Release descriptions are synced from reviewed source notes without rewriting immutable tags or republishing npm artifacts.

The historical v0.1.0, v0.2.0, v1.0.0, v1.1.0 and v1.2.0 notes are curated against immutable tag contents and the actual contributor/PR history. v0.1.0 credits the author of PR #1 as `@Copilot` without declaring a bot to be a first-time human contributor. The tagged v0.2.0 has no corresponding GitHub Release page; retaining a source note is not authorization to create one. Updating these files does not modify tag commits or npm artifacts.
Correct an existing GitHub Release description with the `gh release edit`
command under [GitHub Release note formatting](#github-release-note-formatting).
Verify the resulting GitHub Release pages; do not infer success from a
successfully merged source PR.

Each release has a compact human-reviewed `docs/releases/vX.Y.Z.md` file.
This file is the public GitHub Release body, not a second generated changelog:

- **Highlights / Fixes:** explain what a user experiences, normally one
  sentence per entry; include links to related PRs.
- **Compatibility:** Node.js runtime floor, API changes and *actually verified*
  CUBRID versions; never infer full broker compatibility from a unit test.
- **Known limitations:** data-loss risks, unsupported types or methods,
  missing live-version coverage and links to follow-up issues.
- **Validation and release scope:** distinguish offline CI from real broker
  execution, plus the review gate required for publishing.

The automated publish workflow verifies the curated file exists, contains all
required sections, has no placeholder text, and that CHANGELOG has a matching
generated version section with no duplicated [Unreleased] block. **Preflight
runs before creation of a GitHub tag**; exact-tag verification repeats the check
and applies the approved notes with `gh release edit` before npm publication.
If publication fails after tag creation, use `recovery_tag` and investigate.

For release v1.2.0, see `docs/releases/v1.2.0.md`. The notes alone do
not authorize publication: the automated gate checks actual release
content, npm package exports and live database evidence, and fails closed
on missing checks. Release scope remains bounded by documented tests.
