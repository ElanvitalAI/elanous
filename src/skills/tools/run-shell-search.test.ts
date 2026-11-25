import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runShellScript, scriptCommandPolicy } from './run-shell-script.js';
import { isLocalRead } from '../../shell-primitive/spawn-gateway.js';
import {
  citeSearchOutput, finishRunShellSearch, planRunShellSearch, runShellSearchStrategy, type RunShellSearchDeps,
} from './run-shell-search.js';
import { dispatchRunShell, runShellSearchView } from './shell.js';
import { parseRunShellSearch } from './run-shell-search-policy.js';
import { setStaleCwdProbeForTesting } from '../../knowledge/stale-cwd.js';
import type { RunShellDispatchResult } from './shell.js';

const SOURCES = [
  { id: 'main', type: 'repo' as const, path: '/w/latest' },
  { id: 'notes', type: 'ref' as const, path: '/w/ref' },
];

function deps(over: Partial<RunShellSearchDeps> = {}, logs: Array<[string, string, Record<string, unknown>]> = []): RunShellSearchDeps {
  return {
    staleCwd: () => null,
    sources: (scope) => (scope === 'repo' ? SOURCES.filter((s) => s.type === 'repo') : SOURCES),
    exists: () => true,
    log: (c, e, d) => { logs.push([c, e, d]); },
    ...over,
  };
}
const STALE = { days: 5, cwdRoot: '/w/old', latestRoot: '/w/latest' };

describe('RunShell search allowlist (single + script)', () => {
  test('read-only search forms classify read-local', () => {
    expect(scriptCommandPolicy(['rg', '-n', 'judge load', 'docs'])).toBe('read-local');
    expect(scriptCommandPolicy(['rg', '--files', '--sort', 'path', '--iglob', '*judge*'])).toBe('read-local');
    expect(scriptCommandPolicy(['rg', '-uu', '-tmd', 'needle'])).toBe('read-local');
    expect(scriptCommandPolicy(['git', 'grep', '-n', '-e', 'needle', '--', 'docs'])).toBe('read-local');
    expect(scriptCommandPolicy(['ast-grep', 'run', '-p', 'foo($A)', '--lang', 'ts'])).toBe('read-local');
    expect(scriptCommandPolicy(['ast-grep', 'scan', '--inline-rules', 'id: x', '--files-with-matches', '.'])).toBe('read-local');
    expect(scriptCommandPolicy(['ast-grep', '-p', 'bar()', 'src'])).toBe('read-local');
    expect(scriptCommandPolicy(['eln', 'docs', 'search', 'judge load reduction'])).toBe('read-local');
    expect(scriptCommandPolicy(['eln', 'docs', 'search', 'x/y design', '--scope', 'both', '--json'])).toBe('read-local');
    expect(scriptCommandPolicy(['elanous', 'docs', 'search', 'q', '--scope', 'custom', '--source', 'main', '--path', '/w/ref'])).toBe('read-local');
  });

  test('rewrite / exec flags are refused', () => {
    expect(scriptCommandPolicy(['ast-grep', 'run', '-p', 'a', '-r', 'b'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'run', '-p', 'a', '--rewrite=b'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'scan', '-U'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'scan', '--update-all'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'run', '-p', 'a', '--interactive'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'new', 'rule'])).toBe('deny');
    expect(scriptCommandPolicy(['ast-grep', 'scan', '-c', 'rm -rf x'])).toBe('deny');
    expect(scriptCommandPolicy(['rg', '-r', 'x', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['rg', '-nr', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['rg', '--replace=x', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['rg', '--pre', 'cat', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['git', 'grep', '-O', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['git', 'grep', '--open-files-in-pager=vim', 'needle'])).toBe('deny');
    expect(scriptCommandPolicy(['eln', 'docs', 'search', 'q', '--scope', 'everything'])).toBe('deny');
    expect(scriptCommandPolicy(['eln', 'docs', 'search', 'q', '--rebuild'])).toBe('deny');
  });

  test('sg is never a read-local search (Linux sg = setgroup runs its argument)', () => {
    expect(scriptCommandPolicy(['sg', 'run', 'touch /tmp/pwn'])).toBe('deny');
    expect(scriptCommandPolicy(['sg', '-p', 'bar()', 'src'])).toBe('deny');
    expect(scriptCommandPolicy(['/usr/bin/sg', 'scan'])).toBe('deny');
    expect(isLocalRead('sg', ['run', 'touch /tmp/pwn'], '/w/old')).toBe(false);
  });

  test('single argv: the spawn gate treats search argv as a local read', () => {
    expect(isLocalRead('rg', ['-n', 'needle'], '/w/old')).toBe(true);
    expect(isLocalRead('/opt/homebrew/bin/ast-grep', ['run', '-p', 'foo()'], '/w/old')).toBe(true);
    expect(isLocalRead('git', ['grep', 'needle'], '/w/old')).toBe(true);
    expect(isLocalRead('ast-grep', ['run', '-p', 'a', '-U'], '/w/old')).toBe(false);
  });

  test('script mode: hardened git prefix still reads as git grep', () => {
    const guarded = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false', 'grep', '-n', 'needle'];
    expect(runShellSearchView(guarded, true)).toEqual(['git', 'grep', '-n', 'needle']);
    expect(isLocalRead('git', guarded.slice(1), '/w/old')).toBe(true);
  });

  test('script mode runs rg steps; no-hit exit 1 is a miss, not a failure', async () => {
    const ran: string[][] = [];
    const result = await runShellScript([
      { id: 'find', command: ['rg', '-l', 'needle'] },
      { id: 'docs', command: ['eln', 'docs', 'search', 'needle'] },
    ], undefined, 5000, async (command) => {
      ran.push(command);
      const hit = command[0] === 'eln';
      return { output: '', exitCode: hit ? 0 : 1, outcome: 'exit', elapsedMs: 1, stdout: hit ? 'one\ntwo\n' : '', stderr: '',
        truncated: false, approvalKey: 'k', sandboxed: false, sandboxTool: 'none' } satisfies RunShellDispatchResult;
    });
    expect(ran.length).toBe(2);
    expect(result.exitCode).toBe(0);
    const steps = JSON.parse(result.stdout).steps;
    expect(steps[0].search).toEqual({ hits: 0, rawBytes: 0, returnedBytes: 0 });
    expect(steps[1].search.hits).toBe(2);
    expect(steps[1].search.rawBytes).toBe(8);
  });

  test('script mode refuses an ast-grep rewrite step before anything runs', async () => {
    let calls = 0;
    await expect(runShellScript([
      { id: 'ok', command: ['rg', 'needle'] },
      { id: 'bad', command: ['ast-grep', 'run', '-p', 'a', '-r', 'b', '-U'] },
    ], undefined, 5000, async () => { calls++; throw new Error('must not run'); })).rejects.toThrow('refuses');
    expect(calls).toBe(0);
  });
});

describe('RunShell search roots parity', () => {
  test('stale cwd + no path → latest repo root added, hint lines', () => {
    const plan = planRunShellSearch(['rg', '-n', 'needle'], '/w/old', deps({ staleCwd: () => STALE }))!;
    expect(plan.argv).toEqual(['rg', '-n', 'needle', '.', '/w/latest']);
    expect(plan.hints).toEqual(['cwd tree is 5 days old — searched latest too (/w/latest)', 'also searched: repo:main']);
  });

  test('ref roots are not added to raw tools', () => {
    const plan = planRunShellSearch(['rg', 'needle'], '/w/old', deps({ staleCwd: () => STALE }))!;
    expect(plan.addedRoots).toEqual(['/w/latest']);
  });

  test('resolver throws → no roots, no hints (argv runs as written)', () => {
    const plan = planRunShellSearch(['rg', '-n', 'needle'], '/w/old', deps({
      staleCwd: () => STALE, sources: () => { throw new Error('knowledge.sources: bad JSON'); } }))!;
    expect(plan.argv).toEqual(['rg', '-n', 'needle']);
    expect(plan.addedRoots).toEqual([]);
    expect(plan.hints).toEqual([]);
  });

  test('explicit path → argv untouched', () => {
    const plan = planRunShellSearch(['rg', 'needle', 'src'], '/w/old', deps({ staleCwd: () => STALE }))!;
    expect(plan.argv).toEqual(['rg', 'needle', 'src']);
    expect(plan.hints).toEqual([]);
  });

  test('fresh cwd outside the source + markdown filter → repo root added', () => {
    const plan = planRunShellSearch(['rg', '-t', 'md', 'needle'], '/seat', deps())!;
    expect(plan.argv).toEqual(['rg', '-t', 'md', 'needle', '.', '/w/latest']);
    expect(plan.hints).toEqual(['also searched: repo:main']);
  });

  test('fresh cwd inside the source → nothing added', () => {
    const plan = planRunShellSearch(['rg', '-g', '*.md', 'needle'], '/w/latest/docs', deps())!;
    expect(plan.argv).toEqual(['rg', '-g', '*.md', 'needle']);
  });

  test('git grep on a stale tree → hint only', () => {
    const plan = planRunShellSearch(['git', 'grep', 'needle'], '/w/old', deps({ staleCwd: () => STALE }))!;
    expect(plan.argv).toEqual(['git', 'grep', 'needle']);
    expect(plan.hints).toEqual(['cwd tree is 5 days old — git grep saw only this tree (/w/latest) — repeat with rg or eln docs search']);
  });

  test('ast-grep on a stale tree → latest root added after the pattern', () => {
    const plan = planRunShellSearch(['ast-grep', 'run', '-p', 'foo($A)'], '/w/old', deps({ staleCwd: () => STALE }))!;
    expect(plan.argv).toEqual(['ast-grep', 'run', '-p', 'foo($A)', '.', '/w/latest']);
  });
});

describe('RunShell search citations', () => {
  test('match output: the path: prefix of relative and absolute paths becomes repo:/ref:', () => {
    const out = citeSearchOutput('src/a.ts:3:foo\n/w/ref/notes/x.md:1:y\n/elsewhere/z.md:2:q\n', '/w/latest', SOURCES, 'match', () => true);
    expect(out).toBe('repo:main/src/a.ts:3:foo\nref:notes/notes/x.md:1:y\n/elsewhere/z.md:2:q\n');
  });

  test('list output (-l / --files): the whole line is the path', () => {
    expect(citeSearchOutput('README.md\ndocs/plan.md\n', '/w/latest', SOURCES, 'list', () => true))
      .toBe('repo:main/README.md\nrepo:main/docs/plan.md\n');
  });

  test('--no-filename: match text that looks like a path is not rewritten', () => {
    const parsed = parseRunShellSearch(['rg', '--no-filename', 'README']);
    expect(parsed!.output).toBe('none');
    expect(citeSearchOutput('README.md\nsee README.md:intro\n', '/w/latest', SOURCES, parsed!.output, () => true))
      .toBe('README.md\nsee README.md:intro\n');
    expect(parseRunShellSearch(['rg', '-I', 'x'])!.output).toBe('none');
    expect(parseRunShellSearch(['git', 'grep', '-h', 'x'])!.output).toBe('none');
  });

  test('match output: a line with no path: prefix is left alone', () => {
    expect(citeSearchOutput('README.md\n', '/w/latest', SOURCES, 'match', () => true)).toBe('README.md\n');
  });

  test('rg --json: only data.path.text is cited', () => {
    const line = '{"type":"match","data":{"path":{"text":"docs/a.md"},"lines":{"text":"README.md\\n"},"line_number":1}}';
    const out = citeSearchOutput(`${line}\n`, '/w/latest', SOURCES, 'json', () => true);
    const event = JSON.parse(out.split('\n')[0]!);
    expect(event.data.path.text).toBe('repo:main/docs/a.md');
    expect(event.data.lines.text).toBe('README.md\n');
  });

  test('output modes per flag', () => {
    expect(parseRunShellSearch(['rg', '-l', 'x'])!.output).toBe('list');
    expect(parseRunShellSearch(['rg', '--files'])!.output).toBe('list');
    expect(parseRunShellSearch(['rg', '--json', 'x'])!.output).toBe('json');
    expect(parseRunShellSearch(['git', 'grep', '--name-only', 'x'])!.output).toBe('list');
    expect(parseRunShellSearch(['ast-grep', 'scan', '--files-with-matches'])!.output).toBe('list');
    expect(parseRunShellSearch(['ast-grep', 'run', '-p', 'x'])!.output).toBe('match');
  });
});

describe('RunShell search miss + bytes', () => {
  test('no hits → docs.search-miss (surface runshell) and a byte summary', () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const d = deps({ staleCwd: () => STALE }, logs);
    const plan = planRunShellSearch(['rg', 'absent-term'], '/w/old', d)!;
    const done = finishRunShellSearch(plan, { stdout: '', exitCode: 1, outcome: 'exit' }, '/w/old', d);
    expect(done.hits).toBe(0);
    expect(done.stdout).toBe('[search] cwd tree is 5 days old — searched latest too (/w/latest)\n[search] also searched: repo:main\n');
    expect(logs[0]).toEqual(['docs', 'search-miss', { query: 'absent-term', roots: ['/w/old', '/w/latest'], hits: 0, surface: 'runshell', tool: 'rg' }]);
    expect(logs[1]![1]).toBe('search.summary');
    expect(logs[1]![2]).toMatchObject({ tool: 'rg', hits: 0, rawBytes: 0, returnedBytes: 102 });
  });

  test('hits → no miss log; eln docs search never double-logs a miss', () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const d = deps({}, logs);
    finishRunShellSearch(planRunShellSearch(['rg', 'x', 'src'], '/w/latest', d)!, { stdout: 'src/a.ts:1:x\n', exitCode: 0, outcome: 'exit' }, '/w/latest', d);
    finishRunShellSearch(planRunShellSearch(['eln', 'docs', 'search', 'x'], '/w/latest', d)!, { stdout: '', exitCode: 0, outcome: 'exit' }, '/w/latest', d);
    expect(logs.filter(([, e]) => e === 'search-miss')).toEqual([]);
  });

  test('sim adapter: runShellSearchStrategy plans, runs, cites', () => {
    const seen: string[][] = [];
    const r = runShellSearchStrategy('needle', { cwd: '/w/old', flags: ['-n'], deps: deps({ staleCwd: () => STALE }),
      exec: (argv) => { seen.push([...argv]); return { stdout: '/w/latest/docs/a.md:4:needle\n', exitCode: 0 }; } });
    expect(seen).toEqual([['rg', '-n', 'needle', '.', '/w/latest']]);
    expect(r.hits).toBe(1);
    expect(r.stdout.endsWith('repo:main/docs/a.md:4:needle\n')).toBe(true);
  });
});

const hasRg = (() => { try { return spawnSync('rg', ['--version']).status === 0; } catch { return false; } })();

describe('RunShell dispatch (real rg)', () => {
  let dir = '';
  const prevSources = process.env.ELANOUS_SOURCES;
  afterEach(() => {
    setStaleCwdProbeForTesting(null);
    if (prevSources === undefined) delete process.env.ELANOUS_SOURCES; else process.env.ELANOUS_SOURCES = prevSources;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!hasRg)('stale cwd: the doc only in latest is found and cited', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rs-search-')));
    const old = join(dir, 'old'); const latest = join(dir, 'latest');
    mkdirSync(join(latest, 'docs'), { recursive: true }); mkdirSync(old);
    writeFileSync(join(latest, 'docs', 'plan.md'), 'quartz-needle-77\n');
    process.env.ELANOUS_SOURCES = JSON.stringify([{ id: 'main', type: 'repo', path: latest }]);
    setStaleCwdProbeForTesting(() => ({ days: 4, cwdRoot: old, latestRoot: latest }));
    const r = await dispatchRunShell({ command: ['rg', '-n', 'quartz-needle-77'], cwd: old });
    expect(r.stdout).toContain('repo:main/docs/plan.md:1:quartz-needle-77');
    expect(r.stdout).toContain('[search] also searched: repo:main');
    expect(r.output).toContain('search=rg hits=1 roots+1');
  });

  test.skipIf(!hasRg)('script mode via real dispatch: stale-hint miss and rg --json miss (exit 1) do not stop later steps', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rs-search-')));
    const old = join(dir, 'old'); const latest = join(dir, 'latest');
    mkdirSync(join(latest, 'docs'), { recursive: true }); mkdirSync(old);
    writeFileSync(join(latest, 'docs', 'plan.md'), 'quartz-needle-77\n');
    writeFileSync(join(old, 'local.txt'), 'onyx-local-12\n');
    process.env.ELANOUS_SOURCES = JSON.stringify([{ id: 'main', type: 'repo', path: latest }]);
    setStaleCwdProbeForTesting(() => ({ days: 4, cwdRoot: old, latestRoot: latest }));
    const r = await dispatchRunShell({ cwd: old, script: [
      { id: 'miss', command: ['rg', '-n', 'absent-term-0042'] },
      { id: 'jsonmiss', command: ['rg', '--json', 'absent-term-0042'] },
      { id: 'hit', command: ['rg', '-l', 'onyx-local-12'] },
    ] }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
    const steps = JSON.parse(r.stdout).steps;
    expect(steps.map((s: { id: string }) => s.id)).toEqual(['miss', 'jsonmiss', 'hit']);
    expect(steps[0].exitCode).toBe(1);
    expect(steps[0].search.hits).toBe(0);
    expect(steps[1].exitCode).toBe(1);
    expect(steps[1].search.hits).toBe(0);
    expect(steps[2].search.hits).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  test('ast-grep rewrite through RunShell is refused before spawn', async () => {
    const r = await dispatchRunShell({ command: ['ast-grep', 'run', '-p', 'a', '--rewrite', 'b', '-U'], cwd: tmpdir() });
    expect(r.outcome).toBe('denied');
    expect(r.approvalKey).toBe('rejected:search-flag');
  });
});
