#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

IR_PATH="${TMPDIR:-/tmp}/mun-native-ui-$$.json"
trap 'rm -f "$IR_PATH"' EXIT HUP INT TERM

./node_modules/.bin/tsc -p packages/core/tsconfig.json
node packages/animation/scripts/build.mjs
./node_modules/.bin/tsc -p packages/compiler/tsconfig.json
node bin/mun.mjs compile examples/NativeLayoutStyle.mun "$IR_PATH"

MUN_NATIVE_UI_IR="$IR_PATH" \
  cargo test \
    --manifest-path native/Cargo.toml \
    -p mun-runtime \
    --test native_layout_style \
    canonical_source_renders_stack_geometry_and_styles \
    -- \
    --ignored \
    --exact
