import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { interpretDirective, readCellCandidates, renderInterpretationCard } from './interpretation-card.js';

test('one-line directives resolve only unique ledger candidates and leave ambiguity visible', () => {
  const cells = [{ id: 'K13', title: '로그 관측' }, { id: 'K14', title: '음성 입력' }];
  expect(interpretDirective('  K13 로그 관측을 고쳐라  ', cells)).toEqual({ what: 'K13 로그 관측을 고쳐라', cell: 'K13', unknowns: [] });
  expect(interpretDirective('K13을 고쳐라', cells).cell).toBe('K13');
  expect(interpretDirective('K130을 고쳐라', cells)).toEqual({ what: 'K130을 고쳐라', cell: null, unknowns: ['연결할 칸을 확인해야 한다'] });
  expect(interpretDirective('로그 관측과 음성 입력을 고쳐라', cells)).toEqual({ what: '로그 관측과 음성 입력을 고쳐라', cell: null, unknowns: ['칸 후보가 여럿이다: K13, K14'] });
  expect(() => interpretDirective('K13\nK14', cells)).toThrow('한 줄');
  expect(() => interpretDirective('  ', cells)).toThrow('빈 지시');
});

test('human rendering always has exactly three lines, including explicit unknowns', () => {
  expect(renderInterpretationCard({ what: '로그 관측을 고쳐라', cell: 'K13', unknowns: [] })).toBe('무엇: 로그 관측을 고쳐라\n칸: K13\n미확인: 없음');
  expect(renderInterpretationCard(interpretDirective('처리해라', []))).toBe('무엇: 처리해라\n칸: 확인 필요\n미확인: 연결할 칸을 확인해야 한다');
});

test('candidate reader uses the same isolated SQLite checklist as release checklist list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'interpretation-card-'));
  setElanousConfigDir(dir);
  try {
    addItem('9.9.9', { id: 'K13', title: '로그 관측' });
    addItem('9.9.9', { id: 'K14', title: '음성 입력' });
    expect(existsSync(join(dir, 'release', 'features.sqlite'))).toBe(true);
    expect(readCellCandidates('9.9.9')).toEqual(listChecklist('9.9.9').items.map(({ id, title }) => ({ id, title })));
    expect(interpretDirective('K14 개선', readCellCandidates('9.9.9')).cell).toBe('K14');
    expect(readCellCandidates('9.9.8')).toEqual([]);
  } finally {
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});
