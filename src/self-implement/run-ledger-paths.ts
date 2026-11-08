import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { normalizeRunId } from '../harness/harness-space.js';

/** `<ELANOUS_STATE_DIR or ~/.elanous>/run-ledger`, separate from self-dev resume checkpoints. */
export function runLedgerDir(stateDir?: string): string {
  return join(stateDir ?? elanousStateRoot(), 'run-ledger');
}

/** Parse graph/run references without treating the namespace as a filesystem path. */
export function parseNamespacedRunId(value: string): { namespace: 'release-loop'; uuid: string } | null {
  const match = /^([a-z][a-z0-9-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\s\S])/i.exec(value);
  if (!match || match[0] !== value || match[1]!.toLowerCase() !== 'release-loop') return null;
  return { namespace: 'release-loop', uuid: match[2]!.toLowerCase() };
}

export function runLedgerPath(runId: string, dir = runLedgerDir()): string {
  // ⛔⭐ 자기 정규식을 갖지 않는다 — runId 의 «정규화 계약»은 harness-space 의 normalizeRunId 하나다
  //    (pickRunId·mintRunId·전파 env·PTY 가 전부 그것을 통과한다).
  //    ⚠️ 종전 판은 여기서 «따로» 검사하고 던졌다. 관측 관문은 fail-soft 라 그 예외가 삼켜지므로,
  //      계약이 어긋나는 순간 그 런의 원장이 «통째로 조용히» 비었을 것이다(리뷰 should-fix).
  //    ⇒ 같은 함수를 쓰면 파일 이름이 다른 표면이 부르는 이름과 «항상» 같고, 던질 일이 없다.
  //    ⛔⭐ 그렇다고 «정규화해서 통과»시키지 않는다 — `../x` 가 조용히 `-x` 로 바뀌면 경로 탈출 방어가
  //      «값을 고쳐서» 사라진다. 거부는 유지하고, 「받아들이는 집합」만 그 함수의 «산출 집합»과 맞춘다.
  if (runId !== normalizeRunId(runId) || !runId) throw new Error(`invalid runId: ${runId}`);
  return join(dir, `${runId}.jsonl`);
}
