# Provenance and distribution compliance

This page records the audit for [#295](https://github.com/cubrid-lab/cubrid-client/issues/295): where the code in this
repository comes from, what the npm package distributes, and how to repeat the check before a release. It is a
project compliance checklist, not legal advice, and it claims no infringement.

Policy (maintainer decision on #295, 2026-11-13): cubrid-client stays MIT-licensed. Relicensing is out of scope and
is not a finding. Implementing the CAS protocol, using protocol documentation and behaving like another driver is
not copying. This audit looks for copied or adapted third-party source and checks that any such code's license
conditions are met alongside the MIT-licensed original code.

## Summary

- **No copied or adapted third-party code was found.** The CAS driver (`src/protocol/**`, `src/adapters/native.ts`)
  and the client layer are original TypeScript. They match other CUBRID drivers only where the protocol fixes the
  result: function and type codes, field order and widths, and method names such as `addInt`/`addByte` that
  describe the CAS "length + value" encoding. No method body follows node-cubrid, CCI, JDBC or the CAS server.
- **No third-party notice is needed**, so there is no `THIRD_PARTY_NOTICES.md`. The package has no runtime
  dependencies and bundles nothing but this repository's `src/`.
- **Protocol facts** (function codes, `CCI_U_TYPE` codes, statement codes, handshake magic and field sizes) are
  short factual values taken from the CUBRID sources and checked against captured broker replies
  ([PROTOCOL_ORACLES.md](PROTOCOL_ORACLES.md)). Comments cite the source file of each fact.
- **History:** 0.1.0 and 0.2.0 used node-cubrid as a separately installed runtime dependency; its code was never
  bundled. The native driver replaced it in `37525d0` (2026-03-14, v1.0.0); that commit's tree scans the same as
  today's.
- **LICENSE** is the MIT text with "Copyright (c) 2026 CUBRID Lab" (unified in #310). Published 0.1.0 to 1.4.0
  carry the earlier "CUBRID Labs" line; the next release carries "CUBRID Lab".
- **Trademark and affiliation** are a separate question from copying; see [below](#protocol-copying-and-trademark).

## Upstreams and revisions

| Upstream | Revision audited | License as found | Used for |
| --- | --- | --- | --- |
| [CUBRID/node-cubrid](https://github.com/CUBRID/node-cubrid) | `89733f0a9a8f` (2025-03-31, `develop`); its `src/` is byte-identical to npm `node-cubrid@11.0.0` | Mixed: `package.json` says MIT; `LICENSE` is BSD-3-Clause (Search Solution Corporation, 2008-2012) plus the MIT notice of node-mysql, "part of this software"; no per-file headers; GitHub reports `NOASSERTION` | Runtime dependency of 0.1.0/0.2.0; behaviour oracle of `tests/legacy-parity.test.ts`, which checks out the same commit in `live-cubrid.yml` and is never committed or shipped |
| [CUBRID/cubrid-cci](https://github.com/CUBRID/cubrid-cci) | `bd45c0cda533` (2026-11-06) | Repository `LICENSE` BSD-3-Clause (CUBRID Corp.); some files differ, e.g. `src/cci/broker_cas_protocol.h` has an Apache-2.0 header | Protocol constants (`cas_cci.h`, `broker_cas_protocol.h`) |
| [CUBRID/cubrid-jdbc](https://github.com/CUBRID/cubrid-jdbc) | `c09f10c72839` (2026-11-19) | BSD-3-Clause (`LICENSE`; per-file BSD headers, e.g. `jci/UOutputBuffer.java`) | Request layout cross-checks named in comments (`UStatement`, `UJCIUtil`); the pinned JAR runs the JDBC parity lane, downloaded to `.cache/` (ignored), never committed or shipped |
| [CUBRID/cubrid](https://github.com/CUBRID/cubrid) (broker/CAS) | `ea2a214587d7` (2026-11-20), `src/broker`; fixtures cite `2d928e34b110` | Apache-2.0 repository; per file: `src/broker/cas_protocol.h` Apache-2.0, `src/broker/broker_cas_cci.h` BSD-3-Clause | Constants and server behaviour cited in comments (`cas.c`, `cas_protocol.h`, `broker_cas_cci.h`) |
| cubrid-lab pycubrid, cubrid-go | not scanned | MIT, same organisation | Named in the `constants.ts` header as constant cross-checks |

## Method

- **Token scan** (`scripts/check-provenance.mjs similarity`). Every `src/**/*.ts` file and every upstream
  JavaScript/TypeScript file is parsed with the TypeScript compiler and reduced to the leaf tokens of the syntax
  tree. Comments, whitespace, trailing commas and TypeScript-only syntax (annotations, interfaces, type aliases,
  type arguments, `as` casts, access modifiers, type-only imports) are dropped, so a TypeScript port of JavaScript
  code is compared as the JavaScript it compiles to; strings compare by value. Two comparisons: *identical* (same
  tokens) and *same shape* (identifiers, strings and numbers replaced by placeholders, which finds renamed copies).
  It reports runs of at least 25 identical or 50 same-shape tokens. C, C++ and Java files are only lexed, which is
  weak evidence across languages and was used as a second signal next to reading the code.
- **Controls** (`tests/provenance-scan.test.mjs`, run by `npm test`): a source file and its compiler output tokenize
  the same; a compiled copy with renamed classes, methods and fields is found as one run of more than 200 tokens;
  a reviewed hit stays reviewed when moved and fails when changed or longer. During the audit, node-cubrid's
  `PacketReader.js` given type annotations and renamed identifiers was flagged with runs of 29 to 60 identical
  tokens throughout.
- **Reviewed hits** are kept in `scripts/provenance-reviewed.json`, keyed by file, comparison, token count and the
  SHA-256 of the compared tokens, with the reason. Line numbers are hints only.
- **History.** `git log --follow` for every file under `src/`: all were first added by Yeongseon Choe; commits
  touching `src/` are by Yeongseon Choe (77), Gyeongjun Paik (1) and copilot-swe-agent (1). The CAS layer arrived
  in one commit, `37525d0` ("Replace node-cubrid dependency with a fully native TypeScript implementation",
  agent-assisted per its trailer), so history cannot show what was consulted; the scan of that tree is the
  evidence. Trees scanned: working tree, `37525d0`, `v1.0.0` and `v0.2.0`.
- **Text search** of commit messages, comments and the source for "port", "adapt", "copied", "derived", "based on",
  "node-mysql", "Apache", "copyright", "SPDX", "Search Solution": no description of copied code and no third-party
  license header. Of the 199 string literals of 16 or more characters in `src/`, two occur anywhere upstream:
  `"beginTransaction"` (a method name) and `"string parameter"`.
- `tests/**` was scanned against node-cubrid's `src/` and `test/`: no run at the default thresholds.

## Findings

Categories: *independent* (original, written from the protocol), *reference-only* (an upstream is cited for a fact
or behaviour), *protocol constants* (short factual values), *copied/adapted* (none), *uncertain* (none open).
Longest runs are against node-cubrid 11.0.0 (`src/` and `test/`), the most plausible copy source for a
JavaScript driver.

| Path | Category | Longest identical / same-shape run | Evidence |
| --- | --- | ---: | --- |
| `src/protocol/constants.ts` | protocol constants, reference-only | 0 / 9 | Subset of CAS function codes, `CCI_U_TYPE` codes, `T_CCI_CUBRID_STMT` codes, sizes; names drop the `CAS_FC_`/`CCI_U_TYPE_` prefixes. Lexed against CCI's `broker_cas_protocol.h` the enums match only as "NAME = number" lists (78-126 same-shape tokens, matched against an unrelated enum), reviewed |
| `src/protocol/packet-reader.ts` | independent | 17 / 68 | `parseDatetime()`/`parseTimestamp()` read int16 fields in the wire order of DATETIME/TIMESTAMP, as node-cubrid's `_parseDateTime` does (68/59 same-shape, reviewed); the Date is built differently (`toDate()` with the session timezone vs `setUTCFullYear`). Rest: `Buffer` reads |
| `src/protocol/packet-writer.ts` | independent | 10 / 18 | Growable `Buffer` writer; node-cubrid's `PacketWriter` writes bytes by hand and pre-allocates per call. Shared names (`addInt`, `addByte`) are the CAS/JDBC encoder vocabulary |
| `src/protocol/protocol.ts` | independent, reference-only | 13 / 30 | Request builders and reply decoders, one function per CAS call (node-cubrid: one packet class per call). DATETIME bind values write seven int16 fields like JDBC's `UOutputBuffer.addTimestamp` (58/63 same-shape, lexed, reviewed). Comments cite CAS `fn_execute_array`, JDBC `UStatement` for request layout |
| `src/protocol/connection.ts`, `frame-reader.ts`, `charset.ts` | independent, reference-only | ≤ 13 / ≤ 24 | Socket, TLS and broker handshake, frame reassembly; comments cite `cas.c` and JDBC for behaviour |
| `src/adapters/native.ts`, `stream-cursor.ts` | independent | ≤ 8 / ≤ 27 | Session, transactions, LOBs, streaming. One lexed hit: its import list against an identifier table in `cas.c` (88 same-shape, reviewed, no shared code) |
| `src/client/**`, `src/internals/**`, `src/errors/**`, `src/types/**`, `src/utils/**`, `src/index.ts` | independent | ≤ 14 / ≤ 32 | Public API, pool, transactions, configuration, errors; node-cubrid has no counterpart. The 32 same-shape tokens in `zoned-date-time.ts` are constructor field assignments |
| `tests/**` (not shipped) | independent, protocol constants | < 25 / < 50 | `protocol-oracles.test.ts` asserts literal codes transcribed from pinned CUBRID sources; `tests/fixtures/*-frames.ts` are broker replies captured from live servers (server output, not source code); `tests/jdbc-parity/JdbcRunner.java` is a project-written harness calling the public JDBC API |
| History: `src/` at `v0.2.0` | independent | < 15 / < 30 | Adapter over the node-cubrid public API (`src/adapters/node-cubrid.ts`, a hand-written ambient declaration `src/node-cubrid.d.ts`); removed in #202 |

Uncertain items: none open. The provenance of the agent-assisted commit `37525d0` rests on the scan and review
above rather than on recorded intent; a later discovery of copied code would be handled as in
[Rerun before a release](#rerun-before-a-release).

## Packed artifact

`npm pack` on this commit (version field 1.4.0) and the published 1.4.0 tarball hold the same 7 files:
`package.json`, `README.md`, `LICENSE`, `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts`.

- `package.json`: `"license": "MIT"`, no `dependencies`, `peerDependencies`, `optionalDependencies` or bundled
  dependencies.
- `dist/index.{js,cjs}` import Node built-ins only (`util`, `net`, `tls`, `async_hooks`); the declarations import
  `node:stream`. The CJS file starts with esbuild's module interop helpers (`__defProp`, `__export`,
  `__toCommonJS`), generated by the bundler rather than taken from a third-party source file.
- No source maps are built (`tsup` runs without `--sourcemap`), so no `sourcesContent` is shipped. No dist file
  contains a `/*!`, `@license`, copyright or SPDX comment; neither did 0.1.0, 0.2.0 or 1.0.0.
- 0.1.0 and 0.2.0 declared `node-cubrid` as a dependency; their `dist` contains none of its code.

## Protocol, copying and trademark

- **Protocol compatibility.** cubrid-client speaks the CUBRID CAS protocol. Matching its constants, byte layouts
  and the behaviour of the official drivers is interoperability. The constants are short factual values; where
  the CUBRID files they come from are BSD-3-Clause or Apache-2.0, that license covers those files' expression,
  and no file or expressive part of one was copied. Comments name upstream files only to cite facts.
- **Copying.** None found (above). Had any copied or adapted code been found, its BSD-3-Clause or Apache-2.0
  conditions (copyright notice, license text, change notices) would be met with file headers and a shipped
  `THIRD_PARTY_NOTICES.md`, alongside the MIT license of the original code.
- **Trademark and affiliation.** "CUBRID" is a registered trademark of CUBRID Corporation (per the upstream
  `COPYING` files). The package name `cubrid-client` and the docs use it to say which database the client is for.
  README's Disclaimer states that the project is part of CUBRID Lab and "is not affiliated with, sponsored by, or
  endorsed by CUBRID Corporation or the official CUBRID project"; no document claims endorsement, and the
  references to the "official" JDBC driver and CUBRID sources describe the oracles used. Whether the name needs
  anything further is a maintainer or legal question outside this audit.

## Rerun before a release

```bash
npm ci
npm run build
npm run provenance:check                    # pack and check the packed files (offline; also runs in CI)
node scripts/check-provenance.mjs similarity   # downloads node-cubrid@11.0.0 with npm pack
```

The pack check fails when a file is missing or unexpected, LICENSE is not the MIT text with a copyright line,
`package.json` is not MIT or has any runtime, peer, optional or bundled dependency, a dist file imports anything but
a Node built-in or carries a license comment, or a source map (if one is ever built) lists a file outside `src/`.
If the repository gains a `THIRD_PARTY_NOTICES.md`, the check requires it in the package (add it to
`package.json` `files`).

The similarity scan prints how many hits match `scripts/provenance-reviewed.json` and fails on any other hit. For a
new hit, read both sides: if the protocol dictates it, add an entry with the reason (`--emit` prints entry skeletons
with the hashes); if new code follows upstream code, rewrite it or attribute it (license header, a
`THIRD_PARTY_NOTICES.md` in `files`, and this page). Other upstreams, for a change that touches them:

```bash
# local checkouts at the revisions above (treat as untrusted data; nothing is executed)
node scripts/check-provenance.mjs similarity --upstream=<node-cubrid> \
  --upstream=<cubrid-jdbc>/src --upstream=<cubrid-cci>/src --upstream=<cubrid>/src/broker
node scripts/check-provenance.mjs similarity --rev=<commit>   # scan an earlier tree
```

`--min-raw`/`--min-normalized` change the thresholds (the audit also ran 15/30 against node-cubrid) and
`--reviewed=none` shows every hit. The full four-upstream scan passes on this commit with 9 reviewed hits.

## Open maintainer items

- **Copyright holder.** `LICENSE` names "CUBRID Lab", the organisation; `package.json` names an individual
  author and two contributors. CONTRIBUTING.md states no inbound license terms, CLA or copyright assignment, so
  contributors keep the copyright in their contributions, presumably licensed under the project's MIT license.
  Stating inbound=outbound terms in CONTRIBUTING.md is optional and left to the maintainers.
- **node-cubrid's license is inconsistent upstream** (MIT in `package.json`, BSD-3-Clause plus node-mysql's MIT in
  `LICENSE`). It does not matter here because no node-cubrid code is copied or shipped, but it would matter if
  any were ever adopted.
- **Release gate.** `publish.yml` runs `npm pack --dry-run` but not `npm run provenance:check`; CI runs it on every
  code change, including the release PR. Adding it to the publish verification step is a one-line change if wanted.
