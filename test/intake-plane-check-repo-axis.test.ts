import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAP_VERDICTS, intakeCheckReportJson, renderIntakeCheckReport, runIntakeCheck, runIntakeCheckDocument } from '../src/intake-plane/check.js';
import { buildIntakeDocumentStageCallables } from '../src/intake-plane/runtime-callables.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const roots: string[] = [];
const token = ['sample', 'repo', 'marker', 'q7'].join('-');
const fakeRepo = () => createIntakeFakeRepo(roots, 'intake-axis-');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fact = () => ({ text: `elanous 에 \`${token}\` 가 있다` });

test('fake repository supplies every ruler source without an unmeasured verdict', () => {
  const item = runIntakeCheck([fact()], fakeRepo()).items[0]!;
  expect(item.verdict).toBe('없음');
  expect(item.failures).toEqual([]);
});

test('documentation-only match is a mention, not behavioral evidence', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), `The token ${token} is mentioned.\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.summary.includes('문서 언급') && row.path === 'docs/notes.md')).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('동작 근거'))).toBe(false);
});

test('code comment-only match is a mention, not behavioral evidence', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `/* ${token}\n * another line */\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.summary.includes('주석 언급') && row.path === 'src/probe.ts')).toBe(true);
});

test('a token in a string literal beside a comment remains executable evidence', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `// ${token}\nexport const probe = '${token}'; // ${token}\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.summary.includes('동작 근거') && row.line === 2)).toBe(true);
});

test('non-TypeScript executable source remains behavioral evidence while its comment is a mention', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.py'), `# ${token}\nprobe = '${token}'\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.repoKind === 'comment' && row.path === 'src/probe.py' && row.line === 1)).toBe(true);
  expect(item.evidence.some((row) => row.repoKind === 'behavior' && row.path === 'src/probe.py' && row.line === 2)).toBe(true);
});

test('nested test and spec files are excluded from the repository evidence axis', () => {
  const deps = fakeRepo();
  for (const path of ['src/a.test.ts', 'src/a.spec.ts', 'src/__tests__/probe.ts', 'src/test/probe.py', 'src/tests/probe.py']) {
    const full = join(deps.root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `export const probe = '${token}';\n`);
  }
  const report = runIntakeCheck([fact()], deps);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.items[0]?.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'behavior')).toBe(false);
});

test('inline hash and slash comments in source are mentions only', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.py'), `probe = 1 # ${token}\n`);
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = 1; // ${token}\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.evidence.some((row) => row.repoKind === 'comment' && row.path === 'src/probe.py')).toBe(true);
  expect(item.evidence.some((row) => row.repoKind === 'comment' && row.path === 'src/probe.ts')).toBe(true);
});

test('sampled document mentions cannot hide later executable evidence', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), Array.from({ length: 40 }, () => `${token} is mentioned`).join('\n'));
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = '${token}';\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.summary.includes('문서 언급'))).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('동작 근거'))).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
});

test('more indicator counts actual remaining matches, not just unread bytes', () => {
  const one = fakeRepo();
  writeFileSync(join(one.root, 'src/probe.ts'), `export const probe = '${token}';\nexport const unrelated = 1;\n`);
  const single = runIntakeCheck([fact()], one).items[0]!;
  expect(single.verdict).toBe('있음');
  expect(single.evidence.some((row) => row.summary.includes('더 있음'))).toBe(false);

  const two = fakeRepo();
  writeFileSync(join(two.root, 'src/probe.ts'), `export const probe = '${token}';\nexport const later = '${token}';\n`);
  const repeated = runIntakeCheck([fact()], two).items[0]!;
  expect(repeated.verdict).toBe('있음');
  expect(repeated.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);

  const separate = fakeRepo();
  writeFileSync(join(separate.root, 'src/first.ts'), `export const first = '${token}';\n`);
  writeFileSync(join(separate.root, 'src/second.ts'), `export const second = '${token}';\n`);
  const acrossFiles = runIntakeCheck([fact()], separate).items[0]!;
  expect(acrossFiles.verdict).toBe('있음');
  expect(acrossFiles.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
});

test('a refusal line cannot hide a later executable match', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const rejected = '${token}'; // 무효한 옵션\nexport const accepted = '${token}';\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.repoKind === 'behavior' && row.line === 2)).toBe(true);
});

test('name-only executable hit does not stop before a later behavior-supporting hit', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const first = '${token}';\nexport const elanous = () => randomChoose('${token}');\n`);
  const item = runIntakeCheck([{ text: `elanous 는 \`${token}\` 을 무작위로 고른다` }], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.repoKind === 'behavior' && row.line === 2)).toBe(true);
});

test('behavior-supporting hit beyond the executable sample remains visible', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), [
    ...Array.from({ length: 15 }, (_, i) => `export const name${i} = '${token}';`),
    `export const elanous = () => randomChoose('${token}');`,
  ].join('\n'));
  const item = runIntakeCheck([{ text: `elanous 는 \`${token}\` 을 무작위로 고른다` }], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.repoKind === 'behavior' && row.line === 16)).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
});

test('executable code is evidence even alongside a comment', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `// ${token}\nexport const probe = '${token}';\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.summary.includes('동작 근거') && row.path === 'src/probe.ts' && row.line === 2)).toBe(true);
});

test('frequent matches do not overflow the search buffer and disclose sampling', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), Array.from({ length: 100_000 }, () => `export const probe = '${token}';`).join('\n'));
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.path === 'src/probe.ts' && row.line === 1)).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
  expect(item.failures).toEqual([]);
});

test('100k comment matches complete with bounded classification cost', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), Array.from({ length: 100_000 }, () => `// ${token}`).join('\n'));
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.evidence.some((row) => row.repoKind === 'comment' && row.path === 'src/probe.ts')).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
  expect(item.failures).toEqual([]);
}, 30_000);

test('many source-code comments exhaust the byte budget without implying absence', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.py'), `# ${token}\n`.repeat(1_600_000));
  const report = runIntakeCheck([fact()], deps);
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures.join(' ')).toContain('탐색 예산 소진');
  expect(report.goalDraftPaths).toEqual([]);
}, 30_000);

test('document-only frequency is measured as sampled mentions, not a failed implementation search', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), `${token} mention\n`.repeat(1_200_000));
  const report = runIntakeCheck([fact()], deps);
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.items[0]?.evidence.some((row) => row.repoKind === 'document' && row.path === 'docs/notes.md')).toBe(true);
  expect(report.items[0]?.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
  expect(report.items[0]?.failures).toEqual([]);
  expect(report.goalDraftPaths).toEqual([]);
}, 30_000);

test('document filename-list sampling does not make implementation search unmeasured', () => {
  const deps = fakeRepo();
  for (let i = 0; i < 5500; i++) {
    writeFileSync(join(deps.root, 'docs', `mention-${String(i).padStart(4, '0')}-${'x'.repeat(185)}.md`), `${token} mention\n`);
  }
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.evidence.some((row) => row.repoKind === 'document')).toBe(true);
  expect(item.evidence.some((row) => row.summary.includes('더 있음'))).toBe(true);
  expect(item.failures).toEqual([]);
}, 30_000);

test('many document mentions cannot exhaust the budget before a later code hit', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), `${token} mention\n`.repeat(1_200_000));
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = '${token}';\n`);
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.repoKind === 'behavior' && row.path === 'src/probe.ts')).toBe(true);
  expect(item.failures).toEqual([]);
}, 30_000);

test('a failed repository search remains unmeasured, and only 없음 makes a goal draft', () => {
  const deps = fakeRepo();
  const failed = runIntakeCheck([fact()], { ...deps, listFiles: () => { throw new Error('search failed'); } });
  expect(failed.items[0]?.verdict).toBe('못 쟀다');
  expect(failed.items[0]?.failures).toContain('search failed');
  expect(failed.goalDraftPaths).toEqual([]);
  const missing = runIntakeCheck([fact()], deps);
  expect(missing.items[0]?.verdict).toBe('없음');
  expect(missing.goalDraftPaths).toHaveLength(1);
  expect(readFileSync(missing.goalDraftPaths[0]!, 'utf8')).toContain('대상 경로:');
  expect(GAP_VERDICTS).toEqual(['없음']);
});

test('failed document mention read does not mask a completed implementation search', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), `${token} mention\n`);
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = '${token}';\n`);
  const item = runIntakeCheck([fact()], { ...deps, listFiles: () => ['docs/notes.md', 'src/probe.ts'], readFile: (path: string) => {
    if (path.endsWith('docs/notes.md')) throw new Error('mention read failed');
    return readFileSync(path, 'utf8');
  } }).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.failures).toEqual([]);
  expect(item.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'behavior' && row.path === 'src/probe.ts')).toBe(true);
});

test('failed document read with no implementation match is unmeasured, not absent', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/notes.md'), `${token} mention\n`);
  const report = runIntakeCheck([fact()], { ...deps, listFiles: () => ['docs/notes.md'], readFile: (path: string) => {
    if (path.endsWith('docs/notes.md')) throw new Error('mention read failed');
    return readFileSync(path, 'utf8');
  } });
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures.some((row) => row.includes('문서 읽기 실패'))).toBe(true);
  expect(report.goalDraftPaths).toEqual([]);
});

test('a mention only past the document read limit is not reported as absent', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'docs/long.md'), `${'filler line\n'.repeat(12_000)}${token} late mention\n`);
  const report = runIntakeCheck([fact()], deps);
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.items[0]?.evidence.some((row) => row.axis === 'repo' && row.summary.includes('128KB'))).toBe(true);
  expect(report.goalDraftPaths).toEqual([]);
});

test('repository read failure remains unmeasured', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = '${token}';\n`);
  const report = runIntakeCheck([fact()], { ...deps, readFile: (path: string) => {
    if (path.endsWith('src/probe.ts')) throw new Error('source read failed');
    return readFileSync(path, 'utf8');
  } });
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures).toContain('source read failed');
  expect(report.goalDraftPaths).toEqual([]);
});

test('negative claim from a fake preprocessing caller is normalized with both wordings', async () => {
  const deps = fakeRepo();
  const original = `elanous 는 ${token} 를 0건 보유한다`;
  const report = await runIntakeCheckDocument([], { ...deps, preprocess: () => JSON.stringify({
    claims: [{ text: original, quote: 'external quote', lens: 'L1 능력' }], discards: [],
  }) }, { document: 'external quote' });
  expect(report.items[0]?.fact).toBe(`elanous 에 ${token} 가 있다`);
  expect(report.items[0]?.originalClaims).toEqual([original]);
  expect((intakeCheckReportJson(report).items as Array<{ originalClaims?: string[] }>)[0]?.originalClaims).toEqual([original]);
  expect(renderIntakeCheckReport(report)).toContain(`원 주장: ${original}`);
});

test('existence denial from the preprocessing caller is discarded before comparison', async () => {
  const deps = fakeRepo();
  const original = `elanous 에 ${token} 가 존재하지 않다`;
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = '${token}';\n`);
  const report = await runIntakeCheckDocument([], { ...deps, preprocess: () => JSON.stringify({
    claims: [{ text: original, quote: 'external quote', lens: 'L1 능력' }], discards: [],
  }) }, { document: 'external quote' });
  expect(report.items).toEqual([]);
  expect(report.keptClaims).toBe(0);
  expect(report.discards?.[0]?.reason).toContain(original);
  expect(report.discards?.[0]?.reason).toContain('부정형');
  expect(renderIntakeCheckReport(report)).toContain(`버림: external quote — ${report.discards?.[0]?.reason}`);
});

test('zero-count variants and other negative markers cannot be compared as affirmative claims', async () => {
  const deps = fakeRepo();
  for (const suffix of ['0개 보유한다', '보유하지 않는다', '보유하지 못한다', '없음', '못 한다', '아니다']) {
    const original = `elanous 는 ${token} 를 ${suffix}`;
    const report = await runIntakeCheckDocument([], { ...deps, preprocess: () => JSON.stringify({
      claims: [{ text: original, quote: 'external quote', lens: 'L1 능력' }], discards: [],
    }) }, { document: 'external quote' });
    expect(report.items.every((item) => !item.fact.includes(suffix))).toBe(true);
    if (report.items.length === 0) expect(report.discards?.[0]?.reason).toContain(original);
    else expect(report.items[0]?.originalClaims).toEqual([original]);
  }
});

test('colloquial denial is discarded before comparison with its reason', async () => {
  const deps = fakeRepo();
  for (const phrase of [`elanous 는 ${token} 를 안 한다`, `elanous 는 ${token} 가 안 된다`]) {
    const report = await runIntakeCheckDocument([], { ...deps, preprocess: () => JSON.stringify({
      claims: [{ text: phrase, quote: 'external quote', lens: 'L1 능력' }], discards: [],
    }) }, { document: 'external quote' });
    expect(report.items).toEqual([]);
    expect(report.discards?.[0]?.reason).toContain(phrase);
  }
});

test('unknown negative form is discarded with a reason; production prompt requests affirmative claims', async () => {
  const deps = fakeRepo();
  const report = await runIntakeCheckDocument([], { ...deps, preprocess: () => JSON.stringify({
    claims: [{ text: `elanous 는 ${token} 를 지원하지 않는다`, quote: 'external quote', lens: 'L1 능력' }], discards: [],
  }) }, { document: 'external quote' });
  expect(report.items).toEqual([]);
  expect(report.discards?.[0]?.reason).toContain('부정형');
  let prompt = '';
  const stages = buildIntakeDocumentStageCallables({ resolveRoleProvider: () => ({ provider: { name: 'stub' } }),
    streamLLM: async (messages) => { prompt = messages[0]?.content ?? ''; return '{"claims":[],"discards":[{"quote":"x","reason":"y"}]}'; } });
  await stages.preprocess({ document: 'external quote', lenses: ['L1 능력'] });
  expect(prompt).toContain('반드시 긍정형 존재·능력 문장');
  expect(prompt).toContain('0건 보유한다');
  expect(prompt).toContain('안 한다');
});

test('a doc comment after a template literal with an expression is still a comment mention', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/desync.ts'), [
    'const label = `left ${1 + 1} right`;',
    `/** ${token} appears only in this doc comment */`,
    'export const value = label;',
    '',
  ].join('\n'));
  const item = runIntakeCheck([fact()], deps).items[0]!;
  expect(item.verdict).not.toBe('있음');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'comment' && row.path === 'src/desync.ts')).toBe(true);
});

test('an injected file list keeps later document mentions after executable support', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/probe.ts'), `export const probe = 'elanous ${token} records';\n`);
  writeFileSync(join(deps.root, 'docs/notes.md'), `${token} mention\n`);
  const claim = { text: `elanous 는 \`${token}\` 를 records` };
  const item = runIntakeCheck([claim], { ...deps, listFiles: () => ['src/probe.ts', 'docs/notes.md'] }).items[0]!;
  expect(item.verdict).toBe('있음');
  expect(item.evidence.some((row) => row.axis === 'repo' && row.repoKind === 'document' && row.path === 'docs/notes.md')).toBe(true);
});

test('a refusing entrance line cannot supply behavioral support next to a neutral executable line', () => {
  const deps = fakeRepo();
  writeFileSync(join(deps.root, 'src/refuse.ts'), `export const refuse = 'elanous ${token} records: unknown option';\n`);
  writeFileSync(join(deps.root, 'src/neutral.ts'), `export const neutral = '${token}';\n`);
  const item = runIntakeCheck([{ text: `elanous 는 \`${token}\` 를 records` }], deps).items[0]!;
  expect(item.verdict).not.toBe('있음');
});
