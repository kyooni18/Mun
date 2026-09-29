#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

IR_PATH="${TMPDIR:-/tmp}/mun-semantic-ir-contract-$$.json"
trap 'rm -f "$IR_PATH"' EXIT HUP INT TERM

./node_modules/.bin/tsc -p packages/core/tsconfig.json
node packages/animation/scripts/build.mjs
./node_modules/.bin/tsc -p packages/compiler/tsconfig.json
node bin/mun.mjs compile examples/NativeDemo.mun "$IR_PATH"

MUN_COMPILER_CONTRACT_IR="$IR_PATH" \
  cargo test \
    --manifest-path native/Cargo.toml \
    -p mun-runtime \
    --test compiler_contract \
    compiler_output_deserializes_into_native_runtime \
    -- \
    --ignored \
    --exact
