/**
 * #250: what DATE, TIME, TIMESTAMP and DATETIME decode to under each process
 * `TZ`, for the 1.x default (`timezone: "local"`) and for `timezone: "utc"`, the
 * proposed 2.0 default (docs/adr/0010-utc-temporal-default-in-2-0.md).
 *
 * The stored fields are what the client writes for {@link SENT}: `Date`
 * parameters are always sent as their UTC fields. The expected instants are
 * written out by hand, not computed with the code under test. America/Los_Angeles
 * is on PDT (-07:00) in June 2025 and on PST (-08:00) on 1970-01-01, the day a TIME
 * is placed on; Asia/Seoul is +09:00 on both days.
 */

export const FIXTURE_ZONES = ["UTC", "Asia/Seoul", "America/Los_Angeles"] as const;
export type FixtureZone = (typeof FIXTURE_ZONES)[number];

/** The `Date` parameter written. */
export const SENT = new Date(Date.UTC(2025, 5, 14, 23, 30, 45, 678));

/** The fields the server stores for {@link SENT} in each column type. */
export const STORED = {
  datetime: [2025, 6, 14, 23, 30, 45, 678],
  timestamp: [2025, 6, 14, 23, 30, 45],
  date: [2025, 6, 14],
  time: [23, 30, 45],
} as const;

export interface DecodedIso {
  datetime: string;
  timestamp: string;
  date: string;
  time: string;
}

/** `toISOString()` of each stored value decoded under the 1.x default, per process TZ. */
export const LOCAL_DECODED: Record<FixtureZone, DecodedIso> = {
  UTC: {
    datetime: "2025-06-14T23:30:45.678Z",
    timestamp: "2025-06-14T23:30:45.000Z",
    date: "2025-06-14T00:00:00.000Z",
    time: "1970-01-01T23:30:45.000Z",
  },
  "Asia/Seoul": {
    datetime: "2025-06-14T14:30:45.678Z",
    timestamp: "2025-06-14T14:30:45.000Z",
    date: "2025-06-13T15:00:00.000Z",
    time: "1970-01-01T14:30:45.000Z",
  },
  "America/Los_Angeles": {
    datetime: "2025-06-15T06:30:45.678Z",
    timestamp: "2025-06-15T06:30:45.000Z",
    date: "2025-06-14T07:00:00.000Z",
    time: "1970-01-02T07:30:45.000Z",
  },
};

/** `toISOString()` of each stored value decoded with `timezone: "utc"`, under every process TZ. */
export const UTC_DECODED: DecodedIso = LOCAL_DECODED.UTC;

/**
 * How far the DATETIME read back under the 1.x default is from {@link SENT}, in
 * milliseconds: minus the zone's UTC offset on that day. Zero with `"utc"`.
 */
export const LOCAL_ROUND_TRIP_SHIFT_MS: Record<FixtureZone, number> = {
  UTC: 0,
  "Asia/Seoul": -9 * 3_600_000,
  "America/Los_Angeles": 7 * 3_600_000,
};

/**
 * `new Date(2025, 5, 15)`, local midnight of 15 June built under each TZ, is sent
 * as these UTC fields, and a DATE column keeps only the day: east of UTC that is
 * the day before.
 */
export const LOCAL_MIDNIGHT_SENT: Record<FixtureZone, { literal: string; storedDay: number }> = {
  UTC: { literal: "DATETIME'2025-06-15 00:00:00.000'", storedDay: 20250615 },
  "Asia/Seoul": { literal: "DATETIME'2025-06-14 15:00:00.000'", storedDay: 20250614 },
  "America/Los_Angeles": { literal: "DATETIME'2025-06-15 07:00:00.000'", storedDay: 20250615 },
};

/**
 * America/Los_Angeles daylight-saving transitions in 2026. In the gap, 02:30 on
 * 8 March does not exist; in the overlap, 01:30 on 1 November happens twice, at
 * 08:30Z (PDT) and at 09:30Z (PST).
 */
export const LA_DST = {
  gap: {
    fields: [2026, 3, 8, 2, 30, 0, 0],
    /** JavaScript moves a nonexistent local time forward by the gap's length. */
    localIso: "2026-03-08T10:30:00.000Z",
    utcIso: "2026-03-08T02:30:00.000Z",
  },
  overlap: {
    fields: [2026, 11, 1, 1, 30, 0, 0],
    /** JavaScript picks the earlier of the two instants, PDT. */
    localIso: "2026-11-01T08:30:00.000Z",
    utcIso: "2026-11-01T01:30:00.000Z",
    instants: ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"],
  },
} as const;
