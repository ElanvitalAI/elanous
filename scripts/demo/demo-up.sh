#!/bin/bash
# DEMO-FANOUT-START-PATH (AI&B 11-26 act 3): the one documented start path for the live OP fan-out demo.
# It is the setup that passed in #40118 (/tmp/tvfo), written down so a fresh universe works the same way:
#   1. a short universe dir (Unix socket ≤ 103 bytes) with a pre-seeded provider (no first-run picker)
#   2. tree `eln`/`els`/`elanous` shims first on PATH (a seat pane must not start the installed eln)
#   3. <universe>/seats/OP and a work folder (els seat refuses a missing seat folder)
#   4. its own `els serve`, then `els seat set OP && els seat OP` from the person's terminal
#   5. herdr/tmux pane env unset (they would point the children at the ops els)
# usage: scripts/demo/demo-up.sh [universe=/tmp/demo-u] [provider=openrouter] [model=tierModel(budget)]
#   then: tmux -L demo attach -t main     (window 0 = the OP seat · window srv = els serve)
#   stop: scripts/demo/demo-up.sh --down [universe]
set -u
TREE=$(cd "$(dirname "$0")/../.." && pwd)
if [ "${1:-}" = "--down" ]; then tmux -L demo kill-server 2>/dev/null; echo "demo-up: stopped (universe ${2:-/tmp/demo-u} kept)"; exit 0; fi
U=${1:-/tmp/demo-u}; PROVIDER=${2:-openrouter}
MODEL=${3:-$(cd "$TREE" && bun -e 'import { tierModel } from "./src/llm/model-defaults.ts"; console.log(tierModel("budget", "openrouter"))')}
SOCK="$U/els/els.sock"
[ ${#SOCK} -le 103 ] || { echo "demo-up: $SOCK is ${#SOCK} bytes — pick a shorter universe dir" >&2; exit 2; }
BUN=$(command -v bun) || { echo "demo-up: bun not on PATH" >&2; exit 2; }
mkdir -p "$U/bin" "$U/seats/OP" "$U/work" || exit 2
for name in eln elanous; do printf '#!/bin/sh\nexec %s %s/bin/elanous.mjs "$@"\n' "$BUN" "$TREE" > "$U/bin/$name"; done
printf '#!/bin/sh\nexec %s %s/bin/elanous.mjs side "$@"\n' "$BUN" "$TREE" > "$U/bin/els"
chmod +x "$U/bin/eln" "$U/bin/elanous" "$U/bin/els"
if [ ! -s "$U/config.json" ]; then
  printf '{\n  "llm": { "provider": "%s", "model": "%s", "fallbackChain": ["%s"] }\n}\n' "$PROVIDER" "$MODEL" "$PROVIDER" > "$U/config.json"
fi
cat > "$U/env.sh" <<EOF
unset HERDR_ENV HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_TAB_ID HERDR_WORKSPACE_ID TMUX ELANOUS_ELS_SOCKET ELANOUS_ELS_PANE_TOKEN
export ELANOUS_STATE_DIR=$U ELANOUS_SKIP_LOGIN_ENV=1 PATH=$U/bin:\$PATH
EOF
tmux -L demo kill-server 2>/dev/null
tmux -L demo new-session -d -s main -x "${COLS:-120}" -y "${ROWS:-36}" "bash --noprofile --norc"
tmux -L demo new-window -d -t main -n srv "bash --noprofile --norc -c '. $U/env.sh; els serve 2>&1 | tee $U/serve.log'"
for _ in $(seq 1 30); do [ -S "$SOCK" ] && break; sleep 0.5; done
[ -S "$SOCK" ] || { echo "demo-up: els serve did not start — see $U/serve.log" >&2; exit 1; }
tmux -L demo send-keys -t main:0 ". $U/env.sh; cd $U/work; clear; els seat set OP && els seat OP" Enter
echo "demo-up: universe $U · els $SOCK · provider $PROVIDER/$MODEL"
echo "demo-up: tmux -L demo attach -t main"
