import { TransactionError } from "../errors/transaction-error.js";
import {
  isAbortReason,
  mapError,
  toError,
  withTransactionOutcome,
} from "../internals/map-error.js";
import {
  assertValidQueryOptions,
  checkedResult,
  checkedRows,
} from "../internals/normalize-config.js";
import { unknownOutcomeProbe } from "../internals/session-state.js";
import type {
  ArrayRowOptions,
  ArrayRowQueryable,
  BatchTransactionClient,
  ConnectionLike,
  ExecutableTransactionClient,
  ExecuteManyResult,
  ExecuteOptions,
  ExecuteResult,
  PreparedTransactionClient,
  QueryOptions,
  ResultTransactionClient,
} from "../types/client.js";
import { LobParamError, type PreparedQueryParam, refuseLobParams } from "../types/lob.js";
import type { QueryParams } from "../types/query.js";
import type { ArrayQueryResult, QueryResult, QueryResultRow } from "../types/result.js";
import type { ConnectionSource, ConnectionVerdict } from "./connection-source.js";

export class CubridTransaction
  implements
    ArrayRowQueryable,
    ResultTransactionClient,
    ExecutableTransactionClient,
    PreparedTransactionClient,
    BatchTransactionClient
{
  constructor(private readonly connection: ConnectionLike) {}

  query<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]>;
  query(sql: string, params?: QueryParams, options?: QueryOptions): Promise<unknown[]> {
    return runStatement(options, "Transaction query failed.", async () => {
      refuseLobParams(params);
      return checkedRows(options, await this.connection.query(sql, params, options));
    });
  }

  queryResult<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryResult(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return runStatement(options, "Transaction query failed.", async () => {
      refuseLobParams(params);
      if (!this.connection.queryResult) {
        throw new Error("Underlying connection does not support queryResult.");
      }
      return checkedResult(options, await this.connection.queryResult(sql, params, options));
    });
  }

  execute(sql: string, params?: QueryParams, options?: ExecuteOptions): Promise<ExecuteResult> {
    return runStatement(options, "Transaction statement failed.", () => {
      refuseLobParams(params);
      if (!this.connection.execute) {
        throw new Error("Underlying connection does not support execute.");
      }
      return this.connection.execute(sql, params, options);
    });
  }

  queryPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]>;
  queryPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<unknown[]> {
    return runStatement(options, "Transaction query failed.", async () => {
      if (!this.connection.queryPrepared) {
        throw new Error("Underlying connection does not support queryPrepared.");
      }
      return checkedRows(options, await this.connection.queryPrepared(sql, params, options));
    });
  }

  queryResultPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryResultPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return runStatement(options, "Transaction query failed.", async () => {
      if (!this.connection.queryResultPrepared) {
        throw new Error("Underlying connection does not support queryResultPrepared.");
      }
      return checkedResult(
        options,
        await this.connection.queryResultPrepared(sql, params, options),
      );
    });
  }

  executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return runStatement(options, "Transaction statement failed.", () => {
      if (!this.connection.executePrepared) {
        throw new Error("Underlying connection does not support executePrepared.");
      }
      return this.connection.executePrepared(sql, params, options);
    });
  }

  /**
   * `executeMany()` inside this transaction. A failed set rejects with every
   * set's outcome in `batch` and leaves the transaction as it is: the sets that
   * succeeded are still part of it, and the caller decides to roll back or not.
   */
  executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: QueryOptions,
  ): Promise<ExecuteManyResult> {
    return runStatement(options, "Transaction statement failed.", () => {
      if (!this.connection.executeMany) {
        throw new Error("Underlying connection does not support executeMany.");
      }
      return this.connection.executeMany(sql, paramSets, options);
    });
  }

  commit(): Promise<void> {
    return this.connection.commit();
  }

  rollback(): Promise<void> {
    return this.connection.rollback();
  }
}

/**
 * Runs one statement of a transaction. Invalid options and a signal already
 * aborted reject before the connection is used, and the reason of the caller's
 * own abort is passed on unchanged. A function, not a method, so subclasses of
 * the public `CubridTransaction` cannot collide with it.
 */
async function runStatement<R>(
  options: QueryOptions | undefined,
  failureMessage: string,
  run: () => Promise<R>,
): Promise<R> {
  assertValidQueryOptions(options);
  options?.signal?.throwIfAborted();

  try {
    return await run();
  } catch (error) {
    // A misused blob() or clob() is the caller's TypeError, as on the client.
    if (isAbortReason(error, options?.signal) || error instanceof LobParamError) {
      throw error;
    }
    throw mapError("transaction", error, failureMessage);
  }
}

type CallbackTransactionState =
  | "open"
  | "completing"
  | "committed"
  | "rolledBack"
  | "failed"
  | "discarded";

const COMPLETED_MESSAGES: Record<Exclude<CallbackTransactionState, "open">, string> = {
  completing: "Transaction is already completing.",
  committed: "Transaction has already been committed.",
  rolledBack: "Transaction has already been rolled back.",
  failed: "Transaction has already failed.",
  discarded: "Transaction was discarded because the client was closed.",
};

/**
 * The promise a statement of a `CallbackTransaction` returns. Attaching a
 * rejection handler to it, directly or further down a chain of `then(onFulfilled)`
 * calls, marks the statement observed (ADR 0009). `await`, `.catch()`,
 * `.finally()`, `.then(f, g)`, `Promise.all()`, `Promise.allSettled()` and
 * returning it from an async function all call `then()` with a rejection
 * handler: a native `await` assimilates it through `then()` because its
 * constructor is not `Promise`.
 *
 * What counts is whether a handler was attached, not when the statement settles.
 */
class StatementPromise<T> extends Promise<T> {
  /** Marks the statement observed; derived promises without a rejection handler share it. */
  observe: () => void = () => undefined;

  // biome-ignore lint/suspicious/noThenProperty: overriding Promise.prototype.then is the point
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    // biome-ignore lint/suspicious/noExplicitAny: the signature of Promise.prototype.then
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (typeof onrejected === "function") {
      this.observe();
    }

    const derived = super.then(onfulfilled, onrejected);

    // A rejection passes through to the derived promise, so a handler attached
    // there observes this statement's failure too.
    if (typeof onrejected !== "function" && derived instanceof StatementPromise) {
      derived.observe = this.observe;
    }
    return derived;
  }
}

/** One statement issued through a `CallbackTransaction`, kept until the outcome is decided. */
interface StatementRecord {
  /** Resolves once the statement settled. Never rejects. */
  readonly settled: Promise<void>;
  failed: boolean;
  reason: unknown;
  observed: boolean;
}

/**
 * Marks a promise handled without observing it, so Node.js does not report it.
 * The base `then()` bypasses the override; the promise it derives is a
 * `StatementPromise` whose `observe` does nothing.
 */
function markHandled(promise: Promise<unknown>): void {
  Promise.prototype.then.call(promise, undefined, () => {
    // Reported by the transaction instead.
  });
}

/**
 * The `tx` handed to a `CubridClient.transaction()` callback. It allows exactly
 * one terminal outcome, whether the callback asks for it through `commit()` or
 * `rollback()` or the client decides when the callback settles. Everything
 * after that outcome rejects without reaching the connection: the adapter is
 * back in autocommit by then, so a late statement would persist on its own.
 *
 * A statement that failed stops the commit only if nothing observed its promise
 * (ADR 0009): `void tx.query()` and a promise left untouched. Whether a handler
 * was attached is a property of the code, not of when the failure arrived.
 *
 * `CubridTransaction` stays an unguarded forwarder because its constructor is
 * public 1.x API and a caller may reuse one across several transactions.
 */
export class CallbackTransaction extends CubridTransaction {
  protected state: CallbackTransactionState = "open";
  private completion: Promise<void> | undefined;
  /**
   * Statements in the order they were issued, so the failure reported is the same
   * whichever settled first. A statement leaves once it settled and either
   * succeeded or was observed, since it can no longer stop the commit.
   */
  private readonly statements = new Set<StatementRecord>();
  /** The callback returned without completing, so the client commits on its behalf. */
  private committingForCallback = false;
  /** Set once every statement settled and the outcome is decided. */
  private decided = false;

  /** Why the rollback failed, once one was attempted and rejected. */
  rollbackFailure: Error | undefined;

  /**
   * Whether the transaction that failed to end has an unknown outcome, reported
   * again by a commit() or rollback() refused afterwards (#254). Undefined when
   * the connection could not tell.
   */
  protected endOutcome: boolean | undefined = false;

  override query<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  override query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]>;
  override query(sql: string, params?: QueryParams, options?: QueryOptions): Promise<unknown[]> {
    return this.track(() => super.query(sql, params, options));
  }

  override queryResult<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: QueryParams | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  override queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  override queryResult(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return this.track(() => super.queryResult(sql, params, options));
  }

  override execute(
    sql: string,
    params?: QueryParams,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return this.track(() => super.execute(sql, params, options));
  }

  override queryPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<T[]>;
  override queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<T[]>;
  override queryPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<unknown[]> {
    return this.track(() => super.queryPrepared(sql, params, options));
  }

  override queryResultPrepared<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly PreparedQueryParam[] | undefined,
    options: ArrayRowOptions,
  ): Promise<ArrayQueryResult<T>>;
  override queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  override queryResultPrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: QueryOptions,
  ): Promise<QueryResult | ArrayQueryResult> {
    return this.track(() => super.queryResultPrepared(sql, params, options));
  }

  override executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return this.track(() => super.executePrepared(sql, params, options));
  }

  override executeMany(
    sql: string,
    paramSets: readonly QueryParams[],
    options?: QueryOptions,
  ): Promise<ExecuteManyResult> {
    return this.track(() => super.executeMany(sql, paramSets, options));
  }

  override commit(): Promise<void> {
    return this.complete("commit");
  }

  override rollback(): Promise<void> {
    return this.complete("rollback");
  }

  /**
   * The callback resolved: commit unless it already completed the transaction.
   * Rejects when its own completion failed, even if it swallowed that failure,
   * because returning normally must not report work that was not committed.
   */
  async finish(): Promise<void> {
    if (!this.completion) {
      this.committingForCallback = true;
    }
    await (this.completion ?? this.commit());
  }

  /**
   * The transaction failed: roll back unless a completion already ran. Never
   * rejects, so the caller keeps its original failure; see `rollbackFailure`.
   */
  async abort(): Promise<void> {
    await (this.completion ?? this.rollback()).catch(() => {
      // Recorded in rollbackFailure when it matters; the original error wins.
    });
  }

  /** Runs one statement of this transaction, unless the transaction is over. */
  private track<R>(statement: () => Promise<R>): Promise<R> {
    if (this.state !== "open") {
      const refused = new TransactionError(COMPLETED_MESSAGES[this.state], {
        outcomeUnknown: false,
      });

      // Work the callback left running is still issuing statements while the client
      // commits for it. This one is never sent, so committing would persist the
      // rest of the work without it. An explicit commit() keeps the 1.x rule: the
      // late statement is refused and the commit stands.
      if (this.committingForCallback && this.state === "completing" && !this.decided) {
        this.statements.add({
          settled: Promise.resolve(),
          failed: true,
          reason: refused,
          observed: false,
        });
      }
      return Promise.reject(refused);
    }

    const pending = statement();
    // Settled from the internal promise before the record below is, so a handler
    // the caller attached directly to `result` runs before the outcome is decided.
    const result = new StatementPromise<R>((resolve, reject) => {
      pending.then(resolve, reject);
    });
    const record: StatementRecord = {
      // Attached to the internal promise, never to the one the caller holds.
      settled: pending.then(
        () => {
          this.statements.delete(record);
        },
        (error: unknown) => {
          record.failed = true;
          record.reason = error;
          if (record.observed) {
            this.statements.delete(record);
          }
        },
      ),
      failed: false,
      reason: undefined,
      observed: false,
    };
    result.observe = () => {
      record.observed = true;
      if (record.failed) {
        this.statements.delete(record);
      }
    };
    // A failure nobody observed is reported by the commit it refuses, or is
    // irrelevant to a rollback, so Node.js should not report it as well.
    markHandled(result);

    this.statements.add(record);
    return result;
  }

  private complete(outcome: "commit" | "rollback"): Promise<void> {
    if (this.state !== "open") {
      // Nothing is sent, but the transaction's own outcome is what a caller asks about.
      const ended = this.state === "failed" || this.state === "discarded";
      const outcomeUnknown = ended ? this.endOutcome : false;
      return Promise.reject(
        new TransactionError(COMPLETED_MESSAGES[this.state], {
          ...(outcomeUnknown !== undefined && { outcomeUnknown }),
        }),
      );
    }

    this.state = "completing";
    this.completion = outcome === "commit" ? this.runCommit() : this.runRollback();
    // A callback may not await this. finish() and abort() still see the rejection,
    // but without a handler now it would be reported as unhandled before they run.
    this.completion.catch(() => {
      // The failure is delivered through this.completion.
    });
    return this.completion;
  }

  /**
   * A query the callback did not await may not have sent its statement yet: the
   * first bound query on a connection waits for the backslash-mode probe. END_TRAN
   * must follow it, or the statement lands outside the transaction it was issued in.
   * Nothing new can be issued meanwhile: the state is no longer "open".
   */
  private async settleStatements(): Promise<void> {
    await Promise.all([...this.statements].map((record) => record.settled));
    this.decided = true;
  }

  private async runCommit(): Promise<void> {
    try {
      await this.settleStatements();

      // Nobody observed this failure, so nobody decided it was acceptable, and
      // committing would persist the rest of the work without it. In issue order,
      // so the cause does not depend on which statement settled first.
      for (const record of this.statements) {
        if (record.failed && !record.observed) {
          throw record.reason;
        }
      }

      await super.commit();
      this.state = "committed";
    } catch (error) {
      this.state = "failed";

      // A commit that was skipped or refused leaves the transaction open and holding locks.
      try {
        await super.rollback();
      } catch (rollbackError) {
        this.rollbackFailure = toError(rollbackError);
      }

      this.endOutcome = combinedOutcome(error, this.rollbackFailure);
      throw error;
    }
  }

  private async runRollback(): Promise<void> {
    await this.settleStatements();

    try {
      await super.rollback();
      this.state = "rolledBack";
    } catch (error) {
      this.state = "failed";
      this.rollbackFailure = toError(error);
      this.endOutcome = combinedOutcome(error);
      throw error;
    }
  }
}

/**
 * The handle `beginTransactionScope()` returns (#112). It owns a dedicated
 * connection, so statements sent on the client meanwhile cannot join its
 * transaction. It keeps the guarantees of the `transaction()` callback's `tx`:
 * one terminal outcome, a commit refused (and rolled back) while a statement
 * failed that nothing observed, and a rollback after a failed commit. Whichever way it ends, its
 * connection goes back to `source` (closed by a client, released or destroyed
 * by a pool) and its owner stops tracking it.
 */
export class ScopedTransaction extends CallbackTransaction {
  private ending: Promise<void> | undefined;
  /** Whether a request of this transaction has an unknown outcome; see #254. */
  private readonly outcomeUnknown: () => boolean | undefined;

  constructor(
    private readonly ownConnection: ConnectionLike,
    private readonly source: ConnectionSource,
    private readonly onEnded: () => void,
  ) {
    super(ownConnection);
    this.outcomeUnknown = unknownOutcomeProbe(ownConnection);
  }

  override commit(): Promise<void> {
    return this.end(() => super.commit(), "Failed to commit.", true);
  }

  override rollback(): Promise<void> {
    return this.end(() => super.rollback(), "Failed to rollback.", false);
  }

  /**
   * For `close()` of the client or pool: ends a transaction nobody ended by closing its
   * connection, and the server discards the uncommitted work with it. It does not
   * wait for statements still running first, unlike rollback(): one may be waiting
   * for a lock that only another connection being closed would release. A
   * statement already sent then fails with a connection error. Never rejects.
   */
  async discard(): Promise<void> {
    if (!this.ending) {
      this.state = "discarded";
      this.endOutcome = this.outcomeUnknown();
      this.ending = this.endOwnConnection("in-transaction");
    }

    await this.ending.catch(() => {
      // Nothing to report: close() is not about this transaction's outcome.
    });
  }

  private end(run: () => Promise<void>, message: string, committing: boolean): Promise<void> {
    if (this.ending) {
      // Rejects with "already completing" or the settled outcome's message.
      return run();
    }

    this.ending = this.runToEnd(run, message, committing);
    return this.ending;
  }

  private async runToEnd(
    run: () => Promise<void>,
    message: string,
    committing: boolean,
  ): Promise<void> {
    let failure: Error | undefined;

    try {
      await run();
    } catch (error) {
      failure = mapError("transaction", error, message);
      if (failure instanceof TransactionError) {
        // A failed explicit rollback is already the cause.
        if (committing && this.rollbackFailure) {
          failure.rollbackError = this.rollbackFailure;
        }
        withTransactionOutcome(failure, this.outcomeUnknown(), this.rollbackFailure);
        this.endOutcome = failure.outcomeUnknown;
      }
    }

    try {
      await this.endOwnConnection(this.rollbackFailure ? "in-transaction" : "reuse");
    } catch (closeError) {
      // The outcome is decided by now: a committed transaction stays committed,
      // and an uncommitted one is discarded by the server with the connection.
      if (failure instanceof TransactionError) {
        failure.closeError = toError(closeError);
      }
    }

    if (failure) {
      throw failure;
    }
  }

  private async endOwnConnection(verdict: ConnectionVerdict): Promise<void> {
    try {
      await this.source.end(this.ownConnection, verdict);
    } finally {
      this.onEnded();
    }
  }
}

/**
 * True if any of `errors` has an unknown outcome, false if every one says its
 * outcome is known, and undefined otherwise. An absent error counts as known.
 */
function combinedOutcome(...errors: unknown[]): boolean | undefined {
  let known = true;
  for (const error of errors) {
    if (error === undefined) {
      continue;
    }
    const outcome = (error as { outcomeUnknown?: unknown } | null)?.outcomeUnknown;
    if (outcome === true) {
      return true;
    }
    if (outcome !== false) {
      known = false;
    }
  }
  return known ? false : undefined;
}
