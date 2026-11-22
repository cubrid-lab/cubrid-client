// Packed-consumer declaration check (#309).
//
// Usage: node scripts/check-packed-types.mjs   (run `npm run build` first)
//
// Packs the built package with `npm pack`, installs the tarball's contents as
// node_modules/cubrid-client in temporary consumer projects, and compiles each
// with the repository's TypeScript and `skipLibCheck: false`, so the published
// dist/index.d.ts and dist/index.d.cts are type-checked as a consumer sees them:
//
//   no-node  lib ["es2022"], no DOM lib, no @types/node. The declarations must
//            not need Node's or the DOM's types.
//   dom      lib ["es2022", "dom"], no @types/node. The DOM AbortSignal is accepted.
//   node     lib ["es2022"] with @types/node. A real AbortSignal, Buffer and
//            Readable are accepted, and the types the client hands back are
//            still exactly Buffer and AbortSignal.
//
// Network-free: the tarball has no dependencies and @types/node comes from this
// repository's node_modules. Exits 1 if any consumer fails to compile.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const TSC = require.resolve("typescript/bin/tsc");
const NODE_TYPES = dirname(dirname(require.resolve("@types/node/package.json")));

// Compile-time equality, so a widened or narrowed type fails rather than passes.
const EQUAL =
  "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;\n";

const COMMON = `import {
  blob,
  clob,
  createClient,
  type BlobSource,
  type ClientOptions,
  type CollectionElement,
  type CubridAbortSignal,
  type CubridBytes,
  type QueryOptions,
  type QueryParam,
} from "cubrid-client";

const db = createClient({ host: "localhost", database: "demodb", user: "dba" });
const bytes = new Uint8Array([1, 2, 3]);
blob(bytes);
clob("text");
async function* chunks(): AsyncGenerator<Uint8Array> {
  yield bytes;
}
blob(chunks());
const source: BlobSource = bytes;
void source;
void db.query("SELECT 1");
export type Exported = [ClientOptions, CollectionElement, CubridAbortSignal, CubridBytes, QueryOptions, QueryParam];
`;

const CONSUMERS = {
  "no-node": {
    lib: ["es2022"],
    types: [],
    source: `${COMMON}${EQUAL}
// Without Node's types the bytes type is Uint8Array.
const bytesIsUint8Array: Equal<CubridBytes, Uint8Array> = true;
void bytesIsUint8Array;
declare const signal: CubridAbortSignal;
const options: QueryOptions = { signal };
void options;
if (signal.aborted) throw signal.reason;
// @ts-expect-error a string is not a signal
const wrong: QueryOptions = { signal: "abort" };
void wrong;
`,
  },
  dom: {
    lib: ["es2022", "dom"],
    types: [],
    source: `${COMMON}${EQUAL}
const signalIsDom: Equal<CubridAbortSignal, AbortSignal> = true;
void signalIsDom;
const options: QueryOptions = { signal: new AbortController().signal };
void options;
`,
  },
  node: {
    lib: ["es2022"],
    types: ["node"],
    source: `${COMMON}${EQUAL}import { Readable } from "node:stream";
import type {
  ClobSource,
  CollectionValue,
  LobParam,
  PoolConnectionOptions,
  StreamOptions,
} from "cubrid-client";
import { createPool } from "cubrid-client";

// A real AbortSignal, Buffer and Readable are accepted where they were.
const controller = new AbortController();
const query: QueryOptions = { signal: controller.signal };
const stream: StreamOptions = { signal: AbortSignal.timeout(1000) };
const pooled: PoolConnectionOptions = { signal: controller.signal };
void [query, stream, pooled];
void db.query("SELECT ?", [Buffer.from("x")], { signal: controller.signal });
const pool = createPool({ host: "localhost", database: "demodb", user: "dba" });
void pool.connection(async () => undefined, { signal: controller.signal });
const param: QueryParam = Buffer.from("x");
void param;
blob(Buffer.from("x"));
blob(Readable.from([Buffer.from("x")]));
blob(Readable.from([new Uint8Array([1])]));
clob(Buffer.from("x"));
clob(Readable.from(["x", Buffer.from("y")]));
const clobSource: ClobSource = Readable.from(["x"]);
void clobSource;
const ssl: ClientOptions = {
  host: "localhost",
  database: "demodb",
  user: "dba",
  ssl: { ca: Buffer.from("pem") },
};
void ssl;

// Types the client hands back stay exactly Buffer and AbortSignal.
const bytesIsBuffer: Equal<CubridBytes, Buffer> = true;
const signalIsAbortSignal: Equal<CubridAbortSignal, AbortSignal> = true;
void [bytesIsBuffer, signalIsAbortSignal];
declare const element: Extract<CollectionElement, Uint8Array>;
const buffer: Buffer = element;
void buffer;
declare const collection: CollectionValue;
const first = collection[0];
if (first instanceof Uint8Array) {
  const fromCollection: Buffer = first;
  void fromCollection;
}
declare const lob: LobParam;
if (lob.source instanceof Readable) lob.source.pipe(process.stdout);
// A signal a custom connection receives is a full AbortSignal.
declare const received: QueryOptions;
if (received.signal !== undefined) {
  const full: AbortSignal = received.signal;
  full.onabort = null;
}
const caIsBuffer: Equal<NonNullable<Exclude<ClientOptions["ssl"], boolean | undefined>["ca"]>, string | Buffer> = true;
void caIsBuffer;
`,
  },
};

function pack(dest) {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dest], {
      cwd: REPO,
      encoding: "utf8",
    }),
  );
  execFileSync("tar", ["-xzf", join(dest, packed.filename), "-C", dest]);
  return join(dest, "package");
}

const tmp = mkdtempSync(join(tmpdir(), "packed-types-"));
let failed = false;
try {
  const pkg = pack(tmp);
  for (const [name, { lib, types, source }] of Object.entries(CONSUMERS)) {
    const dir = join(tmp, name);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    execFileSync("cp", ["-R", pkg, join(dir, "node_modules", "cubrid-client")]);
    writeFileSync(join(dir, "index.ts"), source);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "es2022",
            lib,
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: false,
            types,
            typeRoots: types.length > 0 ? [NODE_TYPES] : [],
          },
          // Both declaration files are checked: ESM and CommonJS consumers get one each.
          files: [
            "index.ts",
            "node_modules/cubrid-client/dist/index.d.ts",
            "node_modules/cubrid-client/dist/index.d.cts",
          ],
        },
        null,
        2,
      ),
    );
    const result = spawnSync(process.execPath, [TSC, "-p", dir], { encoding: "utf8" });
    if (result.status === 0) {
      console.log(`ok: ${name} consumer compiles (lib ${lib.join(", ")}; types [${types}])`);
    } else {
      failed = true;
      console.error(`FAIL: ${name} consumer (lib ${lib.join(", ")}; types [${types}])`);
      console.error(result.stdout || result.stderr);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
