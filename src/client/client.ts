import * as schema from "./schema.js";
import { CallbackTransaction } from "./transaction.js";
import { TransactionError } from "../errors/transaction-error.js";
import { mapError, toError } from "../internals/map-error.js";
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
  TransactionCallback,
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

export class CubridClient implements Queryable, ResultQueryable, Executable, PreparedQueryable {
  private sharedConnectionPromise: Promise<ConnectionLike> | undefined;
  private closed = false;
  private readonly schemaOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly config: ClientConfig,
    private readonly connectionFactory: ConnectionFactory,
  ) {}

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

  async transaction<T>(
    callback: TransactionCallback<
      T,
      ResultTransactionClient & ExecutableTransactionClient & PreparedTransactionClient
    >,
  ): Promise<T> {
    if (this.closed) {
      throw mapError("transaction", new Error("Client is closed."), "Transaction failed.");
    }

    const connection = await this.connectionFactory(this.config);
    let transaction: CallbackTransaction | undefined;
    let failed = false;
    let details: TransactionError | undefined;

    try {
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

  async beginTransaction(): Promise<void> {
    try {
      const connection = await this.getSharedConnection();
      await connection.beginTransaction();
    } catch (error) {
      throw mapError("transaction", error, "Failed to begin transaction.");
    }
  }

  async commit(): Promise<void> {
    try {
      const connection = await this.getSharedConnection();
      await connection.commit();
    } catch (error) {
      throw mapError("transaction", error, "Failed to commit.");
    }
  }

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
      this.sharedConnectionPromise = Promise.resolve(
        this.connectionFactory(this.config),
      ).catch((error) => {
        this.sharedConnectionPromise = undefined;
        throw error;
      });
    }

    return this.sharedConnectionPromise;
  }
}
