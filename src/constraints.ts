/**
 * The model's rules, as `CHECK` constraints.
 *
 * Worth generating because a `CHECK` is the only kind of validation nobody can skip: it is enforced by
 * the thing holding the data, whatever wrote it, whichever service forgot. A validator in one language
 * guards one door.
 *
 * **SQL expresses one thing JSON Schema cannot, and misses two it can.** A `CHECK` spans the whole row,
 * so `total.currency == lines[].unit.currency`'s same-row cousins — any invariant over columns of one
 * table — becomes a real constraint, which `20-ir.md`'s loss table records as absent from a schema
 * projection. What SQL misses is a `pattern`, because SQL Server has no regular expression operator at
 * all, and a `size` on a list, because the list is a child table and its cardinality is not something a
 * declarative constraint can reach. Both are recorded as losses rather than quietly dropped.
 *
 * **Nothing here is approximate.** A constraint this cannot express exactly is a loss. A `LIKE` pattern
 * that happens to catch most of what a regex would is the kind of near-miss that gets trusted and then
 * lets something through.
 */

import type { ConstraintIr, Decl, FieldIr, Operand, Predicate, TypeIr } from "@sevenk/core";
import type { Loss } from "@sevenk/provider";
import { bracket } from "./naming.js";
import { declOf, isCollection, type Context } from "./types.js";

export interface Checks {
  /** `CHECK` expressions, without the keyword. */
  readonly expressions: readonly { readonly what: string; readonly sql: string }[];
  readonly losses: readonly Loss[];
}

/** `["1", "..", "200"]` — the bounds as the parser kept them. */
export function bounds(args: readonly string[]): { low?: string; high?: string; exact?: string } {
  const at = args.indexOf("..");
  if (at < 0) return args[0] === undefined ? {} : { exact: args[0] };
  const low = args.slice(0, at).join("");
  const high = args.slice(at + 1).join("");
  return { ...(low === "" ? {} : { low }), ...(high === "" ? {} : { high }) };
}

const literal = (text: string): string => `N'${text.replace(/'/g, "''")}'`;

/** How a value's length is measured, which depends on what the column holds. */
function measure(type: TypeIr, ctx: Context, column: string): string | undefined {
  const base = through(type, ctx);
  if (base.t !== "kernel") return undefined;
  if (base.name === "string") return `LEN(${column})`;
  // DATALENGTH counts octets, which is what a `length` on `bytes` means.
  if (base.name === "bytes") return `DATALENGTH(${column})`;
  return undefined;
}

/** Through a chain of nominal values, to the type the rules are about. */
export function through(type: TypeIr, ctx: Context): TypeIr {
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref") return current;
    const decl = ctx.model.declFor(current.ref);
    if (decl === undefined || decl.kind !== "value") return current;
    current = decl.base;
  }
  return current;
}

/** Every constraint along a chain of nominal values, nearest first. */
export function chain(type: TypeIr, ctx: Context): ConstraintIr[] {
  const all: ConstraintIr[] = [];
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref") break;
    const decl = ctx.model.declFor(current.ref);
    if (decl === undefined || decl.kind !== "value") break;
    all.push(...decl.constraints);
    current = decl.base;
  }
  return all;
}

/**
 * The narrowest form of each bounded rule.
 *
 * `value Line60 : Line` is bound by its own `length 1..60` and by the `length 1..255` it refines, and
 * both are true — so emitting both is correct and emitting the intersection is correct and shorter.
 * Two constraints saying almost the same thing are also two constraint names to disambiguate and two
 * lines for a reader to reconcile, so they are intersected here.
 */
export function narrowed(constraints: readonly ConstraintIr[]): ConstraintIr[] {
  const BOUNDED = new Set(["length", "size", "range"]);
  const out: ConstraintIr[] = [];
  const bounded = new Map<string, ConstraintIr>();

  for (const constraint of constraints) {
    if (!BOUNDED.has(constraint.name)) {
      out.push(constraint);
      continue;
    }
    const held = bounded.get(constraint.name);
    if (held === undefined) {
      bounded.set(constraint.name, constraint);
      continue;
    }
    bounded.set(constraint.name, { ...held, args: intersect(held.args, constraint.args) });
  }

  return [...out, ...bounded.values()];
}

/** The tighter of two bounds, as the raw tokens a constraint carries. */
function intersect(a: readonly string[], b: readonly string[]): string[] {
  const x = bounds(a);
  const y = bounds(b);

  // An exact length is already as narrow as a bound gets.
  if (x.exact !== undefined) return [x.exact];
  if (y.exact !== undefined) return [y.exact];

  const tighter = (
    first: string | undefined,
    second: string | undefined,
    pick: (p: number, q: number) => number,
  ): string | undefined => {
    if (first === undefined) return second;
    if (second === undefined) return first;
    const p = Number(first);
    const q = Number(second);
    return Number.isFinite(p) && Number.isFinite(q) ? String(pick(p, q)) : first;
  };

  const low = tighter(x.low, y.low, Math.max);
  const high = tighter(x.high, y.high, Math.min);
  return [...(low === undefined ? [] : [low]), "..", ...(high === undefined ? [] : [high])];
}

/**
 * One constraint, as a check on one column.
 *
 * `at` is where it was declared, for a loss report a human reads. `column` is already bracketed.
 */
export function checksFor(
  constraint: ConstraintIr,
  field: FieldIr,
  column: string,
  at: string,
  ctx: Context,
): Checks {
  const b = bounds(constraint.args);
  const list = isCollection(field.type);
  const of = measure(field.type, ctx, column);

  const expressions: { what: string; sql: string }[] = [];
  const losses: Loss[] = [];

  const rule = (name: string): string =>
    b.exact !== undefined ? `${name} ${b.exact}` : `${name} ${b.low ?? ""}..${b.high ?? ""}`;

  switch (constraint.name) {
    case "length": {
      if (list) {
        // The elements are rows in a child table, and no declarative constraint counts them.
        losses.push(cardinality(constraint.name, at, rule("length")));
        break;
      }
      if (of === undefined) break;
      if (b.exact !== undefined) {
        expressions.push({ what: rule("length"), sql: `${of} = ${b.exact}` });
        break;
      }
      const parts: string[] = [];
      if (b.low !== undefined) parts.push(`${of} >= ${b.low}`);
      if (b.high !== undefined) parts.push(`${of} <= ${b.high}`);
      if (parts.length > 0) expressions.push({ what: rule("length"), sql: parts.join(" AND ") });
      break;
    }

    case "size":
      // A `size` is always about a collection, which is always a child table.
      losses.push(cardinality(constraint.name, at, rule("size")));
      break;

    case "range": {
      const parts: string[] = [];
      if (b.exact !== undefined) parts.push(`${column} = ${b.exact}`);
      if (b.low !== undefined) parts.push(`${column} >= ${b.low}`);
      if (b.high !== undefined) parts.push(`${column} <= ${b.high}`);
      if (parts.length > 0) expressions.push({ what: rule("range"), sql: parts.join(" AND ") });
      break;
    }

    case "multipleOf": {
      const by = constraint.args[0] ?? "1";
      expressions.push({ what: `multipleOf ${by}`, sql: `${column} % ${by} = 0` });
      break;
    }

    case "pattern":
      // SQL Server has no regular expression operator. `LIKE` is a different language, and a `LIKE`
      // that catches most of what a regex would is the kind of near-miss that gets trusted.
      losses.push({
        construct: "pattern",
        at,
        fidelity: "none",
        detail:
          `SQL Server has no regular expression operator, and \`LIKE\` cannot express ` +
          `\`${constraint.args[0] ?? ""}\`. A value this rejects can be written here; 7K's own checker ` +
          `and the producer's validator are what stop it.`,
      });
      break;

    case "unique":
      // Handled where the child table is built, as a UNIQUE constraint over (parent, value).
      break;

    case "normalize":
      losses.push({
        construct: "normalize",
        at,
        fidelity: "none",
        detail:
          `\`normalize ${constraint.args.join(", ")}\` transforms a value and a \`CHECK\` is a ` +
          `predicate, so an unnormalised value is accepted here where 7K would have rewritten it.`,
      });
      break;

    case "example":
      break;

    default:
      losses.push({
        construct: constraint.name,
        at,
        fidelity: "none",
        detail: `This provider does not express \`${constraint.name}\`.`,
      });
      break;
  }

  return { expressions, losses };
}

const cardinality = (construct: string, at: string, rule: string): Loss => ({
  construct,
  at,
  fidelity: "none",
  detail:
    `\`${rule}\` bounds how many elements there are, and they are rows in a child table — a count no ` +
    `declarative constraint can reach. A row violating it can be written here.`,
});

/* ------------------------------------------------------------------ invariants */

/**
 * An invariant, where it stays inside one row.
 *
 * This is the half SQL does *better* than a schema projection: a `CHECK` sees every column of the row,
 * so a rule relating two fields of a message is a real constraint rather than a note. What it cannot
 * reach is a projection — `lines[].unit.currency` is in another table — and that is recorded as a loss
 * with the reason, because it is precisely the rule somebody would most want enforced.
 */
export interface ColumnRef {
  readonly sql: string;
  readonly nullable: boolean;
}

export function invariantCheck(
  predicate: Predicate,
  columnOf: (path: readonly string[]) => ColumnRef | undefined,
  describe: (p: Predicate) => string,
): { sql?: string; why?: string } {
  switch (predicate.p) {
    case "and": {
      const parts = predicate.operands.map((p) => invariantCheck(p, columnOf, describe));
      const failed = parts.find((p) => p.sql === undefined);
      if (failed !== undefined) return failed;
      return { sql: `(${parts.map((p) => p.sql).join(" AND ")})` };
    }

    case "or": {
      const parts = predicate.operands.map((p) => invariantCheck(p, columnOf, describe));
      const failed = parts.find((p) => p.sql === undefined);
      if (failed !== undefined) return failed;
      return { sql: `(${parts.map((p) => p.sql).join(" OR ")})` };
    }

    case "not": {
      const inner = invariantCheck(predicate.operand, columnOf, describe);
      return inner.sql === undefined ? inner : { sql: `NOT (${inner.sql})` };
    }

    case "cmp": {
      const op = OPS[predicate.op];
      if (op === undefined) {
        return { why: `the operator \`${predicate.op}\` is not expressed here` };
      }

      const side = (operand: Operand): { sql?: string; nullable?: boolean; why?: string } => {
        switch (operand.k) {
          case "literal":
            return {
              sql:
                typeof operand.value === "string"
                  ? literal(operand.value)
                  : typeof operand.value === "boolean"
                    ? operand.value
                      ? "1"
                      : "0"
                    : String(operand.value),
              nullable: false,
            };
          case "field":
          case "message": {
            if (operand.path.includes("[]")) {
              return {
                why: `\`${operand.path.join(".").replace(/\.\[\]/g, "[]")}\` reads a list, whose elements are rows in another table`,
              };
            }
            const column = columnOf(operand.path);
            return column === undefined
              ? { why: `\`${operand.path.join(".")}\` is not a column of this table` }
              : { sql: column.sql, nullable: column.nullable };
          }
          case "envelope": {
            const column = columnOf(operand.path);
            return column === undefined
              ? { why: `\`envelope.${operand.path.join(".")}\` is not a column of this table` }
              : { sql: column.sql, nullable: column.nullable };
          }
          default:
            return { why: `it reads \`${operand.k}\`, which is not data this table holds` };
        }
      };

      const left = side(predicate.left);
      const right = side(predicate.right);
      if (left.sql === undefined) return { ...(left.why === undefined ? {} : { why: left.why }) };
      if (right.sql === undefined) return { ...(right.why === undefined ? {} : { why: right.why }) };

      // 7K says a comparison needs both sides: "absent differs from absent" is as unfounded as
      // "absent equals absent", so an absent operand makes the comparison *false*
      // (`contract/evaluate.ts`). SQL would make it UNKNOWN, and a `CHECK` passes on UNKNOWN — so
      // without these guards an absent field would quietly satisfy a rule it violates. Making the
      // comparison two-valued here is also what lets `NOT` and `OR` above compose the way 7K does.
      const present = [
        ...(left.nullable === true ? [`${left.sql} IS NOT NULL`] : []),
        ...(right.nullable === true ? [`${right.sql} IS NOT NULL`] : []),
      ];
      const comparison = `${left.sql} ${op} ${right.sql}`;
      return { sql: present.length === 0 ? comparison : `${present.join(" AND ")} AND ${comparison}` };
    }

    default:
      return { why: "7K could not parse it" };
  }
}

const OPS: Readonly<Record<string, string>> = {
  "==": "=",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/** An invariant as the model would have written it, for a constraint name and a loss. */
export function describePredicate(predicate: Predicate): string {
  switch (predicate.p) {
    case "and":
    case "or":
      return predicate.operands
        .map(describePredicate)
        .join(predicate.p === "and" ? " and " : " or ");
    case "not":
      return `not ${describePredicate(predicate.operand)}`;
    case "cmp": {
      const side = (operand: Operand): string => {
        switch (operand.k) {
          case "literal":
            return JSON.stringify(operand.value);
          case "list":
            return `[${operand.values.map((v) => JSON.stringify(v)).join(", ")}]`;
          case "claim":
            return `claim.${operand.name}`;
          case "envelope":
            return `envelope.${operand.path.join(".")}`;
          default:
            return operand.path.join(".").replace(/\.\[\]/g, "[]");
        }
      };
      return `${side(predicate.left)} ${predicate.op} ${side(predicate.right)}`;
    }
    default:
      return predicate.text;
  }
}

/** An enum's members, as the CHECK that bounds a column to them. */
export function enumCheck(decl: Decl, column: string): string | undefined {
  if (decl.kind !== "enum" || decl.members.length === 0) return undefined;
  return `${column} IN (${decl.members.map((m) => literal(m.name)).join(", ")})`;
}

/** The declaration a column's type resolves to, for the enum check. */
export const enumOf = (type: TypeIr, ctx: Context): Decl | undefined => {
  const base = through(type, ctx);
  const decl = declOf(base, ctx);
  return decl?.kind === "enum" ? decl : undefined;
};

export { bracket };
