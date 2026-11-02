#!/usr/bin/env bash
# Makes fixtures/footage/landscape.mp4, the 2-second 320x180 landscape clip
# with a tone that the footage refusal spec uploads (the studio refuses it as
# not vertical). Run by hand; CI never regenerates the clip, it uses the
# committed file. It never touches fixtures/footage/short-person.mp4.
#
# Usage, from the repository root: scripts/make-landscape-clip.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/fixtures/footage/landscape.mp4"

ffmpeg -hide_banner -v error -y \
  -f lavfi -i "smptebars=size=320x180:rate=30:duration=2" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 1 \
  -shortest -movflags +faststart \
  "$out"

echo "wrote $out ($(wc -c <"$out" | tr -d ' ') bytes)"
