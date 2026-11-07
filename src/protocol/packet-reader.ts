/**
 * Binary packet reader for the CUBRID CAS protocol.
 *
 * All numeric values are read in big-endian byte order.
 */

import {
  SIZE_BYTE,
  SIZE_CAS_INFO,
  SIZE_DOUBLE,
  SIZE_FLOAT,
  SIZE_INT,
  SIZE_LONG,
  SIZE_SHORT,
} from "./constants.js";

export class PacketReader {
  private readonly buf: Buffer;
  private offset: number;

  constructor(data: Buffer, offset = 0) {
    this.buf = data;
    this.offset = offset;
  }

  // ---------------------------------------------------------------------------
  // Scalar readers
  // ---------------------------------------------------------------------------

  parseByte(): number {
    const value = this.buf.readInt8(this.offset);
    this.offset += SIZE_BYTE;
    return value;
  }

  parseUByte(): number {
    const value = this.buf.readUInt8(this.offset);
    this.offset += SIZE_BYTE;
    return value;
  }

  parseShort(): number {
    const value = this.buf.readInt16BE(this.offset);
    this.offset += SIZE_SHORT;
    return value;
  }

  parseInt(): number {
    const value = this.buf.readInt32BE(this.offset);
    this.offset += SIZE_INT;
    return value;
  }

  parseLong(): bigint {
    const value = this.buf.readBigInt64BE(this.offset);
    this.offset += SIZE_LONG;
    return value;
  }

  parseFloat(): number {
    const value = this.buf.readFloatBE(this.offset);
    this.offset += SIZE_FLOAT;
    return value;
  }

  parseDouble(): number {
    const value = this.buf.readDoubleBE(this.offset);
    this.offset += SIZE_DOUBLE;
    return value;
  }

  // ---------------------------------------------------------------------------
  // Buffer / string readers
  // ---------------------------------------------------------------------------

  parseBytes(length: number): Buffer {
    this.assertAvailable(length);
    const data = Buffer.alloc(length);
    this.buf.copy(data, 0, this.offset, this.offset + length);
    this.offset += length;
    return data;
  }

  /** Read `length` bytes and return as a UTF-8 string, stripping trailing null. */
  parseNullTermString(length: number): string {
    if (length <= 0) {
      return "";
    }
    this.assertAvailable(length);
    const raw = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    // Strip trailing null byte(s)
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) {
      end--;
    }
    return raw.subarray(0, end).toString("utf-8");
  }

  /**
   * Bound a reader to the next `length` bytes and move this reader past them.
   * A value decoded from the returned reader cannot read beyond its declared
   * length, and this reader stays aligned on the following value whatever the
   * decoder does.
   */
  subReader(length: number): PacketReader {
    this.assertAvailable(length);
    const reader = new PacketReader(this.buf.subarray(this.offset, this.offset + length));
    this.offset += length;
    return reader;
  }

  /** Parse CAS_INFO (4 bytes). */
  parseCASInfo(): Buffer {
    return this.parseBytes(SIZE_CAS_INFO);
  }

  // ---------------------------------------------------------------------------
  // Date/time readers
  // ---------------------------------------------------------------------------

  /** Read 7 × int16 (DATETIME) and return a Date. */
  parseDatetime(): Date {
    const year = this.parseShort();
    const month = this.parseShort() - 1; // JS months are 0-indexed
    const day = this.parseShort();
    const hour = this.parseShort();
    const minute = this.parseShort();
    const second = this.parseShort();
    const ms = this.parseShort();
    return new Date(year, month, day, hour, minute, second, ms);
  }

  /** Read 6 × int16 (TIMESTAMP — no ms) and return a Date. */
  parseTimestamp(): Date {
    const year = this.parseShort();
    const month = this.parseShort() - 1;
    const day = this.parseShort();
    const hour = this.parseShort();
    const minute = this.parseShort();
    const second = this.parseShort();
    return new Date(year, month, day, hour, minute, second);
  }

  /** Read 3 × int16 (DATE only — year, month, day) and return a Date. */
  parseDate(): Date {
    const year = this.parseShort();
    const month = this.parseShort() - 1;
    const day = this.parseShort();
    return new Date(year, month, day);
  }

  /** Read 3 × int16 (TIME only — hour, min, sec) and return a Date. */
  parseTime(): Date {
    const hour = this.parseShort();
    const minute = this.parseShort();
    const second = this.parseShort();
    return new Date(1970, 0, 1, hour, minute, second);
  }

  // ---------------------------------------------------------------------------
  // Error reader
  // ---------------------------------------------------------------------------

  /**
   * Read an error block from the response.
   * Format: int32 error_code + null-terminated error message.
   */
  readError(responseLength: number): { code: number; message: string } {
    const code = this.parseInt();
    const msgSize = responseLength - SIZE_INT;
    const message = msgSize > 0 ? this.parseNullTermString(msgSize) : "";
    return { code, message };
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  skip(length: number): void {
    this.assertAvailable(length);
    this.offset += length;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  /** Reject a length the packet cannot satisfy, before the offset moves. */
  private assertAvailable(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError(
        `Malformed CAS packet: cannot read ${length} bytes at offset ${this.offset} ` +
          `(${this.remaining} remaining)`,
      );
    }
  }
}
