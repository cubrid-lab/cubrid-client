# Changelog

Release Please generates the change history from merged Conventional Commit PR titles.
This file is the **commit-level history**; the curated GitHub Release text for each
version lives in `docs/releases/vX.Y.Z.md`. Release notes must describe verified
user-visible behavior and known limitations, not just completed implementation.

## [1.3.0](https://github.com/cubrid-lab/cubrid-client/compare/v1.2.0...v1.3.0) (2026-11-07)


### Features

* add configurable transaction isolation and lock timeout ([#209](https://github.com/cubrid-lab/cubrid-client/issues/209)) ([312f9ea](https://github.com/cubrid-lab/cubrid-client/commit/312f9eaf92c9fbe596e4c28ef4fed63cd587a35d))
* add opt-in server-side prepared parameter binding ([#207](https://github.com/cubrid-lab/cubrid-client/issues/207)) ([9258f6f](https://github.com/cubrid-lab/cubrid-client/commit/9258f6f53a64f58273262427af00b6341cab44ac))
* add schema introspection APIs with safe close lifecycle ([#206](https://github.com/cubrid-lab/cubrid-client/issues/206)) ([0d437b9](https://github.com/cubrid-lab/cubrid-client/commit/0d437b94ab1abdd9db6da0a743934d3266745d27))
* decode timezone-aware values as ZonedDateTime and document JSON as text ([#204](https://github.com/cubrid-lab/cubrid-client/issues/204)) ([da1ac1d](https://github.com/cubrid-lab/cubrid-client/commit/da1ac1d41f2782aae022909b4624734b5c77c9b9))
* emit redacted diagnostics to the logger option ([#182](https://github.com/cubrid-lab/cubrid-client/issues/182)) ([7251a78](https://github.com/cubrid-lab/cubrid-client/commit/7251a78097dfaea547792732415a01688a4e877b))
* expose result column metadata through queryResult() ([#198](https://github.com/cubrid-lab/cubrid-client/issues/198)) ([adf0353](https://github.com/cubrid-lab/cubrid-client/commit/adf0353d0a17696811fdf1829654b83103476f5a))
* expose the CUBRID server version through the public client API ([#193](https://github.com/cubrid-lab/cubrid-client/issues/193)) ([ae25eda](https://github.com/cubrid-lab/cubrid-client/commit/ae25eda8f38f50180781c86d2143d614305eb9cf))
* preserve CUBRID error codes and add specific error classes ([#183](https://github.com/cubrid-lab/cubrid-client/issues/183)) ([0f4e180](https://github.com/cubrid-lab/cubrid-client/commit/0f4e180361778620f26d1c808aca75eb481fe626))
* read BLOB and CLOB contents instead of server file locators ([#194](https://github.com/cubrid-lab/cubrid-client/issues/194)) ([e938bba](https://github.com/cubrid-lab/cubrid-client/commit/e938bba3d008b04dd6b48a6b6db247c463e8d87e)), closes [#93](https://github.com/cubrid-lab/cubrid-client/issues/93)
* retry a failed TCP connect with maxConnectionRetryCount ([#191](https://github.com/cubrid-lab/cubrid-client/issues/191)) ([4be8ae0](https://github.com/cubrid-lab/cubrid-client/commit/4be8ae023d931e9f629a6c0871280e9f58b1cd69))
* return affected row count and last insert ID from execute() ([#192](https://github.com/cubrid-lab/cubrid-client/issues/192)) ([c97661e](https://github.com/cubrid-lab/cubrid-client/commit/c97661edfed7c092c824dbfaac9782e9c49773a4))
* stream CUBRID result sets with bounded memory ([#212](https://github.com/cubrid-lab/cubrid-client/issues/212)) ([849bed8](https://github.com/cubrid-lab/cubrid-client/commit/849bed82358047fb02edfad544c4c586a6863f85))


### Bug Fixes

* block later statements after the server aborts a transaction ([#195](https://github.com/cubrid-lab/cubrid-client/issues/195)) ([ed75262](https://github.com/cubrid-lab/cubrid-client/commit/ed75262355fa455edc7f418373207dbb4d33ac74))
* decode an empty top-level BIT value as an empty Buffer ([#197](https://github.com/cubrid-lab/cubrid-client/issues/197)) ([c2735ca](https://github.com/cubrid-lab/cubrid-client/commit/c2735caeb340c1f47c40809e60a3fc2bc3f16b24))
* decode collection columns without corrupting adjacent values ([#167](https://github.com/cubrid-lab/cubrid-client/issues/167)) ([bba0622](https://github.com/cubrid-lab/cubrid-client/commit/bba0622b5c39ba5ff79d15bb06d8d0146e6bfd98))
* decode years 1 to 99 without shifting them into the 1900s ([#211](https://github.com/cubrid-lab/cubrid-client/issues/211)) ([7e30dee](https://github.com/cubrid-lab/cubrid-client/commit/7e30deee3deee410338178ac88a36093fecfe639))
* keep a manual transaction open across ping ([#181](https://github.com/cubrid-lab/cubrid-client/issues/181)) ([a4a84bd](https://github.com/cubrid-lab/cubrid-client/commit/a4a84bd2368e1db6882f4d30ef5721fb64a26a8f)), closes [#170](https://github.com/cubrid-lab/cubrid-client/issues/170)
* keep the CAS session across autocommit statements ([#205](https://github.com/cubrid-lab/cubrid-client/issues/205)) ([310465b](https://github.com/cubrid-lab/cubrid-client/commit/310465bacf1da3aad6dba2a8df62029cada6009f)), closes [#171](https://github.com/cubrid-lab/cubrid-client/issues/171) [#185](https://github.com/cubrid-lab/cubrid-client/issues/185)
* limit the connection handshake when readTimeout is unset ([#199](https://github.com/cubrid-lab/cubrid-client/issues/199)) ([c60ebce](https://github.com/cubrid-lab/cubrid-client/commit/c60ebce7fc6e80044c7267730fa13bb64f37da72))
* make transaction callbacks single-owner and single-completion ([#164](https://github.com/cubrid-lab/cubrid-client/issues/164)) ([f6a1fb8](https://github.com/cubrid-lab/cubrid-client/commit/f6a1fb809d2e49c0e1017828020c31167b9694c5)), closes [#109](https://github.com/cubrid-lab/cubrid-client/issues/109)
* read the backslash escape mode again on each new session ([#188](https://github.com/cubrid-lab/cubrid-client/issues/188)) ([59d6f3e](https://github.com/cubrid-lab/cubrid-client/commit/59d6f3e8fe7e5f44445f271927bb6973ee4eeb83))
* reject a FETCH reply that ends before its declared rows ([#187](https://github.com/cubrid-lab/cubrid-client/issues/187)) ([8b48e9d](https://github.com/cubrid-lab/cubrid-client/commit/8b48e9d333abd2bfce0fdb8d31d3de5d1f18803d))
* reject queries after close instead of reopening the connection ([#200](https://github.com/cubrid-lab/cubrid-client/issues/200)) ([2daa03c](https://github.com/cubrid-lab/cubrid-client/commit/2daa03c617f94b38ce72c0649cae8e10dc59fd20))
* reject truncated EXECUTE replies on the literal path ([#213](https://github.com/cubrid-lab/cubrid-client/issues/213)) ([b3cbfe8](https://github.com/cubrid-lab/cubrid-client/commit/b3cbfe8efa272ddc31897edcf47576a741397b90))
* reject zero dates instead of decoding them as 1899 values ([#186](https://github.com/cubrid-lab/cubrid-client/issues/186)) ([d860171](https://github.com/cubrid-lab/cubrid-client/commit/d8601717ae9c80bc34df7c99e2d56647274ebee8))
* run statements on one connection one at a time ([#169](https://github.com/cubrid-lab/cubrid-client/issues/169)) ([f3f5ae1](https://github.com/cubrid-lab/cubrid-client/commit/f3f5ae14c2a4793caa378afa04050ae2bc5ab65b))
* stop returning SQL NULL for unsupported values and drop damaged sessions ([#177](https://github.com/cubrid-lab/cubrid-client/issues/177)) ([e06a871](https://github.com/cubrid-lab/cubrid-client/commit/e06a8712c8b14df7afc6df6e69538d52bf20c7eb))

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
