/** The CUBRID type a {@link ZonedDateTime} was read from. */
export type ZonedDateTimeType = "TIMESTAMPTZ" | "TIMESTAMPLTZ" | "DATETIMETZ" | "DATETIMELTZ";

/** The fields of a {@link ZonedDateTime}. */
export interface ZonedDateTimeFields {
  type: ZonedDateTimeType;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  zone: string;
}

/**
 * A TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ or DATETIMELTZ value: the wall-clock
 * fields the server sent and the zone they are in, exactly as sent.
 *
 * It is not a `Date`. A `Date` is an instant and cannot say which zone the
 * value was stored in, and for a region zone the instant depends on the zone
 * rules of the day. The server's own zone text is kept in `zone`: an offset
 * such as `+09:00`, or a region and abbreviation such as `Asia/Seoul KST`.
 * For a TIMESTAMPLTZ or DATETIMELTZ value the server sends the fields in the
 * zone of the session that read it.
 *
 * `month` runs from 1 to 12, unlike `Date#getMonth`. `millisecond` is always 0
 * for TIMESTAMPTZ and TIMESTAMPLTZ, which have no fractional seconds.
 */
export class ZonedDateTime {
  readonly type: ZonedDateTimeType;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly zone: string;

  constructor(fields: ZonedDateTimeFields) {
    this.type = fields.type;
    this.year = fields.year;
    this.month = fields.month;
    this.day = fields.day;
    this.hour = fields.hour;
    this.minute = fields.minute;
    this.second = fields.second;
    this.millisecond = fields.millisecond;
    this.zone = fields.zone;
    Object.freeze(this);
  }

  /**
   * The value as SQL literal text, `YYYY-MM-DD HH:MM:SS[.mmm] <zone>`; the
   * fraction is written for DATETIMETZ and DATETIMELTZ only.
   */
  toString(): string {
    const pad = (value: number, width: number): string => String(value).padStart(width, "0");
    const fraction =
      this.type === "DATETIMETZ" || this.type === "DATETIMELTZ"
        ? `.${pad(this.millisecond, 3)}`
        : "";
    return (
      `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)} ` +
      `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}${fraction} ${this.zone}`
    );
  }

  /** The same text as {@link ZonedDateTime.toString}, so `JSON.stringify` keeps the zone. */
  toJSON(): string {
    return this.toString();
  }
}
