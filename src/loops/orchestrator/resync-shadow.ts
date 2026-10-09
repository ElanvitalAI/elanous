import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import {
  defaultGitMergeSeam, defaultLlmResolve, mergeMainWithLlmResolve,
  type LlmMergeOutcome, type MergeGitSeam,
} from '../../autopilot/build/llm-conflict-merge.js';

type ResyncVerdict = 'saved' | 'merge-ok-tests-failed' | 'merge-ok-no-tests' | 'unresolved' | 'guard-tripped' | 'error';
interface ResyncShadowEntry {
  at: string;
  pr: number;
  head: string;
  verdict: ResyncVerdict;
  status: LlmMergeOutcome['status'] | 'error';
  resolvedFiles: string[];
  testFiles: string[];
  failedTests?: string[];
}
export interface ResyncShadowSummary { candidates: number; tried: number; saved: number; savedRatio: number | null }

type OpenPr = { number: number; headRefName: string; mergeable: string; isDraft: boolean; labels: { name: string }[] };
export interface ResyncShadowDeps {
  repoRoot?: string;
  instanceRoot?: string;
  runGh?: (args: string[]) => string;
  resolve?: (file: string, conflicted: string) => Promise<string>;
  gitSeam?: MergeGitSeam;
  runTests?: (cwd: string, files: string[]) => { ok: boolean; failedTests?: string[]; noTests?: boolean };
  now?: () => Date;
}

function command(file: string, args: string[], cwd: string, timeout = 60_000): string {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedTests(gh: (args: string[]) => string, number: number): string[] {
  const observed: unknown = JSON.parse(gh(['pr', 'view', String(number), '--json', 'files']));
  if (!observed || typeof observed !== 'object' || !('files' in observed) || !Array.isArray(observed.files)
    || observed.files.some(file => !file || typeof file.path !== 'string')) throw new Error('invalid PR files observation');
  return [...new Set((observed.files as { path: string }[]).map(file => file.path).filter(path =>
    path.endsWith('.test.ts') && !isAbsolute(path) && path !== '' && !path.split('/').some(part => part === '..' || part === '.' || part === '')))];
}

// A PR test must not inherit credentials, reach the network or write outside its own worktree.
// If the kernel does not provide the required isolation, fail closed before starting bun.
const TEST_SANDBOX = `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
class Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]
class PathRule(ctypes.Structure):
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
EXEC, WRITE, READ_FILE, READ_DIR, REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = (1 << i for i in range(13))
REFER, TRUNCATE = 1 << 13, 1 << 14
READ = EXEC | READ_FILE | READ_DIR
WRITE_BITS = WRITE | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM | REFER | TRUNCATE
ALL = READ | WRITE_BITS
def syscall(num, *args):
    result = libc.syscall(num, *args)
    if result < 0: raise OSError(ctypes.get_errno(), 'syscall ' + str(num) + ': ' + os.strerror(ctypes.get_errno()))
    return result
try:
    cwd, bun, modules, report, *tests = sys.argv[1:]
    version = syscall(444, 0, 0, 1)
    rights = ALL & (~TRUNCATE if version < 3 else ~0) & (~REFER if version < 2 else ~0)
    rules = Ruleset(rights)
    fd = syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0)
    def allow(path, rights):
        if not os.path.exists(path): return
        pathfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathRule(rights & rules.handled_access_fs, pathfd)
            try: syscall(445, fd, 1, ctypes.byref(rule), 0)
            except OSError as error: raise OSError(error.errno, path + ': ' + str(error))
        finally: os.close(pathfd)
    for path in ('/usr', '/lib', '/lib64', '/bin', '/etc', '/dev', '/proc/self', '/proc/thread-self', '/proc/cpuinfo', '/proc/meminfo', '/proc/stat', '/sys'):
        allow(path, (EXEC | READ_FILE) if os.path.isfile(path) else READ)
    allow(bun, EXEC | READ_FILE)
    if modules != '-': allow(modules, READ)
    allow(cwd, READ | WRITE_BITS)
    if libc.prctl(38, 1, 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), 'no_new_privs')
    syscall(446, fd, 0)
    os.close(fd)
    os.environ.clear()
    os.environ.update(PATH='/usr/bin:/bin', HOME=cwd, GH_CONFIG_DIR=cwd, TMPDIR=cwd, XDG_CONFIG_HOME=cwd, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', GH_PROMPT_DISABLED='1')
    print('RESYNC_SANDBOX_READY', file=sys.stderr, flush=True)
    os.execv(bun, [bun, 'test', '--reporter=junit', '--reporter-outfile=' + report, *tests])
except Exception as error:
    print('resync test sandbox: ' + str(error), file=sys.stderr)
    sys.exit(125)`;

/** Bun's own JUnit report is the run evidence — a test file can print «1 pass» to stdout, but it cannot make the runner record a testcase. */
export function junitCounts(xml: string): { tests: number; failures: number; failed: string[] } | null {
  const suites = /<testsuites\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/.exec(xml);
  if (!suites) return null;
  const failed = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*>\s*<failure/g)].map(match => match[1]!);
  return { tests: Number(suites[1]), failures: Number(suites[2]), failed };
}

function defaultRunTests(cwd: string, files: string[]): { ok: boolean; failedTests?: string[]; noTests?: boolean } {
  const modules = existsSync(join(cwd, 'node_modules')) ? realpathSync(join(cwd, 'node_modules')) : '-';
  const deadline = Date.now() + 300_000;
  const failedTests: string[] = [];
  // Review round 3 ②: a test file the PR deleted is not runnable — drop it; none left = «no tests», not a measurement error.
  const present = files.filter(file => existsSync(resolve(cwd, file)));
  if (present.length === 0) return { ok: true, noTests: true };
  // Run each declared file separately: Bun's combined summary counts files loaded, not files with tests.
  for (const file of present) {
    const abs = resolve(cwd, file);
    if (!abs.startsWith(`${cwd}/`) || !realpathSync(abs).startsWith(`${cwd}/`)) throw new Error(`test path outside worktree: ${file}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`test runner timed out before ${file}`);
    const report = join(cwd, `.resync-junit-${randomUUID()}.xml`);
    rmSync(report, { force: true });
    const args: string[] = ['--user', '--map-root-user', '--net', '--fork',
      'python3', '-c', TEST_SANDBOX, cwd, realpathSync(process.execPath), modules, report, abs];
    const options: SpawnSyncOptionsWithStringEncoding = { cwd, env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'test' },
      encoding: 'utf8', timeout: remaining, maxBuffer: 20 * 1024 * 1024 };
    const result = spawnSync('unshare', args, options);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (!result.stderr?.includes('RESYNC_SANDBOX_READY')) throw new Error(`test sandbox unavailable: ${result.error?.message ?? output.trim()}`);
    if (result.error || result.signal) throw new Error(`test runner unavailable for ${file}: ${result.error?.message ?? output.trim()}`);
    // Review round 3 ①: never trust stdout text — read the runner's JUnit report; no report or zero testcases is not a pass.
    const counts = existsSync(report) ? junitCounts(readFileSync(report, 'utf8')) : null;
    rmSync(report, { force: true });
    if (!counts || counts.tests === 0) { failedTests.push(`${file}: no test cases recorded by the runner`); continue; }
    if (result.status === 0 && counts.failures === 0) continue;
    failedTests.push(...(counts.failed.length ? counts.failed : [`${file}: ${counts.failures} failure(s)`]));
  }
  return failedTests.length ? { ok: false, failedTests } : { ok: true };
}

/** Re-merge open conflicts only in disposable detached worktrees; no remote writes. */
export async function runResyncShadow(max = 3, deps: ResyncShadowDeps = {}): Promise<ResyncShadowSummary> {
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('--max must be a nonnegative integer');
  const repoRoot = deps.repoRoot ?? resolve(import.meta.dir, '../../..');
  const gh = deps.runGh ?? ((args: string[]) => command('gh', args, repoRoot));
  const observed: unknown = JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,mergeable,isDraft,labels', '--limit', '1000']));
  if (!Array.isArray(observed) || observed.length >= 1000 || observed.some(pr => !pr || !Number.isSafeInteger(pr.number)
    || typeof pr.headRefName !== 'string' || typeof pr.mergeable !== 'string' || typeof pr.isDraft !== 'boolean'
    || !Array.isArray(pr.labels) || pr.labels.some((label: unknown) => !label || typeof label !== 'object' || typeof (label as { name?: unknown }).name !== 'string')))
    throw new Error('incomplete or invalid PR observation');
  const candidates = (observed as OpenPr[]).filter(pr => pr.headRefName.startsWith('self-impl/')
    && pr.mergeable === 'CONFLICTING'
    && !pr.labels.some(label => label.name === 'elanous:stalled' || label.name === 'elanous:superseded'))
    .sort((a, b) => a.number - b.number).slice(0, max);
  const ledger = join(deps.instanceRoot ?? effectiveInstanceRoot(), 'orchestrator', 'resync-shadow.jsonl');
  let saved = 0;
  let tried = 0;
  for (const pr of candidates) {
    const entry: ResyncShadowEntry = {
      at: (deps.now?.() ?? new Date()).toISOString(), pr: pr.number, head: pr.headRefName,
      verdict: 'error', status: 'error', resolvedFiles: [], testFiles: [],
    };
    let tmp: string | undefined;
    try {
      // Explicit destination refspecs make origin/<head> and origin/main fresh even without remote.origin.fetch.
      command('git', ['fetch', 'origin', `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`,
        '+refs/heads/main:refs/remotes/origin/main'], repoRoot);
      entry.testFiles = changedTests(gh, pr.number);
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'resync-shadow-')));
      command('git', ['worktree', 'add', '--detach', tmp, `origin/${pr.headRefName}`], repoRoot);
      // Focused tests may import packages from the checkout; worktrees do not contain node_modules.
      if (existsSync(join(repoRoot, 'node_modules'))) symlinkSync(realpathSync(join(repoRoot, 'node_modules')), join(tmp, 'node_modules'), 'dir');
      const outcome = await mergeMainWithLlmResolve(tmp, 'origin/main', deps.resolve ?? ((file, content) => defaultLlmResolve(file, content, 'origin/main')), deps.gitSeam ?? defaultGitMergeSeam());
      entry.status = outcome.status;
      entry.resolvedFiles = outcome.resolvedFiles ?? [];
      if (outcome.sizeCollapse?.length || outcome.providerFailure?.length || outcome.testDeclarationLoss?.length) {
        entry.verdict = 'guard-tripped';
      } else if (outcome.status === 'merged' || outcome.status === 'llm-resolved' || outcome.status === 'deterministic-resolved') {
        if (entry.testFiles.length === 0) entry.verdict = 'merge-ok-no-tests';
        else {
          const test = (deps.runTests ?? defaultRunTests)(tmp, entry.testFiles);
          entry.verdict = test.noTests ? 'merge-ok-no-tests' : test.ok ? 'saved' : 'merge-ok-tests-failed';
          if (!test.ok) entry.failedTests = test.failedTests?.length ? test.failedTests : ['test runner failed'];
        }
      } else entry.verdict = outcome.status === 'conflict-unresolved' || outcome.status === 'up-to-date' ? 'unresolved' : 'error';
    } catch (error) {
      entry.verdict = 'error';
      entry.failedTests = [error instanceof Error ? error.message : String(error)];
    } finally {
      if (tmp) {
        try {
          // Even a failed add can have registered a partially created worktree.
          command('git', ['worktree', 'remove', '--force', tmp], repoRoot);
        } catch (error) {
          entry.verdict = 'error';
          entry.failedTests = [`worktree cleanup: ${String(error)}`];
        } finally {
          try { rmSync(tmp, { recursive: true, force: true }); }
          catch (error) { entry.verdict = 'error'; entry.failedTests = [`temporary directory cleanup: ${String(error)}`]; }
        }
      }
    }
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
    debug.log('loop.orchestrator', 'resync-shadow', { pr: entry.pr, verdict: entry.verdict, status: entry.status });
    if (entry.verdict !== 'error') tried++;
    if (entry.verdict === 'saved') saved++;
  }
  const summary = { candidates: candidates.length, tried, saved, savedRatio: tried ? saved / tried : null };
  debug.log('loop.orchestrator', 'resync-shadow-summary', { candidates: summary.candidates, tried: summary.tried, saved });
  return summary;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: bun src/loops/orchestrator/resync-shadow.ts [--max N] [--json]');
    } else {
      const index = args.indexOf('--max');
      if (args.some((arg, i) => arg !== '--json' && arg !== '--max' && (index < 0 || i !== index + 1))
        || (index >= 0 && (index === args.length - 1 || args.lastIndexOf('--max') !== index))) throw new Error('usage: resync-shadow.ts [--max N] [--json]');
      const max = index < 0 ? 3 : Number(args[index + 1]);
      const summary = await runResyncShadow(max);
      console.log(process.argv.includes('--json') ? JSON.stringify(summary) : `resync-shadow candidates=${summary.candidates} tried=${summary.tried} saved=${summary.saved} savedRatio=${summary.savedRatio === null ? 'n/a' : `${(summary.savedRatio * 100).toFixed(1)}%`}`);
    }
  } catch (error) {
    console.error(`resync-shadow: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
