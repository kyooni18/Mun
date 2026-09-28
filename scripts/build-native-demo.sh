#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

./node_modules/.bin/tsc -p packages/core/tsconfig.json
node packages/animation/scripts/build.mjs
./node_modules/.bin/tsc -p packages/compiler/tsconfig.json
node scripts/compile-native-ir.mjs examples/NativeDemo.mun native/generated/NativeDemo.json
cargo build --manifest-path native/Cargo.toml -p mun-native

printf '%s\n' "Built native/target/debug/mun-native with examples/NativeDemo.mun Semantic UI IR"
