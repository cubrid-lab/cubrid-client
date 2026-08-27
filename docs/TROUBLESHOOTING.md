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
    console.error("Original error:", error.cause);
  }
}
```

### DDL/DML statements return empty array

This is **expected behavior**. `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, and other DDL/DML statements return `[]` because they don't produce result sets:

```ts
const result = await db.query("INSERT INTO users (name) VALUES (?)", ["Alice"]);
console.log(result); // [] — this is correct
```

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
  }
}
```

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

If using the legacy `NodeCubridAdapter`, install `node-cubrid` separately:

```bash
npm install node-cubrid
```

The default `NativeCubridAdapter` does not require any external driver dependencies.

If using the legacy `NodeCubridAdapter` with an older version of `node-cubrid`, update to the latest version:

```bash
npm install node-cubrid@latest
```

The default `NativeCubridAdapter` does not expose this limitation.

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
