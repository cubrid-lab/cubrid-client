import { AsyncLocalStorage } from "node:async_hooks";
import { NotSentError } from "../errors/internal-errors.js";
import { isAbortReason, mapError } from "../internals/map-error.js";
import {
  ARRAY_ROWS_UNSUPPORTED,
  assertValidQueryOptions,
  assertValidStreamOptions,
  assertValidTimezone,
  assertValidTransactionOptions,
  checkedResult,
  checkedRows,
  pickTransactionOptions,
  wantsArrayRows,
} from "../internals/normalize-config.js";
import { assertValidCharset } from "../protocol/charset.js";
import { assertValidCredentials } from "../protocol/protocol.js";
import type {
  ArrayRowOptions,
  ArrayRowQueryable,
  ArrayStreamOptions,
  BatchExecutable,
  BatchTransactionClient,
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  Executable,
  ExecutableTransactionClient,
  ExecuteManyResult,
  ExecuteOptions,
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
import type { ArrayQueryResult, QueryResult, QueryResultRow } from "../types/result.js";
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
  /**
   * transaction() calls from admission to their end, including the connection
   * factory, BEGIN, the callback, COMMIT or ROLLBACK and the connection close.
   * The promises never reject. close() waits for them (#246).
   */
  private readonly transactions = new Set<Promise<void>>();
  /** Entries of `transactions` whose callback is running now. */
  private readonly runningCallbacks = new Set<Promise<void>>();
  /** The transaction() calls enclosing this async context, so close() never waits for itself. */
  private readonly enclosingTransactions = new AsyncLocalStorage<ReadonlySet<Promise<void>>>();
  /** Where transaction() opens its connection: the client's source, refusing once closed. */
  private readonly transactionSource: ConnectionSource;
  /** Everything close() waits for but transaction() calls. Rejects as close() does. */
  private closingConnections: Promise<void> | undefined;
  /** The transaction() calls running when close() was first called. */
  private closingTransactions: Promise<void>[] = [];
  /** close() for every caller outside a running callback, returned to each of them. */
  private closing: Promise<void> | undefined;
  private signalDestroyed: () => void = () => undefined;
  /** Resolves when destroy() runs, which ends the wait of a running close(). */
  private readonly destroyedSignal = new Promise<void>((resolve) => {
    this.signalDestroyed = resolve;
  });

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
    this.transactionSource = {
      ...this.source,
      open: async () => {
        const connection = await this.source.open();
        // close() ran while the factory did: nothing is sent on this connection.
        if (this.closed) {
          await this.source.end(connection, "error").catch(() => {
            // The client is closed; that is the failure to report.
          });
          throw mapError(
            "transaction",
            new NotSentError("Client is closed."),
            "Transaction failed.",
          );
        }
        return connection;
      },
    };
  }

  /**
   * Run a statement and return its rows. See {@link QueryOptions} for `signal`
   * and a per-statement `readTimeout`. With `rowMode: "array"` each row is an
   * array of its values in select-list order; see {@link ArrayRowOptions}.
   *
   * @throws RangeError or TypeError (as a rejection, before anything is sent)
   * when an option is invalid.
   */
  query<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]>;
  query(sql: string, params?: QueryParams, options?: QueryOptions): Promise<unknown[]> {
    return runStatement(
      options,
      "Query failed.",
      () => this.literalConnection(params),
      async (connection) => checkedRows(options, await connection.query(sql, params, options)),
    );
  }

  /** {@link query} with the columns of the result. See {@link QueryResult}. */
  queryResult<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryResult(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return runStatement(
      options,
      "Query failed.",
      () => this.literalConnection(params),
      async (connection) => {
        if (!connection.queryResult) {
          throw new Error("Underlying connection does not support queryResult.");
        }
        return checkedResult(options, await connection.queryResult(sql, params, options));
      },
    );
  }

  execute(sql: string, params?: QueryParams, options?: ExecuteOptions): Promise<ExecuteResult> {
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

  queryPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]>;
  queryPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<unknown[]> {
    return runStatement(
      options,
      "Query failed.",
      () => this.getSharedConnection(),
      async (connection) => {
        if (!connection.queryPrepared) {
          throw new Error("Underlying connection does not support queryPrepared.");
        }
        return checkedRows(options, await connection.queryPrepared(sql, params, options));
      },
    );
  }

  queryResultPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryResultPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return runStatement(
      options,
      "Query failed.",
      () => this.getSharedConnection(),
      async (connection) => {
        if (!connection.queryResultPrepared) {
          throw new Error("Underlying connection does not support queryResultPrepared.");
        }
        return checkedResult(options, await connection.queryResultPrepared(sql, params, options));
      },
    );
  }

  executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: ExecuteOptions,
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
   * connection, or another client. With `rowMode: "array"` each row is an array
   * of its values in select-list order. See `docs/API_REFERENCE.md`.
   *
   * @throws RangeError or TypeError at once when an option is invalid.
   */
  stream<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayStreamOptions,
  ): AsyncGenerator<T, void, undefined>;
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined>;
  /**
   * The signature of {@link Streamable.stream}, so a union of this type with
   * `Streamable` or `ConnectionLike` stays callable. Never chosen by a direct call.
   */
  stream<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncIterable<T>;
  stream(
    sql: string,
    params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<unknown, void, undefined> {
    assertValidStreamOptions(options);
    refuseLobParams(params);
    return streamRows(() => this.getSharedConnection(), sql, params, options);
  }

  async transaction<T>(
    callback: TransactionCallback<
      T,
      ArrayRowQueryable &
        ResultTransactionClient &
        ExecutableTransactionClient &
        PreparedTransactionClient &
        BatchTransactionClient
    >,
    options?: TransactionOptions,
  ): Promise<T> {
    assertValidTransactionOptions(options);

    if (this.closed) {
      throw mapError("transaction", new NotSentError("Client is closed."), "Transaction failed.");
    }

    const enclosing = this.enclosingTransactions.getStore();
    let tracked: Promise<void> | undefined;
    const running = runTransaction(
      this.transactionSource,
      async (tx) => {
        // close() ran while the transaction options were applied or BEGIN was sent:
        // the callback never starts, and the transaction is rolled back and its
        // connection closed.
        if (this.closed) {
          throw new NotSentError("Client is closed.");
        }
        const chain = new Set(enclosing);
        if (tracked) {
          chain.add(tracked);
          this.runningCallbacks.add(tracked);
        }
        try {
          return await this.enclosingTransactions.run(chain, () => callback(tx));
        } finally {
          if (tracked) {
            this.runningCallbacks.delete(tracked);
          }
        }
      },
      options,
    );
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    tracked = settled;
    this.transactions.add(settled);
    void settled.then(() => {
      this.transactions.delete(settled);
    });
    return running;
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
      throw mapError(
        "transaction",
        new NotSentError("Client is closed."),
        "Failed to begin transaction.",
      );
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

  /**
   * Stop the client and close its connections once the work already started is
   * done. In the same tick, every later call rejects with `Client is closed.`
   * Statements on the shared connection, schema lookups and `transaction()`
   * callbacks already running finish, including their COMMIT or ROLLBACK, and
   * their connections close; a `transaction()` whose callback has not started
   * yet is rolled back without running it. Scopes nobody ended are discarded.
   * Calling it again returns the same promise; after `destroy()` it resolves.
   * Awaited inside a running `transaction()` callback, it waits for no callback,
   * since it would wait for itself. See `docs/API_REFERENCE.md`.
   */
  close(): Promise<void> {
    // Set first, in the same tick, so no later call can open a connection.
    this.closed = true;
    // destroy() has already torn every connection down.
    if (this.destroyed) {
      return Promise.resolve();
    }
    if (!this.closingConnections) {
      // No transaction() can start from now on.
      this.closingTransactions = [...this.transactions];
      this.closingConnections = this.shutdown();
    }

    // A callback awaiting close() would wait for itself, and two of them for each
    // other, so inside a running callback close() waits for no callback. Only
    // while it runs: a timer it set that calls close() after it returned waits.
    const own = this.enclosingTransactions.getStore();
    if (own && [...own].some((transaction) => this.runningCallbacks.has(transaction))) {
      return this.waitForClose([]);
    }
    this.closing ??= this.waitForClose(this.closingTransactions);
    return this.closing;
  }

  /**
   * Resolves once the connections are closed and `transactions` ended, or once
   * destroy() runs, which is the way out of a close() that waits too long.
   * Callbacks are waited for alongside the connections, not after them: one may
   * wait for a lock that only closing the shared connection or a scope releases.
   */
  private waitForClose(transactions: Promise<void>[]): Promise<void> {
    const closed = (async () => {
      // These never reject.
      const ended = Promise.all(transactions);
      try {
        await this.closingConnections;
      } finally {
        await ended;
      }
    })();
    return Promise.race([closed, this.destroyedSignal]);
  }

  private async shutdown(): Promise<void> {
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
    this.signalDestroyed();

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
      return Promise.reject(
        mapError("query", new NotSentError("Client is closed."), "Query failed."),
      );
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
      return Promise.reject(new NotSentError("Client is closed."));
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
export async function* streamRows<T>(
  connect: () => Promise<ConnectionLike>,
  sql: string,
  params: QueryParams | undefined,
  options: StreamOptions | undefined,
): AsyncGenerator<T, void, undefined> {
  const arrays = wantsArrayRows(options);
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
    rows = (connection.stream(sql, params, options) as AsyncIterable<T>)[Symbol.asyncIterator]();
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
      if (arrays && !Array.isArray(next.value)) {
        throw failure(new Error(ARRAY_ROWS_UNSUPPORTED));
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
