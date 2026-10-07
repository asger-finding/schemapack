import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/schemapack.ts";

test("rejects a declared array length larger than the buffer", () => {
  assert.throws(() => build({ tiles: [[["uint8"]]] }).decode(new Uint8Array([0xff, 0xff, 0xff, 0x7f])), RangeError);
});

test("rejects a declared length of packed booleans larger than the buffer", () => {
  assert.throws(() => build(["bool"]).decode(new Uint8Array([17, 0xff, 0xff])), RangeError);
  assert.deepEqual(build(["bool"]).decode(new Uint8Array([16, 0xff, 0xff])).length, 16);
});

test("decodes long ASCII strings in linear time", () => {
  const built = build("string");
  const long = "a".repeat(1000000);
  const start = performance.now();
  assert.equal(built.decode(built.encode(long)), long);
  assert.ok(performance.now() - start < 30);
});

test("decodes floats that end exactly at the end of the data", () => {
  assert.deepEqual(build(["float32"]).decode(new Uint8Array([2, 0x3f, 0x80, 0, 0, 0x40, 0, 0, 0])), [1, 2]);
});

test("rejects truncated data", () => {
  const built = build({ a: "float64", b: "uint8" });
  const bytes = built.encode({ a: 1.5, b: 2 });
  assert.throws(() => built.decode(bytes.subarray(0, 8)), RangeError);
  assert.throws(() => build({ id: "varuint", name: "string" }).decode(new Uint8Array([0x80])), RangeError);
});

test("never decodes a varuint as negative", () => {
  assert.equal(build("varuint").decode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f])), 0xffffffff);
  assert.throws(() => build("varuint").decode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x10])), RangeError);
  assert.throws(() => build("varuint").decode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])), RangeError);
});

test("decodes ArrayBuffers, Buffers and views with an offset", () => {
  const built = build({ id: "varuint", name: "string", position: "float32" });
  const value = { id: 300, name: "tank", position: 1.5 };
  const bytes = built.encode(value);
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  assert.deepEqual(built.decode(padded.subarray(3)), value);
  assert.deepEqual(built.decode(new DataView(padded.buffer, 3)), value);
  assert.deepEqual(built.decode(bytes.slice().buffer), value);
  assert.deepEqual(built.decode(Buffer.from(bytes)), value);
});
