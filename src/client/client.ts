import { CubridTransaction } from "./transaction.js";
import { mapError } from "../internals/map-error.js";
import type {
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  Queryable,
  ResultQueryable,
  ResultTransactionClient,
  TransactionCallback,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridClient implements Queryable, ResultQueryable {
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

  async transaction<T>(
    callback: TransactionCallback<T, ResultTransactionClient>,
  ): Promise<T> {
    const connection = await this.connectionFactory(this.config);
    const transaction = new CubridTransaction(connection);

    try {
      await connection.beginTransaction();
      const result = await callback(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the original transaction error.
      }

      throw mapError("transaction", error, "Transaction failed.");
    } finally {
      await connection.close();
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
   * Return the CUBRID server version, for example `11.4.6.1963`. It is the same
   * single GET_DB_VERSION request as `ping()` and shares its transaction and
   * reconnect behavior; only the failure message differs.
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
