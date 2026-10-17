/**
 * 렌더 카테고리 SSOT 판정 — OH9(2026-07-24).
 *
 * 발화 게이트(debug/log.ts)와 조회 넛지(cli/logs-cli.ts)가 공유하는 단일
 * 진실원. PLAN §4.2 목록의 카테고리는 true, 제외(input.submit·acp.stream·
 * llm.dispatch·error.*)는 false 여야 한다.
 */
import { describe, expect, it } from 'bun:test';
import {
  assertRenderCategoryExemptions,
  isRenderCategory,
  RENDER_CATEGORY_EXEMPTIONS,
} from './render-categories.js';

describe('render-categories — isRenderCategory 판정', () => {
  it('PLAN §4.2 렌더 카테고리는 전부 true', () => {
    const render = [
      'dashboard', 'dashboard.draw', 'dashboard.frame-compose', 'dashboard.chat.stream',
      'dashboard.host-chrome.visibility', 'dashboard.dock.chrome',
      'cursor.coordinator.apply', 'cursor.blink',
      'key.route', 'key.trace.dispatch',
      'mouse.wheel', 'input-core.emit',
      'vw.paint', 'pane.mount', 'modal.open',
      'iul.render', 'hud.mirror',
      'layout.persistence.save', 'surface.registry.add',
      'voice.auto-tts', 'voice.toggle.on', 'voice.chat.frame',
      'acp.broadcast', 'llm.tool-exposure',
      'ux.render', 'ux.render.telegram', 'ux.event',
      'draw', 'render',
      'log.buffer.trim', 'log.wheel',
      // 동적 chat.*Picker 접미 + chat 렌더 하위
      'chat.updateSlashPicker', 'chat.updateModelPicker',
      'chat.picker.open', 'chat.input.blur', 'chat.modal.mask', 'chat.global.chord', 'chat.chord',
    ];
    for (const c of render) expect(isRenderCategory(c)).toBe(true);
  });

  it('제외 카테고리는 false — 턴/콘텐츠/에러 신호 보존', () => {
    const notRender = [
      'input.submit',        // 턴 시작 신호(렌더 아님·PLAN 명시 제외)
      'acp.stream',          // PLAN 목록 미명시 → 보수적 제외(콘텐츠 델타)
      'capability.resolve', 'session.link', 'self-implement', 'llm.tool-loop',
      'llm.dispatch', 'llm.router', 'llm.reasoning', 'llm.stream',
      'goal.loop', 'chat.tool-call', 'chat.tool-result', 'chat.system-prompt.resolve',
      'error.fatal', 'error',
      'debug.control',
      '',
    ];
    for (const c of notRender) expect(isRenderCategory(c)).toBe(false);
  });

  it('input-core 는 렌더지만 input.* (input.submit) 은 아니다 — 접두 경계', () => {
    expect(isRenderCategory('input-core.foo')).toBe(true);
    expect(isRenderCategory('input-core')).toBe(true);
    expect(isRenderCategory('input.submit')).toBe(false);
    expect(isRenderCategory('input.paste')).toBe(false);
  });

  it('acp.broadcast 는 렌더 · acp.stream 은 아니다', () => {
    expect(isRenderCategory('acp.broadcast')).toBe(true);
    expect(isRenderCategory('acp.stream')).toBe(false);
  });

  it('focus-transition 판정은 dashboard 접두 억제를 이긴다', () => {
    // ⚠️ 문구가 아니라 "이유가 있다"를 잰다 — 특정 문장에 묶으면 문구를 다듬을 때 깨진다(리뷰 should-fix).
    expect((RENDER_CATEGORY_EXEMPTIONS.get('dashboard.setWorkingFocus') ?? '').trim().length).toBeGreaterThan(0);
    expect(isRenderCategory('dashboard.setWorkingFocus.sync')).toBe(false);
    expect(isRenderCategory('dashboard.draw')).toBe(true);
  });

  it('이유 없는 render-suppression exemption은 거부한다', () => {
    expect(() => assertRenderCategoryExemptions(new Map([
      ['dashboard.unexplainedDecision', ''],
    ]))).toThrow('Render category exemption requires a reason: dashboard.unexplainedDecision');
  });
});


// ⛔⭐ `OBS-T128` 회귀 — 턴 제어 판정 프로브는 렌더 음소거를 «살아남아야» 한다.
//   이 계약이 깨지면 「스트리밍 중 큐」 축의 모든 판정이 다시 원리상 0 이 된다(세 창이 그것으로 틀렸다).
describe('render-categories — 턴 제어 판정 프로브는 음소거되지 않는다 (OBS-T128)', () => {
  it('dashboard.turn-typeahead · dashboard.streaming-key 는 렌더 카테고리가 «아니다»', () => {
    expect(isRenderCategory('dashboard.turn-typeahead')).toBe(false);
    expect(isRenderCategory('dashboard.streaming-key')).toBe(false);
  });

  it('그 하위 이벤트 네임스페이스도 함께 살아남는다', () => {
    expect(isRenderCategory('dashboard.turn-typeahead.echo')).toBe(false);
    expect(isRenderCategory('dashboard.streaming-key.arrived')).toBe(false);
  });

  it('⛔ 그러나 dashboard 접두 «전체»가 풀린 것은 아니다 — 진짜 렌더 소음은 여전히 잡힌다', () => {
    expect(isRenderCategory('dashboard.draw')).toBe(true);
    expect(isRenderCategory('dashboard.frame-compose')).toBe(true);
    expect(isRenderCategory('dashboard')).toBe(true);
  });

  it('예외마다 «이유»가 붙어 있다 — 감사 가능성이 이 목록의 존재 조건이다', () => {
    for (const key of ['dashboard.turn-typeahead', 'dashboard.streaming-key']) {
      expect((RENDER_CATEGORY_EXEMPTIONS.get(key) ?? '').trim().length).toBeGreaterThan(20);
    }
  });
});

// ⛔ `TUI-H8-SEAT-BOOT-LOG-MUTED` 회귀 — 자리 부트 카드 항상성 이벤트는 렌더 음소거를 «살아남아야» 한다.
//   깨지면 `/session new` 뒤 card-injected·conversation-start 가 `logs --all --include-test` 로도 0행이 된다.
describe('render-categories — 자리 부트 항상성 이벤트는 음소거되지 않는다 (TUI-H8)', () => {
  it('dashboard.seat-boot 는 렌더 카테고리가 «아니다»', () => {
    expect(isRenderCategory('dashboard.seat-boot')).toBe(false);
  });

  it('tui.autoturn · tui.wakeup · tui.autowake 도 렌더가 아니다(tui 는 렌더 접두가 아니다)', () => {
    for (const c of ['tui.autoturn', 'tui.wakeup', 'tui.autowake', 'tui.agent-wake', 'tui.input-lag']) {
      expect(isRenderCategory(c)).toBe(false);
    }
  });

  it('⛔ 다른 dashboard.* 렌더 범주는 그대로 음소거된다', () => {
    for (const c of ['dashboard', 'dashboard.draw', 'dashboard.frame-compose', 'dashboard.chat.stream', 'dashboard.seat-bootstrap']) {
      expect(isRenderCategory(c)).toBe(true);
    }
  });

  it('예외에 «이유»가 붙어 있다', () => {
    expect((RENDER_CATEGORY_EXEMPTIONS.get('dashboard.seat-boot') ?? '').trim().length).toBeGreaterThan(20);
  });
});
