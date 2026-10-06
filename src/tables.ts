/**
 * A message as tables.
 *
 * Three decisions shape this, and each falls out of what the language already says rather than from
 * what is convenient to emit.
 *
 * **A nested record flattens; a collection gets a table.** `total: Money` is part of the message's own
 * value, so it becomes `TotalAmount` and `TotalCurrency` in the same row — a message is one thing and
 * splitting it across a join would make it look like a relationship. `lines: [OrderLine]` genuinely is
 * several things, so it becomes a child table with an ordinal, because a 7K list is ordered and a set
 * of rows is not.
 *
 * **The three tiers of the encoding are the three groups of columns.** `01-kernel.md` 7.3 separates
 * metadata, envelope and body, and so does the table: `MessageId` and `SentAt` are the runtime's,
 * the envelope columns are the package's, and the rest is the message's own.
 *
 * **A field added in a later version must be nullable.** `FieldIr.since` says which version introduced
 * a field, and one table holds every minor version of a message — so a field the model marks required
 * is still absent from every row written before it existed. Declaring it `NOT NULL` would make the
 * table unable to hold the history it is for. This is the one place the generated DDL is deliberately
 * weaker than the contract, and it says so in a comment on the column.
 */

import type { Decl, FieldIr, MessageIr, Predicate, RecordIr } from "@sevenk/core";
import type { Loss } from "@sevenk/generate";
import {
  bracket,
  childName,
  columnName,
  constraintName,
  qnameOf,
  tableRef,
  type Casing,
} from "./naming.js";
import {
  chain,
  checksFor,
  narrowed,
  describePredicate,
  enumCheck,
  enumOf,
  invariantCheck,
  through,
} from "./constraints.js";
import { columnType, declaredMax, isCollection, isFlattened, type Context, type TypeProblem } from "./types.js";

export interface ColumnDef {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /** Why it is nullable where the model says the field is required. */
  readonly note?: string;
  /** The 7K path it came from, for an invariant that has to find it. */
  readonly path: readonly string[];
}

export interface Table {
  readonly schema: string;
  readonly name: string;
  readonly describes: string;
  readonly columns: readonly ColumnDef[];
  readonly primaryKey: readonly string[];
  readonly checks: readonly { readonly name: string; readonly sql: string; readonly what: string }[];
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly indexes: readonly { readonly name: string; readonly columns: readonly string[]; readonly why: string }[];
  readonly foreignKey?: {
    readonly name: string;
    readonly columns: readonly string[];
    readonly references: string;
    readonly referencedColumns: readonly string[];
  };
  /** A child table comes after its parent, which is the order the script has to be in. */
  readonly depth: number;
}

export interface Built {
  readonly tables: readonly Table[];
  readonly losses: readonly Loss[];
  readonly problems: readonly TypeProblem[];
}

export interface Options {
  readonly casing: Casing;
  readonly schema: string;
  /** The column holding the per-send envelope id, which is the primary key. */
  readonly idColumn: string;
}

/**
 * Makes a set of constraint names unique.
 *
 * Two rules can land on one column and deserve the same name: `value Line60 : Line` is bound by both
 * its own `length` and the one it refines, and both are real — a value must satisfy each. SQL Server
 * will not have two constraints of one name, and the first it hits is the one it refuses, so the
 * duplicate has to be resolved here rather than by dropping a check.
 */
function uniqueNames<T extends { readonly name: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = (seen.get(item.name) ?? 0) + 1;
    seen.set(item.name, count);
    return count === 1 ? item : { ...item, name: `${item.name}_${count}` };
  });
}

const fieldsOf = (decl: Decl): readonly FieldIr[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope" ? decl.fields : [];

const invariantsOf = (decl: Decl): readonly Predicate[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? decl.invariants
    : [];

/**
 * The columns one record's fields become, flattened, with their rules.
 *
 * Recursive over nested records, which is why `path` is carried: a column is named for the whole path
 * it came from and an invariant has to be able to find it by that path again.
 */
function flatten(
  decl: Decl,
  ctx: Context,
  options: Options,
  state: {
    columns: ColumnDef[];
    checks: { name: string; sql: string; what: string }[];
    collections: { path: readonly string[]; field: FieldIr }[];
    losses: Loss[];
    problems: TypeProblem[];
    indexes: { name: string; columns: readonly string[]; why: string }[];
  },
  table: string,
  prefix: readonly string[] = [],
  forcedNullable = false,
  depth = 0,
): void {
  if (depth > 8) return;

  for (const field of fieldsOf(decl)) {
    const path = [...prefix, field.name];
    const at = `${decl.id.name}.${field.name}`;

    if (isCollection(field.type)) {
      state.collections.push({ path, field });
      // A `size` or `length` on the collection is a cardinality rule no CHECK can reach.
      for (const constraint of field.constraints) {
        const { losses } = checksFor(constraint, field, "", at, ctx);
        state.losses.push(...losses);
      }
      continue;
    }

    if (isFlattened(field.type, ctx)) {
      const nested = ctx.model.declFor(field.type.t === "ref" ? field.type.ref : ({} as never));
      if (nested !== undefined) {
        // An optional record makes every column it contributes nullable: there is no row to be
        // half-present in, so absence is all of its columns being absent together.
        flatten(
          nested,
          ctx,
          options,
          state,
          table,
          path,
          forcedNullable || field.optional,
          depth + 1,
        );
      }
      continue;
    }

    const name = columnName(path, options.casing);
    const quoted = bracket(name);
    const max = declaredMax(field) ?? declaredMax({ constraints: chain(field.type, ctx) });
    const type = columnType(field.type, ctx, at, max);
    state.problems.push(...type.problems);

    // A field introduced by a later version is absent from every row written before it existed, so
    // one table holding both versions cannot require it.
    const since = field.since;
    const nullable = forcedNullable || field.optional || since !== undefined;

    state.columns.push({
      name,
      type: type.text,
      nullable,
      path,
      ...(since !== undefined && !field.optional
        ? {
            note:
              `the model requires this, but \`since ${since}\` means it is absent from every row ` +
              `written before that version`,
          }
        : {}),
      ...(forcedNullable && !field.optional && since === undefined
        ? { note: "the record holding it is optional, so all of its columns are absent together" }
        : {}),
    });

    // The field's own rules, then everything its nominal type brings with it.
    for (const constraint of narrowed([...field.constraints, ...chain(field.type, ctx)])) {
      const { expressions, losses } = checksFor(constraint, field, quoted, at, ctx);
      state.losses.push(...losses);
      for (const expression of expressions) {
        state.checks.push({
          name: constraintName("CK", table, [...path, constraint.name], options.casing),
          sql: nullable ? `${quoted} IS NULL OR (${expression.sql})` : expression.sql,
          what: `${field.name}: ${expression.what}`,
        });
      }
    }

    // An enum is bounded to the member names the model declares.
    const enumDecl = enumOf(field.type, ctx);
    if (enumDecl !== undefined) {
      const check = enumCheck(enumDecl, quoted);
      if (check !== undefined) {
        state.checks.push({
          name: constraintName("CK", table, [...path, "member"], options.casing),
          sql: nullable ? `${quoted} IS NULL OR (${check})` : check,
          what: `${field.name}: a member of \`${qnameOf(enumDecl)}\``,
        });
      }
    }

    // A role is a reason to index: these are the columns somebody will look a message up by.
    if (field.role === "businessKey" || field.role === "correlation" || field.role === "partitionKey") {
      state.indexes.push({
        name: constraintName("IX", table, path, options.casing),
        columns: [name],
        why: `\`@role(${field.role})\`, which is what a message is looked up by`,
      });
    }

    // A nominal value is its base type here: SQL Server has no domain that could carry the name.
    if (through(field.type, ctx) !== field.type && field.type.t === "ref") {
      const target = ctx.model.declFor(field.type.ref);
      if (target?.kind === "value") {
        state.losses.push({
          construct: "nominal value",
          at,
          fidelity: "partial",
          detail:
            `\`${qnameOf(target)}\` is its base type here. SQL Server has no domain that could carry ` +
            `the name, so two columns of the same base type are interchangeable where 7K would not ` +
            `have allowed it. Its constraints travel to the column.`,
        });
      }
    }
  }
}

/** The envelope records every message in a package carries (D50). */
const envelopesOf = (pkg: string, ctx: Context): Decl[] =>
  (ctx.model.packages.get(pkg)?.envelopes ?? [])
    .map((ref) => ctx.model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);

/**
 * Every table one message needs: its own, and one per collection it holds, recursively.
 */
export function tablesFor(decl: MessageIr | RecordIr, ctx: Context, options: Options): Built {
  const casing = options.casing;
  const table = columnName([decl.id.name], casing);
  const schema = options.schema;

  const state = {
    columns: [] as ColumnDef[],
    checks: [] as { name: string; sql: string; what: string }[],
    collections: [] as { path: readonly string[]; field: FieldIr }[],
    losses: [] as Loss[],
    problems: [] as TypeProblem[],
    indexes: [] as { name: string; columns: readonly string[]; why: string }[],
  };

  // The metadata tier, which the runtime supplies and the model never declares.
  const idColumn = columnName([options.idColumn], casing);
  const sentAt = columnName(["sentAt"], casing);
  const version = columnName(["messageVersion"], casing);

  state.columns.push(
    { name: idColumn, type: "UNIQUEIDENTIFIER", nullable: false, path: ["$id"] },
    { name: sentAt, type: "DATETIME2(6)", nullable: false, path: ["$time"] },
    { name: version, type: "NVARCHAR(16)", nullable: false, path: ["$version"] },
  );

  // The envelope tier, flat across the records the package declares, as the encoding has it. Not
  // forced nullable: an envelope is carried by *every* message in its package (D50), so a required
  // envelope field is as required as a body one.
  for (const envelope of envelopesOf(decl.id.pkg, ctx)) {
    flatten(envelope, ctx, options, state, table, []);
  }

  // And the body.
  flatten(decl, ctx, options, state, table, []);

  const byPath = new Map(
    state.columns.map((c) => [
      c.path.join("."),
      { sql: bracket(c.name), nullable: c.nullable },
    ]),
  );

  // An invariant becomes a real constraint wherever it stays inside the row, which is the half of the
  // contract a schema projection has to give up.
  invariantsOf(decl).forEach((invariant, index) => {
    const { sql, why } = invariantCheck(
      invariant,
      (path) => byPath.get(path.join(".")),
      describePredicate,
    );
    const text = describePredicate(invariant);
    if (sql === undefined) {
      state.losses.push({
        construct: "invariant",
        at: decl.id.name,
        fidelity: "none",
        detail: `\`${text}\` is not checked here because ${why ?? "it is unsupported"}.`,
      });
      return;
    }
    state.checks.push({
      name: constraintName("CK", table, ["invariant", String(index + 1)], casing),
      sql,
      what: `invariant ${text}`,
    });
  });

  const own: Table = {
    schema,
    name: table,
    describes: qnameOf(decl),
    columns: state.columns,
    primaryKey: [idColumn],
    checks: uniqueNames(state.checks),
    uniques: [],
    indexes: uniqueNames(state.indexes),
    depth: 0,
  };

  const children = state.collections.flatMap((c) =>
    childTables(decl, c.path, c.field, ctx, options, table, [idColumn], 1),
  );

  return { tables: [own, ...children], losses: state.losses, problems: state.problems };
}

/**
 * A collection as a child table.
 *
 * The parent key plus an ordinal is the primary key, because a 7K list is ordered: without the ordinal
 * the rows are a set and the order the model guaranteed is gone. A map's key column takes the
 * ordinal's place, since a map is keyed and not ordered.
 */
function childTables(
  holder: Decl,
  path: readonly string[],
  field: FieldIr,
  ctx: Context,
  options: Options,
  parentTable: string,
  parentKey: readonly string[],
  depth: number,
): Table[] {
  if (depth > 4 || field.type.t === "kernel") return [];

  const casing = options.casing;
  const name = childName(parentTable, path, casing);
  const at = `${holder.id.name}.${path.join(".")}`;

  const columns: ColumnDef[] = parentKey.map((k) => ({
    name: k,
    type: "UNIQUEIDENTIFIER",
    nullable: false,
    path: [`$parent.${k}`],
  }));

  const key: string[] = [...parentKey];
  const state = {
    columns: [] as ColumnDef[],
    checks: [] as { name: string; sql: string; what: string }[],
    collections: [] as { path: readonly string[]; field: FieldIr }[],
    losses: [] as Loss[],
    problems: [] as TypeProblem[],
    indexes: [] as { name: string; columns: readonly string[]; why: string }[],
  };

  const uniques: { name: string; columns: readonly string[] }[] = [];

  if (field.type.t === "list") {
    // Ordered, so the position is part of the row's identity.
    const ordinal = columnName(["ordinal"], casing);
    columns.push({ name: ordinal, type: "INT", nullable: false, path: ["$ordinal"] });
    key.push(ordinal);

    const element = field.type.item;
    const elementDecl = element.t === "ref" ? ctx.model.declFor(element.ref) : undefined;

    if (elementDecl !== undefined && (elementDecl.kind === "record" || elementDecl.kind === "envelope")) {
      flatten(elementDecl, ctx, options, state, name, []);
    } else {
      const valueName = columnName(["value"], casing);
      const type = columnType(element, ctx, at, declaredMax({ constraints: chain(element, ctx) }));
      state.problems.push(...type.problems);
      state.columns.push({ name: valueName, type: type.text, nullable: false, path: ["value"] });
      for (const constraint of narrowed(chain(element, ctx))) {
        const { expressions, losses } = checksFor(
          constraint,
          { ...field, type: element, constraints: [] },
          bracket(valueName),
          at,
          ctx,
        );
        state.losses.push(...losses);
        for (const expression of expressions) {
          state.checks.push({
            name: constraintName("CK", name, ["value", constraint.name], casing),
            sql: expression.sql,
            what: expression.what,
          });
        }
      }
      const enumDecl = enumOf(element, ctx);
      const check = enumDecl === undefined ? undefined : enumCheck(enumDecl, bracket(valueName));
      if (check !== undefined) {
        state.checks.push({
          name: constraintName("CK", name, ["value", "member"], casing),
          sql: check,
          what: `a member of \`${qnameOf(enumDecl!)}\``,
        });
      }
    }

    // `unique` over the list is a UNIQUE over (parent, the element's columns).
    if (field.constraints.some((c) => c.name === "unique")) {
      uniques.push({
        name: constraintName("UQ", name, ["unique"], casing),
        columns: [...parentKey, ...state.columns.map((c) => c.name)],
      });
    }
  } else if (field.type.t === "map") {
    // Keyed, not ordered: the key is what identifies the row.
    const keyName = columnName(["key"], casing);
    const keyType = columnType(field.type.key, ctx, at, declaredMax({ constraints: chain(field.type.key, ctx) }));
    state.problems.push(...keyType.problems);
    columns.push({ name: keyName, type: keyType.text, nullable: false, path: ["$key"] });
    key.push(keyName);

    const value = field.type.value;
    const valueDecl = value.t === "ref" ? ctx.model.declFor(value.ref) : undefined;
    if (valueDecl !== undefined && (valueDecl.kind === "record" || valueDecl.kind === "envelope")) {
      flatten(valueDecl, ctx, options, state, name, []);
    } else {
      const valueName = columnName(["value"], casing);
      const type = columnType(value, ctx, at, declaredMax({ constraints: chain(value, ctx) }));
      state.problems.push(...type.problems);
      state.columns.push({ name: valueName, type: type.text, nullable: false, path: ["value"] });
    }
  }

  const table: Table = {
    schema: options.schema,
    name,
    describes: `${qnameOf(holder)}.${path.join(".")}`,
    columns: [...columns, ...state.columns],
    primaryKey: key,
    checks: uniqueNames(state.checks),
    uniques,
    indexes: state.indexes,
    foreignKey: {
      name: constraintName("FK", name, [parentTable], casing),
      columns: parentKey,
      references: tableRef(options.schema, parentTable),
      referencedColumns: parentKey,
    },
    depth,
  };

  // A collection inside a collection, which the grammar permits.
  const deeper = state.collections.flatMap((c) =>
    childTables(holder, [...path, ...c.path], c.field, ctx, options, name, key, depth + 1),
  );

  return [table, ...deeper];
}
