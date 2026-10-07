import { build } from "../src/schemapack.ts";

const tank = build({
  _typeId: "uint8",
  name: "string",
  position: ["float32"],
  pair: ["string", "uint8"],
  turret: { angle: "float16", "locked?": "bool" },
  "note?": "string",
  data: "buffer"
});

const decoded = tank.decode(new Uint8Array());
const typeId: number = decoded._typeId;
const name: string = decoded.name;
const position: number[] = decoded.position;
const pair: [string, ...number[]] = decoded.pair;
const angle: number = decoded.turret.angle;
const locked: boolean | null | undefined = decoded.turret.locked;
const note: string | null | undefined = decoded.note;
const data: Uint8Array = decoded.data;
const encoded: Uint8Array = tank.encode({ _typeId: 1, name: "a", position: [], pair: ["b"], turret: { angle: 0 }, data: new Uint8Array() });

// @ts-expect-error a required field is missing
tank.encode({ _typeId: 1, name: "a", position: [], pair: ["b"], data: new Uint8Array() });
// @ts-expect-error a field has the wrong type
tank.encode({ _typeId: "1", name: "a", position: [], pair: ["b"], turret: { angle: 0 }, data: new Uint8Array() });
// @ts-expect-error optional keys lose their question mark
tank.encode({ _typeId: 1, name: "a", position: [], pair: ["b"], turret: { angle: 0 }, data: new Uint8Array(), "note?": "x" });

export { typeId, name, position, pair, angle, locked, note, data, encoded };
