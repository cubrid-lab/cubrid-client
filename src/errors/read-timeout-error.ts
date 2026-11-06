import { ConnectionError } from "./connection-error.js";

/**
 * The server sent nothing for `timeoutMs` milliseconds while a response was
 * awaited. The connection has been discarded, so a late response can never be
 * mistaken for the next operation's. The request's outcome on the server is
 * unknown: it may still have run, and a COMMIT may have succeeded.
 * Applications must verify the outcome; a timed-out COMMIT is never retried
 * automatically by the driver.
 */
export class ReadTimeoutError extends ConnectionError {
  override name = "ReadTimeoutError";

  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`No activity from the CUBRID server for ${timeoutMs}ms.`, options);
  }
}
