import { mapError } from "../internals/map-error.js";
import type {
  ConnectionLike,
  ExecuteResult,
  ExecutableTransactionClient,
  ResultTransactionClient,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridTransaction implements ResultTransactionClient, ExecutableTransactionClient {
  constructor(private readonly connection: ConnectionLike) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    try {
      return await this.connection.query<T>(sql, params);
    } catch (error) {
      throw mapError("transaction", error, "Transaction query failed.");
    }
  }

  async queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    try {
      if (!this.connection.queryResult) {
        throw new Error("Underlying connection does not support queryResult.");
      }
      return await this.connection.queryResult<T>(sql, params);
    } catch (error) {
      throw mapError("transaction", error, "Transaction query failed.");
    }
  }

  async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    try {
      if (!this.connection.execute) {
        throw new Error("Underlying connection does not support execute.");
      }
      return await this.connection.execute(sql, params);
    } catch (error) {
      throw mapError("transaction", error, "Transaction statement failed.");
    }
  }

  commit(): Promise<void> {
    return this.connection.commit();
  }

  rollback(): Promise<void> {
    return this.connection.rollback();
  }
}
