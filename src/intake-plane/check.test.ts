import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deriveRuler, intakeCheckReportJson, renderIntakeCheckReport, runIntakeCheck } from './check.js';

test('replacement candidate requires the tool to replace the paid dependency, not the reverse', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-replacement-'));
  const ruler = { capabilities: [], surfaces: [], promises: [], failures: [] };
  const trial = { installation: '미검증', sampleRun: '미검증', license: '미검증', maintenanceStatus: '미검증' } as const;
  try {
    const facts = [
      '유료 `firecrawl` 을 `crawlerkit` 이 대체할 수 있다',
      '`crawlerkit` 이 유료 `firecrawl` 을 대체할 수 있다',
      '유료 `firecrawl` 이 `crawlerkit` 을 대체할 수 있다',
      '`crawlerkit` can replace paid `firecrawl`',
      'paid `firecrawl` can replace `crawlerkit`',
      '유료 `firecrawl` 과 `crawlerkit` 을 비교한다',
      '`crawlerkit`이 유료 `firecrawl`을 대체하지 않는다',
      '`crawlerkit`이 유료 `firecrawl`을 대체하지는 않는다',
      '`crawlerkit`이 유료 `firecrawl`을 대체할 수는 없다',
    ];
    const report = runIntakeCheck(facts.map((text) => ({ text })), {
      root, readFile: (path) => readFileSync(path, 'utf8'), listFiles: () => [],
      commit: () => 'test', draftDir: join(root, 'drafts'), log: () => {},
    }, { ruler });
    for (const index of [0, 1, 3]) {
      const item = report.items[index]!;
      expect(item.verdict).toBe('판단 필요');
      expect(item.replacementCandidate).toEqual({ tool: 'crawlerkit', paidDependency: 'firecrawl', status: '현장 시험 필요', trial });
      expect(item.goalDraftPath).toBeUndefined();
      expect(renderIntakeCheckReport(report)).toContain('대체 후보: crawlerkit → 유료 의존성 firecrawl (현장 시험 필요)');
      expect((intakeCheckReportJson(report).items as typeof report.items)[index]!.replacementCandidate).toEqual(item.replacementCandidate);
    }
    for (const index of [2, 4, 5, 6, 7, 8]) {
      expect(report.items[index]!.replacementCandidate).toBeUndefined();
      expect(report.items[index]!.current).not.toContain('대체 후보');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository documentation alone cannot prove a capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-doc-only-'));
  const token = ['probe', 'doc', 'capability', '7'].join('-');
  try {
    for (const dir of ['catalog', 'src/cli', 'docs']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'catalog/resources.yaml'), 'resources: []\n');
    writeFileSync(join(root, 'catalog/external-commands.yaml'), 'commands: []\n');
    writeFileSync(join(root, 'src/index.ts'), '');
    writeFileSync(join(root, 'docs/FAQ.md'), '# FAQ\n');
    writeFileSync(join(root, 'docs/PRFAQ-elanous-docs-working-backwards-2026-09-22.md'), '# FAQ\n');
    writeFileSync(join(root, 'docs/notes.md'), `${token} is mentioned\n`);
    const item = runIntakeCheck([{ text: `elanous 에 \`${token}\` 가 있다` }], {
      root, readFile: (path) => readFileSync(path, 'utf8'), commit: () => 'test',
      draftDir: join(root, 'drafts'), log: () => {},
    }).items[0]!;
    expect(item.verdict).toBe('판단 필요');
    expect(item.evidence.some((row) => row.repoKind === 'document' && row.path === 'docs/notes.md')).toBe(true);
    expect(item.evidence.some((row) => row.repoKind === 'behavior')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI command and option surfaces survive moving from index to a nested cli file', () => {
  const roots = [mkdtempSync(join(tmpdir(), 'intake-index-')), mkdtempSync(join(tmpdir(), 'intake-cli-'))];
  try {
    const rulers = roots.map((root, index) => {
      for (const dir of ['catalog', 'src/cli/nested', 'docs']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, 'catalog/resources.yaml'), 'resources: []\n');
      writeFileSync(join(root, 'catalog/external-commands.yaml'), 'commands: []\n');
      writeFileSync(join(root, 'docs/FAQ.md'), '# FAQ\n');
      writeFileSync(join(root, 'docs/PRFAQ-elanous-docs-working-backwards-2026-09-22.md'), '# FAQ\n');
      const declarations = "program.command('alpha')\n  .option('--beta', '설명');\n";
      writeFileSync(join(root, 'src/index.ts'), index === 0 ? declarations : 'registerAlpha(program);\n');
      if (index === 1) {
        writeFileSync(join(root, 'src/cli/nested/alpha-cli.ts'), declarations);
        writeFileSync(join(root, 'src/cli/nested/alpha-cli.test.ts'), "program.command('test-only').option('--test-only', 'ignore');\n");
      }
      return deriveRuler({ root, readFile: (path) => readFileSync(path, 'utf8') });
    });
    expect(rulers[0]!.failures).toEqual([]);
    expect(rulers[1]!.failures).toEqual([]);
    expect(rulers.map((ruler) => ruler.surfaces.map((surface) => surface.name).sort())).toEqual([
      ['--beta', 'alpha'], ['--beta', 'alpha'],
    ]);
    expect(rulers[1]!.surfaces).toEqual([
      { name: 'alpha', source: 'src/cli/nested/alpha-cli.ts', line: 1 },
      { name: '--beta', source: 'src/cli/nested/alpha-cli.ts', line: 2, description: '설명' },
    ]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('CLI surfaces deduplicate across files by command name or option name and description', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-dedup-'));
  try {
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), "program.command('alpha');\nprogram.option('--beta', '설명');\n");
    writeFileSync(join(root, 'src/cli/alpha-cli.ts'), "program.command('alpha');\nprogram.option('--beta', '설명');\nprogram.option('--beta', '다른 설명');\n");
    const surfaces = deriveRuler({ root, readFile: (path) => readFileSync(path, 'utf8') }).surfaces;
    expect(surfaces).toEqual([
      { name: 'alpha', source: 'src/index.ts', line: 1 },
      { name: '--beta', source: 'src/index.ts', line: 2, description: '설명' },
      { name: '--beta', source: 'src/cli/alpha-cli.ts', line: 3, description: '다른 설명' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unreadable or missing cli sources are surface failures rather than absence', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-cli-failure-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), "program.command('alpha');\n");
    const readFile = (path: string) => readFileSync(path, 'utf8');
    const missing = deriveRuler({ root, readFile });
    expect(missing.surfaces.map((surface) => surface.name)).toEqual(['alpha']);
    expect(missing.failures.some((failure) => failure.axis === 'surface' && failure.pattern === 'src/cli' && !!failure.failure)).toBe(true);

    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'src/cli/alpha-cli.ts'), "program.command('beta');\n");
    const unreadable = deriveRuler({ root, readFile: (path) => {
      if (path === join(root, 'src/cli/alpha-cli.ts')) throw new Error('cli read denied');
      return readFile(path);
    } });
    expect(unreadable.surfaces.map((surface) => surface.name)).toEqual(['alpha']);
    expect(unreadable.failures).toContainEqual({
      axis: 'surface', summary: 'src/cli/alpha-cli.ts 를 읽지 못했다', failure: 'cli read denied', pattern: 'src/cli/alpha-cli.ts',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual repository CLI surfaces include migrated commands without losing index surfaces', () => {
  const root = resolve(import.meta.dir, '../..');
  const ruler = deriveRuler({ root, readFile: (path) => readFileSync(path, 'utf8') });
  expect(ruler.failures.filter((failure) => failure.axis === 'surface')).toEqual([]);
  expect(ruler.surfaces.length).toBeGreaterThanOrEqual(1052);
  for (const name of ['repo', 'control', 'pr']) {
    expect(ruler.surfaces.some((surface) => surface.name === name && surface.source.startsWith('src/cli/'))).toBe(true);
  }
});
