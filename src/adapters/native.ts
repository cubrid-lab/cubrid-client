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
  readQueryHandle,
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

  /**
   * Session that holds the open transaction's statements. Set by the first
   * statement rather than by beginTransaction(): a released CAS legitimately
   * reconnects on that first statement, before there is any work to lose.
   */
  private transactionGeneration: number | null = null;

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
      // If the first transactional statement lost its session before the
      // post-response bind, remember that failed generation. A ping/reconnect
      // must never make subsequent statements commit on a replacement CAS.
      this.bindSessionLostByFirstStatement();
      throw mapError("query", error, "Failed to execute CUBRID query.");
    }
  }

  async beginTransaction(): Promise<void> {
    try {
      const cas = this.getOrCreateCAS();

      // Starting over here would hide that acknowledged statements are gone.
      // rollback() acknowledges the loss and clears this state.
      if (this.transactionGeneration !== null) {
        this.assertTransactionSession(cas);
      }

      if (!cas.isConnected) {
        await cas.connect();
      }

      this.autoCommit = false;
    } catch (error) {
      throw mapError("transaction", error, "Failed to start transaction.");
    }
  }

  async commit(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      if (!cas.isConnected) {
        throw new Error("Not connected");
      }

      this.assertTransactionSession(cas);

      const { header, payload } = writeEndTran(EndTranType.COMMIT, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      // A transparent reconnect inside sendAndRecv() would have committed an
      // empty session, so this success must still be checked.
      this.assertTransactionSession(cas);
      this.endTransaction();
    } catch (error) {
      this.endTransactionIfSessionLost(cas);
      throw mapError("transaction", error, "Failed to commit transaction.");
    }
  }

  async rollback(): Promise<void> {
    const cas = this.getOrCreateCAS();

    try {
      if (!cas.isConnected) {
        throw new Error("Not connected");
      }

      const { header, payload } = writeEndTran(EndTranType.ROLLBACK, cas.casInfo);
      const responsePayload = await cas.sendAndRecv(header, payload);
      parseSimpleResponse(responsePayload);

      this.endTransaction();
    } catch (error) {
      this.endTransactionIfSessionLost(cas);
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
    this.endTransaction();

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

    // Reconnecting here would drop the earlier statements of this transaction
    // and let a later commit() persist only the ones that follow.
    this.assertTransactionSession(cas);

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

    return this.withQueryHandle(cas, responsePayload, async () => {
      await this.bindTransactionSession(cas);

      const result: PrepareAndExecuteResult = parsePrepareAndExecute(
        responsePayload,
        cas.protoVersion,
      );

      if (result.statementType !== StatementType.SELECT) {
        return [] as unknown as T[];
      }

      const allRows = [...result.rows];

      if (result.totalTupleCount > allRows.length) {
        await this.fetchRemaining(cas, result, allRows);
      }

      return allRows as T[];
    });
  }

  /**
   * Run `use`, then release the query handle held by `response` however `use`
   * ended. The handle is read first because decoding the response can fail
   * after the server has already allocated it.
   */
  private async withQueryHandle<R>(
    cas: CASConnection,
    response: Buffer,
    use: () => Promise<R>,
  ): Promise<R> {
    const queryHandle = readQueryHandle(response);
    const generation = cas.connectionGeneration;

    try {
      return await use();
    } finally {
      if (queryHandle !== null) {
        await this.closeQueryHandle(cas, queryHandle, generation);
      }
    }
  }

  /** True when an open transaction's session no longer exists. */
  private isTransactionSessionLost(cas: CASConnection): boolean {
    if (this.autoCommit) {
      return false;
    }

    return (
      !cas.isConnected ||
      (this.transactionGeneration !== null &&
        cas.connectionGeneration !== this.transactionGeneration)
    );
  }

  private assertTransactionSession(cas: CASConnection): void {
    if (this.isTransactionSessionLost(cas)) {
      throw new Error("Connection lost during transaction");
    }
  }

  /**
   * Called after a statement ran. If the session changed underneath it, that
   * statement is open on the new session, so drop the session rather than
   * let a later autocommit query persist work reported here as failed.
   */
  private async bindTransactionSession(cas: CASConnection): Promise<void> {
    if (!this.autoCommit && this.transactionGeneration === null) {
      this.transactionGeneration = cas.connectionGeneration;
    }

    if (this.isTransactionSessionLost(cas)) {
      await cas.discardSession();
      throw new Error("Connection lost during transaction");
    }
  }

  /** Retain a failed first statement's session so reconnection cannot hide it. */
  private bindSessionLostByFirstStatement(): void {
    if (
      !this.autoCommit &&
      this.transactionGeneration === null &&
      this.cas &&
      !this.cas.isConnected
    ) {
      this.transactionGeneration = this.cas.connectionGeneration;
    }
  }

  private endTransaction(): void {
    this.autoCommit = true;
    this.transactionGeneration = null;
  }

  /** The server discarded the work, so there is nothing left to end. */
  private endTransactionIfSessionLost(cas: CASConnection): void {
    if (this.isTransactionSessionLost(cas)) {
      this.endTransaction();
    }
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

    return this.withQueryHandle(cas, responsePayload, async () => {
      const result = parsePrepareAndExecute(responsePayload, cas.protoVersion);
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
    });
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

      // Returning a partial result as success silently corrupts the query
      // contract. The execute response still promises more rows here.
      if (fetchResult.tupleCount <= 0) {
        throw new Error(
          `CUBRID FETCH returned no rows before the expected ${result.totalTupleCount} rows`,
        );
      }
      if (
        fetchResult.rows.length !== fetchResult.tupleCount ||
        fetched + fetchResult.tupleCount > result.totalTupleCount
      ) {
        throw new Error("CUBRID FETCH returned an inconsistent row count");
      }

      allRows.push(...fetchResult.rows);
      fetched += fetchResult.tupleCount;
    }
  }

  /**
   * Best-effort release on the session that created the handle, so a cleanup
   * failure cannot replace the caller's own error. If that session is gone the
   * server has dropped the handle with it and nothing is sent.
   */
  private async closeQueryHandle(
    cas: CASConnection,
    queryHandle: number,
    generation: number,
  ): Promise<void> {
    try {
      const { header, payload } = writeCloseReqHandle(queryHandle, cas.casInfo);
      const responsePayload = await cas.sendAndRecvOnSession(generation, header, payload);

      if (responsePayload) {
        parseSimpleResponse(responsePayload);
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }
}
