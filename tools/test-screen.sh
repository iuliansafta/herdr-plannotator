#!/bin/sh
# A second herdr-app screen for tests: X11 (keeps drawing while hidden), on a
# hidden Hyprland workspace, sharing herdr-core but not focus with the user's
# window. Usage: test-screen.sh start|stop|status
set -eu
HOME_DIR=/run/user/$(id -u)/${HPT:-hpt}
MOD_DIR=$(cd "$(dirname "$0")/../mod" && pwd)
find_pid() { pgrep -f "^$HOME/.local/bin/herdr-app$" | while read -r p; do tr '\0' '\n' </proc/$p/environ | grep -qx "HERDR_APP_HOME=$HOME_DIR" && echo "$p"; done | head -1; }
case "${1:-status}" in
start)
  [ -n "$(find_pid)" ] && { echo "running"; exit 0; }
  mkdir -p "$HOME_DIR/mods"
  cp ~/.config/herdr-app/settings.json ~/.config/herdr-app/seen.json "$HOME_DIR/" 2>/dev/null || true
  ln -sfn "$MOD_DIR" "$HOME_DIR/mods/plannotator"
  welcomed=$(jq -c '.["frame.welcomed"] // true' ~/.config/herdr-app/shared.json 2>/dev/null || echo true)
  shared=$HOME_DIR/shared.json; [ -f "$shared" ] || echo '{}' >"$shared"
  jq --argjson w "$welcomed" '.["frame.welcomed"] = $w' "$shared" >"$shared.tmp" && mv "$shared.tmp" "$shared"
  (HERDR_APP_HOME=$HOME_DIR env -u WAYLAND_DISPLAY setsid nohup "$HOME/.local/bin/herdr-app" >"$HOME_DIR.log" 2>&1 &)
  for _ in $(seq 1 60); do
    pid=$(find_pid); addr=$([ -n "$pid" ] && hyprctl clients -j | jq -r --argjson p "$pid" '.[] | select(.pid==$p) | .address' || true)
    [ -n "${addr:-}" ] && break; sleep 0.25
  done
  [ -n "${addr:-}" ] || { echo "test screen did not start; see $HOME_DIR.log" >&2; exit 1; }
  hyprctl dispatch "hl.dsp.window.move({ workspace = 'special:herdrtest', follow = false, window = 'address:$addr' })" >/dev/null
  sleep 2
  echo "started pid $pid";;
stop) pid=$(find_pid); [ -n "$pid" ] && kill "$pid"; echo stopped;;
status) pid=$(find_pid); echo "${pid:-not running}";;
esac
