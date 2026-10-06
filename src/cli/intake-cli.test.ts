import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { intakeToTasksMessages, registerIntakeCommands, renderIntakeToTasksResult, runIntakeDigestCli, runIntakeToTasksCli } from './intake-cli.js';

test('registers the complete intake command tree on a fresh Command with its help and options', () => {
  const program = new Command().name('elanous');
  registerIntakeCommands(program);

  const intake = program.commands.find((command) => command.name() === 'intake');
  expect(intake).toBeDefined();
  expect(intake!.description()).toBe('바깥 사실·문서를 elanous 현재와 대조하거나 태스크로 받는다');
  expect(intake!.helpInformation()).toContain('elanous intake');
  expect(intake!.commands.map((command) => command.name())).toEqual([
    'source', 'check', 'collect-pod', 'ingest', 'items', 'mark', 'digest', 'route',
    'grounding-sync', 'queue', 'to-tasks', 'collect-telegram-saved', 'collect-github',
  ]);

  const expected: Record<string, { help: string; options: string[] }> = {
    check: { help: '사실 목록·문서 경로·URL·표준입력을 elanous 현재와 대조한다. 구멍/낡음은 골 초안만 쓴다.', options: ['--file', '--url', '--fact', '--json', '--author', '--author-max'] },
    'collect-pod': { help: 'Pod 흡수 산출을 볼트에 안전하게 수집하고 흡수 원장에 표시한다', options: ['--id', '--vault', '--dry-run', '--json'] },
    ingest: { help: '수집기 산출(JSONL · 한 줄 = {url,title,text,kind,signals,…})을 흡수 원장에 모양 맞춰 넣는다 — 같은 항목은 합친다', options: ['--source', '--file', '--json'] },
    items: { help: '흡수 원장 항목 보기 (최근 본 순)', options: ['--status', '--source', '--seat', '--limit', '--json'] },
    source: { help: '자리별 흡수 원천과 주기 등록·조회·실행', options: [] },
    mark: { help: '흡수 원장 항목의 상태·산출을 갱신한다 (예: 흡수 뒤 absorbed ⊕ 노트 경로)', options: ['--status', '--output'] },
    digest: { help: '흡수 하루 다이제스트 — 그날 흡수한 것을 축별로 · 노트의 한 줄 결론 · 골 후보. 노트 절(마크다운) 또는 텔레그램 보고 채널로', options: ['--day', '--json', '--telegram', '--vault', '--note'] },
    route: { help: '흡수가 끝난 항목의 대조 결과(intake check --json)를 산출 큐로 나눈다 — 없음→goals · 문서뿐인 판단 필요→manual · 노트→grounding 후보', options: ['--check-json', '--dry-run', '--json'] },
    'grounding-sync': { help: '흡수 그라운딩 후보 큐의 노트를 등록 가능한 단일 문서 폴더로 복사한다 (레지스트리는 읽기만)', options: ['--dry-run', '--json'] },
    queue: { help: '자동 흡수 대기열 — 텔레그램 저장 링크를 별도 레인으로 먼저 고르고 일반 몫을 하루 상한까지 queued 로 옮긴다', options: ['--max', '--lane-max', '--kind', '--dry-run', '--json'] },
    'to-tasks': { help: '소비하지 않은 골 줄과 공개 아이디어 노트를 해석해 Nexus 태스크로 등록한다 (기본 최대 5건)', options: ['--limit', '--dry-run', '--json'] },
    'collect-telegram-saved': { help: '텔레그램 «저장된 메시지»를 읽기만 해 흡수 원장에 넣는다 (커서 이후만 · 호스트 전용 · 개인 메모는 user-private)', options: ['--max', '--dry-run', '--json'] },
    'collect-github': { help: '관심 주제의 GitHub 저장소를 별 순으로 모아 흡수 원장에 넣는다 (최근 생성·푸시만 · 별 스냅숏으로 증가량)', options: ['--days', '--per-query', '--dry-run', '--json'] },
  };
  for (const command of intake!.commands) {
    const contract = expected[command.name()]!;
    expect(command.description()).toBe(contract.help);
    expect(command.helpInformation().replace(/\s+/g, ' ')).toContain(contract.help);
    expect(command.options.map((option) => option.long)).toEqual(contract.options);
  }
  const check = intake!.commands.find((command) => command.name() === 'check')!;
  check.parseOptions(['--fact', 'first', '--fact', 'second']);
  expect(check.opts().fact).toEqual(['first', 'second']);
  expect(check.helpInformation()).toContain('--author-max <n>');
  expect(intake!.commands.find((command) => command.name() === 'to-tasks')!.helpInformation()).toContain('--limit <n>');
  expect(intake!.commands.find((command) => command.name() === 'to-tasks')!.helpInformation()).toContain('골 줄·아이디어 노트 상한');
});

test('to-tasks classify prompt receives only goal-line or note content, not ledger fields', () => {
  for (const content of ['Implement the fix', '# Idea note\nInspect the project and document the finding']) {
    const messages = intakeToTasksMessages(content);
    expect(messages[1]).toEqual({ role: 'user', content });
    expect(messages[0]!.content).toContain('"tasks"');
    expect(messages[0]!.content).toContain('"questions"');
    expect(messages[0]!.content).toContain('"acceptanceCriteria"');
    expect(messages[0]!.content).toContain('implement|research|document|operate');
    expect(JSON.stringify(messages)).not.toContain('"url":');
    expect(JSON.stringify(messages)).not.toContain('"signals":');
  }
});

test('to-tasks human output includes typed task results without changing counters and errors', () => {
  const result = {
    processed: 1, created: 2, skipped: 0, failed: 0,
    items: [
      { id: 'goal-1', status: 'created' as const, type: 'implement', taskId: 'task:one' },
      { id: 'goal-1', status: 'deduplicated' as const, type: 'research', taskId: 'task:two' },
      { id: 'note-1', status: 'skipped' as const, reason: 'invalid-llm-response' },
    ],
  };
  expect(renderIntakeToTasksResult(result, true)).toBe([
    '흡수 → 태스크: 처리 1 · 등록 2 · 건너뜀 0 · 실패 0 (dry-run)',
    'goal-1\tcreated\timplement\ttask:one',
    'goal-1\tdeduplicated\tresearch\ttask:two',
    'note-1\tskipped\tinvalid-llm-response',
  ].join('\n'));
});

test('to-tasks CLI uses the Nexus runtime port and bearer auth; dry-run leaves goal lines untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-to-tasks-cli-'));
  try {
    const goals = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(goals, { recursive: true });
    appendFileSync(join(goals, '2026-09-01.jsonl'), JSON.stringify({ fact: 'Research one', current: 'Missing', text: 'LEDGER SECRET', url: 'https://github.com/example/one' }) + '\n');
    const inputs: unknown[] = [];
    const posts: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), method: init!.method!, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
      return Response.json({ taskId: 'task:abcdef', deduplicated: false }, { status: 201 });
    };
    const deps = {
      root, runtime: () => ({ pid: 1, startedAt: '', nexusVersion: '1', phase: 'ready', httpPort: 31999 }),
      token: () => 'private-token', fetch: fetchFn as typeof fetch,
      llm: async (input: unknown) => { inputs.push(input); return JSON.stringify({ tasks: [{ type: 'research', title: 'Research one', description: 'Inspect project', priority: 'medium', acceptanceCriteria: ['Inspect source'] }], questions: [] }); },
    };
    const dry = await runIntakeToTasksCli({ dryRun: true }, deps);
    expect(dry.items).toMatchObject([{ status: 'dry-run', types: ['research'] }]);
    const id = dry.items[0]!.id;
    expect(inputs).toEqual([{ kind: 'goal-line', id, fact: 'Research one', current: 'Missing', url: 'https://github.com/example/one' }]);
    expect(JSON.stringify(inputs)).not.toContain('LEDGER SECRET');
    expect(posts).toHaveLength(0);
    const live = await runIntakeToTasksCli({}, deps);
    expect(live.created).toBe(1);
    expect(live.items).toEqual([{ id, status: 'created', taskId: 'task:abcdef', types: ['research'] }]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: 'http://127.0.0.1:31999/v1/tasks', method: 'POST', body: { title: 'Research one', type: 'research', acceptance: { criteria: ['Inspect source'] }, external: { provider: 'intake', ref: `${id}:0`, url: 'https://github.com/example/one' } } });
    expect(posts[0]!.headers.Authorization).toBe('Bearer private-token');
    expect(posts[0]!.headers['x-elanous-trace-id']).toBeTruthy();
    expect(JSON.stringify(live)).not.toContain('private-token');
    expect((await runIntakeToTasksCli({}, deps)).processed).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('to-tasks CLI retries HTTP failures and accepts Nexus deduplication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-to-tasks-retry-'));
  try {
    const goals = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(goals, { recursive: true });
    appendFileSync(join(goals, '2026-09-01.jsonl'), JSON.stringify({ fact: 'Research retry', current: 'Missing' }) + '\n');
    let fail = true;
    const deps = {
      root, runtime: () => ({ pid: 1, startedAt: '', nexusVersion: '1', phase: 'ready', httpPort: 31999 }),
      token: () => undefined,
      fetch: (async () => fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ taskId: 'task:existing', deduplicated: true })) as unknown as typeof fetch,
      llm: async () => JSON.stringify({ tasks: [{ type: 'research', title: 'Research retry', description: 'Inspect', priority: 'low', acceptanceCriteria: ['Inspect source'] }], questions: [] }),
    };
    const failed = await runIntakeToTasksCli({}, deps);
    expect(failed.items).toMatchObject([{ status: 'failed', reason: 'intake-to-tasks request failed' }]);
    const id = failed.items[0]!.id;
    fail = false;
    const deduplicated = await runIntakeToTasksCli({}, deps);
    expect(deduplicated).toEqual({
      processed: 1, created: 0, skipped: 0, failed: 0,
      items: [{ id, status: 'deduplicated', taskId: 'task:existing', types: ['research'] }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('to-tasks CLI refuses an unavailable Nexus without consuming the goal line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-to-tasks-no-nexus-'));
  try {
    const goals = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(goals, { recursive: true });
    appendFileSync(join(goals, '2026-09-01.jsonl'), JSON.stringify({ fact: 'Research two', current: 'Missing' }) + '\n');
    const result = await runIntakeToTasksCli({}, {
      root, runtime: () => null, fetch: (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
      llm: async () => JSON.stringify({ tasks: [{ type: 'research', title: 'Research two', description: 'Inspect', priority: 'low', acceptanceCriteria: ['Inspect source'] }], questions: [] }),
    });
    expect(result.items).toMatchObject([{ status: 'failed', reason: 'intake-to-tasks request failed' }]);
    expect(result.items[0]!.id).toStartWith('goal:');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('intake digest --telegram sends news-only shadow suggestions without promoting them to goals', async () => {
  const order: string[] = [];
  const sent = await runIntakeDigestCli({ telegram: true, day: '2026-10-06' }, {
    root: '/tmp/intake-digest-news-unused', annotateLens: async () => { order.push('lens'); },
    buildDigest: () => { order.push('digest'); return {
      day: '2026-10-06', absorbed: [], goals: [], grounding: 0, release: 0, manual: 0,
      news: [{ title: 'RRSI', url: 'https://www.aitimes.com/news/articleView.html?idxno=215802', summary: ['구글 RRSI'], implication: ['RRSI → 없음'] }],
      shadowSuggestions: [{ fact: 'RRSI 관련 하니스', verdict: '없음' }],
    }; },
    sendTelegram: async (message) => { order.push('telegram'); expect(message).toContain('뉴스 칸 제안 1건 (그림자·판 미등록)'); return true; },
  });
  expect(order).toEqual(['lens', 'digest', 'telegram']);
  expect(sent).toEqual({ sent: true });
});

test('intake digest --telegram annotates the lens before building the digest, and a lens failure still sends', async () => {
  const order: string[] = [];
  const sent = await runIntakeDigestCli({ telegram: true, day: '2026-10-05' }, {
    root: '/tmp/intake-digest-lens-unused',
    annotateLens: async () => { order.push('lens'); throw new Error('lens down'); },
    buildDigest: () => { order.push('digest'); return { day: '2026-10-05', absorbed: [{ id: 'a', sources: [], axis: '그 밖' }], goals: [], grounding: 0, release: 0, manual: 0 }; },
    sendTelegram: async () => { order.push('telegram'); return true; },
  });
  expect(order).toEqual(['lens', 'digest', 'telegram']);
  expect(sent).toEqual({ sent: true });
});
