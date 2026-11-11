// ⭐ `tools.selfImplement.observeOnly` 의 **단일 출처**.
//
// ⛔ 왜 모듈로 뽑나 — 이 스위치는 `SelfImplement` 를 부르는 **두 경로**에 다 걸려야 한다:
//   ⑴ daemon-tools `dispatchSelfImplement` (ACP·데몬·텔레그램)
//   ⑵ tool-runtime `selfImplementRuntime`  (TUI·대시보드 — **코퍼스 측정이 실제로 타는 길**)
// 두 곳이 각자 config 를 읽으면 *"한 판정의 두 변을 서로 다른 출처가 정한다"* 가 되고, 언젠가 갈린다.
//
// ⛔ **실측이 만든 모듈이다**(2026-08-02): 스위치가 ⑴에만 있어서, 관측 전용으로 재려던 코퍼스 측정이
//    ⑵로 흘러 **진짜 self-implement 런을 두 번 띄웠다**(worktree 두 개 생성 · 사람이 수동 정지).
import { getUserConfig } from '../user-config/reader.js';

export const OBSERVE_ONLY_FLAG_ENV = 'ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY';

export type ObserveOnlySource = 'flag' | 'config' | 'default';
export interface ObserveOnlyDecision {
  readonly enabled: boolean;
  readonly source: ObserveOnlySource;
}

type ObserveOnlyConfigReader = () => boolean;

function readObserveOnlyConfig(): boolean {
  return getUserConfig().tools?.selfImplement?.observeOnly === true;
}

let observeOnlyConfigReader: ObserveOnlyConfigReader = readObserveOnlyConfig;

/** Resolve the boot-time override before the legacy config path. */
export function resolveObserveOnlyDecision(env: NodeJS.ProcessEnv = process.env): ObserveOnlyDecision {
  if (env[OBSERVE_ONLY_FLAG_ENV] === '1') return { enabled: true, source: 'flag' };
  if (observeOnlyConfigReader()) return { enabled: true, source: 'config' };
  return { enabled: false, source: 'default' };
}

/**
 * Report whether SelfImplement should record the call without starting a run.
 *
 * ⛔ fail-closed — 읽기가 실패하면 **던진다**. 조용히 `false` 로 떨어지면 «못 읽었다» 가
 * «관측 전용이 아니다» 로 읽혀 실행이 시작된다(부재와 미지를 같은 값으로 적지 않는다).
 */
export function isObserveOnly(): boolean {
  return resolveObserveOnlyDecision().enabled;
}

/** Build an environment override that is valid before a child process boots. */
export function observeOnlyFlagEnv(enabled?: boolean): Record<string, string> {
  return enabled ? { [OBSERVE_ONLY_FLAG_ENV]: '1' } : {};
}

/** Test seam for config-read failure handling. */
export function _setObserveOnlyConfigReaderForTesting(reader?: ObserveOnlyConfigReader): void {
  observeOnlyConfigReader = reader ?? readObserveOnlyConfig;
}
