/**
 * Binary packet writer for the CUBRID CAS protocol.
 *
 * All numeric values are written in big-endian byte order.
 * Most fields follow the CAS convention: int32 length prefix → value bytes.
 */

import {
  SIZE_BYTE,
  SIZE_CAS_INFO,
  SIZE_DATA_LENGTH,
  SIZE_DOUBLE,
  SIZE_FLOAT,
  SIZE_INT,
  SIZE_LONG,
  SIZE_SHORT,
} from "./constants.js";

const DEFAULT_CAPACITY = 256;
const GROWTH_FACTOR = 2;

export class PacketWriter {
  private buf: Buffer;
  private offset = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.buf = Buffer.alloc(capacity);
  }

  // ---------------------------------------------------------------------------
  // Raw writers (no length prefix)
  // ---------------------------------------------------------------------------

  writeByte(value: number): void {
    this.ensureCapacity(SIZE_BYTE);
    this.buf.writeInt8(value, this.offset);
    this.offset += SIZE_BYTE;
  }

  writeShort(value: number): void {
    this.ensureCapacity(SIZE_SHORT);
    this.buf.writeInt16BE(value, this.offset);
    this.offset += SIZE_SHORT;
  }

  writeInt(value: number): void {
    this.ensureCapacity(SIZE_INT);
    this.buf.writeInt32BE(value, this.offset);
    this.offset += SIZE_INT;
  }

  writeLong(value: bigint): void {
    this.ensureCapacity(SIZE_LONG);
    this.buf.writeBigInt64BE(value, this.offset);
    this.offset += SIZE_LONG;
  }

  writeFloat(value: number): void {
    this.ensureCapacity(SIZE_FLOAT);
    this.buf.writeFloatBE(value, this.offset);
    this.offset += SIZE_FLOAT;
  }

  writeDouble(value: number): void {
    this.ensureCapacity(SIZE_DOUBLE);
    this.buf.writeDoubleBE(value, this.offset);
    this.offset += SIZE_DOUBLE;
  }

  writeBytes(data: Buffer): void {
    this.ensureCapacity(data.length);
    data.copy(this.buf, this.offset);
    this.offset += data.length;
  }

  /**
   * Write a fixed-length string, padded with 0x00 to `length` bytes. A longer
   * value throws rather than being cut, which could change what it names; the
   * message leaves the value out, since the fields hold credentials.
   */
  writeFixedString(value: string, length: number): void {
    const bytes = Buffer.from(value, "utf-8");
    if (bytes.length > length) {
      throw new RangeError(`A fixed-width field value must be at most ${length} bytes.`);
    }
    this.ensureCapacity(length);
    bytes.copy(this.buf, this.offset);
    this.buf.fill(0, this.offset + bytes.length, this.offset + length);
    this.offset += length;
  }

  /** Write a null-terminated string with int32 length prefix. */
  writeNullTermString(value: string): void {
    const encoded = Buffer.from(value, "utf-8");
    this.writeInt(encoded.length + 1); // length includes the trailing 0x00
    this.writeBytes(encoded);
    this.writeByte(0); // null terminator
  }

  // ---------------------------------------------------------------------------
  // Length-prefixed "add" helpers (CAS convention)
  // ---------------------------------------------------------------------------

  /** Write int32(SIZE_BYTE) then one byte. */
  addByte(value: number): void {
    this.writeInt(SIZE_BYTE);
    this.writeByte(value);
  }

  /** Write int32(SIZE_SHORT) then two bytes. */
  addShort(value: number): void {
    this.writeInt(SIZE_SHORT);
    this.writeShort(value);
  }

  /** Write int32(SIZE_INT) then four bytes. */
  addInt(value: number): void {
    this.writeInt(SIZE_INT);
    this.writeInt(value);
  }

  /** Write int32(SIZE_LONG) then eight bytes. */
  addLong(value: bigint): void {
    this.writeInt(SIZE_LONG);
    this.writeLong(value);
  }

  /** Write int32(SIZE_FLOAT) then four bytes. */
  addFloat(value: number): void {
    this.writeInt(SIZE_FLOAT);
    this.writeFloat(value);
  }

  /** Write int32(SIZE_DOUBLE) then eight bytes. */
  addDouble(value: number): void {
    this.writeInt(SIZE_DOUBLE);
    this.writeDouble(value);
  }

  /** Write int32(len) then raw bytes. */
  addBytes(data: Buffer): void {
    this.writeInt(data.length);
    this.writeBytes(data);
  }

  /** Write int32(0) — SQL NULL marker. */
  addNull(): void {
    this.writeInt(0);
  }

  /** Write datetime as 7 × int16 with int32 length prefix. */
  addDatetime(date: Date): void {
    this.writeInt(14); // SIZE_DATETIME
    this.writeShort(date.getFullYear());
    this.writeShort(date.getMonth() + 1);
    this.writeShort(date.getDate());
    this.writeShort(date.getHours());
    this.writeShort(date.getMinutes());
    this.writeShort(date.getSeconds());
    this.writeShort(date.getMilliseconds());
  }

  /** Write date as 7 × int16 (time fields zeroed) with int32 length prefix. */
  addDate(date: Date): void {
    this.writeInt(14);
    this.writeShort(date.getFullYear());
    this.writeShort(date.getMonth() + 1);
    this.writeShort(date.getDate());
    this.writeShort(0);
    this.writeShort(0);
    this.writeShort(0);
    this.writeShort(0);
  }

  // ---------------------------------------------------------------------------
  // Protocol header
  // ---------------------------------------------------------------------------

  /**
   * Build a protocol frame header (8 bytes):
   * - 4 bytes: DATA_LENGTH (big-endian uint32)
   * - 4 bytes: CAS_INFO (copied from server)
   */
  static buildHeader(dataLength: number, casInfo: Buffer): Buffer {
    const header = Buffer.alloc(SIZE_DATA_LENGTH + SIZE_CAS_INFO);
    header.writeUInt32BE(dataLength, 0);
    casInfo.copy(header, SIZE_DATA_LENGTH, 0, SIZE_CAS_INFO);
    return header;
  }

  // ---------------------------------------------------------------------------
  // Buffer access
  // ---------------------------------------------------------------------------

  /** Return the written portion of the internal buffer. */
  toBuffer(): Buffer {
    return this.buf.subarray(0, this.offset);
  }

  /** Current write position (number of bytes written). */
  get length(): number {
    return this.offset;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureCapacity(needed: number): void {
    if (this.offset + needed <= this.buf.length) {
      return;
    }

    let newSize = this.buf.length * GROWTH_FACTOR;
    while (newSize < this.offset + needed) {
      newSize *= GROWTH_FACTOR;
    }

    const newBuf = Buffer.alloc(newSize);
    this.buf.copy(newBuf, 0, 0, this.offset);
    this.buf = newBuf;
  }
}
