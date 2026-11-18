// ── 로컬 LLM 벤치마크 · 실행 러너 (2026-07-15) ──────────────────────────────────
//
// 대표 방식 이식: 모델 하나씩·같은 문항 같은 순서·temperature 0·순차. 코딩은 실제 Python 실행 채점.
// chat 은 OpenAI-호환 /v1/chat/completions(LM Studio·본머신/node-b) 기본, 주입으로 테스트/다른 수단 대체.
// 관측: 결과를 debug.log('llm.bench', ...) 로 남겨 `elanous logs --category llm.bench` 조회(제1원칙).

import { debug } from '../../../debug/log.js';
import { llmNetworkFetch } from '../../../session-runtime/llm-call-gateway.js';
import { runPython } from './code-exec.js';
import { BENCH_TASKS, categoryMaxes, type BenchCategory, type BenchTask, type CodeExecutor } from './tasks.js';

export interface BenchModelTarget {
  /** 노드 id(node-b·local 등) — 표기·SSH RSS 프로브용. */
  readonly node: string;
  /** 모델 id(엔드포인트가 서빙하는 이름). */
  readonly model: string;
  /** OpenAI-호환 베이스 URL(예: http://node-b:1234). */
  readonly endpoint: string;
}

/** chat 반환 — 텍스트만(문자열) 또는 토큰수 포함(tok/s 계측). 하위호환: 문자열도 허용. */
export interface BenchChatResult { readonly text: string; readonly completionTokens?: number }
/** 단일턴 chat — 프롬프트 → content(+선택 토큰수). temperature 0 고정(러너가 강제). */
export type BenchChat = (prompt: string) => Promise<string | BenchChatResult>;

export interface TaskResult {
  readonly id: string;
  readonly category: BenchCategory;
  readonly score: number;
  readonly max: number;
  readonly detail: string;
  readonly latencyMs: number;
  /** 모델 응답 실패(네트워크/타임아웃) 여부. */
  readonly errored: boolean;
  /** 응답 생성 토큰수(API usage) · 미보고 시 undefined. */
  readonly completionTokens?: number;
  /** 실효 tok/s(prefill 포함·completionTokens/latency) · 토큰 미보고 시 undefined. */
  readonly tokPerSec?: number;
}

export interface Scorecard {
  readonly target: BenchModelTarget;
  readonly total: number;
  readonly max: number;
  readonly byCategory: Record<BenchCategory, { score: number; max: number }>;
  readonly tasks: readonly TaskResult[];
  /** 첫 문항 왕복(워밍업 포함) ms. */
  readonly warmupMs: number;
  /** 전체 벤치 소요 ms. */
  readonly totalMs: number;
  readonly startedAt: number;
  /** ★ 개선 B(방법론) — 총점 ≥95% 면 ceiling saturation(이 벤치로 이 모델을 변별 불가·harder tier 필요). */
  readonly saturated: boolean;
  /** 실효 처리량(tok/s) — 전 문항 completionTokens 합 / 생성시간 합. MLX vs GGUF 등 포맷 A/B 지표
   *  (연구: Apple Silicon 포맷 비교의 핵심 척도). 토큰 미보고(주입 chat 등)면 undefined. */
  readonly tokPerSec?: number;
  /** 생성 토큰 총합(tok/s 근거). */
  readonly totalCompletionTokens?: number;
}

export interface BenchmarkDeps {
  /** chat 주입 — 기본은 endpoint 로의 OpenAI-호환 호출. 테스트/다른 수단(SDK 등) 대체. */
  readonly chat?: BenchChat;
  /** 코드 실행 주입 — 기본 runPython. */
  readonly exec?: CodeExecutor;
  /** 태스크 override(부분 실행·테스트). 기본 BENCH_TASKS 전량. */
  readonly tasks?: readonly BenchTask[];
  /** 문항 chat 타임아웃(ms) · 기본 90초(대형 로컬 모델 여유). */
  readonly chatTimeoutMs?: number;
  /** 응답 토큰 상한 · 기본 16384. ⚠️ thinking 모델(qwen3/glm/nemotron)은 reasoning 에 토큰을 크게 써
   *  content 가 비므로 넉넉히(4096 이면 추론만 하다 잘림·content 빔 = 부당 0점). */
  readonly maxTokens?: number;
  /** 프롬프트 프리픽스 — 튜닝 스윕용. 예: `/no_think\n`(qwen-family thinking off·−36% wall).
   *  기본 chat 에만 적용(주입 chat 은 무시). 2026-07-20. */
  readonly promptPrefix?: string;
  readonly now?: () => number;
}

/**
 * OpenAI-호환 /v1/chat/completions 기본 chat. temperature 0·단일턴.
 * ★ thinking 모델 대응: content 가 비면 `reasoning_content` 로 폴백(추론에 코드/답을 담고 content 를 못 낸
 *   truncation 케이스 구제). max_tokens 는 넉넉히(reasoning 소진 방어).
 */
export function makeOpenAiCompatChat(endpoint: string, model: string, timeoutMs: number, maxTokens = 16384, promptPrefix = ''): BenchChat {
  const base = endpoint.replace(/\/$/, '');
  return async (rawPrompt) => {
    const prompt = promptPrefix ? promptPrefix + rawPrompt : rawPrompt;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await llmNetworkFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: ctrl.signal,
      }, { provider: 'local', model, role: 'aux', requestedBy: 'local-benchmark', selectionSource: 'explicit' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 160)}`);
      const j = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: { completion_tokens?: number };
      };
      const msg = j.choices?.[0]?.message;
      const content = (msg?.content ?? '').trim();
      // content 우선, 비면 reasoning_content(thinking 모델 truncation 구제).
      const text = content || (msg?.reasoning_content ?? '');
      const completionTokens = j.usage?.completion_tokens;
      return completionTokens !== undefined ? { text, completionTokens } : { text };
    } finally {
      clearTimeout(to);
    }
  };
}

/**
 * 모델 하나를 평가 뱅크로 벤치. 순차·temperature 0. 문항 실패(네트워크/타임아웃)는 0점 처리하고 계속.
 * chat 미주입 시 endpoint 로 OpenAI-호환 호출.
 */
export async function benchmarkModel(target: BenchModelTarget, deps: BenchmarkDeps = {}): Promise<Scorecard> {
  const now = deps.now ?? Date.now;
  const tasks = deps.tasks ?? BENCH_TASKS;
  const exec = deps.exec ?? ((source: string) => runPython(source));
  const chat = deps.chat ?? makeOpenAiCompatChat(target.endpoint, target.model, deps.chatTimeoutMs ?? 90_000, deps.maxTokens ?? 16384, deps.promptPrefix ?? '');
  const startedAt = now();

  const results: TaskResult[] = [];
  let warmupMs = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const t0 = now();
    let answer = '';
    let completionTokens: number | undefined;
    let errored = false;
    try {
      const raw = await chat(task.prompt);
      if (typeof raw === 'string') { answer = raw; } else { answer = raw.text; completionTokens = raw.completionTokens; }
    } catch (e) {
      errored = true;
      answer = '';
      debug.log('llm.bench', 'chat-error', { node: target.node, model: target.model, task: task.id, err: e instanceof Error ? e.message.slice(0, 120) : String(e) }, { level: 'error' });
    }
    const graded = errored
      ? { score: 0, max: task.max, detail: '모델 응답 실패' }
      : await task.grade(answer, exec);
    const latencyMs = now() - t0;
    if (i === 0) warmupMs = latencyMs;
    const tokPerSec = completionTokens !== undefined && latencyMs > 0 ? completionTokens / (latencyMs / 1000) : undefined;
    results.push({
      id: task.id, category: task.category, score: graded.score, max: graded.max, detail: graded.detail, latencyMs, errored,
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(tokPerSec !== undefined ? { tokPerSec } : {}),
    });
  }

  const catMax = categoryMaxes(tasks);
  const byCategory: Record<BenchCategory, { score: number; max: number }> = {
    coding: { score: 0, max: catMax.coding },
    reasoning: { score: 0, max: catMax.reasoning },
    rag: { score: 0, max: catMax.rag },
    'kr-format': { score: 0, max: catMax['kr-format'] },
  };
  for (const r of results) byCategory[r.category].score += r.score;
  const total = results.reduce((s, r) => s + r.score, 0);
  const max = results.reduce((s, r) => s + r.max, 0);
  const totalMs = now() - startedAt;

  const saturated = max > 0 && total >= max * 0.95;
  // 실효 tok/s — 토큰 보고된 문항들의 completionTokens 합 / 그 문항들의 생성시간 합(prefill 포함).
  const tokTasks = results.filter((r) => r.completionTokens !== undefined && r.latencyMs > 0);
  const totalCompletionTokens = tokTasks.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
  const totalGenMs = tokTasks.reduce((s, r) => s + r.latencyMs, 0);
  const tokPerSec = totalGenMs > 0 && totalCompletionTokens > 0 ? totalCompletionTokens / (totalGenMs / 1000) : undefined;

  debug.log('llm.bench', 'scorecard', {
    node: target.node, model: target.model, total, max,
    coding: byCategory.coding.score, reasoning: byCategory.reasoning.score,
    rag: byCategory.rag.score, krFormat: byCategory['kr-format'].score,
    warmupMs, totalMs, ...(tokPerSec !== undefined ? { tokPerSec: Math.round(tokPerSec) } : {}),
  });

  return {
    target, total, max, byCategory, tasks: results, warmupMs, totalMs, startedAt, saturated,
    ...(tokPerSec !== undefined ? { tokPerSec, totalCompletionTokens } : {}),
  };
}
