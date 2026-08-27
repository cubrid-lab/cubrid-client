# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **TLS/SSL support** (P1): opt-in client-side TLS for connecting to SSL-enabled CUBRID brokers (`SSL=ON`). Set `ssl: true` on `createClient` for default certificate verification, or pass a `ClientSSLOptions` object (`rejectUnauthorized`, `ca`, `servername`) for self-signed / private-CA certificates. The client performs a STARTTLS-style upgrade on the same broker port: it sends the SSL client magic (`CUBRS`), reads the CAS `NO_ERROR` acknowledgement, then upgrades the socket to TLS (minimum TLS 1.2, `rejectUnauthorized: true` by default) before the database login. The plaintext path is unchanged when `ssl` is omitted. Live `SSL=ON` broker validation is the deferred release gate.


### Fixed
- **Data corruption in parameterized queries** (P0): string parameters were always escaped using MySQL-style backslash rules (`\` → `\\`, `\n` → `\\n`, etc.), which corrupts data on CUBRID servers where `no_backslash_escapes=yes` (the CUBRID default) — a backslash there is a literal character, so it was being wrongly doubled. The client now probes the server (`SELECT CHAR_LENGTH('\')`) once per physical connection and pins the correct escaping mode, re-negotiating after reconnect. In literal mode only the single quote is doubled; in escape mode backslashes and CR/LF are escaped as well. String parameters containing NUL (`0x00`) or Ctrl-Z (`0x1A`) are now rejected with a `QueryError` (use a `Buffer` for binary data).

### Changed
- CI now runs the integration test file (`tests/integration.test.ts`) and emits a visible warning annotation when no live CUBRID server is available, instead of silently omitting integration coverage. Documented the real `npm run test:integration` workflow (no `docker compose` file is shipped).
- Updated all repository references from the old `cubrid-labs` GitHub org to the canonical `cubrid-lab` org (`package.json` URLs, README, docs, workflows, issue templates).
- Pinned `@types/node` to `^18.19.0` to match the declared `engines.node >= 18` floor (previously `^26.0.0`, which typed APIs unavailable on the minimum supported runtime).

### Documentation
- Documented that `Date` parameters are serialized in **UTC** (`DATETIME'...'` with millisecond precision), since CUBRID's `DATETIME` type is timezone-less.

## [0.3.0] - 2026-03-13

### Added
- Transaction support: `beginTransaction()`, `commit()`, `rollback()`
- Connection pool management improvements

## [0.2.0] - 2026-03-12

### Added
- Initial public release
- TypeScript-first CUBRID client with full type safety
- Query execution with parameterized queries
- Connection management
- Dual module format (ESM + CJS)
