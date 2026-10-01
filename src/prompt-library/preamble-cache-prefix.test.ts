import { describe, expect, it } from 'bun:test';
import { buildUniversalPreamble, resetUniversalPreambleCache } from './universal-preamble.js';

/**
 * ⛔⭐⭐⭐ 상설 PLAN §6 ③ 의 «읽는 자» — *「매 자식에게 26KB 가 간다 — 이 계획이 경고한 비용을
 * ***끝내 안 쟀다***」*.
 *
 * 📏 2026-08-26 실측 (⛔ 수를 여기 박지 않는다 — 아래는 «왜 이 시험이 있나»의 근거다):
 *    ⓐ 계획이 적은 「26KB」는 ***앵커만***이었다. 자식이 실제로 받는 프리앰블은 그보다 «더 크다».
 *    ⓑ 프로젝트 앵커·트리까지는 «안정 접두»다 — 이후 도구 없는 모드 안내가
 *       lifecycle 앞에 오므로 전체 기본 프리앰블을 도구 있는 자식과 비교하면 접두가 아니다.
 *    ⇒ 🔑 그래서 비용은 「N × 전체」가 아니다. ***프롬프트 캐시가 그 접두를 먹는다.***
 *
 * 🚨 그리고 그 성질은 ***순서에만 기대어 서 있다.*** 누군가 모델 애드덤을 앵커 «앞»으로 옮기면
 *    모든 모델 패밀리가 서로의 캐시를 깨므로 접두 비교 시험이 빨개져야 한다.
 *    ⛔ 그게 이 파일이 있는 이유다. 이 시험은 «내용»이 아니라 ***「접두가 공유되나」***를 문다.
 *
 * ⚠️ 이 시험이 «못» 답하는 것: 프로바이더가 실제로 캐시를 먹였는지. 그건 청구서·응답 메타의 몫이고
 *    여기서는 ***「캐시가 먹을 수 있는 «모양»인가」***까지다.
 */
const CWD = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

function preambleText(opts: Record<string, unknown> = {}, throughTree = false): string {
  resetUniversalPreambleCache();
  const messages = buildUniversalPreamble({ cwd: CWD, ...opts } as never);
  const tree = messages.findIndex((m) => String(m.content).startsWith('## Project Layout'));
  if (tree < 0) throw new Error('project tree missing');
  return (throughTree ? messages.slice(0, tree + 1) : messages)
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['modelFamily=claude', { modelFamily: 'claude' }],
  ['modelFamily=codex', { modelFamily: 'codex' }],
  ['enabledTools 하나', { enabledTools: ['Read'] }],
  ['enabledTools 둘', { enabledTools: ['Read', 'Bash'] }],
  ['둘 다', { modelFamily: 'claude', enabledTools: ['Read', 'Bash'] }],
];

describe('sub-agent 프리앰블 — 자식마다 달라지는 것은 «뒤»에 붙는다(캐시 접두 보존)', () => {
  it.each(VARIANTS)('%s 를 줘도 공통 부분이 «접두»로 남는다', (_label, opts) => {
    const base = preambleText({}, true);
    const variant = preambleText(opts);
    // The entire project anchor and tree must precede every optional addendum.
    expect(variant.startsWith(base)).toBe(true);
    expect(preambleText(opts, true)).toBe(base);
  });

  // ⛔⭐ 위 시험이 «공짜로» 통과하는 길을 막는다 — base 가 비어 있으면 startsWith 는 항상 참이다.
  //   그건 「접두가 보존된다」가 아니라 ***「잴 것이 없다」***다.
  it('기준 프리앰블이 실제로 «있다» — 위 시험이 공짜로 통과하는 것을 막는다', () => {
    const base = preambleText({}, true);
    expect(base.length).toBeGreaterThan(0);
    // 앵커가 실제로 실렸는지까지 문다 — cwd 해석이 깨지면 base 가 «작지만 비지는 않게» 남는다.
    expect(base).toContain('AGENTS.md');
  });

  // ⛔⭐ 그리고 변형이 실제로 적용됐는지도 문다. 아무것도 안 붙으면 위 시험은
  //   「접두가 보존된다」가 아니라 ***「옵션이 무시된다」***를 통과시킨다(그건 다른 결함이다).
  it('변형은 «뒤에» 실제로 무언가를 더한다 — 옵션이 조용히 무시되는 것을 막는다', () => {
    const base = preambleText({}, true);
    for (const [, opts] of VARIANTS) {
      const variant = preambleText(opts);
      expect(variant.length).toBeGreaterThan(base.length);
      if (opts.modelFamily) {
        expect(variant).not.toBe(preambleText({ enabledTools: opts.enabledTools }));
      }
      if (opts.enabledTools) {
        expect(variant).toContain('# Session-specific guidance');
        expect(variant).not.toContain('## Chat without tools');
      }
    }
  });
});
