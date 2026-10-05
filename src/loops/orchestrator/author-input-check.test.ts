import { expect, test } from 'bun:test';
import { checkAuthorInput } from './author-input-check.js';

const base = { title: '사람이 요청한 기능', text: '사용자가 X를 할 수 있어야 한다, 왜냐하면 Y', cellId: 'AUTHOR-PAR', version: '0.2.15' };

for (const text of [
  'lib/foo.py를 수정하세요',
  'src/foo.ts를 수정해 주세요',
  'pnpm build로 판정하라',
  'foo()를 쓰라',
  'bun test로 판정하라',
  '경계:를 넣으라',
  'config/app.yml 고쳐줘',
  'Run make deploy',
]) {
  test(`directed implementation token: ${text}`, () => {
    const result = checkAuthorInput({ ...base, text });
    expect(result.verdict).toBe('resubmit');
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.every(signal => signal.field === 'text' && !!signal.reason && !!signal.match)).toBe(true);
    expect(result.units).toEqual({ checked: 2, candidates: 1 });
    expect(result.implementationRatio).toBe(0.5);
  });
}

for (const text of ['어제 lib/foo.py 에서 오류가 났다', 'docs/README 를 참고했다']) {
  test(`background reference needs confirmation: ${text}`, () => {
    const result = checkAuthorInput({ ...base, text });
    expect(result.verdict).toBe('confirm');
    expect(result.signals.some(signal => signal.kind === 'path' && signal.field === 'text')).toBe(true);
  });
}

test('human-language request, including 2,000 characters, is approved without length cutoff', () => {
  for (const text of [base.text, '사용자가 자신의 기록을 볼 수 있어야 한다. '.repeat(100)]) {
    expect(text === base.text || text.length >= 2_000).toBe(true);
    const result = checkAuthorInput({ ...base, text });
    expect(result.verdict).toBe('approved');
    expect(result.signals).toEqual([]);
    expect(result.units.candidates).toBe(0);
    expect(result.implementationRatio).toBe(0);
  }
});

test('bare markers and commands resubmit; a bare symbol requires confirmation', () => {
  for (const text of ['"대상 경로:"', '관측 =', '`pnpm build`', 'bun test', '--dry-run']) {
    expect(checkAuthorInput({ ...base, text }).verdict).toBe('resubmit');
  }
  expect(checkAuthorInput({ ...base, text: '어제 `helper`에서 오류가 났다' }).verdict).toBe('confirm');
});

test('numeric version in human text is not a file path', () => {
  const result = checkAuthorInput({ ...base, text: '버전 1.2.3 에서 사용자가 기록을 볼 수 있어야 한다' });
  expect(result.verdict).toBe('approved');
  expect(result.signals).toEqual([]);
});

test('missing text remains uncheckable while the selected title is checked for directives', () => {
  const result = checkAuthorInput({ ...base, title: 'src/foo.ts를 수정하세요', text: '' });
  expect(result).toMatchObject({ verdict: 'uncheckable', implementationRatio: null, units: { checked: 0, candidates: 0 } });
  expect(result.signals).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'path', field: 'title', match: 'src/foo.ts' }),
    expect.objectContaining({ kind: 'missing', field: 'text', reason: 'missing cell text' }),
  ]));
});

test('invalid version and missing required inputs are uncheckable, not zero ratio', () => {
  for (const input of [{ ...base, version: '0.2' }, { ...base, title: '  ' }, { ...base, text: '' }, { ...base, cellId: '' }]) {
    const result = checkAuthorInput(input);
    expect(result).toMatchObject({ verdict: 'uncheckable', implementationRatio: null, units: { checked: 0, candidates: 0 } });
  }
});

test('quoted and multiline tokens, title signals, and sentence-level ratio', () => {
  const result = checkAuthorInput({ ...base, title: '기록을 보고 싶다', text: '사용자가 기록을 찾기 어렵다.\n`helper`를 넣어 주세요.\n"--dry-run"' });
  expect(result.verdict).toBe('resubmit');
  expect(result.signals.map(({ kind, match }) => [kind, match])).toEqual([['symbol', '`helper`'], ['command', '--dry-run']]);
  expect(result.units).toEqual({ checked: 4, candidates: 2 });
  expect(result.implementationRatio).toBe(0.5);
  expect(checkAuthorInput({ ...base, title: 'src/foo.ts 개선' }).verdict).toBe('confirm');
});

test('deterministic 200 path shapes with varied endings are never approved', () => {
  let seed = 0x504152;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const endings = ['를 수정하세요', '를 수정해 주세요', '에서 문제가 났다', '를 고쳐줘', '를 참고했다', '를 확인해야 한다'];
  let approved = 0;
  let slashPaths = 0;
  let extensionPaths = 0;
  for (let i = 0; i < 200; i++) {
    const n = random().toString(36);
    const slash = ((random() >>> 16) & 1) === 1;
    if (slash) slashPaths++; else extensionPaths++;
    const path = slash ? `${n}/b` : `${n}.yz`;
    const text = `${path}${endings[(random() >>> 16) % endings.length]}`;
    const result = checkAuthorInput({ ...base, text });
    if (result.verdict === 'approved') approved++;
    expect(result.signals.some(signal => signal.kind === 'path')).toBe(true);
  }
  expect(slashPaths).toBeGreaterThan(0);
  expect(extensionPaths).toBeGreaterThan(0);
  expect(approved).toBe(0);
});
