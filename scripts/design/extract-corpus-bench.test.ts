import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CORPUS,
  parseCorpus,
  renderHuman,
  runBench,
  type SiteRun,
  type SiteRunner,
} from './extract-corpus-bench';

const CORPUS = [
  'dev\tsaas\thttps://linear.app',
  'dev\tblog\thttps://overreacted.io',
  'holdout\tfolio\thttps://dribbble.com',
].join('\n');

function css(ok: boolean): string {
  if (!ok) return '/* ⚪ --font-display: no */\n--bg: white;\n';
  return [
    '--bg: white;',
    '--fg: #111111;',
    '--accent: #2f6feb;',
    '--font-display: serif;',
    '--font-body: sans-serif;',
    '--text-base: 16px;',
  ].join('\n');
}

function runner(byUrl: Record<string, { css: string; painted: number; sec: number }>): SiteRunner {
  return async (site) => {
    const spec = byUrl[site.url]!;
    return {
      sec: spec.sec,
      fromUrl: { id: site.id, saved: true, tokensCss: spec.css, extractDir: '' },
      tokensJson: { paintedColors: { text: { ink: spec.painted } } },
    };
  };
}

describe('extract-corpus-bench', () => {
  test('fake runner over 3 sites writes index, STAMP, and a per-set table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-bench-'));
    const corpusPath = join(dir, 'sites.tsv');
    writeFileSync(corpusPath, `${CORPUS}\n`);
    const outDir = join(dir, 'out');
    const result = await runBench({
      corpusPath,
      outDir,
      repeat: 1,
      json: false,
      showHoldout: false,
      repoRoot: dir,
      commit: 'abc1234',
      now: new Date('2026-09-28T06:00:00.000Z'),
      runSite: runner({
        'https://linear.app': { css: css(true), painted: 40, sec: 4.2 },
        'https://overreacted.io': { css: css(false), painted: 30, sec: 3.1 },
        'https://dribbble.com': { css: css(true), painted: 50, sec: 5 },
      }),
    });
    const stamp = readFileSync(join(outDir, 'STAMP'), 'utf8');
    expect(stamp).toContain('commit=abc1234');
    expect(stamp).toContain('date=2026-09-28T06:00:00.000Z');
    expect(stamp).toContain('corpusSha=');
    const index = readFileSync(join(outDir, 'index.tsv'), 'utf8');
    expect(index.split('\n')[0]).toBe('set\tcategory\tid\turl\trepeat\tsec\tok\tcore\tcontrast\taccentOk\tpainted\tempty\terror');
    expect(index).toContain('dev\tsaas\tlinear.app');
    expect(index).toContain('holdout\tfolio\tdribbble.com');
    const rows = index.trim().split('\n').slice(1);
    const over = rows.find((row) => row.includes('overreacted.io'));
    expect(over?.split('\t')[6]).toBe('0');
    const linear = rows.find((row) => row.includes('linear.app'));
    expect(linear?.split('\t')[6]).toBe('1');
    expect(result.human).toContain('dev');
    expect(result.human).toContain('holdout');
    expect(result.human).toMatch(/coreAvg=/);
    const sites = parseCorpus(CORPUS);
    expect(sites.map((s) => s.id)).toEqual(['linear.app', 'overreacted.io', 'dribbble.com']);
  });

  test('human output hides holdout site rows but the set table still has holdout numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-bench-'));
    const corpusPath = join(dir, 'sites.tsv');
    writeFileSync(corpusPath, `${CORPUS}\n`);
    const result = await runBench({
      corpusPath,
      outDir: join(dir, 'out'),
      repeat: 1,
      json: false,
      showHoldout: false,
      repoRoot: dir,
      commit: 'def',
      now: new Date('2026-09-28T06:00:00.000Z'),
      runSite: runner({
        'https://linear.app': { css: css(false), painted: 10, sec: 1 },
        'https://overreacted.io': { css: css(true), painted: 40, sec: 2 },
        'https://dribbble.com': { css: css(false), painted: 0, sec: 9 },
      }),
    });
    expect(result.human).not.toContain('https://dribbble.com');
    expect(result.human).not.toContain('dribbble.com');
    const holdoutLine = result.human.split('\n').find((l) => l.startsWith('holdout'));
    expect(holdoutLine).toBeDefined();
    expect(holdoutLine).toContain('n=1');
    expect(holdoutLine).toContain('empty=1');
    expect(result.human).toContain('linear.app');
  });

  test('empty captures are counted aside and removed from the contrast and accent denominators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-bench-'));
    const corpusPath = join(dir, 'sites.tsv');
    writeFileSync(corpusPath, 'dev\tsaas\thttps://linear.app\ndev\tblog\thttps://overreacted.io\n');
    const result = await runBench({
      corpusPath,
      outDir: join(dir, 'out'),
      repeat: 1,
      json: false,
      showHoldout: false,
      repoRoot: dir,
      commit: 'ghi',
      now: new Date('2026-09-28T06:00:00.000Z'),
      runSite: runner({
        'https://linear.app': { css: css(true), painted: 0, sec: 1 },
        'https://overreacted.io': { css: css(true), painted: 40, sec: 2 },
      }),
    });
    const all = result.human.split('\n').find((l) => l.startsWith('all'));
    expect(all).toContain('empty=1');
    expect(all).toContain('contrast=1/1');
    expect(all).toContain('accent=1/1');
  });

  test('--compare prints before → after for each summary cell', () => {
    const site = (id: string, core: number, empty: boolean): SiteRun => ({
      site: { set: 'dev', category: 'saas', url: `https://${id}`, id },
      repeat: 0,
      sec: 4,
      okRun: true,
      score: { core, contrast: 21, accentOk: core === 6, painted: empty ? 0 : 30, empty },
      reportedId: id,
      provenance: '',
    });
    const before = new Map<string, SiteRun>([['linear.app', site('linear.app', 4, false)]]);
    const human = renderHuman({
      stamp: { commit: 'old', date: '2026-09-28T00:00:00.000Z', corpusSha: 'aa', corpus: 'sites-v1.tsv' },
      runs: [site('linear.app', 6, false)],
      showHoldout: false,
      compare: before,
    });
    expect(human).toContain('compare');
    expect(human).toContain('4.00 → 6.00');
    expect(human).toContain('0 → 1');
  });

  test('a timeout with no tokens.json is not an EMPTY row and stays out of the accent denominator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-bench-'));
    const corpusPath = join(dir, 'sites.tsv');
    writeFileSync(corpusPath, 'dev\tsaas\thttps://linear.app\ndev\tblog\thttps://overreacted.io\n');
    const result = await runBench({
      corpusPath,
      outDir: join(dir, 'out'),
      repeat: 1,
      json: false,
      showHoldout: false,
      repoRoot: dir,
      commit: 'unk',
      now: new Date('2026-09-28T06:00:00.000Z'),
      runSite: async (site) => {
        if (site.url.endsWith('linear.app')) {
          return { sec: 90, fromUrl: {}, tokensJson: null, error: 'timeout 90000ms' };
        }
        return {
          sec: 2,
          fromUrl: { id: site.id, saved: true, provenance: { via: 'stub' }, tokensCss: css(true) },
          tokensJson: { paintedColors: { text: { ink: 40 } } },
        };
      },
    });
    expect(result.human).not.toContain('EMPTY');
    expect(result.human).toContain('paint=unknown');
    const all = result.human.split('\n').find((l) => l.startsWith('all'));
    expect(all).toContain('empty=0');
    expect(all).toContain('accent=1/1');
    const index = readFileSync(join(dir, 'out', 'index.tsv'), 'utf8');
    const linear = index.trim().split('\n').find((row) => row.includes('linear.app'));
    const cells = linear?.split('\t') ?? [];
    expect(cells[6]).toBe('0');
    expect(cells[10]).toBe('');
    expect(cells[11]).toBe('');
    const saved = JSON.parse(readFileSync(join(dir, 'out', 'overreacted.io.json'), 'utf8')) as SiteRun;
    expect(saved.reportedId).toBe('overreacted.io');
    expect(saved.saved).toBe(true);
    expect(saved.provenance).toContain('stub');
  });

  test('shake lines omit holdout hosts unless --show-holdout', () => {
    const run = (set: 'dev' | 'holdout', id: string, core: number, repeat: number): SiteRun => ({
      site: { set, category: 'folio', url: `https://${id}`, id },
      repeat,
      sec: 1,
      okRun: true,
      score: { core, contrast: 21, accentOk: true, painted: 30, empty: false },
      reportedId: id,
      provenance: '',
    });
    const hidden = renderHuman({
      stamp: { commit: 's', date: '2026-09-28T00:00:00.000Z', corpusSha: 'aa', corpus: 'sites-v1.tsv' },
      runs: [
        run('dev', 'linear.app', 6, 0),
        run('dev', 'linear.app', 4, 1),
        run('holdout', 'dribbble.com', 6, 0),
        run('holdout', 'dribbble.com', 0, 1),
      ],
      showHoldout: false,
    });
    expect(hidden).toContain('linear.app');
    expect(hidden).not.toContain('dribbble.com');
    const shown = renderHuman({
      stamp: { commit: 's', date: '2026-09-28T00:00:00.000Z', corpusSha: 'aa', corpus: 'sites-v1.tsv' },
      runs: [
        run('holdout', 'dribbble.com', 6, 0),
        run('holdout', 'dribbble.com', 0, 1),
      ],
      showHoldout: true,
    });
    expect(shown).toContain('dribbble.com');
  });

  test('sites-v1.tsv is the default corpus: 32 sites, 16 dev, 16 holdout, 11 categories', () => {
    const text = readFileSync(new URL(`../../${DEFAULT_CORPUS}`, import.meta.url), 'utf8');
    const sites = parseCorpus(text);
    expect(sites).toHaveLength(32);
    expect(sites.filter((s) => s.set === 'dev')).toHaveLength(16);
    expect(sites.filter((s) => s.set === 'holdout')).toHaveLength(16);
    expect(new Set(sites.map((s) => s.category)).size).toBe(11);
    expect(DEFAULT_CORPUS).toBe('docs/design/corpus/sites-v1.tsv');
  });

  test('runBench without runSite spawns PATH bun with only --test=<out>/universe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-bench-'));
    const argvLog = join(dir, 'argv.log');
    writeFileSync(join(dir, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\nprintf '%s\\n' '{"id":"linear.app","saved":true,"provenance":"stub","tokensCss":"--bg: white; --fg: #111; --accent: #36c; --font-display: serif; --font-body: sans; --text-base: 16px;"}'\n`);
    chmodSync(join(dir, 'bun'), 0o755);
    writeFileSync(join(dir, 'sites.tsv'), 'dev\tsaas\thttps://linear.app\n');
    const repoRoot = join(dir, 'repo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(repoRoot, { recursive: true });
    const outDir = join(dir, 'out');
    const prev = process.env.PATH;
    process.env.PATH = `${dir}${prev ? `:${prev}` : ''}`;
    try {
      await runBench({
        corpusPath: join(dir, 'sites.tsv'),
        outDir,
        repeat: 1,
        json: false,
        showHoldout: false,
        repoRoot,
        commit: 'iso',
        now: new Date('2026-09-28T06:00:00.000Z'),
      });
    } finally {
      process.env.PATH = prev;
    }
    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    const testArg = argv.find((a) => a.startsWith('--test='));
    expect(testArg).toBe(`--test=${join(outDir, 'universe')}`);
    expect(argv.some((a) => a.startsWith('--test=') && !a.endsWith('/universe'))).toBe(false);
    expect(argv.join('\n')).not.toContain('--test=/.elanous');
    expect(argv).toContain('repo');
    expect(argv).toContain('from-url');
  });
});
