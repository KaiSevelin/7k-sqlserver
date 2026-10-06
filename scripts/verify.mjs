/**
 * Does the generated DDL run, and does it hold the model to its word?
 *
 * Unit tests on a generator can only check that it emitted the string somebody expected. They cannot
 * catch a reserved word used unbracketed, a `CHECK` referring to a column that is named something else
 * by the time it is emitted, a child table created before its parent, or a trailing comma. Only the
 * engine catches those.
 *
 * So this creates a database in LocalDB, runs the script, and then does the part that matters: inserts
 * a row that satisfies the model and a row that breaks each rule, and demands the first is accepted and
 * every other is rejected. A `CHECK` that compiles and permits everything is worse than no `CHECK`,
 * because somebody will trust it.
 *
 * Skipped with a notice, not a failure, where there is no SQL Server: a contributor without one should
 * still be able to run the tests.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, compileRules, withDefaults } from "@sevenk/generate";
import { sqlserver } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const OUT = join(root, ".verify");

const DATABASE = "sevenk_verify";
const NEWLINE = String.fromCharCode(10);

/* ------------------------------------------------------------------ the engine */

/**
 * The instance, by its named pipe.
 *
 * `(localdb)\MSSQLLocalDB` is the friendly form, and it only resolves for a process a shell launched:
 * from a spawned one it fails with "Named Pipes Provider: Could not open a connection", which looks
 * exactly like having no SQL Server at all. The pipe is what that name resolves *to* and works from
 * anywhere — it just changes whenever the instance restarts, so it is asked for rather than remembered.
 */
function instance() {
  const started = spawnSync("sqllocaldb", ["start", "MSSQLLocalDB"], { encoding: "utf8" });
  if (started.error !== undefined) return undefined;
  const info = spawnSync("sqllocaldb", ["info", "MSSQLLocalDB"], { encoding: "utf8" });
  const match = /Instance pipe name:\s*(\S+)/.exec(info.stdout ?? "");
  return match?.[1];
}

const PIPE = instance();

const sqlcmd = (args) =>
  PIPE === undefined
    ? { status: 1, stdout: "", stderr: "no instance" }
    : spawnSync("sqlcmd", ["-S", PIPE, "-b", ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });

const probe = sqlcmd(["-Q", "SELECT 1"]);
if (probe.status !== 0) {
  console.log("verify: no SQL Server LocalDB on this machine, so the DDL was not run.");
  console.log("        `sqllocaldb start MSSQLLocalDB` starts one if the SQL Server tools are installed.");
  process.exit(0);
}

/* ------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("verify: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}

const model = workspace.model;
const { names } = buildNames(model, []);

/** Generates one combination into its own directory. */
function emit(layout, extra = {}) {
  const suffix = Object.entries(extra)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const dir = join(OUT, `${layout}${suffix === "" ? "" : `-${suffix}`}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Through the same defaulting the CLI uses, so the declared default is the only one there is.
  // Without this the harness would silently test whatever the code happened to fall back to.
  const options = withDefaults(sqlserver.options, { ...extra });
  const rules = compileRules(model, []);
  const result = sqlserver.generate({
    model,
    selected: model.decls,
    names,
    layout,
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  if (result.refusals.length > 0) {
    console.error(`verify: ${layout} refused, which the fixture should not provoke:`);
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(dir, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }

  return {
    dir,
    files: result.artifacts.map((a) => join(dir, a.path)),
    losses: result.artifacts.flatMap((a) => a.losses),
  };
}

/* ------------------------------------------------------------------ the running */

let failed = 0;

const fresh = () => {
  const drop = sqlcmd([
    "-Q",
    `IF DB_ID(N'${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}]; END; CREATE DATABASE [${DATABASE}];`,
  ]);
  if (drop.status !== 0) {
    console.error(`verify: could not create ${DATABASE}`);
    console.error(`${drop.stdout}${drop.stderr}`.trim());
    process.exit(1);
  }
};

/** Runs one script file, returning nothing on success and the engine's complaint on failure. */
const runFile = (file) => {
  const result = sqlcmd(["-d", DATABASE, "-i", file]);
  return result.status === 0 ? undefined : `${result.stdout}${result.stderr}`.trim();
};

const COMBINATIONS = [
  ["single", {}],
  ["single", { casing: "snake" }],
  ["single", { schema: "dbo" }],
  ["single", { drop: true }],
  ["single", { checks: false }],
  ["per-package", {}],
  ["per-declaration", {}],
];

for (const [layout, extra] of COMBINATIONS) {
  const { files, losses } = emit(layout, extra);
  fresh();

  // `per-declaration` is many files, and a message's own tables are in one of them — so each runs on
  // its own, which is the promise that layout makes.
  const complaint = files.map(runFile).find((c) => c !== undefined);

  const label =
    `${layout}${Object.keys(extra).length === 0 ? "" : ` ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}`}`;
  if (complaint === undefined) {
    const note = losses.length === 0 ? "" : `, ${losses.length} declared losses`;
    console.log(`ok    ${label.padEnd(30)} ${files.length} file${files.length === 1 ? "" : "s"}${note}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
    for (const line of complaint.split("\n").slice(0, 8)) console.log(`        ${line.trim()}`);
  }
}

/* --------------------------------------------------------------- the behaviour */

/**
 * The part a parser could not tell you: that the constraints actually constrain.
 *
 * Each case is the base row with one thing changed, built here rather than written out. That is not
 * tidiness — a hand-written case that happens to break a second rule is rejected for the wrong reason
 * and proves nothing, which is exactly what the first version of this did. Varying one column is the
 * only way to know which constraint answered.
 */
const spec = JSON.parse(readFileSync(join(root, "verify", "cases.json"), "utf8"));

const insert = (table, row) => {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.map((c) => `[${c}]`).join(",")}) VALUES (${columns
    .map((c) => row[c])
    .join(",")})`;
};

{
  const { files } = emit("single", {});
  fresh();
  const complaint = files.map(runFile).find((c) => c !== undefined);
  console.log("");

  if (complaint !== undefined) {
    console.log("FAIL  the script has to run before anything can be inserted into it");
    console.log(`        ${complaint.split(NEWLINE).slice(0, 3).join(" ")}`);
    failed++;
  } else {
    /** Runs one statement, in a transaction rolled back unless it is meant to persist. */
    const attempt = (sql, keep) => {
      const wrapped = keep
        ? `SET XACT_ABORT ON; ${sql};`
        : `SET XACT_ABORT ON; BEGIN TRAN; ${sql}; ROLLBACK TRAN;`;
      const result = sqlcmd(["-d", DATABASE, "-Q", wrapped]);
      return { ok: result.status === 0, why: `${result.stdout}${result.stderr}`.trim() };
    };

    const report = (one, got) => {
      const ok = got.ok === one.accept;
      console.log(`${ok ? "ok   " : "FAIL "} ${one.accept ? "accepts" : "rejects"} ${one.what}`);
      if (ok) return;
      failed++;
      if (got.ok) console.log("        it was accepted, and the model says it should not be");
      else console.log(`        ${got.why.split(NEWLINE).slice(0, 2).join(" ")}`);
    };

    // The base row persists once, because the child-table cases reference it. Every other case gets
    // its own id and is rolled back, so one case cannot be rejected by the leftovers of another.
    const base = attempt(insert(spec.table, spec.base), true);
    report(spec.cases[0], base);

    for (const one of spec.cases.slice(1)) {
      const row = { ...spec.base, MessageId: "NEWID()", ...(one.set ?? {}) };
      for (const dropped of one.drop ?? []) delete row[dropped];
      const sql = insert(spec.table, row);
      // Inserting one row twice is how the primary key is tested, which needs a fixed id.
      const twice = one.twice === true;
      report(
        one,
        attempt(
          twice
            ? `${insert(spec.table, { ...spec.base, MessageId: "'44444444-4444-4444-4444-444444444444'" })}; ${insert(spec.table, { ...spec.base, MessageId: "'44444444-4444-4444-4444-444444444444'" })}`
            : sql,
          false,
        ),
      );
    }

    for (const one of spec.statements) report(one, attempt(one.sql, one.accept));
  }
}

console.log("");
console.log(
  failed === 0
    ? "verify: the generated DDL runs, and the model's rules are enforced by the database."
    : `verify: ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
