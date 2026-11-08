import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// ── Tier flip · wire helpers · unit tests ──
//
// ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 W2.4/W2.5.
// Covers `injectDeferredAnnounce` (placement rules across system-message
// shapes) and `applyDeferredTools` (the convenience pair that
// `runCoreTurn` calls).

import { describe, expect, test } from 'bun:test';

import {
  applyDeferredTools,
  injectDeferredAnnounce,
} from '../src/session-runtime/tier-flip.ts';
import type { LLMMessage } from '../src/llm.ts';
import type { NativeToolCatalogEntry } from '../src/native-tool-catalog.ts';

function spec(name: string): LLMToolSpec {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {}, required: [] },
  };
}

function catalogEntry(opts: {
  id: string;
  alwaysLoad?: boolean;
  shouldDefer?: boolean;
  summary?: string;
}): NativeToolCatalogEntry {
  return {
    id: opts.id,
    kind: 'other',
    aliases: [],
    displayName: opts.id,
    description: `${opts.id} description`,
    promptSummary: opts.summary ?? `\`${opts.id}\` summary`,
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    alwaysLoad: opts.alwaysLoad,
    shouldDefer: opts.shouldDefer,
  };
}

describe('injectDeferredAnnounce', () => {
  test('empty block is a no-op', () => {
    const msgs: LLMMessage[] = [{ role: 'system', content: 'sys' }];
    const out = injectDeferredAnnounce(msgs, '');
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('sys');
  });

  test('appends to a trailing string system message with double-newline separator', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'go' },
    ];
    const out = injectDeferredAnnounce(msgs, '## Deferred\n- X');
    expect(out).toHaveLength(2);
    const sys = out[0] as LLMMessage;
    expect(sys.role).toBe('system');
    expect(sys.content).toBe('You are an agent.\n\n## Deferred\n- X');
    // input untouched
    expect(msgs[0]!.content).toBe('You are an agent.');
  });

  test('trailing newlines are normalised to a single blank line', () => {
    // Whether the input ended with 0/1/2/N trailing newlines, the
    // result must have exactly one blank line between the prefix and
    // the injected block.
    const variants = ['sys', 'sys\n', 'sys\n\n', 'sys\n\n\n'];
    for (const content of variants) {
      const out = injectDeferredAnnounce(
        [{ role: 'system', content }],
        'BLOCK',
      );
      expect(out[0]!.content).toBe('sys\n\nBLOCK');
    }
  });

  test('picks the LAST system message when several exist', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'main' },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'reminder' },
      { role: 'user', content: 'u2' },
    ];
    const out = injectDeferredAnnounce(msgs, 'D');
    expect(out[0]!.content).toBe('main');
    expect((out[2] as LLMMessage).content).toBe('reminder\n\nD');
  });

  test('prepends a fresh system message when none exists', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'u' }];
    const out = injectDeferredAnnounce(msgs, 'D');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'system', content: 'D' });
    expect(out[1]!.role).toBe('user');
  });

  test('appends to the last text block when system content is ContentBlock[]', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'system-text-1' },
          { type: 'text', text: 'system-text-2' },
        ] as any,
      },
    ];
    const out = injectDeferredAnnounce(msgs, 'BLOCK');
    const blocks = out[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toBe('system-text-2\n\nBLOCK');
    // first block unchanged
    expect(blocks[0]!.text).toBe('system-text-1');
  });

  test('pushes a new text block when no text block exists in ContentBlock[]', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'system',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'X' } }] as any,
      },
    ];
    const out = injectDeferredAnnounce(msgs, 'BLOCK');
    const blocks = out[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.type).toBe('text');
    expect(blocks[1]!.text).toBe('BLOCK');
  });

  test('does not mutate the input messages array', () => {
    const msgs: LLMMessage[] = [{ role: 'system', content: 'sys' }];
    const snapshot = JSON.stringify(msgs);
    injectDeferredAnnounce(msgs, 'D');
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });
});

describe('applyDeferredTools', () => {
  test('empty tools → empty active, no-op stats', () => {
    const msgs: LLMMessage[] = [{ role: 'system', content: 's' }];
    const r = applyDeferredTools(msgs, []);
    expect(r.tools).toEqual([]);
    // ⛔ `toEqual` 을 «유지한다» — 이 정확 일치가 「stats 에 칸이 조용히 느는 것」을 무는 가드다.
    //   (2026-08-14: 그 가드가 3일간 빨간 채로 있었다 — #8118 이 칸 넷을 더했는데 이 파일이
    //    그 PR 의 게이트 범위 «밖»이라 안 잡혔다. 약화하지 말고 기대값을 «따라간다».)
    expect(r.stats).toEqual({
      activeCount: 0, deferredCount: 0, warmPreloaded: 0, injected: false,
      deferredNames: [], toolSearchInjected: false, unhydratableCount: 0, unhydratableNames: [],
    });
    expect(r.messages).toEqual(msgs);
  });

  test('all active → identical tools list, injected=false, messages untouched', () => {
    const catalog = [catalogEntry({ id: 'Read' }), catalogEntry({ id: 'Edit' })];
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ];
    const r = applyDeferredTools(msgs, [spec('Read'), spec('Edit')], { catalog });
    expect(r.tools.map((s) => s.name)).toEqual(['Read', 'Edit']);
    expect(r.stats.injected).toBe(false);
    expect(r.stats.deferredCount).toBe(0);
    expect(r.messages[0]!.content).toBe('sys');
  });

  test('mixed → active subset + announce injected + injected=true', () => {
    const catalog = [
      catalogEntry({ id: 'Read' }),
      catalogEntry({
        id: 'CftPdca',
        alwaysLoad: false,
        shouldDefer: true,
        summary: '`CftPdca` (PDCA runner)',
      }),
    ];
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ];
    const r = applyDeferredTools(msgs, [spec('Read'), spec('CftPdca')], { catalog });

    // ⭐ deferred 가 하나라도 생기면 `ToolSearch` 가 «같이» 활성화된다 — 자식이 미룬 툴을
    //   되찾을 길이 없으면 defer 는 「숨김」이 되기 때문이다. 그 동작이 이 목록에 보여야 한다.
    expect(r.tools.map((s) => s.name)).toEqual(['Read', 'ToolSearch']);
    expect(r.stats).toMatchObject({
      // ⭐ 2 = 원래 활성 `Read` ⊕ 위에서 «같이» 켜진 `ToolSearch`. 이 수가 1로 남아 있으면
      //   「ToolSearch 를 안 켰다」와 구분이 안 된다.
      activeCount: 2,
      deferredCount: 1,
      injected: true,
      toolSearchInjected: true,
    });
    const sysContent = r.messages[0]!.content as string;
    expect(sysContent).toContain('sys');
    expect(sysContent).toContain('Deferred tools');
    expect(sysContent).toContain('CftPdca');
    expect(sysContent).toContain('`CftPdca` (PDCA runner)');
  });

  test('messages with no system message get a fresh one when deferred entries exist', () => {
    const catalog = [
      catalogEntry({ id: 'CftPdca', alwaysLoad: false, shouldDefer: true }),
    ];
    const msgs: LLMMessage[] = [{ role: 'user', content: 'u' }];
    const r = applyDeferredTools(msgs, [spec('CftPdca')], { catalog });

    expect(r.stats.injected).toBe(true);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.role).toBe('system');
    expect((r.messages[0]!.content as string)).toContain('Deferred tools');
  });

  test('spec with no catalog match stays active (safe default)', () => {
    const catalog = [catalogEntry({ id: 'Known' })];
    const msgs: LLMMessage[] = [{ role: 'system', content: 's' }];
    const r = applyDeferredTools(msgs, [spec('Known'), spec('Unknown')], { catalog });
    expect(r.tools.map((s) => s.name)).toEqual(['Known', 'Unknown']);
    expect(r.stats.deferredCount).toBe(0);
  });

  // W2.9 opt-out — enabled=false ships every spec to the provider.
  test('enabled=false bypasses the split · pre-Wave-2 behaviour', () => {
    const catalog = [
      catalogEntry({ id: 'Read' }),
      catalogEntry({
        id: 'CftPdca',
        alwaysLoad: false,
        shouldDefer: true,
      }),
    ];
    const msgs: LLMMessage[] = [{ role: 'system', content: 'sys' }];
    const r = applyDeferredTools(
      msgs,
      [spec('Read'), spec('CftPdca')],
      { catalog, enabled: false },
    );
    expect(r.tools.map((s) => s.name)).toEqual(['Read', 'CftPdca']);
    expect(r.stats.injected).toBe(false);
    expect(r.stats.deferredCount).toBe(0);
    expect(r.messages[0]!.content).toBe('sys'); // no announce
  });
});
