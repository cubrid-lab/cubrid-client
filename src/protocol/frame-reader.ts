/**
 * The byte reader of one socket (#253).
 *
 * One data listener stays on the socket for as long as the reader owns it, so
 * no byte depends on a listener being attached in time, and a read costs no
 * listener churn. The listener queues chunks in arrival order and hands them
 * to one read at a time, so frames come out in strict FIFO order. A reader
 * belongs to one physical socket: bytes of a socket that has been replaced can
 * never satisfy a read of its successor, which has a reader of its own.
 */

import type { Socket } from "node:net";
import { ConnectionLostError } from "../errors/internal-errors.js";

/**
 * Bytes kept beyond a read before the socket is paused. A CAS sends nothing it
 * was not asked for, so this is only reached after a protocol violation, such
 * as the rest of an over-limit reply. A paused socket holds back its 'end'
 * event until it resumes.
 */
export const SURPLUS_LIMIT = 64 * 1024;

const CLOSED = "Connection closed while reading";

interface PendingRead {
  size: number;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private pending: PendingRead | null = null;
  /** Why no more bytes will come. Bytes already queued are still served first. */
  private failure: ConnectionLostError | null = null;
  private attached = true;
  private pausedByReader = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onClose);
  }

  /**
   * Resolve with the next `size` bytes. Only one read may be pending: callers
   * are serialized, and a read that was abandoned (timeout, abort) leaves the
   * socket out of step, so its owner must discard the reader before reading on.
   */
  read(size: number): Promise<Buffer> {
    if (this.pending) {
      return Promise.reject(
        new Error("Internal error: a FrameReader read is already pending on this socket"),
      );
    }
    if (this.buffered >= size) {
      const data = this.take(size);
      this.limitSurplus();
      return Promise.resolve(data);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    // A destroyed socket emits nothing further, so waiting would never end.
    if (!this.attached || this.socket.destroyed) {
      return Promise.reject(new ConnectionLostError(CLOSED));
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.pending = { size, resolve, reject };
      if (this.pausedByReader) {
        this.pausedByReader = false;
        this.socket.resume();
      }
    });
  }

  /**
   * Give the socket up without closing it, for the TLS upgrade: pause it so no
   * byte is emitted with nobody listening, remove the listeners, and return the
   * bytes queued but not read, for the caller to unshift() back.
   */
  detach(): Buffer {
    this.socket.pause();
    const surplus =
      this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks);
    this.release();
    return surplus;
  }

  /** Drop the socket and every queued byte; a pending read rejects. Idempotent. */
  dispose(): void {
    if (this.attached) {
      this.release();
    }
  }

  private release(): void {
    this.attached = false;
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onEnd);
    this.socket.removeListener("close", this.onClose);
    this.chunks = [];
    this.buffered = 0;
    this.fail(new ConnectionLostError(CLOSED));
  }

  private readonly onData = (chunk: Buffer): void => {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const pending = this.pending;
    if (pending && this.buffered >= pending.size) {
      this.pending = null;
      pending.resolve(this.take(pending.size));
    }
    this.limitSurplus();
  };

  private readonly onError = (error: Error): void => {
    this.fail(new ConnectionLostError(error.message, { cause: error }));
  };

  private readonly onEnd = (): void => {
    this.fail(new ConnectionLostError("Connection ended while reading"));
  };

  private readonly onClose = (): void => {
    this.fail(new ConnectionLostError(CLOSED));
  };

  /** The first failure is the one reported. */
  private fail(error: ConnectionLostError): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(this.failure);
  }

  /** Pause the socket while more than SURPLUS_LIMIT bytes wait with no read for them. */
  private limitSurplus(): void {
    if (!this.pending && !this.pausedByReader && this.attached && this.buffered > SURPLUS_LIMIT) {
      this.pausedByReader = true;
      this.socket.pause();
    }
  }

  /** Remove `size` queued bytes, copying only when they span several chunks. */
  private take(size: number): Buffer {
    this.buffered -= size;
    const first = this.chunks[0];
    if (first && first.length >= size) {
      if (first.length === size) {
        this.chunks.shift();
        return first;
      }
      this.chunks[0] = first.subarray(size);
      return first.subarray(0, size);
    }
    const joined = Buffer.concat(this.chunks, this.buffered + size);
    this.chunks = this.buffered > 0 ? [joined.subarray(size)] : [];
    return joined.subarray(0, size);
  }
}
