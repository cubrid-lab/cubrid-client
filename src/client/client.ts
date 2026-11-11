import * as schema from "./schema.js";
import { CallbackTransaction, ScopedTransaction } from "./transaction.js";
import { TransactionError } from "../errors/transaction-error.js";
import { mapError, toError } from "../internals/map-error.js";
import {
  assertValidStreamOptions,
  assertValidTimezone,
  assertValidTransactionOptions,
  pickTransactionOptions,
} from "../internals/normalize-config.js";
import type {
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  Executable,
  ExecutableTransactionClient,
  ExecuteResult,
  PreparedQueryable,
  PreparedTransactionClient,
  Queryable,
  ResultQueryable,
  ResultTransactionClient,
  Streamable,
  StreamOptions,
  TransactionCallback,
  TransactionOptions,
  TransactionScope,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";
import type {
  SchemaColumn,
  SchemaIndex,
  SchemaOptions,
  SchemaPrimaryKey,
  SchemaTable,
} from "../types/schema.js";

export class CubridClient implements Queryable, ResultQueryable, Executable, PreparedQueryable, Streamable {
  private sharedConnectionPromise: Promise<ConnectionLike> | undefined;
  private closed = false;
  private readonly schemaOperations = new Set<Promise<unknown>>();
  private readonly openScopes = new Set<ScopedTransaction>();
  /** beginTransactionScope() calls still opening a connection, so close() can wait for them. */
  private readonly beginningScopes = new Set<Promise<unknown>>();

  constructor(
    private readonly config: ClientConfig,
    private readonly connectionFactory: ConnectionFactory,
  ) {
    assertValidTransactionOptions(config);
    assertValidTimezone(config.timezone);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    try {
      const connection = await this.getSharedConnection();
      return await connection.query<T>(sql, params);
    } catch (error) {
      throw mapError("query", error, "Query failed.");
    }
  }

  async queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    try {
      const connection = await this.getSharedConnection();
      if (!connection.queryResult) {
        throw new Error("Underlying connection does not support queryResult.");
      }
      return await connection.queryResult<T>(sql, params);
    } catch (error) {
      throw mapError("query", error, "Query failed.");
    }
  }

  async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    try {
      const connection = await this.getSharedConnection();
      if (!connection.execute) {
        throw new Error("Underlying connection does not support execute.");
      }
      return await connection.execute(sql, params);
    } catch (error) {
      throw mapError("query", error, "Statement failed.");
    }
  }

  async queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    try {
      const connection = await this.getSharedConnection();
      if (!connection.queryPrepared) {
        throw new Error("Underlying connection does not support queryPrepared.");
      }
      return await connection.queryPrepared<T>(sql, params);
    } catch (error) {
      throw mapError("query", error, "Query failed.");
    }
  }

  async queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    try {
      const connection = await this.getSharedConnection();
      if (!connection.queryResultPrepared) {
        throw new Error("Underlying connection does not support queryResultPrepared.");
      }
      return await connection.queryResultPrepared<T>(sql, params);
    } catch (error) {
      throw mapError("query", error, "Query failed.");
    }
  }

  async executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    try {
      const connection = await this.getSharedConnection();
      if (!connection.executePrepared) {
        throw new Error("Underlying connection does not support executePrepared.");
      }
      return await connection.executePrepared(sql, params);
    } catch (error) {
      throw mapError("query", error, "Statement failed.");
    }
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
    return this.streamRows<T>(sql, params, options);
  }

  private async *streamRows<T extends QueryResultRow>(
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
      const connection = await this.getSharedConnection();
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
          throw failure(error);
        }
      }
    }
  }

  async transaction<T>(
    callback: TransactionCallback<
      T,
      ResultTransactionClient & ExecutableTransactionClient & PreparedTransactionClient
    >,
    options?: TransactionOptions,
  ): Promise<T> {
    assertValidTransactionOptions(options);

    if (this.closed) {
      throw mapError("transaction", new Error("Client is closed."), "Transaction failed.");
    }

    const connection = await this.connectionFactory(this.config);
    let transaction: CallbackTransaction | undefined;
    let failed = false;
    let details: TransactionError | undefined;

    try {
      await this.applyTransactionOptions(connection, {
        ...pickTransactionOptions(this.config),
        ...pickTransactionOptions(options),
      });
      await connection.beginTransaction();
      transaction = new CallbackTransaction(connection);
      const result = await callback(transaction);
      await transaction.finish();
      return result;
    } catch (error) {
      failed = true;
      await transaction?.abort();
      const failure = mapError("transaction", error, "Transaction failed.");

      // mapError returns a ReadTimeoutError unchanged, and that object is not ours to modify.
      if (failure instanceof TransactionError) {
        details = failure;

        if (transaction?.rollbackFailure) {
          details.rollbackError = transaction.rollbackFailure;
        }
      }

      throw failure;
    } finally {
      try {
        await connection.close();
      } catch (closeError) {
        if (!failed) {
          throw closeError;
        }

        if (details) {
          details.closeError = toError(closeError);
        }
      }
    }
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

  private async openScope(options: TransactionOptions | undefined): Promise<TransactionScope> {
    let connection: ConnectionLike | undefined;
    try {
      connection = await this.connectionFactory(this.config);
      await this.applyTransactionOptions(connection, {
        ...pickTransactionOptions(this.config),
        ...pickTransactionOptions(options),
      });
      await connection.beginTransaction();
    } catch (error) {
      await connection?.close().catch(() => {
        // The failure to begin is the one to report.
      });
      throw mapError("transaction", error, "Failed to begin transaction.");
    }

    // close() may have run while the connection was opening: it could not see
    // this transaction, so nothing would ever end it.
    if (this.closed) {
      await connection.close().catch(() => {
        // The client is closed; that is the failure to report.
      });
      throw mapError("transaction", new Error("Client is closed."), "Failed to begin transaction.");
    }

    const scope: ScopedTransaction = new ScopedTransaction(connection, () => {
      this.openScopes.delete(scope);
    });
    this.openScopes.add(scope);
    return scope;
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
      throw mapError("connection", error, "Failed to close client connection.");
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
      () => { this.schemaOperations.delete(running); },
      () => { this.schemaOperations.delete(running); },
    );
    return running;
  }

  private getSharedConnection(): Promise<ConnectionLike> {
    if (this.closed) {
      return Promise.reject(new Error("Client is closed."));
    }

    if (!this.sharedConnectionPromise) {
      this.sharedConnectionPromise = Promise.resolve(this.connectionFactory(this.config))
        .then((connection) => this.prepareSharedConnection(connection))
        .catch((error) => {
          this.sharedConnectionPromise = undefined;
          throw error;
        });
    }

    return this.sharedConnectionPromise;
  }
  private async prepareSharedConnection(connection: ConnectionLike): Promise<ConnectionLike> {
    try {
      await this.applyTransactionOptions(connection, pickTransactionOptions(this.config));
      return connection;
    } catch (error) {
      await connection.close().catch(() => {
        // The failure that decided this connection's fate is the one to report.
      });
      throw error;
    }
  }

  /**
   * Hands `options` to a new connection before anything runs on it. A connection
   * that cannot take them fails here: the statements would otherwise run, with no
   * sign of it, under the server's defaults.
   */
  private async applyTransactionOptions(
    connection: ConnectionLike,
    options: TransactionOptions,
  ): Promise<void> {
    if (Object.keys(options).length === 0) {
      return;
    }

    if (!connection.setTransactionOptions) {
      throw new Error("Underlying connection does not support transaction options.");
    }

    await connection.setTransactionOptions(options);
  }
}
