#!/bin/zsh
# One-command S2 + S3 onboarding check. Uses the existing ux-sim fakes and zero-* tools.
# Usage: scripts/zero-sim-world.sh <zero-name> [rail|main|sha] [pr:N,M]
set -u
setopt pipefail

M=${1:?usage: zero-sim-world.sh zero-name [rail|main|sha] [pr:N,M]}
REF=${2:-main}
PRS=${3:-}
[[ $M == zero-* && $M != *[^a-z0-9-]* && ${#M} -le 63 ]] || { print -u2 "REFUSE lowercase zero-* VM name required"; exit 2; }

ROOT=${0:A:h:h}
TOOLS=${ZERO_TOOLS_DIR:-$HOME/elanous-hq/seat-state/OP/tools}
VM=$TOOLS/zero-vm.sh
RAIL=$TOOLS/zero-rail.sh
[[ -x $VM && -x $RAIL ]] || { print -u2 "zero-vm.sh/zero-rail.sh not found in $TOOLS"; exit 2; }
EVIDENCE=${ZERO_SIM_EVIDENCE_DIR:-$HOME/elanous-hq/seat-state/OPT/evidence/$(date +%Y%m%d)}
mkdir -p "$EVIDENCE"

created=0
zero_tool() { zsh -f "$@"; }
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if (( created )); then
    zero_tool "$VM" delete "$M" || { print -u2 "VM cleanup failed: $M"; (( rc == 0 )) && rc=1; }
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

print "[S2] existing fake-LLM + fake-GH devices"
(cd "$ROOT" && bun test src/ux-sim/world-definition.test.ts src/ux-sim/fake-llm.test.ts src/ux-sim/fake-gh.test.ts) || exit $?

print "[S3] create empty VM: $M"
EXISTING=$(zero_tool "$VM" list) || exit $?
if print -r -- "$EXISTING" | rg -q "^${M}[[:space:]]"; then
  print -u2 "REFUSE existing VM: $M"
  exit 2
fi
zero_tool "$VM" create "$M" || exit $?
created=1
print "[S3] install shelf: $REF ${PRS:-}"
zero_tool "$RAIL" "$M" "$REF" "$PRS" || exit $?

print "[S3] one headless first run with credentials removed"
zero_tool "$VM" sh "$M" 'bash -lc '\''
  set -u
  export PATH="$HOME/.local/share/elanous/bin:$PATH"
  export ELANOUS_LANG=ko
  unset ELANOUS_LLM_PROVIDER ELANOUS_ESCALATE_PROVIDER
  unset ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GROK_API_KEY GROK_CODE_XAI_API_KEY
  unset GEMINI_API_KEY GOOGLE_API_KEY OPENROUTER_API_KEY CLAUDE_CODE_OAUTH_TOKEN
  unset ANTHROPIC_AUTH_TOKEN LOCAL_LLM_URL
  while IFS="=" read -r name value; do
    case "$name" in
      *_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_CLIENT_SECRET|*_OAUTH_TOKEN) unset "$name" ;;
    esac
  done < <(env)
  export CODEX_HOME="$HOME/.zero-sim-empty-codex" CLAUDE_CONFIG_DIR="$HOME/.zero-sim-empty-claude"
  echo credential_env_cleared
  export ELANOUS_TEST_FAKE_LLM=1 ELANOUS_TEST_FAKE_LLM_AS_PROVIDER=1
  elanous </dev/null
'\''' 2>&1 | tee "$EVIDENCE/zero-sim-$M-first-run.log"
first_run_pipeline_rc=("${pipestatus[@]}")
first_run_rc=${first_run_pipeline_rc[1]:-0}
first_run_log_rc=${first_run_pipeline_rc[2]:-0}

print "[S3] collect first-run logs"
zero_tool "$VM" logs "$M" --since 15m --limit 100 2>&1 | tee "$EVIDENCE/zero-sim-$M-elanous-logs.log"
logs_rc=$?
if (( logs_rc != 0 )); then
  print -r -- "[S3] log collection unavailable rc=$logs_rc" | tee -a "$EVIDENCE/zero-sim-$M-elanous-logs.log"
fi
if (( first_run_rc != 0 )); then
  print "[S3] first run failed rc=$first_run_rc; logs rc=$logs_rc"
  exit $first_run_rc
fi
if (( first_run_log_rc != 0 )); then exit $first_run_log_rc; fi
if (( logs_rc != 0 )); then exit $logs_rc; fi
print "[S3] passed; deleting $M"
