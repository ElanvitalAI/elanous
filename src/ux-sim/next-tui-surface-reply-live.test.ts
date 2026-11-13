import goldenReply from './fixtures/surface-reply-golden-turn.json';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

// 출처: #37048 bab9a9a 설치본 PTY의 기존 관찰 예산(턴 60초·로그 10초)을 유지한다.
const TURN_TIMEOUT_MS = 60_000;
// 출처: #37048 bab9a9a 설치본 PTY의 기존 로그 관찰 예산.
const LOG_TIMEOUT_MS = 10_000;

// 출처: Next compact 기본 높이 24행 양쪽의 기기 fixture (18행/35행).
test.each([18, 35])('installed Next TUI keeps tool output in explicit log and only the public answer in basic chat (rows=%s)', async (rows) => {
  const root = mkdtempSync(join(tmpdir(), 'next-public-reply-live-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
          when: 'PLUGIN-LIVE', name: 'ToolSearch', args: { query: 'route:제안 적용해줘' },
          after: { name: 'suggest_accept', args: { suggestionId: 'demo' } },
        }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root,
      },
      ready: { label: 'boot', until: (screen) => screen.includes('Ctrl+Q 종료') && screen.includes('❯') },
      steps: [
        { label: 'basic answer', text: 'PLUGIN-LIVE 제안 적용해줘', timeoutMs: TURN_TIMEOUT_MS,
          until: (screen) => screen.includes('턴 완료') && screen.includes('[fake-llm] done') },
        { label: 'explicit log', keys: '\x1b[5~', timeoutMs: LOG_TIMEOUT_MS,
          until: (screen) => screen.includes('도구: suggest_accept · 오류') },
        { label: 'back to basic', keys: '\x1b', timeoutMs: LOG_TIMEOUT_MS,
          until: (screen) => screen.includes('[fake-llm] done') && !screen.includes('로그 탐색') && !screen.includes('도구:') },
      ],
      ...(process.env.ELANOUS_SURFACE_REPLY_PTY_ARTIFACT
        ? { artifactPath: process.env.ELANOUS_SURFACE_REPLY_PTY_ARTIFACT.replace(/\.json$/, `-${rows}.json`) } : {}),
    });
    const basic = run.frames.find((frame) => frame.label === 'basic answer')?.screen ?? '';
    const log = run.frames.find((frame) => frame.label === 'explicit log')?.screen ?? '';
    const returned = run.frames.find((frame) => frame.label === 'back to basic')?.screen ?? '';
    expect(basic).toContain('[fake-llm] done');
    expect(basic).not.toContain('도구:');
    expect(basic).not.toContain('graph route requires a verified owner context');
    expect(log).toContain('도구: suggest_accept · 오류');
    expect(returned).toContain('[fake-llm] done');
    expect(returned).not.toContain('도구:');
    expect(returned).not.toContain('graph route requires a verified owner context');
    const sessionFile = readdirSync(join(root, 'sessions')).find((file) => file.endsWith('.jsonl'));
    expect(sessionFile).toBeDefined();
    const savedRows = readFileSync(join(root, 'sessions', sessionFile!), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { toolName?: string; toolResult?: string });
    const tool = savedRows.find((row) => row.toolName === 'suggest_accept');
    expect(JSON.parse(tool?.toolResult ?? '{}')).toEqual({ error: 'graph route requires a verified owner context' });
    expect(run.exitCode).toBe(0);
    expect(run.binarySha256).toHaveLength(64);
    expect(run.entrySha256).toHaveLength(64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('installed Next TUI renders authored final actions in order through public history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-public-actions-live-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: goldenReply.finalProse,
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
          when: '정리해줘', name: 'ToolSearch', args: { query: goldenReply.internalMarker },
        }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root,
      },
      ready: { label: 'boot', until: (screen) => screen.includes('Ctrl+Q 종료') && screen.includes('❯') },
      steps: [{ label: 'public final actions', text: '정리해줘', timeoutMs: TURN_TIMEOUT_MS,
        until: (screen) => screen.includes('턴 완료') && screen.includes(`할 일: ${goldenReply.actions[1]}`) }],
      ...(process.env.ELANOUS_SURFACE_REPLY_ACTION_PTY_ARTIFACT
        ? { artifactPath: process.env.ELANOUS_SURFACE_REPLY_ACTION_PTY_ARTIFACT } : {}),
    });
    const screen = run.frames.find((frame) => frame.label === 'public final actions')?.screen ?? '';
    expect(screen).toContain(goldenReply.answer);
    expect(screen.indexOf('할 일: 검토하세요.')).toBeGreaterThan(screen.indexOf(goldenReply.answer));
    expect(screen.indexOf('할 일: 공유하세요.')).toBeGreaterThan(screen.indexOf('할 일: 검토하세요.'));
    expect(screen).not.toContain('도구:');
    expect(screen).not.toContain(goldenReply.internalMarker);
    const publicLines = screen.split('\n').map((line) => line.trim().replace(/^엘라누스: /, ''))
      .filter((line) => line === goldenReply.answer || line.startsWith('할 일: '));
    expect(publicLines.join('\n')).toBe(goldenReply.expectedFinalText);
    const stored = readdirSync(join(root, 'sessions')).filter((file) => file.endsWith('.jsonl'))
      .map((file) => readFileSync(join(root, 'sessions', file), 'utf8')).join('\n');
    expect(stored).toContain(goldenReply.internalMarker);
    expect(run.exitCode).toBe(0);
    expect(run.binarySha256).toHaveLength(64);
    expect(run.entrySha256).toHaveLength(64);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
