// TURN-GIVES-UP-NO-WORK (CEO field report 11-28 21:5x) — «현재 폴더에서 memory … 계약문서로 markdown 으로 저장해주세요» in a fresh folder:
// the first turn answered with 0 tools («확인하지 못해 작성하지 못했습니다»), its delegation row was ✗, and auto-continue
// fired in one folder (A — the reply happened to end on a pledge phrase) but not the other (B). Four literal scenes:
//   ROUTE-REENTER   — the provisional research pass ends when the structured route says local-only; the turn re-enters as the
//                     ordinary turn (Glob/Write in the pool) and saves the file. Real runCoreTurn · fake model · fake research.
//   DELEGATION-INLINE — a delegation that throws comes back as one structured failed result (fallback inline); the same turn writes.
//   CONTINUE-ROWS   — no plan, no pledge wording, a failed Agent row and no state change → one continuation (rows only).
//   FANOUT-NOT-VERIFY — a fan-out sibling whose prompt says «확인» is not a verify chain; a spawn named as a check still is.
import { runCoreTurn } from '../../../core-turn/run-core-turn.js';
import type { LLMProvider } from '../../../llm.js';
import type { LLMToolSpec } from '../../../llm/tool-spec.js';
import { createGoalContinue } from '../../../tui/input/goal-continue.js';
import { AgentSpawnGuard, guardedAgentSpawn } from '../../../skills/tools/agent-spawn-guard.js';
import type { SimWorldScenario } from '../types.js';

/** The CEO's line, verbatim shape (11-28 21:43 run B). */
const CEO_PROMPT = '현재 폴더에서 memory 및 기억 장치에 관련된 내용을 찾아서  계약문서로 markdown 으로 저장해주세요\n\n'
  + '  언제 어떠한 것들을 메모리로 기억하는지, 어떤 방식으로 기록하는지? 파일 메모리? 파일로 저장하는 체크 포인트 순간은?\n\n'
  + '  저장 형식은?\n\n  그리고 recall 은 어떻게 하는지? 메모리 저장 위계는 어떻게 하는지 상세하게 분석해주세요.';
/** Run B's final reply tail (logged by tui.goal-continue skipped · not-pledge). */
const B_TAIL = '구현 내용을 확인하기 전에는 이 항목들을 사실로 단정할 수 없습니다.';
const SAVED = 'Saved MEMORY-CONTRACT.md';

const spec = (name: string): LLMToolSpec => ({ name, description: `${name} (sim)`, parameters: { type: 'object', properties: {} } });
const toolNames = (opts: unknown): string[] => {
  const tools = (opts as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [];
  return tools.map(tool => String(tool.name));
};
const signalOf = (opts: unknown): AbortSignal | undefined => (opts as { signal?: AbortSignal } | undefined)?.signal;
/** The structured fields of the latest tool result the model sees (a tool_result block whose content is a JSON object). */
function lastToolResult(messages: ReadonlyArray<{ role: string; content?: unknown }>): Record<string, unknown> | null {
  for (const message of [...messages].reverse()) {
    const blocks = Array.isArray(message.content) ? message.content as Array<{ type?: unknown; content?: unknown }> : [];
    const block = [...blocks].reverse().find(item => item?.type === 'tool_result');
    if (!block) continue;
    if (typeof block.content !== 'string') return null;
    try { const parsed = JSON.parse(block.content) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null; } catch { return null; }
  }
  return null;
}

const routeReenter: SimWorldScenario = {
  id: 'TURN-GIVEUP-ROUTE-REENTER',
  title: 'a local-only research route ends the provisional pass and the ordinary turn saves the file',
  async run(ctx) {
    const pools: string[][] = [];
    const dispatched: string[] = [];
    let call = 0;
    const provider: LLMProvider = {
      name: 'turn-giveup-fake', defaultModel: 'turn-giveup-fake', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, opts) {
        const pool = toolNames(opts);
        pools.push(pool);
        call += 1;
        if (!pool.includes('Glob')) {
          // The provisional research pass: a real model needs seconds; this one waits for its cancellation (or 3s).
          const signal = signalOf(opts);
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 3_000);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          if (signal?.aborted) return;
          yield { type: 'tool_call' as const, id: `rp-${call}`, name: 'Agent', args: { name: 'memory survey', reason: 'long', prompt: 'survey memory' } };
          return;
        }
        if (!dispatched.includes('Write')) {
          yield { type: 'tool_call' as const, id: `w-${call}`, name: 'Write', args: { file_path: 'MEMORY-CONTRACT.md', content: '# Memory contract' } };
          return;
        }
        yield { type: 'text' as const, delta: SAVED };
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await runCoreTurn({
        sessionId: `turn-giveup-route-${ctx.seed}-${ctx.engine}`, messages: [{ role: 'user', content: CEO_PROMPT }], userText: CEO_PROMPT,
        tools: ['WebSearch', 'Read', 'Glob', 'Grep', 'Write', 'Agent', 'update_plan'].map(spec), initialProvider: provider, signal: controller.signal,
        dispatchTool: async (name) => { dispatched.push(name); return name === 'Write' ? { ok: true, path: 'MEMORY-CONTRACT.md' } : { ok: true }; },
        stableToolSet: true,
      }, {
        stallSeat: null,
        runResearch: async (_request, _signal, _admit, _routing, hooks) => {
          await Promise.resolve();
          hooks?.onRoute?.({ needsFreshFacts: false, needsCitations: false, localOnly: true, reason: 'files in this folder' });
          return { ok: false, output: '', sourceUrls: [] };
        },
      });
      const ordinaryPool = pools.find(pool => pool.includes('Glob')) ?? [];
      const observed = {
        finalText: result.finalText,
        dispatched: dispatched.join(','),
        ordinaryPoolHasWrite: ordinaryPool.includes('Write'),
        agentDispatched: dispatched.includes('Agent'),
      };
      ctx.recorder.event('turn-giveup-route-reenter', observed);
      const ok = observed.finalText.startsWith('Saved MEMORY-CONTRACT.md') && observed.dispatched === 'Write'
        && observed.ordinaryPoolHasWrite && !observed.agentDispatched;
      return ok ? { ok: true } : { ok: false, diff: JSON.stringify(observed) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  },
};

const delegationInline: SimWorldScenario = {
  id: 'TURN-GIVEUP-DELEGATION-INLINE',
  title: 'a delegation that does not start returns status failed · fallback inline, and the same turn writes the file',
  async run(ctx) {
    const dispatched: string[] = [];
    const seen: Array<Record<string, unknown> | null> = [];
    let call = 0;
    const provider: LLMProvider = {
      name: 'turn-giveup-inline-fake', defaultModel: 'turn-giveup-inline-fake', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) {
        call += 1;
        if (call === 1) {
          yield { type: 'tool_call' as const, id: 'a-1', name: 'Agent', args: { name: 'memory survey', reason: 'long', prompt: 'survey memory' } };
          return;
        }
        const last = lastToolResult(messages);
        seen.push(last);
        if (call === 2 && last?.status === 'failed' && last?.fallback === 'inline') {
          yield { type: 'tool_call' as const, id: 'w-2', name: 'Write', args: { file_path: 'MEMORY-CONTRACT.md', content: '# Memory contract' } };
          return;
        }
        yield { type: 'text' as const, delta: call === 2 ? 'Could not delegate.' : SAVED };
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await runCoreTurn({
        sessionId: `turn-giveup-inline-${ctx.seed}-${ctx.engine}`, messages: [{ role: 'user', content: 'Save the memory contract as MEMORY-CONTRACT.md.' }],
        tools: ['Glob', 'Write', 'Agent'].map(spec), initialProvider: provider, signal: controller.signal, stableToolSet: true,
        dispatchTool: async (name) => {
          dispatched.push(name);
          if (name === 'Agent') throw new Error('NOT SPAWNED — 3 agents are already running for this seat (limit 3)');
          return { ok: true, path: 'MEMORY-CONTRACT.md' };
        },
      }, { stallSeat: null });
      const failed = seen[0];
      const observed = {
        finalText: result.finalText,
        dispatched: dispatched.join(','),
        status: failed?.status ?? null, delegation: failed?.delegation ?? null, fallback: failed?.fallback ?? null, reason: failed?.reason ?? null,
      };
      ctx.recorder.event('turn-giveup-delegation-inline', observed);
      const ok = observed.finalText.startsWith('Saved MEMORY-CONTRACT.md') && observed.dispatched === 'Agent,Write'
        && observed.status === 'failed' && observed.delegation === 'failed' && observed.fallback === 'inline' && observed.reason === 'spawn-threw';
      return ok ? { ok: true } : { ok: false, diff: JSON.stringify(observed) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  },
};

const continueRows: SimWorldScenario = {
  id: 'TURN-GIVEUP-CONTINUE-ROWS',
  title: 'a failed delegation with no state change continues once — decided by rows, not by the reply wording',
  async run(ctx) {
    const opened: string[] = [];
    const make = () => createGoalContinue({
      startTurnIfIdle: (input) => { opened.push(input); return { opened: true, turnId: `auto-${opened.length}` }; },
      isEnabled: () => true, planNudge: true, defer: () => {}, log: () => {},
    });
    const failedAgent = { role: 'tool', toolName: 'Agent', toolResult: { error: 'Research tool budget reached. Answer with the evidence collected so far.' } };
    // ① run B: the reply ends on «… 단정할 수 없습니다.» (no pledge) — the rows decide.
    const b = make();
    b.noteTurnEnded({ lines: [B_TAIL], rows: [failedAgent] });
    const bOpened = b.check();
    const bPrompt = opened.at(-1) ?? '';
    // ② the same failed delegation, but the turn then wrote the file → nothing to continue.
    const done = make();
    done.noteTurnEnded({ lines: [B_TAIL], rows: [failedAgent, { role: 'tool', toolName: 'Write', toolArgs: { file_path: 'MEMORY-CONTRACT.md' }, toolResult: { ok: true } }] });
    const doneOpened = done.check();
    // ③ a plain answer with no tool rows → nothing to continue.
    const plain = make();
    plain.noteTurnEnded({ lines: ['2 더하기 2 는 4 입니다.'], rows: [] });
    const plainOpened = plain.check();
    const observed = {
      b: bOpened.opened, bReason: bOpened.reason, bPromptLiteral: bPrompt.startsWith('[delegation] The delegated agent in the last turn did not start, and nothing was saved or changed since. '),
      done: doneOpened.opened, doneReason: doneOpened.reason,
      plain: plainOpened.opened, plainReason: plainOpened.reason, openedCount: opened.length,
    };
    ctx.recorder.event('turn-giveup-continue-rows', observed);
    const ok = observed.b === true && observed.bReason === 'pledge-without-result'
      && observed.bPromptLiteral
      && observed.done === false && observed.doneReason === 'not-armed'
      && observed.plain === false && observed.plainReason === 'not-armed' && observed.openedCount === 1;
    return ok ? { ok: true } : { ok: false, diff: JSON.stringify(observed) };
  },
};

const fanoutNotVerify: SimWorldScenario = {
  id: 'TURN-GIVEUP-FANOUT-NOT-VERIFY',
  title: 'a fan-out sibling whose prompt says «확인» spawns; a spawn named as a check of the running agent is refused',
  async run(ctx) {
    const tasks = new Map<string, { state: string }>();
    const guard = new AgentSpawnGuard({ now: () => 1_000_000, taskState: id => tasks.get(id), isCoordinator: () => false });
    let n = 0;
    const spawn = async (args: Record<string, unknown>): Promise<string> => {
      try {
        await guardedAgentSpawn(args, async () => { const taskId = `s${++n}`; tasks.set(taskId, { state: 'running' }); return { taskId, background: true }; }, guard, 'local');
        return 'allowed';
      } catch (error) { return `refused ${(error as Error).message.slice(0, 26)}`; }
    };
    const first = await spawn({ name: '메모리 생성 저장 조사', reason: '저장 계약의 독립적인 코드 추적', prompt: '메모리 생성과 저장 경로를 코드에서 추적하고 저장 형식을 확인하라' });
    const sibling = await spawn({ name: '메모리 회상 검색 조사', reason: '회상 경로 독립 조사', prompt: '메모리 회상과 검색 경로를 코드에서 추적하고 주입 방식을 확인하라' });
    const check = await spawn({ name: '메모리 저장 검증', reason: '독립 검증', prompt: '메모리 생성과 저장 경로 추적 결과를 검증하라' });
    const observed = { first, sibling, check };
    ctx.recorder.event('turn-giveup-fanout-not-verify', observed);
    const ok = first === 'allowed' && sibling === 'allowed' && check === 'refused NOT SPAWNED — wait for 메모리';
    return ok ? { ok: true } : { ok: false, diff: JSON.stringify(observed) };
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [routeReenter, delegationInline, continueRows, fanoutNotVerify];
