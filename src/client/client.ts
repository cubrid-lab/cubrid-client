import { isAbortReason, mapError } from "../internals/map-error.js";
import {
  assertValidQueryOptions,
  assertValidStreamOptions,
  assertValidTimezone,
  assertValidTransactionOptions,
  pickTransactionOptions,
} from "../internals/normalize-config.js";
import { assertValidCharset } from "../protocol/charset.js";
import { assertValidCredentials } from "../protocol/protocol.js";
import type {
  BatchExecutable,
  BatchTransactionClient,
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  Executable,
  ExecutableTransactionClient,
  ExecuteManyResult,
  ExecuteResult,
  PreparedQueryable,
  PreparedTransactionClient,
  Queryable,
  QueryOptions,
  ResultQueryable,
  ResultTransactionClient,
  Streamable,
  StreamOptions,
  TransactionCallback,
  TransactionOptions,
  TransactionScope,
} from "../types/client.js";
import { type PreparedQueryParam, refuseLobParams } from "../types/lob.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";
import type {
  SchemaColumn,
  SchemaIndex,
  SchemaOptions,
  SchemaPrimaryKey,
  SchemaTable,
} from "../types/schema.js";
import {
  applyTransactionOptions,
  beginScope,
  type ConnectionSource,
  factorySource,
  runTransaction,
} from "./connection-source.js";
import * as schema from "./schema.js";
import type { ScopedTransaction } from "./transaction.js";

export class CubridClient
  implements Queryable, ResultQueryable, Executable, PreparedQueryable, BatchExecutable, Streamable
{
  private sharedConnectionPromise: Promise<ConnectionLike> | undefined;
  /** The shared connection as soon as the factory returns it, before it is ready. */
  private sharedConnection: ConnectionLike | undefined;
  /** Where transaction() and beginTransactionScope() open their own connections. */
  private readonly source: ConnectionSource;
  private closed = false;
  private destroyed = false;
  /** Connections of transaction() and beginTransactionScope() not ended yet, for destroy(). */
  private readonly dedicated = new Set<ConnectionLike>();
  private readonly schemaOperations = new Set<Promise<unknown>>();
  private readonly openScopes = new Set<ScopedTransaction>();
  /** beginTransactionScope() calls still opening a connection, so close() can wait for them. */
  private readonly beginningScopes = new Set<Promise<unknown>>();

  constructor(
    private readonly config: ClientConfig,
    private readonly connectionFactory: ConnectionFactory,
  ) {
    assertValidCredentials(config);
    assertValidTransactionOptions(config);
    assertValidTimezone(config.timezone);
    assertValidCharset(config.charset);
    const source = factorySource(config, connectionFactory);
    this.source = {
      ...source,
      open: async () => {
        const connection = await source.open();
        if (this.destroyed) {
          // Its calls then reject as lost, so the transaction fails as one would.
          destroyConnection(connection);
        } else {
          this.dedicated.add(connection);
        }
        return connection;
      },
      end: async (connection, verdict) => {
        try {
          await source.end(connection, verdict);
        } finally {
          this.dedicated.delete(connection);
        }
      },
    };
  }

  /**
   * Run a statement and return its rows. See {@link QueryOptions} for `signal`
   * and a per-statement `readTimeout`.
   *
   * @throws RangeError or TypeError (as a rejection, before anything is sent)
   * when an option is invalid.
   */
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return runStatement(
      options,
      "Query failed.",
      () => this.literalConnection(params),
      (connection) => connection.query<T>(sql, params, options),
    );
  }

  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return runStatement(
      options,
      "Query failed.",
      () => this.literalConnection(params),
      (connection) => {
        if (!connection.queryResult) {
          throw new Error("Underlying connection does not support queryResult.");
        }
        return connection.queryResult<T>(sql, params, options);
      },
    );
  }

  execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult> {
    return runStatement(
      options,
      "Statement failed.",
      () => this.literalConnection(params),
      (connection) => {
        if (!connection.execute) {
          throw new Error("Underlying connection does not support execute.");
        }
        return connection.execute(sql, params, options);
      },
    );
  }

  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return runStatement(
      options,
      "Query failed.",
      () => this.getSharedConnection(),
      (connection) => {
        if (!connection.queryPrepared) {
          throw new Error("Underlying connection does not support queryPrepared.");
        }
        return connection.queryPrepared<T>(sql, params, options);
      },
    );
  }

  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return runStatement(
      options,
      "Query failed.",
      () => this.getSharedConnection(),
      (connection) => {
        if (!connection.queryResultPrepared) {
          throw new Error("Underlying connection does not support queryResultPrepared.");
        }
        return connection.queryResultPrepared<T>(sql, params, options);
      },
    );
  }

  executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<ExecuteResult> {
    return runStatement(
      options,
      "Statement failed.",
      () => this.getSharedConnection(),
      (connection) => {
        if (!connection.executePrepared) {
          throw new Error("Underlying connection does not support executePrepared.");
        }
        return connection.executePrepared(sql, params, options);
      },
    );
  }

  /**
   * Run one INSERT, UPDATE, DELETE or MERGE once per parameter set, with
   * server-side prepared binding: one PREPARE, then one EXECUTE_ARRAY request
   * for every set (several for a batch over about 1 MiB of values), instead of
   * a round trip per set. `results` holds each set's affected rows, in order.
   *
   * On this client, which runs in autocommit mode, the batch is all or nothing:
   * it is committed only when every set succeeded. Otherwise it is rolled back
   * and rejects with a `QueryError` whose `batch` reports every set's outcome.
   * An empty `paramSets` resolves `{ affectedRows: 0, results: [] }` and sends
   * nothing. A SELECT, SQL holding more than one statement, a statement without
   * a `?` marker and a set whose size is not the statement's marker count are
   * refused. Nothing is retried. See `docs/API_REFERENCE.md`.
   */
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: QueryOptions,
  ): Promise<ExecuteManyResult> {
    return runStatement(
      options,
      "Statement failed.",
      () => this.getSharedConnection(),
      (connection) => {
        if (!connection.executeMany) {
          throw new Error("Underlying connection does not support executeMany.");
        }
        return connection.executeMany(sql, paramSets, options);
      },
    );
  }

  /**
   * Run a statement and read its rows one at a time with `for await`, holding at
   * most one server reply of rows in memory. Nothing is sent before the first read.
   *
   * The open cursor holds this connection's turn until the rows run out or the
   * stream closes. A `break`, a throw or a failed read closes it and releases the
   * query handle; code that drives the iterator by hand must call `return()`.
   * Statements issued on this client meanwhile wait, so one awaited inside the loop
   * can never run: it rejects with `kind: "stream-busy"` after
   * {@link StreamOptions.consumerTimeout}. Use `transaction()`, which has its own
   * connection, or another client. See `docs/API_REFERENCE.md`.
   *
   * @throws RangeError at once when an option is invalid.
   */
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    assertValidStreamOptions(options);
    refuseLobParams(params);
    return streamRows<T>(() => this.getSharedConnection(), sql, params, options);
  }

  async transaction<T>(
    callback: TransactionCallback<
      T,
      ResultTransactionClient &
        ExecutableTransactionClient &
        PreparedTransactionClient &
        BatchTransactionClient
    >,
    options?: TransactionOptions,
  ): Promise<T> {
    assertValidTransactionOptions(options);

    if (this.closed) {
      throw mapError("transaction", new Error("Client is closed."), "Transaction failed.");
    }

    return runTransaction(this.source, callback, options);
  }

  /**
   * Start a manual transaction on its own connection and return the handle that
   * owns it. Statements belong to the transaction only when sent through the
   * handle; `client.query()` and the rest keep using the shared connection in
   * autocommit, so concurrent callers can never join it (#112).
   *
   * End it with exactly one `commit()` or `rollback()`, which also closes its
   * connection; later calls on the handle reject without reaching the server.
   * `close()` rolls back a handle that was never ended.
   *
   * @throws RangeError at once when an option is invalid.
   */
  async beginTransactionScope(options?: TransactionOptions): Promise<TransactionScope> {
    assertValidTransactionOptions(options);

    if (this.closed) {
      throw mapError("transaction", new Error("Client is closed."), "Failed to begin transaction.");
    }

    const beginning = this.openScope(options);
    this.beginningScopes.add(beginning);
    try {
      return await beginning;
    } finally {
      this.beginningScopes.delete(beginning);
    }
  }

  private openScope(options: TransactionOptions | undefined): Promise<TransactionScope> {
    return beginScope(
      this.source,
      options,
      () => this.closed,
      "Client is closed.",
      this.openScopes,
    );
  }

  /**
   * Start a manual transaction on the shared connection.
   *
   * @deprecated This 1.x method has no ownership token: any other call on this
   * client while the transaction is open, including an unrelated caller's,
   * joins the same server transaction. Use {@link beginTransactionScope}, or
   * `transaction(async (tx) => ...)`, which own a dedicated connection. Kept,
   * with its behavior unchanged, for all of 1.x. See issue #112.
   */
  async beginTransaction(): Promise<void> {
    try {
      const connection = await this.getSharedConnection();
      await connection.beginTransaction();
    } catch (error) {
      throw mapError("transaction", error, "Failed to begin transaction.");
    }
  }

  /**
   * Commit the manual transaction started by {@link beginTransaction}.
   *
   * @deprecated Use the `commit()` of a {@link beginTransactionScope} handle. See issue #112.
   */
  async commit(): Promise<void> {
    try {
      const connection = await this.getSharedConnection();
      await connection.commit();
    } catch (error) {
      throw mapError("transaction", error, "Failed to commit.");
    }
  }

  /**
   * Roll back the manual transaction started by {@link beginTransaction}.
   *
   * @deprecated Use the `rollback()` of a {@link beginTransactionScope} handle. See issue #112.
   */
  async rollback(): Promise<void> {
    try {
      const connection = await this.getSharedConnection();
      await connection.rollback();
    } catch (error) {
      throw mapError("transaction", error, "Failed to rollback.");
    }
  }

  async close(): Promise<void> {
    // Set first, in the same tick, so no later call can open a connection.
    this.closed = true;
    // destroy() has already torn every connection down.
    if (this.destroyed) {
      return;
    }
    // In-flight schema lookups can still require follow-up catalog queries.
    await Promise.allSettled([...this.schemaOperations]);

    // Scopes nobody ended are discarded alongside the shared connection, not
    // before it: a scope statement may be waiting for a lock that only closing
    // the shared connection releases. A scope still beginning sees `closed`
    // and closes its own connection.
    const scopes = Promise.allSettled([
      ...this.beginningScopes,
      ...[...this.openScopes].map((scope) => scope.discard()),
    ]);
    try {
      await this.closeSharedConnection();
    } finally {
      await scopes;
    }
  }

  private async closeSharedConnection(): Promise<void> {
    if (!this.sharedConnectionPromise) {
      return;
    }

    try {
      const connection = await this.sharedConnectionPromise;
      await connection.close();
      this.sharedConnectionPromise = undefined;
    } catch (error) {
      // A destroy() that ran meanwhile is what failed it, and that is not a failed close.
      if (this.destroyed) {
        return;
      }
      throw mapError("connection", error, "Failed to close client connection.");
    }
  }

  /**
   * Tear down every connection of this client now, without waiting for anything
   * on them: the shared connection, `beginTransactionScope()` handles and
   * `transaction()` callbacks, even mid-handshake once the connection factory has
   * returned the connection. For when `close()` would wait
   * too long, such as a server that stopped answering or a process shutting down.
   *
   * Like `close()`, it stops new calls first. A statement in flight rejects with
   * kind `connection-lost`; its outcome on the server is unknown, it is never
   * retried, and the server rolls back its open transaction. Every statement
   * still waiting rejects the same way without being sent. No COMMIT is sent
   * after destroy(): a `transaction()` callback that goes on fails, and a commit
   * already in flight has an unknown outcome. Open scopes are discarded and open
   * streams end with that error. Resolves at once; calling `destroy()` or `close()` again
   * resolves too.
   *
   * A custom connection without `destroy()` is closed instead, without waiting
   * for its `close()`.
   */
  async destroy(): Promise<void> {
    this.closed = true;
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    if (this.sharedConnection) {
      destroyConnection(this.sharedConnection);
    }
    for (const connection of this.dedicated) {
      destroyConnection(connection);
    }
    for (const scope of this.openScopes) {
      // Its connection is gone, so ending it does not wait. Never rejects.
      void scope.discard();
    }
  }

  async ping(): Promise<string> {
    try {
      const connection = await this.getSharedConnection();
      if (connection.ping) {
        return await connection.ping();
      }
      throw new Error("Underlying connection does not support ping.");
    } catch (error) {
      throw mapError("connection", error, "Health check failed.");
    }
  }

  /**
   * Return the CUBRID server version, for example `11.4.6.1963`. It sends the
   * same requests as `ping()` and shares its transaction and reconnect behavior;
   * only the failure message differs.
   */
  async getServerVersion(): Promise<string> {
    try {
      const connection = await this.getSharedConnection();
      if (connection.ping) {
        return await connection.ping();
      }
      throw new Error("Underlying connection does not support querying the server version.");
    } catch (error) {
      throw mapError("connection", error, "Failed to get the server version.");
    }
  }

  /**
   * List the user tables and views the connected user may SELECT from, ordered
   * by owner and name. See {@link SchemaOptions} to list one owner only.
   */
  getTables(options?: SchemaOptions): Promise<SchemaTable[]> {
    return this.runSchemaOperation((query) => schema.getTables(query, options));
  }

  /** List the columns of a table or view in table order. */
  getColumns(table: string, options?: SchemaOptions): Promise<SchemaColumn[]> {
    return this.runSchemaOperation((query) => schema.getColumns(query, table, options));
  }

  /** Return the primary key of a table, or `null` when it has none. */
  getPrimaryKey(table: string, options?: SchemaOptions): Promise<SchemaPrimaryKey | null> {
    return this.runSchemaOperation((query) => schema.getPrimaryKey(query, table, options));
  }

  /** List the indexes of a table, including its primary and foreign keys. */
  getIndexes(table: string, options?: SchemaOptions): Promise<SchemaIndex[]> {
    return this.runSchemaOperation((query) => schema.getIndexes(query, table, options));
  }

  /** Run catalog inspections on a captured shared connection until completion. */
  private runSchemaOperation<T>(operation: (query: schema.SchemaQuery) => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(mapError("query", new Error("Client is closed."), "Query failed."));
    }
    // Capture the connection immediately. Subsequent catalog queries must still
    // run even after close() rejects new public operations.
    const connectionPromise = this.getSharedConnection();
    const running = (async () => {
      const connection = await connectionPromise;
      const query: schema.SchemaQuery = async (sql, params) => {
        try {
          return await connection.query(sql, params);
        } catch (error) {
          throw mapError("query", error, "Query failed.");
        }
      };
      return await operation(query);
    })();
    this.schemaOperations.add(running);
    void running.then(
      () => {
        this.schemaOperations.delete(running);
      },
      () => {
        this.schemaOperations.delete(running);
      },
    );
    return running;
  }

  /**
   * getSharedConnection() for a method that renders SQL literals, refusing blob()
   * and clob() first. Not async: an extra await would let a statement issued later
   * take the connection's turn first.
   */
  private literalConnection(params: QueryParams | undefined): Promise<ConnectionLike> {
    refuseLobParams(params);
    return this.getSharedConnection();
  }

  private getSharedConnection(): Promise<ConnectionLike> {
    if (this.closed) {
      return Promise.reject(new Error("Client is closed."));
    }

    if (!this.sharedConnectionPromise) {
      this.sharedConnectionPromise = Promise.resolve(this.connectionFactory(this.config))
        .then((connection) => {
          this.sharedConnection = connection;
          if (this.destroyed) {
            destroyConnection(connection);
          }
          return this.prepareSharedConnection(connection);
        })
        .catch((error) => {
          this.sharedConnectionPromise = undefined;
          throw error;
        });
    }

    return this.sharedConnectionPromise;
  }
  private async prepareSharedConnection(connection: ConnectionLike): Promise<ConnectionLike> {
    try {
      await applyTransactionOptions(connection, pickTransactionOptions(this.config));
      return connection;
    } catch (error) {
      await connection.close().catch(() => {
        // The failure that decided this connection's fate is the one to report.
      });
      throw error;
    }
  }
}

/**
 * destroy() of `connection`, or for a custom connection without one, a close()
 * nobody waits for. Never throws.
 */
function destroyConnection(connection: ConnectionLike): void {
  try {
    if (connection.destroy) {
      // Declared void, but a custom one may still return a promise that rejects.
      const result: unknown = connection.destroy();
      if (typeof result === "object" && result !== null && "then" in result) {
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
      return;
    }
    Promise.resolve()
      .then(() => connection.close())
      .catch(() => {
        // Nobody waits for it, and the connection is abandoned either way.
      });
  } catch {
    // A custom destroy() that throws must not stop the others.
  }
}

/**
 * Runs one statement on the shared connection. Invalid options and a signal
 * already aborted reject before a connection is opened, and the reason of the
 * caller's own abort is passed on unchanged.
 */
async function runStatement<R>(
  options: QueryOptions | undefined,
  failureMessage: string,
  connect: () => Promise<ConnectionLike>,
  run: (connection: ConnectionLike) => Promise<R>,
): Promise<R> {
  assertValidQueryOptions(options);
  options?.signal?.throwIfAborted();

  try {
    return await run(await connect());
  } catch (error) {
    if (isAbortReason(error, options?.signal)) {
      throw error;
    }
    throw mapError("query", error, failureMessage);
  }
}

/**
 * Reads the rows of `stream()` from the connection `connect` gives. A failure
 * of `connect` or of a read is a QueryError; the reason of the caller's own
 * abort is passed on unchanged. A stream left early is closed on its connection.
 */
export async function* streamRows<T extends QueryResultRow>(
  connect: () => Promise<ConnectionLike>,
  sql: string,
  params: QueryParams | undefined,
  options: StreamOptions | undefined,
): AsyncGenerator<T, void, undefined> {
  // An abort is the caller's own decision, so its reason stays as it is.
  const failure = (error: unknown): unknown =>
    options?.signal?.aborted && error === options.signal.reason
      ? error
      : mapError("query", error, "Query failed.");

  let rows: AsyncIterator<T>;
  try {
    const connection = await connect();
    if (!connection.stream) {
      throw new Error("Underlying connection does not support stream.");
    }
    rows = connection.stream<T>(sql, params, options)[Symbol.asyncIterator]();
  } catch (error) {
    throw failure(error);
  }

  let exhausted = false;
  try {
    for (;;) {
      let next: IteratorResult<T>;
      try {
        next = await rows.next();
      } catch (error) {
        exhausted = true;
        throw failure(error);
      }

      if (next.done) {
        exhausted = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!exhausted) {
      try {
        await rows.return?.();
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: a failed cleanup of an unfinished stream is the error the caller must see
        throw failure(error);
      }
    }
  }
}
