#!/usr/bin/env bash
# Assembles the frames captured by tools/capture-demo.mjs into the README GIF.
# Two-pass palette so the thermal overlay's gradients survive quantisation.
#
#   ./tools/make-gif.sh [framesDir] [out.gif] [width] [fps]
set -euo pipefail

FRAMES="${1:-/tmp/dc-frames}"
OUT="${2:-assets/demo.gif}"
WIDTH="${3:-760}"
FPS="${4:-12}"

mkdir -p "$(dirname "$OUT")"
PALETTE="$(mktemp -t dcpalette).png"

ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/f%04d.png" \
  -vf "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,palettegen=stats_mode=diff" "$PALETTE"

ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/f%04d.png" -i "$PALETTE" \
  -lavfi "fps=$FPS,scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 "$OUT"

rm -f "$PALETTE"
ls -lh "$OUT"
