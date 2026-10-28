import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { intakeToTasksMessages, registerIntakeCommands, renderIntakeToTasksResult, runIntakeCandidatesCli, runIntakeDigestCli, runIntakeToTasksCli } from './intake-cli.js';
/** Local copy of the directive row shape — `src/directives/directive-index` is excluded from the public export. */
interface DirectiveRow {
  ts: string; agent: string; session_id: string; cwd: string | null;
  track: string | null; released: string | null; dev: string | null;
  codename: string | null; text: string; source_file: string; line_no: number;
}
import type { IntakeItem } from '../intake-plane/items.js';
import type { TaskCard } from '../task-cards/card-store.js';
import { ingestIntakeItems, markIntakeItem, listIntakeItems } from '../intake-plane/items.js';
import { buildIntakeDigest } from '../intake-plane/digest.js';
import { addSource } from '../intake-plane/intake-sources.js';
import { debug } from '../debug/log.js';
import { readSavedCursor, type SavedMessage } from '../intake-plane/collect-telegram-saved.js';
import { CHANNEL_PUBLISH_CROWN_OWNER, ChannelPublishQueue } from '../intake-plane/intake-to-tasks.js';

test('registers the complete intake command tree on a fresh Command with its help and options', () => {
  const program = new Command().name('elanous');
  registerIntakeCommands(program);

  const intake = program.commands.find((command) => command.name() === 'intake');
  expect(intake).toBeDefined();
  expect(intake!.description()).toBe('바깥 사실·문서를 elanous 현재와 대조하거나 태스크로 받는다');
  expect(intake!.helpInformation()).toContain('elanous intake');
  expect(intake!.commands.map((command) => command.name())).toEqual([
    'source', 'check', 'candidates', 'collect-pod', 'ingest', 'items', 'mark', 'digest', 'route',
    'grounding-sync', 'queue', 'to-tasks', 'approve-channel-post', 'collect-telegram-saved', 'collect-github',
  ]);

  const expected: Record<string, { help: string; options: string[] }> = {
    check: { help: '사실 목록·문서 경로·URL·표준입력을 elanous 현재와 대조한다. 구멍/낡음은 골 초안만 쓴다.', options: ['--file', '--url', '--fact', '--json', '--author', '--author-max'] },
    candidates: { help: '지시·흡수·소원에서 읽기 전용 요구 후보를 모은다', options: ['--json', '--limit'] },
    'collect-pod': { help: 'Pod 흡수 산출을 볼트에 안전하게 수집하고 흡수 원장에 표시한다', options: ['--id', '--vault', '--dry-run', '--json'] },
    ingest: { help: '수집기 산출(JSONL · 한 줄 = {url,title,text,kind,signals,…})을 흡수 원장에 모양 맞춰 넣는다 — 같은 항목은 합친다', options: ['--source', '--file', '--json'] },
    items: { help: '흡수 원장 항목 보기 (최근 본 순)', options: ['--status', '--source', '--seat', '--limit', '--json'] },
    source: { help: '자리별 흡수 원천과 주기 등록·조회·실행', options: [] },
    mark: { help: '흡수 원장 항목의 상태·산출을 갱신한다 (예: 흡수 뒤 absorbed ⊕ 노트 경로)', options: ['--status', '--output'] },
    digest: { help: '흡수 하루 다이제스트 — 그날 흡수한 것을 축별로 · 노트의 한 줄 결론 · 골 후보. 노트 절(마크다운) 또는 텔레그램 보고 채널로', options: ['--day', '--json', '--telegram', '--seat', '--vault', '--note'] },
    route: { help: '흡수가 끝난 항목의 대조 결과(intake check --json)를 산출 큐로 나눈다 — 없음→goals · 문서뿐인 판단 필요→manual · 노트→grounding 후보', options: ['--check-json', '--dry-run', '--json'] },
    'grounding-sync': { help: '흡수 그라운딩 후보 큐의 노트를 등록 가능한 단일 문서 폴더로 복사한다 (레지스트리는 읽기만)', options: ['--dry-run', '--json'] },
    queue: { help: '자동 흡수 대기열 — 텔레그램 저장 링크를 별도 레인으로 먼저 고르고 일반 몫을 하루 상한까지 queued 로 옮긴다', options: ['--max', '--lane-max', '--kind', '--dry-run', '--json'] },
    'to-tasks': { help: '소비하지 않은 골 줄과 공개 아이디어 노트를 해석해 Nexus 태스크로 등록한다 (기본 최대 5건)', options: ['--limit', '--dry-run', '--json'] },
    'approve-channel-post': { help: '보호 범주의 채널 게시 초안을 사람 승인한다 (외부 게시 커넥터는 호출하지 않는다)', options: ['--by', '--json'] },
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

test('intake candidates --json reads three injected sources, limits only after sorting and leaves them unchanged', async () => {
  const input: { directives: DirectiveRow[]; intakeItems: IntakeItem[]; cards: TaskCard[] } = {
    directives: [{ ts: '', agent: 'claude-code', session_id: 's1', cwd: null, track: null, released: null, dev: null, codename: null,
      text: '요구 깔때기 만들어 루브릭: A3 E2 R2 D1 M1 B1 S1 X0', source_file: '', line_no: 7 }],
    intakeItems: [{ id: 'ix1', title: 'repo X', text: '루브릭 없음', source: 'github', sources: ['github'], kind: 'repo',
      observedAt: '', lastSeenAt: '', signals: {}, privacy: 'public', status: 'new', outputs: [] },
      { id: 'ix2', source: 'github', sources: ['github'], kind: 'repo', observedAt: '', lastSeenAt: '', signals: {}, privacy: 'public', status: 'discarded', outputs: [] }],
    cards: [{ id: 'c1', goalId: 'wish:linear:ENG-12', title: '소원 하나', status: 'open', createdAt: '', sections: [] },
      { id: 'c2', goalId: 'goal:x', title: '다른 카드', status: 'open', createdAt: '', sections: [] },
      { id: 'c3', goalId: 'wish:pwa:9', title: '닫힌 카드', status: 'closed', createdAt: '', sections: [] }],
  };
  const before = structuredClone(input);
  const calls: string[] = [];
  const output: string[] = [];
  const deps = {
    directives: () => { calls.push('directives'); return input.directives; },
    intakeItems: () => { calls.push('intake'); return input.intakeItems; },
    cards: () => { calls.push('cards'); return input.cards; },
    write: async (text: string) => { output.push(text); },
  };
  const program = new Command().name('elanous').exitOverride();
  registerIntakeCommands(program, deps);
  await program.parseAsync(['intake', 'candidates', '--json'], { from: 'user' });
  const parsed = JSON.parse(output.pop()!) as { candidates: Array<{ id: string }> };
  expect(parsed.candidates).toHaveLength(3);
  expect(parsed.candidates[0]!.id).toBe('s1:7');
  expect(calls).toEqual(['directives', 'intake', 'cards']);
  await program.parseAsync(['intake', 'candidates', '--json', '--limit', '1'], { from: 'user' });
  expect(JSON.parse(output.pop()!).candidates).toHaveLength(1);
  expect(input).toEqual(before);
  expect(runIntakeCandidatesCli({ limit: '-1' }, deps)).rejects.toThrow('--limit');
});

test('intake candidates --limit validates the raw string: blank, negative and fractional are rejected, 2 is accepted', async () => {
  const deps = {
    directives: () => [1, 2, 3].map((line_no) => ({ ts: '', session_id: 's1', track: null, text: `요구 ${line_no}`, source_file: '', line_no })),
    intakeItems: () => [],
    cards: () => [],
  };
  for (const raw of ['', '  ', '-1', '1.5']) {
    const output: string[] = [];
    await expect(runIntakeCandidatesCli({ json: true, limit: raw }, { ...deps, write: async (text) => { output.push(text); } }))
      .rejects.toThrow('--limit 는 0 이상의 정수여야 한다');
    expect(output).toEqual([]);

    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((message?: unknown) => { errors.push(String(message)); });
    const previousExitCode = process.exitCode;
    try {
      const cliOutput: string[] = [];
      const program = new Command().name('elanous').exitOverride();
      registerIntakeCommands(program, { ...deps, write: async (text) => { cliOutput.push(text); } });
      await program.parseAsync(['intake', 'candidates', '--json', '--limit', raw], { from: 'user' });
      expect(process.exitCode).toBe(2);
      expect(cliOutput).toEqual([]);
      expect(errors).toEqual([`--limit 는 0 이상의 정수여야 한다: ${JSON.stringify(raw)}`]);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode ?? 0; // Bun 은 undefined 대입으로 값을 지우지 않는다
    }
  }

  const output: string[] = [];
  await runIntakeCandidatesCli({ json: true, limit: '2' }, { ...deps, write: async (text) => { output.push(text); } });
  expect(JSON.parse(output.pop()!).candidates).toHaveLength(2);
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

test('intake approve-channel-post records explicit approval without publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-channel-approve-cli-'));
  const previousExitCode = process.exitCode;
  try {
    const queue = new ChannelPublishQueue(root);
    const id = 'goal:first-release';
    queue.enqueue(id, {
      channel: 'telegram', cadence: 'one-off', voice: 'release', owner: 'MK',
      category: 'first-release', title: '0.2.40', body: 'Release notes',
    });
    const program = new Command().name('elanous');
    registerIntakeCommands(program, { root });
    await program.parseAsync(['intake', 'approve-channel-post', id, '--by', 'MK', '--json'], { from: 'user' });
    expect(queue.plan(id)).toMatchObject({ status: 'approved', approvedBy: 'MK', category: 'first-release' });
    expect(queue.publishedIds().size).toBe(0);

    const crownId = 'goal:patent';
    queue.enqueue(crownId, {
      channel: 'linkedin', cadence: 'one-off', voice: 'formal', owner: CHANNEL_PUBLISH_CROWN_OWNER,
      category: 'patent', title: 'Patent review', body: 'Needs review',
    });
    const rejected = new Command().name('elanous');
    registerIntakeCommands(rejected, { root });
    await rejected.parseAsync(['intake', 'approve-channel-post', crownId, '--by', 'OP'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(queue.plan(crownId)).toMatchObject({ status: 'queued' });
  } finally {
    process.exitCode = previousExitCode ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
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

test('intake digest --seat user sends only two user notes and sends an empty arrival receipt through the same channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-brief-'));
  const day = '2026-10-05';
  const now = '2026-10-04T16:00:00Z';
  try {
    addSource({ id: 'watch-topic', kind: 'github-query', seat: 'user', spec: 'agent', every: '1d' }, root);
    for (const [seat, title] of [['user', 'one'], ['MK', 'other'], ['user', 'two']]) {
      ingestIntakeItems(root, 'github', [{ seat, url: `https://example.com/${title}`, title, kind: 'repo' }], now);
      const id = listIntakeItems(root).find(item => item.title === title)!.id;
      expect(markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: `/notes/${title}.md` } }, now)).toBe(true);
    }
    const unfiltered = buildIntakeDigest(root, day);
    expect(unfiltered.absorbed).toHaveLength(3);
    const messages: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const sent = await runIntakeDigestCli({ seat: 'user', telegram: true, day }, {
        root, annotateLens: async () => {}, sendTelegram: async text => { messages.push(text); return true; },
      });
      expect(sent).toEqual({ sent: true });
      expect(buildIntakeDigest(root, day, undefined, undefined, 'user').absorbed.map(e => e.noteName)).toEqual(['one', 'two']);
      expect(messages[0].split('\n')[0]).toBe('흡수 2편 → 우리에게 닿는 것 0');
      expect(messages[0]).toContain('참고 2편 — 노트: [[one]], [[two]]');
      expect(messages[0]).not.toContain('other');
      expect(log).toHaveBeenCalledWith('watch.default', 'brief', { topics: 1, items: 2, sent: true });
      await runIntakeDigestCli({ seat: 'user', telegram: true, day: '2026-10-06' }, {
        root, annotateLens: async () => {}, sendTelegram: async text => { messages.push(text); return true; },
      });
      expect(messages[1]).toBe('흡수 0편 → 우리에게 닿는 것 0');
      expect(log).toHaveBeenCalledWith('watch.default', 'brief', { topics: 1, items: 0, sent: true });
    } finally { log.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a seat briefing does not resend yesterday\'s items when the same search result is collected again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-rebrief-'));
  try {
    const raw = [{ seat: 'user', url: 'https://example.com/repo', title: 'repo', kind: 'repo' as const }];
    ingestIntakeItems(root, 'github', raw, '2026-10-04T23:00:00Z');
    const messages: string[] = [];
    const deps = { root, annotateLens: async () => {}, sendTelegram: async (text: string) => { messages.push(text); return true; } };
    await runIntakeDigestCli({ seat: 'user', telegram: true, day: '2026-10-05' }, deps);
    expect(messages[0]).toContain('repo');
    await runIntakeDigestCli({ seat: 'user', telegram: true, day: '2026-10-05' }, deps);
    expect(messages[1]).toContain('repo');
    ingestIntakeItems(root, 'github', raw, '2026-10-05T23:00:00Z');
    ingestIntakeItems(root, 'github', [{ seat: 'user', url: 'https://example.com/fresh', title: 'fresh', kind: 'repo' }], '2026-10-05T23:00:00Z');
    await runIntakeDigestCli({ seat: 'user', telegram: true, day: '2026-10-06' }, deps);
    expect(messages[2]).toContain('fresh');
    expect(messages[2]).not.toContain('example.com/repo');
    ingestIntakeItems(root, 'github', raw, '2026-10-06T23:00:00Z');
    // 미전송 경로는 process.exitCode = 3 을 남긴다 — 되돌리지 않으면 bun test 전체가 3으로 끝나 게이트가 «덜 끝난 조각»으로 읽는다.
    const previousExitCode = process.exitCode;
    try {
      await runIntakeDigestCli({ seat: 'user', telegram: true, day: '2026-10-07' }, { ...deps, sendTelegram: async (text: string) => { messages.push(text); return false; } });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previousExitCode ?? 0; // Bun 은 undefined 대입으로 값을 지우지 않는다
    }
    expect(messages[3]).toBe('흡수 0편 → 우리에게 닿는 것 0');
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

// ── TG-SAVED-ZERO ── 사흘 0 을 «필터로 버려서» 인지 «다른 주체가 이미 가져가서» 인지 갈라 읽는다.
// 무대: 실제 커맨드 트리(registerIntakeCommands) + program.parseAsync · 가짜 저장 메시지 fetch · 격리 임시 root.
const savedMsg = (id: number, text: string, urls: string[] = []): SavedMessage => ({ id, date: '2026-10-24T00:00:00.000Z', text, urls });

function savedTelegramRoot(prefix: string, lastId: number): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'intake'), { recursive: true });
  writeFileSync(join(root, 'intake', 'telegram-saved.cursor.json'), JSON.stringify({ lastId, at: '2026-10-21T00:00:00.000Z' }) + '\n');
  return root;
}

test('intake collect-telegram-saved reports connection failures through the registered CLI dependency', async () => {
  const errors: string[] = [];
  const previousExitCode = process.exitCode;
  const program = new Command().name('elanous').exitOverride();
  registerIntakeCommands(program, {
    connectSaved: async () => { throw new Error('mock saved connection unavailable'); },
    error: (message) => { errors.push(message); },
  });
  try {
    await program.parseAsync(['intake', 'collect-telegram-saved'], { from: 'user' });
    expect(errors).toEqual(['mock saved connection unavailable']);
    expect(process.exitCode).toBe(2);
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
});

test('intake collect-telegram-saved human output separates «메시지 0» from «원장 입력 0»: filter vs another consumer', async () => {
  const root = savedTelegramRoot('intake-tg-saved-cli-', 8959);
  try {
    let all: SavedMessage[] = [];
    let closes = 0;
    const output: string[] = [];
    const program = new Command().name('elanous').exitOverride();
    registerIntakeCommands(program, {
      root,
      connectSaved: async () => ({
        fetch: async (minId: number, limit: number) => all.filter((m) => m.id > minId).slice(0, limit),
        close: async () => { closes++; },
      }),
      write: async (text: string) => { output.push(text); },
    });

    // ① 메시지는 왔지만 전부 빈 몸통 — 원장 입력 0 은 «필터» 때문이다.
    all = [savedMsg(9060, '   '), savedMsg(9070, ''), savedMsg(9092, '')];
    await program.parseAsync(['intake', 'collect-telegram-saved'], { from: 'user' });
    const filtered = output.pop()!;
    expect(filtered).toContain('읽음 3');
    expect(filtered).toContain('필터로 버림 3');
    expect(filtered).toContain('원장 입력 0');
    expect(filtered).toContain('커서 8959 → 9092');
    expect(filtered).toContain('필터 때문이다');
    expect(filtered).not.toContain('다른 주체');
    // 커서는 원장 입력 0 과 «독립»으로 전진한다(사흘 0 의 관측 사실 그대로).
    expect(readSavedCursor(root)).toBe(9092);
    expect(listIntakeItems(root)).toHaveLength(0);

    // ② 원장 입력은 있지만 «새 것 0» — 같은 항목을 다른 주체(-queue)가 이미 가져갔다.
    ingestIntakeItems(root, 'telegram-saved', [{ url: 'https://example.com/consumed', observedAt: '2026-10-22T00:00:00.000Z' }]);
    const consumedId = listIntakeItems(root).find((item) => item.url === 'https://example.com/consumed')!.id;
    expect(markIntakeItem(root, consumedId, { status: 'absorbed', output: { kind: 'note', ref: '/notes/consumed.md' } })).toBe(true);
    all = [savedMsg(9093, '볼 것 https://example.com/consumed')];
    await program.parseAsync(['intake', 'collect-telegram-saved'], { from: 'user' });
    const consumed = output.pop()!;
    expect(consumed).toContain('읽음 1');
    expect(consumed).toContain('원장 입력 1');
    expect(consumed).toContain('이미 끝난 것 1');
    expect(consumed).toContain('새 0');
    expect(consumed).toContain('다른 주체');
    expect(consumed).not.toContain('필터 때문이다');
    expect(readSavedCursor(root)).toBe(9093);
    expect(closes).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('intake collect-telegram-saved recovers the cursor-boundary message and every missed saved message through the registered CLI', async () => {
  const root = savedTelegramRoot('intake-tg-saved-recovery-', 9092);
  try {
    const messages = [
      savedMsg(8960, '앞쪽 누락 https://example.com/first'),
      savedMsg(9050, '가운데 누락 https://example.com/middle'),
      savedMsg(9092, '커서 경계 https://example.com/boundary'),
      savedMsg(9100, '새 메시지 https://example.com/newer'),
    ];
    const output: string[] = [];
    const requested: number[] = [];
    const program = new Command().name('elanous').exitOverride();
    registerIntakeCommands(program, {
      root,
      connectSaved: async () => ({
        fetch: async (minId: number, limit: number) => {
          requested.push(minId);
          return messages.filter((message) => message.id > minId).slice(0, limit);
        },
        close: async () => {},
      }),
      write: async (text: string) => { output.push(text); },
    });
    await program.parseAsync(['intake', 'collect-telegram-saved', '--json'], { from: 'user' });
    expect(JSON.parse(output.pop()!)).toMatchObject({ cursorBefore: 9092, cursorAfter: 9100, messages: 4, raws: 4, ingest: { added: 4 } });
    expect(requested).toEqual([9092, 8791]);
    expect(listIntakeItems(root)).toHaveLength(4);
    expect(listIntakeItems(root).map((item) => item.url)).toEqual([
      'https://example.com/first', 'https://example.com/middle', 'https://example.com/boundary', 'https://example.com/newer',
    ]);
    expect(listIntakeItems(root).every((item) => item.source === 'telegram-saved' && item.privacy === 'user-private')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('intake collect-telegram-saved --json reports fetched / dropped / ingest apart and the representative\'s saved message lands on the next collect', async () => {
  const root = savedTelegramRoot('intake-tg-saved-json-', 8959);
  try {
    let all: SavedMessage[] = [];
    const output: string[] = [];
    const program = new Command().name('elanous').exitOverride();
    registerIntakeCommands(program, {
      root,
      connectSaved: async () => ({
        fetch: async (minId: number, limit: number) => all.filter((m) => m.id > minId).slice(0, limit),
        close: async () => {},
      }),
      write: async (text: string) => { output.push(text); },
    });
    const collect = async (extra: string[] = []) => {
      await program.parseAsync(['intake', 'collect-telegram-saved', '--json', ...extra], { from: 'user' });
      return JSON.parse(output.pop()!) as {
        cursorBefore: number; cursorAfter: number; messages: number; droppedByFilter: number; raws: number;
        dryRun: boolean; ingest?: { shaped: number; added: number; merged: number; seen: number; skipped: number };
      };
    };

    // 첫 흡수는 빈 메시지만 받아 커서를 9092로 옮기지만 원장에는 넣지 않는다.
    all = [savedMsg(9060, ''), savedMsg(9092, '')];
    const filtered = await collect();
    expect(filtered).toMatchObject({ cursorBefore: 8959, cursorAfter: 9092, messages: 2, droppedByFilter: 2, raws: 0, dryRun: false });
    expect(filtered.ingest).toMatchObject({ added: 0, seen: 0 });
    expect(listIntakeItems(root)).toHaveLength(0);

    // 대표가 그 뒤 저장한 1건이 다음 CLI 수집에서 원장에 실제 유입된다(판정선).
    all.push(savedMsg(9093, '판정선 https://example.com/judged'));
    const judged = await collect();
    expect(judged).toMatchObject({ cursorBefore: 9092, cursorAfter: 9093, messages: 1, droppedByFilter: 0, raws: 1 });
    expect(judged.ingest).toMatchObject({ shaped: 1, added: 1, merged: 0, seen: 0, skipped: 0 });
    const landed = listIntakeItems(root);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ url: 'https://example.com/judged', source: 'telegram-saved', privacy: 'user-private', status: 'new', text: '판정선' });
    expect(readFileSync(join(root, 'intake', 'items.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);

    // 같은 판을 다시 돌리면 새 메시지 0 — 이미 들어간 것을 되풀이해 넣지 않는다.
    const again = await collect();
    expect(again).toMatchObject({ cursorBefore: 9093, cursorAfter: 9093, messages: 0, raws: 0 });

    // dry-run 은 원장·커서를 바꾸지 않고, 그래도 «들어갈 것» 을 센다.
    all = [savedMsg(9094, 'https://example.com/dry')];
    const dry = await collect(['--dry-run']);
    expect(dry).toMatchObject({ cursorBefore: 9093, cursorAfter: 9094, messages: 1, raws: 1, dryRun: true });
    expect(dry.ingest).toBeUndefined();
    expect(readSavedCursor(root)).toBe(9093);
    expect(listIntakeItems(root)).toHaveLength(1);

    // --max 상한은 fetch 에 그대로 전달된다.
    all = [savedMsg(9095, 'https://example.com/a'), savedMsg(9096, 'https://example.com/b')];
    const limited = await collect(['--max', '1']);
    expect(limited).toMatchObject({ messages: 1, cursorBefore: 9093, cursorAfter: 9095 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
