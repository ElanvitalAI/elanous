// ── ACP Claude Code 최종 완결 판정 (독립 권위 심판) ──
//
// PLAN-review-reactive-completion-loop §4 L2 + 최종심판.
// review-loop 의 rework + 객관 게이트(tsc/test) 통과 위에, **독립적인 Claude Code(Opus)** 를
// ACP 로 호출해 최종 머지 판정을 받는다. 구현(codex)·드라이브(elanous 브레인)·심판(Claude/ACP)이
// 서로 다른 주체라 단일모델 러버스탬프가 원천 불가.
// 재사용: AcpAgent(`elanous acp test` 와 동일 경로) · 순수 파서.
import { type AcpAgent } from '../acp/client.js';
import { globalAcpAgentManager } from '../acp/agent-manager.js';
import { canonicalizeBackendId, getAcpBackend } from '../acp/backend-registry.js';
import { debug } from '../debug/log.js';
import { DEFAULT_REVIEW_BACKEND, isReadOnlyReviewTool } from '../agent-substrate/acp-reviewer.js';
import { extractFirstJsonObject } from '../autopilot/llm-control-brain.js';

type AcpAgentManagerPort = {
  getAgent: (backendId: string, opts: Omit<ConstructorParameters<typeof AcpAgent>[0], 'backendId'>) => Promise<AcpAgent>;
};

export type JudgeVerdict = 'merge' | 'rework' | 'reject' | 'ambiguous';
export interface AcpJudgeResult {
  verdict: JudgeVerdict; asks: string[]; reason: string; raw: string;
  /** TA-LAND-MUSTFIX-ZERO — 심판 JSON 의 asks 가 없거나 배열이 아니거나 문자열 아닌 원소가 섞였다(`asks` 는 소비처 호환으로 `[]`·걸러진 값).
   *  ⛔ 이때 `asks: []` 는 «남은 지적 0» 이 아니라 «모름» — 자동 병합 관문이 `review-must-fix-unknown` 으로 막는다. */
  asksUnreadable?: true;
}

/** ACP 최종심판에 전달하는 PR diff의 기본 문자 상한. */
export const DEFAULT_JUDGE_DIFF_CHAR_LIMIT = 24_000;

/** 심판 프롬프트와 사람이 읽는 범위 문면이 공유하는 유일한 diff 제한 계산. */
export interface PreparedJudgeDiff {
  judgeDiff: string;
  judgeChars: number;
  totalChars: number;
  truncated: boolean;
}

export function prepareJudgeDiff(diff: string, limit = DEFAULT_JUDGE_DIFF_CHAR_LIMIT): PreparedJudgeDiff {
  const truncated = diff.length > limit;
  const judgeDiff = diff.slice(0, limit);
  return { judgeDiff, judgeChars: judgeDiff.length, totalChars: diff.length, truncated };
}

export interface AcpJudgeInput {
  /** 테스트용 ACP 에이전트 매니저. 운영에서는 process-wide 매니저를 사용한다. */
  agentManager?: AcpAgentManagerPort;
  /** PR 변경 diff(잘릴 수 있음). */
  diff: string;
  /** 무엇을 반영했나(리뷰 지적 목록 등)·PR 의도. */
  context: string;
  /** 객관 게이트(tsc/test) 통과 여부 — 심판에 사실로 제공. */
  gatePassed: boolean;
  cwd: string;
  backend?: string;       // 기본 'claude' (Claude Code via ACP)
  model?: string;         // 모델 tier 별칭 (opus|sonnet|haiku). 지정 시 session/set_model 로 고정.
  diffCharLimit?: number; // 기본 24000
  timeoutMs?: number;     // 심판 1턴 최대 대기(tool-enabled 라 파일 읽기 hang 방지). 기본 300000.
}

/** 심판 프롬프트 — 스킵티컬한 최종 머지 심판. JSON 만 요구. */
export function buildJudgePrompt(input: AcpJudgeInput): string {
  const preparedDiff = prepareJudgeDiff(input.diff, input.diffCharLimit ?? DEFAULT_JUDGE_DIFF_CHAR_LIMIT);
  const diff = preparedDiff.truncated ? `${preparedDiff.judgeDiff}\n… [diff truncated]` : preparedDiff.judgeDiff;
  return [
    'You are the FINAL MERGE JUDGE for a monad-agent pull request. You are an INDEPENDENT reviewer — you did not write this code. Be skeptical and rigorous; do not rubber-stamp.',
    '',
    'You MAY and SHOULD use your read-only tools (Read, Grep, Glob) to verify claims the diff alone cannot settle — ESPECIALLY:',
    '- Is a NEW or CHANGED export actually imported/used anywhere? (dead-code / orphan check — grep the symbol repo-wide; an unused new module is NOT mergeable scaffolding.)',
    '- Do callers OUTSIDE the diff break with this change?',
    '- Does claimed behavior actually exist / is it wired to a real entry point?',
    'Do NOT edit files, run mutating commands, push, or open PRs — verify only, then decide.',
    '',
    `Objective gates (deterministic): tsc/test = ${input.gatePassed ? 'PASSED' : 'NOT PASSED'}.`,
    '',
    'What was addressed / PR intent:',
    input.context.slice(0, 3000),
    '',
    'PR diff:',
    '```diff',
    diff,
    '```',
    '',
    'Decide the merge verdict. Criteria:',
    '- "merge": objective gates passed AND the change is correct, complete for its stated scope, safe (no security/regression), and genuinely addresses the intent — not plausible scaffolding.',
    '- "rework": specific, fixable issues remain — list them concretely in "asks" (each actionable, one line).',
    '- "reject": wrong direction / design flaw / needs human decision — not fixable by mechanical rework.',
    'If objective gates did NOT pass, you cannot answer "merge".',
    '',
    'Respond with STRICT JSON only, no prose, no code fence:',
    '{"verdict":"merge|rework|reject","asks":["..."],"reason":"<one or two sentences>"}',
  ].join('\n');
}

/** 심판 원문에서 JSON 판정 파싱(관대). */
export function parseJudge(raw: string): AcpJudgeResult {
  const json = extractFirstJsonObject(raw);
  if (!json) return { verdict: 'ambiguous', asks: [], reason: `no-json: ${raw.slice(0, 100)}`, raw };
  try {
    const d = JSON.parse(json) as { verdict?: string; asks?: unknown; reason?: string };
    const verdict = (['merge', 'rework', 'reject', 'ambiguous'] as const).includes(d.verdict as JudgeVerdict) ? (d.verdict as JudgeVerdict) : 'ambiguous';
    const asks = Array.isArray(d.asks) ? d.asks.filter((x): x is string => typeof x === 'string') : [];
    const asksUnreadable = !Array.isArray(d.asks) || asks.length !== d.asks.length;
    return { verdict, asks, reason: typeof d.reason === 'string' ? d.reason : '', raw, ...(asksUnreadable ? { asksUnreadable: true as const } : {}) };
  } catch { return { verdict: 'ambiguous', asks: [], reason: 'json-parse-fail', raw }; }
}

/** ⭐ ACP Claude Code 를 최종 심판으로 호출. gate 미통과면 호출 없이 rework(안전). */
export async function judgeWithAcp(input: AcpJudgeInput): Promise<AcpJudgeResult> {
  if (!input.gatePassed) {
    return { verdict: 'rework', asks: ['객관 게이트(tsc/test) 미통과 — 먼저 통과시켜라.'], reason: 'gate not passed', raw: '' };
  }
  // ⛔⭐⭐ 리뷰어와 **같은 상수**를 쓴다(`DEFAULT_REVIEW_BACKEND` = codex · `JDG-S9`).
  //   ⚠️ 2026-08-01 교차 리뷰 must-fix: `acp-reviewer` 만 고치고 여기를 놓쳤었다 —
  //   ***`-32602` 를 실제로 낸 것은 이 심판 경로였다***(`--final-judge`). 두 곳이 갈리면
  //   "리뷰는 codex, 심판은 claude" 가 되어 결손이 그대로 남는다.
  const requestedBackend = input.backend ?? DEFAULT_REVIEW_BACKEND;
  const backend = canonicalizeBackendId(requestedBackend);
  const transport = getAcpBackend(backend).transport ?? 'acp';
  const timeoutMs = input.timeoutMs ?? 300_000;
  debug.log('acp-judge', 'start', {
    requestedBackend,
    backend,
    transport,
    model: input.model ?? '(default)',
    diffChars: input.diff.length,
  });
  // ★ tool-enabled 심판(#5181·백로그3·acp-reviewer 패턴 이식) — read-only 화이트리스트 approver 로 Read/Grep/
  //   Glob 만 자동허가(Write/Bash/Edit 거부). 심판이 실제 레포 파일을 읽어 호출처/미배선(orphan dead-code)까지
  //   검증(diff-only 심판의 맹점 해소·e4f97b 류 orphan FAIL 을 심판이 스스로 포착). approver 부재 시 퍼미션
  //   자동취소로 Read 반복거부 정체 → 무조건 필요. 각 허가/거부는 debug.log(제1원칙 관측 관문).
  let allowed = 0; let denied = 0;
  const manager = input.agentManager ?? globalAcpAgentManager();
  const agent = await manager.getAgent(backend, {
    cwd: input.cwd,
    log: (message) => debug.log('acp-judge', 'agent-log', { backend, message }),
    permissionApprover: async (req) => {
      const ok = isReadOnlyReviewTool(req.kind, req.title);
      if (ok) { allowed++; debug.log('acp-judge', 'permission-allow', { n: allowed, title: req.title.slice(0, 80), kind: req.kind ?? null }); }
      else { denied++; debug.log('acp-judge', 'permission-deny', { n: denied, title: req.title.slice(0, 80), kind: req.kind ?? null }); }
      return ok;
    },
  });
  let text = '';
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sid = await agent.newSession();
    if (input.model) {
      const picked = await agent.selectSessionModel(sid, input.model);
      debug.log('acp-judge', 'model', { requested: input.model, picked: picked?.name ?? null, backend });
    }
    timer = setTimeout(() => { timedOut = true; agent.cancel(sid).catch(() => { /* noop */ }); }, timeoutMs);
    await agent.prompt(sid, [{ type: 'text', text: buildJudgePrompt(input) }], (u) => {
      if (u.sessionUpdate === 'agent_message_chunk') {
        const c = u.content;
        if (c.type === 'text' && c.text) text += c.text;
      }
    });
    if (timedOut) throw new Error(`ACP judge 타임아웃(${timeoutMs}ms·툴콜 ${allowed})`);
  } catch (e) {
    debug.log('acp-judge', 'error', { message: (e as Error).message }, { level: 'error' });
    return { verdict: 'ambiguous', asks: [], reason: `ACP judge 오류: ${(e as Error).message}`, raw: text };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const r = parseJudge(text);
  const extractedJson = r.reason === 'json-parse-fail' ? extractFirstJsonObject(text) : null;
  debug.log('acp-judge', 'verdict', {
    verdict: r.verdict,
    asks: r.asks.length,
    reason: r.reason.slice(0, 120),
    ...(r.reason === 'json-parse-fail' ? {
      rawTail: text.slice(-500),
      extractedJson: extractedJson?.slice(0, 500) ?? null,
    } : {}),
  });
  return r;
}
