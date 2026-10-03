// ── 미션 tool-set 재현성 가드 (RFC-elanous-tiered-tool-exposure P5) ──────
//
// 미션 실행기(getAutopilotToolRegistry)의 tool 집합은 armed 자율 미션(실자금·
// 자율빌드)이 호출할 수 있는 능력의 경계다. RFC P5 가 "tool-set before==after
// 검증 필수(미션 재현성)"를 명시한 이유. 이 테스트는 현재 노출 집합을 **못박아**,
// 향후 리팩터(특히 P5 수렴 — 하드코딩 grandfather 리스트를 tiered surface
// 프레임워크로 이관)가 tool 집합을 의도치 않게 바꾸면 CI 에서 잡는다.
//
// Bash 를 포함한 T1 substrate 가 프레임워크(surface)를 거쳐 들어오도록 수렴할
// 때, 이 테스트가 before==after 를 보장한다. 의도적 변경 시엔 이 기대값을
// 함께 갱신(= 변경을 명시적으로 리뷰하게 강제).

import { describe, expect, test } from 'bun:test';
import { getAutopilotToolRegistry } from '../src/autopilot/tool-registry.js';

// 미션 실행기 curated tool 집합 스냅샷. 순서 포함.
// 2026-07-17 갱신(의도적·명시 리뷰): Active 자기인지 4종 추가(19→23) —
// self_recall·logs_query·ops_status·memory_recall(READ-ONLY 자기관측). 미션
// agent 가 실행 중 자기 로그/기억/ops/구현이력을 능동 조회(제1원칙 셀프인지).
// 레지스트리가 SELF_COGNITION_RUNTIMES ledger 순서를 append 하므로 self_recall·logs_query·ops_status·memory_recall 로 갱신.
const MISSION_TOOL_SET_2026_07_17 = [
  'Bash', 'Read', 'Edit', 'Write',
  'update_plan', 'AskUserQuestion',
  'GitCommit', 'FindRepo', 'SyncRepo', 'RefConsult', 'ToolSearch',
  'WebTerminalSnapshot', 'WebTerminalInput', 'WebTerminalScreenshot',
  'WebFetch', 'WebSearch', 'Grep', 'Glob', 'ListDir',
  // Active 자기인지(2026-07-17 추가).
  'self_recall', 'logs_query', 'ops_status', 'memory_recall',
  // CTX2 #23185 — 맥락 한 문(READ-ONLY).
  'context_now',
] as const;

describe('mission tool-set 재현성 가드 (RFC P5)', () => {
  test('SET — 미션 노출 tool 집합이 스냅샷과 정확히 일치(before==after)', () => {
    const { tools } = getAutopilotToolRegistry({ surface: 'dashboard' });
    const names = tools.map((t) => t.name);
    // 집합 동일성(순서 무관) — RFC 는 tool-SET before==after 를 요구.
    expect([...names].sort()).toEqual([...MISSION_TOOL_SET_2026_07_17].sort());
  });

  test('ORDER — 스냅샷 순서까지 동일(프롬프트 재현성 강가드)', () => {
    // 순서도 프롬프트 재현성에 기여하므로 함께 못박는다. P5 수렴이 순서를
    // 바꾸면(surface 는 native-first 정렬) 이 테스트가 잡아 명시적 결정 강제.
    const { tools } = getAutopilotToolRegistry({ surface: 'dashboard' });
    expect(tools.map((t) => t.name)).toEqual([...MISSION_TOOL_SET_2026_07_17]);
  });

  test('Active 자기인지 — 자기관측 4종이 미션 집합에 포함(제1원칙)', () => {
    // 미션 agent 가 실행 중 자기 로그·기억·ops·구현이력을 능동 조회할 수 있어야
    // 한다. READ-ONLY 자기관측 — mutating 코어툴은 제외.
    const { tools } = getAutopilotToolRegistry({ surface: 'dashboard' });
    const names = tools.map((t) => t.name);
    for (const t of ['self_recall', 'logs_query', 'ops_status', 'memory_recall']) {
      expect(names).toContain(t);
    }
    // mutating 코어툴은 미션 실행 중 노출하지 않는다(관측만).
    for (const t of ['schedule_manage', 'mission_decide', 'session_manage']) {
      expect(names).not.toContain(t);
    }
  });

  test('Bash 는 미션 노출 집합에 포함(T1 substrate)', () => {
    // Bash 는 T1 world-I/O substrate. P5 수렴 후에도 surface(coding/mission)
    // 경유로 반드시 포함돼야 한다 — 이 명시 가드로 회귀 방지.
    const { tools } = getAutopilotToolRegistry({ surface: 'dashboard' });
    expect(tools.map((t) => t.name)).toContain('Bash');
  });
});
