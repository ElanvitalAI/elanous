// Goal-judge runtime — Plan-Mode UX P1.2.
//
// After every auto-turn the GoalLoop calls `judgeGoalTurn(...)` to
// decide whether to continue, declare done, retry, or pause. The
// judge is an LLM call against `goals.judgeModel` (or, when empty,
// the primary provider's default) with a tiny JSON-only template.
// Cost target: ~100-200 tokens per call → ~$0.001 with grok-fast.
//
// Fail-safe (CLAUDE.md D6): parse-fail or `empty` after retries
// returns `verdict: 'empty'` to the caller, which translates to
// PAUSE+ASK in the loop. Drift is more dangerous than a confirm.

import { debug } from '../debug/log.js';
import { getProvider, logAgentTurnUsage, resolveDefaultProvider, type LLMMessage, type LLMOpts } from '../llm.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import type { GoalJudgeVerdict } from './types.js';

export interface JudgeInput {
  /** Goal objective the user originally asked for. */
  objective: string;
  /** Last assistant turn text — what the model just said. */
  lastAssistantTurn: string;
  /** Optional: condensed list of recent tool calls (`name(args)` form,
   *  one per line, capped). Helps judge see ACTIONS, not just words. */
  recentToolCalls?: string[];
  /** Optional: plan body when goal was created from plan-mode handoff
   *  (P2 `(G)oal-loop drive`). Lets judge use plan steps as success
   *  criteria. */
  planBody?: string;
}

export interface JudgeResult {
  verdict: GoalJudgeVerdict;
  /** Single-sentence explanation. Surfaced in `/goal status` and
   *  injected into the next continuation prompt so the model sees
   *  what the judge thought. */
  summary: string;
  /** 0..1 self-rated confidence. Below 0.5 with a `done` verdict is
   *  treated by the loop as `partial` (keep going, signal caution). */
  confidence: number;
  /** Approximate tokens billed for this call. Best-effort — provider
   *  may not return usage in the streaming path. */
  tokensUsed?: number;
}

export interface JudgeOptions {
  /** Override the model resolved from goals.judgeModel config. */
  model?: string;
  /** Abort signal threading through to the provider. */
  signal?: AbortSignal;
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are a goal-judge: a tiny binary classifier
that decides whether the assistant has finished a goal handed to it
across multiple turns. You are not the assistant — you are a
supervisor that returns ONE JSON object.`;

const TEMPLATE = `Goal objective:
{OBJECTIVE}

{PLAN_BODY_BLOCK}
Last assistant turn:
{LAST_TURN}

{TOOL_CALLS_BLOCK}
Decide: has the goal been achieved?

Respond with EXACTLY this JSON shape (no other text):
{
  "verdict": "done" | "continue" | "partial" | "empty",
  "summary": "<one sentence — what was just done OR what's still missing>",
  "confidence": <number between 0 and 1>
}

Rules:
- "done" — all observable success criteria met. Use only when you are
  confident the user would say "yes that's it".
- "partial" — substantial real progress but more remains. Use this
  when you'd say "good, but not yet complete".
- "continue" — work is in progress, no obvious blocker. The model
  should keep going.
- "empty" — last turn made no meaningful progress (filler, repetition,
  off-topic). Triggers retry or pause.

Be honest. Bias toward "partial" over "done" when uncertain — the
loop will keep going, which is cheaper than a wrong "done".`;

export function buildJudgeMessages(input: JudgeInput): LLMMessage[] {
  const planBlock = input.planBody
    ? `Plan steps (success criteria — judge against these):
${input.planBody.trim()}

`
    : '';
  const toolsBlock = input.recentToolCalls && input.recentToolCalls.length > 0
    ? `Recent tool calls (most recent first, capped):
${input.recentToolCalls.slice(0, 10).map((t) => `  • ${t}`).join('\n')}

`
    : '';
  const body = TEMPLATE
    .replace('{OBJECTIVE}', input.objective.trim())
    .replace('{PLAN_BODY_BLOCK}', planBlock)
    .replace('{LAST_TURN}', input.lastAssistantTurn.trim().slice(0, 8_000))
    .replace('{TOOL_CALLS_BLOCK}', toolsBlock);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: body },
  ];
}

const VERDICT_VALUES: ReadonlySet<GoalJudgeVerdict> = new Set(['done', 'continue', 'partial', 'empty']);

export function parseJudgeResponse(raw: string): JudgeResult | null {
  // Provider may wrap in ```json``` fences or surround with extra
  // text. Hunt the first { and the last } and try to parse.
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const verdictRaw = typeof o.verdict === 'string' ? o.verdict.toLowerCase() : '';
  if (!VERDICT_VALUES.has(verdictRaw as GoalJudgeVerdict)) return null;
  const summary = typeof o.summary === 'string' ? o.summary : '';
  const confidenceRaw = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence ?? NaN);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;
  return {
    verdict: verdictRaw as GoalJudgeVerdict,
    summary: summary.trim() || '(judge returned no summary)',
    confidence,
  };
}

/** Apply the confidence guard: a `done` with low confidence is
 *  downgraded to `partial` so the loop keeps going. The model may
 *  signal "I think it's done but I'm not sure" — we believe the
 *  doubt, not the verdict. */
export function applyConfidenceGuard(r: JudgeResult): JudgeResult {
  if (r.verdict === 'done' && r.confidence < 0.5) {
    return { ...r, verdict: 'partial', summary: `[low-conf done → partial] ${r.summary}` };
  }
  return r;
}

/** Run a single judge call. Throws on AbortSignal / timeout / no
 *  provider. Returns null when parsing fails on every retry attempt
 *  (loop translates this to PAUSE+ASK). */
export async function judgeGoalTurn(
  input: JudgeInput,
  opts: JudgeOptions & { retries?: number } = {},
): Promise<JudgeResult | null> {
  const retries = Math.max(0, opts.retries ?? 0);
  // 모델을 안 주면 런타임 기본 결정(auto = codex 등)을 쓴다 — 종전 `getProvider(undefined)` 는 다른 답을 냈다.
  const provider = opts.model ? getProvider(opts.model) : resolveDefaultProvider();
  const messages = buildJudgeMessages(input);

  const llmOpts: LLMOpts = {
    model: opts.model,
    temperature: 0.1,
    maxTokens: 300,
    signal: opts.signal,
    promptCache: false, // tiny call, cache overhead not worth it
  };

  let lastRaw = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    debug.log('goal', 'judge.call', {
      objective: input.objective.slice(0, 80),
      attempt,
      provider: provider.name,
      model: opts.model ?? provider.defaultModel,
    });

    let text = '';
    let usage: LLMUsage = {};
    try {
      const t0 = Date.now();
      if (provider.streamChat) {
        for await (const ev of provider.streamChat(messages, llmOpts)) {
          if (ev.type === 'text' && ev.delta) text += ev.delta;
          else if (ev.type === 'usage') usage = { ...usage, ...ev.usage };
          if (opts.timeoutMs && Date.now() - t0 > opts.timeoutMs) {
            throw new Error(`judge timeout after ${opts.timeoutMs}ms`);
          }
        }
      } else {
        for await (const chunk of provider.chat(messages, llmOpts)) {
          text += chunk;
          if (opts.timeoutMs && Date.now() - t0 > opts.timeoutMs) {
            throw new Error(`judge timeout after ${opts.timeoutMs}ms`);
          }
        }
      }
      try {
        logAgentTurnUsage(opts.model ?? provider.defaultModel, usage, { providerName: provider.name, site: 'goals.judge' });
      } catch { /* best-effort observation */ }
    } catch (err) {
      debug.log('goal', 'judge.error', { attempt, message: (err as Error).message }, { level: 'error' });
      // On timeout / abort, return null so the loop can pause-ask
      // rather than retrying a stuck call.
      return null;
    }

    lastRaw = text;
    const parsed = parseJudgeResponse(text);
    if (parsed) {
      const guarded = applyConfidenceGuard(parsed);
      debug.log('goal', 'judge.result', {
        verdict: guarded.verdict,
        confidence: guarded.confidence,
        summary: guarded.summary.slice(0, 120),
      });
      return guarded;
    }
    debug.log('goal', 'judge.parse-fail', { attempt, raw: text.slice(0, 200) }, { level: 'error' });
  }
  // All attempts failed — return empty marker so caller can pause+ask
  debug.log('goal', 'judge.exhausted', { retries, lastRaw: lastRaw.slice(0, 200) });
  return null;
}
