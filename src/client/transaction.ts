import { mapError } from "../internals/map-error.js";
import type { ConnectionLike, ResultTransactionClient } from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridTransaction implements ResultTransactionClient {
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

  commit(): Promise<void> {
    return this.connection.commit();
  }

  rollback(): Promise<void> {
    return this.connection.rollback();
  }
}
