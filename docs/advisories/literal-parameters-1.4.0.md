# Upgrade advisory: literal parameters before 1.4.0

**Upgrade to `cubrid-client@1.4.0` or later.** Versions 0.2.0 through 1.3.0
can turn a scoped `UPDATE` into one that changes every row when a negative
number is passed as a parameter right after a minus sign. Version 1.4.0 fixes
this ([#242](https://github.com/cubrid-lab/cubrid-client/issues/242),
[#243](https://github.com/cubrid-lab/cubrid-client/issues/243), PR
[#258](https://github.com/cubrid-lab/cubrid-client/pull/258)).

Tracking issue: [#290](https://github.com/cubrid-lab/cubrid-client/issues/290).

## Who is affected

The problems are in how `query()` and `execute()` write parameter values into
the SQL text. They only matter when your SQL has a pattern like the ones below.

- **Negative number after a minus sign.** In `bal-?` with the value `-1`, older
  versions wrote `bal--1`. CUBRID reads `--` as the start of a comment, so the
  rest of the line, including a `WHERE` clause, was dropped. In the test below
  `UPDATE t SET flag = 1, bal = bal-? WHERE id = ?` changed all three rows
  instead of one. Writing `bal - ?` with a space, or passing a positive number,
  avoids it.
- **A `?` inside a `//` comment.** Versions 1.2.0 and 1.3.0 filled in a `?`
  that sat inside a `//` comment. A string value containing a newline then
  ended the comment, and the rest of the value ran as SQL. This needs a `?`
  inside a comment in your own SQL text.

String values containing quotes (`x' OR 1=1 --`) were escaped correctly in
every tested version.

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
| C2 `x' OR 1=1 --` as a string | n/a¹ | safe | safe | safe | safe | safe | safe |
| C3 string with `\` and a newline stored unchanged | n/a¹ | altered | altered | altered | yes | yes | yes |
| C4 `'a\'` followed by `?` | works | works | works | error | error | error | works |
| C5 `?` inside `//` comment, value with a newline | n/a¹ | 1 row | 1 row | 1 row | **all rows** | **all rows** | refused |
| C6 more values than placeholders | accepted | accepted | accepted | accepted | accepted | accepted | refused |
| C7 `?` inside a `[bracket]` identifier | filled in | filled in | filled in | filled in | filled in | filled in | refused |

¹ 0.1.0 cannot run `UPDATE`, `DELETE`, `INSERT` or DDL through `query()` at
all, so these cases could not run. Its `SELECT` path behaved like 0.2.0.

**Bold** marks a statement that changed rows its `WHERE` clause should have
excluded. "Refused" means 1.4.0 raised a `QueryError` before sending any SQL:
it does not count a `?` inside a comment or a quoted identifier as a
placeholder, so the value count no longer matches.

Summary:

| Version | Status |
| --- | --- |
| 0.1.0 | Not confirmed: the fixture cannot run. Upgrade anyway; it is unsupported. |
| 0.2.0, 1.0.0, 1.1.0 | **Affected** (C1). |
| 1.2.0, 1.3.0 | **Affected** (C1, C5). |
| 1.4.0 | Fixed. Tested from the published npm artifact. |

No CVE has been assigned. These results show that SQL written in the patterns
above can change more rows than intended. They do not show that a particular
application is exploitable; that depends on its SQL and on where the values
come from.

## What to do

1. Upgrade to `cubrid-client@1.4.0` or later. The
   [1.4.0 release notes](../releases/v1.4.0.md) list the other behaviour
   changes in that release.
2. If you cannot upgrade yet, search your SQL for a `-` directly before `?`, and
   for `?` inside comments, or switch those statements to `executePrepared()` /
   `queryPrepared()` (1.3.0).
3. 1.4.0 refuses some calls that older versions accepted: a value count that
   does not match the placeholders (a `?` inside a comment, string or quoted
   identifier is not a placeholder), and values that are not a supported
   parameter type. Fix the call rather than working around the error.

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

No older version is deprecated on npm yet. Proposed command, to be run by a
maintainer only after review:

```sh
npm deprecate 'cubrid-client@<1.4.0' 'Upgrade to >=1.4.0: older versions can drop a WHERE clause when a negative number follows a minus sign in query()/execute() parameters. See https://github.com/cubrid-lab/cubrid-client/blob/main/docs/advisories/literal-parameters-1.4.0.md'
```

Deprecation makes `npm install` print a warning. It does not remove or change
the published packages.
