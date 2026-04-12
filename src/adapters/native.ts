/**
 * Native CUBRID adapter — speaks the CAS protocol directly over TCP.
 *
 * Replaces NodeCubridAdapter by eliminating the node-cubrid dependency.
 * Implements the ConnectionLike interface used by CubridClient.
 */

import { CASConnection, type CASConnectionConfig } from "../protocol/connection.js";
import {
  writePrepareAndExecute,
  parsePrepareAndExecute,
  writeFetch,
  parseFetch,
  writeCloseReqHandle,
  parseSimpleResponse,
  writeEndTran,
  writeConClose,
  interpolateParams,
  type PrepareAndExecuteResult,
} from "../protocol/protocol.js";
import { EndTranType, StatementType } from "../protocol/constants.js";
import { mapError } from "../internals/map-error.js";
import type { DriverAdapter } from "./base.js";
import type { ClientConfig } from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResultRow } from "../types/result.js";

const DEFAULT_FETCH_SIZE = 100;

export class NativeCubridAdapter implements DriverAdapter {
  private cas: CASConnection | null = null;
  private autoCommit = true;

  constructor(private readonly config: ClientConfig) {}

  async connect(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      await cas.connect();
    } catch (error) {
      throw mapError("connection", error, "Failed to connect to CUBRID.");
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    try {
      return await this.executeQuery<T>(sql, params);
    } catch (error) {
      throw mapError("query", error, "Failed to execute CUBRID query.");
    }
  }

  async beginTransaction(): Promise<void> {
    try {
      const cas = this.getOrCreateCAS();

      if (!cas.isConnected) {
        await cas.connect();
      }

      this.autoCommit = false;
    } catch (error) {
      throw mapError("transaction", error, "Failed to start transaction.");
    }
  }

  async commit(): Promise<void> {
    try {
      const cas = this.getOrCreateCAS();

      if (!cas.isConnected) {
        throw new Error("Not connected");
      }

      const { header, payload } = writeEndTran(EndTranType.COMMIT, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      this.autoCommit = true;
    } catch (error) {
      throw mapError("transaction", error, "Failed to commit transaction.");
    }
  }

  async rollback(): Promise<void> {
    try {
      const cas = this.getOrCreateCAS();

      if (!cas.isConnected) {
        throw new Error("Not connected");
      }

      const { header, payload } = writeEndTran(EndTranType.ROLLBACK, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      this.autoCommit = true;
    } catch (error) {
      throw mapError("transaction", error, "Failed to roll back transaction.");
    }
  }

  async close(): Promise<void> {
    if (!this.cas) {
      return;
    }

    const cas = this.cas;
    this.cas = null;

    try {
      if (cas.isConnected) {
        try {
          const { header, payload } = writeConClose(cas.casInfo);
          await cas.send(header, payload);
        } catch {
          // Ignore — best effort
        }
      }

      await cas.close();
    } catch (error) {
      throw mapError("connection", error, "Failed to close CUBRID connection.");
    }
  }

  async ping(): Promise<string> {
    try {
      const cas = this.getOrCreateCAS();

      if (!cas.isConnected) {
        await cas.connect();
      }

      return await cas.ping();
    } catch (error) {
      throw mapError("connection", error, "Health check failed.");
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async executeQuery<T extends QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    const cas = this.getOrCreateCAS();

    if (!cas.isConnected) {
      await cas.connect();
    }

    const resolvedSql = params && params.length > 0 ? interpolateParams(sql, params) : sql;

    const { header, payload } = writePrepareAndExecute(
      resolvedSql,
      this.autoCommit,
      cas.casInfo,
    );
    const responsePayload = await cas.sendAndRecv(header, payload);

    const result: PrepareAndExecuteResult = parsePrepareAndExecute(
      responsePayload,
      cas.protoVersion,
    );

    if (result.statementType !== StatementType.SELECT) {
      await this.closeQueryHandle(cas, result.queryHandle);
      return [] as unknown as T[];
    }

    const allRows = [...result.rows];

    if (result.totalTupleCount > allRows.length) {
      await this.fetchRemaining(cas, result, allRows);
    }

    await this.closeQueryHandle(cas, result.queryHandle);

    return allRows as T[];
  }

  private getOrCreateCAS(): CASConnection {
    if (!this.cas) {
      const casConfig: CASConnectionConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ...(this.config.connectionTimeout !== undefined && {
          connectionTimeout: this.config.connectionTimeout,
        }),
      };
      this.cas = new CASConnection(casConfig);
    }

    return this.cas;
  }

  private async fetchRemaining(
    cas: CASConnection,
    result: PrepareAndExecuteResult,
    allRows: Record<string, unknown>[],
  ): Promise<void> {
    let fetched = allRows.length;

    while (fetched < result.totalTupleCount) {
      const { header, payload } = writeFetch(
        result.queryHandle,
        fetched,
        DEFAULT_FETCH_SIZE,
        cas.casInfo,
      );
      const fetchPayload = await cas.sendAndRecv(header, payload);
      const fetchResult = parseFetch(fetchPayload, result.columns);

      if (fetchResult.tupleCount === 0) {
        break;
      }

      allRows.push(...fetchResult.rows);
      fetched += fetchResult.tupleCount;
    }
  }

  private async closeQueryHandle(cas: CASConnection, queryHandle: number): Promise<void> {
    try {
      const { header, payload } = writeCloseReqHandle(queryHandle, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}
