// ── Agent runner ──
//
// Phase B3 — turns an AgentTask into a stream of AgentEvent frames.
//
// Architecture: streamLLMWithTools is callback-based, but consumers of
// the agent runtime expect an async iterable (so the log adapter can
// drive the Phase F thread folding). We bridge the two with a small
// AsyncEventQueue — callbacks push events, the generator drains them.
//
// Task state lives in the AgentTask object supplied by the registry;
// the runner updates state/result/error fields as the run progresses.
// Every early exit path (abort, throw, done) closes the queue so the
// generator terminates instead of hanging.

import {
  inferProviderFromModel,
  isModelCompatible,
  resolveDefaultProvider,
  streamLLMWithTools,
  type LLMMessage,
  type LLMToolSpec,
} from '../llm.js';
import { debug } from '../debug/log.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { getModelFamily } from '../models/prompts.js';
import { resolveModelAlias } from '../intelligence-map/model-alias.js';
import type {
  AgentDefinition, AgentEvent, AgentSpawnOpts, AgentTask,
} from './types.js';

// ── AsyncEventQueue: push-to-iterator bridge ──

class AsyncEventQueue<T> {
  private events: T[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  push(ev: T): void {
    if (this.closed) return;
    this.events.push(ev);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<T, void, unknown> {
    while (true) {
      while (this.events.length > 0) yield this.events.shift()!;
      if (this.closed) return;
      await new Promise<void>(resolve => { this.resolver = resolve; });
    }
  }

  private wake() {
    const r = this.resolver;
    this.resolver = null;
    r?.();
  }
}

// ── Model resolution (TUI-AGENT-MODEL-FALLBACK · 결함 #34) ──
//
// A definition's frontmatter `model:` is a REQUEST, not a guarantee. The
// runner must check it against the provider the child will actually run
// on BEFORE handing it to streamLLMWithTools — a codex parent used to
// request `haiku` verbatim and die (the provider chain re-routed the
// Claude-family id to Anthropic, 결함 #34, 2026-10-14).
//
// `model: undefined` in the result means "inherit the parent": the child
// then rides streamLLMWithTools's own provider decision
// (`opts.provider ?? resolveDefaultProvider(opts.model)`), exactly like a
// spawn with no model hint at all.

/** Why resolveAgentModel returned the model it did. Six distinct exits —
 *  never collapse them into one value: "fell back to parent" and "sent an
 *  unrecognized id verbatim" must stay separable in the logs. */
export type AgentModelResolutionReason =
  | 'no-definition-model'
  | 'declared-inherit'
  | 'definition'
  | 'incompatible-provider'
  | 'unknown-model'
  | 'provider-unknown';

export interface AgentModelResolution {
  /** Canonical model id; undefined = inherit the parent's model. */
  model: string | undefined;
  reason: AgentModelResolutionReason;
}

/** Injection seams so tests can pin the provider / inference without
 *  touching user config. Defaults are the production functions. */
export interface ResolveAgentModelDeps {
  currentProviderName: () => string;
  isCompatible: (providerName: string, model: string) => boolean;
  inferProvider: (model: string) => string | null;
}

/** Production `currentProviderName` — the provider a model-less spawn
 *  would run on right now (the parent-configured default). A lookup
 *  failure is NOT hidden behind a made-up name: it throws, and
 *  resolveAgentModel turns it into the separate `provider-unknown` exit
 *  (judging compatibility against a fake name like 'auto' would drop a
 *  usable definition model to inherit). */
function productionCurrentProviderName(): string {
  return resolveDefaultProvider().name;
}

const defaultResolveAgentModelDeps: ResolveAgentModelDeps = {
  currentProviderName: productionCurrentProviderName,
  isCompatible: isModelCompatible,
  inferProvider: inferProviderFromModel,
};

/** Resolve a definition model against the provider the child would run
 *  on RIGHT NOW. Decision order — each step guards the next:
 *    1. no model → { undefined, 'no-definition-model' }
 *    2. `inherit` (trimmed, case-insensitive; an inheritance MARKER, not
 *       a model name) → { undefined, 'declared-inherit' }
 *    3. resolveModelAlias → canonical id
 *    4. inferProvider(canonical) === null → { canonical, 'unknown-model' }
 *       — do NOT fall back: free-form names ride the provider as-is
 *       (isModelCompatible's "unknown prefix is the provider's problem"
 *       stance; dropping a local free-form name to inherit is a regression)
 *    5. isCompatible(currentProviderName, canonical)
 *       true  → { canonical, 'definition' }
 *       false → { undefined, 'incompatible-provider' } (parent fallback)
 *       currentProviderName throws → { undefined, 'provider-unknown' } —
 *       compatibility cannot be judged, so the definition model is NOT
 *       sent (sending it could re-route the provider by model name); the
 *       child inherits the parent model — the goal's «can't call it →
 *       parent model» intent, kept as its own reason so a lookup failure
 *       is never confused with a real incompatibility
 *
 *  Inference (4) runs BEFORE compatibility (5) because isModelCompatible
 *  returns true on null inference — checking compatibility first would
 *  mislabel every unknown model as compatible and the unknown-model exit
 *  would be unreachable. */
export function resolveAgentModel(
  defModel: string | undefined,
  deps: Partial<ResolveAgentModelDeps> = {},
): AgentModelResolution {
  const d: ResolveAgentModelDeps = { ...defaultResolveAgentModelDeps, ...deps };
  if (defModel === undefined || defModel.trim() === '') {
    return { model: undefined, reason: 'no-definition-model' };
  }
  const trimmed = defModel.trim();
  if (trimmed.toLowerCase() === 'inherit') {
    return { model: undefined, reason: 'declared-inherit' };
  }
  const canonical = resolveModelAlias(trimmed) ?? trimmed;
  if (d.inferProvider(canonical) === null) {
    return { model: canonical, reason: 'unknown-model' };
  }
  let providerName: string;
  try {
    providerName = d.currentProviderName();
  } catch {
    return { model: undefined, reason: 'provider-unknown' };
  }
  if (d.isCompatible(providerName, canonical)) {
    return { model: canonical, reason: 'definition' };
  }
  return { model: undefined, reason: 'incompatible-provider' };
}

/** Resolve + record exactly one `agent.model` observation. Every runtime
 *  resolution goes through here (runAgent ⊕ a direct buildAgentMessages call
 *  without a pre-resolved `model`) so «one observation per resolution» holds
 *  on both paths. incompatible-provider (parent fallback), unknown-model
 *  (verbatim pass-through of an unrecognizable id) and provider-unknown
 *  (provider lookup failed, inherited the parent unjudged) are the exits an
 *  operator must tell apart from a log line alone — they get warn level. */
function resolveAgentModelObserved(
  def: Pick<AgentDefinition, 'name' | 'model'>,
  pinnedProviderName?: string,
): AgentModelResolution {
  let providerError: string | undefined;
  let currentProviderName: string | undefined = pinnedProviderName;
  const resolution = resolveAgentModel(def.model, {
    currentProviderName: () => {
      if (currentProviderName !== undefined) return currentProviderName;
      try {
        currentProviderName = productionCurrentProviderName();
        return currentProviderName;
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });
  debug.log('agent.model', 'resolved', {
    agent: def.name,
    declared: def.model,
    model: resolution.model,
    reason: resolution.reason,
    provider: currentProviderName ?? null,
    ...(providerError !== undefined ? { providerError } : {}),
  }, resolution.reason === 'incompatible-provider' || resolution.reason === 'unknown-model'
    || resolution.reason === 'provider-unknown'
    ? { level: 'warn' as const }
    : undefined);
  return resolution;
}

// ── Helpers ──

/** Assemble the initial message history. The parent's rendered system
 *  text (if any) is prepended with a blank line so adjacent agents
 *  sharing a parent share the same cache prefix — keeping cache hits
 *  high when fanning out N personas in parallel.
 *
 *  PFC-S1 P5: when `def.omitInheritedContext === true`, replace the parent-
 *  supplied `systemPromptPrefix` with a compact `<system-reminder>` notice. The
 *  agent's own `def.systemPrompt` is always preserved — we are only
 *  stripping inherited context, not the agent's own instructions.
 *  Pass `ctx.cwd` so the notice can name the sub-agent's working
 *  directory (set by isolation='worktree' in skill-tool-agent). */
export function buildAgentMessages(
  def: AgentDefinition,
  prompt: string,
  systemPromptPrefix?: string,
  ctx: { cwd?: string; enabledTools?: readonly string[]; model?: string } = {},
): LLMMessage[] {
  let effectivePrefix: string | undefined = systemPromptPrefix;
  if (def.omitInheritedContext) {
    const noticeLines: string[] = [
      '<system-reminder>',
      `You are running as a sub-agent (${def.name}).`,
    ];
    if (ctx.cwd) noticeLines.push(`Your working directory is ${ctx.cwd}.`);
    noticeLines.push(
      `Parent-provided context and the project preamble are omitted per agent definition; your own instructions remain available.`,
      '</system-reminder>',
    );
    effectivePrefix = noticeLines.join('\n');
  }
  const system = effectivePrefix
    ? `${effectivePrefix}\n\n${def.systemPrompt}`
    : def.systemPrompt;

  // P3 (2026-05-03) — Universal preamble plumbing for the sub-agent
  // surface. Without this, codex sub-agents executed with ZERO project
  // anchor (AGENTS.md/CLAUDE.md) and ZERO codex behavioral discipline
  // addendum. PR #768 wired the dashboard turn loop only; sub-agent
  // spawns (general-purpose, persona panels, data-collector, etc.) were
  // a blind spot — codex sub-agents were arriving with no context and
  // no anti-reread / parallelize / persist guidance.
  //
  // Skip when `def.omitInheritedContext === true` — that flag's whole purpose
  // is to deliver a SLIM context (sub-agent doesn't need the project
  // anchor). The codex addendum still matters even in slim mode (it's
  // about the model's own behavior, not the project), but to keep the
  // omitInheritedContext contract stable we honor it strictly.
  let universalPreamble: LLMMessage[] = [];
  if (!def.omitInheritedContext && ctx.cwd) {
    // TUI-AGENT-MODEL-FALLBACK: the preamble's modelFamily must track the
    // model the run will actually use. runAgent passes the already-resolved
    // model (one resolution + one `agent.model` observation per spawn);
    // direct callers that omit `model` resolve here so a definition model
    // the current provider can't run never reaches the preamble either.
    const effectiveModel = 'model' in ctx
      ? ctx.model
      : resolveAgentModelObserved(def).model;
    const agentModelFamily = effectiveModel ? getModelFamily(effectiveModel) : undefined;
    universalPreamble = buildUniversalPreamble({
      cwd: ctx.cwd,
      ...(agentModelFamily !== undefined ? { modelFamily: agentModelFamily } : {}),
      ...(ctx.enabledTools !== undefined ? { enabledTools: ctx.enabledTools } : {}),
    });
    if (debug.enabled) {
      debug.log('chat.agent-preamble', 'built', {
        agent: def.name,
        model: def.model,
        modelFamily: agentModelFamily,
        universalCount: universalPreamble.length,
        universalChars: universalPreamble.reduce((sum, m) => {
          const c = m.content;
          return sum + (typeof c === 'string' ? c.length : JSON.stringify(c).length);
        }, 0),
        cwd: ctx.cwd,
      });
    }
  }
  // ⛔⭐⭐⭐ 「어느 자식이 프로젝트 앵커를 «못 봤나»」는 ***무조건*** 관측한다.
  //   🚨 종전엔 `built`·`skipped` 가 «둘 다» `if (debug.enabled)` 뒤에 있었다.
  //      그건 핫패스 게이트라 ***운영에서 꺼진다*** ⇒ 이 축은 조회에 «영영 0건»이다.
  //      📏 실측 2026-08-26: 등록된 로그 스토어 ***109개 전수*** 에서 chat.agent-preamble 0행이었고,
  //         직접 태워 보니 `debug.enabled=false` 에서 경로는 «돌았는데» 이벤트가 0개였다.
  //         ⇒ 「사건이 없다」가 아니라 ***「게이트가 막았다」***다(CLAUDE.md 「0건」 축 ⑪).
  //   🪞 이것은 `#12766` 이 «바로 옆»(앵커 절단 관측)에서 이미 닫은 결함의 «쌍둥이»다.
  //      그때 배운 문장 그대로 — 셀프힐 판정의 근거가 되는 관측은 debug 게이트 밖에 둔다.
  //   ⭐ 비싼 것(메시지 문자 수 합산)은 위 `built` 에 «그대로 남긴다» — 여기선 «싼 필드»만 낸다.
  //   📌 이 값이 답하는 물음 = 상설 PLAN §6 ② 「omitInheritedContext 자식이 디자인을 못 본다 —
  //      결손인가 의도인가」. 코드는 «의도»라고 말하지만(위 주석), ***누가 얼마나 그러는지***는
  //      이 줄이 없으면 못 센다.
  debug.log('chat.agent-preamble', 'resolved', {
    agent: def.name,
    projectAnchorIncluded: universalPreamble.length > 0,
    reason: universalPreamble.length > 0
      ? 'included'
      : def.omitInheritedContext ? 'omit-inherited-context' : 'no-cwd',
    universalCount: universalPreamble.length,
    cwd: ctx.cwd,
  });

  return [
    ...universalPreamble,
    { role: 'system', content: system },
    { role: 'user',   content: prompt },
  ];
}

/** Resolve the tools a single agent may invoke this run.
 *
 *  Policy (per PLAN §11.2): undefined or empty allowlist = NO tools.
 *  Only explicit names are exposed. Unknown names in the allowlist
 *  are dropped silently — the agent simply doesn't see that tool. */
export function filterAgentTools(
  hostTools: LLMToolSpec[] | undefined,
  allowlist: string[] | undefined,
): LLMToolSpec[] | undefined {
  if (!allowlist || allowlist.length === 0) return undefined;
  if (!hostTools || hostTools.length === 0) return undefined;
  const allow = new Set(allowlist);
  const filtered = hostTools.filter(t => allow.has(t.name));
  return filtered.length > 0 ? filtered : undefined;
}

// ── SUBAGENT-ENCAPSULATION (0.2.36 · 대표 10-22 «서브에이전트 안의 행위는 안에서 해결 · 밖으로는 이상 상황에서만») ──
//
// 🚨 실물(n8n wS:p1 · 22:4x): 서브에이전트가 1~2분 만에 «…하지 못했습니다» 로 끝나 메인 대화에 끼어들었다.
// ⭐ 자식 답이 «못 했다»형이고 이상 사유(막힘·권한·사람 필요·예산)가 없으면 «안에서» 잇는다 — 상한 SUBAGENT_CONTINUE_INSIDE_CAP.
//   같은 답이 다시 나오면(같은 원인 반복) 그때 밖으로 낸다 = 이상 상황.
// 세 얼굴: 관측 = agent.encapsulation continue-inside / surfaced{reason} · 인지 = 미완형 ∧ 이상 사유 없음 ·
//   힐링 = 이어가기 지시 한 턴 · 상한·반복이면 그대로 반환(실패를 숨기지 않는다).

export const SUBAGENT_CONTINUE_INSIDE_CAP = 2;

export const SUBAGENT_CONTINUE_INSIDE_PROMPT = [
  '[continue inside]',
  '아직 맡은 일이 끝나지 않았다. 부모에게 «못 했다»를 돌려주지 말고 지금 이어서 끝까지 하라 — 막힌 도구는 다른 방법(다른 도구·인자·순서)으로 다시 시도하라.',
  '정말 더 갈 수 없을 때(권한 없음 · 사람이 정해야 함 · 같은 장애 반복)만 «BLOCKED: <사유> · <시도한 것>» 한 줄로 끝내라. 끝났으면 결과와 증거만 짧게.',
].join('\n');

const INCOMPLETE_EXIT = /(?:하지 못했|못했습니다|못 했습니다|완료하지 못|완료되지 않|끝내지 못|보고할 수 없|could not (?:complete|finish)|unable to (?:complete|finish)|not (?:yet )?(?:complete|completed|done|finished))/i;
const ABNORMAL_EXIT = /(?:BLOCKED:|needs-human|사람이 (?:정해|결정)|권한(?:이)? (?:없|부족)|permission denied|예산(?:을)? (?:소진|초과)|budget exhausted|quota)/i;

/** 자식 답을 가른다 — 'done'(밖으로) · 'abnormal'(이상 상황 · 밖으로) · 'incomplete'(안에서 잇는다). 순수. */
export function classifySubagentExit(text: string): 'done' | 'abnormal' | 'incomplete' {
  if (ABNORMAL_EXIT.test(text)) return 'abnormal';
  return INCOMPLETE_EXIT.test(text) ? 'incomplete' : 'done';
}

/** 걸음의 «답» 텍스트(마지막 도구 라운드 뒤)를 붙들어 두는 칸 — 걸음이 끝나 «밖으로 낼 답»으로 판정된 뒤에만
 *  부모에게 흘린다(r1 must-fix). 안에서 이어간 걸음의 답(«…하지 못했습니다»)은 부모 소비자에게 닿지 않는다.
 *  도구 호출 앞 진행 서술은 순서대로 바로 흘린다(이벤트 순서 계약 유지). */
export interface SubagentStepBuffer {
  /** 새 걸음을 시작한다 — 앞 걸음에 남은 텍스트는 버리고 그 글자 수를 돌려준다. */
  reset(): number;
}

async function runEncapsulated(task: AgentTask, runOnce: () => Promise<string>, step: SubagentStepBuffer): Promise<string> {
  step.reset();
  let text = await runOnce();
  const seen = new Set<string>([text.trim()]);
  for (let attempt = 1; attempt <= SUBAGENT_CONTINUE_INSIDE_CAP; attempt++) {
    const kind = classifySubagentExit(text);
    if (kind !== 'incomplete' || task.controller.signal.aborted) {
      // 첫 걸음에서 바로 끝나도 남긴다(should-fix) — 종료 건수를 이 이벤트 하나로 셀 수 있게.
      debug.log('agent.encapsulation', 'surfaced', { taskId: task.id, agent: task.definition.name, reason: kind, attempts: attempt - 1 }, attempt === 1 && kind === 'done' ? { level: 'debug' } : undefined);
      return text;
    }
    const droppedStreamChars = step.reset();
    debug.log('agent.encapsulation', 'continue-inside', { taskId: task.id, agent: task.definition.name, attempt, chars: text.length, droppedStreamChars });
    task.messages.push({ role: 'user', content: SUBAGENT_CONTINUE_INSIDE_PROMPT });
    text = await runOnce();
    const key = text.trim();
    if (seen.has(key)) {
      debug.log('agent.encapsulation', 'surfaced', { taskId: task.id, agent: task.definition.name, reason: 'same-reply', attempts: attempt }, { level: 'warn' });
      return text;
    }
    seen.add(key);
  }
  const final = classifySubagentExit(text);
  debug.log('agent.encapsulation', 'surfaced', { taskId: task.id, agent: task.definition.name, reason: final === 'incomplete' ? 'cap' : final, attempts: SUBAGENT_CONTINUE_INSIDE_CAP }, final === 'incomplete' ? { level: 'warn' } : undefined);
  return text;
}

// ── runAgent ──

/** Stream an agent's execution as a sequence of AgentEvent frames.
 *
 *  Exhausting the generator is equivalent to awaiting the run: the
 *  last event is always `done` | `error` | `status:aborted`, after
 *  which the generator returns. Consumers can break out early to
 *  stop listening, but the underlying LLM call keeps running until
 *  cancelled via `task.controller.abort()` (registry.abort(id)).  */
export async function* runAgent(
  task: AgentTask,
  opts: Omit<AgentSpawnOpts, 'definition' | 'prompt'> & {
    /** PFC-S1 P2: called once when task state flips to done / error /
     *  aborted (after finishedAt is stamped). Registry.spawn injects
     *  `(t) => this.notifyTaskDone(t)` so the task-notification queue
     *  can observe completion without runner importing registry
     *  (avoids a circular import). */
    onTerminal?: (task: AgentTask) => void;
  },
): AsyncGenerator<AgentEvent, void, unknown> {
  const queue = new AsyncEventQueue<AgentEvent>();

  task.state = 'running';
  task.startedAt = Date.now();
  queue.push({ type: 'status', stage: 'thinking' });

  // Resolve tools BEFORE buildAgentMessages so the universal preamble
  // can read the active toolset and emit session-specific guidance
  // (Wave 4, 2026-05-04 — `buildSessionGuidanceAddendum` reads
  // `enabledTools` to gate per-tool one-liner directives like
  // `Agent` → search-vs-spawn split, `TaskCreate` → don't batch).
  const tools = filterAgentTools(opts.tools, task.definition.tools);

  // TUI-AGENT-MODEL-FALLBACK (결함 #34): resolve the definition model
  // against the provider the child will ACTUALLY run on — the pinned
  // `opts.provider` when the dispatcher chose one, otherwise the
  // parent-configured default (what streamLLMWithTools picks for a
  // model-less spawn). `model: undefined` = inherit: the child then takes
  // the same provider/model decision path as the parent.
  const modelResolution = resolveAgentModelObserved(task.definition, opts.provider?.name);

  // Build history on the task so callers can inspect it after the run.
  // PFC-S1 P5: pass task.cwd so the slim-context notice (when
  // omitInheritedContext) can name the child's working directory.
  task.messages = buildAgentMessages(
    task.definition,
    task.prompt,
    opts.systemPromptPrefix,
    {
      model: modelResolution.model,
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(tools ? { enabledTools: tools.map(t => t.name) } : {}),
    },
  );
  const dispatchTool = opts.dispatchTool ?? (async (name: string) => {
    throw new Error(`agent '${task.definition.name}' has no dispatchTool but invoked '${name}'`);
  });

  // Kick off the LLM call. Callbacks push events to the queue; the
  // promise's resolution/rejection closes the queue.
  // SUBAGENT-ENCAPSULATION — 한 번의 tool loop 를 «한 걸음»으로 두고, 그 답이 «못 했다»형이면 안에서 잇는다(아래 runEncapsulated).
  // 걸음별 스트림 버퍼 — 판정 전 텍스트는 부모에게 흘리지 않는다(runEncapsulated 가 밖으로 낼 걸음만 flush).
  let stepDeltas: string[] = [];
  const stepBuffer: SubagentStepBuffer = {
    reset: () => { const dropped = stepDeltas.join('').length; stepDeltas = []; return dropped; },
  };
  const flushStep = (): void => {
    for (const delta of stepDeltas) queue.push({ type: 'text', delta });
    stepDeltas = [];
  };
  const runOnce = (): Promise<string> => streamLLMWithTools(
    task.messages,
    {
      // ⛔⭐⭐ 빈 델타는 «에이전트 이벤트»가 아니다 — LLM 층의 «표식»이다.
      //   📍 llm.ts `clearVisibleAssistantTextForToolRound` 가 툴 라운드마다 `onText('', '')` 를 낸다
      //      (= "화면에 뿌린 어시스턴트 텍스트를 지워라") ⊕ llm.ts:7535 도 «FINAL emit» 을
      //      `delta === ''` 로 가른다. ***그 층에서는 의미가 있다.***
      //   🚨 그런데 ***AgentEvent 의 `text` 에는 «지움» 의미가 없다*** — `{ type:'text', delta:'' }` 는
      //      소비자에게 «아무것도 말하지 않는다». 실측: agent text 소비자 «셋»이 전부
      //      무조건 이어붙이기만 한다(skills/tools/agent.ts · subagent-callable.ts · log-adapter.ts).
      //   ⇒ 그래서 이 자리에서 «떨군다». 안 그러면 툴 라운드마다 ***내용 없는 이벤트가 하나씩*** 흐르고,
      //     소비자는 그걸 「새 텍스트가 왔다」로 읽는다(UI 플러시·줄 버퍼·로그가 헛돈다).
      //   ⚠️ ⛔ 이것이 「지움」을 «전달»하지는 않는다 — 그 신호는 ***여기서 사라진다***.
      //     📌 그래서 라이브 소비자는 여전히 «툴 라운드 «전»» 텍스트를 화면에 들고 있고,
      //        최종 `done.text` 는 그것을 «뺀» 값이다(실측: 델타 누적 "checking done" ↔ done.text " done").
      //        ⇒ 그건 «별개 결손»이고 이 줄이 고치지 않는다. AgentEvent 에 지움 의미가 생겨야 닫힌다.
      onText: (delta) => { if (delta !== '') stepDeltas.push(delta); },
      onToolCall: (call) => {
        // 도구 호출 앞 텍스트는 걸음의 «답»이 아니라 진행 서술이다 — 순서를 지켜 바로 흘린다.
        //   붙들어 두는 것은 마지막 도구 라운드 뒤의 텍스트(= 이 걸음의 답)뿐이다.
        flushStep();
        task.toolCallCount = (task.toolCallCount ?? 0) + 1;
        queue.push({ type: 'status', stage: 'tool' });
        queue.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      },
      onToolResult: ({ id, name, result }) => {
        queue.push({ type: 'tool_result', id, name, result });
        queue.push({ type: 'status', stage: 'thinking' });
      },
      dispatchTool,
      // 이 걸음의 새 메시지(도구 호출·결과·답)를 이력에 이어 둔다 — 안에서 이어갈 때 앞 걸음을 잊지 않게.
      onTurnComplete: (newMessages) => { task.messages.push(...newMessages); },
    },
    {
      model: modelResolution.model,
      tools,
      signal: task.controller.signal,
      provider: opts.provider,
      maxTurns: opts.maxTurns,
    },
  );
  const runPromise = runEncapsulated(task, runOnce, stepBuffer);

  runPromise.then(
    (text) => {
      flushStep();
      task.result = text;
      task.state = 'done';
      task.finishedAt = Date.now();
      queue.push({ type: 'status', stage: 'done' });
      queue.push({ type: 'done', text });
      queue.close();
      // PFC-S1 P2: fire terminal-state callback after the task is
      // fully settled (state + result + finishedAt). Caught-isolated
      // by the registry; any throw here is swallowed upstream.
      try { opts.onTerminal?.(task); } catch { /* registry isolates */ }
    },
    (err) => {
      // 중단·오류 걸음의 부분 텍스트는 예전처럼 흘린다(취소 결과의 output 이 이 누적에 기댄다).
      flushStep();
      task.finishedAt = Date.now();
      if (task.controller.signal.aborted) {
        task.state = 'aborted';
        queue.push({ type: 'status', stage: 'aborted' });
      } else {
        const msg = err?.message || String(err);
        task.error = msg;
        task.state = 'error';
        queue.push({ type: 'status', stage: 'error' });
        queue.push({ type: 'error', message: msg });
      }
      queue.close();
      try { opts.onTerminal?.(task); } catch { /* registry isolates */ }
    },
  );

  yield* queue.drain();
}
