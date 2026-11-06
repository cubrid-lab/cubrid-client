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

## Human-approved publication and recovery

1. Review and merge the version/changelog Release PR.
2. Record live CUBRID verification for advertised support versions and types,
   TLS and transaction behavior before approving publication (#95/#120).
   A successful offline test suite is not live protocol validation.
3. Configure the npm-publish GitHub Environment with required reviewers and
   suitable branch protections. Keep NPM_TOKEN restricted to npm publishing.
4. Run Actions -> Publish reviewed npm release -> Run workflow and type PUBLISH.
   Leave recovery_tag empty for a new release. This first runs typecheck,
   offline tests and builds on Node 18/20/22, and a mandatory full-dependency high/critical audit on Node 22 **before** creating a tag.
5. The manual workflow then uses release-please to create the immutable
   GitHub release/tag, checks out that exact tag, verifies package.json,
   package-lock.json and manifest versions, repeats npm audit (high and above, see
   SECURITY.md) on the immutable tag, runs tests/build/npm pack and
   publishes via NPM_TOKEN.
6. If npm publishing fails after GitHub Release creation, rerun with
   recovery_tag=vX.Y.Z; the workflow uses the existing immutable tag and
   avoids republishing an already-present npm version. Investigate failures
   before retries and verify GitHub/npm versions match after success.

The previous automatic v* tag-push publish trigger has been removed to avoid
unreviewed distribution and GITHUB_TOKEN tag event pitfalls. Provenance is
tracked separately in #101. Do not treat v1.2.0 or any 1.x release as
production-ready based only on version number: support and stability claims
must follow verified evidence, and limitations (#81/#82/#110/#116) must be
disclosed. v1.2.0 is a scoped remediation release (#106) until full gates exist.

PR #67 (tsup v9) requires Node >=22.18 for the **build tool**, while runtime
Node support and current CI Node 18/20/22 are separate decisions. Review it
independently.

## Release-note ownership and style

Release Please owns the generated `CHANGELOG.md` and semantic version bump.
Contributors describe user-visible changes in their PRs; **do not hand-add
Unreleased entries** to CHANGELOG because Release Please will also generate
entries from merged Conventional Commit titles. Review the generated release
PR against actual commits, rather than an anticipated issue milestone.

**No emoji in release notes or the generated changelog.** Use plain-language headings
and ordinary Markdown bullets without pictograms. CI checks all versioned
`docs/releases/*.md` files and `CHANGELOG.md` before review or publication.
The rule applies to historical corrections as well as future releases.

The v1.0.0 and v1.1.0 published release descriptions contained either emoji,
unverified coverage language, or changes not present in their tags. Their
corrected, emoji-free archived notes live in `docs/releases/v1.0.0.md` and
`docs/releases/v1.1.0.md`. Updating these files does not modify tag commits.
The separate historical-release synchronization workflow updates the existing
GitHub Release descriptions and titles after a reviewed merge to `main`.
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

The manual publish workflow verifies the curated file exists, contains all
required sections, has no placeholder text, and that CHANGELOG has a matching
generated version section with no duplicated [Unreleased] block. **Preflight
runs before creation of a GitHub tag**; exact-tag verification repeats the check
and applies the approved notes with `gh release edit` before npm publication.
If publication fails after tag creation, use `recovery_tag` and investigate.

For the current release candidate see `docs/releases/v1.2.0.md`. This file
does not authorize publication by itself: unresolved correctness issues,
live CUBRID tests, npm contents and the release-gate checklist must still be
reviewed. A generated release PR with absent CI checks or an incomplete DB
matrix is not evidence of a successful production-ready release.
