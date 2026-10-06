/**
 * Identifiers.
 *
 * Two things matter and both are easy to get wrong. The first is that **every identifier is bracketed**,
 * always, because a 7K field may legitimately be called `order`, `key` or `user` and a generated script
 * that works until somebody adds a field named after a keyword is worse than one that never did.
 *
 * The second is that a name has to be *stable*. A table name is in somebody's queries, so it cannot
 * change because this provider learned a nicer convention — which is why the casing is an option with a
 * default and not a judgement made per declaration.
 */

import type { Decl, NodeId } from "@sevenk/core";

export type Casing = "pascal" | "snake";

/** `[Order]` — bracketed, with any closing bracket doubled, which is T-SQL's own escape. */
export const bracket = (name: string): string => `[${name.replace(/]/g, "]]")}]`;

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((w) => w !== "");

export const pascal = (name: string): string =>
  words(name)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("");

export const snake = (name: string): string =>
  words(name)
    .map((w) => w.toLowerCase())
    .join("_");

export const cased = (name: string, casing: Casing): string =>
  casing === "snake" ? snake(name) : pascal(name);

/**
 * A SQL Server schema from a 7K package.
 *
 * A package is 7K's ownership boundary and a schema is SQL Server's, so the mapping is the faithful
 * one. SQL Server schemas do not nest, so the dots become underscores: `acme.retail.sales` is
 * `acme_retail_sales` and not three levels of anything.
 */
export function schemaFor(pkg: string, override: string, casing: Casing): string {
  if (override !== "") return override;
  if (pkg === "") return "dbo";
  return casing === "snake" ? snake(pkg) : pascal(pkg);
}

/** A column name from a flattened path: `total.currency` becomes `TotalCurrency` or `total_currency`. */
export const columnName = (path: readonly string[], casing: Casing): string =>
  casing === "snake"
    ? path.map((p) => snake(p)).join("_")
    : path.map((p) => pascal(p)).join("");

/** A child table's name: the holder, then the field that holds it. */
export const childName = (holder: string, path: readonly string[], casing: Casing): string =>
  casing === "snake"
    ? [snake(holder), ...path.map((p) => snake(p))].join("_")
    : [pascal(holder), ...path.map((p) => pascal(p))].join("");

export const qualified = (id: NodeId): string => (id.pkg === "" ? id.name : `${id.pkg}.${id.name}`);

export const qnameOf = (decl: Decl): string => qualified(decl.id);

/** `[schema].[table]`, which is how every reference in the script is written. */
export const tableRef = (schema: string, table: string): string =>
  `${bracket(schema)}.${bracket(table)}`;

/**
 * A constraint's name.
 *
 * Named rather than left to SQL Server, which would invent something like `CK__PlaceOrd__total__3B75D760`
 * — different on every database, so two deployments of one model could not be diffed and an error
 * message could not be looked up. The name says what it checks.
 */
export const constraintName = (
  kind: "CK" | "PK" | "FK" | "UQ" | "IX",
  table: string,
  what: readonly string[],
  casing: Casing,
): string => [kind, cased(table, casing), ...what.map((w) => cased(w, casing))].join("_");
