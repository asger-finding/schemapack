import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type * as Schemapack from "../src/schemapack.ts";

const schema = { id: "uint8", "flag?": "bool", name: "string" } as const;
const value = { id: 1, flag: true, name: "tank" };

test("loads through the package exports with require()", () => {
  const { build } = createRequire(import.meta.url)("@asger-finding/schemapack") as typeof Schemapack;
  const built = build(schema);
  assert.deepEqual(built.decode(built.encode(value)), value);
});

test("loads through the package exports with import", async () => {
  const { build } = (await import("@asger-finding/schemapack")) as typeof Schemapack;
  const built = build(schema);
  assert.deepEqual(built.decode(built.encode(value)), value);
});

test("exposes a global from the browser build", () => {
  const context: { schemapack?: typeof Schemapack } = { TextEncoder, TextDecoder } as never;
  runInNewContext(readFileSync(new URL("../dist/schemapack.min.js", import.meta.url), "utf8"), context);
  assert.ok(context.schemapack);
  const built = context.schemapack.build(schema);
  assert.deepEqual({ ...built.decode(built.encode(value)) }, value);
});
