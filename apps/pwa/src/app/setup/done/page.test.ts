// PWA `/setup/done` Phase 2 — page export + link inventory contract.
//
// Page 렌더 순서와 SETUP_LINKS inventory / Phase 3 anchor sync 를 검증한다.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ⛔ 2026-08-14 — `SETUP_LINKS` 는 `./setup-links` 로 «옮겨졌다»(Next 가 Page 파일의
//   비표준 export 를 거부한다 — 그 파일 머리말이 이유를 적어 뒀다). 이 검사만 옛 자리를
//   가리키고 있어서 `SyntaxError: Export named 'SETUP_LINKS' not found` 로 파일 전체가 죽었다.
import SetupDonePage from './page';
import { SETUP_LINKS } from './setup-links';

describe('SetupDonePage — Phase 2 mount surface', () => {
  test('exports a default component function', () => {
    expect(typeof SetupDonePage).toBe('function');
  });

  test('prerenders without a daemon provider', () => {
    expect(() => renderToStaticMarkup(createElement(SetupDonePage))).not.toThrow();
  });

  test('renders next steps below direct chat and retains the settings links when mounted', async () => {
    const { act, create } = await import('react-test-renderer');
    const { NexusProvider } = await import('@/nexus/hooks/use-nexus-context');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = {
      getLlmProviders: async () => ({ activeProvider: 'test' }),
      getChatFastPath: async () => ({ enabled: true }),
    } as Parameters<typeof NexusProvider>[0]['client'];
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(createElement(NexusProvider, { client, children: createElement(SetupDonePage) }));
    });
    const html = JSON.stringify(tree.toJSON());
    expect(html).toContain('곧장 chat 으로');
    expect(html).toContain('elanous doctor --fix --yes');
    expect(html).toContain('chat.fastPath=true');
    expect(html).toContain('elanous config set chat.fastPath false');
    expect(html).not.toContain('smart');
    expect(html.indexOf('고칠 것 고치기')).toBeLessThan(html.indexOf('짧은 물음은 빠르게'));
    expect(html.indexOf('짧은 물음은 빠르게')).toBeLessThan(html.indexOf('현재 LLM provider'));
    expect(html).toContain('다음 셋업(선택)');
    expect(html).toContain('필요하면 더 셋업하기');
    expect(tree.root.findByProps({ 'data-testid': 'setup-done-link-channels' }).props.href).toBe('/settings#channels');
    expect(html).not.toContain('Slack');
    expect(html.indexOf('곧장 chat 으로')).toBeLessThan(html.indexOf('다음 셋업(선택)'));
    expect(html.indexOf('다음 셋업(선택)')).toBeLessThan(html.indexOf('필요하면 더 셋업하기'));
    for (const anchor of ['channels', 'voice', 'ios', 'personas', 'tools', 'advanced']) {
      expect(html).toContain(`setup-done-link-${anchor}`);
    }
    await act(async () => { tree.unmount(); });
  });
});

describe('SETUP_LINKS inventory contract', () => {
  test('channels link stays on settings but describes only the supported bots', () => {
    const channels = SETUP_LINKS.find(link => link.anchor === 'channels');
    expect(channels?.description).toBe('Telegram / Discord 봇 연결');
    expect(channels?.description).not.toContain('Slack');
  });
  test('exports 6 link cards', () => {
    expect(SETUP_LINKS.length).toBe(6);
  });

  test('every link has anchor + label + description + primary fields', () => {
    for (const link of SETUP_LINKS) {
      expect(typeof link.anchor).toBe('string');
      expect(link.anchor.length).toBeGreaterThan(0);
      expect(typeof link.label).toBe('string');
      expect(link.label.length).toBeGreaterThan(0);
      expect(typeof link.description).toBe('string');
      expect(link.description.length).toBeGreaterThan(0);
      expect(typeof link.primary).toBe('boolean');
    }
  });

  test('anchor ids are unique', () => {
    const ids = SETUP_LINKS.map((l) => l.anchor);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('anchor ids are kebab-case (lowercase alphanumerics + dash)', () => {
    for (const link of SETUP_LINKS) {
      expect(link.anchor).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test('3 primary + 3 optional split (matches design — 안 쓰는 사람 많은 항목은 collapsed)', () => {
    const primaryCount = SETUP_LINKS.filter((l) => l.primary).length;
    const optionalCount = SETUP_LINKS.filter((l) => !l.primary).length;
    expect(primaryCount).toBe(3);
    expect(optionalCount).toBe(3);
  });

  test('personas anchor is in the optional (collapsed) set — per user feedback', () => {
    const personas = SETUP_LINKS.find((l) => l.anchor === 'personas');
    expect(personas).toBeDefined();
    expect(personas?.primary).toBe(false);
  });

  test('expected anchor inventory (Phase 3 가 동일 id 사용해야 함)', () => {
    const anchors = SETUP_LINKS.map((l) => l.anchor).sort();
    expect(anchors).toEqual([
      'advanced',
      'channels',
      'ios',
      'personas',
      'tools',
      'voice',
    ]);
  });
});
