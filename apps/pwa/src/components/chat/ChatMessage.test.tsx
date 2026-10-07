// Phase B-2 (PWA chat streaming · 2026-05-06) — ChatMessageView blocks
// branch render contract.
//
// PWA bun test env has no React Testing Library, so we drive the
// component through `react-dom/server.renderToStaticMarkup` and grep
// the resulting HTML for the structural markers a future broken
// renderer would lose: `<img>` tag for image blocks, markdown
// paragraph for text blocks, fallback to legacy `text` rendering when
// `blocks` is absent or empty.

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatMessageView } from './ChatMessage';
import type { ChatMessage } from '@/lib/chat-runtime';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-test-1',
    role: 'assistant',
    text: '',
    timestamp: Date.parse('2026-05-06T12:00:00Z'),
    ...overrides,
  };
}

describe('ChatMessageView — blocks renderer (Phase B-2)', () => {
  it('renders a markdown paragraph from `text` when blocks are absent (legacy path)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView message={makeMessage({ text: 'hello world' })} />,
    );
    expect(html).toMatch(/hello world/);
    // Legacy path uses MarkdownBody — should produce a <p> tag.
    expect(html).toMatch(/<p[^>]*>hello world<\/p>/);
    // No image markers since there are no blocks.
    expect(html).not.toMatch(/data-elanous-block-kind="image"/);
  });

  it('renders blocks branch when `blocks` is non-empty (image inline)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: 'see this',
          blocks: [
            { kind: 'text', text: 'see this' },
            {
              kind: 'image',
              src: 'data:image/png;base64,iVBORw0KGgo=',
              mediaType: 'image/png',
              alt: 'screenshot',
            },
          ],
        })}
      />,
    );
    // Markdown text from the text block.
    expect(html).toMatch(/see this/);
    // Image element with the daemon-supplied data URI + media type
    // marker (so a future regression replacing the renderer with a
    // text-only fallback fails this).
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo="/);
    expect(html).toMatch(/data-elanous-block-kind="image"/);
    expect(html).toMatch(/data-elanous-media-type="image\/png"/);
    expect(html).toMatch(/alt="screenshot"/);
  });

  it('falls back to text path when `blocks` is an empty array', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({ text: 'fallback', blocks: [] })}
      />,
    );
    expect(html).toMatch(/<p[^>]*>fallback<\/p>/);
    expect(html).not.toMatch(/data-elanous-block-kind/);
  });

  it('synthesizes a default alt when image block omits alt', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'image',
              src: 'data:image/jpeg;base64,/9j/',
              mediaType: 'image/jpeg',
            },
          ],
        })}
      />,
    );
    // No caller-supplied alt → derives one from media type so screen
    // readers / inspectors still see a hint.
    expect(html).toMatch(/alt="inline image \(image\/jpeg\)"/);
  });

  // ── Phase B-3 — tool_use pill renderer ───────────────────────────

  it('B-3: renders tool_use block as a pill with name + status icon (running)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_use',
              id: 'call-1',
              name: 'WebTerminalScreenshot',
              status: 'running',
              args: { terminalId: 't-1' },
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="tool_use"/);
    expect(html).toMatch(/data-elanous-tool-name="WebTerminalScreenshot"/);
    expect(html).toMatch(/data-elanous-tool-status="running"/);
    // Running glyph.
    expect(html).toMatch(/⋯/);
  });

  it('B-3: done status renders the check glyph + summary line', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_use',
              id: 'call-1',
              name: 'Read',
              status: 'done',
              summary: '95 lines',
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-tool-status="done"/);
    expect(html).toMatch(/✓/);
    expect(html).toMatch(/95 lines/);
  });

  it('renders each tool block timing independently without replacing the message timestamp', () => {
    const first = Date.parse('2026-05-06T12:01:02Z');
    const second = Date.parse('2026-05-06T12:03:04Z');
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          blocks: [
            { kind: 'tool_use', id: 'call-1', name: 'Read', status: 'done', startedAt: first },
            { kind: 'tool_use', id: 'call-2', name: 'Grep', status: 'done', startedAt: second },
          ],
        })}
      />,
    );
    expect(html).toContain(new Date(first).toLocaleTimeString());
    expect(html).toContain(new Date(second).toLocaleTimeString());
    expect(html).toContain(new Date(makeMessage().timestamp).toLocaleTimeString());
  });

  it('does not render a block timestamp for legacy tool blocks without timing', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          blocks: [{ kind: 'tool_use', id: 'call-legacy', name: 'Read', status: 'done' }],
        })}
      />,
    );
    expect(html).not.toMatch(/→/);
    expect(html).toContain(new Date(makeMessage().timestamp).toLocaleTimeString());
  });

  it('B-3: error status renders the cross glyph + tone class', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_use',
              id: 'call-1',
              name: 'Grep',
              status: 'error',
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-tool-status="error"/);
    expect(html).toMatch(/✗/);
    expect(html).toMatch(/text-destructive/);
  });

  it('B-3: pill collapsed by default — args details panel not in initial markup', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_use',
              id: 'call-1',
              name: 'Read',
              status: 'done',
              args: { path: '/tmp/secret.txt', limit: 100 },
            },
          ],
        })}
      />,
    );
    // Args text only appears after the user clicks the pill — which
    // we can't simulate without RTL — so the static markup must NOT
    // contain the args JSON. The collapsed marker `▸` should appear
    // when args are present.
    expect(html).not.toMatch(/secret\.txt/);
    expect(html).toMatch(/▸/);
  });

  it('tool sources stay inside the initially collapsed card and expand with its summary', () => {
    const html = renderToStaticMarkup(<ChatMessageView mobileSimple message={makeMessage({ blocks: [{
      kind: 'tool_use', id: 'call-source', name: 'Read', status: 'done', summary: 'one file',
      sources: [{ label: 'sensitive file', source: '/tmp/private', ago: null }],
    }] })} />);
    expect(html).toContain('one file');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('sensitive file');
    expect(html).toContain('▸');
  });

  it('tool card opens sources on click without changing its one-line default', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ChatMessageView mobileSimple message={makeMessage({ blocks: [{
      kind: 'tool_use', id: 'call-source', name: 'Read', status: 'done', summary: 'one file',
      sources: [{ label: 'source file', source: '/tmp/private', ago: null }],
    }] })} />); });
    try {
      const card = tree.root.findByProps({ 'data-elanous-block-kind': 'tool_use' });
      expect(card.findByType('button').props['aria-expanded']).toBe(false);
      expect(card.findAllByProps({ 'aria-label': '출처' })).toHaveLength(0);
      await act(async () => card.findByType('button').props.onClick());
      expect(card.findByType('button').props['aria-expanded']).toBe(true);
      expect(card.findByProps({ 'aria-label': '출처' }).findByType('li').children.join('')).toBe('source file');
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('1024px tool sources keep the prior visible card below the pill', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={makeMessage({ blocks: [{
      kind: 'tool_use', id: 'call-source', name: 'Read', status: 'done', summary: 'one file',
      sources: [{ label: 'source file', source: '/tmp/private', ago: null }],
    }] })} />);
    expect(html).toContain('source file');
    expect(html).not.toContain('aria-expanded="false"');
  });

  it('B-3: pill without args has no expand affordance (no triangle marker)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_use',
              id: 'call-1',
              name: 'NoArgs',
              status: 'done',
            },
          ],
        })}
      />,
    );
    expect(html).not.toMatch(/▸/);
    expect(html).not.toMatch(/▾/);
  });

  it('meta messages always render via the small italic surface (independent of blocks)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          role: 'meta',
          text: 'switched provider',
          // Even with blocks supplied, meta path takes precedence.
          blocks: [{ kind: 'text', text: 'ignored' }],
        })}
      />,
    );
    expect(html).toMatch(/switched provider/);
    expect(html).not.toMatch(/ignored/);
    expect(html).toMatch(/italic/);
  });

  // ── M3 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) ────────
  // Feedback Envelope-derived blocks render contract.

  it('M3: agent_thinking running pulses (no ✓, blockId stamped)', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_thinking',
              blockId: 's-1:thinking:1',
              msg: 'Thinking',
              done: false,
              metrics: { elapsedMs: 1200, tokenCount: 250 },
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="agent_thinking"/);
    expect(html).toMatch(/data-elanous-block-id="s-1:thinking:1"/);
    expect(html).toMatch(/data-elanous-done="false"/);
    expect(html).toMatch(/Thinking/);
    expect(html).toMatch(/1s/);
    expect(html).toMatch(/250 tokens/);
    expect(html).not.toMatch(/✓/);
  });

  it('M3: agent_thinking done flips to ✓ + final metrics', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_thinking',
              blockId: 's-1:thinking:1',
              msg: 'Reasoning',
              done: true,
              metrics: { elapsedMs: 8000, tokenCount: 1500 },
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-done="true"/);
    expect(html).toMatch(/✓/);
    expect(html).toMatch(/Reasoning/);
    expect(html).toMatch(/8s/);
    expect(html).toMatch(/1\.5k tokens/);
  });

  it('M3: agent_status running renders agentId + lastEvent + pulse', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_status',
              blockId: 's-1:sys:agent-status:claude-code',
              agentId: 'claude-code',
              status: 'running',
              lastEvent: 'tool-call',
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="agent_status"/);
    expect(html).toMatch(/data-monad-agent-id="claude-code"/);
    expect(html).toMatch(/data-elanous-status="running"/);
    expect(html).toMatch(/claude-code/);
    expect(html).toMatch(/tool-call/);
    expect(html).toMatch(/animate-pulse/);
  });

  it('M3: agent_status done / error glyph + tone differ from running', () => {
    const done = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_status',
              blockId: 'b-done',
              agentId: 'codex',
              status: 'done',
            },
          ],
        })}
      />,
    );
    expect(done).toMatch(/data-elanous-status="done"/);
    expect(done).toMatch(/✓/);
    const err = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_status',
              blockId: 'b-err',
              agentId: 'codex',
              status: 'error',
            },
          ],
        })}
      />,
    );
    expect(err).toMatch(/data-elanous-status="error"/);
    expect(err).toMatch(/✗/);
    expect(err).toMatch(/text-destructive/);
  });

  it('M3: agent_plan renders step list with status glyphs + active marker', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_plan',
              blockId: 's-1:plan:plan-A',
              ref: 'plan-A',
              steps: [
                { text: 'Read files', status: 'done' },
                { text: 'Patch wire', status: 'in-progress' },
                { text: 'Run tests', status: 'pending' },
              ],
              activeIndex: 1,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="agent_plan"/);
    expect(html).toMatch(/data-elanous-plan-ref="plan-A"/);
    expect(html).toMatch(/Read files/);
    expect(html).toMatch(/Patch wire/);
    expect(html).toMatch(/Run tests/);
    expect(html).toMatch(/data-elanous-step-status="done"/);
    expect(html).toMatch(/data-elanous-step-status="in-progress"/);
    expect(html).toMatch(/data-elanous-step-status="pending"/);
    // 2/3 progress marker
    expect(html).toMatch(/2\/3/);
  });

  it('M3: agent_plan skipped step renders strikethrough tone', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'agent_plan',
              blockId: 'b-plan',
              ref: 'plan-B',
              steps: [{ text: 'Aborted step', status: 'skipped' }],
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-step-status="skipped"/);
    expect(html).toMatch(/line-through/);
  });

  // ── M4 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) ────────
  // tool.diff / tool.search-hit renderers.

  it('M4: tool_diff renders summary line (file, lang, +N/-M) and stays collapsed by default', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_diff',
              blockId: 's:tc-1',
              filePath: 'src/foo.ts',
              language: 'typescript',
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 2,
                  lines: [
                    { kind: 'ctx', text: 'header' },
                    { kind: 'del', text: 'old' },
                    { kind: 'add', text: 'new1' },
                    { kind: 'add', text: 'new2' },
                  ],
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="tool_diff"/);
    expect(html).toMatch(/data-elanous-file-path="src\/foo\.ts"/);
    expect(html).toMatch(/src\/foo\.ts/);
    // +2 adds, -1 del rendered in summary tail
    expect(html).toMatch(/\+2/);
    expect(html).toMatch(/-1/);
    expect(html).toMatch(/1 hunk/);
    // Collapsed by default — hunk body lines should NOT be in the
    // static markup.
    expect(html).not.toMatch(/data-elanous-line-kind="add"/);
    expect(html).toMatch(/▸/);
  });

  it('M4: tool_search_hits renders query + accumCount + up to 5 hits', () => {
    const hits = Array.from({ length: 8 }).map((_, i) => ({
      filePath: `file-${i}.ts`,
      line: i + 1,
      snippet: `match-${i}`,
    }));
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_search_hits',
              blockId: 's:tc-grep',
              query: 'needle',
              hits,
              accumCount: 12,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="tool_search_hits"/);
    expect(html).toMatch(/data-elanous-search-query="needle"/);
    expect(html).toMatch(/data-elanous-accum-count="12"/);
    expect(html).toMatch(/needle/);
    expect(html).toMatch(/12 hits/);
    // Only the first 5 hit rows render in collapsed view
    expect(html).toMatch(/file-0\.ts/);
    expect(html).toMatch(/file-4\.ts/);
    expect(html).not.toMatch(/file-5\.ts/);
    // "+ 3 more" button surface
    expect(html).toMatch(/\+ 3 more/);
  });

  it('M4: tool_search_hits truncated flag renders amber marker', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_search_hits',
              blockId: 's:trunc',
              query: 'x',
              hits: [{ filePath: 'a.ts', line: 1, snippet: 'x' }],
              accumCount: 5000,
              truncated: true,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/truncated/);
    expect(html).toMatch(/text-amber/);
  });

  it('M4: tool_search_hits empty hits renders the "no hits yet" placeholder', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_search_hits',
              blockId: 's:empty',
              query: 'q',
              hits: [],
              accumCount: 0,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/no hits yet/);
  });

  it('M4: tool_search_hits a-tag uses vscode:// scheme with line+column', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_search_hits',
              blockId: 's:link',
              query: 'x',
              hits: [
                {
                  filePath: '/abs/path.ts',
                  line: 42,
                  column: 7,
                  snippet: 'x',
                },
              ],
              accumCount: 1,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/vscode:\/\/file\/\/abs\/path\.ts:42:7/);
  });

  // ── M5 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) ────────
  // tool.progress renderer.

  it('M5: tool_progress running shows tail + line count + pulse glyph', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_progress',
              blockId: 's:bash-1',
              stream: 'stdout',
              lines: ['$ ls', 'a.ts', 'b.ts'],
              done: false,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-block-kind="tool_progress"/);
    expect(html).toMatch(/data-elanous-stream="stdout"/);
    expect(html).toMatch(/data-elanous-done="false"/);
    expect(html).toMatch(/b\.ts/);
    expect(html).toMatch(/3 lines/);
    expect(html).toMatch(/animate-pulse/);
  });

  it('M5: tool_progress done with exitCode=0 shows exit 0 + emerald tone', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_progress',
              blockId: 's:bash-done',
              stream: 'stdout',
              lines: ['ok'],
              done: true,
              exitCode: 0,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-done="true"/);
    expect(html).toMatch(/exit 0/);
    expect(html).toMatch(/text-emerald/);
  });

  it('M5: tool_progress with non-zero exit code shows rose tone', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_progress',
              blockId: 's:bash-err',
              stream: 'stderr',
              lines: ['command not found'],
              done: true,
              exitCode: 127,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/exit 127/);
    expect(html).toMatch(/text-rose/);
  });

  it('M5: tool_progress http stream renders bytesSoFar + amber tone', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_progress',
              blockId: 's:http-1',
              stream: 'http',
              lines: ['HTTP/1.1 200 OK', 'Content-Length: 1024'],
              bytesSoFar: 1024,
              done: false,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/data-elanous-stream="http"/);
    expect(html).toMatch(/1\.0KB/);
    expect(html).toMatch(/text-amber/);
  });

  it('M5: tool_progress empty lines renders 0 lines', () => {
    const html = renderToStaticMarkup(
      <ChatMessageView
        message={makeMessage({
          text: '',
          blocks: [
            {
              kind: 'tool_progress',
              blockId: 's:empty',
              stream: 'stdout',
              lines: [],
              done: false,
            },
          ],
        })}
      />,
    );
    expect(html).toMatch(/0 lines/);
  });
});
