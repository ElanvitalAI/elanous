import type { LLMToolSpec } from '../../llm/tool-spec.js';
// RelayShellPrompt — 셸 안 프롬프트를 operator 에게 릴레이하는 LLM 툴 (§6(a) · 2026-07-20)
//
// DESIGN-cross-surface-autonomy-membrane §6. PtyShell 안(codex/aider/claude)에서 승인/선택
// 프롬프트가 떠서 **"이건 operator 가 결정할 일"**이라고 에이전트가 판단하면 이 툴을 호출한다.
// 툴은 프롬프트를 막(SurfaceUx)으로 표면화(텔레그램 버튼·PWA/iOS 시트) → operator 답 수집 →
// 그 답을 다시 셸 stdin 으로 재주입한다(라운드트립).
//
//   경계: 이미 답을 아는 입력은 이 툴이 아니라 `PtyShellSend` — RelayShellPrompt 는 **operator
//   판단이 필요할 때만**. autoDrive='off' 하드코딩 = LLM 호출 = operator 로 escalate(자기승인 불가).
//   auto 게이트/패턴 자동감지(§6(b))는 relayShellPrompt primitive 위 후속 증분.
//
// ★ 제1원칙: 결정·주입 관측은 relayShellPrompt(harness.relay)가 이미 남긴다. 이 어댑터는
//   ctx→SurfaceUx 변환(surfaceUxFromDispatchCtx)만 — 채널 없으면 confirm fail-closed(안전 decline).


import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import { surfaceUxFromDispatchCtx } from '../../agent/surface-ux/build.js';
import { relayShellPrompt, type ShellInjector } from '../../harness/shell-relay.js';
import { detectShellPrompt } from '../../harness/shell-prompt-detect.js';

export function buildRelayShellPromptTool(): LLMToolSpec {
  return {
    name: 'RelayShellPrompt',
    description:
      'Relay a prompt from inside a PTY shell (e.g. codex "Apply patch? (y/n)", aider menu) to the ' +
      'human operator, then inject their answer back into the shell. Use this ONLY when the shell asks ' +
      'something that needs the operator\'s decision — for answers you already know, use PtyShellSend. ' +
      'Provide `options` for a multiple-choice menu (surfaces as buttons); omit it for a yes/no confirm. ' +
      'Returns whether an answer was injected and the resulting shell output.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The PtyShell id whose prompt you are relaying.' },
        prompt: { type: 'string', description: 'The question to show the operator (the shell\'s prompt text, cleaned up).' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Menu choices to inject verbatim on selection (e.g. ["Overwrite","Skip"]). Omit for a yes/no confirm.',
        },
      },
      required: ['process_id', 'prompt'],
      additionalProperties: false,
    },
  };
}

export async function dispatchRelayShellPrompt(
  rawArgs: Record<string, unknown>,
  ctx?: DaemonToolDispatchCtx,
  // 재주입 seam override — 기본 defaultShellInjector(dispatchPtyShellSend). 테스트/비-daemon 주입용.
  opts?: { inject?: ShellInjector },
): Promise<{ output: string }> {
  const processId = typeof rawArgs.process_id === 'string' ? rawArgs.process_id : '';
  const prompt = typeof rawArgs.prompt === 'string' ? rawArgs.prompt : '';
  if (!processId) throw new Error('RelayShellPrompt: process_id required');
  if (!prompt) throw new Error('RelayShellPrompt: prompt required');
  const explicitOptions = Array.isArray(rawArgs.options)
    ? rawArgs.options.filter((o): o is string => typeof o === 'string')
    : undefined;

  // §6(b) 자동감지: LLM 이 options 를 안 넘겼으면 프롬프트 텍스트를 detectShellPrompt 로
  // 구조화(메뉴 옵션·optionStyle 추출) — LLM 이 메뉴를 손으로 쪼갤 필요 없이 raw 프롬프트만.
  const detected = (!explicitOptions || explicitOptions.length === 0) ? detectShellPrompt(prompt) : null;
  const options = (explicitOptions && explicitOptions.length > 0) ? explicitOptions : detected?.options;
  const optionStyle = detected?.optionStyle;

  // ctx 없으면(비-daemon 호출) 채널 0 → confirm fail-closed. surfaceUxFromDispatchCtx 는 빈 소스도 안전.
  const ux = surfaceUxFromDispatchCtx(ctx ?? {});

  const outcome = await relayShellPrompt({
    shellId: processId,
    prompt,
    ...(options && options.length > 0 ? { options } : {}),
    ...(optionStyle ? { optionStyle } : {}),
    ux,
    // LLM 이 relay 를 호출 = "operator 가 결정할 일" 판단 → 항상 escalate(자기승인 불가·§6(a)).
    autoDrive: 'off',
    ...(opts?.inject ? { inject: opts.inject } : {}),
  });

  const answer = outcome.answer === null ? '(none)' : outcome.answer;
  const head = outcome.injected
    ? `RelayShellPrompt injected answer=${JSON.stringify(answer)} into ${processId}`
    : `RelayShellPrompt did NOT inject (reason=${outcome.reason ?? 'no-answer'})`;
  const tail = outcome.shellOutput ? `\n${outcome.shellOutput}` : '';
  return { output: `${head} · mode=${outcome.mode} · interactive=${ux.interactive}${tail}` };
}
