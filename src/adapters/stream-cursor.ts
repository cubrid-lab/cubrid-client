import type { DecodedRow } from "../protocol/protocol.js";

/**
 * The hand-over between a statement that holds its turn on the connection (the
 * producer) and the code iterating `stream()` (the consumer). The producer offers
 * one window of rows and then waits, so the next FETCH goes out only when the
 * consumer has used up the previous window. That wait is the backpressure: at most
 * one window is held here, however large the result is.
 */
export class StreamCursor {
  /** When the consumer last showed it is still reading. */
  activityAt = Date.now();

  private window: DecodedRow[] | null = null;
  private stopped = false;
  private cancellation: { reason: unknown } | null = null;
  private running = false;
  private finished = false;
  private failure: { error: unknown } | null = null;
  private producer: Promise<void> = Promise.resolve();
  private resumeProducer: (() => void) | null = null;
  private resumeConsumer: (() => void) | null = null;

  constructor(readonly consumerTimeout: number) {}

  /** True once the rows are no longer wanted, so the producer must release its handle. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** True once the statement's turn came and it started to run, so it may have sent requests. */
  get hasBegun(): boolean {
    return this.running;
  }

  /** Takes ownership of the queued statement that produces this cursor's rows. */
  run(producer: Promise<void>): void {
    this.producer = producer.then(
      () => this.finish(),
      (error: unknown) => {
        this.failure = { error };
        this.finish();
      },
    );
  }

  /** Called when the statement's turn comes. False means it must send nothing. */
  begin(): boolean {
    this.running = !this.stopped;
    return this.running;
  }

  /**
   * Hands over `rows`. With `more` set this waits until the consumer asks for the
   * next window or stops. Without it the server has nothing left to send, so the
   * statement can release its turn while the consumer reads these rows.
   */
  offer(rows: DecodedRow[], more: boolean): Promise<void> {
    this.window = rows;
    this.activityAt = Date.now();
    this.wakeConsumer();

    if (!more || this.stopped) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.resumeProducer = resolve;
    });
  }

  /** The next window, or null after the last one. Rejects if the statement failed. */
  async take(): Promise<DecodedRow[] | null> {
    this.wakeProducer();

    for (;;) {
      this.assertNotCancelled();

      if (this.window) {
        const rows = this.window;
        this.window = null;
        return rows;
      }

      if (this.finished) {
        if (this.failure) {
          const { error } = this.failure;
          this.failure = null;
          throw error;
        }
        return null;
      }

      await new Promise<void>((resolve) => {
        this.resumeConsumer = resolve;
      });
    }
  }

  /** Rows still held in the current window are dropped once the stream is cancelled. */
  assertNotCancelled(): void {
    if (this.cancellation) {
      throw this.cancellation.reason;
    }
  }

  /** Stops the stream from outside the consumer, which may not be asking for anything. */
  cancel(reason: unknown): void {
    this.cancellation ??= { reason };
    this.stopped = true;
    this.wakeProducer();
    this.wakeConsumer();
  }

  /**
   * Stops the stream and waits until its handle is released and its turn is over.
   * A statement still queued sends nothing when its turn comes, so nothing is
   * waited for. Rejects with a failure the consumer has not seen yet.
   */
  async close(): Promise<void> {
    this.stopped = true;
    this.wakeProducer();

    if (this.running) {
      await this.producer;
    }

    if (this.failure && !this.cancellation) {
      const { error } = this.failure;
      this.failure = null;
      throw error;
    }
  }

  private finish(): void {
    this.finished = true;
    this.wakeConsumer();
  }

  private wakeProducer(): void {
    const resume = this.resumeProducer;
    this.resumeProducer = null;
    resume?.();
  }

  private wakeConsumer(): void {
    const resume = this.resumeConsumer;
    this.resumeConsumer = null;
    resume?.();
  }
}
