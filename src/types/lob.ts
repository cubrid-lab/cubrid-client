import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

import { NOT_LATIN1, type TextCharset } from "../protocol/charset.js";
import type { QueryParam } from "./query.js";

/** Content for {@link blob}: bytes, or a stream of byte chunks read once. */
export type BlobSource = Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array> | Readable;

/**
 * Content for {@link clob}: text, UTF-8 bytes, or a stream of either read once.
 * Bytes must be valid UTF-8 and text must not hold a lone surrogate. With
 * `ClientOptions.charset` "iso-8859-1" the bytes are ISO-8859-1 instead, sent as
 * they are, and text must not hold a character above U+00FF.
 */
export type ClobSource = string | Buffer | AsyncIterable<string | Buffer | Uint8Array> | Readable;

/**
 * A BLOB or CLOB parameter, made by {@link blob} or {@link clob}. The prepared
 * methods upload its content with LOB_NEW and LOB_WRITE before the statement
 * runs; every other method refuses it with a TypeError before anything is sent.
 */
export interface LobParam {
  readonly kind: "blob" | "clob";
  readonly source: BlobSource | ClobSource;
}

/** A parameter of `queryPrepared()`, `queryResultPrepared()` and `executePrepared()`. */
export type PreparedQueryParam = QueryParam | LobParam;

/**
 * Marks the values blob() and clob() return. A registered symbol, so a LobParam
 * from the ESM build is still recognized by the CommonJS build and back.
 */
const LOB_PARAM = Symbol.for("cubrid-client.LobParam");

/**
 * Stream sources whose upload has started: each can be read only once. Shared
 * through a registered symbol, so the ESM and CommonJS builds see the same set.
 */
const CONSUMED_SOURCES = Symbol.for("cubrid-client.consumedLobSources");
const registry = globalThis as { [CONSUMED_SOURCES]?: WeakSet<object> };
registry[CONSUMED_SOURCES] ??= new WeakSet<object>();
const consumedSources: WeakSet<object> = registry[CONSUMED_SOURCES];

/**
 * A BLOB parameter for the prepared methods. A Buffer or Uint8Array is sent as
 * it is and can be used again; an empty one is an empty BLOB, not NULL. An
 * AsyncIterable or Readable is read once, chunk by chunk, while the statement
 * runs. A plain Buffer parameter, without blob(), still binds as VARBIT.
 */
export function blob(source: BlobSource): LobParam {
  if (!(source instanceof Uint8Array) && !isAsyncIterable(source)) {
    throw new TypeError("blob() takes a Buffer, a Uint8Array, an AsyncIterable or a Readable");
  }
  return makeLobParam("blob", source);
}

/**
 * A CLOB parameter for the prepared methods, stored as UTF-8. A string is
 * encoded, a Buffer must already be UTF-8, and an AsyncIterable or Readable may
 * yield either and is read once. Content that is not valid UTF-8 or text with a
 * lone surrogate fails the statement with a TypeError, and nothing is stored.
 * With `ClientOptions.charset` "iso-8859-1" it is stored as ISO-8859-1: see
 * {@link ClobSource}.
 */
export function clob(source: ClobSource): LobParam {
  if (typeof source !== "string" && !Buffer.isBuffer(source) && !isAsyncIterable(source)) {
    throw new TypeError("clob() takes a string, a Buffer, an AsyncIterable or a Readable");
  }
  return makeLobParam("clob", source);
}

function makeLobParam(kind: LobParam["kind"], source: BlobSource | ClobSource): LobParam {
  const param = { kind, source };
  Object.defineProperty(param, LOB_PARAM, { value: true });
  return Object.freeze(param);
}

/** True for a value made by blob() or clob(). */
export function isLobParam(value: unknown): value is LobParam {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [LOB_PARAM]?: unknown })[LOB_PARAM] === true
  );
}

/** True for a source that is read once: an AsyncIterable or a Readable. */
export function isStreamSource(source: BlobSource | ClobSource): boolean {
  return typeof source !== "string" && !(source instanceof Uint8Array);
}

export function isSourceConsumed(source: BlobSource | ClobSource): boolean {
  return isStreamSource(source) && consumedSources.has(source as object);
}

/** Marks a stream source as read, refusing one that already was. */
export function consumeSource(source: BlobSource | ClobSource): void {
  if (!isStreamSource(source)) {
    return;
  }
  if (consumedSources.has(source as object)) {
    throw new LobParamError(STREAM_REUSED);
  }
  consumedSources.add(source as object);
}

export const STREAM_REUSED =
  "this blob() or clob() stream source has already been read; a stream can be uploaded only once";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Misuse of a blob() or clob() value. A TypeError, which every layer passes on as
 * it is: the caller's code is wrong and nothing was sent for it to fail.
 */
export class LobParamError extends TypeError {}

/**
 * Refuses a blob() or clob() value given to a method that renders SQL literals,
 * which would otherwise send it as the text '[object Object]'.
 */
export function refuseLobParams(params: unknown): void {
  if (Array.isArray(params) && params.some(isLobParam)) {
    throw new LobParamError(
      "query(), queryResult(), execute() and stream() send values as SQL literals and cannot " +
        "send a blob() or clob() value; use queryPrepared(), queryResultPrepared() or executePrepared()",
    );
  }
}

/** UTF-16 code units encoded at a time: at most 3 bytes each, so a slice stays near a chunk. */
const TEXT_SLICE = 43_690;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The content of `param` as chunks of exactly `size` bytes, the last one
 * shorter. A stream source is read with `for await`, so it is pulled only as fast
 * as the chunks are sent; small chunks are merged and large ones sliced. A CLOB
 * is checked as it goes: bytes must be UTF-8 and text must not hold a lone
 * surrogate. With charset "iso-8859-1" a CLOB is that charset instead: bytes
 * are sent as they are and text must not hold a character above U+00FF.
 * A chunk is valid only until the next one is asked for.
 */
export async function* lobChunks(
  param: LobParam,
  size: number,
  charset: TextCharset = "utf-8",
): AsyncGenerator<Buffer> {
  const pieces =
    param.kind === "blob"
      ? blobPieces(param.source)
      : charset === "iso-8859-1"
        ? latin1ClobPieces(param.source)
        : clobPieces(param.source);
  yield* rechunk(pieces, size);
}

async function* rechunk(pieces: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingLength = 0;

  for await (let piece of pieces) {
    while (piece.length > 0) {
      if (pendingLength === 0 && piece.length >= size) {
        yield piece.subarray(0, size);
        piece = piece.subarray(size);
        continue;
      }
      // Copied: a source may reuse its buffer once asked for the next chunk.
      const take = Math.min(size - pendingLength, piece.length);
      pending.push(Buffer.from(piece.subarray(0, take)));
      pendingLength += take;
      piece = piece.subarray(take);
      if (pendingLength === size) {
        yield Buffer.concat(pending, size);
        pending = [];
        pendingLength = 0;
      }
    }
  }

  if (pendingLength > 0) {
    yield Buffer.concat(pending, pendingLength);
  }
}

async function* blobPieces(source: BlobSource | ClobSource): AsyncGenerator<Buffer> {
  if (source instanceof Uint8Array) {
    yield asBuffer(source);
    return;
  }
  for await (const chunk of source as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) {
      throw new LobParamError(
        `a blob() stream yielded a ${describe(chunk)}; only Buffer and Uint8Array chunks are accepted`,
      );
    }
    yield asBuffer(chunk);
  }
}

async function* clobPieces(source: BlobSource | ClobSource): AsyncGenerator<Buffer> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // A high surrogate at the end of one string, whose low half may start the next.
  let carry = "";

  const pieces: Iterable<unknown> | AsyncIterable<unknown> =
    typeof source === "string" || Buffer.isBuffer(source) ? [source] : source;
  for await (const piece of pieces) {
    if (typeof piece === "string") {
      // Bytes before this text must have ended on a whole character.
      checkUtf8(decoder);
      let text = carry + piece;
      carry = "";
      if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
        carry = text.slice(-1);
        text = text.slice(0, -1);
      }
      yield* encodeText(text);
    } else if (piece instanceof Uint8Array) {
      if (carry !== "") {
        throw new LobParamError(LONE_SURROGATE_REFUSED);
      }
      // Sliced so no more than one chunk is decoded into a string at a time.
      const buffer = asBuffer(piece);
      for (let at = 0; at < buffer.length; at += TEXT_SLICE * 3) {
        const bytes = buffer.subarray(at, at + TEXT_SLICE * 3);
        checkUtf8(decoder, bytes);
        yield bytes;
      }
    } else {
      throw new LobParamError(
        `a clob() stream yielded a ${describe(piece)}; only string, Buffer and Uint8Array chunks are accepted`,
      );
    }
  }

  if (carry !== "") {
    throw new LobParamError(LONE_SURROGATE_REFUSED);
  }
  checkUtf8(decoder);
}

/** clobPieces() for charset "iso-8859-1": one byte per character, so nothing spans pieces. */
async function* latin1ClobPieces(source: BlobSource | ClobSource): AsyncGenerator<Buffer> {
  const pieces: Iterable<unknown> | AsyncIterable<unknown> =
    typeof source === "string" || Buffer.isBuffer(source) ? [source] : source;
  for await (const piece of pieces) {
    if (typeof piece === "string") {
      for (let at = 0; at < piece.length; at += TEXT_SLICE) {
        const slice = piece.slice(at, at + TEXT_SLICE);
        if (NOT_LATIN1.test(slice)) {
          throw new LobParamError(CLOB_NOT_LATIN1);
        }
        yield Buffer.from(slice, "latin1");
      }
    } else if (piece instanceof Uint8Array) {
      yield asBuffer(piece);
    } else {
      throw new LobParamError(
        `a clob() stream yielded a ${describe(piece)}; only string, Buffer and Uint8Array chunks are accepted`,
      );
    }
  }
}

/** UTF-8 of `text`, a slice at a time, never splitting a surrogate pair. */
function* encodeText(text: string): Generator<Buffer> {
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + TEXT_SLICE, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    const slice = text.slice(at, end);
    if (LONE_SURROGATE.test(slice)) {
      throw new LobParamError(LONE_SURROGATE_REFUSED);
    }
    yield Buffer.from(slice, "utf-8");
    at = end;
  }
}

/** Feeds `bytes` to the streaming decoder, or with none, checks that it ended on a whole character. */
function checkUtf8(decoder: TextDecoder, bytes?: Buffer): void {
  try {
    if (bytes === undefined) {
      decoder.decode();
    } else {
      decoder.decode(bytes, { stream: true });
    }
  } catch (error) {
    throw new LobParamError("clob() content is not valid UTF-8", { cause: error });
  }
}

export const CLOB_NOT_LATIN1 =
  'clob() text has a character above U+00FF, which charset "iso-8859-1" cannot encode';

const LONE_SURROGATE_REFUSED = "clob() text holds a lone surrogate, which has no UTF-8 encoding";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function describe(value: unknown): string {
  return value === null
    ? "null"
    : typeof value === "object"
      ? (value.constructor?.name ?? "object")
      : typeof value;
}
