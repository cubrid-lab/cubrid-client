# Downstream consumer inventory (1.x)

> **Snapshot:** 2026-11-23. cubrid-client `main` at `5376037`; npm `latest` is
> 1.6.0. Tracks [#300](https://github.com/cubrid-lab/cubrid-client/issues/300).
> This is evidence for the v2 review in [ADR 0011](adr/0011-v2-binding-option-and-driver-subpath.md)
> (still **Proposed**) and [V2_INTERFACE_REVIEW.md](V2_INTERFACE_REVIEW.md). It
> records what consumers use of **1.x**. It does not evaluate the v2 proposal, and
> a passing compile fixture does not show runtime compatibility.

Every link below points at a pinned commit, so the line numbers stay valid. Rerun
the searches before relying on this page after the snapshot date.

## How consumers were found

| Source | Query | Result on 2026-11-23 |
| --- | --- | --- |
| npm registry search | `/-/v1/search?text=cubrid-client`, `text=keywords:cubrid`, `text=cubrid` | 7 packages mention CUBRID. 2 depend on cubrid-client: `drizzle-cubrid` (peer) and `cubrid-mcp` (dependency). `node-cubrid`, `migrate-cubrid-to-mysql`, `pdo` and `@benny1hk/pdo` do not (checked with `npm view <name> dependencies peerDependencies`) |
| GitHub dependency graph | `github.com/cubrid-lab/cubrid-client/network/dependents` | 0 repositories, 2 packages: `cubrid-lab/drizzle-cubrid`, `xhdndi81/cubrid-mcp` |
| cubrid-lab organization | every `package.json` in all 19 repositories (`gh repo list cubrid-lab`, then each repository's git tree) | `drizzle-cubrid/package.json` and `cubrid-benchmark/typescript/package.json` depend on it. No other repository has a `package.json` naming it |
| GitHub code search | `cubrid-client org:cubrid-lab`; `cubrid-client language:TypeScript`; `cubrid-client language:JavaScript`; `"cubrid-client" filename:package.json` | Only `cubrid-rs` documents in the organization (a Rust crate of the same name, not an npm consumer). Outside it, 0 TypeScript hits and 2 unrelated JavaScript hits. The search missed `drizzle-cubrid` and `cubrid-benchmark`, so it is not a reliable negative |

### Limitations

- Private repositories, application code that never publishes a `package.json`
  to GitHub, and other registries or mirrors cannot be searched. A consumer that
  vendors or bundles the package is invisible to all four sources.
- GitHub code search covers only indexed default branches, and its index
  missed two known consumers. The dependency graph missed `cubrid-benchmark`
  (a nested `typescript/package.json`).
- npm has no public "dependents" endpoint; the registry search matches names,
  descriptions and keywords only.
- Mentions in documents (`showcase` press kits and event appendices,
  `cubrid-rs`, `sqlalchemy-cubrid`) are not consumers and are not listed.

## Consumers

| Consumer | Kind | Pinned revision | Accepts | Installs | Types against | Fixture |
| --- | --- | --- | --- | --- | --- | --- |
| [cubrid-lab/drizzle-cubrid](https://github.com/cubrid-lab/drizzle-cubrid) | npm library (`drizzle-cubrid` 0.3.2), Drizzle ORM dialect | `main` at [`0035410`](https://github.com/cubrid-lab/drizzle-cubrid/tree/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0) (npm 0.3.2 is tag `v0.3.2`, `3af5258`) | peer `>=1.4.0 <2.0.0` ([package.json:128](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/package.json#L128)) | dev `^1.6.0`, lock 1.6.0 ([package.json:134](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/package.json#L134)) | `CubridClient`, `CubridPool` (types); error classes (values); its own structural interfaces | [`tests/consumer-fixtures/drizzle-cubrid.ts`](../tests/consumer-fixtures/drizzle-cubrid.ts) |
| [cubrid-lab/cubrid-benchmark](https://github.com/cubrid-lab/cubrid-benchmark) `typescript/` | private benchmark package | `main` at [`fcecf40`](https://github.com/cubrid-lab/cubrid-benchmark/tree/fcecf40566d52b1eed47af8101a543e7bf372112) | `^1.1.0` ([typescript/package.json:12](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/package.json#L12)) | lock 1.1.0 | `CubridClient` (type), `createClient` | [`tests/consumer-fixtures/cubrid-benchmark.ts`](../tests/consumer-fixtures/cubrid-benchmark.ts) |
| [xhdndi81/cubrid-mcp](https://github.com/xhdndi81/cubrid-mcp) | npm application (`cubrid-mcp` 1.0.3), MCP server; outside the organization | [`876117d`](https://github.com/xhdndi81/cubrid-mcp/tree/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77), the `gitHead` of npm 1.0.3 | `^1.1.0` ([package.json:42](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/package.json#L42)) | lock 1.1.0 | nothing (plain JavaScript) | [`tests/consumer-fixtures/cubrid-mcp.ts`](../tests/consumer-fixtures/cubrid-mcp.ts) |

### drizzle-cubrid

Two entry points reach cubrid-client: the default (`.` and `./native`, the
native session) and `./legacy` (the deprecated 0.x session over Drizzle's MySQL
classes). Neither imports an SPI type, `NativeCubridAdapter`, `CubridTransaction`,
`queryResult*`, `executeMany` or `beginTransactionScope`. Base URL:
`https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/`.

| 1.x API | How it is used | Where |
| --- | --- | --- |
| `import type { CubridClient }` | Default of `TClient extends CubridQueryable` in the legacy `drizzle()` | [src/driver.ts:12](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/driver.ts#L12), [:147-164](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/driver.ts#L147-L164) |
| `CubridClient`, `CubridPool` assignable to `CubridNativeClient` | Native `drizzle<TClient extends CubridNativeClient>(client)`, used with a client and a pool in its type tests | [src/native/db.ts:205-208](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/db.ts#L205-L208), [tests/native/dml.test-d.ts:36-37](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/tests/native/dml.test-d.ts#L36-L37), [tests/native/relational.test-d.ts:11](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/tests/native/relational.test-d.ts#L11) |
| Structural `CubridQueryable` (legacy): `query` with and without `{ rowMode: "array" }`, optional `queryPrepared` (same overloads), `executePrepared`, `execute`, `transaction(callback, options?)`, `beginTransaction`, `commit`, `rollback`; `params: readonly unknown[] \| undefined` | The only way the legacy session reaches the driver | [src/session.ts:88-128](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L88-L128) |
| Structural `CubridNativeClient`: `query`, `queryPrepared`, `execute`, `executePrepared` (options `{ generatedKeys: true }`), `stream(sql, params, { rowMode: "array", signal?, fetchSize?, consumerTimeout? })`, `transaction(callback, { isolationLevel? })` | The only way the native session reaches the driver | [src/native/session.ts:80-143](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L80-L143), [:211-264](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L211-L264) |
| `queryPrepared`, `executePrepared` (default binding) or `query`, `execute` (`binding: "literal"`) | Picks the method by presence; refuses rather than falling back | [src/session.ts:188-225](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L188-L225), [src/native/session.ts:456-458](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L456-L458), [:531-541](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L531-L541) |
| `query(sql, params)`, `query(sql, params, { rowMode: "array" })`, `execute(sql, params)` | Statements, positional rows, counts | [src/session.ts:359-370](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L359-L370), [:418](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L418), [:518](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L518), [:530](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L530) |
| `execute`/`executePrepared(..., { generatedKeys: true })`; `ExecuteResult.affectedRows`, `lastInsertId` | `$returningId()` with AUTO_INCREMENT | [src/native/dml.ts:294](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/dml.ts#L294), [src/native/session.ts:538-541](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L538-L541) |
| `stream()` with array rows | `iterator()`; refused under prepared binding unless `{ literal: true }` (#307) | [src/native/session.ts:498-521](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L498-L521) |
| `transaction(callback)`, `transaction(callback, { isolationLevel })`; the callback's `tx` used as the same structural interface | `db.transaction()`, relational reads in one snapshot (`repeatable read`) | [src/session.ts:540-570](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L540-L570), [src/native/session.ts:562-591](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L562-L591), [:619-636](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L619-L636) |
| Deprecated `beginTransaction()`, `commit()`, `rollback()` on the client | Legacy fallback when the value has no `transaction()` | [src/session.ts:601-632](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/session.ts#L601-L632) |
| `TransactionError` (`instanceof`), `new ConstraintError/SqlSyntaxError/DeadlockError/LockTimeoutError/QueryError(message, options)`; `kind`, `cause`, `rollbackError` | Gives a relational read's statement error the class it has outside a transaction | [src/native/session.ts:3-10](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L3-L10), [:52-77](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L52-L77), [:592-599](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/session.ts#L592-L599) |
| `timezone` (public, `TimezoneAware`); private `config.timezone`, `connection.utcDates` and `constructor.name` as fallbacks | Refuses temporal columns unless the client decodes in UTC | [src/timezone.ts:18-62](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/timezone.ts#L18-L62), [src/native/timezone.ts:21-60](https://github.com/cubrid-lab/drizzle-cubrid/blob/0035410ba87b5fbe0eb3d7f35df003fae1fd68d0/src/native/timezone.ts#L21-L60) |

### cubrid-benchmark (`typescript/`)

Base URL: `https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/`.

| 1.x API | Where |
| --- | --- |
| `createClient({ host, port, database, user, password })` returning `CubridClient` | [helpers.ts:4](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L4), [:10](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L10), [:21-29](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L21-L29), [benchflow_worker.ts:16](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/benchflow_worker.ts#L16), [:121-127](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/benchflow_worker.ts#L121-L127) |
| `query(sql, params)` with a mutable array of its own `QueryParam` (`string \| number \| boolean \| bigint \| Date \| Buffer \| null`); `query(sql)`; rows read by label | [helpers.ts:7](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L7), [:41-47](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L41-L47), [benchflow_worker.ts:129-141](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/benchflow_worker.ts#L129-L141) |
| `close()` | [helpers.ts:49-51](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/helpers.ts#L49-L51), [benchflow_worker.ts:135-137](https://github.com/cubrid-lab/cubrid-benchmark/blob/fcecf40566d52b1eed47af8101a543e7bf372112/typescript/benchflow_worker.ts#L135-L137) |

### cubrid-mcp

Base URL: `https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/`.

| 1.x API | Where |
| --- | --- |
| `createClient(config)` as an injectable factory, with `{ host, port, database, user, password, connectionTimeout }` | [src/database.js:1](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L1), [:31-42](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L31-L42), [src/config.js:58-70](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/config.js#L58-L70) |
| `query(sql, params)` with strings and numbers, raced against its own timer | [src/database.js:53-69](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L53-L69), [:72](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L72), [:82](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L82), [:175](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L175) |
| `close()`, also while a timed-out query is still pending | [src/database.js:44-50](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L44-L50), [:62-64](https://github.com/xhdndi81/cubrid-mcp/blob/876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77/src/database.js#L62-L64) |

## Compile fixtures

[`tests/consumer-fixtures/`](../tests/consumer-fixtures/) has one file per
consumer. Each states the consumer's 1.x usage in TypeScript and is compiled
twice in CI (`ci.yml`):

- by `npm run typecheck` (also in `npm run check`), against the source types
  (`src/index.ts`);
- by `npm run types:packed`, against the **packed** package: the fixtures are
  copied into temporary consumers with `node_modules/cubrid-client` unpacked
  from `npm pack`, their import rewritten to `"cubrid-client"`, and compiled with
  `skipLibCheck: false` once through the package's `exports` (ESM,
  `dist/index.d.ts`) and once with `"cubrid-client"` mapped to
  `dist/index.d.cts` (CJS declarations). Network-free.

- drizzle-cubrid reaches the driver only through structural interfaces whose
  members are optional and detected at run time, so a client that lost a method
  would still be assignable. The fixture copies both interfaces and requires a
  client, a pool, a leased connection and both transaction clients to satisfy
  `Required<...>` of them (minus the members each surface does not have), then
  makes every call drizzle-cubrid makes directly on the 1.x types.
- cubrid-benchmark's helpers are reproduced with their own parameter type.
- cubrid-mcp is JavaScript; the fixture types its config object, its factory
  injection and its calls.

Checked on 2026-11-23 by breaking one consumer-used signature at a time in
`src/` (not committed); `npm run typecheck` failed in the fixtures each time:

| Temporary change | Fixture errors |
| --- | --- |
| `ExecuteOptions.generatedKeys` renamed | `drizzle-cubrid.ts`: 7 (surface checks and both `generatedKeys` calls) |
| `CubridClient.beginTransaction()` renamed | `drizzle-cubrid.ts`: legacy surface and the direct call |
| `ArrayRowOptions.rowMode` changed from `"array"` | `drizzle-cubrid.ts`: every surface check |
| `ClientOptions.port` typed `string` | `cubrid-benchmark.ts`: 2; `cubrid-mcp.ts`: 2 |

The packed check was proved the same way: with `generatedKeys` renamed only in
the built `dist/index.d.cts`, `types:packed` failed the `fixtures-cjs` consumer and
passed `fixtures-esm`; renamed only in `dist/index.d.ts`, it failed
`fixtures-esm` and passed `fixtures-cjs`.

## Runtime behavior the fixtures cannot check

Types show that the calls still compile. These behaviors are what the consumers
rely on at run time; none is checked by the fixtures, and none is established by
this page:

- drizzle-cubrid reads the private `config.timezone`, `connection.utcDates` and
  `constructor.name` when the public `timezone` is missing, and tests
  `transaction.length >= 2` to know that `transaction()` takes options.
- drizzle-cubrid relies on `TransactionError` wrapping a callback failure with
  `cause`, `kind`, `rollbackError`; on `lastInsertId` being left out when there is
  none; on `stream()`'s `return()` closing the cursor on early exit; on
  `Buffer`-only binary parameters, arrays refused as parameters, NUMERIC as a
  string, BIGINT as a `bigint`, collections as arrays and `Date` decoding.
- cubrid-mcp calls `close()` while a query it gave up on is still pending, and
  passes `connectionTimeout`.
- cubrid-benchmark runs one statement at a time per client.

These belong to the runtime contract in #300 item 3, against a real broker.

## Not covered here (blocked on ADR 0011)

- Compiling these fixtures against the proposed 2.0 mock (`tests/v2-api-mock/`)
  and recording which break: the mock is a proposal until ADR 0011 is decided.
- Runtime verification against a real broker of the proposed SPI and binding
  path, and ESM/CJS packed-package smoke for `cubrid-client/driver`: both need
  the implementation.
- The compatibility matrix of proposed behavior (#300 item 5).
