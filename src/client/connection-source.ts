import { NotSentError } from "../errors/internal-errors.js";
import { TransactionError } from "../errors/transaction-error.js";
import { mapError, toError, withTransactionOutcome } from "../internals/map-error.js";
import { pickTransactionOptions } from "../internals/normalize-config.js";
import { unknownOutcomeProbe } from "../internals/session-state.js";
import type {
  BatchTransactionClient,
  ClientConfig,
  ConnectionFactory,
  ConnectionLike,
  ExecutableTransactionClient,
  PreparedTransactionClient,
  ResultTransactionClient,
  TransactionCallback,
  TransactionOptions,
  TransactionScope,
} from "../types/client.js";
import { CallbackTransaction, ScopedTransaction } from "./transaction.js";

/**
 * How a transaction left its connection, as far as the transaction knows:
 * `in-transaction` when it began but could not be ended cleanly, `error` when
 * it failed before its transaction began, and `reuse` otherwise, which the pool
 * still checks against the session itself (ADR 0008). A client closes the
 * connection whatever the verdict.
 */
export type ConnectionVerdict = "reuse" | "in-transaction" | "error";

/**
 * Where `transaction()` and `beginTransactionScope()` get their dedicated
 * connection and what they do with it afterwards: the client opens a new one and
 * closes it, the pool leases one and releases or destroys it.
 */
export interface ConnectionSource {
  open(): Promise<ConnectionLike>;
  /** Applies the configured, then the per-call, transaction settings. */
  applyOptions(connection: ConnectionLike, options: TransactionOptions | undefined): Promise<void>;
  end(connection: ConnectionLike, verdict: ConnectionVerdict): Promise<void>;
}

/**
 * Hands `options` to a new connection before anything runs on it. A connection
 * that cannot take them fails here: the statements would otherwise run, with no
 * sign of it, under the server's defaults.
 */
export async function applyTransactionOptions(
  connection: ConnectionLike,
  options: TransactionOptions,
): Promise<void> {
  if (Object.keys(options).length === 0) {
    return;
  }

  if (!connection.setTransactionOptions) {
    throw new Error("Underlying connection does not support transaction options.");
  }

  await connection.setTransactionOptions(options);
}

/** The client's source: a new connection per transaction, closed at its end. */
export function factorySource(config: ClientConfig, factory: ConnectionFactory): ConnectionSource {
  return {
    open: async () => factory(config),
    applyOptions: (connection, options) =>
      applyTransactionOptions(connection, {
        ...pickTransactionOptions(config),
        ...pickTransactionOptions(options),
      }),
    end: (connection) => connection.close(),
  };
}

export type TransactionHandle = ResultTransactionClient &
  ExecutableTransactionClient &
  PreparedTransactionClient &
  BatchTransactionClient;

/**
 * The body of `transaction()`: begin, run the callback, commit or roll back,
 * and end the connection. A failure to end it after a commit rejects (the 1.x
 * result); after a failure it is recorded in `closeError`.
 */
export async function runTransaction<T>(
  source: ConnectionSource,
  callback: TransactionCallback<T, TransactionHandle>,
  options: TransactionOptions | undefined,
): Promise<T> {
  const connection = await source.open();
  const outcomeUnknown = unknownOutcomeProbe(connection);
  let transaction: CallbackTransaction | undefined;
  let failed = false;
  let details: TransactionError | undefined;

  try {
    await source.applyOptions(connection, options);
    await connection.beginTransaction();
    transaction = new CallbackTransaction(connection);
    const result = await callback(transaction);
    await transaction.finish();
    return result;
  } catch (error) {
    failed = true;
    await transaction?.abort();
    const failure = mapError("transaction", error, "Transaction failed.");

    // mapError returns a ReadTimeoutError unchanged, and that object is not ours to modify.
    if (failure instanceof TransactionError) {
      details = failure;

      if (transaction?.rollbackFailure) {
        details.rollbackError = transaction.rollbackFailure;
      }
      // Read before the connection ends: closing it is no request of the transaction.
      withTransactionOutcome(details, outcomeUnknown(), transaction?.rollbackFailure);
    }

    throw failure;
  } finally {
    // A transaction that never began, or whose rollback failed, leaves its
    // session in an unknown state.
    const verdict: ConnectionVerdict = !failed
      ? "reuse"
      : !transaction
        ? "error"
        : transaction.rollbackFailure
          ? "in-transaction"
          : "reuse";
    try {
      await source.end(connection, verdict);
    } catch (closeError) {
      if (!failed) {
        // biome-ignore lint/correctness/noUnsafeFinally: after a commit, a failed close is the 1.x result of transaction()
        throw closeError;
      }

      if (details) {
        details.closeError = toError(closeError);
      }
    }
  }
}

/**
 * The body of `beginTransactionScope()`. `isClosed` is checked again once the
 * transaction has begun: a close() that ran meanwhile could not see it, so
 * nothing would ever end it.
 */
export async function beginScope(
  source: ConnectionSource,
  options: TransactionOptions | undefined,
  isClosed: () => boolean,
  closedMessage: string,
  openScopes: Set<ScopedTransaction>,
): Promise<TransactionScope> {
  let connection: ConnectionLike | undefined;
  try {
    connection = await source.open();
    await source.applyOptions(connection, options);
    await connection.beginTransaction();
  } catch (error) {
    if (connection) {
      await source.end(connection, "error").catch(() => {
        // The failure to begin is the one to report.
      });
    }
    throw mapError("transaction", error, "Failed to begin transaction.");
  }

  if (isClosed()) {
    await source.end(connection, "in-transaction").catch(() => {
      // The client is closed; that is the failure to report.
    });
    throw mapError("transaction", new NotSentError(closedMessage), "Failed to begin transaction.");
  }

  const scope: ScopedTransaction = new ScopedTransaction(connection, source, () => {
    openScopes.delete(scope);
  });
  openScopes.add(scope);
  return scope;
}
