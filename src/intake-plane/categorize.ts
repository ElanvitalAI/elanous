/**
 * `intake.categorize` — Phase 1 / I3 / RESEARCH §4.4 + §6.2.
 *
 * Single LLM call that classifies every task in an `EnrichedDecomposition`
 * with:
 *   - `category` — one of seven closed values (research · research-and-plan
 *     · dev-feature · dev-spec · cognitive · debug · workflow-update)
 *   - `workflowEligible` — whether the task can be served by a synthesised
 *     workflow (`true`) or needs human cognition / interactive decision
 *     (`false`).
 *   - `workflowSkeletonHint` — one-line nudge to I5 multi-spec on the
 *     expected node sequence.
 *
 * Output shape: `{ taskId: <slug-id> → categorization }` indexed by the
 * `m-<n>/t-<n>` ids the decomposition already minted, so downstream I4
 * goal_align can join purely on id without re-walking the tree.
 *
 * Like I1, the LLM call is injected. D4-style fallback (everything
 * 'cognitive' + ineligible) keeps the pipeline moving when the model
 * misfires; strict mode opts in to throwing.
 */
import type {
  EnrichedDecomposition,
  EnrichedTask,
} from './enrich.js';
import { summariseContext } from './enrich.js';
import { buildResponseFormatHeader } from './prompt-format.js';
import { judge } from '../llm/judge-layer.js';

// ──────────────────── Closed sets ──────────────────────────────────────

export const TASK_CATEGORIES = [
  'research',
  'research-and-plan',
  'dev-feature',
  'dev-spec',
  'cognitive',
  'debug',
  'workflow-update',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export function isTaskCategory(v: unknown): v is TaskCategory {
  return typeof v === 'string' && (TASK_CATEGORIES as readonly string[]).includes(v);
}

// ──────────────────── Public shapes ────────────────────────────────────

export interface TaskCategorization {
  /** Fully-qualified task id in the decomposition (`m-1/t-3`). */
  taskKey: string;
  category: TaskCategory;
  workflowEligible: boolean;
  workflowSkeletonHint?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface CategorizeResult {
  /** `taskKey` → categorization. Always covers every task in the input
   *  (fallback rows added for any task the LLM omitted). */
  categorizations: Record<string, TaskCategorization>;
  fallback: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    modelId?: string;
  };
}

export interface CategorizeCallable {
  (args: { prompt: string; signal?: AbortSignal; provider?: string; model?: string }): Promise<{
    text: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    modelId?: string;
  }>;
}

export class CategorizeError extends Error {
  constructor(
    public readonly code: 'LLM_CALL_FAILED' | 'PARSE_FAILED',
    message: string,
    public readonly rawText?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CategorizeError';
  }
}

// ──────────────────── Helpers ──────────────────────────────────────────

export function taskKey(missionId: string, taskId: string): string {
  return `${missionId}/${taskId}`;
}

function listTasks(decomposition: EnrichedDecomposition): Array<{
  key: string;
  task: EnrichedTask;
  missionTitle: string;
}> {
  const out: Array<{ key: string; task: EnrichedTask; missionTitle: string }> = [];
  for (const m of decomposition.missions) {
    for (const t of m.tasks) out.push({ key: taskKey(m.id, t.id), task: t, missionTitle: m.title });
  }
  return out;
}

// ──────────────────── Prompt builder ───────────────────────────────────

export function buildCategorizePrompt(decomposition: EnrichedDecomposition): string {
  const items = listTasks(decomposition);
  const body = items
    .map(({ key, task, missionTitle }) => {
      const ctx = summariseContext(task, 240);
      const parts = [
        `- key: ${key}`,
        `  mission: ${missionTitle}`,
        `  title: ${task.title}`,
        `  intent: ${task.intent}`,
      ];
      if (ctx) parts.push(`  context:\n    ${ctx.replace(/\n/g, '\n    ')}`);
      return parts.join('\n');
    })
    .join('\n');

  return [
    'SYSTEM:',
    '당신은 task categorizer 입니다. 각 task 가 어느 종류이고 workflow 합성 적합 여부를 판단하세요.',
    '',
    '카테고리 (closed set):',
    '- research: 외부 자료 조사 + 요약 (omni-digest/crawl 패턴)',
    '- research-and-plan: research + 구체적 plan 작성',
    '- dev-feature: 코드 작성 (구체 implementation)',
    '- dev-spec: 기능 명세 작성 (코드 X)',
    '- cognitive: 사용자가 직접 확인/판단 필요 (시스템 자동 X)',
    '- debug: 특정 현상 분석 (deterministic 작업 어려움)',
    '- workflow-update: 기존 workflow 수정 (신규 workflow X)',
    '',
    'workflow_eligible 판단:',
    '- 자동 fetch · LLM 호출 · 파일 작업으로 완수 가능 → true',
    '- 사용자 인지 · 시스템 외부 · interactive 결정 필요 → false',
    '',
    ...buildResponseFormatHeader([
      '{',
      '  "categorizations": [',
      '    {',
      '      "key": "m-1/t-1",',
      '      "category": "research-and-plan",',
      '      "workflowEligible": true,',
      '      "workflowSkeletonHint": "omni-digest 2 url → llm plan",',
      '      "confidence": "high"',
      '    }',
      '  ]',
      '}',
    ].join('\n')),
    '',
    // FU8 follow-up #2 (2026-05-12) — worked example covering the
    // 3 highest-frequency category transitions we expect dogfood
    // traffic to hit:
    //   1. URL + plan keywords → research-and-plan + eligible
    //   2. Pure code action verb → dev-feature + eligible
    //   3. User-cognition phrasing → cognitive + NOT eligible
    // Picks one task from each archetype so the LLM sees how the
    // closed-set categories map to memo-shape cues without us
    // baking in phase-specific worked-example bloat across all 6
    // category values (deferred until dogfood signal narrows the
    // miss surface).
    'WORKED EXAMPLE (참고용):',
    'USER tasks:',
    '- key: m-1/t-1',
    '  mission: 다이어그램 능력 강화',
    '  title: Mermaid live-render plan',
    '  intent: 사이드 패널에서 실시간 mermaid 렌더링 흐름 설계',
    '  context:',
    '    urls: ["https://mermaid.live"]',
    '    keywords: ["mermaid", "live-render"]',
    '- key: m-1/t-2',
    '  mission: 다이어그램 능력 강화',
    '  title: kitty graphics 프로토콜 시그널 호환 구현',
    '  intent: 터미널 이미지 출력 코드 작성',
    '- key: m-2/t-1',
    '  mission: 주간 회고',
    '  title: 이번 주 회고 미팅 일정 잡기',
    '  intent: 동료 3명 시간 조율 + 캘린더 등록',
    '응답:',
    '```json',
    '{',
    '  "categorizations": [',
    '    {',
    '      "key": "m-1/t-1",',
    '      "category": "research-and-plan",',
    '      "workflowEligible": true,',
    '      "workflowSkeletonHint": "omni-digest mermaid.live → llm draft plan",',
    '      "confidence": "high"',
    '    },',
    '    {',
    '      "key": "m-1/t-2",',
    '      "category": "dev-feature",',
    '      "workflowEligible": true,',
    '      "workflowSkeletonHint": "spec + bash test loop",',
    '      "confidence": "high"',
    '    },',
    '    {',
    '      "key": "m-2/t-1",',
    '      "category": "cognitive",',
    '      "workflowEligible": false,',
    '      "confidence": "high"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'USER tasks:',
    body,
  ].join('\n');
}

// ──────────────────── Parse + coerce ──────────────────────────────────

function coerceConfidence(v: unknown): 'high' | 'medium' | 'low' {
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'medium';
}

export function coerceCategorizations(
  raw: unknown,
  validKeys: ReadonlySet<string>,
): Record<string, TaskCategorization> | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as Record<string, unknown>).categorizations;
  if (!Array.isArray(list)) return null;
  const out: Record<string, TaskCategorization> = {};
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : null;
    const category = isTaskCategory(r.category) ? r.category : null;
    if (!key || !category) continue;
    if (!validKeys.has(key)) continue;
    out[key] = {
      taskKey: key,
      category,
      workflowEligible: typeof r.workflowEligible === 'boolean' ? r.workflowEligible : false,
      workflowSkeletonHint:
        typeof r.workflowSkeletonHint === 'string' && r.workflowSkeletonHint.length > 0
          ? r.workflowSkeletonHint
          : undefined,
      confidence: coerceConfidence(r.confidence),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ──────────────────── Fallback ─────────────────────────────────────────

/** All-cognitive · workflow_eligible=false · low confidence. Pessimistic so
 *  the user reviews everything in I7 preview. */
function fallbackRow(key: string): TaskCategorization {
  return {
    taskKey: key,
    category: 'cognitive',
    workflowEligible: false,
    confidence: 'low',
  };
}

// ──────────────────── Public entry ─────────────────────────────────────

export interface CategorizeOptions {
  callable: CategorizeCallable;
  signal?: AbortSignal;
  strict?: boolean;
}

export async function categorizeDecomposition(
  decomposition: EnrichedDecomposition,
  opts: CategorizeOptions,
): Promise<CategorizeResult> {
  const tasks = listTasks(decomposition);
  const validKeys = new Set(tasks.map((t) => t.key));
  if (validKeys.size === 0) {
    return { categorizations: {}, fallback: false };
  }

  const prompt = buildCategorizePrompt(decomposition);

  const decision = await judge({
    site: 'intake.categorize', prompt, signal: opts.signal,
    call: ({ prompt, signal, provider, model }) => opts.callable({ prompt, signal, provider, model }),
    schema: (parsed) => coerceCategorizations(parsed, validKeys),
  });
  if (!decision.ok) {
    if (opts.strict) {
      if (decision.reason === 'call') {
        throw new CategorizeError('LLM_CALL_FAILED',
          decision.error instanceof Error ? decision.error.message : String(decision.error));
      }
      throw new CategorizeError('PARSE_FAILED', 'no usable categorizations', decision.rawText);
    }
    return {
      categorizations: Object.fromEntries(tasks.map((t) => [t.key, fallbackRow(t.key)])),
      fallback: true,
    };
  }

  // Backfill any missing tasks with the fallback shape so callers can
  // index by key without null checks.
  const filled: Record<string, TaskCategorization> = { ...decision.value };
  for (const t of tasks) {
    if (!filled[t.key]) filled[t.key] = fallbackRow(t.key);
  }
  return {
    categorizations: filled,
    fallback: false,
    usage: {
      promptTokens: decision.reply.promptTokens,
      completionTokens: decision.reply.completionTokens,
      costUsd: decision.reply.costUsd,
      modelId: decision.reply.modelId,
    },
  };
}
