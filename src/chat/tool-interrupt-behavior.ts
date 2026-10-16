// ── 도구별 «제출로 끊어도 되나» 선언 (10-14 · 대표 «지금 밀어 넣기») ─────────────────
//
// 턴 중에 사용자가 «지금 밀어 넣기»를 하면, 도는 도구가 «전부» `cancel` 일 때만 턴을 끊고 그 발화로
// 바로 이어 간다. 하나라도 `block` 이면 끊지 않고 다음 도구 경계에 최우선으로 넣는다.
// ⭐ 기본은 `block` 이다 — 모르는 도구(쓰기·실행·자식 띄우기)를 «끊어도 된다»로 읽지 않는다.
// ⭐ `cancel` 은 부작용 없는 읽기·대기 도구만 — 끊으면 결과를 버릴 뿐 바깥 상태가 안 바뀐다.
//   (Claude Code `Tool.interruptBehavior()` 계약과 같은 축 · 기본 block)
// ⚠️ 이 표가 «도구 선언 칸»이다. TUI 는 도는 도구의 «이름»만 알아서 스펙 객체가 아니라 이름으로 선언한다.
//   새 읽기 전용 도구를 더하면 여기 한 줄을 더한다.

export type ToolInterruptBehavior = 'cancel' | 'block';

const DECLARED: ReadonlyMap<string, ToolInterruptBehavior> = new Map<string, ToolInterruptBehavior>([
  ['Read', 'cancel'],
  ['Grep', 'cancel'],
  ['Glob', 'cancel'],
  ['ListDir', 'cancel'],
  ['WebSearch', 'cancel'],
  ['WebFetch', 'cancel'],
  // 대기·조회 — 끊어도 자식은 산다(턴만 끊는다).
  ['AgentOutput', 'cancel'],
  ['AgentList', 'cancel'],
  ['TaskGet', 'cancel'],
  ['TaskList', 'cancel'],
]);

export function toolInterruptBehavior(name: string): ToolInterruptBehavior {
  return DECLARED.get(name) ?? 'block';
}

/**
 * 도는 도구가 «전부» 끊어도 되는가. 도는 도구가 없으면(모델이 글을 쓰는 중) 참이다.
 * 막는 도구 이름을 함께 낸다(안내 줄용).
 */
export function canInterruptRunningTools(names: readonly string[]): { ok: boolean; blocking: string[] } {
  const blocking = [...new Set(names.filter(name => toolInterruptBehavior(name) === 'block'))].sort();
  return { ok: blocking.length === 0, blocking };
}
