import { test } from "node:test";
import assert from "node:assert/strict";
import { build, addTypeAlias } from "../src/schemapack.ts";

test("keeps the case of type aliases", () => {
  addTypeAlias("edgeId", "uint32");
  addTypeAlias("ammo", "uint8");
  const built = build("edgeId");
  assert.equal(built.decode(built.encode(70000)), 70000);
  assert.throws(() => build("edgeid"), TypeError);
  assert.throws(() => build("Ammo"), TypeError);
});

test("accepts built-in types in any case", () => {
  const built = build({ a: " UINT8 ", b: "Bool" });
  assert.deepEqual(built.decode(built.encode({ a: 1, b: true })), { a: 1, b: true });
});

test("leaves the schema untouched", () => {
  const schema = { flag: "bool", list: ["UINT8"], "note?": "string" };
  build(schema);
  assert.deepEqual(schema, { flag: "bool", list: ["UINT8"], "note?": "string" });
});

test("quotes field names inside generated code", () => {
  const schema = { "it's": "uint8", 'quote"d': "uint8", "a\\b": "uint8" };
  const value = { "it's": 1, 'quote"d': 2, "a\\b": 3 };
  const built = build(schema);
  assert.deepEqual(built.decode(built.encode(value)), value);
});
