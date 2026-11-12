/**
 * #113: DATE, TIME, TIMESTAMP and DATETIME carry no zone. `timezone: "utc"`
 * decodes their fields as UTC, the zone Date parameters are encoded in, so the
 * result no longer depends on the process's TZ. `"local"` stays the default.
 *
 * Node.js re-reads process.env.TZ on assignment, so each case runs under
 * several zones in one process, including ones with DST and a half-hour offset.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { CubridClient } from "../src/client/client.js";
import { createClient } from "../src/client/create-client.js";
import { normalizeConfig } from "../src/internals/normalize-config.js";
import { PacketReader } from "../src/protocol/packet-reader.js";
import { encodePreparedParams, formatValue, interpolateParams } from "../src/protocol/protocol.js";
import type { ClientOptions } from "../src/types/client.js";
import { isZonedParam, zoned } from "../src/types/zoned-param.js";
import {
  FIXTURE_ZONES,
  LA_DST,
  LOCAL_DECODED,
  LOCAL_MIDNIGHT_SENT,
  LOCAL_ROUND_TRIP_SHIFT_MS,
  SENT,
  STORED,
  UTC_DECODED,
} from "./fixtures/temporal-zones.js";

const ZONES = ["UTC", "Asia/Seoul", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"];

function withTZ(zone: string, run: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

function shorts(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => {
    buf.writeInt16BE(value, index * 2);
  });
  return buf;
}

const utc = (buf: Buffer) => new PacketReader(buf, 0, true);

test("utc: DATETIME decodes to the same instant under every process TZ", () => {
  const expected = Date.UTC(2025, 2, 14, 10, 30, 45, 123);
  for (const zone of ZONES) {
    withTZ(zone, () => {
      const value = utc(shorts(2025, 3, 14, 10, 30, 45, 123)).parseDatetime();
      assert.equal(value.getTime(), expected, zone);
    });
  }
});

test("utc: TIMESTAMP, DATE and TIME decode to fixed instants under every process TZ", () => {
  for (const zone of ZONES) {
    withTZ(zone, () => {
      assert.equal(
        utc(shorts(2025, 3, 14, 10, 30, 45))
          .parseTimestamp()
          .getTime(),
        Date.UTC(2025, 2, 14, 10, 30, 45),
        zone,
      );
      assert.equal(
        utc(shorts(2025, 6, 15))
          .parseDate()
          .toISOString(),
        "2025-06-15T00:00:00.000Z",
        zone,
      );
      assert.equal(
        utc(shorts(10, 30, 45))
          .parseTime()
          .toISOString(),
        "1970-01-01T10:30:45.000Z",
        zone,
      );
    });
  }
});

test("local (default): the same fields become a different instant under each TZ", () => {
  const instants = new Set<number>();
  for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
    withTZ(zone, () => {
      const value = new PacketReader(shorts(2025, 3, 14, 10, 30, 45, 123)).parseDatetime();
      // The 1.x contract: local getters return the stored fields.
      assert.deepEqual(
        [value.getFullYear(), value.getMonth(), value.getDate(), value.getHours()],
        [2025, 2, 14, 10],
      );
      instants.add(value.getTime());
    });
  }
  assert.equal(instants.size, 3);
});

test("utc: a Date parameter written and read back is the same instant under every TZ", () => {
  const sent = new Date(Date.UTC(2024, 1, 29, 23, 59, 59, 999));
  for (const zone of ZONES) {
    withTZ(zone, () => {
      // The literal the client sends for a Date: UTC fields, milliseconds kept.
      const literal = formatValue(sent, true);
      assert.equal(literal, "DATETIME'2024-02-29 23:59:59.999'", zone);

      const fields = literal
        .match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)\.(\d+)/)!
        .slice(1)
        .map(Number);
      assert.equal(
        utc(shorts(...fields))
          .parseDatetime()
          .getTime(),
        sent.getTime(),
        zone,
      );
    });
  }
});

test("utc: a wall-clock time inside a DST gap keeps its fields; local cannot", () => {
  // 2026-03-08 02:30 does not exist in Los Angeles: clocks jump from 02:00 to 03:00.
  withTZ("America/Los_Angeles", () => {
    const fields = shorts(2026, 3, 8, 2, 30, 0, 0);

    const asUtc = utc(fields).parseDatetime();
    assert.deepEqual([asUtc.getUTCHours(), asUtc.getUTCMinutes()], [2, 30]);

    const asLocal = new PacketReader(fields).parseDatetime();
    assert.notEqual(asLocal.getHours(), 2);
  });
});

test("utc: years 1 to 99 stay out of the 1900s", () => {
  for (const year of [1, 99, 100, 9999]) {
    const value = utc(shorts(year, 12, 31, 23, 59, 59, 999)).parseDatetime();
    assert.equal(value.getUTCFullYear(), year);
    assert.deepEqual(
      [value.getUTCMonth(), value.getUTCDate(), value.getUTCHours(), value.getUTCMilliseconds()],
      [11, 31, 23, 999],
    );
    assert.equal(
      utc(shorts(year, 2, 28))
        .parseDate()
        .getUTCFullYear(),
      year,
    );
  }
});

test("utc: sub-readers, as used for collection elements, keep the zone", () => {
  const outer = utc(Buffer.concat([shorts(2025, 3, 14, 10, 30, 45, 123)]));
  const element = outer.subReader(14);
  withTZ("Asia/Seoul", () => {
    assert.equal(element.parseDatetime().getTime(), Date.UTC(2025, 2, 14, 10, 30, 45, 123));
  });
});

test("timezone option: accepted values, default and validation", () => {
  const base: ClientOptions = { host: "localhost", database: "demodb", user: "dba" };

  assert.ok(!("timezone" in normalizeConfig(base)));
  assert.equal(normalizeConfig({ ...base, timezone: "utc" }).timezone, "utc");
  assert.equal(normalizeConfig({ ...base, timezone: "local" }).timezone, "local");

  for (const timezone of ["UTC", "Z", "+09:00", "Asia/Seoul", ""]) {
    const options = { ...base, timezone } as unknown as ClientOptions;
    assert.throws(() => createClient(options), RangeError, timezone);
    // CubridClient and the adapter are public and skip normalizeConfig().
    assert.throws(
      () =>
        new CubridClient({ ...normalizeConfig(base), timezone } as never, () => {
          throw new Error("not reached");
        }),
      RangeError,
      timezone,
    );
    assert.throws(
      () => new NativeCubridAdapter({ ...normalizeConfig(base), timezone } as never),
      RangeError,
      timezone,
    );
  }
});

// ---------------------------------------------------------------------------
// #250: the 1.x default and the proposed 2.0 default, as fixtures. The design
// is docs/adr/0010-utc-temporal-default-in-2-0.md; tests/integration.test.ts
// checks the same fixtures against a live server.
// ---------------------------------------------------------------------------

function decodeAll(utcDates: boolean): Record<keyof typeof STORED, string> {
  const read = (fields: readonly number[]) => new PacketReader(shorts(...fields), 0, utcDates);
  return {
    datetime: read(STORED.datetime).parseDatetime().toISOString(),
    timestamp: read(STORED.timestamp).parseTimestamp().toISOString(),
    date: read(STORED.date).parseDate().toISOString(),
    time: read(STORED.time).parseTime().toISOString(),
  };
}

test("#250 1.x default: each process TZ decodes the stored fields as its own instant", () => {
  // A PacketReader built without the flag is the default every client gets.
  assert.ok(!("timezone" in normalizeConfig({ host: "h", database: "d", user: "u" })));
  for (const zone of FIXTURE_ZONES) {
    withTZ(zone, () => {
      assert.deepEqual(decodeAll(false), LOCAL_DECODED[zone], zone);
      assert.equal(
        new PacketReader(shorts(...STORED.datetime)).parseDatetime().toISOString(),
        LOCAL_DECODED[zone].datetime,
        zone,
      );
    });
  }
});

test("#250 proposed 2.0 default (utc): every process TZ decodes the same instants", () => {
  for (const zone of FIXTURE_ZONES) {
    withTZ(zone, () => {
      assert.deepEqual(decodeAll(true), UTC_DECODED, zone);
    });
  }
  // A host already on TZ=UTC reads exactly what it reads today.
  assert.deepEqual(UTC_DECODED, LOCAL_DECODED.UTC);
});

test("#250: a Date parameter read back moves by the zone offset under the default only", () => {
  for (const zone of FIXTURE_ZONES) {
    withTZ(zone, () => {
      const literal = formatValue(SENT, true);
      assert.equal(literal, "DATETIME'2025-06-14 23:30:45.678'", zone);
      const local = new PacketReader(shorts(...STORED.datetime)).parseDatetime();
      assert.equal(local.getTime() - SENT.getTime(), LOCAL_ROUND_TRIP_SHIFT_MS[zone], zone);
      assert.equal(
        utc(shorts(...STORED.datetime))
          .parseDatetime()
          .getTime(),
        SENT.getTime(),
        zone,
      );
    });
  }
});

test("#250: a local-midnight Date is sent as UTC fields, so a DATE east of UTC is the day before", () => {
  for (const zone of FIXTURE_ZONES) {
    withTZ(zone, () => {
      assert.equal(formatValue(new Date(2025, 5, 15), true), LOCAL_MIDNIGHT_SENT[zone].literal);
      // A UTC-midnight Date names the same day in every zone.
      assert.equal(
        formatValue(new Date(Date.UTC(2025, 5, 15)), true),
        "DATETIME'2025-06-15 00:00:00.000'",
      );
    });
  }
});

test("#250: wall-clock fields come back through local getters by default, UTC getters with utc", () => {
  const fields = (date: Date, inUtc: boolean) =>
    inUtc
      ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours()]
      : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()];
  for (const zone of FIXTURE_ZONES) {
    withTZ(zone, () => {
      const stored = shorts(...STORED.datetime);
      assert.deepEqual(fields(new PacketReader(stored).parseDatetime(), false), [2025, 6, 14, 23]);
      assert.deepEqual(fields(utc(stored).parseDatetime(), true), [2025, 6, 14, 23]);
    });
  }
});

test("#250: DST gap and overlap in America/Los_Angeles: local guesses, utc keeps the fields", () => {
  withTZ("America/Los_Angeles", () => {
    for (const { fields, localIso, utcIso } of [LA_DST.gap, LA_DST.overlap]) {
      assert.equal(new PacketReader(shorts(...fields)).parseDatetime().toISOString(), localIso);
      assert.equal(
        utc(shorts(...fields))
          .parseDatetime()
          .toISOString(),
        utcIso,
      );
    }
  });
  // The overlap's fields stand for two instants; a zone-less value cannot say which.
  const [pdt, pst] = LA_DST.overlap.instants;
  assert.notEqual(pdt, pst);
  assert.equal(LA_DST.overlap.localIso, pdt);
});

// #273: a Date written to a TIMESTAMPTZ, DATETIMETZ or *LTZ column gets the
// session zone attached to its UTC fields. No single encoding fixes that without
// changing TIMESTAMP columns, so the encoding stays a zone-less DATETIME and the
// caller opts in with zoned() (#281) or FROM_TZ(?, '+00:00') (docs/TYPES.md). Live evidence is in
// the #273 block of tests/integration.test.ts.

test("#273: a Date is a DATETIME of its UTC fields on the literal and the prepared path, under every TZ", () => {
  const preparedHex =
    "00000001" + // type length
    "16" + // CUBRIDDataType.DATETIME, 22
    "0000000e" + // value length, 14
    shorts(...STORED.datetime).toString("hex");
  for (const zone of ZONES) {
    withTZ(zone, () => {
      assert.equal(formatValue(SENT, true), "DATETIME'2025-06-14 23:30:45.678'", zone);
      assert.equal(formatValue(SENT, false), "DATETIME'2025-06-14 23:30:45.678'", zone);
      const binds = encodePreparedParams([SENT]);
      assert.equal(binds.count, 1, zone);
      assert.equal(binds.bytes.toString("hex"), preparedHex, zone);
    });
  }
});

test("#273: FROM_TZ(?, '+00:00') labels the UTC fields of a Date as UTC on the literal path", () => {
  for (const zone of ZONES) {
    withTZ(zone, () => {
      assert.equal(
        interpolateParams("INSERT INTO t (at) VALUES (FROM_TZ(?, '+00:00'))", [SENT], true),
        "INSERT INTO t (at) VALUES (FROM_TZ(DATETIME'2025-06-14 23:30:45.678', '+00:00'))",
        zone,
      );
    });
  }
});

// #281: zoned(date) sends a Date as the instant it is, a DATETIMETZ of its UTC
// fields at +00:00, so a zone-aware column keeps it in any session zone. Live
// evidence is in the #281 block of tests/integration.test.ts.

test("#281: zoned() is a DATETIMETZ of the UTC fields at +00:00 on the literal path, under every TZ", () => {
  for (const zone of ZONES) {
    withTZ(zone, () => {
      const param = zoned(SENT);
      assert.equal(formatValue(param, true), "DATETIMETZ'2025-06-14 23:30:45.678 +00:00'", zone);
      assert.equal(formatValue(param, false), "DATETIMETZ'2025-06-14 23:30:45.678 +00:00'", zone);
      assert.equal(
        interpolateParams("INSERT INTO t (at, d) VALUES (?, ?)", [param, SENT], true),
        "INSERT INTO t (at, d) VALUES (DATETIMETZ'2025-06-14 23:30:45.678 +00:00', " +
          "DATETIME'2025-06-14 23:30:45.678')",
        zone,
      );
    });
  }
});

test("#281: zoned() is a DATETIMETZ bind of the UTC fields and the zone text without a NUL", () => {
  // JDBC UOutputBuffer.addDatetimetz; CAS net_arg_get_datetimetz reads the
  // zone length as the value length less the 14 bytes of the fields.
  const preparedHex =
    "00000001" + // type length
    "1f" + // CUBRIDDataType.DATETIMETZ, 31
    "00000014" + // value length, 14 + 6
    shorts(...STORED.datetime).toString("hex") +
    Buffer.from("+00:00", "latin1").toString("hex");
  for (const zone of ZONES) {
    withTZ(zone, () => {
      const binds = encodePreparedParams([zoned(SENT)]);
      assert.equal(binds.count, 1, zone);
      assert.equal(binds.bytes.toString("hex"), preparedHex, zone);
    });
  }
  // A plain Date next to it keeps its DATETIME bind.
  const mixed = encodePreparedParams([SENT, zoned(SENT), null]);
  assert.equal(mixed.count, 3);
  assert.equal(
    mixed.bytes.toString("hex"),
    "0000000116" +
      "0000000e" +
      shorts(...STORED.datetime).toString("hex") +
      preparedHex +
      "0000000100" + // CUBRIDDataType.NULL
      "00000000",
  );
});

test("#281: zoned() reads the time when called, is frozen, and keeps the epoch and the year range ends", () => {
  const date = new Date(SENT.getTime());
  const param = zoned(date);
  date.setTime(0);
  assert.equal(formatValue(param, true), "DATETIMETZ'2025-06-14 23:30:45.678 +00:00'");
  assert.ok(Object.isFrozen(param));
  assert.deepEqual({ ...param }, { kind: "zoned", time: SENT.getTime() });
  assert.equal(formatValue(zoned(new Date(0)), true), "DATETIMETZ'1970-01-01 00:00:00.000 +00:00'");
  assert.equal(
    formatValue(zoned(new Date("9999-12-31T23:59:59.999Z")), true),
    "DATETIMETZ'9999-12-31 23:59:59.999 +00:00'",
  );
  // The year is not zero-padded, as for a plain Date; the server reads it.
  assert.equal(
    formatValue(zoned(new Date("0001-01-01T00:00:00.000Z")), true),
    "DATETIMETZ'1-01-01 00:00:00.000 +00:00'",
  );
  assert.equal(
    encodePreparedParams([zoned(new Date("0001-01-01T00:00:00.000Z"))]).bytes.toString("hex"),
    `000000011f00000014${shorts(1, 1, 1, 0, 0, 0, 0).toString("hex")}2b30303a3030`,
  );
});

test("#281: zoned() refuses what is not a valid Date in the DATETIMETZ years", () => {
  const notDates: unknown[] = [undefined, null, "2025-06-14", SENT.getTime(), {}, zoned(SENT)];
  for (const value of notDates) {
    assert.throws(() => zoned(value as Date), {
      name: "TypeError",
      message: "zoned() takes a Date",
    });
  }
  assert.throws(() => zoned(new Date(Number.NaN)), {
    name: "TypeError",
    message: "zoned() takes a valid Date, not an invalid one",
  });
  for (const iso of ["0000-12-31T23:59:59.999Z", "+010000-01-01T00:00:00.000Z"]) {
    assert.throws(() => zoned(new Date(iso)), {
      name: "TypeError",
      message: "zoned() takes a Date whose UTC year is from 0001 to 9999",
    });
  }
});

test("#281: only a value zoned() made is a zoned parameter, recognized across builds by a registered symbol", () => {
  // A look-alike without the brand stays an unsupported object on both paths.
  const lookAlike = { kind: "zoned", time: SENT.getTime() };
  assert.equal(isZonedParam(lookAlike), false);
  assert.throws(() => formatValue(lookAlike, true), /unsupported parameter type: object/);
  assert.throws(() => encodePreparedParams([lookAlike]), /unsupported prepared parameter type/);
  // The ESM and CommonJS builds share the brand through the symbol registry.
  const otherBuild = Object.defineProperty(
    { kind: "zoned", time: SENT.getTime() },
    Symbol.for("cubrid-client.ZonedParam"),
    { value: true },
  );
  assert.equal(isZonedParam(otherBuild), true);
  // A branded value with a time zoned() would refuse is refused on both paths.
  for (const time of [Number.NaN, Date.UTC(10000, 0, 1)]) {
    const forged = Object.defineProperty(
      { kind: "zoned", time },
      Symbol.for("cubrid-client.ZonedParam"),
      { value: true },
    );
    assert.throws(() => formatValue(forged, true), /DATETIMETZ years 0001 to 9999/);
    assert.throws(() => encodePreparedParams([forged]), /DATETIMETZ years 0001 to 9999/);
  }
});

test("#281: the package exports zoned()", async () => {
  const entry = await import("../src/index.js");
  assert.equal(entry.zoned, zoned);
});
