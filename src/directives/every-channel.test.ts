import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { defaultCodexRoots, scanDirectiveSources } from './sources.js';
import { DirectiveIndex, dedupeUtterances, type DirectiveRow } from './directive-index.js';

const write = (path: string, rows: unknown[]) => writeFileSync(path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
function roots(root: string) {
  return { claudeRoot: join(root, 'no-claude'), codexRoots: [] as string[], grokRoot: join(root, 'no-grok'), surfaceDb: join(root, 'no-surface.db'), sessionRoots: [] as string[] };
}

test('codex 0.17x: user-provenance response items are the typed turns; harness and exec turns are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'utter-codex-'));
  const home = join(root, '.codex-third-owner', 'sessions', '2026', '11', '25');
  mkdirSync(home, { recursive: true });
  const typed = (text: string, ts: string, provenance: Array<{ provenance: Record<string, unknown> }> = [{ provenance: { type: 'user' } }]) => ({ timestamp: ts, type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: 't', content_item_metadata: provenance } } });
  write(join(home, 'rollout-2026-11-25T06-00-00-seat.jsonl'), [
    { timestamp: '2026-11-24T21:00:00.000Z', type: 'session_meta', payload: { id: 'seat-1', cwd: '/Users/x/elanous-hq/seats/TC', originator: 'codex-tui', source: 'cli' } },
    typed('<environment_context><cwd>/x</cwd></environment_context>', '2026-11-24T21:00:01.000Z', [{ provenance: { type: 'agents_md' } }, { provenance: { type: 'harness', hook: false } }]),
    typed('코덱스 탭에 직접 친 말', '2026-11-24T21:00:02.000Z'),
    { timestamp: '2026-11-24T21:00:03.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '코덱스 탭에 직접 친 말' }] } } },
    typed('하니스가 넣은 말', '2026-11-24T21:00:04.000Z', [{ provenance: { type: 'harness', hook: false } }]),
  ]);
  write(join(home, 'rollout-2026-11-25T06-01-00-exec.jsonl'), [
    { timestamp: '2026-11-24T21:01:00.000Z', type: 'session_meta', payload: { id: 'exec-1', cwd: '/Users/x/elanous-hq/seats/TC', originator: 'codex_exec', source: 'exec' } },
    typed('exec 로 돌린 자동 프롬프트', '2026-11-24T21:01:01.000Z'),
  ]);
  const scan = scanDirectiveSources({ ...roots(root), codexRoots: [join(root, '.codex-third-owner', 'sessions')] });
  expect(scan.files.flatMap(f => f.turns).filter(t => t.role === 'user').map(t => [t.agent, t.text, t.ts])).toEqual([
    ['codex', '코덱스 탭에 직접 친 말', '2026-11-24T21:00:02.000Z'],
  ]);
  expect(Object.values(scan.perSource.codex)).toEqual([2, 1]);
});

test('every CODEX_HOME under home is a codex source', () => {
  const home = mkdtempSync(join(tmpdir(), 'utter-home-'));
  for (const dir of ['.codex/sessions', '.codex-team-owner/sessions', '.codex-third-owner/sessions', '.codex-empty', '.config']) mkdirSync(join(home, dir), { recursive: true });
  expect(defaultCodexRoots(home, {})).toEqual([
    join(home, '.codex-team-owner', 'sessions'), join(home, '.codex-third-owner', 'sessions'), join(home, '.codex', 'sessions'),
  ]);
});

test('eln sessions: only turns whose author is a person; telegram and pwa keep their channel; harness sessions skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'utter-eln-'));
  const store = join(root, 'sessions'); mkdirSync(store);
  writeFileSync(join(store, 'index.json'), JSON.stringify([
    { id: 'op-tui', source: 'tui', sourceKind: 'keyboard' },
    { id: 'tg-dm', source: 'telegram', sourceKind: 'telegram' },
    { id: 'pwa-chat', source: 'pwa', origin: 'pwa', sourceKind: 'keyboard' },
    { id: 'harness-child', source: 'cli', origin: 'harness' },
  ]));
  write(join(store, 'op-tui.jsonl'), [
    { role: 'user', content: '[notice · seat-mail · 1 msg · from TC · #1]  [from TC · info] 우편', ts: '2026-11-24T21:30:00.000Z' },
    { role: 'user', content: '목표 계속', ts: '2026-11-24T21:31:00.000Z', from: { kind: 'system', origin: 'goal-continue' } },
    { role: 'user', content: '정해진 시각 점검', ts: '2026-11-24T21:32:00.000Z', from: { kind: 'system', origin: 'scheduled' } },
    { role: 'user', content: '자리 우편', ts: '2026-11-24T21:33:00.000Z', from: { kind: 'agent', seat: 'TC' } },
    { role: 'user', content: '3.36 버전 로스터 정해주세요', ts: '2026-11-24T21:34:06.471Z', from: { kind: 'human' } },
    { role: 'user', content: '중단 표시', ts: '2026-11-24T21:34:30.000Z', from: { kind: 'human' }, interruptionMarker: true },
    { role: 'assistant', content: '네', ts: '2026-11-24T21:35:00.000Z' },
    { role: 'tool', content: 'MsgList', ts: '2026-11-24T21:35:01.000Z', toolName: 'MsgList' },
    { role: 'user', content: '턴 중에 덧붙인 말', ts: '2026-11-24T21:36:00.000Z', from: { kind: 'human' }, steerJoined: true },
  ]);
  write(join(store, 'tg-dm.jsonl'), [
    { role: 'user', content: '텔레그램에서 보낸 말', ts: '2026-11-14T06:21:12.979Z' },
    { role: 'user', content: '예약 알림', ts: '2026-11-14T06:22:00.000Z', from: { kind: 'system', origin: 'scheduled' } },
  ]);
  write(join(store, 'pwa-chat.jsonl'), [{ role: 'user', content: '간단한 카운터 웹앱 하나 만들어줘', ts: '2026-11-18T07:52:37.893Z' }]);
  write(join(store, 'harness-child.jsonl'), [{ role: 'user', content: '하니스 자식 지시', ts: '2026-11-18T07:00:00.000Z', from: { kind: 'human' } }]);
  write(join(store, 'unindexed.jsonl'), [{ role: 'user', content: '색인 밖 세션의 사람 말', ts: '2026-11-18T08:00:00.000Z', from: { kind: 'human' } }]);
  const scan = scanDirectiveSources({ ...roots(root), sessionRoots: [store] });
  const said = scan.files.flatMap(f => f.turns).map(t => [t.agent, t.sessionId, t.text]).sort((a, b) => a.join().localeCompare(b.join()));
  expect(said).toEqual([
    ['elanous', 'op-tui', '3.36 버전 로스터 정해주세요'],
    ['elanous', 'op-tui', '턴 중에 덧붙인 말'],
    ['elanous', 'unindexed', '색인 밖 세션의 사람 말'],
    ['pwa', 'pwa-chat', '간단한 카운터 웹앱 하나 만들어줘'],
    ['telegram', 'tg-dm', '텔레그램에서 보낸 말'],
  ]);
  expect(scan.perSource.elanous.files).toBe(2);
  expect(Object.values(scan.perSource.telegram)).toEqual([1, 1]);
  expect(scan.missingSources).not.toContain('elanous');
});

test('index: eln sessions sync incrementally; codex positions from the old parser are reread once', () => {
  const root = mkdtempSync(join(tmpdir(), 'utter-index-'));
  const store = join(root, 'sessions'); mkdirSync(store);
  writeFileSync(join(store, 'index.json'), JSON.stringify([{ id: 's1', source: 'tui' }]));
  const session = join(store, 's1.jsonl');
  write(session, [{ role: 'user', content: '첫 발화', ts: '2026-11-25T00:00:00.000Z', from: { kind: 'human' } }]);
  const codexRoot = join(root, 'codex'); mkdirSync(codexRoot);
  const rollout = join(codexRoot, 'rollout-a.jsonl');
  write(rollout, [
    { timestamp: '2026-11-25T00:00:00.000Z', type: 'session_meta', payload: { id: 'c1', cwd: '/w/elanous-hq/seats/UX', originator: 'codex-tui', source: 'cli' } },
    { timestamp: '2026-11-25T00:10:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '코덱스 발화' }],
      internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: 'user' } }] } } },
  ]);
  const opts = { ...roots(root), codexRoots: [codexRoot], sessionRoots: [store], stateDir: join(root, 'state'), repoRoot: join(root, 'absent'), codenames: {}, sessionLabels: {} };
  const index = new DirectiveIndex(opts);
  try {
    // Simulate a position the old parser left at EOF with nothing indexed.
    index.db.run("INSERT INTO positions(source_file, offset, context, size, mtime_ms) VALUES (?, 9999, '{}', 1, 1)", [rollout]);
    expect(index.sync().added).toBe(2);
    expect(index.search('', { agent: 'codex' }).map(r => r.text)).toEqual(['코덱스 발화']);
    appendFileSync(session, JSON.stringify({ role: 'user', content: '두 번째 발화', ts: '2026-11-25T00:20:00.000Z', from: { kind: 'human' } }) + '\n');
    const second = index.sync();
    expect(second.added).toBe(1);
    expect(second.timings.parse.openedFiles).toBe(1);
    expect(index.sync().timings.parse.openedFiles).toBe(0);
    expect(index.utterances({ agent: 'elanous,codex' }).map(r => r.text)).toEqual(['첫 발화', '코덱스 발화', '두 번째 발화']);
  } finally { index.close(); }
});

test('dedupe: one utterance relayed through several channels within two minutes keeps every channel', () => {
  const row = (agent: DirectiveRow['agent'], session: string, ts: string, text: string): DirectiveRow => ({ ts, agent, session_id: session, cwd: null, track: null,
    released: null, dev: null, codename: null, text, source_file: `${agent}.jsonl`, line_no: 1 });
  const merged = dedupeUtterances([
    row('codex', 'c', '2026-11-25T00:00:50.000Z', 'OP 전달: 3.36 버전 로스터 정해주세요   추가 20개'),
    row('claude-code', 'a', '2026-11-25T00:00:00.000Z', '3.36 버전 로스터 정해주세요 추가 20개'),
    row('elanous', 'e', '2026-11-25T00:01:00.000Z', '3.36 버전 로스터 정해주세요 추가 20개'),
    row('telegram', 't', '2026-11-25T00:03:30.000Z', '3.36 버전 로스터 정해주세요 추가 20개'),
    row('elanous', 'e', '2026-11-25T00:01:10.000Z', '3.36 버전 로스터 정해주세요 추가 20개'),
    row('elanous', 'x', '2026-11-25T00:00:20.000Z', '네'),
    row('pwa', 'p', '2026-11-25T00:00:40.000Z', '네'),
  ]);
  expect(merged.map(r => [r.ts, r.channels.join('+'), r.text])).toEqual([
    ['2026-11-25T00:00:00.000Z', 'claude-code+codex+elanous', '3.36 버전 로스터 정해주세요 추가 20개'],
    ['2026-11-25T00:00:20.000Z', 'elanous+pwa', '네'],
    ['2026-11-25T00:01:10.000Z', 'elanous', '3.36 버전 로스터 정해주세요 추가 20개'],
    ['2026-11-25T00:03:30.000Z', 'telegram', '3.36 버전 로스터 정해주세요 추가 20개'],
  ]);
});

test('surface events still count toward elanous next to eln sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'utter-surface-'));
  const surfaceDb = join(root, 'surface.db');
  const db = new Database(surfaceDb);
  db.run('CREATE TABLE events(id TEXT, ts TEXT, direction TEXT, kind TEXT, session_id TEXT, summary TEXT, text TEXT, refs TEXT)');
  db.run("INSERT INTO events VALUES ('e1', '2026-11-25T00:00:00.000Z', 'inbound', 'utterance', 'e', '', '음성으로 한 말', '{}')");
  db.close();
  const store = join(root, 'sessions'); mkdirSync(store);
  write(join(store, 'a.jsonl'), [{ role: 'user', content: '탭에 친 말', ts: '2026-11-25T00:00:05.000Z', from: { kind: 'human' } }]);
  const scan = scanDirectiveSources({ ...roots(root), surfaceDb, sessionRoots: [store] });
  expect(Object.values(scan.perSource.elanous)).toEqual([2, 2]);
});
