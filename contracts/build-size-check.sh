#!/bin/bash
set -e

# Size budget for the WebAssembly artifact (in bytes)
MAX_SIZE_BYTES=${MAX_WASM_SIZE:-100000}

echo "Building accountability_vault contract with stellar CLI..."
# We use the optimized profile specified in Cargo.toml
stellar contract build

WASM_PATH="target/wasm32-unknown-unknown/release/accountability_vault.wasm"

if [ ! -f "$WASM_PATH" ]; then
  echo "Error: Artifact $WASM_PATH not found after build."
  exit 1
fi

SIZE=$(stat -c%s "$WASM_PATH")
echo "Wasm artifact size: $SIZE bytes"
echo "Budget limit:       $MAX_SIZE_BYTES bytes"

if [ "$SIZE" -gt "$MAX_SIZE_BYTES" ]; then
  echo "Error: Contract size exceeds the size budget!"
  exit 1
fi

echo "Success: Contract size is within budget."
