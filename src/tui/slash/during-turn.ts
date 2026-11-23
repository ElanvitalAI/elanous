// TUI-SLASH-DURING-TURN — 판정기: 턴이 도는 중에 친 Enter 의 «/명령» 초안이 조향·대기열이 아니라
// 지금 즉시 로컬 실행(entry.ts 의 한가 제출 디스패치)으로 빠져야 하는가. 실행 자체는 그 한가
// 경로가 맡는다 — 이 판정기는 어느 Enter 가 busy 분기(큐)를 건너뛰는지만 정한다.
//
// 범위: 즉시 실행은 busy 상태를 건드리지 않는 명령만 한다. /provider 목록·조회, 하니스, now
// 처럼 setBusy·turnAbort·turnDone 을 갈아끼우는 분기와 /quit·/new·/compact·/resume 처럼 돌던
// 턴과 세션을 겹치게 하는 명령은 종전 그대로 busy 분기(대기열·거부)를 지킨다 — 한가 경계에서
// 안전하게 실행된다. 비-명령 «/…» 문면(경로·«//글»)도 대화 입력 그대로다.
import { COMMAND_SHAPE } from './unknown-slash.js';
import { parseNextTuiModelCommand } from './model.js';

/** 즉시 실행해도 busy 턴 상태를 건드리지 않는 branch host. */
const IMMEDIATE_BRANCH_HOSTS: ReadonlySet<string> = new Set(['loop', 'memory', 'decide', 'context', 'app', 'sidetab', 'terminal']);

/**
 * true — 이 Enter 는 busy 분기를 건너뛰고 지금 로컬 실행된다(미등록이면 지금 «알 수 없는 명령» 안내).
 * false — busy 분기 그대로(대기열·steer·턴 거부 안내).
 */
export function isNextTuiSlashCommandDraft(
  draft: string,
  registry: typeof import('../core/registry.js'),
): boolean {
  const first = draft.trim().split(/\s+/)[0] ?? '';
  // 경로(«/Users/x»)·«//글» 같은 비-명령 문면은 종전 대화 입력 — unknown-slash 와 같은 명령 모양 판정.
  if (!COMMAND_SHAPE.test(first)) return false;
  const route = registry.resolveNextTuiRoute(draft, registry.NEXT_TUI_INPUT_CONTEXT);
  if (!route) return true; // 미등록 /xxx — 지금 안내로 답한다(모델로 보내지 않는다).
  // 턴·세션을 겹치게 하는 넷은 busy 분기의 기존 거부 안내가 지킨다.
  if (route.action === 'quit' || route.id === 'session.new' || route.id === 'session.compact' || route.id === 'session.resume') return false;
  if (route.id === 'model') {
    // /model fast|normal|deep(및 한국어 별칭)은 지금 즉시 적용(«다음 턴부터» 안내) —
    // /provider 목록·조회 계열은 busy 를 쓰는 조회이므로 종전 대기열을 지킨다.
    const parsed = parseNextTuiModelCommand(draft);
    return parsed.kind === 'tier' || parsed.kind === 'invalid';
  }
  const host = route.branchHost ?? null;
  // 하니스·now 는 busy·turnAbort 를 갈아끼우고, 플러그인 마법사는 대화형 상태를 열어 턴과 섞인다.
  if (host === 'harness' || host === 'now' || host === 'plugin-wizard') return false;
  return route.action === 'help' || route.action === 'command' || route.id === 'graph'
    || (host !== null && IMMEDIATE_BRANCH_HOSTS.has(host));
}
