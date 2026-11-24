// DIRECTIVES-INDEX-CLAUDE-CODE — Claude Code 원문 3턴 → 색인 3건 → 검색이 원문을 찾는다 → OP 세션 시작 «살아 있는 지시» 블록.
// 기대값은 제품 상수를 쓰지 않은 독립 리터럴이다.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectiveIndex } from './directive-index.js';
import { buildActiveDirectivesBlock } from './active-directives-block.js';
import { buildActiveDirectivesSystemMessages, resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';

afterEach(() => resetSeatBootCacheForTest());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'active-directives-'));
  const claudeRoot = join(root, 'claude', '-Users-me-elanous-hq-seats-OP');
  mkdirSync(claudeRoot, { recursive: true });
  const cwd = '/Users/me/elanous-hq/seats/OP';
  const base = { cwd, sessionId: 's1', isSidechain: false };
  const rows = [
    { ...base, type: 'user', timestamp: '2026-11-24T01:00:00Z', message: { role: 'user', content: 'Ship 0.3.34 by quickpass now' } },
    { ...base, type: 'user', timestamp: '2026-11-24T01:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Keep the security relaxation, do not add barriers' }] } },
    { ...base, type: 'user', timestamp: '2026-11-24T01:10:00Z', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>Raise cache hit rate above eighty percent' } },
    { ...base, type: 'user', timestamp: '2026-11-24T01:11:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'tool output' }] } },
    { ...base, type: 'user', timestamp: '2026-11-24T01:12:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } },
    { ...base, type: 'user', timestamp: '2026-11-24T01:13:00Z', message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } },
    { ...base, type: 'assistant', timestamp: '2026-11-24T01:14:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ];
  writeFileSync(join(claudeRoot, 's1.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const opts = { claudeRoot: join(root, 'claude'), codexRoot: join(root, 'codex'), grokRoot: join(root, 'grok'), surfaceDb: join(root, 'surface.db'), stateDir: join(root, 'state'), repoRoot: join(root, 'missing') };
  return { root, opts, dbPath: join(root, 'state', 'directives', 'directives.db') };
}

test('3 Claude Code user turns → added=3 · search finds verbatim · tool_result and command wrappers skipped', () => {
  const { opts } = fixture();
  const index = new DirectiveIndex(opts);
  try {
    const r = index.sync();
    console.log(`시험 우주 directives sync: added=${r.added} perSource=${JSON.stringify(r.perSource['claude-code'])}`);
    expect(r.added).toBe(3);
    expect(index.search('quickpass').map(row => row.text)).toEqual(['Ship 0.3.34 by quickpass now']);
    expect(index.search('').map(row => row.text).sort()).toEqual([
      'Keep the security relaxation, do not add barriers',
      'Raise cache hit rate above eighty percent',
      'Ship 0.3.34 by quickpass now',
    ]);
  } finally { index.close(); }
});

test('OP session start block: ledger first, then index newest first, ≤1536 bytes, contract line; no ledger → index only', () => {
  const { root, opts, dbPath } = fixture();
  const index = new DirectiveIndex(opts);
  try { index.sync(); } finally { index.close(); }
  const home = join(root, 'home');
  const ledgerDir = join(home, 'elanous-hq', 'seat-state', 'OP', 'directives');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, 'DIRECTIVES-LEDGER-20261124.md'),
    '# ledger\n| 시각(KST) | 원문 | 해석·적용 |\n|---|---|---|\n| 06:2x | «quickpass publish» | publish approved |\n');

  const withLedger = buildActiveDirectivesBlock({ label: 'OP', seat: 'OP', ledgerDir }, { dbPath })!;
  console.log(withLedger);
  const lines = withLedger.split('\n');
  expect(lines[0]).toBe('## Active CEO directives — OP (session-start snapshot · newest first · ledger then index)');
  expect(lines[1]).toBe('Before reversing or overriding a change that a CEO directive asked for, search directives (`eln directives search <words>`) and the ledger; if a directive covers it, do not reverse it — raise a decision card instead.');
  expect(lines.slice(2)).toEqual([
    '- [ledger 11-24 06:2x] «quickpass publish» → publish approved',
    '- [11-24 01:10Z] Raise cache hit rate above eighty percent',
    '- [11-24 01:05Z] Keep the security relaxation, do not add barriers',
    '- [11-24 01:00Z] Ship 0.3.34 by quickpass now',
  ]);
  expect(Buffer.byteLength(withLedger, 'utf8')).toBeLessThanOrEqual(1536);

  const noLedger = buildActiveDirectivesBlock({ label: 'OP', seat: 'OP', ledgerDir: join(root, 'absent') }, { dbPath })!;
  expect(noLedger.split('\n').slice(2)).toEqual([
    '- [11-24 01:10Z] Raise cache hit rate above eighty percent',
    '- [11-24 01:05Z] Keep the security relaxation, do not add barriers',
    '- [11-24 01:00Z] Ship 0.3.34 by quickpass now',
  ]);
  // 다른 자리 cwd 는 거른다.
  expect(buildActiveDirectivesBlock({ label: 'TC', seat: 'TC', ledgerDir: null }, { dbPath })).toBeNull();

  // OP 세션 시작 안정 구역에 실린다(같은 대화 = 같은 바이트).
  const seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
  mkdirSync(seatCwd, { recursive: true });
  const deps = { home, env: {}, msgPath: join(home, 'msg.db'), seatMemoryRoot: join(root, 'memory'), directivesDbPath: dbPath };
  const a = buildActiveDirectivesSystemMessages({ cwd: seatCwd }, deps);
  expect(a).toHaveLength(1);
  expect(String(a[0]!.content)).toContain('- [ledger 11-24 06:2x] «quickpass publish» → publish approved');
  expect(String(a[0]!.content)).toContain('- [11-24 01:00Z] Ship 0.3.34 by quickpass now');
  expect(buildActiveDirectivesSystemMessages({ cwd: seatCwd }, deps)).toBe(a);
});
