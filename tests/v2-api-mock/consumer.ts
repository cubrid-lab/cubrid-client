// Compile test for the proposed 2.0 API (#249, docs/design/v2-api.md, ADR 0011).
//
// `npm run typecheck` (tsc --noEmit over tests/**/*.ts) compiles this file against
// the mocks in ./index.d.ts ("cubrid-client") and ./driver.d.ts
// ("cubrid-client/driver"). Nothing here runs: the functions are never called and
// the mocks have no implementation. What it proves is that typical application,
// library and driver code written against the proposal type-checks, and, through
// the `@ts-expect-error` lines, that the removed 1.x names and the misuses the
// design rejects at compile time are really rejected. If one of those lines
// stopped being an error, tsc would report the unused directive.
//
// The published 1.x API is not touched: package.json builds only src/index.ts and
// `npm run api:check` compares it with api/index.d.ts.

import type {
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  DriverQueryResult,
  DriverStatement,
} from "./driver.js";
import { CubridTransaction, NativeCubridAdapter } from "./driver.js";
import type * as Root from "./index.js";
import type {
  Binding,
  ExecuteResult,
  Queryable,
  StatementClient,
  TransactionClient,
} from "./index.js";
import {
  blob,
  buildWhere,
  CubridClient,
  type CubridPool,
  clob,
  createClient,
  createPool,
  escapeIdentifier,
  QueryError,
} from "./index.js";

interface User {
  [column: string]: unknown;
  id: number;
  name: string;
}

// ------------------------------------------------- application code, one client

export async function applicationCode(): Promise<void> {
  // Binding is chosen once per client and can be overridden per statement.
  const db = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    binding: "prepared",
    timezone: "utc",
  });

  const users: User[] = await db.query<User>("SELECT id, name FROM users WHERE id > ?", [10]);
  const literal = await db.query<User>("SELECT id, name FROM users WHERE id = ?", [1], {
    binding: "literal",
  });
  const withColumns = await db.queryResult<User>("SELECT * FROM users", [], {
    binding: "prepared",
    readTimeout: 5000,
  });
  void [users, literal, withColumns.columns[0]?.type];

  // execute() with LOBs and generated keys, prepared on this statement only.
  const inserted: ExecuteResult = await db.execute(
    "INSERT INTO docs (body, notes) VALUES (?, ?)",
    [blob(Buffer.from([1, 2, 3])), clob("text")],
    { binding: "prepared", generatedKeys: true },
  );
  const id: number | bigint | undefined = inserted.lastInsertId;
  void id;

  // executeMany() always binds on the server; it takes no binding.
  await db.executeMany("INSERT INTO t (a, b) VALUES (?, ?)", [
    [1, "x"],
    [2, null],
  ]);

  // Prepared streaming is the same stream() with a binding option.
  const controller = new AbortController();
  for await (const row of db.stream<User>("SELECT id, name FROM users WHERE name LIKE ?", ["a%"], {
    binding: "prepared",
    fetchSize: 500,
    signal: controller.signal,
  })) {
    const name: string = row.name;
    void name;
  }

  // Array rows (#255, in progress) compose with binding instead of adding methods.
  const arrays: unknown[][] = await db.query("SELECT a.id, b.id FROM a, b", [], {
    rowMode: "array",
    binding: "prepared",
  });
  const arrayResult = await db.queryResult("SELECT 1, 1", undefined, { rowMode: "array" });
  const firstCell: unknown = arrayResult.rows[0]?.[0];
  void [arrays, firstCell];

  // Transactions take the same options.
  const total = await db.transaction(
    async (tx) => {
      await tx.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", [100, 1], {
        binding: "prepared",
      });
      const rows = await tx.query<{ [column: string]: unknown; balance: number }>(
        "SELECT balance FROM accounts WHERE id = ?",
        [1],
      );
      return rows[0]?.balance ?? 0;
    },
    { isolationLevel: "read committed" },
  );
  void total;

  const scope = await db.beginTransactionScope();
  await scope.execute("DELETE FROM t WHERE a = ?", [1]);
  await scope.commit();

  // Helpers keep working and now type-check straight into query().
  const where = buildWhere({ name: "kim", deleted_at: null });
  await db.query(`SELECT * FROM ${escapeIdentifier("users")} ${where.clause}`, where.params);

  // Errors carry outcomeUnknown (#254, in progress).
  try {
    await db.execute("UPDATE t SET a = 1");
  } catch (error) {
    if (error instanceof QueryError && error.outcomeUnknown === true) {
      // Check the server before running it again.
    }
  }

  await db.close();
}

// ------------------------------------------------- application code, pool

export async function poolCode(): Promise<void> {
  const pool: CubridPool = createPool({
    host: "localhost",
    database: "demodb",
    user: "dba",
    max: 10,
    binding: "literal",
  });

  await pool.query("SELECT 1", [], { binding: "prepared" });
  const count = await pool.connection(async (connection) => {
    let rows = 0;
    for await (const _row of connection.stream("SELECT * FROM t", [], { binding: "prepared" })) {
      rows += 1;
    }
    return rows;
  });
  void [count, pool.stats().idle];
  await pool.close();
}

// ------------------------------------------------- library code

// A structural type such as the one drizzle-cubrid declares keeps accepting a
// client and a pool, because the default query() overload is unchanged in shape.
interface DownstreamQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}
export function downstreamAccepts(client: CubridClient, pool: CubridPool): DownstreamQueryable[] {
  return [client, pool];
}

// Libraries accept the narrow interfaces, which a client, a pool, a leased
// connection and a transaction all satisfy.
export async function countRows(db: Queryable, table: string): Promise<number> {
  const rows = await db.query<{ [column: string]: unknown; n: number }>(
    `SELECT COUNT(*) AS n FROM ${escapeIdentifier(table)}`,
  );
  return rows[0]?.n ?? 0;
}
export function narrowInterfaces(client: CubridClient, pool: CubridPool, tx: TransactionClient) {
  const all: StatementClient[] = [client, pool];
  const queryables: Queryable[] = [client, pool, tx];
  return { all, queryables };
}

// A binding chosen at run time (for example from configuration) is typed.
export function bindingFromConfig(value: string): Binding {
  return value === "prepared" ? "prepared" : "literal";
}

// ------------------------------------------------- driver code (subpath)

// A custom connection that only renders literals. Declaring nothing in
// `capabilities` means literal only: the client refuses `binding: "prepared"`
// for it instead of letting it fall back.
class RecordingConnection implements ConnectionLike {
  readonly statements: DriverStatement[] = [];
  async connect(): Promise<void> {}
  async query(statement: DriverStatement): Promise<DriverQueryResult> {
    this.statements.push(statement);
    return { rows: [], columns: [] };
  }
  async execute(statement: DriverStatement): Promise<ExecuteResult> {
    this.statements.push(statement);
    return { affectedRows: 0 };
  }
  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async close(): Promise<void> {}
}

// Wrapping the built-in adapter, for example to add tracing.
const tracingFactory: ConnectionFactory = (config: ClientConfig) => {
  const inner = new NativeCubridAdapter(config);
  const capabilities = inner.capabilities;
  return {
    capabilities,
    connect: () => inner.connect(),
    query: (statement, options) => inner.query(statement, options),
    execute: (statement, options) => inner.execute(statement, options),
    stream: (statement, options) => inner.stream(statement, options),
    beginTransaction: () => inner.beginTransaction(),
    commit: () => inner.commit(),
    rollback: () => inner.rollback(),
    close: () => inner.close(),
    destroy: () => inner.destroy(),
  };
};

// The adapter class satisfies the factory contract directly.
const nativeFactory: ConnectionFactory = (config) => new NativeCubridAdapter(config);

export function driverCode(): void {
  new CubridClient(
    { host: "localhost", port: 33000, database: "demodb", user: "dba", password: "" },
    nativeFactory,
  );
  createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => new RecordingConnection(),
  });
  createPool({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: tracingFactory,
  });

  const tx: TransactionClient = new CubridTransaction(new RecordingConnection());
  void tx;
}

// ------------------------------------------------- what 2.0 rejects at compile time

export async function rejected(db: CubridClient): Promise<void> {
  // The *Prepared variants are gone: use { binding: "prepared" }.
  // @ts-expect-error queryPrepared() is removed in 2.0
  await db.queryPrepared("SELECT ?", [1]);
  // @ts-expect-error queryResultPrepared() is removed in 2.0
  await db.queryResultPrepared("SELECT ?", [1]);
  // @ts-expect-error executePrepared() is removed in 2.0
  await db.executePrepared("DELETE FROM t WHERE a = ?", [1]);

  // @ts-expect-error only "literal" and "prepared" exist
  await db.query("SELECT 1", [], { binding: "server" });

  // @ts-expect-error executeMany() always binds on the server and takes no binding
  await db.executeMany("INSERT INTO t VALUES (?)", [[1]], { binding: "literal" });

  // @ts-expect-error collections are not parameters on either binding
  await db.query("SELECT ?", [[1, 2]]);

  // @ts-expect-error undefined is not a QueryParam; 2.0 also refuses it at run time
  await db.query("SELECT ?", [undefined]);

  // @ts-expect-error the client constructor needs a config and a connection factory
  new CubridClient();

  // @ts-expect-error a LOB is not an executeMany() parameter
  await db.executeMany("INSERT INTO t VALUES (?)", [[blob(Buffer.alloc(1))]]);
}

// The driver SPI is not exported from the root entry point, and the 1.x
// capability interfaces are gone.
// @ts-expect-error ConnectionLike lives in "cubrid-client/driver"
export type RootConnectionLike = Root.ConnectionLike;
// @ts-expect-error ConnectionFactory lives in "cubrid-client/driver"
export type RootConnectionFactory = Root.ConnectionFactory;
// @ts-expect-error NativeCubridAdapter lives in "cubrid-client/driver"
export type RootAdapter = typeof Root.NativeCubridAdapter;
// @ts-expect-error PreparedQueryable is removed; StatementClient covers every method
export type RootPreparedQueryable = Root.PreparedQueryable;
