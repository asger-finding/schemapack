import { deepEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { bench, do_not_optimize, group, run, summary } from "mitata";
import protobuf from "protobufjs";
import avro from "avsc";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { FLOAT32_OPTIONS, Packr } from "msgpackr";
import { build } from "../src/schemapack.ts";
import type { Schema } from "../src/schemapack.ts";
import { benchmarkChart } from "./chart.ts";

const tank = { playerId: "string", x: "float32", y: "float32", rotation: "float32", forward: "bool", back: "bool", left: "bool", right: "bool", fireDown: "bool" } as const;
const projectile = { id: "string", playerId: "string", type: "int8", x: "float32", y: "float32", speedX: "float32", speedY: "float32" } as const;
const tankUpdate = { playerId: "string", "x?": "float32", "y?": "float32", "rotation?": "float32", "forward?": "bool", "back?": "bool", "left?": "bool", "right?": "bool", "fireDown?": "bool" } as const;

const proto = protobuf.parse(`
  syntax = "proto3";
  message Attributes { uint32 str = 1; uint32 agi = 2; uint32 int = 3; }
  message Player { uint32 health = 1; bool jumping = 2; repeated sint32 position = 3; Attributes attributes = 4; }
  message Tank { string playerId = 1; float x = 2; float y = 3; float rotation = 4; bool forward = 5; bool back = 6; bool left = 7; bool right = 8; bool fireDown = 9; }
  message Projectile { string id = 1; string playerId = 2; sint32 type = 3; float x = 4; float y = 5; float speedX = 6; float speedY = 7; }
  message State { uint32 typeId = 1; repeated Tank tanks = 2; repeated Projectile projectiles = 3; }
  message TankUpdate { string playerId = 1; optional float x = 2; optional float y = 3; optional float rotation = 4; optional bool forward = 5; optional bool back = 6; optional bool left = 7; optional bool right = 8; optional bool fireDown = 9; }
  message Delta { uint32 typeId = 1; repeated TankUpdate tanks = 2; }
`, { keepCase: true }).root;

const avroTank = [{ name: "playerId", type: "string" }, ...["x", "y", "rotation"].map(field => ({ name: field, type: "float" })), ...["forward", "back", "left", "right", "fireDown"].map(field => ({ name: field, type: "boolean" }))];
const avroProjectile = [{ name: "id", type: "string" }, { name: "playerId", type: "string" }, { name: "type", type: "int" }, ...["x", "y", "speedX", "speedY"].map(field => ({ name: field, type: "float" }))];

/* Run one payload per process, since libraries that specialise on the first shapes they see slow down for later ones */
const payloads: Record<string, { title: string; description: string; schema: Schema; message: string; avroSchema: avro.Schema; optionalFields: boolean; value: unknown } | undefined> = {
  player: {
    title: "Player",
    description: "Player example from README",
    schema: { health: "varuint", jumping: "bool", position: ["int16"], attributes: { str: "uint8", agi: "uint8", int: "uint8" } },
    message: "Player",
    optionalFields: false,
    avroSchema: { type: "record", name: "Player", fields: [{ name: "health", type: "int" }, { name: "jumping", type: "boolean" }, { name: "position", type: { type: "array", items: "int" } }, { name: "attributes", type: { type: "record", name: "Attributes", fields: [{ name: "str", type: "int" }, { name: "agi", type: "int" }, { name: "int", type: "int" }] } }] },
    value: { health: 4000, jumping: false, position: [-540, 343, 1201], attributes: { str: 87, agi: 42, int: 22 } }
  },
  state: {
    title: "Game state",
    description: "4 tanks and 12 projectiles",
    schema: { typeId: "uint8", tanks: [tank], projectiles: [projectile] },
    message: "State",
    optionalFields: false,
    avroSchema: { type: "record", name: "State", fields: [{ name: "typeId", type: "int" }, { name: "tanks", type: { type: "array", items: { type: "record", name: "Tank", fields: avroTank } } }, { name: "projectiles", type: { type: "array", items: { type: "record", name: "Projectile", fields: avroProjectile } } }] },
    value: {
      typeId: 1,
      tanks: Array.from({ length: 4 }, (_, i) => ({ playerId: `10000${i}`, x: 12.5 * i, y: 7.25, rotation: 1.5, forward: true, back: false, left: false, right: true, fireDown: i == 0 })),
      projectiles: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, playerId: "100001", type: 1, x: i * 3.5, y: i * 2.25, speedX: 1.5, speedY: -2.5 }))
    }
  },
  delta: {
    title: "Game state delta",
    description: "Next tick of the game state, tanks sending only changed fields",
    schema: { typeId: "uint8", tanks: [tankUpdate] },
    message: "Delta",
    optionalFields: true,
    avroSchema: { type: "record", name: "Delta", fields: [{ name: "typeId", type: "int" }, { name: "tanks", type: { type: "array", items: { type: "record", name: "TankUpdate", fields: avroTank.map(field => (field.name == "playerId" ? field : { name: field.name, type: ["null", field.type], default: null })) } } }] },
    value: {
      typeId: 3,
      tanks: [{ playerId: "100000", x: 0.5, rotation: 1.75 }, { playerId: "100001", forward: false }, { playerId: "100002" }, { playerId: "100003", y: 8.5, fireDown: true }]
    }
  }
};

const name = process.argv[2];
const payload = payloads[name];
if (!payload) throw new Error(`Unknown payload ${name}, expected one of ${Object.keys(payloads).join(", ")}`);
const { title, description, schema, message, avroSchema, optionalFields, value } = payload;

interface Codec {
  encode(data: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

const built = build(schema);
const legacy = (createRequire(import.meta.url)("schemapack") as { build(schema: unknown): Codec }).build(structuredClone(schema));
const type = proto.lookupType(message);
const avroType = avro.Type.forSchema(avroSchema);
const packr = new Packr({ useRecords: true, useFloat32: FLOAT32_OPTIONS.ALWAYS });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Library {
  name: string;
  encode: (data: unknown) => Uint8Array;
  decode: (bytes: Uint8Array) => unknown;
  toPlain?: (decoded: unknown) => unknown;
}

const unsupported = optionalFields ? [{ name: "schemapack v1.4", note: "No optional fields" }] : [];
const libraries: Library[] = [
  { name: "schemapack v2", encode: data => built.encode(data), decode: bytes => built.decode(bytes) },
  ...(optionalFields ? [] : [{ name: "schemapack v1.4", encode: (data: unknown) => legacy.encode(data), decode: (bytes: Uint8Array) => legacy.decode(bytes) }]),
  { name: "Protocol Buffers", encode: data => type.encode(data as protobuf.Message).finish(), decode: bytes => type.decode(bytes), toPlain: decoded => type.toObject(decoded as protobuf.Message, { defaults: true }) },
  { name: "Avro", encode: data => avroType.toBuffer(data), decode: bytes => avroType.fromBuffer(bytes as Buffer) as unknown, toPlain: decoded => JSON.parse(JSON.stringify(decoded, (_, field: unknown) => field ?? undefined)) as unknown },
  { name: "msgpackr", encode: data => packr.pack(data), decode: bytes => packr.unpack(bytes) as unknown },
  { name: "MessagePack", encode: data => msgpackEncode(data, { forceFloat32: true }), decode: bytes => msgpackDecode(bytes) },
  { name: "JSON", encode: data => textEncoder.encode(JSON.stringify(data)), decode: bytes => JSON.parse(textDecoder.decode(bytes)) as unknown }
];

for (const library of libraries) {
  const decoded = library.decode(library.encode(value));
  deepEqual({ ...((library.toPlain ? library.toPlain(decoded) : decoded) as object) }, value, `${library.name} does not round-trip the ${name} payload`);
}
const sizes = libraries.map(library => library.encode(value).length);
console.log(`${name}: ${libraries.map((library, i) => `${library.name} ${sizes[i]} bytes`).join(", ")}`);

group(`${name} encode`, () => {
  summary(() => {
    for (const library of libraries) {
      bench(library.name, () => {
        do_not_optimize(library.encode(value));
      });
    }
  });
});

group(`${name} decode`, () => {
  summary(() => {
    for (const library of libraries) {
      const bytes = library.encode(value).slice();
      bench(library.name, () => {
        do_not_optimize(library.decode(bytes));
      });
    }
  });
});

/* Benchmarks come back in registration order, the encode group first */
const averages = (await run()).benchmarks.map(trial => trial.runs[0]?.stats?.avg ?? NaN);
const encodeTimes = averages.slice(0, libraries.length);
const decodeTimes = averages.slice(libraries.length);
const microseconds = Math.max(...averages) >= 2000;
const formatTime = (nanoseconds: number) => (microseconds ? `${(nanoseconds / 1000).toFixed(nanoseconds < 10000 ? 2 : 1)} µs` : `${Math.round(nanoseconds)} ns`);

const measured = libraries.map((library, i) => ({ name: library.name, size: sizes[i], encode: encodeTimes[i], decode: decodeTimes[i] }));
const rows = [measured[0], ...unsupported, ...measured.slice(1)];
const charts = new URL("./charts/", import.meta.url);
mkdirSync(charts, { recursive: true });
for (const theme of ["light", "dark"] as const) {
  writeFileSync(new URL(`${name}-${theme}.svg`, charts), benchmarkChart(title, `${description} ⋅ Lower is better`, rows, formatTime, theme));
}
