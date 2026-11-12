# ADR 0010: Read plain date and time values as UTC by default in 2.0, never in 1.x

- **Status:** Proposed
- **Date:** 2026-11-12
- **Decision scope:** the default of `ClientOptions.timezone`, how DATE, TIME, TIMESTAMP and DATETIME decode to `Date`, what a `Date` round trip promises, and how 2.0 migrates applications that rely on the 1.x local reading
- **Issue:** [#250](https://github.com/cubrid-lab/cubrid-client/issues/250)
- **Prerequisites:** [ADR 0001](0001-release-governance.md) (SemVer), [API stability](../API_STABILITY.md) ([#132](https://github.com/cubrid-lab/cubrid-client/issues/132)), the `timezone` option ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113), PR [#233](https://github.com/cubrid-lab/cubrid-client/pull/233))

## Context

The client writes and reads plain temporal values in different zones.

- **Writes are UTC.** A `Date` parameter is sent as its UTC fields, as the
  literal `DATETIME'YYYY-MM-DD HH:MM:SS.mmm'` (`formatValue()` in
  `src/protocol/protocol.ts`) or as a DATETIME prepared parameter
  (`writePreparedDate()`). Both paths always send DATETIME, whatever the column.
- **Reads are local by default.** `PacketReader.toDate()` in
  `src/protocol/packet-reader.ts` builds the `Date` from the fields in the
  Node.js process zone unless the client was created with `timezone: "utc"`.
  The option exists since #113; `"local"` is the default and the 1.x contract.
- **Zone-aware types are separate.** TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ and
  DATETIMELTZ decode to a frozen `ZonedDateTime` with the server's fields and
  zone text (`readZonedDateTime()`, [#204](https://github.com/cubrid-lab/cubrid-client/issues/204)),
  never to a `Date`, and the `timezone` option does not touch them.

So under the default a `Date` written and read back is moved by the process
zone's offset: 9 hours early under `TZ=Asia/Seoul`, 7 hours late under
`TZ=America/Los_Angeles` in summer, unchanged under `TZ=UTC`. The same stored
row is a different instant on each host.

Evidence, offline and against cubrid/cubrid:11.4 (fixtures in
`tests/fixtures/temporal-zones.ts`, tests in `tests/timezone.test.ts` and the
#250 block of `tests/integration.test.ts`):

| Type | Stored from `Date.UTC(2025, 5, 14, 23, 30, 45, 678)` | Default read, `TZ=Asia/Seoul` | `"utc"` read, any `TZ` |
| --- | --- | --- | --- |
| DATETIME | `2025-06-14 23:30:45.678` | `2025-06-14T14:30:45.678Z` | `2025-06-14T23:30:45.678Z` (the instant sent) |
| TIMESTAMP | `2025-06-14 23:30:45` | `2025-06-14T14:30:45.000Z` | `2025-06-14T23:30:45.000Z` (seconds kept) |
| DATE | `2025-06-14` | `2025-06-13T15:00:00.000Z` | `2025-06-14T00:00:00.000Z` |
| TIME | `23:30:45` | `1970-01-01T14:30:45.000Z` | `1970-01-01T23:30:45.000Z` |

A value without a zone cannot fully encode an instant, in either mode:

- **DATE and TIME** keep only fields. A DATE has no time of day and a TIME no
  date, so the `Date` they decode to is a convention (midnight; 1970-01-01), not
  the instant written. A DATE is the UTC day of the `Date` sent:
  `new Date(2025, 5, 15)` built under `TZ=Asia/Seoul` is 2025-06-14T15:00Z and
  stores **2025-06-14**. Both modes read that back; only a `Date.UTC(...)` date
  survives unchanged.
- **DATETIME** keeps the UTC fields to the millisecond, so with `"utc"` a `Date`
  between years 1 and 9999 round-trips to the same instant. It is still a
  wall-clock value: rows written by other clients, by `SYSDATETIME` or by
  `NOW()` hold the server's or that client's local fields, not UTC.
- **TIMESTAMP** has no milliseconds, and the server converts it in the
  **session** zone. In a session on America/Los_Angeles the two instants of the
  repeated hour, 2026-11-01 08:30Z and 09:30Z, both read back as
  `2026-11-01 01:30:00`, and a time in the skipped hour (2026-03-08 02:30) is
  refused with `Invalid utime` or a data overflow. In a UTC session neither
  happens.
- **DST in the process zone.** With `"local"`, fields that fall in a gap are
  moved forward by JavaScript (02:30 becomes 03:30 PDT) and fields in an overlap
  become the earlier instant (PDT). `"utc"` has no gaps or overlaps and keeps
  every field.
- **Zone-aware columns** keep the zone, but a `Date` parameter written to one is
  a zone-less DATETIME, so the server attaches the **session** zone to its UTC
  fields. Under `SET TIME ZONE 'Asia/Seoul'` the stored DATETIMETZ is
  `2025-06-14 23:30:45.678 Asia/Seoul KST`, nine hours before the `Date` sent.
  The `timezone` option is not involved: it is a write-side problem.

The internal `encodeBindParams()` helper in `src/protocol/protocol.ts` still
writes local fields. No client path calls it and the package does not export it,
so it does not affect callers; it should be aligned or removed as an internal
cleanup, not as part of this decision.

## Decision

1. **No change in 1.x.** `timezone` keeps defaulting to `"local"` for every 1.x
   release, as [API stability](../API_STABILITY.md) requires: changing the
   default changes the value every existing query returns, so it is a MAJOR
   change even though no type changes. 1.x documents the asymmetry (README,
   `docs/TYPES.md`) and recommends `timezone: "utc"` to new code.
2. **2.0 defaults to `"utc"`.** Leaving `timezone` unset decodes DATE, TIME,
   TIMESTAMP and DATETIME fields as UTC, the zone `Date` parameters are written
   in. The type stays `"local" | "utc"`.
3. **`"local"` stays available in 2.0**, as an explicit setting with the 1.x
   meaning. It is not deprecated by this decision; removing it would need its own
   ADR and MAJOR.
4. **What 2.0 promises, per type, and nothing more:**

   | Type | 2.0 default (`"utc"`) promise |
   | --- | --- |
   | DATETIME | A `Date` in years 1 to 9999 written and read back is the same instant, to the millisecond, on every host |
   | TIMESTAMP | The same instant to the second while the session zone is UTC or has no transition at that value; otherwise the server's conversion applies (see Context) |
   | DATE | The UTC day of the `Date` written, read back as UTC midnight. Not the instant written |
   | TIME | The UTC time of day of the `Date` written, read back on 1970-01-01 UTC. Not the instant written |
   | TIMESTAMPTZ, DATETIMETZ, TIMESTAMPLTZ, DATETIMELTZ | Unchanged: `ZonedDateTime` with the server's fields and zone, no `Date` |

   The documentation must not claim a universal round-trip identity.
5. **Separate from the default change**, tracked as their own issues and
   classified on their own:
   - a `Date` written to a zone-aware column takes the session zone (Context);
   - the unused local-field `encodeBindParams()` helper.

### Breaking change versus bug fix

| Change | Class | Release |
| --- | --- | --- |
| Default `timezone` from `"local"` to `"utc"` | **Breaking default change.** Every DATE/TIME/TIMESTAMP/DATETIME `Date` changes instant on a non-UTC host; the code still compiles | 2.0 MAJOR only, with notice in a prior 1.x release |
| README and `docs/TYPES.md` warnings, this ADR, characterization tests | Documentation | Any 1.x |
| A `Date` sent to a zone-aware column labelled with the session zone instead of UTC | **Bug fix candidate**: the stored instant is wrong whenever the session zone is not UTC. The fix changes what is stored, so its SemVer level is classified in its own issue under API stability, not assumed to be a PATCH | Its own issue; may land in 1.x if it keeps DATETIME, DATE, TIME and TIMESTAMP columns unchanged |
| Align or remove `encodeBindParams()` | Internal cleanup; no public behavior | Any |
| Refusing or warning on local-mode DST gaps and overlaps | Not proposed. In `"local"` mode it would change 1.x results; `"utc"` has neither | None |

## Migration

**In 1.x, before 2.0:**

1. A 1.x MINOR release note announces the 2.0 default and links this ADR. No
   runtime warning is emitted (see Alternatives).
2. Applications choose explicitly, which also makes them immune to the 2.0 flip:
   - code that intentionally reads **local wall-clock** fields (`getHours()`,
     `getDate()`, formatting with the host zone) sets `timezone: "local"` now;
   - all other code sets `timezone: "utc"` now and tests on a non-UTC `TZ`.

**Moving an application from local to UTC reads:**

- Read fields with `getUTCFullYear()`, `getUTCHours()` and so on, or format with
  `timeZone: "UTC"`; local getters show the host-zone rendering of the instant.
- Build date-only and wall-clock parameters with `Date.UTC(...)`, not
  `new Date(y, m, d)`, so the DATE written is the intended day in every zone.
- Data **written by other clients or by SQL** (`SYSDATETIME`, `NOW()`,
  `SYSTIMESTAMP`, a JDBC application on a KST host) holds that writer's local
  wall-clock. `"utc"` reads it as UTC, so it moves by that zone's offset. Either
  keep `timezone: "local"` with the process `TZ` set to the writer's zone, convert
  in SQL (for example `CAST(col AS DATETIMETZ)` or `TO_CHAR(col)`), or store new
  values in a zone-aware column.
- A host already on `TZ=UTC` reads exactly the same instants in both modes; for
  it the 2.0 change is invisible.

**In 2.0:** the 2.0 release note and migration guide show the one-line opt-out
(`timezone: "local"`) first, then the steps above.

## Alternatives considered

- **Keep `"local"` as the default forever.** Rejected: the default is the only
  configuration where the client's own write and read disagree, so a correct
  round trip depends on the deployment host's `TZ`, which containers and CI often
  set differently from developer machines.
- **Change the default in a 1.x MINOR.** Rejected by API stability: npm `^1.x`
  ranges would silently change every temporal value read.
- **Write local fields instead, to match the 1.x reads.** Rejected: it changes
  what is stored for every existing writer, makes stored data depend on the
  writing host's `TZ`, and moves the DST problems to the write side.
- **Remove `"local"` in 2.0.** Rejected for now: applications that consume
  wall-clock data written by local-time clients need it, and keeping it makes
  migration one line.
- **Warn at runtime in 1.x when `timezone` is unset.** Deferred: every 1.x
  client that has not set the option would log, including those on UTC hosts
  that see no change. Documentation and release notes come first; a logger-level
  notice can be reconsidered before 2.0.
- **Decode plain types to strings or `Temporal.PlainDateTime`.** Not now: it
  changes the result type, `Temporal` is not available on every supported Node.js
  line, and it is a larger API decision than a default. Could be an opt-in later.

## Consequences and trade-offs

- 2.0 removes the host-dependent read for the common case of a client that writes
  and reads its own DATETIME values; the fixtures become the same on every host.
- Applications that read wall-clock data written by local-time writers must set
  `timezone: "local"` or convert in SQL when moving to 2.0. That cost is the
  reason this is MAJOR-only and announced in advance.
- DATE and TIME stay conventions, not instants, in both modes; that is a property
  of the SQL types, documented rather than fixed.
- TIMESTAMP stays subject to the server session zone in both modes.

## Verification / acceptance criteria

- [x] Offline fixtures under `TZ=UTC`, `Asia/Seoul` and `America/Los_Angeles`
  characterize the 1.x default and the proposed 2.0 default
  (`tests/timezone.test.ts`, `tests/fixtures/temporal-zones.ts`).
- [x] The same fixtures pass against a live CUBRID 11.4 broker, including the DST
  overlap of a TIMESTAMP and a `Date` written to a DATETIMETZ in a non-UTC
  session (`tests/integration.test.ts`, #250 block), with no skips. Verified on
  11.4 only so far; the live CI matrix runs them on 10.2, 11.0, 11.2 and 11.4.
- [x] README and `docs/TYPES.md` warn about the 1.x default before the first
  `Date` example, with a `timezone: "utc"` snippet.
- [ ] Maintainer acceptance of this ADR in a reviewed PR.
- [ ] Before 2.0: a 1.x release note announcing the change; the issue for the
  zone-aware write; in the 2.0 PR, the fixtures' "default" expectations move to
  `UTC_DECODED` and an explicit `"local"` test keeps `LOCAL_DECODED`.

## References

- `src/protocol/packet-reader.ts` (`toDate()`, `localDate()`, `utcDate()`)
- `src/protocol/protocol.ts` (`formatValue()`, `writePreparedDate()`, `readZonedDateTime()`)
- `src/types/client.ts` (`ClientOptions.timezone`), `src/types/zoned-date-time.ts`
- [Date and time values](../TYPES.md#date-and-time-values), [timezone-aware values](../TYPES.md#timezone-aware-values)
- Issues [#113](https://github.com/cubrid-lab/cubrid-client/issues/113), [#132](https://github.com/cubrid-lab/cubrid-client/issues/132), [#204](https://github.com/cubrid-lab/cubrid-client/issues/204), [#250](https://github.com/cubrid-lab/cubrid-client/issues/250)
