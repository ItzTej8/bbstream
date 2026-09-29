#!/usr/bin/env bash
set -Eeuo pipefail
SERVICE="bigg-boss-live.service"
case "${1:-status}" in
  start|stop|restart|enable|disable|status|is-active|is-enabled)
    sudo systemctl "$1" "$SERVICE" ;;
  logs|log|follow)
    sudo journalctl -u "$SERVICE" -f ;;
  errors)
    sudo journalctl -u "$SERVICE" -n 200 --no-pager | grep -Ei 'error|failed|broken|timeout|disconnect|killed|SIGKILL|SIGTERM|youtube|ffmpeg' || true ;;
  *) echo "Usage: $0 {start|stop|restart|enable|disable|status|is-active|is-enabled|logs|errors}"; exit 2;;
esac
