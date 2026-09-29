// 셸 relay 라운드트립 — 셸 안 프롬프트를 막(SurfaceUx)으로 (P1 · 2026-07-20)
//
// DESIGN-cross-surface-autonomy-membrane §6. 셸 안(codex/aider/claude in PtyShell)이 물은
// 프롬프트("Apply patch? (y/n)")를 **해석 → autoDrive 게이트 → 외부 전파 → 의도 수집 → 셸 재주입**.
//
//   ① 셸 프롬프트 ─해석→ ② autoDrive 게이트(decideRelayMode)
//        ├ auto  → autoAnswer(LLM/정책 답) → 재주입 (operator 안 부름·관측)
//        └ escalate → ux.confirm|question(외부 전파+의도) → 재주입
//
// P1 = **LLM-구동 relay**(에이전트가 "이건 operator 결정" 판단해 호출). 패턴 자동감지(codex/aider
// 승인 정규식)는 후속(§6 (b)). 메뉴 방향키 시퀀스도 후속 — 여기선 답 + '\n' 종결.
//
// ★ 제1원칙(관측→인지→힐링):
//   - 관측: 모든 relay 결정·주입을 observe(debug.log 'harness.relay'). 없으면 "왜 auto 였나·왜
//     escalate 했나·뭘 셸에 넣었나" 자기인지·디버깅 불가.
//   - 자기인지: autoDrive 게이트는 **입력 재료 digest(prompt·options)까지 계측** — 결정 근거 소실 방지.
//   - 셀프힐: dead/unknown 셸 재주입은 **크래시 대신 fail-soft** 구조화 반환. 비대화형 escalate 는
//     **fail-closed**(위험 답 자동주입 금지) — y/N 은 안전 decline, N-way 메뉴는 HITL 로 보류.

import type { SurfaceUx } from '../agent/surface-ux/types.js';
import type { AutoDrive } from './staged-harness.js';
import { dispatchPtyShellSend } from '../skills/tools/pty.js';
import { debug } from '../debug/log.js';
import { getHarnessRunId } from './harness-space.js';
import { emitDecision } from '../live/detail-switch.js';
import { escalateDecision } from '../self-implement/decision-events.js';

/** relay 게이트 결정 — auto(자율 답·operator 안 부름) vs escalate(막으로 외부 전파). */
export type RelayMode = 'auto' | 'escalate';

/**
 * autoDrive 스펙트럼(§5)을 relay 게이트로. **순수 함수**(관측은 호출측 relayShellPrompt 가).
 * - 'on'   → 항상 auto (처음부터 자율·릴레이 0)
 * - 'off'  → 항상 escalate (풀 HITL)
 * - 'safe' → lowRisk 면 auto, 아니면 escalate (제1원칙 기본: 저위험 자율·고위험만 릴레이)
 */
export function decideRelayMode(autoDrive: AutoDrive, opts?: { lowRisk?: boolean }): RelayMode {
  if (autoDrive === 'on') return 'auto';
  if (autoDrive === 'off') return 'escalate';
  return opts?.lowRisk ? 'auto' : 'escalate';
}

/** 재주입 결과 — dead/unknown 셸도 throw 하지 않고 ok:false 로 (셀프힐 fail-soft). */
export interface ShellInjectResult {
  ok: boolean;
  /** 주입 후 셸 델타(관측·디버깅). */
  output?: string;
  /** ok:false 사유(dead-shell·unknown·write 실패). */
  error?: string;
}

/** 셸 재주입 seam — 기본은 dispatchPtyShellSend(registry.write). 테스트는 스텁 주입. */
export type ShellInjector = (input: { shellId: string; bytes: string }) => Promise<ShellInjectResult>;

/** dispatchPtyShellSend 위 fail-soft 래퍼 — 예외를 구조화 결과로 흡수(셀프힐). */
export const defaultShellInjector: ShellInjector = async ({ shellId, bytes }) => {
  try {
    const { output } = await dispatchPtyShellSend({ process_id: shellId, input: bytes });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export interface RelayShellPromptInput {
  /** 대상 PtyShell id(registry). */
  shellId: string;
  /** 셸이 물은 프롬프트(감지·구조화된 문구). ux 표면화 + 관측 digest. */
  prompt: string;
  /** 구조화 선택지(메뉴). 있으면 ux.question, 없으면 y/N ux.confirm. */
  options?: readonly string[];
  /** 막 — escalate 시 confirm/question 이 이 서피스로. */
  ux: SurfaceUx;
  /** autoDrive 정책(§5). */
  autoDrive: AutoDrive;
  /** 저위험 여부(safe 티어 auto↔escalate 분기). 기본 false(안전측). */
  lowRisk?: boolean;
  /** auto 모드 답 계산(LLM/정책-구동). 없으면 auto 여도 escalate 로 폴백(자율 답 근거 없음). */
  autoAnswer?: (input: { prompt: string; options?: readonly string[] }) => Promise<string> | string;
  /** 재주입 seam(기본 defaultShellInjector). */
  inject?: ShellInjector;
  /** confirm 승인 시 주입 바이트(기본 'y'). */
  yesBytes?: string;
  /** confirm 거절/fail-closed 시 주입 바이트(기본 'n'). */
  noBytes?: string;
  /** 답 종결자(기본 '\n'). */
  terminator?: string;
  /** 메뉴 주입 스타일 — 'text'(라벨 타이핑+종결자·기본) vs 'arrows'(fzf/curses 피커:
   *  선택지 index 만큼 ↓ 후 Enter). detectShellPrompt 가 힌트 제공. confirm 엔 무관. */
  optionStyle?: 'text' | 'arrows';
}

export interface RelayOutcome {
  /** 실제 게이트 경로(auto-fallback 포함 시 escalate). */
  mode: RelayMode;
  /** 셸에 주입한 답(종결자 제외·원자). null=주입 안 함(비대화형 메뉴·취소·dead-shell). */
  answer: string | null;
  /** 재주입 성공 여부. */
  injected: boolean;
  /** 주입 후 셸 델타(관측). */
  shellOutput?: string;
  /** answer=null / injected=false 사유(fail-closed·cancelled·no-auto-answer·inject-failed). */
  reason?: string;
}

/** ANSI 방향키 — 아래(↓)·Enter. curses/fzf 피커 네비게이션용. */
const KEY_DOWN = '\x1b[B';
const KEY_ENTER = '\r';

/**
 * 선택된 답을 셸 주입 바이트로. 순수.
 * - 메뉴 arrows: 커서를 top(index 0)으로 가정하고 선택 index 만큼 ↓ 후 Enter.
 * - 그 외(text·confirm): 답 + terminator.
 * arrows 인데 답이 옵션에 없으면 text 로 안전 폴백.
 */
export function selectionBytes(
  answer: string,
  opts: { options?: readonly string[]; optionStyle?: 'text' | 'arrows'; terminator: string },
): string {
  if (opts.optionStyle === 'arrows' && opts.options && opts.options.length > 0) {
    const idx = opts.options.indexOf(answer);
    if (idx >= 0) return KEY_DOWN.repeat(idx) + KEY_ENTER;
  }
  return `${answer}${opts.terminator}`;
}

/** 프롬프트/답을 관측용으로 축약(원문 로그 오염·PII 방지). */
function digest(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 셸 프롬프트 라운드트립. autoDrive 게이트 → (auto 답 | 막 escalate) → 셸 재주입. 전 경로 관측.
 *
 * 반환 = LLM/호출자가 소비할 구조화 결과(무엇을·왜 주입했나). throw 안 함(fail-soft).
 */
export async function relayShellPrompt(input: RelayShellPromptInput): Promise<RelayOutcome> {
  const {
    shellId, prompt, options, ux, autoDrive,
    lowRisk = false,
    inject = defaultShellInjector,
    yesBytes = 'y', noBytes = 'n', terminator = '\n', optionStyle = 'text',
  } = input;

  let mode = decideRelayMode(autoDrive, { lowRisk });
  // 자기인지: 결정 + 입력 재료 digest 를 함께 남긴다(왜 auto/escalate 인지 사후 복원 가능).
  debug.log('harness.relay', 'decide', {
    shellId, autoDrive, lowRisk, mode,
    prompt: digest(prompt), optionCount: options?.length ?? 0, interactive: ux.interactive, surface: ux.surface,
  });

  let answer: string | null = null;
  let reason: string | undefined;

  if (mode === 'auto') {
    if (input.autoAnswer) {
      answer = await input.autoAnswer({ prompt, ...(options ? { options } : {}) });
      debug.log('harness.relay', 'auto-answer', { shellId, answer: digest(answer) });
    } else {
      // auto 결정이나 답 근거(autoAnswer) 없음 → 자동 주입 금지. escalate 로 안전 폴백.
      mode = 'escalate';
      debug.log('harness.relay', 'auto-fallback', { shellId, reason: 'no-autoAnswer' });
    }
  }

  if (mode === 'escalate' && answer === null) {
    if (options && options.length > 0) {
      // N-way 메뉴 → ux.question. 비대화형이면 null(안전 추측 불가 → HITL 보류).
      const res = await ux.question({
        questions: [{
          id: 'shell_relay',
          header: '셸 응답',
          question: prompt,
          options: options.map((o) => ({ label: o, description: `셸에 "${o}" 전송` })),
        }],
      });
      const picked = res?.answers?.['shell_relay'];
      answer = typeof picked === 'string' ? picked : Array.isArray(picked) ? (picked[0] ?? null) : null;
      if (answer === null) reason = res == null ? 'non-interactive-menu-fail-closed' : 'cancelled';
      debug.log('harness.relay', 'escalate-question', { shellId, answer: answer ? digest(answer) : null, interactive: ux.interactive });
      try { emitDecision(escalateDecision({ runId: getHarnessRunId() || undefined, shellId, answer, interactive: ux.interactive, mode: 'question' })); } catch { /* observation must not change the relay outcome */ }
    } else {
      // y/N → ux.confirm. 채널 없으면 fail-closed false → 안전측 decline(noBytes) 주입.
      const ok = await ux.confirm({ prompt, detail: `셸 ${shellId}`, yesLabel: '예', noLabel: '아니오' });
      answer = ok ? yesBytes : noBytes;
      if (!ok && !ux.interactive) reason = 'non-interactive-fail-closed-decline';
      debug.log('harness.relay', 'escalate-confirm', { shellId, ok, answer: digest(answer), interactive: ux.interactive });
      try { emitDecision(escalateDecision({ runId: getHarnessRunId() || undefined, shellId, answer: reason === 'non-interactive-fail-closed-decline' ? null : answer, interactive: ux.interactive, mode: 'confirm', safeDecline: reason === 'non-interactive-fail-closed-decline' })); } catch { /* observation must not change the relay outcome */ }
    }
  }

  if (answer === null) {
    debug.log('harness.relay', 'no-inject', { shellId, reason: reason ?? 'no-answer' });
    return { mode, answer: null, injected: false, ...(reason ? { reason } : {}) };
  }

  // 재주입 — 메뉴 arrows 면 방향키 시퀀스, 그 외 라벨+종결자. dead/unknown 셸도 fail-soft(셀프힐).
  const bytes = selectionBytes(answer, { ...(options ? { options } : {}), optionStyle, terminator });
  const res = await inject({ shellId, bytes });
  debug.log('harness.relay', 'reinject', { shellId, bytes: bytes.length, style: optionStyle, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
  if (!res.ok) {
    return { mode, answer, injected: false, reason: `inject-failed: ${res.error ?? 'unknown'}` };
  }
  return { mode, answer, injected: true, ...(res.output ? { shellOutput: res.output } : {}), ...(reason ? { reason } : {}) };
}
