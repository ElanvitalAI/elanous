// ── 턴 UX 시뮬레이터 — 상호작용 ─────────────────────────────────────────────
//
// 렌더 축(`render-frame.ts`)이 「무엇이 보이나」를 답한다면, 이 파일은
// ***「키를 넣으면 무엇이 일어나나」***를 답한다. 둘 다 실제 코드를 부른다.
//
// 🚨 이것이 없어서 치른 값(2026-08-19 실측):
//   ESC 게이트를 라이브로 열려면 ***ESC 시점에 자식이 «실행 중»***이어야 했다.
//   그 순간을 잡으려고 폴링 스크립트를 짓고도 «두 번» 놓쳤고, 판당 3~5분이 들었다.
//   ⇒ 여기서는 자식 수를 «숫자로» 주면 끝난다.

import { createEscAbortGate, requiresLongShellEscConfirmation, type EscAbortGate } from '../esc-abort-gate.js';
import type { ModalSurface } from '../display/modal-stack.js';
import { AgentRegistry } from '../agent/registry.js';
import type { AgentDefinition } from '../agent/types.js';
import { InlineChoiceBroker } from '../tui/inline-choice.js';

export interface EscGateSim {
  gate: EscAbortGate;
  abortCtrl: AbortController;
  /** 마운트된 모달 표면들(마운트 순). 문면 검증용. */
  mounted: ModalSurface[];
  /** 모달이 지금 떠 있나. */
  isOpen(): boolean;
  /** 자식 핸드오프가 «몇 번» 불렸나 — 고아 방지 배선의 관측점. */
  handoffCalls: number;
  /** 키 하나를 게이트에 넣는다(모달이 떠 있을 때만 소비된다). */
  key(name: string): boolean;
  /** Submit an answer to the input-based confirmation, when enabled. */
  inlineInput(input: string): boolean;
  /** Select an inline confirmation option, when enabled. */
  inlineKey(key: string): boolean;
  /** Rendered inline prompt lines, when enabled. */
  inlineLines: string[];
  /** ESC 를 넣는다. */
  esc(): void;
  /** 취소 신호의 «뜻» — turn-only 인지 kill-children 인지. */
  abortReason(): unknown;
  /**
   * ⭐ 마이크로태스크를 한 번 흘린다.
   *
   * ⛔ 모달의 답은 `promise.then(...)` 으로 «비동기»로 풀린다 — 키를 넣은 «직후»에
   *   `signal.aborted` 를 읽으면 아직 false 다. 실제 코드가 그렇게 생겼으므로
   *   시뮬레이터도 그것을 숨기지 않는다. ⇒ 판정 전에 `await sim.settle()`.
   */
  settle(): Promise<void>;
}

/**
 * ★ ESC 게이트를 «자식 N개가 도는» 상태로 즉시 세운다.
 *
 * ⭐ 라이브에서는 이 상태를 만들려면 실제 서브에이전트가 떠 있어야 했다.
 *   여기서는 `runningChildren` 한 숫자면 된다.
 */
export function simEscGate(opts: {
  runningChildren?: number;
  agentRegistry?: AgentRegistry;
  inlineConfirmation?: boolean;
  shellTool?: 'Bash' | 'RunShell';
  shellElapsedMs?: number;
  inlineAbortScope?: 'turn-only' | 'kill-children';
  viewport?: { cols: number; rows: number };
} = {}): EscGateSim {
  const longShell = requiresLongShellEscConfirmation(opts.shellTool ?? '', opts.shellElapsedMs ?? 0);
  const abortCtrl = new AbortController();
  const mounted: ModalSurface[] = [];
  const inlineLines: string[] = [];
  const inlineChoices = new InlineChoiceBroker({
    appendLines: (lines) => inlineLines.push(...lines),
    renderPanel: (lines) => inlineLines.splice(0, inlineLines.length, ...lines),
  });
  const sim = {
    abortCtrl,
    mounted,
    handoffCalls: 0,
  } as EscGateSim & { gate: EscAbortGate };
  sim.gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: () => (opts.agentRegistry?.list('running').length ?? opts.runningChildren ?? 0) + (longShell ? 1 : 0),
    mountModal: (surface) => { mounted.push(surface); return () => { mounted.pop(); }; },
    getViewport: () => opts.viewport ?? { cols: 100, rows: 30 },
    requestRedraw: () => { /* 시뮬레이터는 그리지 않는다 */ },
    handoffSurvivingChildren: () => { sim.handoffCalls += 1; },
    shouldAbortImmediately: () => opts.shellTool !== undefined && !longShell,
    forceStopWithoutModal: () => opts.inlineConfirmation === true || longShell,
    ...(opts.inlineAbortScope ? { onInlineConfirmed: () => opts.inlineAbortScope } : {}),
    ...(opts.inlineConfirmation || longShell ? {
      confirmStopInline: async () => {
        const result = await inlineChoices.ask({
          id: 'sim-esc-confirm', question: longShell ? 'Stop the long-running shell command?' : 'Stop running child work?',
          options: [{ value: 'stop', label: 'Stop' }, { value: 'continue', label: 'Continue' }],
          yesNo: true, includeOther: false,
        });
        return !('cancelled' in result) && result.selected[0] === 'stop';
      },
    } : {}),
  });
  sim.isOpen = () => sim.gate.isGateOpen();
  sim.key = (name: string) => sim.gate.handleKey({ name } as never);
  sim.inlineInput = (input: string) => inlineChoices.handleInput(input);
  sim.inlineKey = (key: string) => inlineChoices.handleKey(key);
  sim.inlineLines = inlineLines;
  sim.esc = () => sim.gate.handleEscape();
  sim.abortReason = () => abortCtrl.signal.reason;
  sim.settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  return sim;
}

/**
 * ★ 에이전트 레지스트리를 「자식 N개가 도는」 상태로 즉시 세운다.
 *
 * ⛔ 실제 `AgentRegistry` 를 쓴다 — 흉내 내지 않는다. 그래야 `markBackground`
 *   같은 실제 규칙(멱등·종료 태스크 제외)이 시뮬레이션에도 그대로 적용된다.
 */
export function simAgentRegistry(opts: {
  foreground?: number;
  background?: number;
  done?: number;
} = {}): AgentRegistry {
  const reg = new AgentRegistry();
  const def = (name: string): AgentDefinition => ({ name, systemPrompt: 'sim' });
  const add = (kind: 'fg' | 'bg' | 'done', i: number) => {
    const task = reg.register(def(`sim-${kind}-${i}`), 'sim task');
    task.startedAt = Date.now();
    if (kind === 'done') { task.state = 'done'; task.finishedAt = Date.now(); }
    else { task.state = 'running'; if (kind === 'bg') task.background = true; }
    return task;
  };
  for (let i = 0; i < (opts.foreground ?? 0); i++) add('fg', i);
  for (let i = 0; i < (opts.background ?? 0); i++) add('bg', i);
  for (let i = 0; i < (opts.done ?? 0); i++) add('done', i);
  return reg;
}
