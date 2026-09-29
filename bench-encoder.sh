#!/usr/bin/env bash
set -Eeuo pipefail
W=${1:-720}; H=${2:-1280}; D=${3:-20}; THREADS=${4:-4}
echo "Bigg Boss FFmpeg encoder benchmark: ${W}x${H}, ${D}s/test, ${THREADS} threads"
echo
for FPS in 15 20 24 25 30 40 50 60; do
  echo "=== Testing ${FPS} FPS ==="
  ffmpeg -hide_banner -loglevel warning -stats \
    -f lavfi -i "testsrc2=size=${W}x${H}:rate=${FPS}" -t "$D" -an \
    -c:v libx264 -preset ultrafast -threads "$THREADS" -pix_fmt yuv420p \
    -b:v 3500k -minrate 3500k -maxrate 3500k -bufsize 7000k \
    -g "$((FPS*2))" -keyint_min "$((FPS*2))" -sc_threshold 0 -f null - 2>&1 | tail -1
  echo
 done
echo "This measures encoding capacity only; the real renderer can be heavier."
