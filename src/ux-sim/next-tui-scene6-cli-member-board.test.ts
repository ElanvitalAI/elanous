import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from '../tui/core/render.js';

test('actual default Next CLI supplies its config-root member session to Scene 6 board receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-scene6-cli-board-'));
  const token = 'aps_' + 's'.repeat(40);
  const memberId = 'member-scene6-cli';
  const cardId = 'suggestion-scene6-cli';
  const runId = 'run-scene6-cli';
  const paths: string[] = [];
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('denied', { status: 401 });
    if (path === '/v1/members/owner') return Response.json({ memberId });
    if (path === '/v1/board') return Response.json({ cards: [{
      id: cardId, memberId, title: '티켓 예매 앱', state: 'deployed', runId,
      resultUrl: 'https://demo.example.test/ticket-app',
      attachments: [
        { kind: 'diagram', title: '아키텍처', url: 'https://demo.example.test/diagram.svg', sha256: 'a'.repeat(64) },
        { kind: 'pdf', title: '설계 PDF', url: 'https://demo.example.test/design.pdf', sha256: 'b'.repeat(64) },
      ],
    }] });
    return new Response('missing', { status: 404 });
  } });
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const sessionFile = join(root, 'member-session.json');
    writeFileSync(sessionFile, JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
    chmodSync(sessionFile, 0o600);
    // The isolated graph fixture supplies a completed build; the private session must
    // cross src/index.ts -> showNextTui -> REPL IPC before the board can be read.
    writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
    writeFileSync(join(root, 'next-graph-results.test.json'), JSON.stringify({
      'absorb-build': { graphId: 'absorb-build', runId, status: 'done' },
    }));
    const repo = resolve(import.meta.dir, '../..');
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SCENE6-CLI', name: 'ToolSearch',
          args: { query: 'route:제안 적용해줘' }, after: { name: 'suggest_accept', args: { suggestionId: cardId } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'approval', text: 'SCENE6-CLI 제안 적용해줘',
          until: screen => screen.includes('플러그인 그래프 승인 · 요청 내용') && screen.includes('이 제안을 격리된 앱 복사본에 적용') },
        { label: 'done', keys: 'y', until: screen => screen.includes('턴 완료') },
        { label: 'board receipt log', keys: '\x1b[5~', until: screen => screen.includes('개발 진행 보드 · 배포됨') },
      ],
    });
    const sessionName = readdirSync(join(root, 'sessions')).find(name => name.endsWith('.jsonl'));
    expect(sessionName).toBeDefined();
    const rows = readFileSync(join(root, 'sessions', sessionName!), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { toolName?: string; toolResult?: string });
    const result = JSON.parse(rows.find(row => row.toolName === 'suggest_accept')?.toolResult ?? '{}') as { output?: string };
    expect(result.output).toContain('개발 진행 보드 · 배포됨');
    expect(result.output).toContain('https://demo.example.test/design.pdf');
    expect(run.frames.find(frame => frame.label === 'board receipt log')?.screen).toContain('개발 진행 보드 · 배포됨');
    expect(paths).toContain('/v1/board');
    expect(paths.filter(path => path === '/v1/members/owner').length).toBeGreaterThan(1); // Source: #37069 graph gate and board receipt each resolve the owner through Nexus.
    expect(run.exitCode).toBe(0);
  } finally {
    nexus.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
