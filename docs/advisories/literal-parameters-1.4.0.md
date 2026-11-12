# Upgrade advisory: literal parameters before 1.4.0

**Upgrade to `cubrid-client@1.4.0` or later.** In every version before 1.4.0,
a negative number passed as a parameter right after a minus sign can silently
return wrong values. In 0.2.0 through 1.3.0 it can also make a scoped `UPDATE`
change every row, or write wrong values.
Version 1.4.0 fixes this ([#242](https://github.com/cubrid-lab/cubrid-client/issues/242),
[#243](https://github.com/cubrid-lab/cubrid-client/issues/243), PR
[#258](https://github.com/cubrid-lab/cubrid-client/pull/258)).

Tracking issue: [#290](https://github.com/cubrid-lab/cubrid-client/issues/290).

## Who is affected

The problems are in how the client writes parameter values into the SQL text.
That is `query()` in every version before 1.4.0, and in 1.3.0 also
`execute()`, `queryResult()` and `stream()`, including their transaction and
pool forms. They only matter when your SQL has one of the patterns below.

- **Negative number after a minus sign.** In `bal-?` with the value `-1`, older
  versions wrote `bal--1`. CUBRID reads `--` as the start of a comment, so the
  rest of that line is ignored, with no error.
  - If the `WHERE` clause is on the same line, it is dropped:
    `UPDATE t SET flag = 1, bal = bal-? WHERE id = ?` changed all three rows
    instead of one.
  - If the rest of the statement is on the next line, the right rows are
    changed but the subtraction is lost: `bal` was written back unchanged.
    `SELECT bal-? AS adj` likewise returned the unadjusted value, under the
    column name `bal` instead of `adj`.
  - Writing `bal - ?` with a space between the `-` and the `?`, or passing a
    positive number, avoids it. `bal -?` is still affected.
- **A `?` inside a `//` comment.** Versions up to 1.3.0 treat a `?` inside a
  `//` comment as a placeholder and fill it in. From 1.2.0, string values keep
  their newlines (the fix for C3 below), so a value containing a newline ends
  the comment and the rest of the value is read as SQL. 1.1.0 and earlier
  rewrote newlines as the two characters `\n` on a default server, so they did
  not reach this case. This needs a `?` inside a comment in your own SQL text.

String values containing quotes were escaped correctly in every tested version.

`queryPrepared()`, `queryResultPrepared()` and `executePrepared()` (added in
1.3.0) send values as typed binds and never write them into the SQL text, so
they are not affected.

## Results by version

Each published npm package was installed from the registry and run with
[`scripts/audit-literal-params.mjs`](../../scripts/audit-literal-params.mjs)
against a disposable CUBRID 11.4.6 database (default
`no_backslash_escapes=yes`). The script reads the rows back from the database
rather than inspecting the generated SQL. Versions 0.x and 1.0.0 hand values to
`node-cubrid`, which was tested at 11.0.0.

| Case | 0.1.0 | 0.2.0 | 1.0.0 | 1.1.0 | 1.2.0 | 1.3.0 | 1.4.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 `bal-?` with `-1` in `UPDATE ... WHERE id = ?` | n/a¹ | **all rows** | **all rows** | **all rows** | **all rows** | **all rows** | 1 row |
| C1b same with `-1n` | n/a¹ | error | error | **all rows** | **all rows** | **all rows** | 1 row |
| C1c `DELETE ... WHERE bal-? > 0 AND id = ?` | n/a¹ | error | error | error | error | error | 1 row |
| C1d C1 with `WHERE` on the next line | n/a¹ | *value lost* | *value lost* | *value lost* | *value lost* | *value lost* | correct |
| C1e `SELECT bal-? AS adj` with `-1` | *wrong value* | *wrong value* | *wrong value* | *wrong value* | *wrong value* | *wrong value* | correct |
| C2 string containing a quote and `--` | n/a¹ | safe | safe | safe | safe | safe | safe |
| C2b string containing a backslash, a quote and `--` | n/a¹ | safe | safe | safe | safe | safe | safe |
| C3 string with `\` and a newline stored unchanged | n/a¹ | altered | altered | altered | yes | yes | yes |
| C4 `'a\'` followed by `?` | works | works | works | error | error | error | works |
| C5 `?` inside `//` comment, value with a newline | n/a¹ | 1 row | 1 row | 1 row | **all rows** | **all rows** | refused |
| C6 more values than placeholders | accepted | accepted | accepted | accepted | accepted | accepted | refused |
| C7 `?` inside a `[bracket]` identifier | filled in | filled in | filled in | filled in | filled in | filled in | refused |

¹ 0.1.0 cannot run `UPDATE`, `DELETE`, `INSERT` or DDL through `query()` at
all, so these cases do not apply. Its table was created and read back with
1.4.0 (`node scripts/audit-literal-params.mjs ./v0.1.0 ./v1.4.0`), and its
`SELECT` cases ran through 0.1.0.

**Bold** marks a statement that changed rows its `WHERE` clause should have
excluded. *Italics* mark a statement that succeeded with a wrong result and no
error. "Altered" (C3) means 0.2.0 to 1.1.0 stored a backslash as two backslashes
and a newline as the characters `\n` on a default server; data written through
those versions may need checking. "Refused" means 1.4.0 raised a `QueryError`
before sending any SQL because the value count does not match the
placeholders. In C5 and C7 that is because it does not count a `?` inside a
comment or a quoted identifier as a placeholder.

Summary:

| Version | Status |
| --- | --- |
| 0.1.0 | **Affected** (C1e, wrong `SELECT` values). It cannot run `UPDATE` or `DELETE`, so the `WHERE`-dropping cases do not apply. |
| 0.2.0, 1.0.0, 1.1.0 | **Affected** (C1, C1d, C1e). |
| 1.2.0, 1.3.0 | **Affected** (C1, C1d, C1e, C5). |
| 1.4.0 | Fixed. Tested from the published npm artifact. |

No CVE has been assigned. These results show that SQL written in the patterns
above can change more rows than intended or produce wrong values. They do not show that a particular
application is exploitable; that depends on its SQL and on where the values
come from.

## What to do

1. Upgrade to `cubrid-client@1.4.0` or later. The
   [1.4.0 release notes](../releases/v1.4.0.md) list the other behaviour
   changes in that release.
2. If you cannot upgrade yet, search your SQL for a `-` directly before `?`, and
   for `?` inside comments, or switch those statements to `executePrepared()` /
   `queryPrepared()` (1.3.0).
3. 1.4.0 refuses, before sending any SQL, some calls that older versions
   accepted. Fix the call rather than working around the error:
   - a value count that does not match the placeholders (a `?` inside a
     comment, string or quoted identifier is not a placeholder);
   - `NaN` and `Infinity`, which older versions sent as bare words;
   - an invalid `Date`;
   - objects, arrays and other values that are not a supported parameter type,
     which older versions sent as text such as `'[object Object]'`;
   - a double-quoted span containing a backslash, when it makes the placeholder
     positions ambiguous.

## Verifying 1.4.0

- npm `cubrid-client@1.4.0`: `gitHead`
  `a92003e9cd289963325f30add36ba8f563c77a11`, which is the `v1.4.0` tag, with
  SLSA provenance from
  [publish run 43188077532](https://github.com/cubrid-lab/cubrid-client/actions/runs/43188077532).
- Integrity of the tested tarball:
  `sha512-LLj+KbdQWPXxepdA06pc0U3Wv46dlZOCjwZtzg1I8Wjqkx9E53hUIOAQ03YRPj0PjnwC8UR2bNuxqQpzOIDDRw==`.
  Check it with `npm view cubrid-client@1.4.0 dist.integrity`, and check the
  provenance with `npm audit signatures` in a project that installs it.

## npm deprecation (proposed, needs maintainer approval)

No older version is deprecated on npm yet. Proposed commands, to be run by a
maintainer with publish rights only after review (add `--otp=<code>` if the
account uses two-factor authentication):

```sh
npm deprecate 'cubrid-client@>=0.2.0 <1.4.0' 'Upgrade to >=1.4.0: a negative number after a minus sign in a parameter can drop a WHERE clause or give wrong values. See https://github.com/cubrid-lab/cubrid-client/blob/main/docs/advisories/literal-parameters-1.4.0.md'
npm deprecate 'cubrid-client@0.1.0' 'Upgrade to >=1.4.0: a negative number after a minus sign in a parameter can give wrong SELECT values. See https://github.com/cubrid-lab/cubrid-client/blob/main/docs/advisories/literal-parameters-1.4.0.md'
```

0.1.0 gets its own message because it cannot run `UPDATE` or `DELETE`, so the
`WHERE`-dropping cases do not apply to it.
Check the result with `npm view cubrid-client@1.3.0 deprecated`. Deprecation
makes `npm install` print a warning. It does not remove or change the published
packages.
