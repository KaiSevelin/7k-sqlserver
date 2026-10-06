/**
 * What this provider is allowed to know.
 *
 * A provider has to know the 7K language — that is its whole job. It must not know *how it is being
 * run*, because there is more than one way and it is not supposed to be able to tell: `7k generate`
 * writes files to a working tree, and Spider shows the same text in a document view and writes nothing
 * at all. Both hand a provider the same `Request`.
 *
 * Checked by reading `src/` rather than by trusting the imports to stay tidy, because the coupling this
 * prevents is the kind that arrives one convenient import at a time. The last one to go was
 * `@sevenk/generate`, the host: every use of it here was type-only, so the dependency bought nothing
 * and cost the ability to be driven by anything else.
 *
 * The harnesses under `scripts/` and the tests under `test/` *do* import the host, deliberately — they
 * have to build a `Request`, which is the host's job. That is why this reads `src/` and not the repo:
 * what ships is the published artifact, not the scaffolding that exercises it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sources = readdirSync(join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, source: readFileSync(join(root, "src", f), "utf8") }));

/** Every module specifier `src/` imports from, with the file that asked for it. */
const imports = sources.flatMap(({ file, source }) =>
  [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => ({ file, what: m[1]! })),
);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("what the provider depends on", () => {
  it("reads the language and the contract, and nothing else", () => {
    expect(sources.length).toBeGreaterThan(0);
    const external = [...new Set(imports.filter((i) => !i.what.startsWith(".")).map((i) => i.what))];
    expect(external.sort()).toEqual(["@sevenk/core", "@sevenk/provider"]);
  });

  it("does not depend on the host that runs it", () => {
    const host = imports.filter((i) => i.what === "@sevenk/generate");
    expect(host.map((i) => i.file)).toEqual([]);
  });

  it("declares the host as a dev dependency, for the harnesses only", () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@sevenk/core",
      "@sevenk/provider",
    ]);
    expect(manifest.devDependencies ?? {}).toHaveProperty("@sevenk/generate");
  });

  /**
   * The capability, not the spelling: a provider returns text and the host decides what becomes of it.
   * A provider that could open a file could write one, and then "generation never touches your code
   * unless you asked" would be a convention rather than a fact.
   */
  it("cannot reach a filesystem, a network or a subprocess", () => {
    const reached = imports.filter((i) => /^node:|^fs$|^path$|^child_process$/.test(i.what));
    expect(reached.map((i) => `${i.file} imports ${i.what}`)).toEqual([]);
  });
});
