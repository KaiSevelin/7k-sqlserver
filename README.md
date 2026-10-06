# 7k-sqlserver

A [7K](https://github.com/KaiSevelin/7k) provider that generates **SQL Server (T-SQL)** DDL from a 7K
model: tables for messages and records, with the model's rules enforced by the database.

**The data layer only.** 7K describes three layers — Data, Topology, Process — and only the first has an
honest translation into SQL. A pipe's delivery guarantee is not a table; a saga is not a constraint.
Those are refused rather than approximated.

## What it generates

| From the model | In T-SQL |
| --- | --- |
| `message`, `record` | a table, with envelope columns and a message id primary key |
| nested `record` | flattened into the holder's table |
| `[T]` list | a child table keyed by parent and `Ordinal`, cascade-deleted |
| `map<K,V>` | a child table keyed by parent and key |
| `value`, field constraints | `CHECK` constraints, intersected along a value chain |
| `invariant` | a `CHECK` with explicit `IS NOT NULL` guards (see below) |
| `enum` | a `CHECK` over the member names as written |
| `unique` on a list | a unique index on the child table |
| `since` (a later version's field) | nullable, because older rows do not have it |

Types are chosen to not lose: `BIGINT` for `int`, `NVARCHAR` at the declared length, `DATETIME2(6)` for
`instant`, `BIGINT` milliseconds for `duration`, `DECIMAL(p,s)` exactly as declared.

## Two things SQL gets wrong by default

**An absent operand.** 7K says a comparison with an absent operand is **false** — "absent differs from
absent is as unfounded as absent equals absent". SQL says `UNKNOWN`, and a `CHECK` *passes* on
`UNKNOWN`. So an invariant naming an optional field would be silently satisfied by leaving it out.
Every generated invariant carries explicit `IS NOT NULL` guards to restore the model's meaning.

**Collation.** 7K names are case-insensitive (D40) but *values* are not. Under a default CI collation the
enum check accepted `WEB` where the model declares `Web`, and a `unique` list rejected `red` next to
`RED`. Columns are emitted `COLLATE Latin1_General_100_BIN2` so the database agrees with the language.

Both were found by running the DDL, not by reading it.

## Options

| Option | Values | Default |
| --- | --- | --- |
| `schema` | string | `""` |
| `casing` | `pascal` \| `snake` | `pascal` |
| `idColumn` | string | `messageId` |
| `collation` | string | `Latin1_General_100_BIN2` |
| `records` | boolean | `false` |
| `checks` | boolean | `true` |
| `drop` | boolean | `false` |

## Verification

```
npm test         # 52 tests, including what this provider may depend on
npm run verify   # executes the DDL on SQL Server LocalDB, then 20 accept/reject cases
```

`npm run verify` creates a database, runs the generated DDL, and inserts rows designed to be rejected —
one rule at a time. Each case is a valid row with a **single** column varied, because a hand-written
reject case that happens to break a second rule is refused for the wrong reason and proves nothing. An
earlier version of this harness had exactly that defect: every reject case omitted two optional fields,
so each was caught by an unrelated invariant and the rule under test was never reached.

## What it depends on

The 7K **language** (`@sevenk/core`, for the IR) and the **provider contract** (`@sevenk/provider`,
which is types and contains no code). Deliberately *not* `@sevenk/generate`, the host that runs
providers — there is more than one host, and a provider is not supposed to be able to tell which one
called it. `test/coupling.test.ts` holds that line, and pins that nothing in `src/` can reach a
filesystem, a network or a subprocess.

## Status

Not yet installable on its own: `package.json` resolves `@sevenk/core` and `@sevenk/provider` through
`file:../7K/packages/...`, so it currently expects a checkout of
[7K](https://github.com/KaiSevelin/7k) beside this one. `npm run verify` needs SQL Server LocalDB.

Apache-2.0.
