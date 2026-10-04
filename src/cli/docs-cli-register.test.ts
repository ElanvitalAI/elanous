import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerDocsCommands } from './docs-cli.js';

test('docs registration preserves command hierarchy and declared flags', () => {
  const program = new Command();
  registerDocsCommands(program);

  const docs = program.commands.find((command) => command.name() === 'docs');
  expect(docs?.description()).toBe('문서 지식 검색/관리 — knowledge.db 벡터+BM25 하이브리드 (DocOps)');
  expect(docs?.commands.map((command) => [command.name(), command.registeredArguments.map((arg) => arg.name()), command.options.map((option) => option.flags)])).toEqual([
    ['rfc-status', [], ['--json', '--missing-cards']],
    ['search', ['query'], ['--limit <n>', '--domain <d>', '--kind <k>', '--json']],
    ['revision', ['path'], ['--json']],
    ['stale', ['path'], ['--json', '--axis <axis>', '--history']],
  ]);
  expect(docs?.commands.map((command) => command.description())).toEqual([
    '전체 RFC 생애주기 표 (RFC frontmatter만 읽음)',
    '하이브리드 검색(RRF) — 의미(임베딩)+키워드(FTS5) 융합. 임베딩 다운 시 키워드 단독',
    '문서가 선언한 현재 판과 해당 문서의 git 이력 판을 비교',
    '과거 TypeScript 인벤토리와 대조해 실제로 늙은 문서를 판정',
  ]);
});
