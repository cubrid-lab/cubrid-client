import { ConnectionError } from "../errors/connection-error.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../errors/query-error.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { TransactionError } from "../errors/transaction-error.js";
import type {
  ClientLogFields,
  ClientLogLevel,
  ConnectionFactory,
  ConnectionLike,
  ExecuteManyResult,
  ExecuteResult,
  QueryOptions,
  StreamOptions,
} from "../types/client.js";
import type { PreparedQueryParam } from "../types/lob.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";
import { SESSION_STATE, sessionStateReader } from "./session-state.js";

/** Values of all the sets of an `executeMany()`, without failing on a malformed argument. */
function countValues(paramSets: readonly QueryParams[]): number {
  if (!Array.isArray(paramSets)) {
    return 0;
  }
  return paramSets.reduce(
    (total: number, set: unknown) => total + (Array.isArray(set) ? set.length : 0),
    0,
  );
}

/**
 * Resolves the `logger` option. Each level is looked up when the event is
 * emitted, so a logger that implements only some levels is honored and a
 * non-conforming value is ignored. A throwing logger never affects a request.
 */
export function createEmit(logger: unknown) {
  return (level: ClientLogLevel, message: string, fields: ClientLogFields): void => {
    if (typeof logger !== "object" || logger === null) {
      return;
    }

    try {
      const method = (logger as Record<string, unknown>)[level];
      if (typeof method === "function") {
        const result: unknown = method.call(logger, message, fields);
        // An async logger must not leave an unhandled rejection behind, and
        // logging never waits for it.
        if (typeof result === "object" && result !== null && "then" in result) {
          (result as PromiseLike<unknown>).then(undefined, () => undefined);
        }
      }
    } catch {
      // Diagnostics must not break queries.
    }
  };
}

/**
 * Classifies an error by class, never by its mutable `name`, which a custom
 * connection could set to a bound value. Unknown classes report `Error`. The
 * first match wins, so a subclass must come before the class it extends.
 */
const ERROR_NAMES: ReadonlyArray<readonly [abstract new (...args: never[]) => Error, string]> = [
  [ReadTimeoutError, "ReadTimeoutError"],
  [ConnectionError, "ConnectionError"],
  [ConstraintError, "ConstraintError"],
  [SqlSyntaxError, "SqlSyntaxError"],
  [DeadlockError, "DeadlockError"],
  [LockTimeoutError, "LockTimeoutError"],
  [QueryError, "QueryError"],
  [TransactionError, "TransactionError"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [EvalError, "EvalError"],
  [URIError, "URIError"],
];

export function errorName(error: unknown): string {
  return ERROR_NAMES.find(([type]) => error instanceof type)?.[1] ?? "Error";
}

/**
 * Wraps a connection factory so every connection reports redacted diagnostics
 * to `logger`. Fields never include SQL text, parameters, row data or
 * credentials, and error messages are omitted because servers can echo SQL.
 */
export function withLogging(factory: ConnectionFactory, logger: unknown): ConnectionFactory {
  const emit = createEmit(logger);

  const timed = async <R>(
    operation: string,
    fields: ClientLogFields,
    run: () => Promise<R>,
    rows?: (result: R) => number,
  ): Promise<R> => {
    const start = performance.now();
    try {
      const result = await run();
      const durationMs = Math.round(performance.now() - start);
      emit("debug", `cubrid-client: ${operation} succeeded`, {
        operation,
        ...fields,
        durationMs,
        ...(rows && { rowCount: rows(result) }),
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      emit("error", `cubrid-client: ${operation} failed`, {
        operation,
        ...fields,
        durationMs,
        errorName: errorName(error),
      });
      throw error;
    }
  };

  return async (config) => {
    const start = performance.now();
    let inner: ConnectionLike;
    try {
      inner = await factory(config);
    } catch (error) {
      emit("error", "cubrid-client: connection failed", {
        operation: "connection",
        host: config.host,
        port: config.port,
        database: config.database,
        durationMs: Math.round(performance.now() - start),
        errorName: errorName(error),
      });
      throw error;
    }
    emit("info", "cubrid-client: connection created", {
      operation: "connection",
      host: config.host,
      port: config.port,
      database: config.database,
    });

    const wrapped: ConnectionLike = {
      connect: () => timed("connect", {}, () => inner.connect()),
      query: <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: QueryParams,
        options?: QueryOptions,
      ) =>
        timed(
          "query",
          { paramCount: params?.length ?? 0 },
          () => inner.query<T>(sql, params, options),
          (rows) => rows.length,
        ),
      beginTransaction: () => timed("beginTransaction", {}, () => inner.beginTransaction()),
      commit: () => timed("commit", {}, () => inner.commit()),
      rollback: () => timed("rollback", {}, () => inner.rollback()),
      close: () => timed("close", {}, () => inner.close()),
    };
    const queryResult = inner.queryResult?.bind(inner);
    if (queryResult) {
      wrapped.queryResult = <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: QueryParams,
        options?: QueryOptions,
      ): Promise<QueryResult<T>> =>
        timed(
          "queryResult",
          { paramCount: params?.length ?? 0 },
          () => queryResult<T>(sql, params, options),
          (result) => result.rows.length,
        );
    }
    const execute = inner.execute?.bind(inner);
    if (execute) {
      wrapped.execute = (
        sql: string,
        params?: QueryParams,
        options?: QueryOptions,
      ): Promise<ExecuteResult> =>
        timed("execute", { paramCount: params?.length ?? 0 }, () => execute(sql, params, options));
    }
    const queryPrepared = inner.queryPrepared?.bind(inner);
    if (queryPrepared) {
      wrapped.queryPrepared = <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: readonly PreparedQueryParam[],
        options?: QueryOptions,
      ): Promise<T[]> =>
        timed(
          "queryPrepared",
          { paramCount: params?.length ?? 0 },
          () => queryPrepared<T>(sql, params, options),
          (rows) => rows.length,
        );
    }
    const queryResultPrepared = inner.queryResultPrepared?.bind(inner);
    if (queryResultPrepared) {
      wrapped.queryResultPrepared = <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: readonly PreparedQueryParam[],
        options?: QueryOptions,
      ): Promise<QueryResult<T>> =>
        timed(
          "queryResultPrepared",
          { paramCount: params?.length ?? 0 },
          () => queryResultPrepared<T>(sql, params, options),
          (result) => result.rows.length,
        );
    }
    const executePrepared = inner.executePrepared?.bind(inner);
    if (executePrepared) {
      wrapped.executePrepared = (
        sql: string,
        params?: readonly PreparedQueryParam[],
        options?: QueryOptions,
      ): Promise<ExecuteResult> =>
        timed("executePrepared", { paramCount: params?.length ?? 0 }, () =>
          executePrepared(sql, params, options),
        );
    }
    const executeMany = inner.executeMany?.bind(inner);
    if (executeMany) {
      wrapped.executeMany = (
        sql: string,
        paramSets: readonly QueryParams[],
        options?: QueryOptions,
      ): Promise<ExecuteManyResult> =>
        timed("executeMany", { paramCount: countValues(paramSets) }, () =>
          executeMany(sql, paramSets, options),
        );
    }
    const setTransactionOptions = inner.setTransactionOptions?.bind(inner);
    if (setTransactionOptions) {
      wrapped.setTransactionOptions = (options) =>
        timed("setTransactionOptions", {}, () => setTransactionOptions(options));
    }
    const stream = inner.stream?.bind(inner);
    if (stream) {
      wrapped.stream = <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: QueryParams,
        options?: StreamOptions,
      ): AsyncIterable<T> => {
        const rows = stream<T>(sql, params, options);
        return (async function* (): AsyncGenerator<T, void, undefined> {
          const fields = { operation: "stream", paramCount: params?.length ?? 0 };
          const start = performance.now();
          let rowCount = 0;
          let failure: { errorName: string } | undefined;

          try {
            for await (const row of rows) {
              rowCount += 1;
              yield row;
            }
          } catch (error) {
            failure = { errorName: errorName(error) };
            throw error;
          } finally {
            // An early break reaches only this block, and it is a success too.
            const durationMs = Math.round(performance.now() - start);
            if (failure) {
              emit("error", "cubrid-client: stream failed", { ...fields, durationMs, ...failure });
            } else {
              emit("debug", "cubrid-client: stream succeeded", { ...fields, durationMs, rowCount });
            }
          }
        })();
      };
    }
    const ping = inner.ping?.bind(inner);
    if (ping) {
      wrapped.ping = () => timed("ping", {}, ping);
    }
    // Only when the inner connection has one: its absence tells callers to fall back.
    const destroy = inner.destroy?.bind(inner);
    if (destroy) {
      wrapped.destroy = () => {
        emit("info", "cubrid-client: connection destroyed", { operation: "destroy" });
        destroy();
      };
    }
    // The pool reads the session's state through the wrapper.
    const readState = sessionStateReader(inner);
    if (readState) {
      Object.defineProperty(wrapped, SESSION_STATE, { value: readState });
    }
    return wrapped;
  };
}
