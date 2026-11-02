#!/usr/bin/env bash
# Makes fixtures/footage/short-speech.mp4, the few-second vertical test clip
# with speech the studio's upload spec sends (a plain colour background, no
# person on screen). macOS only (it needs `say`) and run by hand; CI never
# regenerates the clip, it uses the committed file. It never touches
# fixtures/footage/short-person.mp4.
#
# Usage, from the repository root: scripts/make-test-clip.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/fixtures/footage/short-speech.mp4"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say -o "$tmp/speech.aiff" "This is a short test clip for the reel studio."

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x2f4f4f:s=720x1280:r=30" \
  -i "$tmp/speech.aiff" \
  -map 0:v -map 1:a \
  -c:v libx264 -pix_fmt yuv420p -crf 35 -preset veryslow \
  -c:a aac -ac 1 -b:a 48k \
  -shortest -movflags +faststart \
  "$out"

echo "wrote $out ($(stat -f%z "$out") bytes)"
