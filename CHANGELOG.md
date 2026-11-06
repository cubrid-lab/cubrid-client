# Changelog

Release Please generates the change history from merged Conventional Commit PR titles.
This file is the **commit-level history**; the curated GitHub Release text for each
version lives in `docs/releases/vX.Y.Z.md`. Release notes must describe verified
user-visible behavior and known limitations, not just completed implementation.

## [1.1.0](https://github.com/cubrid-lab/cubrid-client/releases/tag/v1.1.0) (2026-03-17)

### Fixes

- Improve SQL parameter interpolation and UTC date handling.
- Correct strict TypeScript test compilation issues.

### Historical clarification

- The published v1.1.0 GitHub Release description mentioned URL connection parsing
  and query helpers, but their implementation commit was after the v1.1.0 tag.
  Those changes belong to a subsequent release, not the v1.1.0 tagged package.

## [1.0.0](https://github.com/cubrid-lab/cubrid-client/releases/tag/v1.0.0) (2026-03-14)

### Changes

- Replace the default `node-cubrid` adapter with a native TypeScript CAS implementation.

### Historical clarification

- The original announcement listed offline test coverage and an integration test
  count. These figures did **not** establish that live CUBRID integration tests
  were required or passed in release CI. See [#119](https://github.com/cubrid-lab/cubrid-client/issues/119)
  and the [release validation gate](https://github.com/cubrid-lab/cubrid-client/issues/120).
- Documented protocol correctness limitations were discovered later; consult current
  release notes and the issue tracker rather than treating v1.0.0 as production-certified.

## [0.2.0](https://github.com/cubrid-lab/cubrid-client/releases/tag/v0.2.0) (2026-03-12)

### Added

- Initial TypeScript-first API for CUBRID queries and connection management.
- ESM and CommonJS package entry points.
