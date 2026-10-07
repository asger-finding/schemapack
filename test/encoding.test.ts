import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/schemapack.ts";

test("keeps earlier results intact while later messages share the buffer", () => {
  const built = build({ id: "uint16", name: "string" });
  const results = Array.from({ length: 5000 }, (_, i) => built.encode({ id: i, name: `tank${i}` }));
  results.push(build("string").encode("x".repeat(100000)));
  results.forEach((bytes, i) => {
    if (i < 5000) assert.deepEqual(built.decode(bytes), { id: i, name: `tank${i}` });
  });
});

test("encodes an empty schema to zero bytes", () => {
  assert.equal(build({}).encode({}).length, 0);
});

test("validates values when encoding, unless told not to", () => {
  assert.throws(() => build({ "position?": { "x?": "uint8" } }).encode({ position: [] as never }), TypeError);
  assert.throws(() => build("float16").encode(70000), TypeError);
  assert.equal(build({ "position?": { x: "uint8" } }).encode({ position: null }).length, 1);
  assert.doesNotThrow(() => build({ count: "uint8" }, false).encode({ count: 256 }));
});

test("rejects fractions and NaN for integer types", () => {
  for (const type of ["int8", "uint8", "int16", "uint16", "int32", "uint32", "varuint", "varint"]) {
    const built = build(type);
    assert.throws(() => built.encode(1.5), TypeError, type);
    assert.throws(() => built.encode(NaN), TypeError, type);
  }
  assert.ok(Number.isNaN(build("float32").decode(build("float32").encode(NaN))));
});

test("refuses to encode from inside another encode", () => {
  const outer = build({ a: "uint8", b: "uint8" });
  const inner = build("uint8");
  const value = {
    a: 1,
    get b() {
      inner.encode(99);
      return 2;
    }
  };
  assert.throws(() => outer.encode(value), /another encode/);
  assert.deepEqual([...outer.encode({ a: 1, b: 2 })], [1, 2]);
});

test("lets go of a buffer grown for a large message", () => {
  const large = build("buffer").encode(new Uint8Array(4 << 20));
  const small = build("uint8").encode(1);
  assert.ok(large.buffer.byteLength > 4 << 20);
  assert.ok(small.buffer.byteLength < 1 << 20);
});

test("recovers after a failed encode", () => {
  const built = build({ count: "uint8", name: "string" });
  assert.throws(() => built.encode({ count: 300, name: "a" }), TypeError);
  assert.deepEqual(built.decode(built.encode({ count: 3, name: "b" })), { count: 3, name: "b" });
});
