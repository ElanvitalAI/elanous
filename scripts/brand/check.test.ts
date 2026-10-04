import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkBrand } from './check.js';

const cli = join(import.meta.dir, 'check.ts');
const rules = join(import.meta.dir, '../../docs/brand/brand-rules.yaml');
const run = (scope: string, paths: string[], rulePath = rules, json = false) => spawnSync(process.execPath,
  [cli, '--scope', scope, ...paths, '--rules', rulePath, ...(json ? ['--json'] : [])], { encoding: 'utf8' });

test('real rule file compiles and four public fixtures have exact findings and exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-check-'));
  try {
    const english = join(dir, 'english-en.md');
    const ui = join(dir, 'ui.md');
    const site = join(dir, 'site.md');
    const clean = join(dir, 'clean.md');
    writeFileSync(english, 'available now\n/Users/alice/x\n한국어 한 줄\n');
    writeFileSync(ui, '```ts\nlabel: "저장"\n```\n> `button: "저장"`\n');
    writeFileSync(site, '---\nlang: ko\n---\nElanous is here. 완전 자율\n');
    writeFileSync(clean, 'Elanous is a tool.\n');
    for (const [scope, file, status, ids] of [
      ['public-docs', english, 1, ['B2', 'B7', 'B11']],
      ['public-docs', ui, 0, []],
      ['site', site, 1, ['BRAND-AUTONOMY']],
      ['public-docs', clean, 0, []],
    ] as const) {
      const result = run(scope, [file]);
      expect(result.status).toBe(status);
      expect(result.stderr).toBe('');
      expect(result.stdout.split('\n').filter((line) => line.startsWith(`${file}:`)).map((line) => line.split(':')[2])).toEqual([...ids]);
      expect(result.stdout).toContain(`brand-check ${scope} files=1 findings=${ids.length} rules=`);
      expect(readFileSync(file, 'utf8')).toBe(file === english ? 'available now\n/Users/alice/x\n한국어 한 줄\n'
        : file === ui ? '```ts\nlabel: "저장"\n```\n> `button: "저장"`\n'
          : file === site ? '---\nlang: ko\n---\nElanous is here. 완전 자율\n' : 'Elanous is a tool.\n');
    }
    const missing = run('public-docs', [english], join(dir, 'missing.yaml'));
    expect(missing.status).toBe(0);
    expect(missing.stdout.trim()).toBe('규칙 없음');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B8 private markers and host names fail; rule-level code exemption does not bypass B2 or B8', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-private-'));
  try {
    const file = join(dir, 'draft.md');
    // The CEO mark is written as an escape so this test file itself carries no ceo-mark into the public export.
    writeFileSync(file, '\u{1F451} RFC-secret\nmbp.tailnet\n```text\navailable now\n\u{1F451}\n```\n');
    const result = run('skill', [file], rules, true);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).findings.map((finding: { id: string }) => finding.id)).toEqual([
      'B8', 'B8', 'BRAND-PRIVATE-HOST', 'B2', 'B8',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B7 exempts reader placeholders but rejects real home paths and tailnet hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-placeholders-'));
  try {
    const placeholders = join(dir, 'placeholders.md');
    const privateAddresses = join(dir, 'private.md');
    writeFileSync(placeholders, '/Users/me/Q3.pdf\nhttps://home.<your-tailnet>.ts.net:8413\n/Users/you/chart.png\n/Users/<reader>/chart.png\n');
    writeFileSync(privateAddresses, '/Users/alice/secret\nx.tail1a2b3c.ts.net\n/Users/me/Q3.pdf /Users/alice/secret\nhttps://home.<your-tailnet>.ts.net:8413 x.tail1a2b3c.ts.net\n');
    expect(checkBrand('public-docs', [placeholders]).findings).toEqual([]);
    expect(checkBrand('public-docs', [privateAddresses]).findings.filter((finding) => finding.id === 'B7'))
      .toMatchObject([{ file: privateAddresses, line: 1, id: 'B7' },
        { file: privateAddresses, line: 2, id: 'B7' }, { file: privateAddresses, line: 2, id: 'B7' },
        { file: privateAddresses, line: 3, id: 'B7' }, { file: privateAddresses, line: 4, id: 'B7' },
        { file: privateAddresses, line: 4, id: 'B7' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BRAND-FORMER-NAME exempts same-line migration notices, not other uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-former-name-'));
  try {
    const migration = join(dir, 'migration.md');
    const promotion = join(dir, 'promotion.md');
    writeFileSync(migration, 'Coming from **monad** (0.1.x)?\nMoving from monad\nElanous is monad renamed.\n');
    writeFileSync(promotion, 'Install monad with brew\n## Moving from monad\nInstall monad with brew\nmonad update\n');
    expect(checkBrand('public-docs', [migration]).findings).toEqual([]);
    expect(checkBrand('public-docs', [promotion]).findings.filter((finding) => finding.id === 'BRAND-FORMER-NAME'))
      .toMatchObject([{ file: promotion, line: 1, id: 'BRAND-FORMER-NAME' },
        { file: promotion, line: 3, id: 'BRAND-FORMER-NAME' },
        { file: promotion, line: 4, id: 'BRAND-FORMER-NAME' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('four shipped public documents have no B7 or BRAND-FORMER-NAME findings', () => {
  const paths = ['tui.md', 'multi-machine.md', 'install.md', 'update-and-uninstall.md']
    .map((name) => join(import.meta.dir, '../../release/public/docs', name));
  const result = checkBrand('public-docs', paths);
  expect(result.files).toBe(4);
  expect(result.findings.filter((finding) => finding.id === 'B7' || finding.id === 'BRAND-FORMER-NAME')).toEqual([]);
});

test('canonical glossary provides internal-to-public mapping and marks private vocabulary', () => {
  const document = parseYaml(readFileSync(rules, 'utf8')) as { glossary: Array<{ internal: string; public: string; publicForbidden: boolean }> };
  expect(document.glossary).toEqual([
    // Review round 3: everyday Korean words are a mapping for writers, not a forbid list (B11 already guards English docs).
    { internal: '자리', public: 'seat', publicForbidden: false },
    { internal: '하니스', public: 'harness', publicForbidden: false },
    { internal: '판', public: 'release', publicForbidden: false },
    { internal: '칸', public: 'checklist item', publicForbidden: false },
  ]);
});

test('publicForbidden glossary terms produce CLI findings and B11 scans English site prose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-glossary-'));
  try {
    const file = join(dir, 'public.md');
    writeFileSync(file, '자리\n');
    // The forbid mechanism stays: a rules file that marks a term publicForbidden still produces a finding.
    const forbidRules = join(dir, 'rules.yaml');
    writeFileSync(forbidRules, readFileSync(rules, 'utf8').replace("internal: 자리\n    public: seat\n    publicForbidden: false", "internal: 자리\n    public: seat\n    publicForbidden: true"));
    const result = run('public-docs', [file], forbidRules);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${file}:1:GLOSSARY-자리:자리`);
    const site = join(dir, 'site.md');
    writeFileSync(site, 'Read the guide.\n한국어 설명\n');
    const siteResult = run('site', [site]);
    expect(siteResult.status).toBe(1);
    expect(siteResult.stdout).toContain(`${site}:2:B11:한`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowInCode exempts only confirmed quoted UI values, not lookalike prose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-code-'));
  try {
    const file = join(dir, 'english-en.md');
    writeFileSync(file, '```text\n한국어 UI 문자열\n한국어 설명\n```\n> 한국어 UI 문자열\n> 한국어 설명\n> UI 문자열: 저장; 한국어 설명\n```ts\nlabel: "저장"; note: "한국어 설명"\n한국어 설명 UI 문자열\n```\n> `button: "저장"`\n');
    const result = run('public-docs', [file], rules, true);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).findings).toMatchObject([
      { file, line: 2, id: 'B11' },
      { file, line: 3, id: 'B11' },
      { file, line: 5, id: 'B11' },
      { file, line: 6, id: 'B11' },
      { file, line: 7, id: 'B11' },
      { file, line: 9, id: 'B11' },
      { file, line: 10, id: 'B11' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('site language metadata and body text, not HTML markup, govern B11', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-lang-'));
  try {
    const ko = join(dir, 'ko.html');
    const en = join(dir, 'en.html');
    const inferredKo = join(dir, 'ko-unmarked.html');
    const inferredEn = join(dir, 'en-unmarked.html');
    const script = join(dir, 'en-script.html');
    writeFileSync(ko, '<html lang="ko"><head><meta charset="utf-8"></head><body><div class="text">한국어 소개</div></body></html>');
    writeFileSync(en, '<html lang="en"><body><p>한국어 설명</p></body></html>');
    writeFileSync(inferredKo, '<html><head><title>한국어</title></head><body><div class="text">한국어 소개</div></body></html>');
    writeFileSync(inferredEn, '<html><body><p>Read the guide.</p><p>한국어 설명</p></body></html>');
    writeFileSync(script, '<html lang="en">\n<script>const x = "한국어";</script>\n<p>Read the guide.</p>\n<p>한국어 설명</p>\n</html>');
    for (const [file, expected] of [[ko, 0], [en, 1], [inferredKo, 0], [inferredEn, 1], [script, 1]] as const) {
      const result = run('site', [file], rules, true);
      expect(result.status).toBe(expected);
      expect(JSON.parse(result.stdout).findings.filter((finding: { id: string }) => finding.id === 'B11')).toHaveLength(expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B11 defers for Korean and undecidable public documents, and reads explicit language across scopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-doc-lang-'));
  try {
    for (const scope of ['public-docs', 'release-notes', 'deck', 'skill'] as const) {
      const ko = join(dir, `${scope}-ko.md`);
      const unknown = join(dir, `${scope}-unknown.md`);
      const en = join(dir, `${scope}-en.md`);
      writeFileSync(ko, '---\nlang: ko\n---\n한국어 정상 본문입니다.\n');
      writeFileSync(unknown, '한국어 정상 본문입니다.\n');
      writeFileSync(en, '---\nlang: en\n---\n한국어 설명\n');
      for (const file of [ko, unknown]) {
        const result = run(scope, [file], rules, true);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).findings).toEqual([]);
      }
      const result = run(scope, [en], rules, true);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).findings).toMatchObject([{ file: en, line: 4, id: 'B11' }]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B11 sees English HTML title and image alt but not markup, metadata or scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-visible-html-'));
  try {
    const file = join(dir, 'index.html');
    writeFileSync(file, '<html lang="en">\n<head><title>한국어 제목</title><meta name="description" content="한국어 속성"></head>\n<body><img src="x.png" alt="한국어 그림" title="한국어 비표시 속성">\n<script>const label = "한국어 코드";</script>\n</body></html>');
    const result = run('site', [file], rules, true);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).findings.filter((finding: { id: string }) => finding.id === 'B11')).toMatchObject([
      { file, line: 2, id: 'B11', match: '한' },
      { file, line: 3, id: 'B11', match: '한' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('folder scope, JSON, former-name exception, and rules-only configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-scopes-'));
  try {
    const file = join(dir, 'draft-en.md');
    writeFileSync(file, 'formerly monad; monad\nmonad\nELANOUS\n곧\n');
    const site = run('site', [dir], rules, true);
    expect(site.status).toBe(1);
    expect(JSON.parse(site.stdout)).toMatchObject({ scope: 'site', files: 1, findings: [
      { file, line: 1, id: 'BRAND-FORMER-NAME', match: 'monad' },
      { file, line: 2, id: 'BRAND-FORMER-NAME', match: 'monad' },
      { file, line: 3, id: 'BRAND-NAME', match: 'ELANOUS' },
      { file, line: 4, id: 'B11', match: '곧' },
      { file, line: 4, id: 'BRAND-SOON', match: '곧' },
    ] });
    writeFileSync(file, readFileSync(file, 'utf8') + 'Logo: ELANOUS\n# 사람에게 묻는다\n');
    const siteWithHeadline = run('site', [file], rules, true);
    expect(JSON.parse(siteWithHeadline.stdout).findings.map((finding: { id: string }) => finding.id)).toContain('BRAND-HEADLINE');
    expect(JSON.parse(siteWithHeadline.stdout).findings.filter((finding: { id: string }) => finding.id === 'BRAND-NAME')).toHaveLength(1);
    const doc = run('public-docs', [file], rules, true);
    expect(doc.status).toBe(1);
    expect(JSON.parse(doc.stdout).findings.map((finding: { id: string }) => finding.id)).toEqual(['BRAND-FORMER-NAME', 'BRAND-FORMER-NAME', 'BRAND-NAME', 'B11', 'B11']);
    const customRules = join(dir, 'rules.yaml');
    writeFileSync(customRules, `rules:\n  - id: CUSTOM\n    kind: forbid\n    pattern: 'Elanous'\n    scope: [any]\n    why: test\n    source: test\n`);
    writeFileSync(file, 'Elanous\n');
    expect(run('skill', [file], customRules).stdout).toContain(`${file}:1:CUSTOM:Elanous`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review round 3: numbers need a source marker, marketing numbers stay round, glossary words are not forbidden', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-round3-'));
  try {
    const site = join(dir, 'site.html');
    // A source marker counts on the same line or a neighbouring one, so the fixture keeps blank lines between cases.
    writeFileSync(site, [
      '<p>설치 420만+ 줄</p>', '',                     // 1: number with unit, no source → B4
      '<p>병합 PR 2만+ <!-- src: gh pr list --state merged --limit 100000 | wc -l --></p>', '', // 3: sourced on the same line
      '<p>정확히 4,213,000 줄</p>', '',                 // 5: exact long figure → MARKETING-ROUND and B4
      '<p>이번 판의 칸과 자리를 봅니다</p>',              // 7: everyday Korean words — no glossary finding
    ].join('\n'));
    const ids = checkBrand('site', [site]).findings.map((f) => `${f.line}:${f.id}`).sort();
    expect(ids).toEqual(['1:B4-NUMBER-SOURCE', '5:B4-NUMBER-SOURCE', '5:MARKETING-ROUND']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
