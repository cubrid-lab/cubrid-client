# ADR 0001: Release governance and compatibility contract

- **Status:** Proposed
- **Date:** 2026-11-07
- **Decision scope:** cubrid-client release and supported-consumer contract
- **Owner:** Repository maintainers (approval not yet recorded)

## Context

The CUBRID Lab language drivers and ORM adapters progressed at different rates. An optimistic package number, borrowed ORM backend, passing mocks or a green but empty integration job must not accidentally imply production readiness. The Python driver and SQLAlchemy dialect established useful regression evidence, but release rules must follow each ecosystem's real package manager and compatibility obligations.

## Decision

Use existing Node.js 1.x SemVer commitments; breaking observable API or Node runtime floor needs a MAJOR, compatible functionality a MINOR, compatible corrections a PATCH. A release is complete only after immutable tag, reviewed candidate checks, and successful npm registry publication are verified. Keep GitHub Release and npm state distinct; package.json currently reports 1.2.0 but the reviewed release decision file separately records a failed npm publish and npm still serving 1.1.0 as of its snapshot. Keep release-please reviewed PR, typed API checks, real CUBRID matrix, TLS and packed ESM/CJS consumption; do not silently change publishing workflows.

Applicable SemVer classification: a compatible bug/security fix is generally PATCH, an additive feature MINOR, and an incompatible public behavior or supported-environment change requires a reviewed breaking release (under current 0.x rules, commonly the next 0.y.0; at 1.x+ a MAJOR). Changes to SQL generation, data types, migrations or transactions can be compatibility-breaking without exported-type changes. A release candidate must have a reviewed version and notes, a final immutable commit, actual live CUBRID evidence when database behavior is claimed, and verified published artifacts. Keep omitted/failed checks visible; never invent approval or successful publication.

## Alternatives considered

- **Rejected:** Existing Node runtime/API promises matter more than copying the Python project's 28-day notice or equating a GitHub tag with registry availability.
- **Rejected:** One centrally synchronized release number and a generic Python-style policy for all languages; each distribution has separate SemVer, packaging and runtime constraints.
- **Rejected:** Treat an issue, green mock suite, GitHub tag or draft changelog as sufficient release evidence.

## Consequences and trade-offs

Preflight complexity and maintainer review are needed even for correctness-only releases. Existing 1.x API support commitments cannot be removed in a 1.x MINOR.

Maintainers must explicitly review the supported matrix and any runtime/API removal. Compatible fixes may be released independently when their own gates pass. Release automation can prepare PRs but must not bypass a maintainer review, exact candidate test or registry verification.

## Verification / acceptance criteria

- [ ] Maintainer reviews and accepts this ADR, links the approval and records acceptance date.
- [ ] Published README/release guide and dependency version declarations agree with the reviewed compatibility contract.
- [ ] A candidate-specific CI check identifies supported CUBRID server versions, tests run/passed/failed/skipped, runtime and driver/ORM versions, and actual artifact.
- [ ] Required release checks reject failed, missing, zero-case or skipped live tests, with scoped exceptions documented as unsupported/unverified—not counted as passes.
- [ ] User-visible breaking changes have accurate migration notes; correct author attribution in curated release notes comes from verified merged contributions.
- [ ] Existing immutable tags and published versions remain untouched by adopting this ADR.

## References

[API stability](../API_STABILITY.md), [release process](../RELEASE_PROCESS.md), [reviewed v1.2.0 decision](../RELEASE_DECISION.md)

**This ADR does not update version numbers, create a release, authorize publishing, or claim any database test has passed.** Its status remains **Proposed** until explicit maintainer approval.
