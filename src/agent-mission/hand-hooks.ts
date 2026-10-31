import { randomUUID } from 'node:crypto';
import { MissionLineEvent, MissionLineInput, postMissionLineEvent } from './mission-line.js';

/**
 * HAND-HOOKS-NEXUS-STATUS 재수리 — OP #54582 승인 · TC #54571 계약 (2026-10-30).
 *
 * 손(hook) 클라이언트: TC 소유 수신기·서버·별도 endpoint는 여기에 없다. 기존 계약
 * `POST /v1/missions/{missionId}/line`(`src/agent-mission/mission-line.ts` 의
 * `postMissionLineEvent`)만 지나간다. Claude Code 훅(SessionStart·UserPromptSubmit·Stop·
 * StopFailure·PreToolUse)과 Codex notify 는 **progress 만** 보낸다. final 은 명시적
 * `mission reply --done` 전용이며 ask/answer/correct 는 예약(구현하지 않는다).
 * 인증: missionId+attemptId+손별 Bearer. token(ELANOUS_HAND_TOKEN)은 child env 에만
 * 둔다 — 인자·파일·다른 저장 위치를 쓰지 않는다. 각 훅 호출은 한 건의 progress 만
 * 보내고 병렬 송신 경로를 만들지 않는다(Pod concurrency=1).
 */

/** Claude Code 훅 이벤트 중 progress 를 보낼 때 허용되는 목록. */
export const CLAUDE_CODE_PROGRESS_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse'] as const;

export interface HandProgressInput {
  missionId: string;
  attemptId: string;
  agent: 'codex' | 'claude';
  source: string;
  text: string;
  state?: string;
}

export function renderClaudeHandSource(event: string): string {
  return `claude-code:${event}`;
}

export function renderCodexHandSource(tool: string): string {
  return `codex-notify:${tool}`;
}

/**
 * 손(hook) 발화 한 건을 progress 로 기존 mission-line 계약에 싣는다.
 * lineId 는 이 계약이 새로 발급하고, token 은 env(deps.env ?? process.env)에서만 읽는다.
 */
export async function postHandProgress(
  input: HandProgressInput,
  deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<MissionLineEvent> {
  const payload: MissionLineInput = {
    lineId: randomUUID(),
    missionId: input.missionId,
    attemptId: input.attemptId,
    agent: input.agent,
    type: 'progress',
    source: input.source,
    text: input.text,
    ...(input.state === undefined ? {} : { state: input.state }),
  };
  return postMissionLineEvent(payload, deps);
}

function readJsonField(raw: string, field: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[field] === 'string' && (parsed[field] as string).trim() ? (parsed[field] as string).trim() : null;
  } catch { return null; }
}

/** child env 접근자 — 자격(missionId·attemptId)은 child env 에만 있다(파일·인자 저장 금지). */
function missionId(env: NodeJS.ProcessEnv): string {
  return env.ELANOUS_MISSION_ID?.trim() ?? '';
}
function attemptId(env: NodeJS.ProcessEnv): string {
  return env.ELANOUS_ATTEMPT_ID?.trim() ?? '';
}

/** CLI: `bun src/agent-mission/hand-hooks.ts claude-code|codex-notify` — stdin JSON 훅 본문. fail-soft(exit 0). */
async function main(): Promise<number> {
  const mode = process.argv[2] ?? '';
  const env = process.env;
  const mission = missionId(env);
  const attempt = attemptId(env);
  const token = env.ELANOUS_HAND_TOKEN?.trim();
  // 자격은 child env 에만 존재한다 — 없으면 조용히 넘어간다(훅이 Claude Code/Codex 를 막지 않는다).
  if (!mission || !attempt || !token) return 0;
  const raw = await new Response(Bun.stdin.stream()).text();
  const text = raw.slice(0, 200);
  // 계약상 text 는 비어 있으면 안 된다 — 빈 훅 본문은 계약 위반 요청을 만들지 않고 조용히 넘어간다.
  if (!text.trim()) return 0;
  if (mode === 'claude-code') {
    const event = readJsonField(raw, 'hook_event_name');
    // 허용 이벤트만 progress — 그 외(예약 ask/answer/correct·final)는 여기서 만들지 않는다.
    if (!event || !(CLAUDE_CODE_PROGRESS_EVENTS as readonly string[]).includes(event)) return 0;
    await postHandProgress({ missionId: mission, attemptId: attempt, agent: 'claude', source: renderClaudeHandSource(event), text });
  } else if (mode === 'codex-notify') {
    const tool = readJsonField(raw, 'tool_name') ?? 'notify';
    await postHandProgress({ missionId: mission, attemptId: attempt, agent: 'codex', source: renderCodexHandSource(tool), text });
  }
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch { process.exit(0); } // fail-soft: 손 전달 실패가 훅 호출자를 막지 않는다.
}