import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/schemapack.ts";

test("encodes fields in sorted key order like 1.x", () => {
  const built = build({ name: "string", age: "uint8", weight: "float32" });
  const bytes = built.encode({ name: "John Smith", age: 32, weight: 188.5 });
  assert.deepEqual([...bytes], [0x20, 0x0a, 0x4a, 0x6f, 0x68, 0x6e, 0x20, 0x53, 0x6d, 0x69, 0x74, 0x68, 0x43, 0x3c, 0x80, 0x00]);
});

test("writes fixed array items before the total length like 1.x", () => {
  assert.deepEqual([...build(["uint8", "uint8"]).encode([7, 1, 2])], [7, 3, 1, 2]);
  assert.deepEqual([...build({ x: ["uint8", ["uint8", "uint8"]] }).encode({ x: [5, [7, 1], [8, 2, 3]] })], [5, 3, 7, 2, 1, 8, 3, 2, 3]);
});

test("encodes sibling arrays inside array items in key order", () => {
  const built = build([{ a: ["uint8"], b: ["uint8"] }]);
  assert.deepEqual([...built.encode([{ a: [1, 2], b: [3] }, { a: [4], b: [5, 6] }])], [2, 2, 1, 2, 1, 3, 1, 4, 2, 5, 6]);
});

test("packs the booleans of an object into one bitfield where the first sits", () => {
  const built = build({ _typeId: "uint8", back: "bool", forward: "bool", x: "uint8", locked: "bool" });
  assert.deepEqual([...built.encode({ _typeId: 2, back: false, forward: true, x: 9, locked: true })], [2, 0b110, 9]);
});

test("spills packed booleans into further bytes after eight", () => {
  const schema = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`b${i}`, "bool"]));
  const value = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`b${i}`, i == 0 || i == 8]));
  assert.deepEqual([...build(schema).encode(value)], [0b1, 0b1]);
});

test("packs arrays of booleans eight to a byte after the length", () => {
  const values = [true, false, false, true, false, false, false, false, true, true];
  assert.deepEqual([...build(["bool"]).encode(values)], [10, 0b1001, 0b11]);
});

test("sets a presence bit per optional field and skips absent values", () => {
  const built = build({ "health?": "varuint", id: "uint8", "name?": "string" });
  assert.deepEqual([...built.encode({ id: 4 })], [0b00, 4]);
  assert.deepEqual([...built.encode({ health: 300, id: 4 })], [0b01, 0xac, 0x02, 4]);
  assert.deepEqual([...built.encode({ id: 4, name: "a" })], [0b10, 4, 1, 0x61]);
});

test("stores float16 as two big-endian bytes", () => {
  assert.deepEqual([...build("float16").encode(1.5)], [0x3e, 0x00]);
  assert.deepEqual([...build("float16").encode(-65504)], [0xfb, 0xff]);
});
