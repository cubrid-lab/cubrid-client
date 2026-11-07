# Troubleshooting

Solutions for common issues when using `cubrid-client`.

## Connection Issues

### `ConnectionError: Failed to connect to CUBRID`

**Symptoms**: First query throws `ConnectionError`.

**Causes and fixes**:

| Error Detail | Cause | Fix |
|--------------|-------|-----|
| `ECONNREFUSED 127.0.0.1:33000` | CUBRID broker is not running | Start CUBRID: `cubrid service start` or `docker compose up -d` |
| `ENOTFOUND some-host` | Hostname cannot be resolved | Check `host` option — use IP address or valid hostname |
| `ETIMEDOUT` | Firewall blocking port or wrong port | Check `port` (default: 33000) and firewall rules |
| `connect timeout` | Server too slow to respond | Increase `connectionTimeout` option |
| `ReadTimeoutError` | Server sent nothing for `readTimeout` ms: stalled broker or network, or a statement slower than the limit | Check the server, or raise `readTimeout`. Check whether a write or `COMMIT` took effect before retrying it |

**Example**: Diagnose connection failures gracefully:

```ts
import { createClient, ConnectionError } from "cubrid-client";

const db = createClient({
  host: "localhost",
  port: 33000,
  database: "demodb",
  user: "dba",
  connectionTimeout: 5000,
});

try {
  await db.query("SELECT 1");
  console.log("Connected successfully");
} catch (error) {
  if (error instanceof ConnectionError) {
    console.error("Cannot connect to CUBRID:");
    console.error("  Message:", error.message);
    console.error("  Cause:", error.cause);
  }
  process.exit(1);
}
```

### Connection works in Docker but not from host

The CUBRID broker port (default 33000) must be exposed:

```yaml
# docker-compose.yml
services:
  cubrid:
    image: cubrid/cubrid:11.2
    ports:
      - "33000:33000"   # broker port
    environment:
      - CUBRID_DB=testdb
```

If using Docker Desktop on macOS/Windows, `localhost` works. On Linux, use `127.0.0.1` or the container's IP.

## Query Issues

### `QueryError: Query failed`

**Common causes**:

1. **SQL syntax error** — CUBRID SQL differs from MySQL/PostgreSQL in some areas
2. **Table/column not found** — Check table and column names (CUBRID folds identifiers to lowercase)
3. **Type mismatch** — Parameter types don't match column types

```ts
import { QueryError } from "cubrid-client";

try {
  await db.query("SELECT * FROM nonexistent_table");
} catch (error) {
  if (error instanceof QueryError) {
    console.error("Query failed:", error.message);
    console.error("Server code:", error.code); // -493 for an unknown table
    console.error("Original error:", error.cause);
  }
}
```

`error.code` and `error.kind` identify the failure without parsing the message. See [Error details](API_REFERENCE.md#error-details) for the measured codes.

### `QueryError` because a value or reply could not be decoded

A decode failure has two outcomes, and only one leaves the connection usable. To
tell them apart, walk the `cause` chain for the error's `name`. Do not match
message text, and do not stop at `error.cause`: `db.query()` wraps the failure in
a second `QueryError`.

```ts
function decodeFailure(error: unknown): Error | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.name === "UnsupportedValueError" || current.name === "MalformedReplyError") {
      return current;
    }
  }
  return undefined;
}
```

The driver does not export these two classes, so test `name` and not
`instanceof`. Both `name` values are a stable part of the 1.x
[public contract](API_STABILITY.md).

- **`UnsupportedValueError`**: the server sent a value this driver has no decoder
  for. Its message names the column and CAS wire type: `29` to `32` are the
  timezone-aware types, and `19` is an OBJECT reference. The connection and any
  open transaction stay usable, so cast the column in SQL, for example
  `CAST(created_at AS DATETIME)`, or select `TO_CHAR(created_at)`. A message
  `Zero date 0000-00-00` on wire type `13`, `15` or `22` means a DATE, TIMESTAMP
  or DATETIME holds the zero date, which has no JavaScript `Date`; use
  `TO_CHAR(created_at)` or `CASE WHEN created_at = DATETIME'0000-00-00 00:00:00'
  THEN NULL ELSE created_at END`.
  BLOB and CLOB columns raise it too when a query is over `maxLobBytes` or a CLOB
  is not UTF-8; see [BLOB and CLOB columns](TYPES.md#blob-and-clob-columns).
- **`MalformedReplyError`**: the reply was damaged, so the connection was dropped
  and the server rolled back any open transaction. Its message names the column
  only when one cell failed. See
  [values that cannot be decoded](TYPES.md#values-that-cannot-be-decoded) for how
  to recover.

### `QueryError` with `CUBRID LOB read failed (-1020)`

The server no longer has the file behind a BLOB or CLOB value. There are two usual
causes:

- The statement built the LOB, as in `SELECT CHAR_TO_CLOB('a')`, in autocommit
  mode. The server deletes that temporary file before it replies, so run the
  statement in a transaction.
- Another session deleted or updated the row and committed after your `SELECT`
  returned its rows and before the driver read the value. Run the query again.

The connection stays usable. See
[BLOB and CLOB columns](TYPES.md#blob-and-clob-columns).

### DDL/DML statements return empty array

This is **expected behavior**. `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, and other DDL/DML statements return `[]` because they don't produce result sets:

```ts
const result = await db.query("INSERT INTO users (name) VALUES (?)", ["Alice"]);
console.log(result); // [] — this is correct
```

To learn how many rows a statement changed, or the generated `AUTO_INCREMENT` id of an `INSERT`, use `execute()`: `await db.execute("INSERT INTO users (name) VALUES (?)", ["Alice"])` resolves to `{ affectedRows: 1, lastInsertId: 1 }`. See [`execute()`](API_REFERENCE.md#executesql-params).

The client detects DDL/DML statements (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, TRUNCATE, RENAME, REPLACE, MERGE, SET, GRANT, REVOKE) and routes them through `execute()` instead of `queryAll()` to avoid `CAS_ER_NO_MORE_DATA` errors.

### Parameters not binding correctly

`cubrid-client` uses positional `?` placeholders. Parameters are passed as an array:

```ts
// Correct — positional parameters
await db.query("SELECT * FROM users WHERE name = ? AND age > ?", ["Alice", 25]);

// Wrong — named parameters are NOT supported
await db.query("SELECT * FROM users WHERE name = :name", { name: "Alice" }); // ❌
```

**Supported parameter types**: `string`, `number`, `boolean`, `bigint`, `Date`, `Buffer`, `null`.

### Queries returning unexpected column names

CUBRID folds unquoted identifiers to **lowercase**. If your query uses `SELECT Name`, the result column key will be `name`:

```ts
const rows = await db.query("SELECT Name, AGE FROM users");
console.log(rows[0]); // { name: "Alice", age: 30 } — lowercase keys
```

To preserve case, quote the identifiers:

```ts
const rows = await db.query('SELECT "Name", "AGE" FROM users');
console.log(rows[0]); // { Name: "Alice", AGE: 30 }
```

## Transaction Issues

### `TransactionError: Transaction failed`

**Common causes**:

1. **Deadlock** — Two concurrent transactions waiting on each other
2. **Lock timeout** — Transaction held too long
3. **Connection lost** — Network interruption during transaction

```ts
import { TransactionError } from "cubrid-client";

try {
  await db.transaction(async (tx) => {
    await tx.query("UPDATE accounts SET balance = balance - 100 WHERE id = ?", [1]);
    await tx.query("UPDATE accounts SET balance = balance + 100 WHERE id = ?", [2]);
  });
} catch (error) {
  if (error instanceof TransactionError) {
    console.error("Transaction failed (auto-rolled back):", error.message);
    console.error("Why:", error.kind, error.code); // For example "deadlock" -72
  }
}
```

`error.kind` tells these causes apart: `deadlock`, `lock-timeout` or `connection-lost`.

- **`deadlock`**: retry the whole transaction. With code `-72` the server already rolled it back, so if your callback catches that error and continues, its later `tx` statements reject, nothing is committed and `transaction()` rejects with that error. See [what happens after `-72`](API_REFERENCE.md#error-details).
- **`lock-timeout`**: only the statement failed and the transaction is still open. CUBRID waits indefinitely by default. To limit the wait, run `SET TRANSACTION LOCK TIMEOUT <seconds>` inside the transaction.

### Transaction auto-rollback

When `db.transaction()` throws, the transaction is **automatically rolled back** before the error propagates. You don't need to catch and rollback manually:

```ts
try {
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO orders (item) VALUES (?)", ["Widget"]);
    throw new Error("Business logic failed");
    // Transaction is auto-rolled back — the INSERT is undone
  });
} catch (error) {
  // error.message === "Transaction failed."
  // error.cause.message === "Business logic failed"
}
```

### `TransactionError: Transaction has already been committed`

A `tx` was used after its transaction ended. The same applies to `Transaction has already been rolled back`, `Transaction has already failed` and `Transaction is already completing`. The call sent nothing to the server. Common causes:

- `tx.commit()` or `tx.rollback()` was called twice, or a `catch` block rolls back after a commit that succeeded.
- A query runs after `tx.commit()`. Move it before the commit, or run it on `db.query()` if it belongs outside the transaction.
- `tx` was kept past the end of the callback, for example in a timer or an un-awaited promise. Await all of the work inside the callback.

### A transaction failed because of a query the callback did not await

If a `tx.query()`, `tx.queryResult()` or `tx.execute()` is still running when the commit starts and then fails, nothing is committed and `transaction()` rejects with that failure as `cause`. Await every statement, and catch the error at that point if the transaction may continue. The client cannot see a query that was not awaited and rejected before the callback's last `await` resumed, so the commit goes ahead in that case. See the [transaction lifecycle](API_REFERENCE.md#transaction-lifecycle).

### The rollback or close failed as well

`error.cause` is always the failure that ended the transaction. Check `error.rollbackError` and `error.closeError` for what went wrong during cleanup:

```ts
try {
  await db.transaction(work);
} catch (error) {
  if (error instanceof TransactionError) {
    console.error("Transaction failed:", error.cause);
    if (error.rollbackError) console.error("Rollback also failed:", error.rollbackError);
    if (error.closeError) console.error("Close also failed:", error.closeError);
  }
}
```

### `transaction()` rejected but the data was committed

Two situations leave committed data behind a rejection, so check before retrying:

- The callback called `tx.commit()` and then threw. A commit cannot be rolled back.
- The commit succeeded and only closing the connection failed. `transaction()` then rejects with the close error, a `ConnectionError` from the built-in adapter.

A [read timeout](CONNECTION.md#read-timeout) during the commit leaves the outcome unknown as well.

### Manual transaction left open

If you use `beginTransaction()` / `commit()` / `rollback()` and forget to commit or rollback, the transaction stays open on the shared connection. All subsequent queries will execute inside that transaction:

```ts
// Dangerous pattern — transaction left open on error
await db.beginTransaction();
await db.query("INSERT INTO logs (msg) VALUES (?)", ["start"]);
// If this throws, the transaction is never closed!
await db.query("INSERT INTO logs (msg) VALUES (?)", ["end"]);
await db.commit();

// Safe pattern — always use try/catch
await db.beginTransaction();
try {
  await db.query("INSERT INTO logs (msg) VALUES (?)", ["start"]);
  await db.query("INSERT INTO logs (msg) VALUES (?)", ["end"]);
  await db.commit();
} catch (error) {
  await db.rollback();
  throw error;
}
```

**Best practice**: Prefer `db.transaction(callback)` over manual transaction management. It handles commit/rollback/cleanup automatically.

## Driver Issues

`cubrid-client` speaks the CAS protocol itself through `NativeCubridAdapter`
and does not require or load any external driver such as `node-cubrid`.

### ESM vs CommonJS import issues

`cubrid-client` ships both ESM and CommonJS builds:

```ts
// ESM (recommended)
import { createClient } from "cubrid-client";

// CommonJS
const { createClient } = require("cubrid-client");
```

If you see "ERR_REQUIRE_ESM" errors, your project is using CommonJS but trying to load the ESM build. Either:
1. Add `"type": "module"` to your `package.json`
2. Rename your file to `.mjs`
3. Use dynamic import: `const { createClient } = await import("cubrid-client")`

## TypeScript Issues

### Generic type parameter not inferring

Always provide the type parameter explicitly for best results:

```ts
type User = { id: number; name: string };

// Explicit type — recommended
const users = await db.query<User>("SELECT id, name FROM users");
// users is User[]

// Without type parameter — returns QueryResultRow[]
const rows = await db.query("SELECT id, name FROM users");
// rows is Record<string, unknown>[]
```

### Type errors with query parameters

Parameters must match the `QueryParam` type. Common mistakes:

```ts
// ❌ Object is not a valid parameter
await db.query("SELECT ?", [{ name: "test" }]);

// ❌ undefined is not a valid parameter
await db.query("SELECT ?", [undefined]);

// ✅ Valid parameter types
await db.query("SELECT ?, ?, ?, ?, ?, ?, ?", [
  "text",     // string
  42,          // number
  true,        // boolean
  100n,        // bigint
  new Date(),  // Date
  Buffer.from("data"), // Buffer
  null,        // null
]);
```

## Performance Tips

### Reuse the client instance

Create one client and reuse it across your application:

```ts
// db.ts — single shared instance
import { createClient } from "cubrid-client";

export const db = createClient({
  host: "localhost",
  database: "myapp",
  user: "dba",
});

// app.ts — import and use
import { db } from "./db.js";
const users = await db.query("SELECT * FROM users");
```

### Close the client on shutdown

Prevent connection leaks by closing the client when your process exits:

```ts
process.on("SIGINT", async () => {
  await db.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await db.close();
  process.exit(0);
});
```

## Getting Help

- [GitHub Issues](https://github.com/cubrid-lab/cubrid-client/issues) — Bug reports and feature requests
- [API Reference](./API_REFERENCE.md) — Full method signatures and types
- [Connection Guide](./CONNECTION.md) — Connection configuration details
- [CUBRID Documentation](https://www.cubrid.org/manual/) — Official CUBRID documentation
