import { TransactionError } from "../errors/transaction-error.js";
import { isAbortReason, mapError, toError } from "../internals/map-error.js";
import { assertValidQueryOptions } from "../internals/normalize-config.js";
import type {
  ConnectionLike,
  ExecutableTransactionClient,
  ExecuteResult,
  PreparedTransactionClient,
  QueryOptions,
  ResultTransactionClient,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridTransaction
  implements ResultTransactionClient, ExecutableTransactionClient, PreparedTransactionClient
{
  constructor(private readonly connection: ConnectionLike) {}

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return runStatement(options, "Transaction query failed.", () =>
      this.connection.query<T>(sql, params, options),
    );
  }

  queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return runStatement(options, "Transaction query failed.", () => {
      if (!this.connection.queryResult) {
        throw new Error("Underlying connection does not support queryResult.");
      }
      return this.connection.queryResult<T>(sql, params, options);
    });
  }

  execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult> {
    return runStatement(options, "Transaction statement failed.", () => {
      if (!this.connection.execute) {
        throw new Error("Underlying connection does not support execute.");
      }
      return this.connection.execute(sql, params, options);
    });
  }

  queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return runStatement(options, "Transaction query failed.", () => {
      if (!this.connection.queryPrepared) {
        throw new Error("Underlying connection does not support queryPrepared.");
      }
      return this.connection.queryPrepared<T>(sql, params, options);
    });
  }

  queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return runStatement(options, "Transaction query failed.", () => {
      if (!this.connection.queryResultPrepared) {
        throw new Error("Underlying connection does not support queryResultPrepared.");
      }
      return this.connection.queryResultPrepared<T>(sql, params, options);
    });
  }

  executePrepared(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<ExecuteResult> {
    return runStatement(options, "Transaction statement failed.", () => {
      if (!this.connection.executePrepared) {
        throw new Error("Underlying connection does not support executePrepared.");
      }
      return this.connection.executePrepared(sql, params, options);
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
    if (isAbortReason(error, options?.signal)) {
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
 * The `tx` handed to a `CubridClient.transaction()` callback. It allows exactly
 * one terminal outcome, whether the callback asks for it through `commit()` or
 * `rollback()` or the client decides when the callback settles. Everything
 * after that outcome rejects without reaching the connection: the adapter is
 * back in autocommit by then, so a late statement would persist on its own.
 *
 * `CubridTransaction` stays an unguarded forwarder because its constructor is
 * public 1.x API and a caller may reuse one across several transactions.
 */
export class CallbackTransaction extends CubridTransaction {
  protected state: CallbackTransactionState = "open";
  private completion: Promise<void> | undefined;
  private readonly runningQueries = new Set<Promise<unknown>>();
  private readonly justRejectedQueries = new Set<Promise<unknown>>();
  private readonly rejectedQueries = new Set<Promise<unknown>>();

  /** Why the rollback failed, once one was attempted and rejected. */
  rollbackFailure: Error | undefined;

  override query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.track(() => super.query<T>(sql, params, options));
  }

  override queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.track(() => super.queryResult<T>(sql, params, options));
  }

  override execute(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<ExecuteResult> {
    return this.track(() => super.execute(sql, params, options));
  }

  override queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.track(() => super.queryPrepared<T>(sql, params, options));
  }

  override queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.track(() => super.queryResultPrepared<T>(sql, params, options));
  }

  override executePrepared(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<ExecuteResult> {
    return this.track(() => super.executePrepared(sql, params, options));
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
    for (const query of this.justRejectedQueries) {
      this.runningQueries.add(query);
    }

    await (this.completion ?? this.commit());
  }

  /**
   * The transaction failed: roll back unless a completion already ran. Never
   * rejects, so the caller keeps its original failure; see `rollbackFailure`.
   */
  async abort(): Promise<void> {
    // Nobody may ever look at these now, and the callback's failure is the one reported.
    // A rejection left alone until the event loop moved on was already reported by Node.js.
    for (const query of this.rejectedQueries) {
      query.catch(() => {
        // The transaction failed for another reason.
      });
    }

    await (this.completion ?? this.rollback()).catch(() => {
      // Recorded in rollbackFailure when it matters; the original error wins.
    });
  }

  /** Runs one statement of this transaction, unless the transaction is over. */
  private track<R>(statement: () => Promise<R>): Promise<R> {
    if (this.state !== "open") {
      return Promise.reject(new TransactionError(COMPLETED_MESSAGES[this.state]));
    }

    const pending = statement();

    // Tracks the promise the caller holds, so settling it later also marks it handled.
    // It leaves the set in the same step that settles it, so it is never untracked
    // while still pending.
    const settle = async (): Promise<R> => {
      try {
        return await pending;
      } catch (error) {
        this.rememberRejection(running);
        throw error;
      } finally {
        this.runningQueries.delete(running);
      }
    };
    const running = settle();

    this.runningQueries.add(running);
    return running;
  }

  /**
   * Keeps a rejected query visible to finish() for two microtask turns. A callback
   * that awaited it resumes one turn after the rejection, and transaction() resumes
   * one turn after the callback returns, so by then this entry is gone. A query still
   * here when the callback settles rejected too late for the callback to have seen it.
   */
  protected rememberRejection(query: Promise<unknown>): void {
    this.rejectedQueries.add(query);
    this.justRejectedQueries.add(query);
    queueMicrotask(() => {
      queueMicrotask(() => {
        this.justRejectedQueries.delete(query);
      });
    });
  }

  private complete(outcome: "commit" | "rollback"): Promise<void> {
    if (this.state !== "open") {
      return Promise.reject(new TransactionError(COMPLETED_MESSAGES[this.state]));
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
   * Settling them also marks their promises handled: this is where a failure is reported.
   */
  private settleRunningQueries(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(this.runningQueries);
  }

  private async runCommit(): Promise<void> {
    try {
      // Nobody awaited a query still running here, so nobody decided its failure was
      // acceptable. Committing would persist the rest of the work without it. A query
      // that rejected before the callback's last step cannot be told apart from a handled one.
      const results = await this.settleRunningQueries();
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      if (failed) {
        throw failed.reason;
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

      throw error;
    }
  }

  private async runRollback(): Promise<void> {
    await this.settleRunningQueries();

    try {
      await super.rollback();
      this.state = "rolledBack";
    } catch (error) {
      this.state = "failed";
      this.rollbackFailure = toError(error);
      throw error;
    }
  }
}

/**
 * The handle `CubridClient.beginTransactionScope()` returns (#112). It owns a
 * dedicated connection, so statements sent on the client meanwhile cannot join
 * its transaction. It keeps the guarantees of the `transaction()` callback's
 * `tx`: one terminal outcome, a commit refused while one of its statements is
 * still failing, and a rollback after a failed commit. Whichever way it ends, its
 * connection is closed and the client stops tracking it.
 */
export class ScopedTransaction extends CallbackTransaction {
  private ending: Promise<void> | undefined;

  constructor(
    private readonly ownConnection: ConnectionLike,
    private readonly onEnded: () => void,
  ) {
    super(ownConnection);
  }

  override commit(): Promise<void> {
    return this.end(() => super.commit(), "Failed to commit.", true);
  }

  override rollback(): Promise<void> {
    return this.end(() => super.rollback(), "Failed to rollback.", false);
  }

  /**
   * For `CubridClient.close()`: ends a transaction nobody ended by closing its
   * connection, and the server discards the uncommitted work with it. It does not
   * wait for statements still running first, unlike rollback(): one may be waiting
   * for a lock that only another connection being closed would release. A
   * statement already sent then fails with a connection error. Never rejects.
   */
  async discard(): Promise<void> {
    if (!this.ending) {
      this.state = "discarded";
      this.ending = this.closeOwnConnection();
    }

    await this.ending.catch(() => {
      // Nothing to report: close() is not about this transaction's outcome.
    });
  }

  /**
   * A handle may live long and run many statements whose failures its caller
   * handled; only finish() and abort() of the transaction() callback read these.
   */
  protected override rememberRejection(): void {}

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
      // A failed explicit rollback is already the cause.
      if (committing && failure instanceof TransactionError && this.rollbackFailure) {
        failure.rollbackError = this.rollbackFailure;
      }
    }

    try {
      await this.closeOwnConnection();
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

  private async closeOwnConnection(): Promise<void> {
    try {
      await this.ownConnection.close();
    } finally {
      this.onEnded();
    }
  }
}
