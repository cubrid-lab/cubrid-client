import { mapError, toError } from "../internals/map-error.js";
import { TransactionError } from "../errors/transaction-error.js";
import type {
  ConnectionLike,
  ExecuteResult,
  ExecutableTransactionClient,
  PreparedTransactionClient,
  ResultTransactionClient,
} from "../types/client.js";
import type { QueryParams } from "../types/query.js";
import type { QueryResult, QueryResultRow } from "../types/result.js";

export class CubridTransaction
  implements ResultTransactionClient, ExecutableTransactionClient, PreparedTransactionClient
{
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

  async queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    try {
      if (!this.connection.queryPrepared) {
        throw new Error("Underlying connection does not support queryPrepared.");
      }
      return await this.connection.queryPrepared<T>(sql, params);
    } catch (error) {
      throw mapError("transaction", error, "Transaction query failed.");
    }
  }

  async queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    try {
      if (!this.connection.queryResultPrepared) {
        throw new Error("Underlying connection does not support queryResultPrepared.");
      }
      return await this.connection.queryResultPrepared<T>(sql, params);
    } catch (error) {
      throw mapError("transaction", error, "Transaction query failed.");
    }
  }

  async executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    try {
      if (!this.connection.executePrepared) {
        throw new Error("Underlying connection does not support executePrepared.");
      }
      return await this.connection.executePrepared(sql, params);
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

type CallbackTransactionState = "open" | "completing" | "committed" | "rolledBack" | "failed";

const COMPLETED_MESSAGES: Record<Exclude<CallbackTransactionState, "open">, string> = {
  completing: "Transaction is already completing.",
  committed: "Transaction has already been committed.",
  rolledBack: "Transaction has already been rolled back.",
  failed: "Transaction has already failed.",
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
  private state: CallbackTransactionState = "open";
  private completion: Promise<void> | undefined;
  private readonly runningQueries = new Set<Promise<unknown>>();
  private readonly justRejectedQueries = new Set<Promise<unknown>>();
  private readonly rejectedQueries = new Set<Promise<unknown>>();

  /** Why the rollback failed, once one was attempted and rejected. */
  rollbackFailure: Error | undefined;

  override query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return this.track(() => super.query<T>(sql, params));
  }

  override queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    return this.track(() => super.queryResult<T>(sql, params));
  }

  override execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    return this.track(() => super.execute(sql, params));
  }

  override queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return this.track(() => super.queryPrepared<T>(sql, params));
  }

  override queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    return this.track(() => super.queryResultPrepared<T>(sql, params));
  }

  override executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    return this.track(() => super.executePrepared(sql, params));
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
  private rememberRejection(query: Promise<unknown>): void {
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
