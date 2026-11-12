<!-- CUBRID-LAB-ICON:START -->
<p align="center">
  <a href="https://github.com/cubrid-lab/brand"><img src="https://raw.githubusercontent.com/cubrid-lab/brand/e55990a6a0b2c3b0d133985951d41e42b62a8588/dist/icons/cubrid-client.svg" alt="CUBRID Lab Driver icon (TypeScript)" width="120"></a>
</p>
<!-- CUBRID-LAB-ICON:END -->

# cubrid-client

**Modern TypeScript-first Node.js client for the CUBRID database** — zero native dependencies, built-in CAS protocol driver, Promise-based API with full type safety.

<!-- BADGES:START -->
[![npm version](https://img.shields.io/npm/v/cubrid-client)](https://www.npmjs.com/package/cubrid-client)
[![node version](https://img.shields.io/node/v/cubrid-client)](https://nodejs.org)
[![ci workflow](https://github.com/cubrid-lab/cubrid-client/actions/workflows/ci.yml/badge.svg)](https://github.com/cubrid-lab/cubrid-client/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/cubrid-lab/cubrid-client/branch/main/graph/badge.svg)](https://codecov.io/gh/cubrid-lab/cubrid-client)
[![license](https://img.shields.io/github/license/cubrid-lab/cubrid-client)](https://github.com/cubrid-lab/cubrid-client/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/cubrid-lab/cubrid-client)](https://github.com/cubrid-lab/cubrid-client)
<!-- BADGES:END -->

## Why cubrid-client?

A modern CUBRID client that speaks the CAS binary protocol directly over TCP — no legacy driver dependencies, no native bindings.

| Feature | cubrid-client |
|---------|---------------|
| Protocol | Native CAS binary over TCP |
| Dependencies | Zero runtime dependencies |
| API style | Pure async/await |
| TypeScript | Full generics (`query<T>()`) |
| Results | `Record<string, unknown>[]` objects |
| Errors | `ConnectionError`, `QueryError`, `TransactionError`, with the server's numeric `code`, a `kind` and `outcomeUnknown` |
| Transactions | `transaction(callback, options?)` with auto commit/rollback, and `isolationLevel` and `lockTimeout` options |
| Node.js | 18+ |

## Versioning and compatibility

`cubrid-client` follows SemVer for its public runtime and TypeScript APIs:
compatible fixes use PATCH, additive options/features use MINOR, and breaking
changes (including an increase of the declared Node.js minimum) require MAJOR.
The current `engines.node` floor is Node.js 18. Types such as `query<T>()`
are compile-time declarations, not runtime validation.
See [API stability and compatibility](docs/API_STABILITY.md) for the precise
contract and migration policy. Version numbers do not establish full live
CUBRID compatibility; review the version support evidence and release notes.

**Node support policy:** All `cubrid-client@1.x` releases retain Node 18 and Node 20 support. Node 22 is recommended for **building/contributing**, not a higher consumer runtime minimum. Any removal of Node 18 is considered no earlier than a separately reviewed **2.0 MAJOR** release. [ADR 0006](docs/adr/0006-node-18-support-through-1x.md) records this commitment; actual Node 18 packed-artifact tests are required for releases.

## Installation

```bash
npm install cubrid-client
```

No peer dependencies required.

**Declared runtime requirement:** Node.js 18+ (CI tests Node 18, 20, 22, 24 and 26;
Node 18 and 20 are end-of-life upstream and deprecated, see the
[support schedule](docs/API_STABILITY.md#nodejs-support-schedule)). The
[real-broker CI matrix](https://github.com/cubrid-lab/cubrid-client/actions/runs/42216017228)
passed 23 integration tests (0 skipped) on CUBRID 10.2, 11.0, 11.2 and
11.4. A separate real SSL=ON CUBRID 11.4 run also passed 3/3 certificate
verification and rejection checks. This is **not exhaustive**
type, cross-version TLS or fault-injection validation;
see the [support matrix](docs/SUPPORT_MATRIX.md) before deployment.

## Quick Start

```ts
import { createClient } from "cubrid-client";

const db = createClient({
  host: "localhost",
  port: 33000,
  database: "demodb",
  user: "dba",
  password: "",
});

// Query returns an array of row objects
const rows = await db.query("SELECT * FROM athlete LIMIT 5");
console.log(rows);
// [{ code: 10000, name: 'Fernandez', ... }, ...]

await db.close();
```

> **Date and time zones.** `Date` parameters are sent as their **UTC** fields,
> but DATE, TIME, TIMESTAMP and DATETIME values are read back in the **local
> zone of the Node.js process** by default (`timezone: "local"`, the 1.x
> behavior). On a host that is not on UTC a `Date` you write does not come back
> as the same instant: under `TZ=Asia/Seoul` it reads back 9 hours early. To read
> the fields as UTC, the zone they were written in, opt in:
>
> ```ts
> const db = createClient({ host: "localhost", database: "demodb", user: "dba", timezone: "utc" });
> ```
>
> The 1.x default does not change. `"utc"` is proposed as the 2.0 default; see
> [date and time values](docs/TYPES.md#date-and-time-values) and
> [ADR 0010](docs/adr/0010-utc-temporal-default-in-2-0.md).

See [CUBRID-to-JavaScript type behavior](docs/TYPES.md) for the current
result and input mapping, including `BIGINT` as `bigint`, decimal `NUMERIC`
as `string`, SET/MULTISET/SEQUENCE collections as arrays, and values
that cannot be decoded. The [roadmap](ROADMAP.md) tracks work that has **not** been released.

## Server Version

`getServerVersion()` returns the CUBRID server version string, for example for a compatibility check. It is the same single request as `ping()`, so it never ends an open transaction.

```ts
const version = await db.getServerVersion(); // "11.4.6.1963"
```

## Schema Introspection

`getTables()`, `getColumns()`, `getPrimaryKey()` and `getIndexes()` return typed metadata read from the catalog views, which behave the same on CUBRID 10.2 to 11.4. Pass the bare table name; matching ignores case, and a `schema` option picks the owner when CUBRID 11.2 or later has the same table name under several users.

```ts
const tables = await db.getTables(); // [{ name: "athlete", schema: "DBA", type: "table" }, ...]
const columns = await db.getColumns("athlete"); // name, position, dataType, precision, scale, nullable, defaultValue
const pk = await db.getPrimaryKey("athlete"); // { name: "pk_athlete_code", columns: ["code"] } or null
const indexes = await db.getIndexes("athlete"); // unique, reverse, primaryKey, foreignKey, filter, columns
```

The catalog lists only tables the connected user may `SELECT`, so an inaccessible table is absent from `getTables()` and rejects with a `QueryError` in the others. See the [API reference](docs/API_REFERENCE.md#schema-introspection-gettables-getcolumns-getprimarykey-getindexes) for names, owners, permissions and what is not included.

## Result Columns

`query()` returns only rows. Use `queryResult()` to also get the type, precision, scale and nullability of each column, for example to know the type of a column that is NULL in every row:

```ts
const { rows, columns } = await db.queryResult("SELECT code, name FROM athlete LIMIT 5");
// columns[0] -> { name: "code", type: "INT", precision: 10, scale: 0, nullable: false }
```

`columns` lists every select-list column, so a repeated name such as `SELECT a.id, b.id` appears twice there; each row object still has one key per name, and the last column wins. See [`QueryResult`](docs/API_REFERENCE.md#queryresult).

### Repeated column names

Give the columns distinct aliases. This works with every 1.x release and keeps object rows:

```ts
const rows = await db.query<{ a_id: number; b_id: number | null }>(
  "SELECT a.id AS a_id, b.id AS b_id FROM a LEFT JOIN b ON b.a_id = a.id",
);
```

Or ask for array rows, which keep every value in select-list order whatever the names, with the names in `columns` at the same index:

```ts
const { rows, columns } = await db.queryResult(
  "SELECT a.id, b.id FROM a LEFT JOIN b ON b.a_id = a.id",
  [],
  { rowMode: "array" },
);
// rows: [[1, 10], [2, null]]; columns.map((c) => c.name): ["id", "id"]
```

`rowMode: "array"` is accepted by `query`, `queryResult`, their `Prepared` forms and `stream`, typed as `unknown[]` rows unless you pass a tuple such as `query<[number, number | null]>(...)`. Object rows stay the default. See [Array rows](docs/API_REFERENCE.md#array-rows-rowmode-array).

## Streaming Large Results

`query()` returns all rows in one array. `stream()` reads them as they are needed, holding one server reply of rows at a time:

```ts
for await (const row of db.stream<{ id: number; name: string }>(
  "SELECT id, name FROM athlete WHERE nation_code = ?",
  ["KOR"],
)) {
  await send(row);
  if (done(row)) {
    break; // Closes the server cursor. So do a thrown error and a failed read.
  }
}
```

An open stream holds its connection. Other statements on the same client wait until it ends, so **do not await `db.query()` inside the loop**: it rejects with `kind: "stream-busy"` after 5 seconds instead of hanging. Use `db.transaction()`, which has its own connection, or a second client. See [`stream()`](docs/API_REFERENCE.md#streamtsql-params-options) for cancellation, timeouts and LOB columns.

## Typed Queries

Use TypeScript generics to get fully typed query results:

```ts
type Athlete = {
  code: number;
  name: string;
  gender: string;
  nation_code: string;
  event: string;
};

const athletes = await db.query<Athlete>(
  "SELECT * FROM athlete WHERE nation_code = ? LIMIT ?",
  ["KOR", 10],
);
// athletes is Athlete[] — full autocompletion and type safety
```

## Parameterized Queries

Use `?` placeholders to safely pass parameters:

```ts
// Positional parameters
const users = await db.query(
  "SELECT * FROM users WHERE name = ? AND age > ?",
  ["Alice", 25],
);

// Supported parameter types
await db.query("INSERT INTO data (a, b, c, d, e, f, g) VALUES (?, ?, ?, ?, ?, ?, ?)", [
  "text",              // string
  42,                  // number
  true,                // boolean
  9007199254740993n,   // bigint
  new Date(),          // Date
  Buffer.from("bin"),  // Buffer
  null,                // null
]);
```

### Affected rows and generated ids

`query()` returns `[]` for `INSERT`, `UPDATE` and `DELETE`. Use `execute()` to
learn how many rows changed and the generated `AUTO_INCREMENT` value:

```ts
const { affectedRows, lastInsertId } = await db.execute(
  "INSERT INTO users (name) VALUES (?)",
  ["Alice"],
);
// affectedRows: 1, lastInsertId: 1 (a bigint beyond Number.MAX_SAFE_INTEGER)
```

`db.transaction((tx) => tx.execute(...))` works the same way.

`lastInsertId` is optional and never guessed. By default it comes from the
session's last insert id, so it is left out whenever the client cannot tell the
value is this statement's: an `INSERT` that generates the same number the session
already held (tables `A` and `B` that both generate `1`), a table without
`AUTO_INCREMENT`, `INSERT ... SELECT`, values that call a function, and
multi-statement strings. It costs one more request after the `INSERT`, and one
before it when another kind of statement ran last. Pass `{ generatedKeys: true }`
to get the key the statement itself generated, as JDBC's `RETURN_GENERATED_KEYS`
does, for one request after the `INSERT`:

```ts
await db.execute("INSERT INTO b (v) VALUES (?)", [1], { generatedKeys: true });
// { affectedRows: 1, lastInsertId: 1 }, even right after table a generated 1
```

On CUBRID 11.0 to 11.4 that option makes an `INSERT` into a table with an
`INSERT` trigger fail, and an `INSERT` into a newly created table can come back
without its key. See [Generated ids](docs/API_REFERENCE.md#generated-ids)
for every case and its cost.

### Server-side prepared binding

`query()` and `execute()` render parameters into SQL text. To send them as typed
binds instead, use `queryPrepared()`, `queryResultPrepared()` or
`executePrepared()`, on the client or on a transaction:

```ts
const rows = await db.queryPrepared("SELECT id FROM users WHERE name = ?", [name]);
```

It is opt-in, takes more round trips than `query()` and has no reusable statement
object. See [prepared binding](docs/TYPES.md#prepared-binding) for the type
mapping, the values it refuses and where results differ.

### Writing BLOB and CLOB

Wrap the content in `blob()` or `clob()` and pass it to a prepared method. The
driver uploads it in 128 KiB pieces before the statement runs, so a stream is
never held in memory whole:

```ts
import { createReadStream } from "node:fs";
import { blob, clob } from "cubrid-client";

await db.executePrepared("INSERT INTO docs (id, body, notes) VALUES (?, ?, ?)", [
  1,
  blob(createReadStream("report.pdf")),
  clob("Résumé 😀"),
]);
```

A CLOB is stored as UTF-8 (ISO-8859-1 with `charset: "iso-8859-1"`). A stream source is read once; an empty `blob()` is an
empty BLOB, not NULL. A plain `Buffer` still binds as `BIT VARYING`. Supported on
CUBRID 10.2 to 11.4; see [writing BLOB and CLOB](docs/TYPES.md#writing-blob-and-clob).

### Batch execution

`executeMany()` runs one INSERT, UPDATE, DELETE or MERGE once per parameter set,
with one PREPARE and one EXECUTE_ARRAY request instead of a round trip per set:

```ts
const { affectedRows, results } = await db.executeMany(
  "INSERT INTO users (id, name) VALUES (?, ?)",
  [
    [1, "Alice"],
    [2, "Bob"],
  ],
);
```

On the client the batch is all or nothing: if any set fails, nothing is
committed and it rejects with a `QueryError` whose `batch` property reports every
set. Inside `transaction()` or a scope a failure leaves the transaction to you.
See [`executeMany()`](docs/API_REFERENCE.md#executemanysql-paramsets-options) and
the [measurements](docs/PERFORMANCE.md#batch-execution).

### Date parameters are serialized in UTC

`Date` parameters are rendered as a `DATETIME'YYYY-MM-DD HH:MM:SS.mmm'`
literal using the date's **UTC** components (millisecond precision). CUBRID's
`DATETIME` type has no timezone, so the stored value reflects UTC wall-clock
time, not the client's local time. If you need local-time semantics, convert
the value yourself before passing it, or store an explicit UTC offset alongside
it.

### How parameters are escaped

Parameters are rendered into the SQL text client-side, with escaping that is
aware of the server's `no_backslash_escapes` setting. The first time a value or
the SQL text needs it, the client probes the session
(`SELECT CHAR_LENGTH('\\')`) and keeps the mode until the session changes or a
statement that may run `SET SYSTEM PARAMETERS` is sent:

- **`no_backslash_escapes=yes`** (the CUBRID default): the backslash is an
  ordinary character. Only the single quote is doubled (`'` → `''`); backslashes,
  newlines, and carriage returns are preserved verbatim. This means a Windows
  path like `C:\temp\file.txt` round-trips unchanged.
- **`no_backslash_escapes=no`**: backslash-escape processing is active, so
  backslashes are doubled and `\r` / `\n` are backslash-escaped in addition to
  doubling the single quote.

A `?` is a marker only where CUBRID's own lexer reads code: not inside a
`'...'` string, a `"..."`, `` `...` `` or `[...]` identifier, a `/* */` comment or
a `--` or `//` comment (which ends at CR or LF). The number of values must equal
the number of markers; too few or too many reject with a `QueryError` before
anything is sent. A backslash escapes a quote only when the server runs with
`no_backslash_escapes=no`, so SQL whose markers depend on that is measured against
the server first. In that mode a `"..."` span holding a backslash is refused when
the server's `ansi_quotes` setting, which the client cannot see, would move a
marker. A call without `params` sends the SQL as written.

The values become SQL text. To keep them out of it, use the
[prepared methods](#server-side-prepared-binding): the server finds the markers
and receives typed values. `query()` and `execute()` keep the literal behavior in
1.x.

A negative `number` or `bigint` is rendered in parentheses, `(-1)`, so SQL such
as `balance-?` can never become `balance--1`, where `--` would start a comment.
`NaN`, `Infinity`, an invalid `Date` and any value that is not a `QueryParam`
(an object, array, function or symbol) are rejected with a `QueryError` before
anything is sent; they are never converted with `String()`.

> **Rejected bytes:** string parameters containing a NUL (`0x00`) or Ctrl-Z
> (`0x1A`) byte are rejected with a `QueryError`, because CUBRID cannot store a
> NUL in a string literal and defines no safe literal escape for `0x1A`. Encode
> such values as binary using a `Buffer` parameter (rendered as `X'..'`) instead.

## Transactions

### Automatic (Recommended)

`transaction()` creates an isolated connection, auto-commits on success, and auto-rolls back on error:

```ts
await db.transaction(async (tx) => {
  await tx.query("INSERT INTO orders (item, qty) VALUES (?, ?)", ["Widget", 1]);
  await tx.query(
    "UPDATE inventory SET qty = qty - 1 WHERE item = ?",
    ["Widget"],
  );
  // Auto-committed here
});
// If any query throws, everything is rolled back automatically.
```

The callback owns one transaction with exactly one outcome. You normally do not
call `tx.commit()` or `tx.rollback()`, but both remain available, for example to
decline a change without treating it as an error. The client then skips its own
commit or rollback and still returns the callback's value:

```ts
const placed = await db.transaction(async (tx) => {
  const [stock] = await tx.query<{ qty: number }>(
    "SELECT qty FROM inventory WHERE item = ?",
    ["Widget"],
  );
  if (!stock || stock.qty < 1) {
    await tx.rollback();
    return false;
  }
  await tx.query("INSERT INTO orders (item, qty) VALUES (?, ?)", ["Widget", 1]);
  return true;
});
```

Once the transaction is complete, `tx.query()`, `tx.queryResult()`, `tx.execute()`,
`tx.commit()` and `tx.rollback()` reject with `TransactionError` and send nothing
to the server. If the rollback or
the connection close also fails, `error.cause` stays the original failure and the
later ones are on `error.rollbackError` and `error.closeError`. Await every
statement. A failure you awaited and caught is your decision, so the rest still
commits. A statement nobody awaited or attached a handler to, such as
`void tx.query(sql)`, rolls the transaction back if it fails, whether it fails
before the callback returns or after. Any handler counts, including
`.finally()` and a `Promise.all()` you never await: then the rest commits and
Node.js reports the unhandled rejection. See the
[transaction lifecycle](docs/API_REFERENCE.md#transaction-lifecycle) for every
outcome and the [compatibility notes](docs/API_STABILITY.md#unobserved-statement-failures).

### Isolation level and lock timeout

Set them on the client, or on one transaction. They are applied before the transaction starts, and again on any session that replaces the first one, so they never disappear silently after a reconnect.

```typescript
const db = createClient({ host, database, user, lockTimeout: 5000 });

await db.transaction(async (tx) => {
  await tx.query('UPDATE stock SET qty = qty - 1 WHERE id = ?', [1]);
}, { isolationLevel: 'repeatable read', lockTimeout: 0 });
```

`serializable` behaves like `repeatable read` on CUBRID 10.2 to 11.4, and it still allows write skew. See [what each level does](docs/CONNECTION.md#isolation-level-and-lock-timeout), and [Autocommit](docs/CONNECTION.md#autocommit) for its behavior after a reconnect.

### Manual

When commit or rollback is decided outside one callback, take a handle that owns
its own connection. Only statements sent through `tx` belong to the transaction,
so concurrent `db.query()` calls can never join it:

```ts
const tx = await db.beginTransactionScope();
try {
  await tx.query("INSERT INTO logs (msg) VALUES (?)", ["step 1"]);
  await tx.query("INSERT INTO logs (msg) VALUES (?)", ["step 2"]);
  await tx.commit();
} catch (error) {
  await tx.rollback().catch(() => {});
  throw error;
}
```

`db.beginTransaction()`, `db.commit()` and `db.rollback()` still work throughout
1.x but are **deprecated**: they run on the shared connection, where any other
call on `db` joins the open transaction
([#112](https://github.com/cubrid-lab/cubrid-client/issues/112)).

## Connection Pool

A client sends every statement over one shared connection, one at a time. A pool
keeps several connections and lends one to each statement, so independent
statements run in parallel:

```ts
import { createPool } from "cubrid-client";

const pool = createPool({
  host: "localhost",
  database: "demodb",
  user: "dba",
  max: 10, // connections at most, counting those being opened
  acquireTimeoutMs: 30_000, // then reject with kind "pool-timeout"
});

const rows = await pool.query("SELECT name FROM athlete WHERE code = ?", [10999]);

await pool.transaction(async (tx) => {
  await tx.execute("UPDATE account SET balance = balance - 10 WHERE id = ?", [1]);
  await tx.execute("UPDATE account SET balance = balance + 10 WHERE id = ?", [2]);
});

// Several autocommit statements on one session, released when fn settles.
await pool.connection(async (conn) => {
  await conn.execute("INSERT INTO logs (msg) VALUES (?)", ["imported"]);
  return conn.query("SELECT COUNT(*) AS n FROM logs");
});

await pool.close();
```

The pool has the client's statement methods, `stream()`, `transaction()`,
`beginTransactionScope()`, `ping()`, `getServerVersion()` and the schema methods.
Each statement leases a connection for itself; a stream keeps its lease until it
ends, so a query awaited inside the loop uses another connection. Callers wait in
arrival order. A connection goes back to the pool only when its session is
clean: no open transaction, nothing still running, no request with an unknown
outcome (after a read timeout or an abort) and no per-call transaction settings
other than the pool's. Otherwise it is closed and the next caller gets a new one
([ADR 0008](docs/adr/0008-pool-reuse-invariant.md)). Session variables, and an
isolation level or lock timeout changed with SQL, stay on a reused session; set
`isolationLevel` and `lockTimeout` on the pool instead. `pool.stats()` reports
`{ total, idle, active, pending, waiting }`. See
[`CubridPool`](docs/API_REFERENCE.md#cubridpool) for every option.

## TLS/SSL

Connect to an SSL-enabled CUBRID broker (`SSL=ON` in `cubrid_broker.conf`) by
setting the `ssl` option. Certificates are verified against the system trust
store by default (`rejectUnauthorized: true`), and the minimum negotiated
protocol is TLS 1.2.

```ts
// Simplest form: enable TLS with default certificate verification
const db = createClient({
  host: "localhost",
  database: "demodb",
  user: "dba",
  ssl: true,
});
```

For self-signed or private-CA broker certificates, pass an options object:

```ts
import { readFileSync } from "node:fs";

const db = createClient({
  host: "db.internal",
  database: "demodb",
  user: "dba",
  ssl: {
    ca: readFileSync("broker-ca.pem", "utf8"), // trust a private CA
    servername: "db.internal",                 // override SNI / cert hostname
    // rejectUnauthorized: false,               // opt out of verification (NOT recommended)
  },
});
```

`ClientSSLOptions` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rejectUnauthorized` | `boolean` | `true` | Reject connections whose certificate cannot be verified |
| `ca` | `string \| Buffer \| Array` | *(system store)* | Trusted CA certificate(s) for verification |
| `servername` | `string` | `host` | Server name for SNI and certificate hostname checks |

> The client uses a STARTTLS-style upgrade on the same broker port (`33000`):
> it negotiates the CAS handshake, then upgrades the socket to TLS before the
> database login. The plaintext (non-SSL) path is unaffected when `ssl` is
> omitted or `false`.


## Error Handling

Every error includes the original driver error as `.cause`:

```ts
import { createClient, ConnectionError, QueryError, TransactionError } from "cubrid-client";

const db = createClient({ host: "localhost", database: "demodb", user: "dba" });

try {
  await db.query("SELECT * FROM nonexistent_table");
} catch (error) {
  if (error instanceof ConnectionError) {
    console.error("Connection failed:", error.message);
  } else if (error instanceof QueryError) {
    console.error("Query failed:", error.message);
    console.error("Driver error:", error.cause);
  } else if (error instanceof TransactionError) {
    console.error("Transaction failed:", error.message);
  }
}
```

Errors also say what happened without parsing a message. `error.code` is the numeric server code and `error.kind` classifies known failures. `error.outcomeUnknown` is `true` when the request was sent and its reply lost, so a write or `COMMIT` may have been applied: check the database before writing again (see [Unknown outcomes](docs/API_REFERENCE.md#unknown-outcomes)). Outside a transaction, `ConstraintError`, `SqlSyntaxError`, `DeadlockError` and `LockTimeoutError` extend `QueryError`. See [Error details](docs/API_REFERENCE.md#error-details).

```ts
import { ConstraintError } from "cubrid-client";

try {
  await db.query("INSERT INTO users (email) VALUES (?)", [email]);
} catch (error) {
  if (error instanceof ConstraintError && error.kind === "unique-violation") {
    console.error("Already registered:", error.code); // -670
  }
}
```

## API Reference

### `createClient(options): CubridClient`

Creates a client instance. Connection is established lazily on first query.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | *(required)* | Server hostname |
| `port` | `number` | `33000` | Broker port |
| `database` | `string` | *(required)* | Database name. At most 31 bytes in UTF-8, no NUL; see [Credential length](docs/CONNECTION.md#credential-length) |
| `user` | `string` | *(required)* | Database user. At most 31 bytes in UTF-8, no NUL |
| `password` | `string` | `""` | Password. At most 31 bytes in UTF-8, no NUL |
| `connectionTimeout` | `number` | `10000` | Limit of each TCP connect (ms); `0` for the OS limit. See [Connection limits](docs/CONNECTION.md#connection-limits) |
| `maxConnectionRetryCount` | `number` | `0` | Retries after a failed TCP connect to the broker (see [Connection retries](docs/CONNECTION.md#connection-retries)) |
| `readTimeout` | `number` | — | Fail a query after this many ms with no activity from the server (see [Read timeout](docs/CONNECTION.md#read-timeout)). Unset means no timeout for queries; the connect handshake still gives up after 10 s |
| `fetchSize` | `number` | `100` | Rows requested per FETCH. CUBRID 10.2 to 11.4 ignore it and send about 16 KiB per reply (see [`fetchSize`](docs/API_REFERENCE.md#clientoptions)) |
| `timezone` | `"local" \| "utc"` | `"local"` | Zone DATE/TIME/TIMESTAMP/DATETIME values are decoded in. `"utc"` makes them independent of the process `TZ` and symmetric with `Date` parameters (see [Date and time values](docs/TYPES.md#date-and-time-values)) |
| `charset` | `"utf-8" \| "iso-8859-1"` | `"utf-8"` | How text is sent and read. The default is UTF-8 whatever the database charset; `"iso-8859-1"` matches an `iso88591` database, such as the Docker images' `testdb`, and reads each column in its own charset (see [Text and character sets](docs/TYPES.md#text-and-character-sets)) |
| `maxLobBytes` | `number` | 64 MiB | Most BLOB and CLOB content one query may load, in bytes. A query over it rejects (see [BLOB and CLOB columns](docs/TYPES.md#blob-and-clob-columns)) |
| `maxReplyBytes` | `number` | 1 GiB | Largest single reply from the server, in bytes, and so the largest row. A longer reply rejects and closes the connection (see [Reply size limit](docs/CONNECTION.md#reply-size-limit)) |
| `isolationLevel` | `"read committed" \| "repeatable read" \| "serializable"` | Server default | Isolation level of every session this client opens, restored after a reconnect (see [Isolation Level and Lock Timeout](docs/CONNECTION.md#isolation-level-and-lock-timeout)) |
| `lockTimeout` | `number` | Server default | Longest a statement waits for a lock, in ms. `0` does not wait and `-1` has no limit. Restored after a reconnect |
| `ssl` | `boolean \| ClientSSLOptions` | `false` | Enable TLS. `true` for defaults, or an object for cert/verification control (see [TLS/SSL](#tlsssl)) |

### `createPool(options): CubridPool`

Creates a pool of connections. It takes every `createClient()` option plus `max`
(10), `min` (0), `acquireTimeoutMs` (30000), `maxWaitingClients` (`Infinity`),
`idleTimeoutMs` (30000), `maxLifetimeMs` (none) and `validateAfterIdleMs` (none).
An invalid value throws a `RangeError`. See [Connection Pool](#connection-pool).

### `client.stream<T>(sql, params?, options?): AsyncGenerator<T>`

Reads a result row by row with `for await`, with bounded memory. See [Streaming Large Results](#streaming-large-results).

### `client.query<T>(sql, params?, options?): Promise<T[]>`

Executes SQL and returns typed row objects. DDL/DML statements return `[]`. BLOB columns return a complete `Buffer` and CLOB columns a complete `string`.

`options` is a `QueryOptions` `{ signal?: AbortSignal; readTimeout?: number }`, also accepted by `queryResult`, `execute`, the `Prepared` methods and `executeMany` on the client, `tx` and a transaction scope. An abort rejects with `signal.reason`: a statement still queued is never sent, and one already sent has its connection discarded and an unknown outcome on the server, so verify before retrying. `readTimeout` overrides the client's for that statement (`0` = none). See [Cancelling one statement](docs/API_REFERENCE.md#cancelling-one-statement).

### `client.transaction<T>(callback, options?): Promise<T>`

Runs `callback` in an isolated transaction with exactly one commit or rollback. `options` can set `isolationLevel` and `lockTimeout` for that transaction.

### `client.beginTransactionScope(options?): Promise<TransactionScope>`

Starts a transaction on a dedicated connection and returns the handle that owns it. Exactly one `tx.commit()` or `tx.rollback()` ends it and closes that connection.

### `client.beginTransaction(): Promise<void>` *(deprecated)*

Starts a transaction on the shared connection. Use `beginTransactionScope()` instead.

### `client.commit(): Promise<void>` *(deprecated)*

Commits the active transaction on the shared connection.

### `client.rollback(): Promise<void>` *(deprecated)*

Rolls back the active transaction on the shared connection.

### `client.close(): Promise<void>`

Closes the shared connection and discards (rolls back) any `beginTransactionScope()` handle not yet ended. It waits for `transaction()` callbacks already running to commit or roll back, and refuses those that have not started. Safe to call multiple times: every call returns the same promise. See [`close()`](docs/API_REFERENCE.md#close).

### `client.destroy(): Promise<void>`

Tears down every connection of the client at once, without waiting for the statement in flight: it rejects with kind `connection-lost` and an unknown outcome, and queued statements reject without being sent. Nothing is retried. Use it when `close()` would wait too long. See [Destroying a client](docs/CONNECTION.md#destroying-a-client).

> 📖 Full API documentation: [docs/API_REFERENCE.md](docs/API_REFERENCE.md)

## Architecture

`cubrid-client` implements the CUBRID CAS binary protocol directly over TCP sockets:

```mermaid
flowchart TD
    App[Application] --> Client[cubrid-client]
    Client --> CAS[CAS Protocol over TCP]
    CAS --> Broker[CUBRID Broker]
    Broker --> Server[CUBRID Server]
```

```mermaid
graph TD
    A[createClient options] --> B[CubridClient config connectionFactory]
    B --> C[NativeCubridAdapter implements ConnectionLike]
    C --> D[CASConnection TCP socket framed binary IO]
    D --> E[PacketWriter binary request encoding]
    D --> F[PacketReader binary response decoding]
    D --> G[Protocol CAS command builders and parsers]
    D --> H[Constants function codes and data types]
```

```mermaid
sequenceDiagram
    participant App as Application
    participant Client as cubrid-client
    participant Broker as CUBRID Broker
    participant Server as CUBRID Server

    App->>Client: createClient(config)
    Note over Client: Lazy connection (no network I/O)
    App->>Client: query(sql, params)
    Client->>Broker: CAS connect/query over TCP
    Broker->>Server: Execute SQL
    Server-->>Broker: Result set / status
    Broker-->>Client: CAS response packets
    Client-->>App: Typed rows / [] for DDL-DML
```

No external protocol drivers needed — the entire CAS handshake, query execution, and result parsing is implemented in TypeScript.

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API_REFERENCE.md) | Complete method signatures, type definitions, error classes |
| [Connection Guide](docs/CONNECTION.md) | Connection options, lazy connection, lifecycle, Docker setup |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common errors, debugging tips, performance advice |
| [Architecture](docs/architecture.md) | Internal design and module responsibilities |

## Project Layout

```mermaid
graph TD
    Root[cubrid-client] --> Src[src]
    Root --> Tests[tests]
    Root --> Docs[docs]
    Src --> Protocol[protocol - CAS binary protocol]
    Src --> ClientModule[client - CubridClient CubridTransaction createClient]
    Src --> Adapters[adapters - ConnectionLike and NativeCubridAdapter]
    Src --> Errors[errors - ConnectionError QueryError TransactionError and subclasses]
    Src --> Internals[internals - mapError normalizeConfig]
    Src --> Types[types - TypeScript interfaces and aliases]
```

## Development

### Reproducible contributor setup

Use the [development setup guide](docs/DEVELOPMENT_SETUP.md) for the actual language-specific toolchain, clean dependency install, offline tests, **real CUBRID integration readiness** and known setup blockers. The [ADR index](docs/adr/README.md) records proposed release, architecture, TDD and setup decisions. Documentation alone is not a claim that those tests have run or that an unverified runtime/database version is supported.


```bash
git clone https://github.com/cubrid-lab/cubrid-client.git
cd cubrid-client
npm install
npm run build        # TypeScript compilation (tsup)
npm test             # Run offline tests
npm run test:coverage # Coverage report (99%+ statements)
npm run typecheck    # tsc --noEmit
npm run api:check    # public API vs api/index.d.ts (run after build)
```

### Integration Tests

Integration tests run against a live CUBRID server. They self-skip their
database-dependent cases when no server is reachable, so they are safe to run
anywhere. Point them at a running CUBRID broker on `127.0.0.1:33000` with a
database named `testdb` and user `dba` (empty password):

```bash
npm run test:integration              # DB-dependent cases self-skip if unreachable
```

> CI runs this step too, but no CUBRID server is provisioned there, so only the
> offline cases execute and a warning annotation is emitted. To exercise the full
> suite, run the command above against your own CUBRID instance.

## Ecosystem

| Package | Description |
|---------|-------------|
| [cubrid-client](https://github.com/cubrid-lab/cubrid-client) | TypeScript client (this package) |
| [drizzle-cubrid](https://github.com/cubrid-lab/drizzle-cubrid) | Drizzle ORM dialect for CUBRID |

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for this project's direction and next milestones.


## Disclaimer

This project is part of [CUBRID Lab](https://github.com/cubrid-lab), an independent open-source initiative for CUBRID developer tooling, and is not affiliated with, sponsored by, or endorsed by CUBRID Corporation or the official CUBRID project.

## License

[MIT](LICENSE)
