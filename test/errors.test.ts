import { test } from "node:test";
import assert from "node:assert/strict";
import { build, addTypeAlias } from "../src/schemapack.ts";
import type { Schema } from "../src/schemapack.ts";

function thrown(run: () => unknown, type: typeof TypeError | typeof RangeError): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof type, String(error));
    return error.message;
  }
  throw new Error("expected an error");
}

const typeError = (run: () => unknown) => thrown(run, TypeError);
const rangeError = (run: () => unknown) => thrown(run, RangeError);

test("names where a schema goes wrong", () => {
  const cases: [Schema, string][] = [
    ["uint7", 'schemapack: unknown type "uint7"'],
    [{ tanks: [{ x: "uint7" }] }, 'schemapack: unknown type "uint7" at tanks[].x'],
    [{ pair: ["nope", "uint8"] }, 'schemapack: unknown type "nope" at pair[0]'],
    [["nope"], 'schemapack: unknown type "nope" at value[]'],
    [{ tanks: [{ "my key": "nope" }] }, 'schemapack: unknown type "nope" at tanks[]["my key"]'],
    [{ tanks: [{ x: null as never }] }, "schemapack: schema at tanks[].x must be a type name, object or array, got null"],
    [{ tanks: [] as never }, "schemapack: array at tanks needs at least one item"],
    [[] as never, "schemapack: array needs at least one item"],
    [{ tanks: [{}] }, "schemapack: empty objects are only allowed as the whole schema, found one at tanks[]"],
    [[["uint8", {}, "uint8"]], "schemapack: empty objects are only allowed as the whole schema, found one at value[][1]"],
    [{ a: { b: {} } }, "schemapack: empty objects are only allowed as the whole schema, found one at a.b"],
    [{ tanks: [{ x: "uint8", "x?": "uint8" }] }, 'schemapack: duplicate field "x" at tanks[]'],
    [{ tanks: [{ ["__proto__"]: "uint8" }] }, 'schemapack: "__proto__" cannot be a field name at tanks[]']
  ];
  for (const [schema, expected] of cases) assert.equal(typeError(() => build(schema)), expected);
});

test("explains rejected type aliases", () => {
  assert.equal(typeError(() => { addTypeAlias("uint8", "string"); }), 'schemapack: "uint8" is a built-in type and cannot be an alias');
  assert.equal(typeError(() => { addTypeAlias("Bool", "uint8"); }), 'schemapack: "Bool" is a built-in type and cannot be an alias');
  assert.equal(typeError(() => { addTypeAlias("ammo", "nope"); }), 'schemapack: unknown type "nope"');
});

test("names the value that fails validation and what it should be", () => {
  const game = build({ tanks: [{ x: "uint8", y: "float32", name: "string", alive: "bool", "hp?": "int16", data: "buffer" }], flags: ["bool"], pair: ["string", "uint8"] });
  const tank = { x: 1, y: 1, name: "a", alive: true, data: new Uint8Array() };
  const valid = { tanks: [tank], flags: [true], pair: ["a"] as [string, ...number[]] };
  const cases: [unknown, string][] = [
    [{ ...valid, tanks: [tank, tank, { ...tank, x: 300 }] }, "schemapack: tanks[2].x must be a uint8 from 0 to 255, got 300"],
    [{ ...valid, tanks: [{ ...tank, x: 1.5 }] }, "schemapack: tanks[0].x must be a uint8 from 0 to 255, got 1.5"],
    [{ ...valid, tanks: [{ ...tank, hp: NaN }] }, "schemapack: tanks[0].hp must be an int16 from -32768 to 32767, got NaN"],
    [{ ...valid, tanks: [{ ...tank, y: Infinity }] }, "schemapack: tanks[0].y must be a float32 from -3.40e+38 to 3.40e+38, got Infinity"],
    [{ ...valid, tanks: [{ ...tank, name: 5 }] }, "schemapack: tanks[0].name must be a string, got 5"],
    [{ ...valid, tanks: [{ ...tank, alive: 1 }] }, "schemapack: tanks[0].alive must be a boolean, got 1"],
    [{ ...valid, tanks: [{ ...tank, data: [1] }] }, "schemapack: tanks[0].data must be a Uint8Array, got an array"],
    [{ ...valid, tanks: [tank, null] }, "schemapack: tanks[1] must be an object, got null"],
    [{ ...valid, tanks: "abc" }, 'schemapack: tanks must be an array, got "abc"'],
    [{ ...valid, flags: [true, true, false, 0] }, "schemapack: flags[3] must be a boolean, got 0"],
    [{ ...valid, pair: [5] }, "schemapack: pair[0] must be a string, got 5"],
    [{ ...valid, pair: ["a", 1, 999] }, "schemapack: pair[2] must be a uint8 from 0 to 255, got 999"]
  ];
  for (const [value, expected] of cases) assert.equal(typeError(() => game.encode(value as never)), expected);
});

test("calls a value without a field name after where it sits", () => {
  assert.equal(typeError(() => build("int8").encode(200)), "schemapack: value must be an int8 from -128 to 127, got 200");
  assert.equal(typeError(() => build(["uint8"]).encode([1, 2, -1])), "schemapack: value[2] must be a uint8 from 0 to 255, got -1");
  assert.equal(typeError(() => build({ a: "uint8" }).encode(undefined as never)), "schemapack: value must be an object, got undefined");
  assert.equal(typeError(() => build({ "my key": "uint8" }).encode({ "my key": -1 })), 'schemapack: value["my key"] must be a uint8 from 0 to 255, got -1');
});

test("describes what was passed instead of printing it raw", () => {
  const built = build("uint8");
  assert.match(typeError(() => built.encode({} as never)), /got an object$/);
  assert.match(typeError(() => built.encode([1] as never)), /got an array$/);
  assert.match(typeError(() => built.encode("1" as never)), /got "1"$/);
  assert.match(typeError(() => built.encode(5n as never)), /got 5n$/);
  assert.match(typeError(() => built.encode((() => 1) as never)), /got a function$/);
});

test("reports every kind of truncated or oversized data the same way", () => {
  const truncated = "schemapack: data ends before the message does";
  assert.equal(rangeError(() => build({ a: "float64" }).decode(new Uint8Array([1, 2]))), truncated);
  assert.equal(rangeError(() => build(["float32"]).decode(new Uint8Array([2, 0x3f, 0x80, 0, 0, 0x40]))), truncated);
  assert.equal(rangeError(() => build({ a: "uint8", b: "float64" }).decode(new Uint8Array([1, 0x3f, 0xf0, 0, 0, 0, 0, 0]))), truncated);
  assert.equal(rangeError(() => build("string").decode(new Uint8Array([5, 97]))), truncated);
  assert.equal(rangeError(() => build(["string"]).decode(new Uint8Array([0xff, 0xff, 0xff, 0x7f]))), truncated);
  assert.equal(rangeError(() => build("varuint").decode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))), "schemapack: malformed varuint");
});

test("explains input to decode that is not binary data", () => {
  const built = build("uint8");
  assert.equal(typeError(() => built.decode(5 as never)), "schemapack: decode needs a Uint8Array, ArrayBuffer or other ArrayBufferView, got 5");
  for (const input of ["abc", [1], null, {}]) assert.match(typeError(() => built.decode(input as never)), /^schemapack: decode needs/);
});
