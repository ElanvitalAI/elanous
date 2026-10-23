/** Fixed si-v1 entry inside a standing warm Pod. Private input is a framed stdin stream. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSiWarmCommand, siWarmDigestMatches, siWarmSha256,
  type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from './pod-si-warm-protocol.js';

const REPO = '/workspace/repo';
const CONTROL = '/workspace/data/control';
const RUNS = '/workspace/data/si-runs';
const MAX_FRAME = 128 * 1024 * 1024;
const MAX_FIELD = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const RUN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CREDENTIAL_FILE = /^(?:elanous-auth\.json|codex-auth\.json|gh-token|grok-auth\.json|grok-api-key|llm-fallback-config\.json|codex-[0-9]+\.json)$/;

export interface SiWarmRunnerPayload {
  mode: 'self' | 'ask' | 'say';
  feature: string;
  args: string[];
  goalDocument?: string;
  env?: Record<string, string>;
}
export interface SiWarmCredentialBundle {
  files: Record<string, string>;
  env?: Record<string, string>;
  accounts?: string[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Reject truncated, oversized and trailing input before parsing any secret bytes. */
export function decodeSiWarmRunnerFrame(frame: Uint8Array): {
  command: SiWarmCommand; payloadBytes: Uint8Array; credentialBytes: Uint8Array;
} {
  if (frame.length > MAX_FRAME) throw new Error('si-v1 frame too large');
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > frame.length) throw new Error('si-v1 frame truncated');
    const size = Buffer.from(frame.buffer, frame.byteOffset + offset, 4).readUInt32BE();
    offset += 4;
    if (size > MAX_FIELD || offset + size > frame.length) throw new Error('si-v1 field invalid');
    parts.push(frame.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== frame.length) throw new Error('si-v1 frame has trailing bytes');
  const command = parseSiWarmCommand(json(parts[0]!));
  if (!command || !siWarmDigestMatches(parts[1]!, command.payloadSha256)
    || !siWarmDigestMatches(parts[2]!, command.credentialBundleSha256))
    throw new Error('si-v1 command or private digest invalid');
  return { command, payloadBytes: parts[1]!, credentialBytes: parts[2]! };
}

/** The executable shape is fixed; the feature and flags remain ordinary argv, never shell text. */
export function parseSiWarmRunnerPayload(raw: unknown): SiWarmRunnerPayload {
  const row = object(raw);
  if (!row || !fields(row, ['mode', 'feature', 'args'], ['goalDocument', 'env'])
    || !['self', 'ask', 'say'].includes(String(row.mode)) || typeof row.feature !== 'string'
    || !row.feature.trim() || row.feature.length > 1_000_000
    || !Array.isArray(row.args) || row.args.length > 64
    || row.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || (row.goalDocument !== undefined && (typeof row.goalDocument !== 'string' || row.goalDocument.length > 1_000_000))
    || (row.mode === 'ask' && typeof row.goalDocument !== 'string')
    || (row.env !== undefined && (!object(row.env) || Object.entries(row.env as Record<string, unknown>).some(([key, value]) =>
      !/^ELANOUS_[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || value.length > 8192))))
    throw new Error('si-v1 payload invalid');
  return row as unknown as SiWarmRunnerPayload;
}

export function parseSiWarmCredentialBundle(raw: unknown): SiWarmCredentialBundle {
  const row = object(raw), files = object(row?.files), env = row?.env === undefined ? {} : object(row.env);
  const accounts = row?.accounts;
  const codexFiles = Object.keys(files ?? {}).filter(key => /^codex-[0-9]+\.json$/.test(key));
  if (!row || !fields(row, ['files'], ['env', 'accounts']) || !files || !env
    || (accounts !== undefined && (!Array.isArray(accounts) || !accounts.length || accounts.length > 16
      || accounts.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
      || new Set(accounts).size !== accounts.length
      || accounts.some((_name, index) => typeof files[`codex-${index}.json`] !== 'string')))
    || (accounts === undefined && codexFiles.length > 0)
    || (Array.isArray(accounts) && (codexFiles.length !== accounts.length
      || codexFiles.some(key => Number(key.slice(6, -5)) >= accounts.length)
      || files['elanous-auth.json'] !== undefined || files['codex-auth.json'] !== undefined))
    || Object.entries(files).some(([key, value]) => !CREDENTIAL_FILE.test(key)
      || typeof value !== 'string' || value.length > 2_000_000)
    || Object.entries(env).some(([key, value]) => !/^(?:GH_TOKEN|GITHUB_TOKEN|OPENROUTER_API_KEY|OPENGATEWAY_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|ELANOUS_[A-Z0-9_]+)$/.test(key)
      || typeof value !== 'string' || value.length > 2_000_000))
    throw new Error('si-v1 credentials invalid');
  return { files: files as Record<string, string>,
    ...(row.env === undefined ? {} : { env: env as Record<string, string> }),
    ...(accounts === undefined ? {} : { accounts: accounts as string[] }) };
}

/** Rebuild the cold Job's named Codex store inside this run's private HOME. */
export function installSiWarmCodexAccounts(home: string, bundle: SiWarmCredentialBundle):
  Record<'ELANOUS_CODEX_ACCOUNT' | 'ELANOUS_CODEX_ACCOUNT_HOME' | 'CODEX_HOME', string> | null {
  if (!bundle.accounts) return null;
  const providers: Record<string, unknown> = {};
  let version: unknown;
  for (const [index, name] of bundle.accounts.entries()) {
    const pair = object(JSON.parse(bundle.files[`codex-${index}.json`]!));
    if (!pair || typeof pair.elanousAuth !== 'string' || typeof pair.codexAuth !== 'string')
      throw new Error('si-v1 named Codex credential invalid');
    const auth = object(JSON.parse(pair.elanousAuth));
    const source = object(object(auth?.providers)?.['openai-codex']);
    if (!auth || !source) throw new Error('si-v1 named Codex provider missing');
    if (index === 0) version = auth.version;
    const accountHome = join(home, '.elanous', 'codex-accounts', String(index));
    mkdirSync(accountHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(accountHome, 'auth.json'), pair.codexAuth, { mode: 0o600, flag: 'wx' });
    providers[name === 'default' ? 'openai-codex' : `openai-codex:${name}`] = {
      ...source, codexHome: accountHome,
    };
  }
  if (!providers['openai-codex']) providers['openai-codex'] =
    providers[`openai-codex:${bundle.accounts[0]}`]!;
  mkdirSync(join(home, '.elanous'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ version, providers }),
    { mode: 0o600, flag: 'wx' });
  const firstHome = join(home, '.elanous', 'codex-accounts', '0');
  return { ELANOUS_CODEX_ACCOUNT: bundle.accounts[0]!,
    ELANOUS_CODEX_ACCOUNT_HOME: firstHome, CODEX_HOME: firstHome };
}

export function siWarmRunnerIdentity(command: SiWarmCommand, env: NodeJS.ProcessEnv,
  head: string, lockHash: string): boolean {
  return env.WARM_WORKER_ID === command.workerId && env.WARM_POD_UID === command.podUid
    && env.WARM_CUT_SHA === command.sourceSha && env.WARM_CONTEXT === command.key.context
    && env.WARM_IMAGE_DIGEST === command.key.imageDigest && env.WARM_LOCK_HASH === command.key.lockHash
    && env.WARM_ARCHITECTURE === command.key.architecture
    && SHA.test(head) && head === command.sourceSha && lockHash === command.key.lockHash;
}

function git(args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function validatePod(command: SiWarmCommand): void {
  if (process.platform !== 'linux' || !existsSync(REPO) || !existsSync(CONTROL))
    throw new Error('si-v1 warm Pod unavailable');
  const head = git(['rev-parse', 'HEAD']);
  const lockHash = siWarmSha256(readFileSync(join(REPO, 'bun.lock')));
  if (head.status !== 0 || !siWarmRunnerIdentity(command, process.env, head.stdout.trim(), lockHash))
    throw new Error('si-v1 warm Pod identity mismatch');
  if (git(['status', '--porcelain', '--untracked-files=no']).stdout.trim())
    throw new Error('si-v1 warm source dirty');
}

function terminalFromLog(log: Uint8Array, exitCode: number): Uint8Array {
  const lines = new TextDecoder().decode(log).trimEnd().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const row = JSON.parse(lines[index]!);
      const value = row?.kind === 'self' && object(row.result) ? { ...row.result, ok: row.ok } : row;
      if (object(value) && typeof value.ok === 'boolean' && typeof value.stage === 'string' && value.stage) {
        if (exitCode === 0 || value.ok === false) return Buffer.from(JSON.stringify(value));
      }
    } catch { /* A normal log line is not a disposition. */ }
  }
  return Buffer.from(JSON.stringify({ ok: false, stage: 'error', error: `si-v1 child exited ${exitCode} without terminal disposition` }));
}

function collectLedger(dir: string): Uint8Array {
  const root = join(dir, '.elanous', 'run-ledger');
  if (!existsSync(root)) return Buffer.from('[]');
  const rows = readdirSync(root).filter(name => name.endsWith('.jsonl')).sort().map(name => ({
    name, bytes: readFileSync(join(root, name)).toString('base64'),
  }));
  return Buffer.from(JSON.stringify(rows));
}

function collectArtifacts(home: string): SiWarmReturnedBytes['artifacts'] {
  const root = join(home, 'outbox');
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory()) throw new Error('si-v1 outbox invalid');
  const files: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { visit(path, relative); continue; }
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || total + stat.size > 20 * 1024 * 1024
        || files.length >= 256) continue;
      const bytes = readFileSync(path);
      total += bytes.length;
      files.push({ path: relative, bytes });
    }
  };
  visit(root, '');
  return files;
}

/** The runner's actual private-HOME staging step, exposed for filesystem verification. */
export function stageSiWarmCredentials(runDir: string, payload: SiWarmRunnerPayload,
  credentials: SiWarmCredentialBundle): NodeJS.ProcessEnv {
  const home = join(runDir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Bundle values are consumed from memory only; no unconsumed plaintext copy is written under runDir.
  const auth = credentials.files['elanous-auth.json'];
  const codex = credentials.files['codex-auth.json'];
  const namedAccountEnv = installSiWarmCodexAccounts(home, credentials);
  if (auth && !namedAccountEnv) { mkdirSync(join(home, '.elanous'), { mode: 0o700 });
    writeFileSync(join(home, '.elanous', 'auth.json'), auth, { mode: 0o600, flag: 'wx' }); }
  if (codex && !namedAccountEnv) { mkdirSync(join(home, '.codex'), { mode: 0o700 });
    writeFileSync(join(home, '.codex', 'auth.json'), codex, { mode: 0o600, flag: 'wx' }); }
  if (credentials.files['llm-fallback-config.json']) {
    mkdirSync(join(home, '.elanous'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.elanous', 'config.json'), credentials.files['llm-fallback-config.json']!,
      { mode: 0o600, flag: 'wx' });
  }
  if (credentials.files['grok-auth.json']) {
    mkdirSync(join(home, '.grok'), { mode: 0o700 });
    writeFileSync(join(home, '.grok', 'auth.json'), credentials.files['grok-auth.json']!,
      { mode: 0o600, flag: 'wx' });
  }
  const ghToken = credentials.files['gh-token'];
  const env: NodeJS.ProcessEnv = { ...process.env, ...payload.env, ...credentials.env,
    ...namedAccountEnv,
    HOME: home, ELANOUS_STATE_DIR: join(home, '.elanous'), ELANOUS_STATE_DIR_SOURCE: 'explicit',
    ...(ghToken ? { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } : {}),
    ...(credentials.files['grok-api-key'] ? { XAI_API_KEY: credentials.files['grok-api-key'] } : {}) };
  return env;
}

async function executeChild(command: SiWarmCommand, payload: SiWarmRunnerPayload,
  credentials: SiWarmCredentialBundle, runDir: string): Promise<{ code: number; log: Uint8Array }> {
  const env = stageSiWarmCredentials(runDir, payload, credentials);
  // The cold Job configures git and the GitHub credential helper before running SI.
  // Keep these writes inside this run's private HOME; a failed setup is a measured child failure.
  for (const args of [
    ['config', '--global', 'user.name', 'elanous pod child'],
    ['config', '--global', 'user.email', 'noreply@anthropic.com'],
  ]) {
    const configured = spawnSync('git', args, { cwd: REPO, env, timeout: 30_000, stdio: 'ignore' });
    if (configured.status !== 0) throw new Error('si-v1 git identity setup failed');
  }
  // SI's PR push path requires an explicit brokered GitHub token for this lease.
  if (!credentials.files['gh-token'] || spawnSync('gh', ['auth', 'setup-git'],
    { cwd: REPO, env, timeout: 30_000, stdio: 'ignore' }).status !== 0)
    throw new Error('si-v1 GitHub credential helper setup failed');
  const argv = payload.mode === 'self'
    ? ['self', 'implement', payload.feature, '--json', ...payload.args]
    : payload.mode === 'say'
      ? ['harness', 'say', '--substrate', 'local', '--json', ...payload.args, '--', payload.feature]
      : ['harness', 'ask', join(runDir, 'goal.md'), '--json', ...payload.args];
  if (payload.mode === 'ask') writeFileSync(join(runDir, 'goal.md'), payload.goalDocument!, { mode: 0o600 });
  const child = spawn('elanous', argv, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) writeFileSync(join(runDir, 'child-pid'), String(child.pid), { mode: 0o600, flag: 'wx' });
  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_FIELD) chunks.push(chunk);
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const timeout = setTimeout(() => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  }, Math.max(1, command.deadlineAt - Date.now()));
  try {
    const code = await new Promise<number>(done => {
      child.once('error', () => done(1));
      child.once('close', (rc, signal) => done(signal ? 124 : rc ?? 1));
    });
    return { code, log: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timeout);
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
}

export async function runSiWarmRunner(frame: Uint8Array): Promise<{
  reply: SiWarmReply; bytes: SiWarmReturnedBytes; cleanup: 'clean' | 'failed';
}> {
  const { command, payloadBytes, credentialBytes } = decodeSiWarmRunnerFrame(frame);
  validatePod(command);
  const payload = parseSiWarmRunnerPayload(json(payloadBytes));
  const credentials = parseSiWarmCredentialBundle(json(credentialBytes));
  if (command.deadlineAt <= Date.now()) throw new Error('si-v1 expired');
  const active = join(CONTROL, 'si-active');
  if (existsSync(join(CONTROL, 'quarantine'))) throw new Error('si-v1 worker quarantined');
  mkdirSync(active, { mode: 0o700 });
  const runDir = join(RUNS, `${command.leaseId}-${command.generation}`);
  const startedAt = Date.now();
  try {
    if (!RUN_TOKEN.test(command.leaseId) || !Number.isSafeInteger(command.generation))
      throw new Error('si-v1 lease invalid');
    mkdirSync(RUNS, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: false, mode: 0o700 });
    const child = await executeChild(command, payload, credentials, runDir);
    const finishedAt = Date.now();
    const log = child.log;
    const terminal = terminalFromLog(log, child.code);
    const ledger = collectLedger(join(runDir, 'home'));
    const artifacts = collectArtifacts(join(runDir, 'home'));
    const bytes: SiWarmReturnedBytes = { terminal, ledger, log, artifacts };
    const reply: SiWarmReply = { ...command, startedAt, finishedAt, exitCode: child.code,
      terminalSha256: siWarmSha256(terminal), ledgerSha256: siWarmSha256(ledger),
      logSha256: siWarmSha256(log), artifacts: artifacts.map(item => ({ path: item.path,
        sha256: siWarmSha256(item.bytes), bytes: item.bytes.length })) };
    delete (reply as unknown as Record<string, unknown>).deadlineAt;
    delete (reply as unknown as Record<string, unknown>).credentialBundleSha256;
    const cleanup = finishedAt < command.deadlineAt ? 'clean' : 'failed';
    return { reply, bytes, cleanup };
  } finally {
    // The host keeps this lease fenced until it validates and adopts these bytes.
    rmSync(active, { recursive: true, force: true });
  }
}

function maintenance(verb: string, raw: unknown): { status?: number | null; stdout?: string; remaining?: number } {
  const lease = object(raw), key = object(lease?.key);
  if (!lease || !key || typeof lease.leaseId !== 'string' || !RUN_TOKEN.test(lease.leaseId)
    || !Number.isSafeInteger(lease.generation) || (lease.generation as number) < 1
    || typeof lease.sourceSha !== 'string' || !SHA.test(lease.sourceSha)
    || lease.workerId !== process.env.WARM_WORKER_ID || lease.podUid !== process.env.WARM_POD_UID
    || lease.sourceSha !== process.env.WARM_CUT_SHA || key.context !== process.env.WARM_CONTEXT
    || key.imageDigest !== process.env.WARM_IMAGE_DIGEST || key.lockHash !== process.env.WARM_LOCK_HASH
    || key.architecture !== process.env.WARM_ARCHITECTURE) throw new Error('si-v1 maintenance identity mismatch');
  const runDir = join(RUNS, `${lease.leaseId}-${lease.generation}`);
  if (!existsSync(runDir)) throw new Error('si-v1 run directory missing');
  if (verb === '--stop') {
    const path = join(runDir, 'child-pid');
    if (!existsSync(path)) throw new Error('si-v1 child pid missing');
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('si-v1 child pid invalid');
    try { process.kill(-pid, 'SIGKILL'); } catch { /* A finished group needs no signal. */ }
    try { process.kill(-pid, 0); return { remaining: 1 }; } catch { return { remaining: 0 }; }
  }
  if (verb === '--revoke') {
    rmSync(runDir, { recursive: true, force: true });
    return { remaining: existsSync(runDir) ? 1 : 0 };
  }
  const args = verb === '--git-reset' ? ['reset', '--hard', lease.sourceSha as string]
    : verb === '--git-clean' ? ['clean', '-ffdx', '-e', 'node_modules', '-e', 'apps/pwa/node_modules', '-e', '*.tsbuildinfo']
      : verb === '--git-status' ? ['status', '--porcelain', '-z'] : null;
  if (!args) throw new Error('si-v1 maintenance verb invalid');
  const result = git(args);
  return { status: result.status, stdout: result.stdout };
}

if (import.meta.main) {
  const verb = process.argv[2];
  if (verb === '--probe') {
    const head = git(['rev-parse', 'HEAD']);
    const status = git(['status', '--porcelain', '--untracked-files=no']);
    const ready = process.platform === 'linux' && head.status === 0
      && head.stdout.trim() === process.env.WARM_CUT_SHA
      && existsSync(join(REPO, 'bun.lock'))
      && siWarmSha256(readFileSync(join(REPO, 'bun.lock'))) === process.env.WARM_LOCK_HASH
      && status.status === 0 && status.stdout.trim() === ''
      && !existsSync(join(CONTROL, 'si-active')) && !existsSync(join(CONTROL, 'quarantine'));
    process.stdout.write(JSON.stringify({ protocol: 'si-v1', runner: ready ? 'ready' : 'unavailable',
      workerId: process.env.WARM_WORKER_ID ?? null, podUid: process.env.WARM_POD_UID ?? null,
      sourceSha: process.env.WARM_CUT_SHA ?? null }));
    if (!ready) process.exitCode = 2;
  } else if (verb) {
    try { process.stdout.write(JSON.stringify(maintenance(verb, JSON.parse(await Bun.stdin.text())))); }
    catch (error) { process.stderr.write(`si-v1 maintenance failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  } else {
    try {
      const result = await runSiWarmRunner(new Uint8Array(await Bun.stdin.arrayBuffer()));
      process.stdout.write(JSON.stringify({ reply: result.reply, cleanup: result.cleanup,
        bytes: { terminal: Buffer.from(result.bytes.terminal).toString('base64'),
          ledger: Buffer.from(result.bytes.ledger).toString('base64'), log: Buffer.from(result.bytes.log).toString('base64'),
          artifacts: result.bytes.artifacts.map(item => ({ path: item.path, bytes: Buffer.from(item.bytes).toString('base64') })) } }));
    } catch (error) {
      process.stderr.write(`si-v1 runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
