import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

test('next TUI PTY hydrates a plugin graph tool, then refuses an ownerless call before confirmation', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot
    ? mkdtempSync(join(resolve(keptRoot), 'run-'))
    : mkdtempSync(join(tmpdir(), 'next-plugin-dispatch-live-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      rows: 35,
      cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
          when: 'PLUGIN-LIVE', name: 'ToolSearch', args: { query: 'route:제안 적용해줘' },
          after: { name: 'suggest_accept', args: { suggestionId: 'demo' } },
        }),
        ELANOUS_CONFIG_DIR: root,
        ELANOUS_STATE_DIR: root,
      },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous next ·') && screen.includes('Ctrl+Q 종료') },
      steps: [{
        // Source: 내부 문서 `next-tui-production` B2 PTY receipt uses a bounded isolated turn.
        label: 'plugin round', text: 'PLUGIN-LIVE 제안 적용해줘', timeoutMs: 60_000,
        until: (screen) => screen.includes('graph route requires a verified owner context') && screen.includes('응답 완료'),
      }],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const sessionFile = readdirSync(join(root, 'sessions')).find(file => file.endsWith('.jsonl'));
    expect(sessionFile).toBeDefined();
    const rows = readFileSync(join(root, 'sessions', sessionFile!), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { role?: string; toolName?: string; toolResult?: string });
    const search = rows.find(row => row.toolName === 'ToolSearch');
    const graph = rows.find(row => row.toolName === 'suggest_accept');
    expect(JSON.parse(search?.toolResult ?? '{}')).toMatchObject({ matched: ['suggest_accept'] });
    expect(JSON.parse(search?.toolResult ?? '{}').content).toContain('"suggestionId"');
    expect(JSON.parse(graph?.toolResult ?? '{}')).toEqual({ error: 'graph route requires a verified owner context' });
    const screen = run.frames.find(frame => frame.label === 'plugin round')?.screen ?? '';
    expect(screen).toContain('도구: suggest_accept · 오류');
    expect(screen).not.toContain('y/n');
    expect(run.exitCode).toBe(0);
    expect(run.binarySha256).toHaveLength(64);
    expect(run.entrySha256).toHaveLength(64);
    if (keptRoot) console.log(`next TUI plugin dispatch PTY receipt: ${root}`);
  } finally {
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
