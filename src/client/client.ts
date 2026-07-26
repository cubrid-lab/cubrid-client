import { CubridTransaction } from "./transaction.js";
import { mapError } from "../internals/map-error.js";
import type {
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  Queryable,
  TransactionCallback,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResultRow } from "../types/result.js";

export class CubridClient implements Queryable {
  private sharedConnectionPromise: Promise<ConnectionLike> | undefined;

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

  async transaction<T>(callback: TransactionCallback<T>): Promise<T> {
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

  private getSharedConnection(): Promise<ConnectionLike> {
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
