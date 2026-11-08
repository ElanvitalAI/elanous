import type { GoalType } from '../self-implement/goal-author.js';
import type { PodMemoryTier } from '../task-orchestrator/surfaces/self-implement-pod.js';

export type PodMemorySelectionReason = 'explicit-option' | 'goal-type-default' | 'existing-tier';

export const POD_MEMORY_SAMPLE_INTERVAL_SECONDS = 15;
export const POD_MEMORY_STAGE_NAMES = ['source', 'install', 'implement', 'typecheck', 'test', 'build'] as const;
export type PodMemoryStageName = typeof POD_MEMORY_STAGE_NAMES[number];

/** Wrap the commands that define memory-profile phases so samples use explicit active-command markers. */
export function podMemoryStageToolWrappersScript(): string {
  return `stage_bin="\${ELANOUS_POD_MEMORY_STAGE_BIN:-/tmp/si-memory-stage-bin}"
stage_dir="\${ELANOUS_POD_MEMORY_STAGE_DIR:-/tmp/si-memory-stage-active}"
mkdir -p "$stage_bin" "$stage_dir"
for tool in git bun tsc; do
  real_tool=$(command -v "$tool" 2>/dev/null || true)
  [ -n "$real_tool" ] || continue
  printf '#!/usr/bin/env bash\\nreal_tool=%q\\n' "$real_tool" > "$stage_bin/$tool"
  cat >> "$stage_bin/$tool" <<'ELANOUS_POD_STAGE_WRAPPER'
tool=\${0##*/}
stage=""
real_args=("$@")
process_start_time() {
  if [ -r "/proc/$1/stat" ]; then sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; return; fi
  ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; gsub(/ /, "_"); print}'
}
write_stage_marker() {
  marker_tmp="$marker.tmp"
  if printf '%s %s %s %s %s\\n' "$stage" "$1" "$2" "$3" "$4" > "$marker_tmp"; then
    mv -f -- "$marker_tmp" "$marker" || { rm -f -- "$marker_tmp"; return 1; }
  else rm -f -- "$marker_tmp"; return 1; fi
}
case "$tool" in
  git)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -C|-c|--config-env|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix) shift 2 ;;
        --config-env=*|--exec-path=*|--git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--no-pager|--no-replace-objects|--no-optional-locks|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--bare) shift ;;
        *) break ;;
      esac
    done
    case "\${1:-}" in clone|fetch|checkout|pull) stage=source;; esac ;;
  tsc) stage=typecheck ;;
  bun)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --cwd|--env-file|--conditions|--preload|--define|--config|--loader|--use) shift 2 ;;
        --cwd=*|--env-file=*|--conditions=*|--config=*|--loader=*|--use=*|--bun|--silent|--smol|--no-install|--no-save|--prefer-offline) shift ;;
        *) break ;;
      esac
    done
    if [ "\${1:-}" = install ]; then stage=install
    elif [ "\${1:-}" = test ]; then stage=test
    elif [ "\${1:-}" = build ]; then stage=build
    elif { [ "\${1:-}" = x ] || [ "\${1:-}" = exec ]; } && [ "\${2:-}" = tsc ]; then stage=typecheck
    elif [ "\${1:-}" = run ]; then
      case "\${2:-}" in
        test) stage=test ;;
        typecheck|check-types) stage=typecheck ;;
        build) stage=build ;;
      esac
    fi ;;
esac
marker=""
if [ -n "$stage" ]; then
  marker="\${ELANOUS_POD_MEMORY_STAGE_DIR:-/tmp/si-memory-stage-active}/$$"
  marker_start=$(process_start_time "$$" || true)
  [ -n "$marker_start" ] || marker_start=unknown
  marker_started_at=$(date +%s)
  if write_stage_marker "$$" "$marker_start" launching "$marker_started_at"; then
    export ELANOUS_POD_MEMORY_ACTIVE_STAGE="$stage" ELANOUS_POD_MEMORY_STAGE_MARKER="$marker"
  else marker=""; fi
fi
cleanup_stage_marker() { [ -z "$marker" ] || rm -f -- "$marker" "$marker.tmp" "$marker.gate"; }
trap cleanup_stage_marker EXIT
trap - HUP INT TERM
command_pid=""
handle_signal() {
  signal="$1"
  exit_code="$2"
  trap - INT TERM
  exec 9>&- 2>/dev/null || true
  exec 9<&- 2>/dev/null || true
  if [ -n "$command_pid" ]; then
    kill -s "$signal" "$command_pid" 2>/dev/null || true
    (sleep 2; kill -KILL "$command_pid" 2>/dev/null || true) &
    killer_pid=$!
    wait "$command_pid" 2>/dev/null || true
    kill "$killer_pid" 2>/dev/null || true
    wait "$killer_pid" 2>/dev/null || true
  fi
  cleanup_stage_marker
  exit "$exit_code"
}
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
run_real_tool() {
  if [ -n "$marker" ]; then
    exec 9>&-; exec 9<&-
    IFS= read -r gate_release < "$marker.gate" || exit 125
    [ "$gate_release" = go ] || exit 125
  fi
  trap - HUP INT TERM
  if [ -n "$marker" ]; then
    IFS=" " read -r marker_stage command_pid command_start marker_state marker_started_at < "$marker"
    write_stage_marker "$command_pid" "$command_start" active "$marker_started_at" || true
  fi
  exec "$real_tool" "\${real_args[@]}"
}
if [ -n "$marker" ] && mkfifo "$marker.gate" 2>/dev/null && exec 9<> "$marker.gate"; then
  run_real_tool <&0 &
  command_pid=$!
  command_start=$(process_start_time "$command_pid" || true)
  [ -n "$command_start" ] || command_start=unknown
  write_stage_marker "$command_pid" "$command_start" prepared "$marker_started_at" || true
  printf 'go\\n' >&9 || true
  exec 9>&-; exec 9<&-
  for i in {1..100}; do
    IFS=" " read -r marker_stage marker_pid marker_start marker_state marker_started_at < "$marker" || break
    [ "$marker_state" = active ] && break
    kill -0 "$command_pid" 2>/dev/null || break
    sleep 0.01
  done
  rm -f -- "$marker.gate"
  wait "$command_pid"
  rc=$?
else
  exec 9>&- 2>/dev/null || true
  exec 9<&- 2>/dev/null || true
  cleanup_stage_marker
  marker=""
  run_real_tool <&0 &
  command_pid=$!
  wait "$command_pid"
  rc=$?
fi
cleanup_stage_marker
exit "$rc"
ELANOUS_POD_STAGE_WRAPPER
  chmod 755 "$stage_bin/$tool"
done
export ELANOUS_POD_MEMORY_STAGE_DIR="$stage_dir"
export PATH="$stage_bin:$PATH"
hash -r`;
}

/** Sample cgroup and the top-five RSS total; phase attribution comes only from explicit lifecycle markers. */
export function podMemorySamplerScript(): string {
  return `stage_dir="\${ELANOUS_POD_MEMORY_STAGE_DIR:-/tmp/si-memory-stage-active}"
stage_file="\${ELANOUS_POD_MEMORY_STAGE_FILE:-/tmp/si.stage}"
(while :; do { mem=$(if [ -r /sys/fs/cgroup/memory.current ]; then cat /sys/fs/cgroup/memory.current; elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then cat /sys/fs/cgroup/memory/memory.usage_in_bytes; else printf -- -; fi); stage=""; conflict=0; active=""; if [ -d "$stage_dir" ]; then for marker in "$stage_dir"/*; do [ -f "$marker" ] || continue; marker_name=\${marker##*/}; case "$marker_name" in *.tmp) continue;; ''|*[!0-9]*) rm -f -- "$marker"; continue;; esac; IFS=" " read -r value pid marker_start marker_state marker_started_at < "$marker" || { rm -f -- "$marker"; continue; }; case "$value" in source|install|typecheck|test|build) ;; *) rm -f -- "$marker"; continue;; esac; case "$pid" in ''|*[!0-9]*) rm -f -- "$marker"; continue;; esac; case "$marker_state" in active|launching|prepared) ;; *) rm -f -- "$marker"; continue;; esac; case "$marker_started_at" in ''|*[!0-9]*) rm -f -- "$marker"; continue;; esac; if ! kill -0 "$pid" 2>/dev/null; then rm -f -- "$marker"; continue; fi; if [ "$marker_state" != active ]; then continue; fi; if [ "$marker_start" != unknown ]; then actual_start=$(if [ -r "/proc/$pid/stat" ]; then sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}'; else ps -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; gsub(/ /, "_"); print}'; fi); if [ -z "$actual_start" ] || [ "$actual_start" != "$marker_start" ]; then rm -f -- "$marker"; continue; fi; fi; if [ -z "$active" ]; then active="$value"; elif [ "$active" != "$value" ]; then conflict=1; fi; done; fi; if [ "$conflict" -eq 0 ]; then if [ -n "$active" ]; then stage="$active"; else base=$(cat "$stage_file" 2>/dev/null || true); case "$base" in source) stage=source;; run) stage=implement;; esac; fi; fi; ps_result=$(ps -eo rss=,comm=,args= --sort=-rss 2>/dev/null); ps_rc=$?; top=""; rss_marker=""; if [ "$ps_rc" -ne 0 ] || [ -z "$ps_result" ]; then rss_marker=" rss=unavailable"; else top=$(printf '%s\\n' "$ps_result" | awk 'function encode(s) { gsub(/%/, "%25", s); gsub(/:/, "%3A", s); gsub(/ /, "%20", s); gsub(/\\t/, "%09", s); return s } NR<=5 { rss=$1; name=$2; sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]*/, ""); n=split($0, a, /[[:space:]]+/); cmd="<redacted>"; if (name=="git" && (a[2]=="clone" || a[2]=="fetch" || a[2]=="checkout" || a[2]=="pull")) cmd="git " a[2] " <redacted>"; else if (name=="sleep" && a[2]=="30") cmd="sleep 30" (n>2 ? " <redacted>" : ""); else if (name=="bun") { cmd="bun <redacted>"; if (a[2]=="test") cmd="bun test <redacted>"; else if (a[2]=="install") cmd="bun install <redacted>"; else if (a[2]=="run" && (a[3]=="build" || a[3]=="test" || a[3]=="typecheck" || a[3]=="check-types")) cmd="bun run " a[3] " <redacted>"; else if (a[2]=="run") cmd="bun run <redacted>"; else if ((a[2]=="x" || a[2]=="exec") && a[3]=="tsc") cmd="bun x tsc <redacted>" } else if (name=="tsc") cmd="tsc <redacted>"; else if (name=="elanous") { cmd="elanous <redacted>"; if (a[2]=="self" && a[3]=="implement") cmd="elanous self implement <redacted>"; else if (a[2]=="self") cmd="elanous self <redacted>"; else if (a[2]=="harness" && (a[3]=="ask" || a[3]=="say")) cmd="elanous harness " a[3] " <redacted>"; else if (a[2]=="harness") cmd="elanous harness <redacted>" } else if (name=="node") cmd="node <redacted>"; if (name=="sleep" && cmd=="<redacted>") cmd="sleep <redacted>"; else if (cmd=="<redacted>" && name!="bash" && name!="sh") name="other"; printf " %s:%s:%s", rss, encode(name), encode(substr(cmd,1,120)) }'); [ -n "$top" ] || rss_marker=" rss=unavailable"; fi; stage_tag=""; [ -z "$stage" ] || stage_tag=" stage=$stage"; printf "ELANOUS_MEM %s %s%s%s%s\\n" "$(date +%s)" "$mem" "$stage_tag" "$rss_marker" "$top"; } || true; sleep ${POD_MEMORY_SAMPLE_INTERVAL_SECONDS} || break; done) & mem_sampler_pid=$!`;
}

export interface PodMemoryProcessSample { readonly rssKb: number; readonly name: string; readonly cmd?: string }
export interface PodMemorySample { readonly at: number; readonly cgroupBytes: number | null; readonly stage?: PodMemoryStageName; readonly top: readonly PodMemoryProcessSample[] | null }
export interface PodMemoryStagePeak {
  readonly stage: PodMemoryStageName;
  readonly samples: number;
  readonly cgroupSampledPeakBytes: number | null;
  readonly topProcessRssPeakKb: number | null;
  readonly coverage: 'sampled' | 'not-observed';
}

/** Per-stage sampled high-water marks; empty buckets stay explicitly unobserved. */
export function summarizePodMemoryByStage(samples: readonly PodMemorySample[]): PodMemoryStagePeak[] {
  const peaks = new Map<PodMemoryStageName, { samples: number; cgroup: number | null; rssKb: number | null }>(
    POD_MEMORY_STAGE_NAMES.map((stage) => [stage, { samples: 0, cgroup: null, rssKb: null }]),
  );
  for (const sample of samples) {
    const stage = sample.stage;
    if (!stage || !peaks.has(stage)) continue;
    const peak = peaks.get(stage)!;
    peak.samples++;
    if (sample.cgroupBytes !== null && Number.isSafeInteger(sample.cgroupBytes) && sample.cgroupBytes >= 0) {
      peak.cgroup = Math.max(peak.cgroup ?? 0, sample.cgroupBytes);
    }
    if (sample.top !== null) {
      const rssKb = sample.top.reduce((total, process) => total + process.rssKb, 0);
      peak.rssKb = Math.max(peak.rssKb ?? 0, rssKb);
    }
  }
  return POD_MEMORY_STAGE_NAMES.map((stage) => {
    const peak = peaks.get(stage)!;
    return {
      stage,
      samples: peak.samples,
      cgroupSampledPeakBytes: peak.cgroup,
      topProcessRssPeakKb: peak.rssKb,
      coverage: peak.samples > 0 ? 'sampled' : 'not-observed',
    };
  });
}

/** Select the harness Pod tier without discarding the existing implementation/operate decision. */
export function selectPodMemoryTier(
  goalType: GoalType,
  explicitPodMemory: PodMemoryTier | undefined,
  existingTier: PodMemoryTier = 'standard',
): { tier: PodMemoryTier; reason: PodMemorySelectionReason } {
  if (explicitPodMemory !== undefined) return { tier: explicitPodMemory, reason: 'explicit-option' };
  if (goalType === 'research' || goalType === 'document') return { tier: 'lite', reason: 'goal-type-default' };
  return { tier: existingTier, reason: 'existing-tier' };
}
