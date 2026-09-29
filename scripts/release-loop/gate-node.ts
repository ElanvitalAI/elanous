#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { diffFailures, parseFailures } from './gate-diff';
import { deriveCdpTestPatterns } from '../test-deterministic';
import { emitNodeResult, readGraphContext } from './node-verdict.js';

interface CommandResult { rc: number; output: string }
export interface GateRunner {
  command(cmd: string, args: string[], cwd: string): Promise<CommandResult>;
  sweep(tree: string, logDir?: string): Promise<CommandResult>;
  add(tree: string, commit: string): Promise<void>;
  remove(tree: string): Promise<void>;
  snapshot(tree: string, commit: string): Promise<void>;
  removeSnapshot(tree: string): Promise<void>;
}
export interface GateOptions {
  commit: string;
  version: string;
  baselineVersion?: string;
  baselineCommit?: string;
  remote?: string;
  instanceRoot?: string;
  repo?: string;
}
export interface GateResult {
  outcome: 'ok' | 'regression' | 'error';
  commit: string;
  introduced: string[];
  preexisting: number;
  fixed: number;
  durationMs: number;
  error?: string;
}

const sha = /^[0-9a-f]{7,40}$/i;
const versionPattern = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const failureFile = (root: string, version: string) => join(root, 'release', version, 'gate-failures.json');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function check(result: CommandResult, label: string): void {
  if (result.rc !== 0) throw new Error(`${label} failed (rc=${result.rc}): ${result.output.slice(-500)}`);
}

type SweepFailures = { failures: string[]; errors: string[] };
const summaryCount = (output: string, label: string) => Number(new RegExp(`(?:^|\\n)\\s*(\\d+) ${label}s?\\s*(?:\\n|$)`).exec(output)?.[1] ?? NaN);
const tail40 = (output: string) => output.trimEnd().split(/\r?\n/).slice(-40).join('\n');

function failuresOf(run: CommandResult, label: string): SweepFailures {
  const output = run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const ran = /Ran (\d+) tests? across ([1-9]\d*) files?/.exec(output);
  const reportedErrors = summaryCount(output, 'error');
  const errorCount = Number.isNaN(reportedErrors) ? 0 : reportedErrors;
  const incomplete = (reason: string) => new Error(`${label} incomplete (rc=${run.rc}; Ran=${ran ? ran[0] : 'missing'}; errors=${Number.isNaN(reportedErrors) ? 'missing' : errorCount}; ${reason})\n${tail40(output)}`);
  if (!ran || (Number(ran[1]) === 0 && errorCount === 0) || (run.rc !== 0 && run.rc !== 1)) throw incomplete('summary/exit');
  const count = summaryCount(output, 'fail');
  const failures = parseFailures(output);
  const occurrences = [...output.matchAll(/\(fail\)\s+.+?(?:\s+\[[\d.]+(?:ms|s)\])?\s*$/gm)].length;
  // Bun reports file-level unhandled errors separately from test failures.
  const errors: string[] = [];
  let file: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):/.exec(raw.trim());
    if (header) file = header[1];
    if (/^# Unhandled error between tests/.test(raw.trim())) {
      if (!file) throw incomplete('unattributed unhandled error');
      errors.push(`${file} > [error]`);
      file = undefined;
    }
  }
  if (errors.length !== errorCount) throw incomplete(`error attribution identified=${errors.length}`);
  if (!Number.isFinite(count) || count !== occurrences || (count > 0 && failures.length === 0)
    || (run.rc === 1 && count === 0 && errorCount === 0) || (run.rc === 0 && count + errorCount > 0)) {
    throw incomplete(`failure attribution incomplete: summary=${count}, identified=${failures.length}`);
  }
  return { failures, errors: [...new Set(errors)].sort() };
}

/** Commands on the remote host use the same absolute repository path as the caller. */
export function createGateRunner(repo: string, remote?: string, commandOverride?: GateRunner['command']): GateRunner {
  const command: GateRunner['command'] = commandOverride ?? (async (cmd: string, args: string[], cwd: string): Promise<CommandResult> => {
    const executable = remote ? 'ssh' : cmd;
    const argv = remote ? [remote, `cd ${quote(cwd)} && ${[cmd, ...args].map(quote).join(' ')}`] : args;
    const run = spawnSync(executable, argv, { cwd: remote ? repo : cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}` };
  });
  return {
    command,
    async sweep(tree, logDir) {
      const listed = await command('git', ['ls-files', '*.test.*'], tree);
      check(listed, 'git ls-files tests');
      const files = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
      const groups = [
        { name: 'src-cli', paths: ['src/cli'] },
        { name: 'src-rest', paths: [...new Set(files.filter((f) => f.startsWith('src/') && !f.startsWith('src/cli/')).map((f) => f.split('/').length === 2 ? f : f.split('/').slice(0, 2).join('/')))] },
        { name: 'test', paths: ['test'] },
        { name: 'other', paths: [...new Set(files.filter((f) => !f.startsWith('src/') && !f.startsWith('test/')).map((f) => f.split('/')[0]!))] },
      ];
      let cdpPatterns: string[];
      if (remote) {
        const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
        if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
        cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
      } else cdpPatterns = deriveCdpTestPatterns({ cwd: tree });
      const outputs: string[] = [];
      let total = { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 };
      for (const group of groups) {
        if (!group.paths.length || !files.some((f) => group.paths.some((p) => f === p || f.startsWith(`${p}/`)))) continue;
        const start = Date.now();
        const groupIgnores = cdpPatterns.filter((pattern) => group.paths.some((p) => pattern === p || pattern.startsWith(`${p}/`)))
          .flatMap((pattern) => ['--path-ignore-patterns', pattern]);
        const run = await command('bun', ['run', 'test:deterministic', ...groupIgnores, ...group.paths], tree);
        if (logDir) {
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, `${group.name}.log`), run.output, { mode: 0o600 });
          writeFileSync(join(logDir, `${group.name}.json`), JSON.stringify({ durationMs: Date.now() - start, rc: run.rc }) + '\n', { mode: 0o600 });
        }
        debug.log('release-loop.gate', 'shard', { shard: group.name, durationMs: Date.now() - start, rc: run.rc, logDir });
        try { failuresOf(run, `${group.name} shard`); }
        catch (error) { throw new Error(`${group.name} shard: ${error instanceof Error ? error.message : String(error)}`); }
        const clean = run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const ran = /Ran (\d+) tests? across (\d+) files?/.exec(clean)!;
        const passes = summaryCount(clean, 'pass');
        if (!Number.isFinite(passes) && Number(ran[1]) > 0) throw new Error(`${group.name} shard incomplete (rc=${run.rc}; pass summary missing)\n${tail40(clean)}`);
        total = { pass: total.pass + (Number.isNaN(passes) ? 0 : passes), fail: total.fail + summaryCount(clean, 'fail'),
          errors: total.errors + (Number.isNaN(summaryCount(clean, 'error')) ? 0 : summaryCount(clean, 'error')),
          ran: total.ran + Number(ran[1]), files: total.files + Number(ran[2]) };
        outputs.push(clean.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
      }
      if (!outputs.length || (total.ran === 0 && total.errors === 0)) throw new Error('sweep incomplete: no tests ran');
      return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n` };
    },
    async add(tree, commit) { check(await command('git', ['worktree', 'add', '--detach', tree, commit], repo), 'git worktree add'); },
    async remove(tree) { check(await command('git', ['worktree', 'remove', '--force', tree], repo), 'git worktree remove'); },
    async snapshot(tree, commit) {
      check(await command('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, tree], repo), 'baseline snapshot clone');
      check(await command('git', ['checkout', '--quiet', '--detach', commit], tree), 'baseline snapshot checkout');
    },
    async removeSnapshot(tree) {
      if (remote) check(await command('rm', ['-r', '--', tree], repo), 'baseline snapshot cleanup');
      else rmSync(tree, { recursive: true, force: true });
    },
  };
}

function readBaseline(root: string, version: string): { commit: string; failures: string[]; errors?: string[] } | undefined {
  const path = failureFile(root, version);
  if (!existsSync(path)) return undefined;
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || !('failures' in data) || !Array.isArray(data.failures)
    || !data.failures.every((id: unknown) => typeof id === 'string')
    || ('errors' in data && (!Array.isArray(data.errors) || !data.errors.every((id: unknown) => typeof id === 'string')))
    || !('commit' in data) || typeof data.commit !== 'string' || !sha.test(data.commit)) {
    throw new Error(`invalid baseline failure ledger: ${path}`);
  }
  const record = data as { commit: string; failures: string[]; errors?: string[] };
  for (const id of [...record.failures, ...(record.errors ?? [])]) fileOf(id);
  return record;
}

function baselineCommit(root: string, version: string): string {
  const path = join(root, 'release', version, 'release.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const commit = manifest && typeof manifest === 'object' && 'sourceCommit' in manifest ? manifest.sourceCommit : undefined;
  if (typeof commit !== 'string' || !sha.test(commit)) throw new Error(`missing sourceCommit in ${path}`);
  return commit;
}

function fileOf(id: string): string {
  const file = id.split(' > ', 1)[0]!;
  if (!id.includes(' > ') || !/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
  return file;
}

export async function judgeGate(opts: GateOptions, runner: GateRunner = createGateRunner(opts.repo ?? process.cwd(), opts.remote)): Promise<GateResult> {
  const start = Date.now();
  const root = opts.instanceRoot ?? effectiveInstanceRoot();
  const repo = resolve(opts.repo ?? process.cwd());
  const result: GateResult = { outcome: 'error', commit: opts.commit, introduced: [], preexisting: 0, fixed: 0, durationMs: 0 };
  let work: string | undefined;
  let baseSnapshot = false;
  let cutFailures: SweepFailures | undefined;
  const trees: string[] = [];
  try {
    if (!sha.test(opts.commit) || !versionPattern.test(opts.version)
      || (opts.baselineVersion && !versionPattern.test(opts.baselineVersion))
      || (opts.baselineCommit && !sha.test(opts.baselineCommit))) throw new Error('invalid commit or version');
    if (!opts.baselineVersion) throw new Error('previous release version required (--baseline-version)');
    if (opts.remote && !/^(?:[\w.-]+@)?[\w.-]+$/.test(opts.remote)) throw new Error('invalid ssh host');
    if (opts.remote) {
      const temporary = await runner.command('mktemp', ['-d', '/tmp/release-gate-XXXXXXXX'], repo);
      check(temporary, 'remote mktemp');
      work = temporary.output.trim();
    } else work = mkdtempSync(join(tmpdir(), 'release-gate-'));
    if (!work || (opts.remote && !/^\/tmp\/release-gate-[\w-]+$/.test(work))) throw new Error('could not create temporary work directory');
    const cutTree = join(work, 'cut');
    trees.push(cutTree);
    await runner.add(cutTree, opts.commit);
    for (const dir of [cutTree, join(cutTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
    const cutRun = await runner.sweep(cutTree, join(root, 'release', opts.version, 'gate-logs', 'cut'));
    const cut = failuresOf(cutRun, 'cut sweep');
    cutFailures = cut;
    const saved = readBaseline(root, opts.baselineVersion);
    const baseSha = opts.baselineCommit ?? baselineCommit(root, opts.baselineVersion);
    if (saved && opts.baselineCommit && saved.commit !== baseSha) throw new Error('cached baseline commit does not match requested baseline commit');
    const trusted = saved?.commit === baseSha ? saved : undefined;
    let baseTree: string | undefined;
    const getBaseTree = async () => {
      if (!baseTree) {
        baseTree = join(work!, 'baseline');
        if (trusted) {
          baseSnapshot = true;
          await runner.snapshot(baseTree, baseSha);
        } else {
          trees.push(baseTree);
          await runner.add(baseTree, baseSha);
        }
        for (const dir of [baseTree, join(baseTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
      }
      return baseTree;
    };
    let baseline: SweepFailures | undefined = trusted ? { failures: trusted.failures, errors: trusted.errors ?? [] } : undefined;
    if (!baseline) {
      const baseRun = await runner.sweep(await getBaseTree(), join(root, 'release', opts.version, 'gate-logs', 'baseline'));
      baseline = failuresOf(baseRun, 'baseline sweep');
    }
    for (const id of [...baseline.failures, ...baseline.errors, ...cut.failures, ...cut.errors]) fileOf(id);
    const diff = diffFailures([...cut.failures, ...cut.errors], [...baseline.failures, ...baseline.errors]);
    result.fixed = diff.fixed.length;
    result.preexisting = diff.common.length;
    for (const file of new Set(diff.newFailures.map(fileOf))) {
      const isolated = await runner.command('bun', ['run', 'test:deterministic', file], cutTree);
      const isolatedCut = failuresOf(isolated, `cut isolated ${file}`);
      const reproduced = new Set([...isolatedCut.failures, ...isolatedCut.errors]);
      const candidates = diff.newFailures.filter((id) => fileOf(id) === file && reproduced.has(id));
      if (candidates.length === 0) continue;
      const baselineTree = await getBaseTree();
      const previous = await runner.command('bun', ['run', 'test:deterministic', file], baselineTree);
      let oldFailures: Set<string>;
      if (/No tests found/i.test(previous.output) && previous.rc === 1) {
        const lookup = await runner.command('git', ['ls-tree', '--name-only', baseSha, '--', file], repo);
        if (lookup.rc !== 0 || lookup.output.trim()) throw new Error(`baseline isolated run incomplete: ${file}`);
        oldFailures = new Set();
      } else {
        const prior = failuresOf(previous, `baseline isolated ${file}`);
        oldFailures = new Set([...prior.failures, ...prior.errors]);
      }
      for (const id of candidates) {
        if (oldFailures.has(id)) result.preexisting++;
        else result.introduced.push(id);
      }
    }
    result.outcome = result.introduced.length ? 'regression' : 'ok';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (baseSnapshot && work) {
      try { await runner.removeSnapshot(join(work, 'baseline')); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    for (const tree of trees.reverse()) {
      try { await runner.remove(tree); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    if (work) {
      try {
        if (opts.remote) check(await runner.command('rmdir', [work], repo), 'remote temporary directory cleanup');
        else rmSync(work, { recursive: true, force: true });
      } catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    result.durationMs = Date.now() - start;
  }
  if (result.outcome !== 'error' && cutFailures) {
    try {
      const path = failureFile(root, opts.version);
      mkdirSync(dirname(path), { recursive: true });
      const temp = join(dirname(path), `.gate-failures-${process.pid}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify({ commit: opts.commit, failures: cutFailures.failures, ...(cutFailures.errors.length ? { errors: cutFailures.errors } : {}) }, null, 2) + '\n', { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
      } finally { if (existsSync(temp)) rmSync(temp); }
    } catch (error) {
      result.outcome = 'error';
      result.error = `baseline persistence: ${String(error)}`;
    }
  }
  if (result.outcome !== 'error') debug.log('release-loop.gate', 'judged', { version: opts.version, commit: opts.commit, introduced: result.introduced.length, preexisting: result.preexisting });
  return result;
}

export function graphGateResult(result: GateResult, graph: boolean) {
  return { ...result, ...(graph && result.outcome === 'regression' ? { outcome: 'fail' as const } : {}),
    verdict: result.outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: result.outcome === 'ok' ? `새 회귀 ${result.introduced.length} · 기존 ${result.preexisting} · 고침 ${result.fixed}` : `게이트 ${result.outcome}: ${result.error ?? result.introduced.length + ' new regressions'}` };
}

function parseOptions(args: string[], env: NodeJS.ProcessEnv): GateOptions | 'help' {
  const context = env.ELANOUS_GRAPH_CONTEXT && args.every((arg) => arg === '--json') ? readGraphContext(env) : undefined;
  const fromGraph: Record<string, unknown> = context?.input ?? {};
  const graphCommit = context?.outputs['version-release']?.commit;
  if (typeof graphCommit === 'string') fromGraph.commit = graphCommit;
  const baselineCommit = context?.outputs.cutoff?.baseline as { sha?: unknown } | undefined;
  if (typeof baselineCommit?.sha === 'string') fromGraph.previousCommit = baselineCommit.sha;
  const opts: GateOptions = {
    commit: typeof fromGraph.commit === 'string' ? fromGraph.commit : '',
    version: typeof fromGraph.version === 'string' ? fromGraph.version : '',
    baselineVersion: typeof fromGraph.previousVersion === 'string' ? fromGraph.previousVersion : undefined,
    baselineCommit: typeof fromGraph.previousCommit === 'string' ? fromGraph.previousCommit : undefined,
    remote: typeof fromGraph.gateRemote === 'string' ? fromGraph.gateRemote : undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return 'help';
    if (arg === '--json') continue;
    const key = ({ '--commit': 'commit', '--version': 'version', '--baseline-version': 'baselineVersion', '--baseline-commit': 'baselineCommit', '--remote': 'remote' } as Record<string, keyof GateOptions>)[arg!];
    if (!key) throw new Error(`unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`value required for ${arg}`);
    if (key === 'commit') opts.commit = value;
    else if (key === 'version') opts.version = value;
    else if (key === 'baselineVersion') opts.baselineVersion = value;
    else if (key === 'baselineCommit') opts.baselineCommit = value;
    else if (key === 'remote') opts.remote = value;
  }
  return opts;
}

if (import.meta.main) {
  const start = Date.now();
  let result: GateResult;
  let version = '';
  try {
    const opts = parseOptions(process.argv.slice(2), process.env);
    if (opts === 'help') {
      console.log('Usage: bun scripts/release-loop/gate-node.ts --commit <sha> --version <v> [--baseline-version <prev>] [--baseline-commit <sha>] [--remote <ssh-host>] [--json]\nWithout flags, input.commit, input.version and input.previousVersion come from the JSON file at ELANOUS_GRAPH_CONTEXT.');
      process.exit(0);
    }
    version = opts.version;
    result = await judgeGate(opts);
  } catch (error) {
    result = { outcome: 'error', commit: '', introduced: [], preexisting: 0, fixed: 0, durationMs: Date.now() - start, error: String(error) };
  }
  if (result.error) console.error(result.error);
  debug.log('release-loop.gate', 'result', { version, outcome: result.outcome });
  emitNodeResult(graphGateResult(result, !!process.env.ELANOUS_GRAPH_CONTEXT));
  process.exitCode = result.outcome === 'ok' ? 0 : result.outcome === 'regression' ? 1 : 2;
}
