import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { DirectiveIndex, type IndexOptions } from './directive-index.js';
import { embedPending, type EmbedFn } from './directive-semantic.js';
import { parseNaturalQuery } from './natural-query.js';
import { askDirectives, renderAsk } from './ask.js';
import { dispatchDirectiveSearch } from '../skills/tools/directive-search.js';
import { directiveSearchRuntime } from '../tool-runtime/directive-search-runtime.js';
import { nativeToolCatalog } from '../native-tool-catalog.js';
import { registerDirectivesCommands } from '../cli/directives-cli.js';

// 2026-11-25 (Wed) 12:00 KST.
const NOW = Date.parse('2026-11-25T03:00:00Z');

// Stub embedder: one axis per concept, so paraphrases share an axis and unrelated lines do not.
const CONCEPTS: string[][] = [['로스터', '명단'], ['발행', '출시', '릴리스'], ['데모', '시연'], ['취소', '접자']];
let embedCalls = 0;
const stubEmbed: EmbedFn = async (text) => {
  embedCalls++;
  const vector = new Float32Array(CONCEPTS.length + 1);
  CONCEPTS.forEach((words, axis) => { if (words.some(word => text.includes(word))) vector[axis] = 1; });
  vector[CONCEPTS.length] = 0.1;
  return { vector, model: 'stub-concepts' };
};
const downEmbed: EmbedFn = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); };

const FIXTURE: Array<[string, string, string]> = [
  ['2026-11-24T12:00:00Z', 'telegram', '오늘 밤 안에 로스터 마무리해 주세요'],
  ['2026-11-24T00:00:00Z', 'codex', 'TC 에게 착지 큐 정리를 맡겨'],
  ['2026-11-23T01:00:00Z', 'claude-code', '데모는 취소합니다 다음에 다시 잡죠'],
  ['2026-11-19T01:00:00Z', 'telegram', '발행은 06:00 정시로 갑니다'],
  ['2026-11-21T06:00:00Z', 'claude-code', '발행 노트 먼저 정리하고 컷'],
  ['2026-11-23T23:00:00Z', 'codex', '출시 전에 예행 한 번 더'],
  ['2026-11-20T05:00:00Z', 'elanous', 'els 키 입력 느림 고쳐'],
];

function world(): IndexOptions {
  const root = mkdtempSync(join(tmpdir(), 'directive-ask-'));
  const opts: IndexOptions = {
    stateDir: join(root, 'state'), claudeRoot: join(root, 'claude'), codexRoot: join(root, 'codex'), codexRoots: [],
    grokRoot: join(root, 'grok'), surfaceDb: join(root, 'surface.db'), sessionRoots: [], repoRoot: join(root, 'absent'),
  };
  const index = new DirectiveIndex(opts);
  try {
    FIXTURE.forEach(([ts, agent, text], i) => {
      const row = index.db.prepare(`INSERT INTO directives (ts,agent,session_id,cwd,track,released,dev,codename,text,source_file,line_no)
        VALUES (?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,1)`).run(ts, agent, `session-${i}`, text, `fixture-${i}.jsonl`);
      index.db.prepare('INSERT INTO directive_fts(rowid,text) VALUES (?,?)').run(Number(row.lastInsertRowid), text);
    });
  } finally { index.close(); }
  return opts;
}
async function ask(opts: IndexOptions, question: string, embed: EmbedFn | null = stubEmbed, extra: Record<string, unknown> = {}) {
  const index = new DirectiveIndex(opts);
  try { return await askDirectives(index, question, { embed, now: NOW, ...extra }); } finally { index.close(); }
}

test('time phrases resolve to KST periods: 어제 · 지난주 · 3시간 전 · 11월 23일 · 어제 밤', () => {
  expect(parseNaturalQuery('어제 로스터 얘기한 거', NOW)).toMatchObject({
    topic: '로스터', since: '2026-11-23T15:00:00.000Z', until: '2026-11-24T14:59:59.999Z', day: '2026-11-24', intent: 'search',
  });
  expect(parseNaturalQuery('발행 관련해서 지난주에 뭐라고 했지', NOW)).toMatchObject({
    topic: '발행', since: '2026-11-15T15:00:00.000Z', until: '2026-11-22T14:59:59.999Z',
  });
  expect(parseNaturalQuery('3시간 전에 뭐라고 했지', NOW)).toMatchObject({ topic: '', since: '2026-11-25T00:00:00.000Z', until: '2026-11-25T03:00:00.000Z' });
  expect(parseNaturalQuery('11월 23일에 «데모 취소» 라고 한 적 있어?', NOW)).toMatchObject({
    topic: '데모 취소', intent: 'said', day: '2026-11-23', since: '2026-11-22T15:00:00.000Z', until: '2026-11-23T14:59:59.999Z',
  });
  expect(parseNaturalQuery('어제 밤 코덱스에서 착지 얘기', NOW)).toMatchObject({
    topic: '착지', source: 'codex', since: '2026-11-24T09:00:00.000Z', until: '2026-11-24T14:59:59.999Z',
  });
  expect(parseNaturalQuery('TC 한테 시킨 거', NOW)).toMatchObject({ topic: 'TC', intent: 'search' });
  expect(parseNaturalQuery('지난 일주일 동안 발행 관련 요청 내역 알려주세요', NOW)).toMatchObject({
    topic: '발행', intent: 'history', since: '2026-11-18T03:00:00.000Z', until: '2026-11-25T03:00:00.000Z',
  });
});

test('meaning finds a paraphrase that shares no word, and sync-time embedding is incremental', async () => {
  const opts = world();
  const index = new DirectiveIndex(opts);
  try {
    embedCalls = 0;
    expect(await embedPending(index, stubEmbed)).toMatchObject({ embedded: 7, pending: 0, model: 'stub-concepts', error: null });
    expect(await embedPending(index, stubEmbed)).toMatchObject({ embedded: 0, pending: 0 });
    expect(embedCalls).toBe(7);
  } finally { index.close(); }
  const result = await ask(opts, '어제 명단 정리 얘기한 거');
  expect(result.mode).toBe('hybrid');
  expect(result.rows[0]).toMatchObject({ text: '오늘 밤 안에 로스터 마무리해 주세요', channels: ['telegram'], matchedBy: 'meaning', kst: '2026-11-24 21:00 KST' });
  expect(result.rows[0]!.similarity!).toBeGreaterThan(0.9);
  expect(renderAsk(result)).toContain('2026-11-24 21:00 KST · telegram · 유사 1.00 · 오늘 밤 안에 로스터 마무리해 주세요');
});

test('channel words filter: 텔레그램 keeps telegram lines only', async () => {
  const opts = world();
  const result = await ask(opts, '어제 텔레그램으로 뭐라고 했지');
  expect(result.parsed.source).toBe('telegram');
  expect(result.rows.map(row => row.text)).toEqual(['오늘 밤 안에 로스터 마무리해 주세요']);
  const codex = await ask(opts, '코덱스에서 착지 얘기한 거');
  expect(codex.rows.map(row => row.channels.join('+'))).toEqual(['codex']);
  expect(codex.rows[0]!.text).toBe('TC 에게 착지 큐 정리를 맡겨');
});

test('a down embedder falls back to keywords and says so in one line', async () => {
  const opts = world();
  const found = await ask(opts, '어제 로스터 얘기한 거', downEmbed);
  expect(found.mode).toBe('keyword');
  expect(found.rows.map(row => row.text)).toEqual(['오늘 밤 안에 로스터 마무리해 주세요']);
  const lines = renderAsk(found).split('\n');
  expect(lines[1]).toBe('임베더 응답 없음(connect ECONNREFUSED 127.0.0.1:1234) — 키워드로만 찾음');
  const paraphrase = await ask(opts, '어제 명단 정리 얘기한 거', downEmbed);
  expect(paraphrase.rows.map(row => row.text)).not.toContain('오늘 밤 안에 로스터 마무리해 주세요');
});

test('did-I-say: yes on the day, otherwise «그날은 없고 <날짜>에 있음»', async () => {
  const opts = world();
  const yes = await ask(opts, '11월 23일에 «데모 취소» 라고 한 적 있어?');
  expect(yes.said).toEqual({ yes: true, day: '2026-11-23', otherDays: [] });
  expect(yes.rows[0]!.text).toBe('데모는 취소합니다 다음에 다시 잡죠');
  expect(renderAsk(yes).split('\n')[1]).toBe('예 — 2026-11-23 에 그렇게 말한 적이 있다 (가까운 1건)');
  const no = await ask(opts, '11월 22일에 «데모 취소» 라고 한 적 있어?');
  expect(no.said).toEqual({ yes: false, day: '2026-11-22', otherDays: ['2026-11-23'] });
  expect(renderAsk(no).split('\n')[1]).toBe('아니오 — 그날은 없고 2026-11-23 에 있음');
  expect(no.rows[0]!.text).toBe('데모는 취소합니다 다음에 다시 잡죠');
});

test('theme history: every match in the period, by day oldest first, with an account; md export and theme grouping', async () => {
  const opts = world();
  const result = await ask(opts, '지난 일주일 동안 발행 관련 요청 내역 알려주세요');
  expect(result.intent).toBe('history');
  expect(result.groups!.map(group => [group.label, group.count])).toEqual([['2026-11-19', 1], ['2026-11-21', 1], ['2026-11-24', 1]]);
  expect(result.groups![2]!.rows[0]!.text).toBe('출시 전에 예행 한 번 더');
  expect(result.summary![0]).toBe('총 3건 · 3일 · 채널 telegram 1 · claude-code 1 · codex 1');
  expect(result.summary![1]).toBe('처음 2026-11-19 10:00 KST «발행은 06:00 정시로 갑니다»');
  const md = renderAsk(result, 'md');
  expect(md).toContain('## 2026-11-19 (1건)');
  expect(md).toContain('- **10:00** · telegram · 유사 1.00 — 발행은 06:00 정시로 갑니다');
  expect(md).toContain('## 흐름');
  const themed = await ask(opts, '지난 일주일 동안 발행 관련 요청 내역', stubEmbed, { group: 'theme' });
  expect(themed.groups).toHaveLength(1);
  expect(themed.groups![0]!.count).toBe(3);
});

test('DirectiveSearch tool returns rows; registered read-only; CLI ask prints the same answer', async () => {
  const opts = world();
  const result = await dispatchDirectiveSearch({ query: '어제 로스터 얘기한 거' }, { index: opts, embed: stubEmbed, now: NOW });
  expect(result.ok).toBe(true);
  expect(result.rows[0]).toMatchObject({ text: '오늘 밤 안에 로스터 마무리해 주세요', channels: ['telegram'] });
  expect(result.output).toContain('물음 이해: 기간 2026-11-24 00:00 KST ~ 2026-11-24 23:59 KST · 주제 «로스터» · 방식 의미+키워드');
  await expect(dispatchDirectiveSearch({ query: '' }, { index: opts, embed: null })).rejects.toThrow('query is required');
  expect(directiveSearchRuntime.spec.name).toBe('DirectiveSearch');
  expect(nativeToolCatalog.find(tool => tool.id === 'directive_search')).toMatchObject({ safety: ['read-only'], host: ['skill', 'tui'] });

  const lines: string[] = [];
  const cli = new Command();
  registerDirectivesCommands(cli, { ...opts, embed: stubEmbed, now: () => NOW }, { log: line => lines.push(line) });
  await cli.parseAsync(['directives', 'ask', '11월', '23일에', '«데모', '취소»', '라고', '한', '적', '있어?'], { from: 'user' });
  expect(lines.join('\n')).toContain('예 — 2026-11-23 에 그렇게 말한 적이 있다');
  lines.length = 0;
  await cli.parseAsync(['directives', 'ask', '지난', '일주일', '발행', '내역', '--format', 'md'], { from: 'user' });
  expect(lines.join('\n')).toContain('## 2026-11-21 (1건)');
});
