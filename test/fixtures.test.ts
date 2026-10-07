import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { build } from "../src/schemapack.ts";
import type { Schema } from "../src/schemapack.ts";

for (const file of readdirSync(new URL("./fixtures", import.meta.url))) {
  test(file, async () => {
    const { schema, items } = (await import(`./fixtures/${file}`)) as { schema: Schema; items: unknown[] };
    const built = build(schema);
    for (const item of items) assert.deepEqual(built.decode(built.encode(item)), item);
  });
}
