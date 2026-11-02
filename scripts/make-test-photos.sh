#!/usr/bin/env bash
# Makes fixtures/photos/sample.jpg, the 1200x900 test pattern the photo
# library spec uploads (and the worker's doctor sends to Claude Code), and
# fixtures/photos/sample.heic, the same picture as HEIC for the worker's tools
# test only. macOS only (`sips` writes the HEIC). Run by hand; CI never
# regenerates them, it uses the committed files.
#
# Usage, from the repository root: scripts/make-test-photos.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
jpg="$root/fixtures/photos/sample.jpg"
heic="$root/fixtures/photos/sample.heic"

mkdir -p "$(dirname "$jpg")"
ffmpeg -hide_banner -v error -y \
  -f lavfi -i "testsrc2=size=1200x900:rate=1" \
  -frames:v 1 -q:v 4 -pix_fmt yuvj420p \
  "$jpg"
sips -s format heic "$jpg" --out "$heic" >/dev/null

echo "wrote $jpg ($(wc -c <"$jpg" | tr -d ' ') bytes)"
echo "wrote $heic ($(wc -c <"$heic" | tr -d ' ') bytes)"
