import { addTypeAlias, build, setValidateByDefault } from "./schemapack.ts";
import type * as Schemapack from "./schemapack.ts";

(globalThis as { schemapack?: typeof Schemapack }).schemapack = { build, addTypeAlias, setValidateByDefault } satisfies typeof Schemapack;
