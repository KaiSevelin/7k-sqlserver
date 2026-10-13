/**
 * The coverage declaration, against what this provider actually does.
 *
 * `covers` is read by somebody deciding whether to commit a model to SQL Server, which makes it the
 * most consequential thing in this repository that is not code — and the easiest to let drift,
 * because nothing in a generated script disagrees with a sentence in a declaration. This is what
 * disagrees with it: the fixture is the awkward one `npm run verify` points a real server at, so the
 * losses here are the losses a model exercising this provider's gaps produces.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl } from "@sevenk/core";
import {
  buildNames,
  compileRules,
  coverageFaults,
  overclaimed,
  withDefaults,
  type Request,
} from "@sevenk/generate";
import { sqlserver } from "../src/index.js";

const source = readFileSync(new URL("../verify/model/shop.7k", import.meta.url), "utf-8");

const generated = (options: Record<string, unknown>) => {
  const m = buildWorkspace([{ path: "shop.7k", source }]).model;
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  const defaults = withDefaults(sqlserver.options, options);
  const request: Request = {
    model: m,
    selected: m.decls,
    names,
    layout: "single",
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
  return sqlserver.generate(request);
};

describe("what this provider says it can do", () => {
  it("says it in a form a reader can act on", () => {
    expect(coverageFaults(sqlserver, "sqlserver")).toEqual([]);
  });

  it("does not claim coverage it then loses", () => {
    expect(overclaimed(sqlserver, generated({}).artifacts, "sqlserver")).toEqual([]);
  });

  it("is checked against a fixture that actually loses things", () => {
    // Otherwise the test above passes by the fixture being easy, which is the way a claim like this
    // rots: green on a model that never reaches the gaps.
    const losses = generated({}).artifacts.flatMap((a) => a.losses);
    expect(losses.length).toBeGreaterThan(0);
    expect(new Set(losses.map((l) => l.construct)).size).toBeGreaterThan(2);
  });

  it("holds with the checks and the record tables turned on", () => {
    // `checks off` emits no constraint at all, so the losses only appear with them on — the setting
    // a reader would assume.
    const out = generated({ checks: true, records: true });
    expect(overclaimed(sqlserver, out.artifacts, "sqlserver")).toEqual([]);
  });
});
