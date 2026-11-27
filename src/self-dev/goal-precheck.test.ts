import { expect, test } from 'bun:test';
import { precheckGoalDocument, recordGoalPrecheck } from './goal-precheck.js';

const GOOD = [
  '대상 경로: src/loops/a.ts · src/loops/a.test.ts',
  '- GoalType: implement',
  '',
  'CELL-A — 무엇을 왜',
  '',
  '완료선:',
  '- 단언 — bun test src/loops/a.test.ts',
  '',
  '범위 밖=FU: CELL-A-EDGE',
  '',
  '## PROBLEM',
  '- x',
].join('\n');

test('a goal that already meets the policy pack passes untouched', () => {
  const result = precheckGoalDocument(GOOD);
  expect(result.verdict).toBe('pass');
  expect(result.reasons).toEqual([]);
  expect(result.fixes).toEqual([]);
  expect(result.document).toBe(GOOD);
});

test('missing target paths or a done-when command needs a rewrite', () => {
  const noTarget = precheckGoalDocument(GOOD.replace('대상 경로: src/loops/a.ts · src/loops/a.test.ts', '대상: 몰라'));
  expect(noTarget.verdict).toBe('needs-rewrite');
  expect(noTarget.reasons[0]).toContain('대상 경로가 없다');
  const noCommand = precheckGoalDocument(GOOD.replace('- 단언 — bun test src/loops/a.test.ts', '- 잘 동작한다'));
  expect(noCommand.verdict).toBe('needs-rewrite');
  expect(noCommand.reasons).toEqual(['완료선을 잴 명령이 없다 — 집중 시험(bun test <파일>) 또는 시험 우주(--test=<dir>) 명령을 완료선에 적는다']);
});

test('too many target paths asks for a CORE-first split', () => {
  const many = Array.from({ length: 9 }, (_, i) => `src/x/f${i}.ts`).join(' · ');
  const result = precheckGoalDocument(GOOD.replace('src/loops/a.ts · src/loops/a.test.ts', many));
  expect(result.verdict).toBe('needs-rewrite');
  expect(result.reasons[0]).toBe('대상 경로 9개 > 8 — CORE 먼저 한 골로 쪼개고 나머지는 FU 칸으로');
});

test('trivial issues are fixed: catalog-registration duty · E4 cell kind', () => {
  const doc = GOOD
    .replace('CELL-A — 무엇을 왜', 'CELL-A-E4 — 증거 시험\n- 자식은 카탈로그 API 형식에 맞춰 시나리오를 등록한다.');
  const result = precheckGoalDocument(doc);
  expect(result.verdict).toBe('fixed');
  expect(result.fixes).toHaveLength(2);
  expect(result.document).toContain('시나리오를 등록한다. (참고 — GOAL-PRECHECK: 칸 완료선 밖 의무라 요구가 아니다)');
  expect(result.document.split('\n').slice(1, 3)).toEqual(['- GoalType: implement', '- CellKind: evidence']);
});

test('a duty inside the verbatim fenced ask is not rewritten', () => {
  const doc = `${GOOD}\n\n\`\`\`\n자식은 카탈로그 API 형식에 맞춰 시나리오를 등록한다.\n\`\`\`\n`;
  expect(precheckGoalDocument(doc).verdict).toBe('pass');
});

test('the record lands before the first heading and keeps the header lines first', () => {
  const result = precheckGoalDocument(GOOD);
  const recorded = recordGoalPrecheck(result.document, result);
  expect(recorded.split('\n')[0]).toBe('대상 경로: src/loops/a.ts · src/loops/a.test.ts');
  expect(recorded).toContain('## 사전 검토(GOAL-PRECHECK)\n- 판정: pass\n\n## PROBLEM');
});

test('a verification budget line is clarified so it never waives the evidence commands', () => {
  const doc = GOOD.replace('범위 밖=FU: CELL-A-EDGE', '범위 밖=FU: CELL-A-EDGE\n\n검증 예산: 원격 집중 1회 ⊕ pregate 1회');
  const result = precheckGoalDocument(doc);
  expect(result.verdict).toBe('fixed');
  expect(result.fixes).toEqual(['«검증 예산» 에 «완료선·증거 명령은 모두 실행» 명시']);
  expect(result.document).toContain('검증 예산: 원격 집중 1회 ⊕ pregate 1회 (예산은 실행 순서·호스트 안내일 뿐 — 완료선·증거 명령은 모두 실행한다 · 미실행은 완료가 아니다)');
  expect(precheckGoalDocument(result.document).verdict).toBe('pass');
});

test('the authored contract section «### 검증 예산» gets the note right under its heading; a fenced-only budget gets a trailing note', () => {
  const contract = precheckGoalDocument(`${GOOD}\n\n### 검증 예산\n- 원격 1 · pregate 1\n`);
  expect(contract.verdict).toBe('fixed');
  expect(contract.document).toContain('### 검증 예산\n- (예산은 실행 순서·호스트 안내일 뿐 — 완료선·증거 명령은 모두 실행한다 · 미실행은 완료가 아니다)\n- 원격 1 · pregate 1');
  const fenced = precheckGoalDocument(`${GOOD}\n\n\`\`\`\n검증 예산: 원격 집중 1회\n\`\`\`\n`);
  expect(fenced.document).toContain('\`\`\`\n검증 예산: 원격 집중 1회\n\`\`\`');
  expect(fenced.document.trimEnd().endsWith('검증 예산 해석(GOAL-PRECHECK): (예산은 실행 순서·호스트 안내일 뿐 — 완료선·증거 명령은 모두 실행한다 · 미실행은 완료가 아니다)')).toBe(true);
});

test('precheck is idempotent — a fixed document passes a second precheck unchanged (TA-GP3 sim)', () => {
  const doc = GOOD.replace('CELL-A — 무엇을 왜', 'CELL-A-E4 — 증거 시험\n- 자식은 카탈로그 API 형식에 맞춰 시나리오를 등록한다.') + '\n### 검증 예산\n- 원격 1\n';
  const first = precheckGoalDocument(doc);
  expect(first.verdict).toBe('fixed');
  const second = precheckGoalDocument(first.document);
  expect(second.verdict).toBe('pass');
  expect(second.document).toBe(first.document);
});
