/**
 * Byte values (#309): a Buffer, or a plain Uint8Array, which the public types
 * accept as `CubridBytes` without Node's types. Other typed arrays and DataView
 * are not bytes.
 */
export function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** `bytes` as a Buffer over the same memory: nothing is copied. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
