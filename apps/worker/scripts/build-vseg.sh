#!/usr/bin/env bash
# Builds the cut-out step's mask tool (tools/vseg/vseg.swift) into the
# gitignored tools/vseg/.build/vseg. Apple Vision only exists on macOS.
set -euo pipefail
if [ "$(uname)" != "Darwin" ]; then
  echo "vseg: the mask tool builds on macOS only (Apple Vision)" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
mkdir -p tools/vseg/.build
swiftc -O tools/vseg/vseg.swift -o tools/vseg/.build/vseg
