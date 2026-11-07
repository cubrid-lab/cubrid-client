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
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResultRow } from "../types/result.js";

/**
 * Resolves the `logger` option. Each level is looked up when the event is
 * emitted, so a logger that implements only some levels is honored and a
 * non-conforming value is ignored. A throwing logger never affects a request.
 */
function createEmit(logger: unknown) {
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

function errorName(error: unknown): string {
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
      query: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: QueryParams) =>
        timed(
          "query",
          { paramCount: params?.length ?? 0 },
          () => inner.query<T>(sql, params),
          (rows) => rows.length,
        ),
      beginTransaction: () => timed("beginTransaction", {}, () => inner.beginTransaction()),
      commit: () => timed("commit", {}, () => inner.commit()),
      rollback: () => timed("rollback", {}, () => inner.rollback()),
      close: () => timed("close", {}, () => inner.close()),
    };
    const ping = inner.ping?.bind(inner);
    if (ping) {
      wrapped.ping = () => timed("ping", {}, ping);
    }
    return wrapped;
  };
}
