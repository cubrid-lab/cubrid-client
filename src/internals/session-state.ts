import type { ConnectionLike } from "../types/client.js";

/**
 * Key of the internal method through which a connection tells the pool whether
 * its session may be handed to another caller. It is a symbol, not a member of
 * `ConnectionLike`, so it adds nothing to the public interface; a custom
 * connection without it is reused only after a lease in which every call
 * succeeded.
 */
export const SESSION_STATE: unique symbol = Symbol("cubrid-client.sessionState");

/** What the pool reads from a connection when a lease ends. See ADR 0008. */
export interface SessionState {
  /**
   * A transaction is open, or the server ended one the caller has not yet
   * acknowledged. Reusing the session would let the next caller join it.
   */
  inTransaction: boolean;
  /** A stream cursor or a queued statement still holds or waits for the session. */
  busy: boolean;
  /** Requests whose outcome is unknown, counted over the life of the connection. */
  failedExchanges: number;
  /**
   * The subset of `failedExchanges` that were written to the server, or whose
   * session was discarded, without a reply saying what they did (#254).
   * Absent from a reader that cannot tell.
   */
  unknownOutcomes?: number;
  /** A session is open and ready. */
  connected: boolean;
}

/** The connection's own reader, or undefined when it has none. */
export function sessionStateReader(connection: ConnectionLike): (() => SessionState) | undefined {
  const read: unknown = (connection as unknown as Record<symbol, unknown>)[SESSION_STATE];
  return typeof read === "function" ? () => read.call(connection) as SessionState : undefined;
}

/**
 * Call when a transaction gets its connection; the function it returns tells
 * whether a request sent on it since then has an unknown outcome, or undefined
 * when the connection cannot report it, such as a custom one.
 */
export function unknownOutcomeProbe(connection: ConnectionLike): () => boolean | undefined {
  const read = sessionStateReader(connection);
  const start = read?.().unknownOutcomes;
  return () => (read && start !== undefined ? read().unknownOutcomes !== start : undefined);
}
