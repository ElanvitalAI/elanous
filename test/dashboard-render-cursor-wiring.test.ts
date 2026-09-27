import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { ansi, type RenderOptions } from '../src/tui.js';
import {
  createDashboardEssentialCursorObserver,
  renderDashboardFrame,
} from '../src/dashboard/index.js';
import { paintCursor } from '../src/display/cursor-state.js';

// ⛔ showDashboard() 를 테스트에서 부르지 않는다. 대시보드는 raw 입력을 잡고 이벤트 루프를
//    점유하므로, 프레임 뒤에 예외를 던져 빠져나오려 해도 그 예외가 전파되지 않는다.
//    실측(2026-08-01): 단독 실행이 100초 넘게 안 끝났고 `bun test --timeout` 으로도 안 끊겼다.
//    ⇒ 게이트가 "0 files ran" 을 내고 rework 가 그 자리에서 네 라운드를 태웠다.
//    그래서 배선 보증을 둘로 나눈다 — 헬퍼의 런타임 계약 ⊕ 호출부의 형태 가드.
describe('dashboard frame cursor wiring', () => {
  test('essential frame keeps overlay and force while resolving its cursor', () => {
    const seen: RenderOptions[] = [];
    const caret = { row: 7, col: 13, visible: true };
    renderDashboardFrame(['row'], {
      overlay: 'OVERLAY', force: true, cursorOwner: 'none', claimedCursor: null,
      promptCaret: caret, suppressPromptArea: false,
    }, (_lines, options) => { seen.push(options); });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cursor).toBe(paintCursor(caret));
    expect(seen[0]!.overlay).toBe('OVERLAY');
    expect(seen[0]!.force).toBe(true);
  });

  test('커서 소유자가 없으면 그 자리에 숨김 바이트가 간다', () => {
    const seen: RenderOptions[] = [];

    renderDashboardFrame(
      [],
      { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: null, suppressPromptArea: false },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(ansi.hideCursor);
  });

  // ⭐⭐⭐ essential 은 Z축에 묻지 않는다 — claim 이 없어도 프롬프트 caret 이 프레임에 실린다.
  test('essential 은 claim 이 없으면 프롬프트 caret 을 쓴다', () => {
    const seen: RenderOptions[] = [];
    const caret = { row: 26, col: 2, visible: true };

    renderDashboardFrame(
      ['row'],
      { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: { ...caret }, suppressPromptArea: false },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(paintCursor({ ...caret }));
    expect(seen[0]!.cursor).not.toBe(ansi.hideCursor);
  });

  test('essential 이라도 프롬프트가 감춰지면 숨김이 간다', () => {
    const seen: RenderOptions[] = [];

    renderDashboardFrame(
      ['row'],
      { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: { row: 26, col: 2, visible: true }, suppressPromptArea: true },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(ansi.hideCursor);
  });

  test('프롬프트 caret은 coordinator fallback보다 우선한다', () => {
    const seen: RenderOptions[] = [];
    const promptCaret = { row: 26, col: 2, visible: true };
    const inputCaret = { row: 26, col: 9, visible: true };

    renderDashboardFrame(
      ['row'],
      {
        overlay: '', force: false, cursorOwner: 'coordinator',
        claimedCursor: { ...inputCaret },
        promptCaret: { ...promptCaret },
        suppressPromptArea: false,
      },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(paintCursor({ ...inputCaret }));
    expect(seen[0]!.cursor).not.toBe(paintCursor({ ...promptCaret }));
  });

  test('essential 은 modal 이 실제로 claim 하면 그 값에 양보한다', () => {
    const seen: RenderOptions[] = [];
    const claim = { row: 4, col: 22, visible: true };

    renderDashboardFrame(
      ['row'],
      {
        overlay: '', force: false, cursorOwner: 'modal',
        claimedCursor: { ...claim },
        promptCaret: { row: 26, col: 2, visible: true },
        suppressPromptArea: false,
      },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(paintCursor({ ...claim }));
  });

  // ⛔ RFC essential-z-axis-off §3b ⓑ — `terminal` tier 는 **남긴다**(PTY 가 자기 caret 을 그린다).
  //    무인 리뷰 should-fix: 코드는 지원하는데 검사가 없어 조용히 깨질 수 있었다.
  test('essential 이라도 terminal tier claim 은 이긴다 (PTY caret 보존)', () => {
    const seen: RenderOptions[] = [];
    const ptyCaret = { row: 12, col: 40, visible: true };

    renderDashboardFrame(
      ['row'],
      {
        overlay: '', force: false, cursorOwner: 'terminal',
        claimedCursor: { ...ptyCaret },
        promptCaret: { row: 26, col: 2, visible: true },
        suppressPromptArea: false,
      },
      (_lines, options) => { seen.push(options); },
    );

    expect(seen[0]!.cursor).toBe(paintCursor({ ...ptyCaret }));
  });

  test('essential 최종 결정은 프레임 적용 뒤 정확한 payload로 observer에 전달한다', () => {
    const observations: unknown[] = [];
    renderDashboardFrame(['row'], {
      overlay: '', force: false, cursorOwner: 'terminal',
      claimedCursor: null,
      promptCaret: { row: 26, col: 2, visible: true },
      suppressPromptArea: false,
      onEssentialFrameCursorDecision: observation => { observations.push(observation); },
    }, () => {});

    expect(observations).toEqual([{
      source: 'prompt',
      reason: 'prompt-caret',
      caret: { row: 26, col: 2, visible: true },
      cursorOwner: 'terminal',
      suppressPromptArea: false,
    }]);
  });

  test('essential observer gates, deduplicates changed decisions, and resets per dashboard instance', () => {
    const logs: unknown[] = [];
    let enabled = false;
    const observer = createDashboardEssentialCursorObserver({
      isDebugEnabled: () => enabled,
      log: (_category, _event, data) => { logs.push(data); },
    });
    const prompt = {
      source: 'prompt' as const,
      reason: 'prompt-caret' as const,
      caret: { row: 26, col: 2, visible: true },
      cursorOwner: 'none' as const,
      suppressPromptArea: false,
    };
    observer(prompt);
    expect(logs).toHaveLength(0);
    enabled = true;
    observer(prompt);
    observer(prompt);
    observer({ ...prompt, suppressPromptArea: true, source: 'suppressed', reason: 'prompt-area-suppressed', caret: null });
    expect(logs).toEqual([
      prompt,
      { ...prompt, suppressPromptArea: true, source: 'suppressed', reason: 'prompt-area-suppressed', caret: null },
    ]);

    const nextInstance = createDashboardEssentialCursorObserver({
      isDebugEnabled: () => true,
      log: (_category, _event, data) => { logs.push(data); },
    });
    nextInstance(prompt);
    expect(logs).toHaveLength(3);
  });

  // 배선 회귀 가드 — 헬퍼를 지나지 않고 render 로 직접 그리면 커서 슬롯이 사라진다.
  // 런타임 가드가 아니라 형태 가드다(위 주석의 이유). 되돌리기를 실패시키는 것이 목적이다.
  test('dashboard index keeps chatOnlyMode and has no UI mode axis', () => {
    const src = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('let chatOnlyMode = true;');
    expect(src).toContain('setChatOnlyLayout(next, opts)');
    // D1a — /ui 모드 축 자체가 없다(uiModeSlash 슬롯도 없다).
    expect(src).not.toContain('uiModeSlash');
    expect(src).not.toMatch(/\bdashboardUiMode\b|\bisDashboardHeavyFeatureEnabled\b|\bcreateRichScratchViewers\b/);
    expect(src).toContain('rich: false,');
    expect(src).toContain("slot: 'bottom'");
  });

  test('showDashboard 의 프레임 flush 가 헬퍼를 지난다', () => {
    const src = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    const showDashboardAt = src.indexOf('export async function showDashboard(');
    // ⛔ 함수 **정의**만으로 참이 되면 가드가 아니다 — 등장 횟수로 정의와 호출을 가른다.
    //    (파일 끝까지 훑는 것으로는 "이후 어딘가의 우연한 호출"에 속는다 — 무인 리뷰 should-fix.)
    const occurrences = src.split('renderDashboardFrame(').length - 1;
    const callAt = src.indexOf('renderDashboardFrame(', showDashboardAt);
    // ⚠️ 소스를 단언 대상으로 넘기지 않는다 — 실패 메시지가 파일 전체(수만 자)를 토한다.
    const bareRenderCall = /\brender\(\s*baseLines\s*,/.exec(src.slice(showDashboardAt))?.[0] ?? null;

    expect(showDashboardAt).toBeGreaterThan(-1);
    expect(occurrences).toBe(2);              // 정의 1 · 호출 1
    expect(callAt).toBeGreaterThan(showDashboardAt);
    expect(bareRenderCall).toBeNull();
  });
});

describe('essential 결정이 커서를 안 낼 때 조율자 커서로 폴백 (D1a 리뷰 must-fix · 종전 동작 보존)', () => {
  test('claim·prompt caret 이 없고 조율자 커서가 있으면 그것을 그린다 · 없으면 숨긴다', () => {
    const seen: RenderOptions[] = [];
    const coord = { row: 3, col: 4, visible: true };
    renderDashboardFrame([], { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, coordinatorCursor: coord, promptCaret: null, suppressPromptArea: false },
      (_lines, options) => { seen.push(options); });
    renderDashboardFrame([], { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, coordinatorCursor: null, promptCaret: null, suppressPromptArea: false },
      (_lines, options) => { seen.push(options); });
    expect(seen[0]!.cursor).toBe(paintCursor(coord));
    expect(seen[1]!.cursor).toBe(ansi.hideCursor);
  });
});
