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
  /**
   * Server backslash-escaping mode, negotiated once per physical connection via
   * `SELECT CHAR_LENGTH('\\')`. `null` until negotiated. `true` means the CUBRID
   * default `no_backslash_escapes=yes` (backslash is a literal char); `false`
   * means backslash-escape processing is active. See `negotiateBackslashEscapes`.
   */
  private noBackslashEscapes: boolean | null = null;

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
    this.noBackslashEscapes = null;

    try {
      // Send CON_CLOSE and tear down the socket as a single queued critical
      // section, so the close frame never interleaves with an in-flight query
      // (issue #39). The hook only runs while a live socket is present.
      await cas.close(async () => {
        const { header, payload } = writeConClose(cas.casInfo);
        await cas.send(header, payload);
      });
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

    const resolvedSql =
      params && params.length > 0
        ? interpolateParams(sql, params, await this.ensureBackslashMode(cas))
        : sql;

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
        ...this.resolveSslConfig(),
      };
      this.cas = new CASConnection(casConfig);
    }

    return this.cas;
  }

  /**
   * Translate the public `ssl` option (boolean | ClientSSLOptions) into the flat
   * TLS fields understood by CASConnectionConfig. Returns an empty object when
   * SSL is disabled so the non-SSL path is untouched.
   */
  private resolveSslConfig(): Partial<CASConnectionConfig> {
    const ssl = this.config.ssl;
    if (!ssl) {
      return {};
    }
    if (ssl === true) {
      return { ssl: true };
    }
    return {
      ssl: true,
      ...(ssl.rejectUnauthorized !== undefined && {
        rejectUnauthorized: ssl.rejectUnauthorized,
      }),
      ...(ssl.ca !== undefined && { ca: ssl.ca }),
      ...(ssl.servername !== undefined && { servername: ssl.servername }),
    };
  }


  /**
   * Return the negotiated backslash-escaping mode for the current connection,
   * running the one-time probe on first use.
   */
  private async ensureBackslashMode(cas: CASConnection): Promise<boolean> {
    if (this.noBackslashEscapes === null) {
      this.noBackslashEscapes = await this.negotiateBackslashEscapes(cas);
    }
    return this.noBackslashEscapes;
  }

  /**
   * Probe the live server to determine whether backslash-escape processing is
   * active, mirroring the CUBRID JDBC/pycubrid strategy.
   *
   * Sends `SELECT CHAR_LENGTH('\\')` (a literal two-backslash string):
   *   - result `2` -> backslash is a literal character
   *     (`no_backslash_escapes=yes`, the CUBRID default) -> returns `true`.
   *   - result `1` -> backslash-escape processing is on -> returns `false`.
   *
   * Any other result is treated as unknown and rejected rather than guessed,
   * because guessing wrong silently corrupts every string parameter.
   */
  private async negotiateBackslashEscapes(cas: CASConnection): Promise<boolean> {
    const { header, payload } = writePrepareAndExecute(
      "SELECT CHAR_LENGTH('\\\\')",
      this.autoCommit,
      cas.casInfo,
    );
    const responsePayload = await cas.sendAndRecv(header, payload);
    const result = parsePrepareAndExecute(responsePayload, cas.protoVersion);

    try {
      const firstRow = result.rows[0];
      const length = firstRow ? Number(Object.values(firstRow)[0]) : NaN;

      if (length === 2) {
        return true;
      }
      if (length === 1) {
        return false;
      }
      throw new Error(
        `Unable to determine CUBRID backslash-escaping mode: CHAR_LENGTH probe ` +
          `returned ${String(length)} (expected 1 or 2). Refusing to guess, as an ` +
          `incorrect mode silently corrupts string parameters.`,
      );
    } finally {
      await this.closeQueryHandle(cas, result.queryHandle);
    }
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
