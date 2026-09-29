import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const codemodeRequire = createRequire(import.meta.resolve("@earendil-works/pi-codemode"));
const source = codemodeRequire.resolve("quickjs-wasi/quickjs.wasm");
const destination = path.resolve("dist/server");

await mkdir(destination, { recursive: true });
await copyFile(source, path.join(destination, "quickjs.wasm"));
