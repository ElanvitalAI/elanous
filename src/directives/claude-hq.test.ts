import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerDirectivesCommands } from '../cli/directives-cli.js';
import { DirectiveIndex } from './directive-index.js';

test('Claude HQ user conversation syncs three originals and search returns them; backfills old cursors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-hq-directives-'));
  const claudeRoot = join(root, 'claude'); mkdirSync(claudeRoot);
  const file = join(claudeRoot, 'op.jsonl');
  const texts = ['\u{1F451} 첫째 빠른 발행', '\u{1F451} 둘째 검사 완료', '\u{1F451} 셋째 결과 보고'];
  const common = { cwd: '/Users/me/elanous-hq/seats/OP', sessionId: 'op', timestamp: '2026-11-24T00:00:00Z' };
  const rows = [
    { ...common, type: 'user', message: { content: texts[0] } },
    { ...common, type: 'user', message: { content: [{ type: 'text', text: texts[1] }] } },
    { ...common, type: 'user', message: { content: texts[2] } },
    { ...common, type: 'assistant', message: { content: '\u{1F451} 응답 제외' } },
    { ...common, type: 'user', isSidechain: true, message: { content: '\u{1F451} 사이드체인 제외' } },
    { ...common, type: 'user', isMeta: true, message: { content: '\u{1F451} 메타 제외' } },
    { ...common, type: 'user', message: { content: [{ type: 'tool_result', content: '\u{1F451} 도구 제외' }] } },
    { ...common, type: 'user', cwd: '/tmp/unrelated', sessionId: 'other', message: { content: '\u{1F451} 다른 프로젝트 제외' } },
  ];
  const contents = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(file, contents);
  const opts = { claudeRoot, stateDir: join(root, 'state'), codexRoot: join(root, 'codex'), grokRoot: join(root, 'grok'), surfaceDb: join(root, 'surface'), repoRoot: join(root, 'missing'), embed: null };
  const lines: string[] = [];
  const cli = new Command(); cli.exitOverride();
  registerDirectivesCommands(cli, opts, { log: value => lines.push(String(value)) });
  await cli.parseAsync(['node', 'eln', 'directives', 'sync', '--json']);
  const syncOutput = lines.pop()!;
  expect(JSON.parse(syncOutput).added).toBe(3);
  console.log(`시험 우주 directives sync --json: ${syncOutput}`);
  await cli.parseAsync(['node', 'eln', 'directives', 'search', '둘째', '--json']);
  const searchOutput = lines.pop()!;
  expect(JSON.parse(searchOutput).rows.map((row: { text: string }) => row.text)).toEqual([texts[1]]);
  console.log(`시험 우주 directives search 둘째 --json: ${searchOutput}`);
  const index = new DirectiveIndex(opts);
  try {
    expect(index.search('').map(row => row.text).sort()).toEqual(texts.sort());
    index.db.run("DELETE FROM directive_fts"); index.db.run('DELETE FROM directives');
    index.db.run("DELETE FROM metadata WHERE key='claudeHqRevision'");
    index.db.prepare('UPDATE positions SET offset=?, context=?, size=? WHERE source_file=?').run(Buffer.byteLength(contents), JSON.stringify({ lineNo: rows.length, sessionId: 'op', cwd: common.cwd, automatedCodex: false, sessionCwds: { op: common.cwd }, sessionAllowed: { op: false }, assistantCounts: {} }), Buffer.byteLength(contents), file);
    expect(index.sync().added).toBe(3);
    expect(index.search('첫째')[0]?.text).toBe(texts.find(t => t.includes('첫째'))!);
    expect(index.sync().added).toBe(0);
  } finally { index.close(); }
});
