/*! schemapack | MIT License | https://github.com/asger-finding/schemapack, forked from https://github.com/phretaddin/schemapack */

interface DataTypes {
  boolean: boolean;
  bool: boolean;
  int8: number;
  uint8: number;
  int16: number;
  uint16: number;
  int32: number;
  uint32: number;
  float16: number;
  float32: number;
  float64: number;
  varuint: number;
  varint: number;
  string: string;
  buffer: Uint8Array;
}

export type Schema = string | readonly Schema[] | { readonly [key: string]: Schema };

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type Infer<S> =
  S extends keyof DataTypes ? DataTypes[S] :
  S extends string ? unknown :
  S extends readonly [...infer Fixed, infer Repeated] ? [...{ [I in keyof Fixed]: Infer<Fixed[I]> }, ...Infer<Repeated>[]] :
  S extends readonly (infer Item)[] ? Infer<Item>[] :
  Simplify<
    { -readonly [K in keyof S as K extends `${string}?` ? never : K]: Infer<S[K]> } &
    { -readonly [K in keyof S as K extends `${infer Name}?` ? Name : never]?: Infer<S[K]> | null | undefined }
  >;

export interface BuiltSchema<T> {
  encode(value: T): Uint8Array;
  decode(data: ArrayBuffer | ArrayBufferView): T;
}

type DataType = Exclude<keyof DataTypes, "bool">;

type Writer = (value: string) => string;

type TypeCode<T extends DataType> =
  T extends "string" | "buffer" ? object :
  T extends "varuint" | "varint" ? { range: [number, number]; write: Writer } :
  T extends "boolean" ? { size: number; write: Writer; read: string } :
  { size: number; range: [number, number]; write: Writer; read: string };

const maxFloat32 = 3.4028234663852886e+38;
const types: { [T in DataType]: TypeCode<T> } = {
  boolean: { size: 1, write: value => `bytes[o++] = ${value} ? 1 : 0;`, read: "bytes[o++] != 0" },
  int8: { size: 1, range: [-0x80, 0x7f], write: value => `bytes[o++] = ${value};`, read: "(bytes[o++] << 24) >> 24" },
  uint8: { size: 1, range: [0, 0xff], write: value => `bytes[o++] = ${value};`, read: "bytes[o++]" },
  int16: { size: 2, range: [-0x8000, 0x7fff], write: value => `view.setInt16(o, ${value}); o += 2;`, read: "((bytes[o++] << 24) >> 16) | bytes[o++]" },
  uint16: { size: 2, range: [0, 0xffff], write: value => `view.setUint16(o, ${value}); o += 2;`, read: "(bytes[o++] << 8) | bytes[o++]" },
  int32: { size: 4, range: [-0x80000000, 0x7fffffff], write: value => `view.setInt32(o, ${value}); o += 4;`, read: "(bytes[o++] << 24) | (bytes[o++] << 16) | (bytes[o++] << 8) | bytes[o++]" },
  uint32: { size: 4, range: [0, 0xffffffff], write: value => `view.setUint32(o, ${value}); o += 4;`, read: "((bytes[o++] << 24) | (bytes[o++] << 16) | (bytes[o++] << 8) | bytes[o++]) >>> 0" },
  float16: { size: 2, range: [-65504, 65504], write: value => `view.setUint16(o, h.toFloat16(${value})); o += 2;`, read: "h.fromFloat16((bytes[o++] << 8) | bytes[o++])" },
  float32: { size: 4, range: [-maxFloat32, maxFloat32], write: value => `view.setFloat32(o, ${value}); o += 4;`, read: "(o + 4 > end ? h.overrun() : view.getFloat32((o += 4) - 4))" },
  float64: { size: 8, range: [-Number.MAX_VALUE, Number.MAX_VALUE], write: value => `view.setFloat64(o, ${value}); o += 8;`, read: "(o + 8 > end ? h.overrun() : view.getFloat64((o += 8) - 8))" },
  varuint: { range: [0, 0x7fffffff], write: value => `o = h.writeVarUInt(bytes, o, ${value});` },
  varint: { range: [-0x40000000, 0x3fffffff], write: value => `o = h.writeVarUInt(bytes, o, (${value} << 1) ^ (${value} >> 31));` },
  string: {},
  buffer: {}
};

const aliasTypes: Record<string, DataType> = {};
let validateByDefault = true;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/* Encoded messages are views into one shared buffer. Each message starts where the last ended, and a message that runs out of room moves to a fresh buffer */
const scratch = { bytes: new Uint8Array(0), view: new DataView(new ArrayBuffer(0)), start: 0, busy: false };
const retainedBytes = 1 << 20;

function grow(o: number, size: number): number {
  const { bytes, start } = scratch;
  scratch.bytes = new Uint8Array(Math.max(8192, (o - start + size) * 2));
  scratch.view = new DataView(scratch.bytes.buffer);
  scratch.bytes.set(bytes.subarray(start, o));
  scratch.start = 0;
  return o - start;
}

function varUIntLength(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  if (value < 0x10000000) return 4;
  return 5;
}

function writeVarUInt(bytes: Uint8Array, o: number, value: number): number {
  while (value > 127) {
    bytes[o++] = (value & 127) | 128;
    value >>>= 7;
  }
  bytes[o++] = value & 127;
  return o;
}

function writeString(o: number, string: string): number {
  string = string || "";
  const length = string.length;
  if (o + 5 + length * 3 > scratch.bytes.length) o = grow(o, 5 + length * 3);
  const bytes = scratch.bytes;

  if (length < 128) {
    let i = 0;
    for (; i < length; i++) {
      const code = string.charCodeAt(i);
      if (code > 127) break;
      bytes[o + 1 + i] = code;
    }
    if (i == length) {
      bytes[o] = length;
      return o + 1 + length;
    }
  }

  /* Encode after the widest possible length prefix, then slide the bytes back if the real prefix is shorter */
  const reserved = varUIntLength(length * 3);
  const { written } = textEncoder.encodeInto(string, bytes.subarray(o + reserved));
  const prefix = varUIntLength(written);
  if (prefix < reserved) bytes.copyWithin(o + prefix, o + reserved, o + reserved + written);
  writeVarUInt(bytes, o, written);
  return o + prefix + written;
}

function writeBuffer(o: number, data: Uint8Array): number {
  if (o + 5 + data.length > scratch.bytes.length) o = grow(o, 5 + data.length);
  o = writeVarUInt(scratch.bytes, o, data.length);
  scratch.bytes.set(data, o);
  return o + data.length;
}

function readVarUInt(bytes: Uint8Array, o: number): number {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = bytes[o++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) {
      if (value > 0xffffffff) break;
      helpers.offset = o;
      return value;
    }
  }
  throw new RangeError("schemapack: malformed varuint");
}

function readString(bytes: Uint8Array, o: number, length: number): string {
  if (length > 127) return textDecoder.decode(bytes.subarray(o, o + length));
  let string = "";
  for (let i = o; i < o + length; i++) {
    const code = bytes[i];
    if (code > 127) return textDecoder.decode(bytes.subarray(o, o + length));
    string += String.fromCharCode(code);
  }
  return string;
}

function roundToEven(value: number): number {
  const rounded = Math.round(value);
  return rounded - value == 0.5 && rounded % 2 == 1 ? rounded - 1 : rounded;
}

/* Rounds straight from float64 to the nearest half float, ties to even, like DataView.setFloat16 */
function toFloat16(value: number): number {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  value = Math.abs(value);
  if (Number.isNaN(value)) return 0x7e00;
  if (value >= 65520) return sign | 0x7c00;
  if (value < 2 ** -14) return sign | roundToEven(value * 2 ** 24);
  let exponent = Math.floor(Math.log2(value));
  if (2 ** exponent > value) exponent--;
  else if (2 ** (exponent + 1) <= value) exponent++;
  return sign | (((exponent + 15) << 10) + roundToEven((value / 2 ** exponent - 1) * 1024));
}

function fromFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent == 0) return sign * mantissa * 2 ** -24;
  if (exponent == 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function overrun(): never {
  throw new RangeError("schemapack: data ends before the message does");
}

function describe(value: unknown): string {
  if (typeof value == "string") return JSON.stringify(value);
  if (typeof value == "bigint") return `${String(value)}n`;
  if (typeof value == "function") return "a function";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Uint8Array) return "a Uint8Array";
  if (typeof value == "object" && value != null) return "an object";
  return String(value);
}

function fail(value: unknown, expected: string, path: string): never {
  throw new TypeError(`schemapack: ${path} must be ${expected}, got ${describe(value)}`);
}

const helpers = { scratch, grow, writeVarUInt, writeString, writeBuffer, readVarUInt, readString, toFloat16, fromFloat16, overrun, fail, offset: 0 };

function findDataType(name: string): DataType | undefined {
  if (Object.hasOwn(aliasTypes, name)) return aliasTypes[name];
  const dataType = name.trim().toLowerCase();
  if (dataType == "bool") return "boolean";
  return Object.hasOwn(types, dataType) ? (dataType as DataType) : undefined;
}

function getDataType(name: string): DataType {
  const dataType = findDataType(name);
  if (!dataType) throw new TypeError(`schemapack: unknown type ${JSON.stringify(name)}`);
  return dataType;
}

function isArraySchema(schema: Schema): schema is readonly Schema[] {
  return Array.isArray(schema);
}

function isObjectSchema(schema: Schema): schema is Readonly<Record<string, Schema>> {
  return typeof schema == "object" && (schema as unknown) != null;
}

function isPacked(schema: Schema): boolean {
  return typeof schema == "string" && getDataType(schema) == "boolean";
}

interface Field {
  index: number;
  name: string | number;
  property: string;
  schema: Schema;
  optional: boolean;
  packed: boolean;
  flagged: boolean;
  presenceBit: number;
  valueBit: number;
}

/* Fields of an object, or the fixed leading items of an array, share a bitfield of presence bits for optional fields and value bits for booleans, written where the first such field sits */
interface Group {
  fields: Field[];
  flagBytes: number;
  first: Field | undefined;
}

function createGroup(entries: { name: string | number; schema: Schema; optional: boolean }[]): Group {
  let bit = 0;
  const fields = entries.map(({ name, schema, optional }, index) => {
    const packed = isPacked(schema);
    return { index, name, property: JSON.stringify(name), schema, optional, packed, flagged: optional || packed, presenceBit: optional ? bit++ : -1, valueBit: packed ? bit++ : -1 };
  });
  return { fields, flagBytes: Math.ceil(bit / 8), first: fields.find(field => field.flagged) };
}

function objectGroup(schema: Readonly<Record<string, Schema>>): Group {
  const entries = Object.keys(schema).map(key => {
    const optional = key.endsWith("?");
    return { name: optional ? key.slice(0, -1) : key, schema: schema[key], optional };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createGroup(entries);
}

function arrayParts(schema: readonly Schema[]): [Group, Schema] {
  return [createGroup(schema.slice(0, -1).map((item, i) => ({ name: i, schema: item, optional: false }))), schema[schema.length - 1]];
}

function groupMinimumSize(group: Group): number {
  return group.flagBytes + group.fields.reduce((sum, field) => sum + (field.flagged ? 0 : minimumSize(field.schema)), 0);
}

function minimumSize(schema: Schema): number {
  if (isArraySchema(schema)) return 1 + groupMinimumSize(arrayParts(schema)[0]);
  if (isObjectSchema(schema)) return groupMinimumSize(objectGroup(schema));
  const code = types[getDataType(schema)];
  return "size" in code ? code.size : 1;
}

const identifier = /^[A-Za-z_$][\w$]*$/;

function keyPath(path: string, name: string): string {
  if (identifier.test(name)) return path ? `${path}.${name}` : name;
  return `${path || "value"}[${JSON.stringify(name)}]`;
}

/* Mistakes are found here once, so they can be reported with where they are in the schema */
function checkSchema(schema: unknown, path: string) {
  const at = path ? ` at ${path}` : "";
  if (typeof schema == "string") {
    if (!findDataType(schema)) throw new TypeError(`schemapack: unknown type ${JSON.stringify(schema)}${at}`);
  } else if (Array.isArray(schema)) {
    if (schema.length == 0) throw new TypeError(`schemapack: array${at} needs at least one item`);
    schema.forEach((item, i) => {
      checkSchema(item, `${path || "value"}[${i == schema.length - 1 ? "" : i}]`);
    });
  } else if (typeof schema == "object" && schema != null) {
    if (path && Object.keys(schema).length == 0) throw new TypeError(`schemapack: empty objects are only allowed as the whole schema, found one at ${path}`);
    const names = new Set<string>();
    for (const [key, item] of Object.entries(schema)) {
      const name = key.endsWith("?") ? key.slice(0, -1) : key;
      if (name == "__proto__") throw new TypeError(`schemapack: "__proto__" cannot be a field name${at}`);
      if (names.has(name)) throw new TypeError(`schemapack: duplicate field ${JSON.stringify(name)}${at}`);
      names.add(name);
      checkSchema(item, keyPath(path, name));
    }
  } else {
    throw new TypeError(`schemapack: schema${at} must be a type name, object or array, got ${describe(schema)}`);
  }
}

/* A path is the pieces of a JavaScript expression naming the value, only evaluated when a check fails */
type Path = string[];

const fieldPath = (path: Path, name: string | number): Path => {
  if (typeof name == "number") return [...path, JSON.stringify(`${path.length ? "" : "value"}[${name}]`)];
  if (!path.length) return [JSON.stringify(keyPath("", name))];
  return [...path, JSON.stringify(identifier.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`)];
};
const indexPath = (path: Path, index: string): Path => [...path, JSON.stringify(path.length ? "[" : "value["), index, JSON.stringify("]")];
const pathCode = (path: Path) => (path.length ? path.join(" + ") : JSON.stringify("value"));

function formatLimit(limit: number): string {
  return Math.abs(limit) >= 1e21 ? limit.toPrecision(3) : String(limit);
}

function validation(dataType: DataType, value: string, path: Path): string {
  const failure = (expected: string) => `h.fail(${value}, ${JSON.stringify(expected)}, ${pathCode(path)})`;
  switch (dataType) {
    case "boolean":
    case "string":
      return `if (typeof ${value} != "${dataType}") ${failure(`a ${dataType}`)};`;
    case "buffer":
      return `if (!(${value} instanceof Uint8Array)) ${failure("a Uint8Array")};`;
    default: {
      const [min, max] = types[dataType].range;
      const type = dataType.startsWith("float") ? `typeof ${value} != "number"` : `!Number.isInteger(${value})`;
      const expected = `${dataType.startsWith("int") ? "an" : "a"} ${dataType} from ${formatLimit(min)} to ${formatLimit(max)}`;
      return `if (${type} || ${value} < ${min} || ${value} > ${max}) ${failure(expected)};`;
    }
  }
}

/* Consecutive bounded writes share one capacity check, flushed before anything that sizes itself, branches or loops */
function generateEncode(schema: Schema, validate: boolean): string {
  const lines = ["let bytes = h.scratch.bytes, view = h.scratch.view, o = h.scratch.start;"];
  let pendingSize = 0;
  let pendingLines: string[] = [];
  let id = 0;

  const refresh = "bytes = h.scratch.bytes; view = h.scratch.view;";
  const ensure = (size: string) => `if (o + ${size} > bytes.length) { o = h.grow(o, ${size}); ${refresh} }`;

  const fieldValue = (container: string, field: Field) => `${container}_${field.index}`;
  /* Fields named like Object.prototype members would otherwise pick up the inherited method when absent */
  const readField = (container: string, field: Field) =>
    typeof field.name == "string" && field.name in Object.prototype ? `(Object.hasOwn(${container}, ${field.property}) ? ${container}[${field.property}] : undefined)` : `${container}[${field.property}]`;

  function flush() {
    if (pendingSize > 0) lines.push(ensure(String(pendingSize)));
    lines.push(...pendingLines);
    pendingSize = 0;
    pendingLines = [];
  }

  function bounded(size: number, line: string) {
    pendingSize += size;
    pendingLines.push(line);
  }

  function writeFlags(group: Group, container: string, path: Path) {
    const masks: string[][] = Array.from({ length: group.flagBytes }, () => []);
    for (const field of group.fields.filter(item => item.flagged)) {
      const value = fieldValue(container, field);
      const check = validate && field.packed ? (field.optional ? `if (${value} != null) ` : "") + validation("boolean", value, fieldPath(path, field.name)) : "";
      pendingLines.push(`const ${value} = ${readField(container, field)}; ${check}`);
      if (field.optional) masks[field.presenceBit >> 3].push(`(${value} != null ? ${1 << (field.presenceBit & 7)} : 0)`);
      if (field.packed) masks[field.valueBit >> 3].push(`(${value} ? ${1 << (field.valueBit & 7)} : 0)`);
    }
    for (const mask of masks) bounded(1, `bytes[o++] = ${mask.join(" | ")};`);
  }

  function encodeGroup(group: Group, container: string, path: Path) {
    for (const field of group.fields) {
      if (field == group.first) writeFlags(group, container, path);
      if (field.packed) continue;
      if (field.optional) {
        const value = fieldValue(container, field);
        flush();
        lines.push(`if (${value} != null) {`);
        encodeNode(field.schema, value, fieldPath(path, field.name));
        flush();
        lines.push("}");
      } else {
        encodeNode(field.schema, readField(container, field), fieldPath(path, field.name));
      }
    }
  }

  function encodeNode(node: Schema, expression: string, path: Path) {
    const name = `v${id++}`;

    if (isArraySchema(node)) {
      const [group, repeated] = arrayParts(node);
      const length = `n${name}`;
      const index = `j${name}`;
      const first = group.fields.length;
      pendingLines.push(`const ${name} = ${expression}; ${validate ? `if (!Array.isArray(${name})) h.fail(${name}, "an array", ${pathCode(path)});` : ""} const ${length} = ${name}.length;`);
      encodeGroup(group, name, path);
      bounded(5, types.varuint.write(length));
      flush();

      if (isPacked(repeated)) {
        const packed = `p${name}`;
        const bit = `b${name}`;
        const item = `i${name}`;
        lines.push(
          ensure(`Math.ceil((${length} - ${first}) / 8)`),
          `for (let ${index} = ${first}; ${index} < ${length}; ${index} += 8) {`,
          `let ${packed} = 0;`,
          `for (let ${bit} = 0; ${bit} < 8 && ${index} + ${bit} < ${length}; ${bit}++) {`,
          `const ${item} = ${name}[${index} + ${bit}]; ${validate ? validation("boolean", item, indexPath(path, `(${index} + ${bit})`)) : ""}`,
          `if (${item}) ${packed} |= 1 << ${bit};`,
          "}",
          `bytes[o++] = ${packed};`,
          "}"
        );
        return;
      }

      lines.push(`for (let ${index} = ${first}; ${index} < ${length}; ${index}++) {`);
      encodeNode(repeated, `${name}[${index}]`, indexPath(path, index));
      flush();
      lines.push("}");
      return;
    }

    if (isObjectSchema(node)) {
      pendingLines.push(`const ${name} = ${expression}; ${validate ? `if (typeof ${name} != "object" || ${name} == null || Array.isArray(${name})) h.fail(${name}, "an object", ${pathCode(path)});` : ""}`);
      encodeGroup(objectGroup(node), name, path);
      return;
    }

    const dataType = getDataType(node);
    const check = validate ? validation(dataType, name, path) : "";
    switch (dataType) {
      case "string":
      case "buffer":
        flush();
        lines.push(`const ${name} = ${expression}; ${check}`, `o = h.write${dataType == "string" ? "String" : "Buffer"}(o, ${name}); ${refresh}`);
        return;
      default: {
        const code = types[dataType];
        bounded("size" in code ? code.size : 5, `const ${name} = ${expression}; ${check} ${code.write(name)}`);
      }
    }
  }

  encodeNode(schema, "value", []);
  flush();
  lines.push("const start = h.scratch.start;", "h.scratch.start = o;", "return bytes.subarray(start, o);");
  return lines.join("\n");
}

function generateDecode(schema: Schema): string {
  const lines = ["const end = bytes.length; let o = 0;"];
  let id = 0;
  let usesView = false as boolean;

  function readLength(name: string) {
    lines.push(`let ${name} = bytes[o++];`, `if (${name} > 127) { ${name} = h.readVarUInt(bytes, o - 1); o = h.offset; }`);
  }

  function readFlags(group: Group): string[] {
    return Array.from({ length: group.flagBytes }, () => {
      const flags = `f${id++}`;
      lines.push(`const ${flags} = bytes[o++];`);
      return flags;
    });
  }

  function decodeGroup(group: Group) {
    let flagBytes: string[] = [];
    const bit = (index: number) => `(${flagBytes[index >> 3]} & ${1 << (index & 7)}) != 0`;

    return group.fields.map(field => {
      if (field == group.first) flagBytes = readFlags(group);

      const present = field.optional ? bit(field.presenceBit) : "";
      if (field.packed) {
        const result = `t${id++}`;
        lines.push(`const ${result} = ${bit(field.valueBit)};`);
        return { field, result, present };
      }
      if (!field.optional) return { field, result: decodeNode(field.schema), present };

      const result = `t${id++}`;
      lines.push(`let ${result};`, `if (${present}) {`);
      lines.push(`${result} = ${decodeNode(field.schema)};`, "}");
      return { field, result, present };
    });
  }

  function decodeNode(node: Schema): string {
    const name = `t${id++}`;

    if (isArraySchema(node)) {
      const [group, repeated] = arrayParts(node);
      const length = `n${name}`;
      const index = `j${name}`;
      const first = group.fields.length;
      lines.push(`const ${name} = [${decodeGroup(group).map(item => item.result).join(", ")}];`);
      readLength(length);

      if (isPacked(repeated)) {
        const count = `c${name}`;
        lines.push(
          `const ${count} = Math.max(0, Math.ceil((${length} - ${first}) / 8));`,
          `if (${count} > end - o) h.overrun();`,
          `for (let ${index} = ${first}; ${index} < ${length}; ${index}++) ${name}.push((bytes[o + ((${index} - ${first}) >> 3)] & (1 << ((${index} - ${first}) & 7))) != 0);`,
          `o += ${count};`
        );
        return name;
      }

      lines.push(`if ((${length} - ${first}) * ${minimumSize(repeated)} > end - o) h.overrun();`);
      lines.push(`for (let ${index} = ${first}; ${index} < ${length}; ${index}++) {`);
      lines.push(`${name}.push(${decodeNode(repeated)});`, "}");
      return name;
    }

    if (isObjectSchema(node)) {
      const decoded = decodeGroup(objectGroup(node));
      const required = decoded.filter(item => !item.field.optional).map(item => `${item.field.property}: ${item.result}`);
      lines.push(`const ${name} = { ${required.join(", ")} };`);
      for (const item of decoded) {
        if (item.field.optional) lines.push(`if (${item.present}) ${name}[${item.field.property}] = ${item.result};`);
      }
      return name;
    }

    const dataType = getDataType(node);
    switch (dataType) {
      case "varuint":
        readLength(name);
        return name;
      case "varint":
        readLength(`n${name}`);
        lines.push(`const ${name} = (n${name} >>> 1) ^ -(n${name} & 1);`);
        return name;
      case "string":
      case "buffer":
        readLength(`n${name}`);
        lines.push(`if (n${name} > end - o) h.overrun();`);
        lines.push(`const ${name} = ${dataType == "string" ? `h.readString(bytes, o, n${name})` : `new Uint8Array(bytes.subarray(o, o + n${name}))`}; o += n${name};`);
        return name;
      default:
        usesView ||= dataType == "float32" || dataType == "float64";
        lines.push(`const ${name} = ${types[dataType].read};`);
        return name;
    }
  }

  const root = decodeNode(schema);
  lines.push("if (!(o <= end)) h.overrun();", `return ${root};`);

  /* Integers decode with byte arithmetic, so only schemas with floats pay for a DataView per message */
  if (usesView) lines.unshift("const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);");
  return lines.join("\n");
}

export function build<const S extends Schema>(schema: S, validate?: boolean): BuiltSchema<Infer<S>> {
  checkSchema(schema, "");
  /* eslint-disable @typescript-eslint/no-implied-eval -- compiling the schema in to code is the point of the library */
  const encode = new Function("value", "h", generateEncode(schema, validate ?? validateByDefault)) as (value: unknown, h: typeof helpers) => Uint8Array;
  const decode = new Function("bytes", "h", generateDecode(schema)) as (bytes: Uint8Array, h: typeof helpers) => Infer<S>;
  /* eslint-enable @typescript-eslint/no-implied-eval */

  return {
    encode: value => {
      if (scratch.busy) throw new Error("schemapack: encode cannot be called while another encode is running");
      scratch.busy = true;
      try {
        return encode(value, helpers);
      } finally {
        scratch.busy = false;
        /* Results keep their own reference, so a buffer grown for an outlier message can be let go */
        if (scratch.bytes.length > retainedBytes) {
          scratch.bytes = new Uint8Array(0);
          scratch.view = new DataView(scratch.bytes.buffer);
          scratch.start = 0;
        }
      }
    },
    decode: data => {
      let bytes: Uint8Array;
      if (data instanceof Uint8Array) bytes = data;
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (Object.prototype.toString.call(data) == "[object ArrayBuffer]") bytes = new Uint8Array(data);
      else throw new TypeError(`schemapack: decode needs a Uint8Array, ArrayBuffer or other ArrayBufferView, got ${describe(data)}`);
      return decode(bytes, helpers);
    }
  };
}

export function addTypeAlias(name: string, type: string) {
  const builtIn = name.trim().toLowerCase();
  if (Object.hasOwn(types, builtIn) || builtIn == "bool") throw new TypeError(`schemapack: ${JSON.stringify(name)} is a built-in type and cannot be an alias`);
  aliasTypes[name] = getDataType(type);
}

export function setValidateByDefault(validate: boolean) {
  validateByDefault = validate;
}
