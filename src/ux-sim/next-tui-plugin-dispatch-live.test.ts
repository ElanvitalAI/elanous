import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from '../tui/core/render.js';

// PTY steps use mockSeatPtySequence's existing default; no per-scene timeout policy.

function sessionToolResult(root: string, name: string): Record<string, unknown> {
  const sessionFile = readdirSync(join(root, 'sessions')).find(file => file.endsWith('.jsonl'));
  if (!sessionFile) throw new Error('next TUI session transcript missing');
  const tool = readFileSync(join(root, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { toolName?: string; toolResult?: string })
    .filter(row => row.toolName === name).at(-1);
  if (!tool?.toolResult) throw new Error(`next TUI tool result missing: ${name}`);
  return JSON.parse(tool.toolResult) as Record<string, unknown>;
}

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
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') && screen.includes('❯') },
      steps: [{
        // Source: 내부 문서 `next-tui-production` B2 PTY receipt uses a bounded isolated turn.
        label: 'plugin round', text: 'PLUGIN-LIVE 제안 적용해줘',
        until: (screen) => screen.includes('턴 완료'),
      }, {
        label: 'owner denial log', keys: '\x1b[5~',
        until: (screen) => screen.includes('graph route requires a verified owner context'),
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
    expect(run.frames.find(frame => frame.label === 'plugin round')?.screen).toContain('턴 완료');
    const screen = run.frames.find(frame => frame.label === 'owner denial log')?.screen ?? '';
    expect(screen).toContain('턴 로그');
    expect(screen).toContain('graph route requires a verified owner context');
    expect(screen).not.toContain('응답 완료');
    expect(screen).not.toContain('y/n');
    expect(run.exitCode).toBe(0);
    expect(run.binarySha256).toHaveLength(64);
    expect(run.entrySha256).toHaveLength(64);
    if (keptRoot) console.log(`next TUI plugin dispatch PTY receipt: ${root}`);
  } finally {
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('next TUI demo scene 1 routes injected scrap arguments to the owner gate', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot
    ? mkdtempSync(join(resolve(keptRoot), 'scene1-'))
    : mkdtempSync(join(tmpdir(), 'next-demo-scene1-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  const article = '축제·콘서트 티켓 대란 — 접속 폭주로 예매 실패';
  const url = 'https://news.example.test/ticket-rush';
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
          when: 'SCENE1-SCRAP', name: 'ToolSearch', args: { query: 'route:이 기사 스크랩해줘' },
          after: { name: 'scrap_add', args: { kind: 'web', text: article, url } },
        }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root,
      },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [{
        label: 'scene1 scrap', text: `SCENE1-SCRAP 이 기사 스크랩해줘 ${url}`,
        until: screen => screen.includes('턴 완료'),
      }, {
        label: 'scene1 owner denial log', keys: '\x1b[5~',
        until: screen => screen.includes('graph route requires a verified owner context'),
      }],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const sessionFile = readdirSync(join(root, 'sessions')).find(file => file.endsWith('.jsonl'));
    expect(sessionFile).toBeDefined();
    const rows = readFileSync(join(root, 'sessions', sessionFile!), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { toolName?: string; toolArgs?: unknown; toolResult?: string });
    expect(rows.find(row => row.toolName === 'ToolSearch')).toBeDefined();
    const scrap = rows.find(row => row.toolName === 'scrap_add');
    expect(scrap).toBeDefined();
    expect(JSON.stringify(scrap?.toolArgs)).toContain(url);
    expect(JSON.parse(scrap?.toolResult ?? '{}')).toEqual({ error: 'graph route requires a verified owner context' });
    expect(run.frames.find(frame => frame.label === 'scene1 scrap')?.screen).toContain('턴 완료');
    expect(run.frames.at(-1)?.screen).toContain('턴 로그');
    expect(run.frames.at(-1)?.screen).toContain('graph route requires a verified owner context');
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`next TUI demo scene 1 PTY receipt: ${root}`);
  } finally {
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('next TUI test-world member session reaches graph y/N and N denies execution', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot ? mkdtempSync(join(resolve(keptRoot), 'approval-')) : mkdtempSync(join(tmpdir(), 'next-graph-approval-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const token = 'aps_' + 'a'.repeat(40);
  let verifiedOwnerRequested = false;
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner' || request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    verifiedOwnerRequested = true;
    return Response.json({ memberId: 'member-next-demo' });
  } });
  writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'GRAPH-APPROVAL', name: 'ToolSearch',
          args: { query: 'route:제안 적용해줘' }, after: { name: 'suggest_accept', args: { suggestionId: 'demo' } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root,
      },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'approval', text: 'GRAPH-APPROVAL 제안 적용해줘',
          until: screen => screen.includes('플러그인 그래프 승인 · 요청 내용') && screen.includes('y 승인 · n 거부') },
        { label: 'N denial', keys: 'n', until: screen => screen.includes('턴 완료') },
      ],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    expect(verifiedOwnerRequested).toBe(true);
    expect(sessionToolResult(root, 'suggest_accept')).toMatchObject({ error: 'confirmation declined for suggest_accept' });
    expect(run.frames.find(frame => frame.label === 'approval')?.screen).toContain('이 제안을 격리된 앱 복사본에 적용');
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`next TUI graph approval PTY receipt: ${root}`);
  } finally {
    nexus.stop(true);
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('next TUI test world completes scene 1 scrap route with a verified mock Nexus member', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot ? mkdtempSync(join(resolve(keptRoot), 'scene1-pass-')) : mkdtempSync(join(tmpdir(), 'next-scene1-pass-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const token = 'aps_' + 'b'.repeat(40);
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner' || request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return Response.json({ memberId: 'member-next-demo' });
  } });
  const url = 'https://news.example.test/ticket-rush';
  const scrapId = 'scrap-kcb-article-1';
  writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
  writeFileSync(join(root, 'next-graph-results.test.json'), JSON.stringify({
    'absorb-ingest': { graphId: 'absorb-ingest', status: 'done', sourceScrapId: scrapId,
      result: { scrapId, owner: 'member-next-demo', kind: 'web', url } },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SCENE1-PASS', name: 'ToolSearch',
          args: { query: 'route:이 기사 스크랩해줘' }, after: { name: 'scrap_add',
            args: { kind: 'web', text: '축제·콘서트 티켓 대란 — 접속 폭주로 예매 실패', url } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [{ label: 'scene1 pass', text: `SCENE1-PASS 이 기사 스크랩해줘 ${url}`,
        until: screen => screen.includes('턴 완료') }],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const calls = readFileSync(join(root, 'next-graph-calls.test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ graphId: 'absorb-ingest', verifiedOwner: 'member-next-demo',
      args: { kind: 'web', url }, result: { status: 'done', sourceScrapId: scrapId } });
    expect(sessionToolResult(root, 'scrap_add')).toMatchObject({ status: 'done',
      result: { scrapId, owner: 'member-next-demo', url } });
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`next TUI scene 1 pass PTY receipt: ${root}`);
  } finally {
    nexus.stop(true);
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('next TUI private host session carries briefing and suggestion approval through y', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot ? mkdtempSync(join(resolve(keptRoot), 'scene2-3-')) : mkdtempSync(join(tmpdir(), 'next-scene2-3-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const token = 'aps_' + 'c'.repeat(40);
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner' || request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return Response.json({ memberId: 'member-next-demo' });
  } });
  // Use the real private host envelope, not the test-only owner override.
  writeFileSync(join(root, 'member-session.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 }); // Source: next-tui-scene6-cli-member-board fixture's one-turn session lifetime.
  writeFileSync(join(root, 'next-graph-results.test.json'), JSON.stringify({
    'absorb-brief': { graphId: 'absorb-brief', status: 'done', result: { briefing: { id: 'brief-kcb-ticket-1',
      topics: [{ summary: '접속 폭주·예매 실패', sourceScrapIds: ['scrap-kcb-article-1'] }] } } },
    'absorb-suggest-list': { graphId: 'absorb-suggest-list', status: 'done', result: { suggestions: [
      { id: 'suggestion-kcb-ticket-1', service: '티켓 예매 서비스', evidenceScrapIds: ['scrap-kcb-article-1'] }] } },
    'absorb-build': { graphId: 'absorb-build', status: 'done', result: { acceptance: {
      suggestionId: 'suggestion-kcb-ticket-1', owner: 'member-next-demo', accepted: true } } },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SCENE2-3', calls: [
          { name: 'ToolSearch', args: { query: 'route:오늘 브리핑' } }, { name: 'brief_today', args: {} },
          { name: 'ToolSearch', args: { query: 'route:제안 목록' } }, { name: 'suggest_list', args: {} },
          { name: 'ToolSearch', args: { query: 'route:이 제안 수락' } },
          { name: 'suggest_accept', args: { suggestionId: 'suggestion-kcb-ticket-1' } },
        ] }), ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'scene 3 approval', text: 'SCENE2-3 오늘 브리핑 보고 티켓 제안을 수락해줘',
          until: screen => screen.includes('플러그인 그래프 승인 · 요청 내용') && screen.includes('이 제안을 격리된 앱 복사본에 적용') },
        { label: 'scene 2 and 3 complete', keys: 'y', until: screen => screen.includes('턴 완료') },
      ],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const calls = readFileSync(join(root, 'next-graph-calls.test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.graphId)).toEqual(['absorb-brief', 'absorb-suggest-list', 'absorb-build']);
    expect(calls.every(call => call.verifiedOwner === 'member-next-demo')).toBe(true);
    expect(calls[2].result.result.acceptance).toMatchObject({ accepted: true, suggestionId: 'suggestion-kcb-ticket-1' });
    expect(sessionToolResult(root, 'brief_today')).toMatchObject({ status: 'done',
      result: { briefing: { id: 'brief-kcb-ticket-1' } } });
    expect(sessionToolResult(root, 'suggest_accept')).toMatchObject({ status: 'done',
      result: { acceptance: { accepted: true, suggestionId: 'suggestion-kcb-ticket-1' } } });
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`next TUI scenes 2-3 PTY receipt: ${root}`);
  } finally {
    nexus.stop(true);
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('next TUI scene 5 GCP graph approval denies N and accepts a later y in the mock world', async () => {
  const keptRoot = process.env.ELANOUS_PLUGIN_DISPATCH_LIVE_OUT?.trim();
  if (keptRoot) mkdirSync(resolve(keptRoot), { recursive: true });
  const root = keptRoot ? mkdtempSync(join(resolve(keptRoot), 'scene5-gcp-')) : mkdtempSync(join(tmpdir(), 'next-scene5-gcp-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const token = 'aps_' + 'd'.repeat(40);
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner' || request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return Response.json({ memberId: 'member-next-demo' });
  } });
  writeFileSync(join(root, 'next-member-session.test.json'), JSON.stringify({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }));
  const designPath = join(root, 'ticket-design.json');
  writeFileSync(designPath, JSON.stringify({ service: 'ticketing', concurrentUsers: 100000 }));
  writeFileSync(join(root, 'next-graph-results.test.json'), JSON.stringify({
    'gcp-architect-expand': { graphId: 'gcp-architect-expand', status: 'done', result: {
      proposal: 'mock GCP regional expansion', monthlyCostUsd: 1200, securityClass: 'internal',
      sourceDesignPath: designPath, realGcpCalls: 0 } },
  }));
  const repo = resolve(import.meta.dir, '..', '..');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 35, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] done',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SCENE5-GCP', name: 'ToolSearch',
          args: { query: 'route:GCP 확장안' }, after: { name: 'gcp_architect_expand', args: { ticketDesignPath: designPath } } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: screen => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'GCP first approval', text: 'SCENE5-GCP 티켓팅 설계 GCP 확장안',
          until: screen => screen.includes('플러그인 그래프 승인 · 요청 내용') && screen.includes('GCP 확장 설계 그래프를 실행할까요?') },
        { label: 'GCP N', keys: 'n', until: screen => screen.includes('턴 완료') },
        { label: 'GCP second approval', text: 'SCENE5-GCP 티켓팅 설계 GCP 확장안',
          until: screen => screen.includes('플러그인 그래프 승인 · 요청 내용') && screen.includes('GCP 확장 설계 그래프를 실행할까요?') },
        { label: 'GCP y', keys: 'y', until: screen => screen.includes('턴 완료') },
      ],
      ...(keptRoot ? { artifactPath: join(root, 'pty.json') } : {}),
    });
    const calls = readFileSync(join(root, 'next-graph-calls.test.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ graphId: 'gcp-architect-expand', verifiedOwner: 'member-next-demo',
      args: { ticketDesignPath: designPath }, result: { status: 'done', result: { realGcpCalls: 0 } } });
    expect(sessionToolResult(root, 'gcp_architect_expand')).toMatchObject({ status: 'done',
      result: { sourceDesignPath: designPath, realGcpCalls: 0 } });
    expect(run.exitCode).toBe(0);
    if (keptRoot) console.log(`next TUI scene 5 GCP approval PTY receipt: ${root}`);
  } finally {
    nexus.stop(true);
    if (!keptRoot) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
