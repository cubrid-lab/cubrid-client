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
   offline tests and builds on Node 18/20/22.
5. The manual workflow then uses release-please to create the immutable
   GitHub release/tag, checks out that exact tag, verifies package.json,
   package-lock.json and manifest versions, runs tests/build/npm pack and
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

Open PR #71 (triage) may need a conflict resolution; PR #67 (tsup v9) requires
Node >=22.18 for the **build tool**, while runtime Node support and current
CI Node 18/20/22 are separate decisions. Review those PRs independently.
