// Reader variants for bench-reader.ts and bench-reader-live.ts (#253). Importing
// this replaces CASConnection.recvExact() with a dispatcher; each socket keeps
// the variant selected when it is first read from:
//
//   framed           the shipped reader: one FrameReader per socket.
//   per-read         the reader before #253, verbatim: every read attaches
//                    data/error/close/end listeners and removes them again.
//   per-read-nocopy  per-read, but a read met by one chunk takes it without
//                    copying it first.
import type { Socket } from "node:net";

import { ConnectionLostError } from "../src/errors/internal-errors.js";
import { CASConnection } from "../src/protocol/connection.js";
import { FrameReader } from "../src/protocol/frame-reader.js";

export type Mode = "framed" | "per-read" | "per-read-nocopy";

interface Internals {
  readers: WeakMap<Socket, FrameReader>;
  recvExact(socket: Socket, size: number): Promise<Buffer>;
  withReadTimeout<T>(socket: Socket, operation: Promise<T>): Promise<T>;
  readFrame(socket: Socket): Promise<Buffer>;
}

const prototype = CASConnection.prototype as unknown as Internals;
const framedRecvExact = prototype.recvExact;
const readFrame = prototype.readFrame;
let frames = 0;
prototype.readFrame = function (this: Internals, socket: Socket): Promise<Buffer> {
  frames += 1;
  return readFrame.call(this, socket);
};

/** What the connection's receiveBuffer held before #253, kept per socket here. */
const received = new WeakMap<Socket, Buffer>();

function takeBuffered(socket: Socket, size: number): Buffer {
  const buffer = received.get(socket) ?? Buffer.alloc(0);
  received.set(socket, buffer.subarray(size));
  return buffer.subarray(0, size);
}

function perReadRecvExact(
  this: Internals,
  socket: Socket,
  size: number,
  copyAlways: boolean,
): Promise<Buffer> {
  const read = new Promise<Buffer>((resolve, reject) => {
    const buffer = received.get(socket) ?? Buffer.alloc(0);
    if (buffer.length >= size) {
      resolve(takeBuffered(socket, size));
      return;
    }
    if (socket.destroyed) {
      reject(new ConnectionLostError("Connection closed while reading"));
      return;
    }
    const chunks: Buffer[] = copyAlways || buffer.length > 0 ? [buffer] : [];
    let total = buffer.length;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= size) {
        cleanup();
        received.set(socket, chunks.length === 1 ? chunk : Buffer.concat(chunks, total));
        resolve(takeBuffered(socket, size));
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new ConnectionLostError(err.message, { cause: err }));
    };
    const onClose = (): void => {
      cleanup();
      reject(new ConnectionLostError("Connection closed while reading"));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new ConnectionLostError("Connection ended while reading"));
    };
    const cleanup = (): void => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onEnd);
  });
  return this.withReadTimeout(socket, read);
}

let modeForNewSockets: Mode = "framed";
const socketModes = new WeakMap<Socket, Mode>();

/** Select the reader of every socket that has not been read from yet. */
export function useReader(mode: Mode): void {
  modeForNewSockets = mode;
}

/** Frames read so far, by every connection. */
export function framesRead(): number {
  return frames;
}

prototype.recvExact = function (this: Internals, socket: Socket, size: number): Promise<Buffer> {
  let mode = socketModes.get(socket);
  if (mode === undefined) {
    mode = modeForNewSockets;
    socketModes.set(socket, mode);
    const reader = this.readers.get(socket);
    if (mode === "framed" && !reader) {
      // A socket the benchmark made itself, not one from createSocket().
      this.readers.set(socket, new FrameReader(socket));
    } else if (mode !== "framed" && reader) {
      received.set(socket, reader.detach());
      this.readers.delete(socket);
      socket.resume();
    }
  }
  if (mode === "framed") {
    return framedRecvExact.call(this, socket, size);
  }
  return perReadRecvExact.call(this, socket, size, mode === "per-read");
};
