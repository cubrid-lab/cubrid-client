/**
 * Text encodings of the `charset` client option (#238). See
 * `ClientOptions.charset` for the contract.
 */

/** See `ClientOptions.charset`. */
export type TextCharset = "utf-8" | "iso-8859-1";

/**
 * Charset codes in the low three bits of a protocol V7 column type (CUBRID
 * INTL_CODESET; JDBC UJCIUtil.getJavaCharsetName): 0 ASCII, 2 binary,
 * 3 ISO-8859-1, 4 EUC-KR, 5 UTF-8.
 */
export const CAS_CHARSET_EUC_KR = 4;
export const CAS_CHARSET_UTF8 = 5;

/** A UTF-16 code unit ISO-8859-1 has no byte for: any character above U+00FF. */
export const NOT_LATIN1 = /[\u0100-\uffff]/;

/** Any other value would silently use UTF-8, so it is refused. */
export function assertValidCharset(charset: unknown): void {
  if (charset !== undefined && charset !== "utf-8" && charset !== "iso-8859-1") {
    throw new RangeError('charset must be "utf-8" or "iso-8859-1".');
  }
}

/**
 * Encode text sent to the server. ISO-8859-1 has no byte for a character
 * above U+00FF, and Buffer's `latin1` would keep only its low byte, so such
 * text throws instead. The message gives the offset, never the text.
 */
export function encodeText(value: string, charset: TextCharset, what: string): Buffer {
  assertEncodable(value, charset, what);
  return Buffer.from(value, charset === "iso-8859-1" ? "latin1" : "utf-8");
}

/** Throws what encodeText() would, without encoding. */
export function assertEncodable(value: string, charset: TextCharset, what: string): void {
  if (charset === "iso-8859-1") {
    const at = value.search(NOT_LATIN1);
    if (at !== -1) {
      throw new Error(
        `${what} has a character above U+00FF at offset ${at}, which charset "iso-8859-1" cannot encode`,
      );
    }
  }
}
