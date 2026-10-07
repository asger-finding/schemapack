import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/schemapack.ts";
import type { Schema } from "../src/schemapack.ts";

function roundTrip(schema: Schema, value: unknown): unknown {
  const built = build(schema);
  return built.decode(built.encode(value));
}

test("round-trips strings outside the ASCII loop", () => {
  const strings = ["", "blåbærgrød", "🎮 tank", "﻿bom", "a".repeat(200), "ø".repeat(200), "🎮".repeat(5000)];
  assert.deepEqual(roundTrip(["string"], strings), strings);
});

test("round-trips buffers as plain Uint8Arrays", () => {
  const decoded = roundTrip({ data: "buffer" }, { data: Buffer.from([1, 2, 3]) }) as { data: Uint8Array };
  assert.equal(decoded.data.constructor, Uint8Array);
  assert.deepEqual([...decoded.data], [1, 2, 3]);
});

test("round-trips varint and varuint edges", () => {
  const varuints = [0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 0x7fffffff];
  const varints = [0, -1, 63, -64, 64, -65, 0x3fffffff, -0x40000000];
  assert.deepEqual(roundTrip(["varuint"], varuints), varuints);
  assert.deepEqual(roundTrip(["varint"], varints), varints);
});

test("round-trips packed booleans in objects, tuples and arrays", () => {
  const schema = { flags: ["bool"], pair: ["bool", "uint8", "bool"], tanks: [{ forward: "bool", id: "uint8", locked: "bool" }] };
  const value = {
    flags: [true, false, true, true, false, false, false, true, true],
    pair: [true, 3, false, true, true],
    tanks: [{ forward: true, id: 1, locked: false }, { forward: false, id: 2, locked: true }]
  };
  assert.deepEqual(roundTrip(schema, value), value);
  assert.deepEqual(roundTrip({ flags: ["bool"] }, { flags: [] }), { flags: [] });
});

test("leaves absent optional fields out of the decoded object", () => {
  const schema = { "position?": { x: "float32", y: "float32" }, id: "string", "alive?": "bool", "tags?": ["string"] };
  assert.deepEqual(roundTrip(schema, { id: "a" }), { id: "a" });
  assert.deepEqual(roundTrip(schema, { id: "a", position: null, alive: undefined }), { id: "a" });
  assert.deepEqual(roundTrip(schema, { id: "a", alive: false, tags: [] }), { id: "a", alive: false, tags: [] });
  assert.deepEqual(roundTrip(schema, { id: "a", position: { x: 1.5, y: -2 }, alive: true, tags: ["x"] }), { id: "a", position: { x: 1.5, y: -2 }, alive: true, tags: ["x"] });
});

test("ignores inherited properties for fields named like Object.prototype members", () => {
  const schema = { "constructor?": "bool", "toString?": "uint8", "valueOf?": ["uint8"], hasOwnProperty: "string" };
  for (const validate of [true, false]) {
    const built = build(schema, validate);
    assert.deepEqual(built.decode(built.encode({ hasOwnProperty: "a" } as never)), { hasOwnProperty: "a" });
    const full = { constructor: true, toString: 7, valueOf: [1, 2], hasOwnProperty: "b" };
    assert.deepEqual({ ...built.decode(built.encode(full)) }, full);
  }
});

test("round-trips optional fields inside repeated items", () => {
  const value = [{ id: 1 }, { id: 2, note: "hi" }, { id: 3 }];
  assert.deepEqual(roundTrip([{ id: "uint8", "note?": "string" }], value), value);
});

const view = new DataView(new ArrayBuffer(2));

test("rounds float16 like DataView.setFloat16", { skip: !("setFloat16" in DataView.prototype) && "no native float16 to compare against" }, () => {
  const built = build("float16");
  const unchecked = build("float16", false);
  const samples = [0, -0, 1, -1, 0.1, 1 / 3, 65504, 65519.99, 65520, 1e-8, 5.960464477539063e-8, 2.98e-8, 6.1e-5, 1024.5, 2049, 2051, NaN, Infinity, -Infinity];
  for (let i = 0; i < 100000; i++) samples.push((Math.random() - 0.5) * 2 ** (Math.random() * 40 - 25));
  for (const sample of samples) {
    view.setFloat16(0, sample);
    assert.deepEqual([...unchecked.encode(sample)], [view.getUint8(0), view.getUint8(1)], String(sample));
  }
  for (let bits = 0; bits < 0x10000; bits++) {
    view.setUint16(0, bits);
    assert.ok(Object.is(built.decode(new Uint8Array([bits >> 8, bits & 0xff])), view.getFloat16(0)), String(bits));
  }
});
