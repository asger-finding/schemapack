# schemapack

Fast, compact binary serialization for JavaScript and TypeScript. Describe a message once as a schema, then encode objects to small byte arrays and decode them on the other end. Built for WebSockets and game networking.

```ts
import { build } from "@asger-finding/schemapack";

const playerSchema = build({
  health: "varuint",
  jumping: "bool",
  position: ["int16"],
  attributes: { str: "uint8", agi: "uint8", int: "uint8" }
});

const bytes = playerSchema.encode({ health: 4000, jumping: false, position: [-540, 343, 1201], attributes: { str: 87, agi: 42, int: 22 } });
socket.send(bytes); // 13 bytes, where JSON.stringify gives 100

const player = playerSchema.decode(bytes);
```

* **Small:**  
  Only values go on the wire, with no keys or padding. Booleans and absent optional fields take one bit.
* **Fast:**  
  Each schema compiles to its own encoder and decoder, faster than Protocol Buffers, Avro, MessagePack and JSON in every [benchmark](#benchmarks).
* **Typed:**  
  `encode` and `decode` are typed from the schema.
* **Light:**  
  4.8 KB minified and gzipped, no dependencies, no `Buffer` shim in browsers.

Derived from the great work of [phretaddin/schemapack](https://github.com/phretaddin/schemapack).

## Installation

```sh
npm install @asger-finding/schemapack
```

The package is an ES module and ships its own TypeScript types:

```ts
import { build } from "@asger-finding/schemapack";
```

CommonJS code on Node 22.13 or later can load it with `require()` too:

```js
const { build } = require("@asger-finding/schemapack");
```

In a browser without a bundler, load `dist/schemapack.min.js`, which defines a global `schemapack`. unpkg and jsDelivr serve that file by default:

```html
<script src="https://unpkg.com/@asger-finding/schemapack"></script>
<script>
  const playerSchema = schemapack.build({ health: "varuint" });
</script>
```

## Usage

### Schemas

A schema describes one kind of message. It is a type name from the [data types](#data-types), an object whose values are schemas, or an [array](#arrays) of schemas:

```ts
const personSchema = build({ name: "string", age: "uint8", weight: "float32" });
const scoreSchema = build("varint");
```

`build` compiles the schema into an encoder and decoder with `new Function`, so build each schema once and reuse it. A page with a Content Security Policy needs `'unsafe-eval'` in `script-src` for this to work. In TypeScript, `encode` and `decode` take their types from the schema. A schema kept in a variable needs `as const` for that:

```ts
const schema = { name: "string", age: "uint8" } as const;
const built = build(schema);
```

### Encoding and decoding

```ts
const bytes = personSchema.encode({ name: "John Smith", age: 32, weight: 188.5 }); // 16 bytes
const person = personSchema.decode(bytes); // { age: 32, name: "John Smith", weight: 188.5 }
```

`encode` returns a `Uint8Array`. To avoid a copy, it is a view into a buffer that later messages share, so keep a `.slice()` if you hold on to a result or transfer it to a worker. Otherwise it keeps the whole shared buffer in memory.

`decode` accepts a `Uint8Array` (Node's `Buffer` included), an `ArrayBuffer` or any other `ArrayBufferView`, and throws a `RangeError` on truncated data or lengths beyond the buffer.

### Arrays

The last item of an array schema repeats any number of times. Items before it appear exactly once, which makes tuples:

```ts
const scores = build({ scores: ["string", "uint8"] });
scores.encode({ scores: ["dave", 10, 14, 7] });

const people = build([{ name: "string", numbers: ["varint"] }]);
people.encode([{ name: "joe", numbers: [-3, 2, 5] }, { name: "bobby", numbers: [] }]);
```

An empty object `{}` is only allowed as the whole schema, for messages without data.

### Optional fields and booleans

End a key with `?` to make a field optional. A field that is `undefined` or `null` costs one bit and is left out of the decoded object, so you can send only what changed:

```ts
const tankSchema = build({ id: "uint8", "x?": "float32", "y?": "float32" });
const bytes = tankSchema.encode({ id: 4, x: 12.5 }); // 6 bytes
tankSchema.decode(bytes); // { id: 4, x: 12.5 }
```

Booleans take one bit each. An object's booleans and optional fields share bytes, and arrays of booleans store eight to a byte.

### Message types

Fields are encoded in sorted key order. To send several kinds of message over one socket, give each schema a field like `_type: "uint8"`. The underscore sorts before lowercase keys, so the field lands in the first byte and the receiver can read it to tell messages apart.

### Type aliases and validation

```ts
addTypeAlias("int", "varuint"); // case-sensitive, and cannot replace a built-in type

const unchecked = build({ sample: "string" }, false); // leave out encode validation
setValidateByDefault(false); // or change the default for every later build
```

`encode` checks each value against its type and range, and throws a `TypeError` on a mismatch. `decode` always checks lengths against the buffer, but does not range-check values beyond their type, so a server should still validate what clients send.

## Data types

| Type    | Bytes | Range |
|---------|-------|-------|
| bool, boolean | 1 bit, or 1 byte as a lone value | `true` or `false` |
| int8    | 1 | -128 to 127 |
| uint8   | 1 | 0 to 255 |
| int16   | 2 | -32,768 to 32,767 |
| uint16  | 2 | 0 to 65,535 |
| int32   | 4 | -2,147,483,648 to 2,147,483,647 |
| uint32  | 4 | 0 to 4,294,967,295 |
| float16 | 2 | ±65,504, about 3 significant digits |
| float32 | 4 | ±3.4E38, about 7 significant digits |
| float64 | 8 | ±1.8E308, about 15 significant digits |
| varuint | 1 to 5, one more per 7 bits | 0 to 2,147,483,647 |
| varint  | 1 to 5, zigzag encoded | -1,073,741,824 to 1,073,741,823 |
| string  | varuint length, then UTF-8 | Any string |
| buffer  | varuint length, then the bytes | Any `Uint8Array` |

## Benchmarks

`npm run bench` compares schemapack with [schemapack v1.4](https://github.com/phretaddin/schemapack), [Protocol Buffers](https://github.com/protobufjs/protobuf.js), [Avro](https://github.com/mtth/avsc), [MessagePack](https://github.com/msgpack/msgpack-javascript), [msgpackr](https://github.com/kriszyp/msgpackr) and JSON on three payloads, and redraws these charts. The binary formats store floats as float32.

<sub>Measured on an AMD Ryzen 7 7840HS with Node 24.7.</sub>

![Player benchmark](bench/charts/player-light.svg#gh-light-mode-only)
![Player benchmark](bench/charts/player-dark.svg#gh-dark-mode-only)

![Game state benchmark](bench/charts/state-light.svg#gh-light-mode-only)
![Game state benchmark](bench/charts/state-dark.svg#gh-dark-mode-only)

![Game state delta benchmark](bench/charts/delta-light.svg#gh-light-mode-only)
![Game state delta benchmark](bench/charts/delta-dark.svg#gh-dark-mode-only)

## Development

Development needs Node 22.18 or later, which runs the TypeScript sources directly.

| Command         | What it does |
|-----------------|--------------|
| `npm install`   | Installs dependencies and builds `dist` |
| `npm test`      | Builds, type checks and runs the tests |
| `npm run lint`  | Lints with the strict typescript-eslint rules |
| `npm run bench` | Runs the benchmarks and redraws the charts |

## License

MIT, originally by phretaddin.
