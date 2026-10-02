import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const distWasm = resolve(dist, "wasm");
const prebuilt = resolve(root, "wasm", "prebuilt");
const wasmNames = [
  "resident-kernel-scalar.wasm",
  "resident-kernel-simd.wasm",
  "resident-kernel-shared-scalar.wasm",
  "resident-kernel-shared-simd.wasm",
];

rmSync(dist, { recursive: true, force: true });
const result = spawnSync("tsc", ["-p", "tsconfig.json"], { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(distWasm, { recursive: true });
for (const name of wasmNames) {
  const encoded = readFileSync(resolve(prebuilt, `${name}.b64`), "utf8").replace(/\s+/gu, "");
  writeFileSync(resolve(distWasm, name), Buffer.from(encoded, "base64"));
}

const worker = resolve(root, "wasm", "resident-worker.mjs");
if (existsSync(worker)) cpSync(worker, resolve(distWasm, "resident-worker.mjs"));
