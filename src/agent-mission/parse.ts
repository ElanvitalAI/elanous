// ── agent-mission pure parsers ──
//
// codex-in-elanous PTY RFC 미션(driver.ts)의 순수 파싱 로직. 무거운 import 없이 테스트 가능.
// ⚠️ testGate 버그 교훈: `bun test` 출력 "2 pass 0 fail" 은 "fail" 문자열을 포함하므로
// 단순 `/fail/.test()` 는 거짓실패를 낸다. 반드시 **실패 개수**를 파싱해 0 인지 본다.

export interface TestOutcome {
  ok: boolean;
  pass: number;
  fail: number;
  /** "Ran N tests across M file(s)" 의 N — 실행된 테스트 수. */
  ranTests: number;
  /** M — 실행된 **파일** 수. **0 이면 지정 파일이 하나도 안 돌았다**(경로 오타·no-match).
   *  bun 은 substring 필터라 매칭 0 이어도 exit 0·경고 0 이라 "33 pass/exit 0" 로 거짓
   *  통과하던 근본(INCIDENT-2026-07-24 타임존 트랙 발단)의 직접 증거. */
  ranFiles: number;
  /** 실행 규모 요약("Ran N tests across M files")이 출력에 있었나. 없으면 하위호환. */
  hasRunSummary: boolean;
}

/** `bun test` 출력에서 증거를 파싱. ok = 실패 0 · 통과>0 · **실제로 파일이 돌았다**.
 *  ⭐OH8: pass/fail 만 보면 "아무 파일도 안 돌았는데 통과"(exit 0·오타 필터)를 못 잡는다.
 *  실행 규모(ranFiles)를 증거로 실어 거짓 통과를 차단한다. */
export function parseTestOutput(out: string): TestOutcome {
  // bun 요약 라인: " N pass" / " M fail" (각각 별 줄). 마지막 요약을 취한다.
  const pass = lastInt(out, /(\d+)\s+pass\b/g);
  const fail = lastInt(out, /(\d+)\s+fail\b/g);
  // "Ran N tests across M file(s)." — 단수 file / 복수 files 모두.
  const ran = /Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/i.exec(out);
  const hasRunSummary = ran !== null;
  const ranTests = ran ? parseInt(ran[1]!, 10) : 0;
  const ranFiles = ran ? parseInt(ran[2]!, 10) : 0;
  // 요약이 있으면 ranFiles>0 필수(0 파일=거짓 통과). 요약이 없으면(구버전·부분 출력·비-bun)
  // 하위호환 위해 종전 규칙(fail0·pass>0)만 적용.
  const ok = fail === 0 && pass > 0 && (!hasRunSummary || ranFiles > 0);
  return { ok, pass, fail, ranTests, ranFiles, hasRunSummary };
}

function lastInt(s: string, re: RegExp): number {
  let m: RegExpExecArray | null; let v = 0; let seen = false;
  while ((m = re.exec(s)) !== null) { v = parseInt(m[1]!, 10); seen = true; }
  return seen ? v : 0;
}

/** `tsc --noEmit` 출력에서 `error TS` 라인만 추출. */
export function parseTscErrors(out: string): string[] {
  return out.split('\n').filter((l) => /error TS\d+/.test(l));
}

// ★ P4 — 'provision' 추가(감독이 자식 역량을 자율 설치·[[provision.ts]]). spec/layer 필드 동반.
//   layer 는 **raw 문자열 그대로** 보존한다 — 검증/기본화는 provision 정책이 단일점에서(무효/non-pkg 전부 defer).
//   파서가 무효 layer 를 drop 하면 undefined→pkg 오분류 우회가 생긴다(리뷰 must-fix).
export type BrainAction = 'wait' | 'send' | 'search' | 'verify' | 'done' | 'provision' | 'handoff' | 'ask-human';
export interface BrainDecision { action: BrainAction; text?: string; query?: string; spec?: string; layer?: string; reason: string; to?: 'codex' | 'claude' | 'elanous'; mission?: string; carry?: 'diff' | 'summary'; url?: string; code?: string; }

/** 브레인 LLM 의 원문에서 JSON 결정을 관대하게 파싱. 실패 시 wait 폴백. */
export function parseBrainDecision(raw: string): BrainDecision {
  const jm = raw.match(/\{[\s\S]*\}/);
  if (!jm) return { action: 'wait', reason: `no-json: ${raw.slice(0, 80)}` };
  try {
    const d = JSON.parse(jm[0]) as Record<string, unknown>;
    const action = (['wait', 'send', 'search', 'verify', 'done', 'provision', 'handoff', 'ask-human'] as const).includes(d.action as BrainAction)
      ? (d.action as BrainAction) : 'wait';
    if (action === 'handoff' && (!['codex', 'claude', 'elanous'].includes(d.to as string) || typeof d.mission !== 'string' || !d.mission.trim() || (d.carry !== undefined && d.carry !== 'diff' && d.carry !== 'summary'))) return { action: 'wait', reason: 'invalid handoff' };
    if (action === 'ask-human' && (typeof d.reason !== 'string' || !d.reason.trim())) return { action: 'wait', reason: 'invalid ask-human' };
    return {
      action,
      text: typeof d.text === 'string' ? d.text : undefined,
      query: typeof d.query === 'string' ? d.query : undefined,
      spec: typeof d.spec === 'string' ? d.spec : undefined,
      layer: typeof d.layer === 'string' ? d.layer : undefined,
      reason: typeof d.reason === 'string' ? d.reason : '',
      ...(action === 'handoff' ? { to: d.to as 'codex' | 'claude' | 'elanous', mission: d.mission as string, ...(d.carry ? { carry: d.carry as 'diff' | 'summary' } : {}) } : {}),
      ...(action === 'ask-human' ? { ...(typeof d.url === 'string' ? { url: d.url } : {}), ...(typeof d.code === 'string' ? { code: d.code } : {}) } : {}),
    };
  } catch { return { action: 'wait', reason: 'json-parse-fail' }; }
}

/** codex TUI 화면에서 완료 신호(MISSION-COMPLETE) 를 감지. */
export function screenSignalsComplete(screen: string): boolean {
  return /MISSION-COMPLETE\b/.test(screen);
}

/** codex TUI 화면에서 trust 프롬프트를 감지. */
export function screenNeedsTrust(screen: string): boolean {
  // codex ≥0.157: «Trust this folder? … 1. Trust and continue» (older: «Do you trust the contents …»).
  return /trust the contents|Do you trust|Trust this folder\?/i.test(screen);
}
