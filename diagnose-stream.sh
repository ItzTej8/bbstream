#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
echo '=== Bigg Boss Stream Diagnostics ==='
echo "Time: $(date -Is)"
echo "CPU: $(nproc) cores"
echo "RAM: $(free -h | awk '/Mem:/ {print $2 " total / " $3 " used / " $7 " available"}')"
echo "Load: $(awk '{print $1,$2,$3}' /proc/loadavg)"
echo
printf '%s\n' '--- FFmpeg ---'
ffmpeg -version | head -1 || true
printf '%s\n' '--- Bun ---'
bun --version || true
printf '%s\n' '--- Health ---'
curl -sS --max-time 3 http://127.0.0.1:8787/health 2>/dev/null || true
echo
printf '%s\n' '--- Recent FFmpeg errors ---'
if [ -f data/ffmpeg.log ]; then
  grep -Ei 'error|failed|broken|timeout|disconnect|connection|I/O|invalid|refused|server returned|end of file' data/ffmpeg.log | tail -40 || true
else
  echo 'No data/ffmpeg.log yet.'
fi
echo
printf '%s\n' '--- Process ---'
pgrep -af 'src/index.mjs|ffmpeg' || true
echo
printf '%s\n' '--- Network sockets ---'
ss -tnp 2>/dev/null | grep -E ':1935|a\.rtmp\.youtube\.com|127\.0\.0\.1:878' | tail -30 || true
