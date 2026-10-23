import { encodeControlMemoFrame, type ControlMemoPayload } from './control-inbox.js';
import type { PodFragmentRecord } from './self-send-target.js';
import { defaultKubectl, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';

const POD_CONTROL_KUBECTL_TIMEOUT_MS = 120_000;

export function parsePodReadWait(value: string | number): number {
  const parsed = typeof value === 'string' && !value.trim() ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60) throw new Error('self send --read-wait는 0~60초의 유한한 값이어야 합니다');
  return Math.floor(parsed);
}

const PUBLISH = `set -eu
inbox="$1"
kind="$2"
IFS= read -r line
mkdir -p "\${inbox}.ready"
if [ "$kind" = memo ]; then
  temp=$(mktemp "\${inbox}.ready/.write-XXXXXXXX")
  record=''
  cleanup_memo() {
    rm -f "$temp"
    if [ -n "$record" ]; then rm -f "$record.ack-request" "$record.ack"; fi
  }
  trap 'cleanup_memo' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf 'memo:%s\\n' "$line" > "$temp"
  record="\${inbox}.ready/record-$(printf '%016x' "$(date +%s%3N)")-$(cat /proc/sys/kernel/random/uuid)"
  : > "$record.ack-request"
  mv "$temp" "$record"
  printf 'ELANOUS_POD_MEMO_PUBLISHED %s\\n' "\${record##*/}"
  count=0
  while [ ! -e "$record.ack" ] && [ "$count" -lt "$3" ]; do sleep 1; count=$((count + 1)); done
  if [ -e "$record.ack" ]; then printf 'ELANOUS_POD_MEMO_READ %s\\n' "\${record##*/}"
  else printf 'ELANOUS_POD_MEMO_UNVERIFIED %s\\n' "\${record##*/}"; fi
else
  temp=$(mktemp "\${inbox}.ready/.write-XXXXXXXX")
  trap 'rm -f "$temp"' EXIT
  printf 'stop\\n' > "$temp"
  ln "$temp" "\${inbox}.ready/stop" 2>/dev/null || test -f "\${inbox}.ready/stop"
  mkdir -p "$inbox"
  marker=$(mktemp "$inbox/.stop-requested-XXXXXXXX")
  trap 'rm -f "$temp" "$marker"' EXIT
  printf '{"version":1,"requestedAt":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"
  ln "$marker" "$inbox/stop-requested.json" 2>/dev/null || test -f "$inbox/stop-requested.json"
fi`;

/** Publish a control-inbox record inside the child container, not on the host. */
export function sendPodControl(record: PodFragmentRecord, message: { stop: true } | { memo: ControlMemoPayload }, kubectl: Kubectl = defaultKubectl,
  readWaitSeconds = 0): { memoRecord?: string; read?: boolean } {
  const stop = 'stop' in message;
  const input = stop ? 'stop\n' : `${encodeControlMemoFrame(message.memo)}\n`;
  const result = kubectl([
    ...(record.context ? ['--context', record.context] : []), '-n', record.namespace,
    'exec', '-i', `job/${record.job}`, '-c', 'child', '--',
    'sh', '-c', PUBLISH, 'pod-control', record.inboxDir, stop ? 'stop' : 'memo', String(parsePodReadWait(readWaitSeconds)),
  ], input, POD_CONTROL_KUBECTL_TIMEOUT_MS);
  if (result.status !== 0) throw new Error(`Pod ${record.job} control send 실패: ${result.stderr.trim() || 'kubectl exec failed'}`);
  if (stop) return {};
  const published = /^ELANOUS_POD_MEMO_PUBLISHED (record-[0-9a-f-]+)$/m.exec(result.stdout)?.[1];
  if (!published) return {};
  return { memoRecord: published, read: result.stdout.includes(`ELANOUS_POD_MEMO_READ ${published}`) };
}
