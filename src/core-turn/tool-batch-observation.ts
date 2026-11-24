// ELN-GLM-TOOL-EFFICIENCY(0.3.28) — core 턴 하나의 도구 사용 효율을 «구조 카운트»로만 잰다.
//
// 무엇을 세나:
//   - toolCount               이 core 턴에서 실제 dispatch 된 도구 호출 수
//   - parallelDispatchCount   다른 호출과 «실제로 겹쳐» 돈 호출 수(시작 시점에 다른 호출이 진행 중이었거나,
//                             진행 중에 다른 호출이 시작됐다). 의도(모델이 한 메시지에 몇 개를 냈나)가 아니라
//                             실행기(src/session-runtime/parallel-dispatch.ts)가 정말 겹쳐 돌렸는지를 본다.
//   - maxConcurrentDispatches 동시에 진행 중이던 호출 수의 최댓값
//   - toolRounds              도구를 낸 모델 응답(provider turnIndex) 수 — toolCount / toolRounds = 한 응답당 묶음 크기
//   - readCount               카탈로그 kind 가 'read' 인 도구 호출 수
//   - repeatedReadCount       같은 턴에서 이미 읽은 경로를 다시 읽은 호출 수
//
// ⛔ R-SIG — 도구 이름·문자열 키워드로 판정하지 않는다. «읽기»는 카탈로그의 구조 필드 `kind === 'read'`,
//   경로는 그 도구의 구조 인자(`file_path` · `path`)만 본다. 경로·인자 «값»은 이벤트에 싣지 않는다(카운트만).

import { findNativeTool } from '../native-tool-catalog.js';

export interface ToolBatchObservationSummary {
  toolCount: number;
  parallelDispatchCount: number;
  maxConcurrentDispatches: number;
  toolRounds: number;
  readCount: number;
  repeatedReadCount: number;
}

export interface ToolBatchObserver {
  /** 도구 실행 «직전»에 부른다. 돌려받은 함수를 실행이 끝나면(성공·실패 무관) 한 번 부른다. */
  start(name: string, args: Record<string, unknown> | undefined, turnIndex?: number): () => void;
  summary(): ToolBatchObservationSummary;
}

function isReadTool(name: string): boolean {
  return findNativeTool(name)?.kind === 'read';
}

/** 읽기 대상 열쇠. 경로가 없으면 null(대상 판정 불가 — 재읽기로 세지 않는다). */
function readTargetKey(args: Record<string, unknown> | undefined): string | null {
  const target = typeof args?.file_path === 'string' ? args.file_path
    : typeof args?.path === 'string' ? args.path
    : undefined;
  if (target === undefined || target.length === 0) return null;
  // 대상 = root ⊕ 경로. 도구 id 는 넣지 않는다 — 같은 파일을 다른 읽기 도구로 다시 읽어도 재읽기다(리뷰 r1).
  //   root 같은 구조 인자가 있으면 같은 경로라도 다른 대상이다(elanous_fs_read: cwd|obsidian).
  const root = typeof args?.root === 'string' ? args.root : '';
  return `${root}\u0000${target}`;
}

export function createToolBatchObserver(): ToolBatchObserver {
  type Slot = { overlapped: boolean };
  const inFlight = new Set<Slot>();
  const slots: Slot[] = [];
  const rounds = new Set<number>();
  const readTargets = new Set<string>();
  let maxConcurrent = 0;
  let readCount = 0;
  let repeatedReadCount = 0;

  return {
    start(name, args, turnIndex) {
      const slot: Slot = { overlapped: inFlight.size > 0 };
      if (slot.overlapped) for (const other of inFlight) other.overlapped = true;
      inFlight.add(slot);
      slots.push(slot);
      if (inFlight.size > maxConcurrent) maxConcurrent = inFlight.size;
      if (typeof turnIndex === 'number') rounds.add(turnIndex);
      if (isReadTool(name)) {
        readCount += 1;
        const readKey = readTargetKey(args);
        if (readKey !== null) {
          if (readTargets.has(readKey)) repeatedReadCount += 1;
          else readTargets.add(readKey);
        }
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        inFlight.delete(slot);
      };
    },
    summary() {
      return {
        toolCount: slots.length,
        parallelDispatchCount: slots.filter((slot) => slot.overlapped).length,
        maxConcurrentDispatches: maxConcurrent,
        toolRounds: rounds.size,
        readCount,
        repeatedReadCount,
      };
    },
  };
}
