/**
 * A `Date` parameter sent with its zone, made by {@link zoned}: a DATETIMETZ of
 * its UTC fields at `+00:00`, so a TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ or
 * DATETIMELTZ column keeps its instant whatever the session zone (#281).
 */
export interface ZonedParam {
  readonly kind: "zoned";
  /** Milliseconds since the epoch, read from the `Date` when zoned() was called. */
  readonly time: number;
}

/**
 * Marks the values zoned() returns. A registered symbol, so a ZonedParam from
 * the ESM build is still recognized by the CommonJS build and back.
 */
const ZONED_PARAM = Symbol.for("cubrid-client.ZonedParam");

/**
 * Sends `date` as the instant it is: a DATETIMETZ of its UTC fields with the
 * zone `+00:00`, on every method that takes parameters. A plain `Date` is a
 * zone-less DATETIME, to which a zone-aware column attaches the session zone.
 * Use it for zone-aware columns only: a TIMESTAMP column stores the instant in
 * the session zone instead of the UTC fields a plain `Date` gives.
 *
 * The time is read now, so changing the `Date` afterwards changes nothing.
 * A value that is not a valid `Date`, or whose UTC year is outside 1 to 9999,
 * is refused with a TypeError.
 */
export function zoned(date: Date): ZonedParam {
  if (!(date instanceof Date)) {
    throw new TypeError("zoned() takes a Date");
  }
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new TypeError("zoned() takes a valid Date, not an invalid one");
  }
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new TypeError("zoned() takes a Date whose UTC year is from 0001 to 9999");
  }
  const param = { kind: "zoned" as const, time };
  Object.defineProperty(param, ZONED_PARAM, { value: true });
  return Object.freeze(param);
}

/** True for a value made by zoned(). */
export function isZonedParam(value: unknown): value is ZonedParam {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [ZONED_PARAM]?: unknown })[ZONED_PARAM] === true
  );
}
