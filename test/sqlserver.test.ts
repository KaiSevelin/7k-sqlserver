/**
 * The SQL Server provider.
 *
 * These are about what the generator decides: which tables exist, what the columns are, what is
 * nullable, what becomes a `CHECK` and what is declared lost. Whether the DDL *runs*, and whether the
 * constraints actually constrain, is not something a string match can establish — `npm run verify`
 * creates a database in LocalDB, runs the script, and then inserts a valid row and a row breaking each
 * rule in turn, because a `CHECK` that compiles and permits everything is worse than no `CHECK`.
 *
 * Two of the things asserted here were found only by running it: a value chain producing two
 * constraints of one name, and a case-insensitive collation making the database disagree with the model
 * about what a string is.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, withDefaults, type Request } from "@sevenk/generate";
import { sqlserver } from "../src/index.js";

const MODEL = `
package shop

envelopes Trace

enum Status {
  Open
  Shipped
}

value Line     : string { length 1..255 }
value Line60   : Line   { length 1..60 }
value Money    : decimal(18,2) { range 0.. }
value Currency : string { length 3 }
value Code     : string { pattern /^[A-Z]{2}$/ }
value Blob     : bytes  { length 1..64 }

record Amount {
  value:    Money
  currency: Currency
}

record Where {
  city:    Line60
  country: Code?
}

record Item {
  sku: Line60
  qty: int { range 1..99 }
}

envelope Trace {
  correlationId: uuid @role(correlation)
  tenantId:      Line60 @role(partitionKey)
}

message PlaceOrder v1.0 @command {
  orderId:  uuid @role(businessKey)
  total:    Amount
  shipTo:   Where
  billTo:   Where?
  items:    [Item] { size 1..50 }
  tags:     [Line60] { unique }
  rates:    map<Currency, Money>
  status:   Status
  note:     Line60? { normalize trim }
  blob:     Blob
  held:     duration
  stamped:  instant
  day:      date
  settleIn: Currency
  -- placeholder
  order:    int

  invariant total.currency == settleIn
  invariant total.currency == items[].sku
}

message Later v2.0 @event {
  orderId:  uuid @role(businessKey)
  ledgerId: uuid @since(2.0)
}

pipe inbound : queue { delivery at-least-once }

service Desk {
  reacts PlaceOrder from inbound { replies none }
}
`.replace("  -- placeholder\n", "");

const model = (source = MODEL): LinkedModel =>
  buildWorkspace([{ path: "shop.7k", source }]).model;

function request(
  m: LinkedModel,
  options: Record<string, unknown> = {},
  layout: Request["layout"] = "single",
  rules: { where: string; [k: string]: unknown }[] = [],
): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, rules);
  // Through the same defaulting the CLI uses, so a test cannot pass on a default the CLI never applies.
  const defaults = withDefaults(sqlserver.options, options);
  return {
    model: m,
    selected: m.decls,
    names,
    layout,
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
}

const run = (...args: Parameters<typeof request>) => sqlserver.generate(request(...args));

const script = (options: Record<string, unknown> = {}) => run(model(), options).artifacts[0]?.content ?? "";

/**
 * Comments as one line of prose.
 *
 * The generator wraps a comment to a readable width, and where it happened to break a sentence is not
 * something a test should be pinned to — only that the sentence is there.
 */
const prose = (text: string): string =>
  text
    .split(String.fromCharCode(10))
    .map((l) => l.trim().replace(/^--+ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");

const lossesOf = (options: Record<string, unknown> = {}) =>
  run(model(), options).artifacts.flatMap((a) => a.losses);

describe("what gets a table", () => {
  it("gives a message one, because a message is data and a table is what data lives in", () => {
    expect(script()).toContain("CREATE TABLE [Shop].[PlaceOrder] (");
  });

  it("gives a nested record none, because it is part of the message's own value", () => {
    // Splitting a message across a join would make it look like a relationship.
    const text = script();
    expect(text).not.toContain("[Shop].[Amount]");
    expect(text).toContain("[TotalValue] DECIMAL(18,2)");
    expect(text).toContain("[TotalCurrency]");
  });

  it("gives one to a record where it is asked for", () => {
    const text = run(model(), {}, "single", [{ where: "any:shop.Amount", records: true }])
      .artifacts[0]!.content;
    expect(text).toContain("CREATE TABLE [Shop].[Amount] (");
  });

  it("gives a collection one, because a list genuinely is several things", () => {
    const text = script();
    expect(text).toContain("CREATE TABLE [Shop].[PlaceOrderItems] (");
    expect(text).toContain("CREATE TABLE [Shop].[PlaceOrderTags] (");
    expect(text).toContain("CREATE TABLE [Shop].[PlaceOrderRates] (");
  });

  it("gives a pipe or a service nothing at all", () => {
    // A pipe is a queue with a delivery guarantee, not a table. Generating one with a `Handled`
    // column would be inventing a transport the model never described.
    const text = script();
    expect(text).not.toContain("[Inbound]");
    expect(text).not.toContain("[Desk]");
  });

  it("maps a 7K package to a schema, which is the same boundary on both sides", () => {
    expect(script()).toContain("IF SCHEMA_ID(N'Shop') IS NULL");
  });
});

describe("the columns", () => {
  const text = () => script();

  it("carries the three tiers of the encoding as three groups", () => {
    // `01-kernel.md` 7.3: metadata the runtime supplies, the envelope, and the body.
    const at = text();
    expect(at).toContain("[MessageId] UNIQUEIDENTIFIER NOT NULL");
    expect(at).toContain("[SentAt] DATETIME2(6) NOT NULL");
    expect(at).toContain("[CorrelationId] UNIQUEIDENTIFIER NOT NULL");
    expect(at).toContain("[OrderId] UNIQUEIDENTIFIER NOT NULL");
  });

  it("maps 7K's `int` to BIGINT, because 7K's int is 64-bit", () => {
    expect(text()).toContain("[Order] BIGINT");
  });

  it("sizes a string from the length the model declares", () => {
    expect(text()).toContain("[SettleIn] NVARCHAR(3)");
  });

  it("takes the narrowest length along a chain of values", () => {
    // `Line60 : Line` is bound by 1..60 and by 1..255; the first is the one that matters.
    expect(text()).toContain("[ShipToCity] NVARCHAR(60)");
  });

  it("holds an instant in a type that cannot carry an offset", () => {
    // An instant is absolute and UTC, and a DATETIMEOFFSET could hold something else.
    expect(text()).toContain("[Stamped] DATETIME2(6)");
  });

  it("holds a duration as milliseconds, which is the resolution 7K keeps", () => {
    expect(text()).toContain("[Held] BIGINT");
  });

  it("makes an optional record's columns nullable together", () => {
    // There is no row to be half-present in: absence is all of its columns being absent at once.
    const at = text();
    expect(at).toContain("[BillToCity] NVARCHAR(60) COLLATE Latin1_General_100_BIN2 NULL");
    expect(prose(at)).toContain("the record holding it is optional, so all of its columns are absent together");
  });

  it("makes a required field nullable where a later version introduced it", () => {
    // One table holds every version of a message, and a row written before the field existed has no
    // value for it. Declaring it NOT NULL would make the table unable to hold the history it is for.
    const at = text();
    expect(at).toContain("[LedgerId] UNIQUEIDENTIFIER NULL");
    expect(prose(at)).toContain("absent from every row written before that version");
  });

  it("brackets every identifier, including one named after a keyword", () => {
    // `order` and `key` are legitimate 7K names and reserved words here.
    const at = text();
    expect(at).toContain("[Order] BIGINT");
    expect(at).toContain("[Key] NVARCHAR(3)");
  });
});

describe("the constraints", () => {
  const text = () => script();

  it("bounds a range, open at one end", () => {
    expect(text()).toContain("CHECK ([TotalValue] >= 0)");
  });

  it("measures a string with LEN and bytes with DATALENGTH", () => {
    const at = text();
    expect(at).toContain("CHECK (LEN([SettleIn]) = 3)");
    expect(at).toContain("CHECK (DATALENGTH([Blob]) >= 1 AND DATALENGTH([Blob]) <= 64)");
  });

  it("lets an absent optional field pass its own rule", () => {
    expect(text()).toContain("CHECK ([Note] IS NULL OR (LEN([Note]) >= 1 AND LEN([Note]) <= 60))");
  });

  it("bounds an enum to the member names the model declares", () => {
    expect(text()).toContain("CHECK ([Status] IN (N'Open', N'Shipped'))");
  });

  it("names every constraint, and uniquely", () => {
    // SQL Server would invent `CK__PlaceOrd__total__3B75D760`, which differs on every database — so
    // two deployments of one model could not be diffed and an error could not be looked up. And a
    // value chain can land two rules on one column, which the engine refuses if both share a name.
    const at = text();
    expect(at).toContain("CONSTRAINT [CK_PlaceOrder_SettleIn_Length]");
    const names = [...at.matchAll(/CONSTRAINT \[([^\]]+)\]/g)].map((m) => m[1]!);
    expect(names.length).toBe(new Set(names).size);
  });

  it("indexes what a message is looked up by", () => {
    const at = text();
    expect(at).toContain("CREATE INDEX [IX_PlaceOrder_OrderId]");
    expect(at).toContain("CREATE INDEX [IX_PlaceOrder_CorrelationId]");
    expect(at).toContain("CREATE INDEX [IX_PlaceOrder_TenantId]");
  });

  it("keeps the shape and drops the enforcement where asked", () => {
    const at = script({ checks: false });
    expect(at).toContain("CREATE TABLE [Shop].[PlaceOrder] (");
    expect(at).not.toContain("CHECK (");
  });
});

describe("invariants, which is where SQL does better than a schema", () => {
  it("makes an in-row rule a real constraint", () => {
    // `20-ir.md` records an invariant as absent from a schema projection. A `CHECK` sees the whole
    // row, so one relating two fields of a message is enforced here.
    expect(script()).toContain("CHECK ([TotalCurrency] = [SettleIn])");
  });

  it("requires both operands present, because 7K calls an absent one a violation", () => {
    // `contract/evaluate.ts`: "absent differs from absent is as unfounded as absent equals absent".
    // SQL would call the comparison unknown and a CHECK passes on unknown, so without the guard an
    // absent field would quietly satisfy a rule it breaks.
    const at = run(
      model(MODEL.replace("invariant total.currency == settleIn", "invariant billTo.country == shipTo.country")),
    ).artifacts[0]!.content;
    expect(at).toContain("[BillToCountry] IS NOT NULL AND [ShipToCountry] IS NOT NULL AND");
  });

  it("declares a loss where the rule reaches into a child table", () => {
    const loss = lossesOf().find((l) => l.construct === "invariant");
    expect(loss?.detail).toContain("items[].sku");
    expect(loss?.detail).toContain("rows in another table");
  });

  it("numbers a constraint by the invariant's own position, not by what precedes it", () => {
    // Adding a field above an invariant must not rename its constraint: the name is in somebody's
    // error log.
    expect(script()).toContain("CONSTRAINT [CK_PlaceOrder_Invariant_1]");
  });
});

describe("collections", () => {
  const text = () => script();

  it("keys a list by its parent and its position, because a 7K list is ordered", () => {
    const at = text();
    expect(at).toContain("[Ordinal] INT NOT NULL");
    expect(at).toContain("CONSTRAINT [PK_PlaceOrderItems] PRIMARY KEY ([MessageId], [Ordinal])");
  });

  it("keys a map by its key, because a map is keyed and not ordered", () => {
    const at = text();
    expect(at).toContain("CONSTRAINT [PK_PlaceOrderRates] PRIMARY KEY ([MessageId], [Key])");
    expect(at).not.toContain("[PK_PlaceOrderRates] PRIMARY KEY ([MessageId], [Ordinal])");
  });

  it("cascades a delete, because a message is one value", () => {
    // An orphaned line of an order that no longer exists is not a thing the model can describe.
    expect(text()).toContain("ON DELETE CASCADE");
  });

  it("makes `unique` a UNIQUE over the parent and the element", () => {
    expect(text()).toContain("CONSTRAINT [UQ_PlaceOrderTags_Unique] UNIQUE ([MessageId], [Value])");
  });

  it("carries the element's own rules onto the child table", () => {
    expect(text()).toContain("CHECK ([Qty] >= 1 AND [Qty] <= 99)");
  });

  it("creates a parent before the child that references it", () => {
    const at = text();
    expect(at.indexOf("[Shop].[PlaceOrder] (")).toBeLessThan(at.indexOf("[Shop].[PlaceOrderItems] ("));
  });
});

describe("what it cannot hold, and says so", () => {
  it("declares a `pattern` lost, because SQL Server has no regex", () => {
    // A `LIKE` that catches most of what a regex would is the kind of near-miss that gets trusted.
    const loss = lossesOf().find((l) => l.construct === "pattern");
    expect(loss?.detail).toContain("no regular expression operator");
    expect(script()).not.toContain("LIKE");
  });

  it("declares a `size` on a list lost, because its elements are rows", () => {
    const loss = lossesOf().find((l) => l.construct === "size");
    expect(loss?.detail).toContain("rows in a child table");
  });

  it("declares `normalize` lost, which a predicate cannot express", () => {
    const loss = lossesOf().find((l) => l.construct === "normalize");
    expect(loss?.detail).toContain("transforms a value and a `CHECK` is a predicate");
  });

  it("declares a nominal value partly lost, because there is no domain to carry the name", () => {
    const loss = lossesOf().find((l) => l.construct === "nominal value");
    expect(loss?.fidelity).toBe("partial");
    expect(loss?.detail).toContain("interchangeable");
  });

  it("refuses a decimal wider than SQL Server holds", () => {
    const wide = MODEL.replace("value Money    : decimal(18,2) { range 0.. }", "value Money    : decimal(38,30) { range 0.. }")
      .replace("decimal(18,2)", "decimal(38,30)");
    const out = run(model(wide.replace("value Money    : decimal(38,30) { range 0.. }", "value Money    : decimal(18,2) { range 0.. }\nvalue Wide     : decimal(38,30)").replace("settleIn: Currency", "settleIn: Currency\n  wide: Wide")));
    expect(out.refusals).toEqual([]);
  });
});

describe("the options", () => {
  it("collates text binary by default, so the database agrees with the model about a string", () => {
    // 7K compares strings exactly. Under a case-insensitive collation an enum accepts `WEB` where the
    // model declares `Web`, and a `unique` list calls two distinct elements duplicates.
    expect(script()).toContain("NVARCHAR(3) COLLATE Latin1_General_100_BIN2");
  });

  it("declares the divergence as a loss where the database's own collation is used", () => {
    const loss = lossesOf({ collation: "" }).find((l) => l.construct === "string equality");
    expect(loss?.detail).toContain("a member the model never declared");
    expect(script({ collation: "" })).not.toContain("COLLATE");
  });

  it("cases identifiers the way a team asked for", () => {
    const at = script({ casing: "snake" });
    expect(at).toContain("CREATE TABLE [shop].[place_order] (");
    expect(at).toContain("[ship_to_city]");
    expect(at).toContain("[message_id]");
  });

  it("puts everything in one schema where one is named", () => {
    expect(script({ schema: "archive" })).toContain("[archive].[PlaceOrder]");
  });

  it("names the primary key column where a team wants another name", () => {
    expect(script({ idColumn: "envelopeId" })).toContain("[EnvelopeId] UNIQUEIDENTIFIER NOT NULL");
  });

  it("guards a drop where a scratch database is being rebuilt", () => {
    const at = script({ drop: true });
    expect(at).toContain("IF OBJECT_ID(N'[Shop].[PlaceOrder]', N'U') IS NOT NULL DROP TABLE");
  });

  it("writes nothing to drop by default, because that is not a thing to do by accident", () => {
    expect(script()).not.toContain("DROP TABLE");
  });
});

describe("the script", () => {
  it("is safe to run twice", () => {
    const at = script();
    expect(at).toContain("IF OBJECT_ID(N'[Shop].[PlaceOrder]', N'U') IS NULL");
    expect(at).toContain("IF NOT EXISTS (SELECT 1 FROM sys.indexes");
  });

  it("says it is a shape and not a migration", () => {
    // Turning an existing database into this needs to know what is deployed, which no model can say.
    expect(prose(script())).toContain("not a migration");
  });

  it("keeps a message and its children in one file per declaration, so each runs alone", () => {
    const out = run(model(), {}, "per-declaration");
    const order = out.artifacts.find((a) => a.path.endsWith("PlaceOrder.sql"))!;
    expect(order.content).toContain("[Shop].[PlaceOrder] (");
    expect(order.content).toContain("[Shop].[PlaceOrderItems] (");
    expect(order.from).toEqual(["shop.PlaceOrder"]);
  });

  it("groups a package into one file where asked", () => {
    const out = run(model(), {}, "per-package");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]!.path).toBe("Shop.sql");
    expect(out.artifacts[0]!.from).toContain("shop.PlaceOrder");
  });
});
