# Changelog

Release Please generates the change history from merged Conventional Commit PR titles.
This file is the **commit-level history**; the curated GitHub Release text for each
version lives in `docs/releases/vX.Y.Z.md`. Release notes must describe verified
user-visible behavior and known limitations, not just completed implementation.

## [1.3.0](https://github.com/cubrid-lab/cubrid-client/compare/v1.2.0...v1.3.0) (2026-11-06)


### Features

* add a read timeout for queries ([#128](https://github.com/cubrid-lab/cubrid-client/issues/128)) ([5fe9563](https://github.com/cubrid-lab/cubrid-client/commit/5fe95631eeb4b0cecff6a1c0b24e4e93e7f7b18c))
* add connection string URL parser and query helpers ([df67d44](https://github.com/cubrid-lab/cubrid-client/commit/df67d448283a8ecdbe32f57f0f0f66673ef90843))
* add EPIPE resilience, auto-retry, and health check ([#21](https://github.com/cubrid-lab/cubrid-client/issues/21)) ([65d06ad](https://github.com/cubrid-lab/cubrid-client/commit/65d06ad0f9a7e0eaecb06561d5a34fbf8bf26a24))
* add opt-in TLS/SSL support (P1) ([#55](https://github.com/cubrid-lab/cubrid-client/issues/55)) ([f8082b1](https://github.com/cubrid-lab/cubrid-client/commit/f8082b1829609d7bd897b28c745a8bfa86850646))
* add transaction methods to client (v0.3.0) ([0a7684a](https://github.com/cubrid-lab/cubrid-client/commit/0a7684a502acf63bd7f48763097b4adde8b642a5))
* implement native CAS binary protocol driver ([37525d0](https://github.com/cubrid-lab/cubrid-client/commit/37525d0c53f2a2b976b9b1c5d60df0160337188a))
* initialize @cubrid/client mvp ([2d8481f](https://github.com/cubrid-lab/cubrid-client/commit/2d8481ff0d13452ad3112b18b975db987c14ceeb))


### Bug Fixes

* **ci:** fix badge-sync action version [@v1](https://github.com/v1) → [@v0](https://github.com/v0).4.0 ([45a18dd](https://github.com/cubrid-lab/cubrid-client/commit/45a18dddce7e0555d3a36f0e30c6f829420c0fed))
* clear cached connection promise on factory failure (closes [#13](https://github.com/cubrid-lab/cubrid-client/issues/13)) ([6f009cc](https://github.com/cubrid-lab/cubrid-client/commit/6f009ccc6ba22bf5656ae0ed282772a27a0b01e0))
* correct BIGINT and collection CAS type codes ([#126](https://github.com/cubrid-lab/cubrid-client/issues/126)) ([1974cab](https://github.com/cubrid-lab/cubrid-client/commit/1974cabf0700c9375b629f5001288dab7fb6258c))
* correct CUBRID statement type codes ([#130](https://github.com/cubrid-lab/cubrid-client/issues/130)) ([3d60d60](https://github.com/cubrid-lab/cubrid-client/commit/3d60d60110f59952cef9f81e8d943d98e08f4864))
* escape parameters based on server no_backslash_escapes mode ([#52](https://github.com/cubrid-lab/cubrid-client/issues/52)) ([4b7c27b](https://github.com/cubrid-lab/cubrid-client/commit/4b7c27b2b04e20302009dd9f9b4c45ade0d5773c))
* interpolateParams comment parsing and Date UTC normalization ([6114499](https://github.com/cubrid-lab/cubrid-client/commit/6114499bf4e95f9d44e734db341f486754396341))
* pin typescript to 5.9.x to unblock typecheck ([#51](https://github.com/cubrid-lab/cubrid-client/issues/51)) ([5d6adc6](https://github.com/cubrid-lab/cubrid-client/commit/5d6adc6ffdcf4ae3fd884dfb70560e470025d57d))
* reconnect when CAS is released under KEEP_CONNECTION=AUTO (closes [#15](https://github.com/cubrid-lab/cubrid-client/issues/15)) ([#16](https://github.com/cubrid-lab/cubrid-client/issues/16)) ([9fb440a](https://github.com/cubrid-lab/cubrid-client/commit/9fb440a1f67300e16ccb2f05909f5d52468f45b8))
* reject failed FETCH responses and incomplete results ([#137](https://github.com/cubrid-lab/cubrid-client/issues/137)) ([a157ba4](https://github.com/cubrid-lab/cubrid-client/commit/a157ba452daec95b5f9f4f138be41220ac34958f))
* reject unsupported non-null CUBRID values ([#140](https://github.com/cubrid-lab/cubrid-client/issues/140)) ([fdc4df5](https://github.com/cubrid-lab/cubrid-client/commit/fdc4df59efacdc3c454d90451d6b8c76055c99fd))
* release CAS query handles on fetch and decoding failures ([#127](https://github.com/cubrid-lab/cubrid-client/issues/127)) ([1cda9b6](https://github.com/cubrid-lab/cubrid-client/commit/1cda9b6ab7e0356370fd321e666f8bdddc6233f3))
* remove spurious second plaintext read that deadlocks TLS connect ([#57](https://github.com/cubrid-lab/cubrid-client/issues/57)) ([#58](https://github.com/cubrid-lab/cubrid-client/issues/58)) ([aa14d87](https://github.com/cubrid-lab/cubrid-client/commit/aa14d87941ef42c26b3beef2d614dfa42d97e16c))
* resolve strict TypeScript errors in test files ([4f842e2](https://github.com/cubrid-lab/cubrid-client/commit/4f842e2f89d8659e605a8a2e49c7d1e1b17be326))
* route DDL/DML statements to execute() to avoid CAS_ER_NO_MORE_DATA ([b70ec20](https://github.com/cubrid-lab/cubrid-client/commit/b70ec20c13381dd0852163a8a37e1d70bb058cb8))
* serialize shared connection operations to fix concurrent-query race ([#39](https://github.com/cubrid-lab/cubrid-client/issues/39)) ([#56](https://github.com/cubrid-lab/cubrid-client/issues/56)) ([8888cd3](https://github.com/cubrid-lab/cubrid-client/commit/8888cd3f3d694b83b10d2d0cefae86c2f4fcaf51))
* use explicit test path for node --test runner ([379b3ff](https://github.com/cubrid-lab/cubrid-client/commit/379b3ffd27dab0136ae432a22cbff197746d35df))
* validate CAS frame lengths and retire sockets after bad frames ([#122](https://github.com/cubrid-lab/cubrid-client/issues/122)) ([e09ccff](https://github.com/cubrid-lab/cubrid-client/commit/e09ccffba0d3742fe1e28b9e46863989295ccf6e))

## [1.2.0](https://github.com/cubrid-lab/cubrid-client/compare/v1.1.0...v1.2.0)


### Features

* add a read timeout for queries ([#128](https://github.com/cubrid-lab/cubrid-client/issues/128)) ([5fe9563](https://github.com/cubrid-lab/cubrid-client/commit/5fe95631eeb4b0cecff6a1c0b24e4e93e7f7b18c))
* add connection string URL parser and query helpers ([df67d44](https://github.com/cubrid-lab/cubrid-client/commit/df67d448283a8ecdbe32f57f0f0f66673ef90843))
* improve EPIPE recovery and health checks (configurable connection retry count remains unsupported) ([#21](https://github.com/cubrid-lab/cubrid-client/issues/21)) ([65d06ad](https://github.com/cubrid-lab/cubrid-client/commit/65d06ad0f9a7e0eaecb06561d5a34fbf8bf26a24))
* add opt-in TLS/SSL support ([#55](https://github.com/cubrid-lab/cubrid-client/issues/55)) ([f8082b1](https://github.com/cubrid-lab/cubrid-client/commit/f8082b1829609d7bd897b28c745a8bfa86850646))


### Bug Fixes

* clear cached connection promise on factory failure (closes [#13](https://github.com/cubrid-lab/cubrid-client/issues/13)) ([6f009cc](https://github.com/cubrid-lab/cubrid-client/commit/6f009ccc6ba22bf5656ae0ed282772a27a0b01e0))
* correct BIGINT and collection CAS type codes ([#126](https://github.com/cubrid-lab/cubrid-client/issues/126)) ([1974cab](https://github.com/cubrid-lab/cubrid-client/commit/1974cabf0700c9375b629f5001288dab7fb6258c))
* correct CUBRID statement type codes ([#130](https://github.com/cubrid-lab/cubrid-client/issues/130)) ([3d60d60](https://github.com/cubrid-lab/cubrid-client/commit/3d60d60110f59952cef9f81e8d943d98e08f4864))
* escape parameters based on server no_backslash_escapes mode ([#52](https://github.com/cubrid-lab/cubrid-client/issues/52)) ([4b7c27b](https://github.com/cubrid-lab/cubrid-client/commit/4b7c27b2b04e20302009dd9f9b4c45ade0d5773c))
* pin typescript to 5.9.x to unblock typecheck ([#51](https://github.com/cubrid-lab/cubrid-client/issues/51)) ([5d6adc6](https://github.com/cubrid-lab/cubrid-client/commit/5d6adc6ffdcf4ae3fd884dfb70560e470025d57d))
* reconnect when CAS is released under KEEP_CONNECTION=AUTO (closes [#15](https://github.com/cubrid-lab/cubrid-client/issues/15)) ([#16](https://github.com/cubrid-lab/cubrid-client/issues/16)) ([9fb440a](https://github.com/cubrid-lab/cubrid-client/commit/9fb440a1f67300e16ccb2f05909f5d52468f45b8))
* reject failed FETCH responses and incomplete results ([#137](https://github.com/cubrid-lab/cubrid-client/issues/137)) ([a157ba4](https://github.com/cubrid-lab/cubrid-client/commit/a157ba452daec95b5f9f4f138be41220ac34958f))
* reject unsupported non-null CUBRID values ([#140](https://github.com/cubrid-lab/cubrid-client/issues/140)) ([fdc4df5](https://github.com/cubrid-lab/cubrid-client/commit/fdc4df59efacdc3c454d90451d6b8c76055c99fd))
* release CAS query handles on fetch and decoding failures ([#127](https://github.com/cubrid-lab/cubrid-client/issues/127)) ([1cda9b6](https://github.com/cubrid-lab/cubrid-client/commit/1cda9b6ab7e0356370fd321e666f8bdddc6233f3))
* remove spurious second plaintext read that deadlocks TLS connect ([#57](https://github.com/cubrid-lab/cubrid-client/issues/57)) ([#58](https://github.com/cubrid-lab/cubrid-client/issues/58)) ([aa14d87](https://github.com/cubrid-lab/cubrid-client/commit/aa14d87941ef42c26b3beef2d614dfa42d97e16c))
* serialize shared connection operations to fix concurrent-query race ([#39](https://github.com/cubrid-lab/cubrid-client/issues/39)) ([#56](https://github.com/cubrid-lab/cubrid-client/issues/56)) ([8888cd3](https://github.com/cubrid-lab/cubrid-client/commit/8888cd3f3d694b83b10d2d0cefae86c2f4fcaf51))
* validate CAS frame lengths and retire sockets after bad frames ([#122](https://github.com/cubrid-lab/cubrid-client/issues/122)) ([e09ccff](https://github.com/cubrid-lab/cubrid-client/commit/e09ccffba0d3742fe1e28b9e46863989295ccf6e))

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

## [0.2.0](https://github.com/cubrid-lab/cubrid-client/tree/v0.2.0) (2026-03-12)

### Added

- Initial TypeScript-first API for CUBRID queries and connection management.
- ESM and CommonJS package entry points.
