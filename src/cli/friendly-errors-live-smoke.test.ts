import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { constants, accessSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Allowed environment keys — allowlist-based environment (review must-fix ②).
// Child environment is built from scratch from these keys only, so other credential
// paths or environment variables from the parent cannot leak into the model-call boundary.
function childEnv(root: string, cfg: string): NodeJS.ProcessEnv {
  const state = join(root, 'state');
  const data = join(root, 'data');
  const cache = join(root, 'cache');
  for (const dir of [state, data, cache]) mkdirSync(dir, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    XDG_CONFIG_HOME: cfg,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    CODEX_HOME: join(root, 'codex-home'),
    NODE_ENV: '',
    ELANOUS_SUPPRESS_XDG_WARNING: '1',
    ELANOUS_DEBUG_LEVEL: 'off',
    ELANOUS_LANG: 'en',
  };
}
const english = '❌ No credentials for this model provider\n  ↳ You have not signed in or set a key\n  elanous login\n';
const korean = '❌ 모델에 접속할 자격이 없습니다\n  ↳ 이 provider 에 로그인하지 않았거나 키가 없습니다\n  elanous login\n';

interface RunResult { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null }

// Async spawn with a hard SIGKILL timeout: spawnSync under `bun test` has been observed
// to hang past its own `timeout`, so the child is drained manually and killed on schedule.
function runEln(executable: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status, signal });
    });
  });
}

function verifyOutput(stdout: string, stderr: string, status: number | null, signal: NodeJS.Signals | null): void {
  if (status !== 1 || signal !== null) throw new Error(`expected exit 1 without signal; got exit=${status} signal=${signal}`);
  if (stdout !== '') throw new Error(`expected empty stdout, got ${JSON.stringify(stdout)}`);
  if (stderr !== english && stderr !== korean) {
    throw new Error(`expected one-language credential-missing what/why/next and zero stack lines; got ${JSON.stringify(stderr)}`);
  }
  if (/^\s*at\s|^Bun v/m.test(stdout + stderr)) throw new Error('stack lines in installed CLI output');
}

function installedEln(): { executable: string; entry: string; version: string } {
  let executable: string | undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, 'eln');
      accessSync(candidate, constants.X_OK);
      executable = realpathSync(candidate);
      break;
    } catch { /* next PATH entry */ }
  }
  if (!executable) throw new Error('installed eln not found in PATH');
  // The one-line installer creates a shell wrapper. Verify where *this* installed executable execs.
  const wrapper = readFileSync(executable, 'utf8');
  const match = wrapper.match(/^exec '\S+' '([^'\n]+\/bin\/elanous\.mjs)' "\$@"$/m);
  if (!match) throw new Error(`cannot verify installed eln entrypoint: ${executable}`);
  const entry = realpathSync(match[1]!);
  const packageRoot = dirname(dirname(entry));
  const version = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const checkoutVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  if (!version || version !== checkoutVersion) throw new Error(`installed version mismatch: ${version} != ${checkoutVersion}`);
  if (readFileSync(entry, 'utf8') !== readFileSync(join(repoRoot, 'bin/elanous.mjs'), 'utf8')) {
    throw new Error('installed CLI entrypoint differs from checkout');
  }
  if (readFileSync(join(packageRoot, 'src/cli/friendly-errors.ts'), 'utf8') !== readFileSync(join(repoRoot, 'src/cli/friendly-errors.ts'), 'utf8')) {
    throw new Error('installed friendly-errors.ts differs from checkout');
  }
  const errorHandler = (text: string) => text.slice(text.indexOf('export function runCli(): void {'));
  const installedHandler = errorHandler(readFileSync(join(packageRoot, 'src/index.ts'), 'utf8'));
  const checkoutHandler = errorHandler(readFileSync(join(repoRoot, 'src/index.ts'), 'utf8'));
  if (!installedHandler || installedHandler !== checkoutHandler) throw new Error('installed CLI error handler differs from checkout');
  return { executable, entry, version };
}

// Live installed-CLI evidence is opt-in. Ordinary repository gates must not
// depend on a local installation matching this checkout.
const installedSmoke = process.env.ELANOUS_LIVE_INSTALLED_SMOKE === '1' ? test : test.skip;
installedSmoke('installed eln credential-missing is one language, what/why/next, stack 0, exit 1', async () => {
  const { executable, entry, version } = installedEln();
  const root = mkdtempSync(join(tmpdir(), 'friendly-errors-smoke-'));
  try {
    const cfg = join(root, 'cfg');
    const testRoot = join(root, 'test');
    mkdirSync(join(cfg, 'elanous'), { recursive: true });
    mkdirSync(testRoot, { recursive: true });
    const config = { llm: { provider: 'openai' }, onboarding: { completed: true } };
    writeFileSync(join(cfg, 'elanous', 'config.json'), JSON.stringify(config));
    writeFileSync(join(testRoot, 'config.json'), JSON.stringify(config));
    const env = childEnv(root, cfg);
    const r = await runEln(executable, [`--test=${testRoot}`, 'chat', '--new', '--json', 'hi'], {
      cwd: repoRoot, env, timeoutMs: 60_000,
    });
    console.log(`installed eln=${executable} version=${version} entry=${entry}`);
    console.log(`exitCode=${r.status} signal=${r.signal} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    verifyOutput(r.stdout, r.stderr, r.status, r.signal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('the process-output check fails closed on wrong what, why, next, language, stack, stdout and exit', () => {
  expect(() => verifyOutput('', english, 1, null)).not.toThrow();
  expect(() => verifyOutput('', korean, 1, null)).not.toThrow();
  for (const wrong of [
    english.replace('No credentials for this model provider', 'Unknown model provider'),
    english.replace('You have not signed in or set a key', 'unrelated reason'),
    english.replace('elanous login', 'elanous doctor'),
    `${english}  at runCli (index.ts:12)\n`,
    `${english}❌ 모델에 접속할 자격이 없습니다\n`,
    `prefix\n${english}`,
  ]) expect(() => verifyOutput('', wrong, 1, null)).toThrow();
  expect(() => verifyOutput('', english, 0, null)).toThrow();
  expect(() => verifyOutput('', english, 1, 'SIGKILL')).toThrow();
  expect(() => verifyOutput('other output', english, 1, null)).toThrow();
});
