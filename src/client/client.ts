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
  Queryable,
  ResultQueryable,
  ResultTransactionClient,
  TransactionCallback,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridClient implements Queryable, ResultQueryable, Executable {
  private sharedConnectionPromise: Promise<ConnectionLike> | undefined;
  private closed = false;

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

  async transaction<T>(
    callback: TransactionCallback<T, ResultTransactionClient & ExecutableTransactionClient>,
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
