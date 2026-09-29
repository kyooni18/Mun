#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

IR_PATH="${TMPDIR:-/tmp}/mun-native-controls-$$.json"
trap 'rm -f "$IR_PATH"' EXIT HUP INT TERM

./node_modules/.bin/tsc -p packages/core/tsconfig.json
node packages/animation/scripts/build.mjs
./node_modules/.bin/tsc -p packages/compiler/tsconfig.json
node bin/mun.mjs compile examples/NativeControlsStyle.mun "$IR_PATH"

MUN_NATIVE_CONTROLS_IR="$IR_PATH" \
  cargo test \
    --manifest-path native/Cargo.toml \
    -p mun-runtime \
    --test native_controls_style \
    canonical_controls_mutate_state_relayout_and_render_styles \
    -- \
    --ignored \
    --exact
