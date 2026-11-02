#!/bin/bash
# End to end through the herdr pane: a real plannotator session, the mod opened
# on a hidden test screen, the view driven by its dev script, a header decision
# pressed by props().decide, and the CLI's own output checked.
# Usage: tests/pane-e2e.sh   (needs Hyprland + herdr-app; uses HPT=hpt-e2e)
set -uo pipefail
cd "$(dirname "$0")/.."
export HPT=hpt-e2e
work=$(mktemp -d)
export PLANNOTATOR_DATA_DIR=$work/data
export HERDR_APP_HOME=/run/user/$(id -u)/$HPT
fail=0
cleanup() {
  for tab in $(herdr-app ls 2>/dev/null | jq -r '.spaces[].tabs[] | select(.name == "dev-plannotator") | .id'); do
    herdr-app do tab.close --id "$tab" --confirmed true >/dev/null
  done
  for f in "$work"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  tools/test-screen.sh stop >/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

tools/test-screen.sh start >/dev/null || exit 1

cat >"$work/plan.md" <<'EOF'
# Test plan

## Step 1

Do the **first** thing.

- item a
- item b
EOF

# start <name> <stdin-file|-> <cmd...>: runs a session, prints its URL.
start() {
  local name=$1 stdin=$2; shift 2
  if [ "$stdin" = - ]; then "$@" >"$work/$name.out" 2>"$work/$name.err" </dev/null &
  else "$@" >"$work/$name.out" 2>"$work/$name.err" <"$stdin" &
  fi
  echo $! >"$work/$name.pid"
  for _ in $(seq 1 50); do
    url=$(grep -o 'http://localhost:[0-9]*' "$work/$name.err" | head -1)
    [ -n "$url" ] && { echo "$url"; return; }
    sleep 0.2
  done
  echo "no session URL for $name" >&2
}

# drive <name> <url> <props-json>: opens the pane and waits for the CLI to exit.
drive() {
  local name=$1 url=$2 extra=$3
  DEV_WAIT=0.5 tools/dev-open.sh plannotator "$url" "$work/$name.png" "$extra" >/dev/null
  for _ in $(seq 1 60); do kill -0 "$(cat "$work/$name.pid")" 2>/dev/null || return 0; sleep 0.25; done
  echo "FAIL $name: session still waiting after 15 s" >&2
  fail=1
}

expect() {
  local name=$1 pattern=$2
  if grep -Pzq -- "$pattern" "$work/$name.out"; then echo "ok   $name"
  else echo "FAIL $name: output does not match /$pattern/"; sed 's/^/     /' "$work/$name.out"; fail=1; fi
}

select_first='["press",{"blockId":"block-2","i":1}],["extend",{"blockId":"block-2","i":2}],["release",{"x":300,"y":200}]'

# Annotate: a comment, then the primary (Send Feedback).
url=$(start annotate - plannotator annotate "$work/plan.md" --json --browser none)
drive annotate "$url" "{\"script\":[$select_first,[\"addComment\",\"Why first?\"]],\"decide\":[\"primary\"]}"
expect annotate '"decision":"annotated".*Feedback on: \\"the first\\"\\n> Why first\?'

# Annotate: no annotations, a composer note (Send a note...).
url=$(start note - plannotator annotate "$work/plan.md" --json --browser none)
drive note "$url" '{"decide":["request-changes","Please split step 1."]}'
expect note '"decision":"annotated".*Please split step 1\.'

# Annotate: Close with nothing.
url=$(start close - plannotator annotate "$work/plan.md" --json --browser none)
drive close "$url" '{"decide":["exit"]}'
expect close '"decision":"dismissed"'

# Plan review through the ExitPlanMode hook: a deletion, then the primary (deny).
jq -cn --rawfile plan "$work/plan.md" --arg cwd "$work" '{session_id:"pane-e2e", transcript_path:($cwd+"/t.jsonl"), cwd:$cwd,
  permission_mode:"plan", hook_event_name:"PermissionRequest", tool_name:"ExitPlanMode", tool_input:{plan:$plan}}' >"$work/hook.json"
url=$(start plandeny "$work/hook.json" plannotator)
drive plandeny "$url" "{\"script\":[$select_first,[\"addDeletion\"]],\"decide\":[\"primary\"]}"
expect plandeny '"behavior":"deny".*Remove this'

# Plan review: nothing to say, the primary approves.
url=$(start planok "$work/hook.json" plannotator)
drive planok "$url" '{"decide":["primary"]}'
expect planok '"behavior":"allow"'

# Code review: a line comment in a throwaway repo, then the primary (Send Feedback).
repo=$work/repo
git init -q "$repo" && git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf 'const a = 1;\nconst b = 2;\n' >"$repo/app.js"
git -C "$repo" add app.js && git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m app
printf 'const a = 1;\nconst b = 3;\n' >"$repo/app.js"
url=$(cd "$repo" && start review - plannotator review --browser none)
drive review "$url" '{"script":[["select","app.js"],["comment",2,"Why 3?"]],"decide":["primary"]}'
expect review '(?s)app\.js.*Line 2 \(new\)\n+Why 3\?'

[ "$fail" = 0 ] && echo "all pane e2e cases passed"
exit "$fail"
