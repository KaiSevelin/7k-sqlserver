/**
 * 7K's kernel types, in T-SQL.
 *
 * The mapping is the first place a provider can lie, so it is the first place to be careful. SQL Server
 * is a good target for 7K's kernel and a bad one in two specific places, and both are said out loud
 * rather than papered over:
 *
 * - **`decimal(p,s)` fits exactly.** 7K allows `p` up to 38 (`01-kernel.md`) and so does SQL Server, so
 *   there is no rounding and no refusal — which is worth noting because it is the one type where a
 *   near-miss would be a money bug with a specification behind it.
 * - **`duration` has no type here.** It becomes `BIGINT` milliseconds, which is lossless for what 7K
 *   can express and queryable, but it is not a duration and a reader must be told so.
 * - **`instant` becomes `DATETIME2(6)` and not `DATETIMEOFFSET`.** An instant is absolute and UTC, and a
 *   `DATETIMEOFFSET` can hold an offset that would make it something else. A type that cannot be wrong
 *   beats a type that can.
 */

import type { Decl, FieldIr, LinkedModel, TypeIr } from "@sevenk/core";

/** The widest `decimal` SQL Server holds, which is also 7K's own ceiling. */
export const SQLSERVER_DECIMAL_DIGITS = 38;

/** How long an `NVARCHAR` is when the model declares no bound. */
export const UNBOUNDED = "MAX";

export interface TypeProblem {
  readonly at: string;
  readonly declared: string;
  readonly because: string;
}

export interface Context {
  readonly model: LinkedModel;
  /** The 7K package being written, for a diagnostic that has to say where. */
  readonly pkg: string;
  /**
   * The collation every `NVARCHAR` column is declared with, or empty for the database's own.
   *
   * This is not a cosmetic choice. 7K compares strings exactly — `contract/value.ts` validates an
   * enum member with `includes` and compares two values with `===` — and SQL Server's usual default
   * is case-insensitive. Under that default the database and the model disagree about three things at
   * once: an enum accepts `WEB` where the model declares `Web`, a list declared `unique` rejects
   * `red` beside `RED`, and an invariant comparing two strings holds where 7K says it does not. A
   * binary collation makes the database agree.
   */
  readonly collation: string;
}

/** The column type, plus whatever the model said that it could not carry. */
export interface Column {
  readonly text: string;
  readonly problems: readonly TypeProblem[];
}

/** The upper bound a `length` or `size` constraint declares, where it declares one. */
export function declaredMax(field: Pick<FieldIr, "constraints">): number | undefined {
  for (const constraint of field.constraints) {
    if (constraint.name !== "length" && constraint.name !== "size") continue;
    const at = constraint.args.indexOf("..");
    const text = at < 0 ? constraint.args[0] : constraint.args.slice(at + 1).join("");
    const value = Number(text);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** What a reference points at. */
const referenced = (type: Extract<TypeIr, { t: "ref" }>, ctx: Context): Decl | undefined =>
  ctx.model.declFor(type.ref);

/**
 * The column type for a 7K type, for a type that lives in one column.
 *
 * Lists and maps do not: they become a child table, which `tables.ts` decides. Records do not either —
 * they flatten into the holder's columns. So this only ever sees a scalar, and being handed anything
 * else is a bug here rather than a gap in the model.
 */
export function columnType(type: TypeIr, ctx: Context, at: string, max?: number): Column {
  switch (type.t) {
    case "kernel": {
      const column = kernel(type, at, max);
      // Only a text column takes a collation, and only where one was asked for.
      return ctx.collation === "" || !column.text.startsWith("NVARCHAR")
        ? column
        : { ...column, text: `${column.text} COLLATE ${ctx.collation}` };
    }

    case "ref": {
      const decl = referenced(type, ctx);
      if (decl === undefined) {
        // The model would not have checked, so this is defensive rather than expected.
        return {
          text: "SQL_VARIANT",
          problems: [{ at, declared: type.ref.text, because: `\`${type.ref.text}\` does not resolve` }],
        };
      }

      // A nominal value is its base type here. SQL Server has no domain that could carry the
      // constraint with it, so the constraint travels to every column instead — see `constraints.ts`.
      if (decl.kind === "value") {
        return columnType(decl.base, ctx, at, max ?? declaredMax({ constraints: decl.constraints }));
      }

      // An enum stores the member name the model declares, bounded by a CHECK.
      if (decl.kind === "enum") {
        const widest = decl.members.reduce((n, m) => Math.max(n, m.name.length), 1);
        const text = `NVARCHAR(${widest})`;
        return {
          text: ctx.collation === "" ? text : `${text} COLLATE ${ctx.collation}`,
          problems: [],
        };
      }

      return {
        text: "SQL_VARIANT",
        problems: [
          {
            at,
            declared: type.ref.text,
            because: `A \`${decl.kind}\` does not live in a column; it is flattened or given a table.`,
          },
        ],
      };
    }

    default:
      return {
        text: "SQL_VARIANT",
        problems: [
          {
            at,
            declared: type.t,
            because: "This provider does not know how to put that in a column.",
          },
        ],
      };
  }
}

function kernel(
  type: Extract<TypeIr, { t: "kernel" }>,
  at: string,
  max: number | undefined,
): Column {
  switch (type.name) {
    case "bool":
      return { text: "BIT", problems: [] };

    // 7K's `int` is signed 64-bit, so `BIGINT` and never `INT` — the name is a trap worth not
    // falling into, and `INT` would truncate silently at 2^31.
    case "int":
      return { text: "BIGINT", problems: [] };

    case "float":
      return { text: "FLOAT(53)", problems: [] };

    // NVARCHAR and never VARCHAR: 7K strings are Unicode, NFC (`01-kernel.md`), and a collation-
    // dependent code page would mangle them.
    case "string":
      return { text: `NVARCHAR(${max ?? UNBOUNDED})`, problems: [] };

    case "bytes":
      return { text: `VARBINARY(${max ?? UNBOUNDED})`, problems: [] };

    case "uuid":
      return { text: "UNIQUEIDENTIFIER", problems: [] };

    // Absolute and UTC, so a type that cannot carry an offset is the honest one.
    case "instant":
      return { text: "DATETIME2(6)", problems: [] };

    // No duration type exists. Milliseconds, because that is the resolution 7K's own IR keeps.
    case "duration":
      return { text: "BIGINT", problems: [] };

    case "date":
      return { text: "DATE", problems: [] };

    default: {
      const precision = type.precision ?? 18;
      const scale = type.scale ?? 0;
      if (precision > SQLSERVER_DECIMAL_DIGITS) {
        return {
          text: `DECIMAL(${SQLSERVER_DECIMAL_DIGITS},${scale})`,
          problems: [
            {
              at,
              declared: `decimal(${precision},${scale})`,
              because:
                `SQL Server's \`DECIMAL\` holds ${SQLSERVER_DECIMAL_DIGITS} digits of precision, and ` +
                `this needs ${precision}. A \`FLOAT\` would round money, so there is no honest type ` +
                `for it here.`,
            },
          ],
        };
      }
      return { text: `DECIMAL(${precision},${scale})`, problems: [] };
    }
  }
}

/** Whether a type needs a table of its own rather than a column. */
export const isCollection = (type: TypeIr): boolean => type.t === "list" || type.t === "map";

/** Whether a type flattens into the holder's columns. */
export function isFlattened(type: TypeIr, ctx: Context): boolean {
  if (type.t !== "ref") return false;
  const decl = referenced(type, ctx);
  return decl?.kind === "record" || decl?.kind === "envelope";
}

/** What a reference resolves to, for the callers that need the declaration itself. */
export const declOf = (type: TypeIr, ctx: Context): Decl | undefined =>
  type.t === "ref" ? referenced(type, ctx) : undefined;
