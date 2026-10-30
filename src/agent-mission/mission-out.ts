import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { debug, redactSecretText } from '../debug/log.js';
import type { AsyncLockHandle } from '../storage/file-lock.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';

const MISSION_CONTEXT_ENV = 'ELANOUS_MISSION_CONTEXT';

interface MissionContext { missionId: string; storeRoot: string }

function missionContextForEnv(env: NodeJS.ProcessEnv, missionId: string): MissionContext | undefined {
  const encoded = env[MISSION_CONTEXT_ENV]?.trim();
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(encoded) as Partial<MissionContext>;
    if (value.missionId !== missionId || typeof value.storeRoot !== 'string' || !isAbsolute(value.storeRoot)) return undefined;
    return { missionId, storeRoot: resolve(value.storeRoot) };
  } catch { return undefined; }
}

function missionChildEnv(root: string, missionId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const storeRoot = resolve(root);
  return {
    ...base,
    ELANOUS_STATE_DIR: storeRoot,
    ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(storeRoot, base),
    [MISSION_CONTEXT_ENV]: JSON.stringify({ missionId, storeRoot }),
  };
}

export type MissionOutStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'timeout';
export interface MissionReplyEvent {
  type: 'mission.reply';
  missionId: string;
  sequence: number;
  text: string;
  done: boolean;
  createdAt: string;
  kind?: string;
  defaults?: string;
  deadline?: string;
  scope?: string;
  stop?: boolean;
  priority?: string;
}
export interface MissionReplyMessageFields {
  kind?: string;
  defaults?: string;
  deadline?: string;
  scope?: string;
  stop?: boolean;
  priority?: string;
}
export interface MissionOutRecord {
  missionId: string;
  agent: 'codex' | 'claude';
  prompt: string;
  cwd: string;
  outputPath: string;
  targetOutputPath: string;
  status: MissionOutStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: string;
  doneReceived?: boolean;
  pendingFinalReply?: string;
  workerPid?: number;
  agentPid?: number;
}
export interface MissionOutStoreDeps {
  now?: () => Date;
  id?: () => string;
  emit?: (event: MissionReplyEvent) => void;
}

export interface MissionCancelResult { record: MissionOutRecord; transitioned: boolean }

const MISSION_LOCK_STALE_MS = 30_000;
const MISSION_LOCK_RETRY_MS = 25;
const MISSION_LOCK_MAX_TRIES = 240;

class MissionLockStaleError extends Error {
  constructor(readonly missionId: string, readonly ageMs: number) {
    super(`미션 잠금이 낡았습니다(${Math.round(ageMs)}ms). 자동 회수하지 않았습니다; 잠금이 풀린 뒤 재시도하거나 담당자 판단이 필요합니다`);
    this.name = 'MissionLockStaleError';
  }
}

async function acquireMissionLock(lockPath: string, missionId: string, onStale: (ageMs: number) => void): Promise<AsyncLockHandle> {
  for (let attempt = 0; attempt < MISSION_LOCK_MAX_TRIES; attempt += 1) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, `${token}\n`); }
      catch (error) { try { unlinkSync(lockPath); } catch { /* best effort for the file we just created */ } throw error; }
      finally { closeSync(fd); }

      let lost = false;
      const ownsFile = (): boolean => {
        try { return readFileSync(lockPath, 'utf8').trim() === token; }
        catch { return false; }
      };
      const heartbeat = setInterval(() => {
        if (lost) return;
        if (!ownsFile()) { lost = true; clearInterval(heartbeat); return; }
        try { const now = new Date(); utimesSync(lockPath, now, now); }
        catch { lost = true; clearInterval(heartbeat); }
      }, Math.floor(MISSION_LOCK_STALE_MS / 3));
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      return {
        stillHeld: () => !lost && ownsFile(),
        release: () => {
          clearInterval(heartbeat);
          if (ownsFile()) { try { unlinkSync(lockPath); } catch { /* owner has already gone */ } }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ageMs: number;
      try {
        const first = statSync(lockPath);
        ageMs = Date.now() - first.mtimeMs;
        const token = readFileSync(lockPath, 'utf8').trim();
        const current = statSync(lockPath);
        if (first.ino !== current.ino || token !== readFileSync(lockPath, 'utf8').trim()) continue;
        ageMs = Date.now() - current.mtimeMs;
      } catch { continue; }
      if (ageMs > MISSION_LOCK_STALE_MS) {
        onStale(ageMs);
        throw new MissionLockStaleError(missionId, ageMs);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, MISSION_LOCK_RETRY_MS));
    }
  }
  throw new Error(`mission lock timed out at ${lockPath}`);
}

const validId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id);
const safeRecordPath = (root: string, id: string): string => {
  if (!validId(id)) throw new Error('missionId 형식이 올바르지 않습니다');
  return join(root, 'agent-missions', `${id}.json`);
};
const replyPath = (root: string, id: string): string => safeRecordPath(root, id).replace(/\.json$/, '.replies.jsonl');

function validateReplyMessageFields(fields: MissionReplyMessageFields): MissionReplyMessageFields {
  for (const key of ['kind', 'defaults', 'deadline', 'scope', 'priority'] as const) {
    const value = fields[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`reply ${key} 는 비어 있지 않은 문자열이어야 합니다`);
  }
  if (fields.stop !== undefined && typeof fields.stop !== 'boolean') throw new Error('reply stop 은 boolean 이어야 합니다');
  if (fields.kind === 'correct' && (!fields.scope || fields.stop === undefined || !fields.priority)) {
    throw new Error('reply kind=correct 에는 scope, stop, priority 가 필요합니다');
  }
  // ask / answer / correct are reserved names. Unknown names remain accepted
  // as extension kinds; their behavior is intentionally deferred to 0.2.43.
  return fields;
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

export function createMissionOutStore(root: string, deps: MissionOutStoreDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const withLock = async <T>(missionId: string, action: (lock: AsyncLockHandle) => T): Promise<T> => {
    const lockPath = `${replyPath(root, missionId)}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const lock = await acquireMissionLock(lockPath, missionId, (lockAgeMs) => {
      debug.log('agent-mission', 'lock-stale', { missionId, lockAgeMs, recovery: 'manual-or-retry' });
    });
    try { return action(lock); }
    finally { lock.release(); }
  };
  const read = (missionId: string): MissionOutRecord | null => {
    try {
      const value: unknown = JSON.parse(readFileSync(safeRecordPath(root, missionId), 'utf8'));
      if (!value || typeof value !== 'object' || (value as MissionOutRecord).missionId !== missionId) return null;
      return value as MissionOutRecord;
    } catch { return null; }
  };
  const replies = (missionId: string): MissionReplyEvent[] => {
    try {
      return readFileSync(replyPath(root, missionId), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          const event: unknown = JSON.parse(line);
          return event && typeof event === 'object' && (event as MissionReplyEvent).type === 'mission.reply'
            && (event as MissionReplyEvent).missionId === missionId ? [event as MissionReplyEvent] : [];
        } catch { return []; }
      });
    } catch { return []; }
  };
  return {
    create(input: { missionId?: string; agent: 'codex' | 'claude'; prompt: string; cwd: string; outputPath: string; targetOutputPath: string }): MissionOutRecord {
      const dir = join(root, 'agent-missions');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const createdAt = now().toISOString();
      const record: MissionOutRecord = {
        missionId: input.missionId ?? (deps.id ?? randomUUID)(), ...input, status: 'running', createdAt, updatedAt: createdAt,
      };
      const path = safeRecordPath(root, record.missionId);
      if (existsSync(path)) throw new Error('missionId 충돌');
      atomicJson(path, record);
      return record;
    },
    read,
    replies,
    lockStale(missionId: string): boolean {
      try { return Date.now() - statSync(`${replyPath(root, missionId)}.lock`).mtimeMs > MISSION_LOCK_STALE_MS; }
      catch { return false; }
    },
    async reply(missionId: string, text: string, done = false, fields: MissionReplyMessageFields = {}): Promise<MissionReplyEvent> {
      if (!text.trim()) throw new Error('reply 본문이 비었습니다');
      const messageFields = validateReplyMessageFields(fields);
      return withLock(missionId, (lock) => {
        const current = read(missionId);
        if (!current) throw new Error(`미션을 찾을 수 없습니다: ${missionId}`);
        if (current.status !== 'running') throw new Error(`미션이 실행 중이 아닙니다: ${current.status}`);
        if (current.doneReceived || replies(missionId).some((event) => event.done)) throw new Error('최종 답변이 이미 제출됐습니다');
        const event: MissionReplyEvent = {
          type: 'mission.reply', missionId, sequence: replies(missionId).length + 1,
          text, done, createdAt: now().toISOString(), ...messageFields,
        };
        if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 reply 기록을 중단했습니다');
        appendFileSync(replyPath(root, missionId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
        if (!done) {
          try { deps.emit?.(event); } catch { /* observation failure cannot lose a persisted reply */ }
        }
        if (done) {
          current.doneReceived = true;
          // The agent's claimed final answer is not public until the worker
          // exits successfully and validates the required output file.
          current.pendingFinalReply = text;
          current.updatedAt = event.createdAt;
          if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 reply 상태 저장을 중단했습니다');
          atomicJson(safeRecordPath(root, missionId), current);
        }
        return event;
      });
    },
    complete(missionId: string): Promise<MissionOutRecord> {
      return withLock(missionId, (lock) => {
        const record = read(missionId);
        if (!record) throw new Error(`미션을 찾을 수 없습니다: ${missionId}`);
        if (record.status !== 'running') return record;
        if (!existsSync(record.outputPath) || statSync(record.outputPath).size === 0) throw new Error('결과 파일이 없어 미션을 실패 처리했습니다');
        const finalText = record.pendingFinalReply ?? readFileSync(record.outputPath, 'utf8');
        if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 결과 공개를 중단했습니다');
        renameSync(record.outputPath, record.targetOutputPath);
        if (!lock.stillHeld()) {
          try { renameSync(record.targetOutputPath, record.outputPath); } catch { /* keep the failed transition fail-closed */ }
          throw new Error('미션 상태 잠금을 잃어 완료 기록을 중단했습니다');
        }
        record.status = 'completed';
        record.updatedAt = now().toISOString();
        record.result = finalText;
        record.doneReceived = true;
        delete record.pendingFinalReply;
        atomicJson(safeRecordPath(root, missionId), record);
        const finalEvent = replies(missionId).find((event) => event.done);
        if (finalEvent) {
          try { deps.emit?.(finalEvent); } catch { /* persisted final reply remains authoritative */ }
        }
        return read(missionId)!;
      });
    },
    finish(missionId: string, outcome: { status: 'cancelled' | 'failed' | 'timeout'; error?: string }): Promise<MissionOutRecord> {
      return withLock(missionId, (lock) => {
        const record = read(missionId);
        if (!record) throw new Error(`미션을 찾을 수 없습니다: ${missionId}`);
        if (record.status === 'running') {
          record.status = outcome.status;
          record.updatedAt = now().toISOString();
          delete record.result;
          delete record.doneReceived;
          delete record.pendingFinalReply;
          if (outcome.error !== undefined) record.error = outcome.error;
          if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 terminal 상태 저장을 중단했습니다');
          atomicJson(safeRecordPath(root, missionId), record);
        }
        return read(missionId)!;
      });
    },
    setPids(missionId: string, pids: { workerPid?: number; agentPid?: number }): Promise<MissionOutRecord> {
      return withLock(missionId, (lock) => {
        const record = read(missionId);
        if (!record) throw new Error(`미션을 찾을 수 없습니다: ${missionId}`);
        if (record.status === 'running') {
          Object.assign(record, pids, { updatedAt: now().toISOString() });
          if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 PID 저장을 중단했습니다');
          atomicJson(safeRecordPath(root, missionId), record);
        }
        return read(missionId)!;
      });
    },
    cancel(missionId: string): Promise<MissionCancelResult> {
      return withLock(missionId, (lock) => {
        const record = read(missionId);
        if (!record) throw new Error(`미션을 찾을 수 없습니다: ${missionId}`);
        const transitioned = record.status === 'running';
        if (transitioned) {
          record.status = 'cancelled';
          record.updatedAt = now().toISOString();
          delete record.pendingFinalReply;
          delete record.doneReceived;
          delete record.result;
          if (!lock.stillHeld()) throw new Error('미션 상태 잠금을 잃어 취소를 저장하지 않았습니다');
          atomicJson(safeRecordPath(root, missionId), record);
        }
        return { record: read(missionId)!, transitioned };
      });
    },
  };
}

export type MissionAgentRunner = (record: MissionOutRecord, prompt: string) => Promise<{ code: number | null; stderr?: string }>;

async function createObservedMissionOutStore(root: string) {
  const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
  await registerStandaloneLogSink('agent-mission');
  return createMissionOutStore(root, { emit: (event) => debug.log('agent-mission', 'reply', event) });
}

export async function runMissionOutWorker(root: string, missionId: string, runAgent?: MissionAgentRunner): Promise<void> {
  const store = await createObservedMissionOutStore(root);
  const record = store.read(missionId);
  if (!record || record.status !== 'running') return;
  try {
    await store.setPids(missionId, { workerPid: process.pid });
    if (store.read(missionId)?.status !== 'running') return;
    const prompt = `${record.prompt}${renderMissionAgentInstructions(missionId, root)}\n\nWrite the final answer to the requested output file: ${record.outputPath}`;
    const result = await (runAgent ?? createProcessAgentRunner(root))(record, prompt);
    if (result.code !== 0) throw new Error(`agent exited with code ${String(result.code)}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`);
    if (!existsSync(record.outputPath) || statSync(record.outputPath).size === 0) throw new Error('결과 파일이 없어 미션을 실패 처리했습니다');
    const latest = store.read(missionId);
    if (!latest || latest.status !== 'running') return;
    if (!latest.doneReceived) await store.reply(missionId, readFileSync(record.outputPath, 'utf8'), true);
    await store.complete(missionId);
  } catch (e) {
    const latest = store.read(missionId);
    if (latest?.status === 'running') {
      try {
        await store.finish(missionId, {
          status: 'failed',
          error: redactSecretText(String(e)).replace(record.outputPath, '[internal output]').replace(record.targetOutputPath, '[output]'),
        });
      } catch (stateError) {
        debug.log('agent-mission', 'terminal-write-failed', { missionId, error: redactSecretText(String(stateError)) }, { level: 'error' });
      }
    }
  }
}

export function createProcessAgentRunner(root: string, spawnProcess: typeof spawn = spawn): MissionAgentRunner {
  return async (record, prompt) => {
    const backend = record.agent === 'codex'
      ? { command: 'codex', args: ['exec', '--approve-for-me', '--output-last-message', record.outputPath, '-'], scrub: ['OPENAI_API_KEY'] }
      : { command: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], scrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] };
    const env = missionChildEnv(root, record.missionId);
    for (const key of backend.scrub) delete env[key];
    const child = spawnProcess(backend.command, backend.args, { cwd: record.cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderrTail = '';
    let spawnFailure: Error | undefined;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderrTail = `${stderrTail}${chunk}`.slice(-4000); });
    const processOutcome = new Promise<{ code?: number | null; error?: Error }>((resolveExit) => {
      child.once('error', (error: Error) => { spawnFailure = error; resolveExit({ error }); });
      child.once('close', (code) => resolveExit({ code }));
    });
    if (child.pid) await createMissionOutStore(root).setPids(record.missionId, { agentPid: child.pid });
    if (spawnFailure) throw spawnFailure;
    child.stdin.end(prompt);
    const outcome = await processOutcome;
    if (outcome.error) throw outcome.error;
    return { code: outcome.code ?? null, stderr: redactSecretText(stderrTail) };
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderMissionAgentInstructions(missionId: string, storeRoot: string): string {
  const rootArg = `--config-dir ${shellQuote(resolve(storeRoot))}`;
  const missionArg = `--mission ${missionId}`;
  return [
    '',
    'Elanous mission reply contract:',
    `- Send progress or a question with: eln ${rootArg} mission reply ${missionArg} "<message>"`,
    `- When the task is complete, send the final answer with: eln ${rootArg} mission reply ${missionArg} --done "<final answer>"`,
    `- Inspect this mission with: eln ${rootArg} mission status ${missionId} --json`,
    '- Keep the reply concise. Do not report a filesystem path as the result.',
  ].join('\n');
}

const missionUsage = {
  command: 'eln mission',
  commands: {
    run: {
      args: [], flags: ['--agent codex|claude', '--prompt <text>|--prompt-file <path>', '--out <path>', '--dry-run', '--output-format json'],
      responseSchema: { type: 'object', required: ['id', 'missionId', 'status'], properties: { id: { type: 'string', format: 'uuid' }, missionId: { type: 'string', format: 'uuid' }, status: { const: 'running' }, artifacts: { type: 'array', items: { type: 'string' } } } },
    },
    status: {
      args: ['<id>'],
      responseSchema: { type: 'object', required: ['id', 'missionId', 'status', 'artifacts', 'replies'], properties: { id: { type: 'string', format: 'uuid' }, missionId: { type: 'string', format: 'uuid' }, status: { enum: ['running', 'done', 'cancelled', 'failed', 'timeout'] }, body: { type: 'string' }, artifacts: { type: 'array', items: { type: 'string' } }, replies: { type: 'array', items: { $ref: '#/events/mission.reply' } }, result: { type: 'string' }, lockStale: { type: 'boolean' }, error: { type: 'string' } } },
    },
    reply: {
      args: ['[missionId]', '[text|stdin]'], flags: ['--mission <missionId>', '--done', '--kind <kind>', '--defaults <text>', '--deadline <value>', '--scope <text>', '--[no-]stop', '--priority <value>'],
      responseSchema: { type: 'object', required: ['missionId', 'accepted', 'sequence', 'done'], properties: { missionId: { type: 'string', format: 'uuid' }, accepted: { const: true }, sequence: { type: 'integer', minimum: 1 }, done: { type: 'boolean' } } },
    },
    cancel: {
      args: ['<missionId>'],
      responseSchema: { type: 'object', required: ['missionId', 'status', 'cancelled'], properties: { missionId: { type: 'string', format: 'uuid' }, status: { enum: ['running', 'completed', 'cancelled', 'failed'] }, cancelled: { type: 'boolean' } } },
    },
  },
  events: { 'mission.reply': { type: 'object', required: ['type', 'missionId', 'sequence', 'text', 'done', 'createdAt'], properties: { type: { const: 'mission.reply' }, missionId: { type: 'string', format: 'uuid' }, sequence: { type: 'integer' }, text: { type: 'string' }, done: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, kind: { type: 'string', description: 'Reserved kinds: ask, answer, correct. Unknown kinds are accepted as no-op extensions.' }, defaults: { type: 'string' }, deadline: { type: 'string' }, scope: { type: 'string' }, stop: { type: 'boolean' }, priority: { type: 'string' } } } },
  replyContract: 'Use `eln --config-dir <storeRoot> mission reply --mission <missionId> <text> [--kind ask|answer|correct]` for replies and `eln --config-dir <storeRoot> mission reply --mission <missionId> --done <text>` for the final answer.',
  agentInstructionBlock: [
    'You can send durable progress and final answers to Elanous with `eln mission reply`.',
    'Use `eln --config-dir <storeRoot> mission reply --mission <missionId> "<message>"` for progress/questions.',
    'Reserved message kinds: ask, answer, correct. Unknown kinds are accepted but have no special behavior.',
    'Finish with `eln --config-dir <storeRoot> mission reply --mission <missionId> --done "<final answer>"`.',
    'Use `eln --config-dir <storeRoot> mission status <missionId>` to inspect the interaction; do not return output file paths.',
  ].join('\n'),
};

export function registerMissionOutCommand(program: Command, deps: {
  stateRoot?: () => string;
  emit?: (event: MissionReplyEvent) => void;
  readStdin?: () => Promise<string>;
  write?: (text: string) => void;
  error?: (text: string) => void;
  startWorker?: (root: string, missionId: string) => number;
} = {}): Command {
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const error = deps.error ?? ((text) => process.stderr.write(text));
  const root = async (): Promise<string> => deps.stateRoot ? deps.stateRoot() : (await import('../instance/resolve.js')).effectiveInstanceRoot();
  const storeAt = async (observeReplies = false) => {
    const stateRoot = await root();
    if (deps.emit) return createMissionOutStore(stateRoot, { emit: deps.emit });
    return observeReplies ? createObservedMissionOutStore(stateRoot) : createMissionOutStore(stateRoot);
  };
  const observingStoreAt = async (stateRoot: string) => deps.emit
    ? createMissionOutStore(stateRoot, { emit: deps.emit })
    : createObservedMissionOutStore(stateRoot);
  const replyStoreAt = async (missionId: string) => {
    const missionContext = missionContextForEnv(process.env, missionId);
    return missionContext ? observingStoreAt(missionContext.storeRoot) : storeAt(true);
  };
  const out = (opts: { json?: boolean; outputFormat?: string }, value: unknown): void => {
    write(opts.json || opts.outputFormat === 'json' ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
  };
  const cmd = program.command('mission').description('Run a stateless Codex/Claude mission and exchange replies by missionId');
  cmd.option('--usage', 'Print machine-readable mission command tree').action((opts: { usage?: boolean }) => {
    if (opts.usage) out({ json: true }, missionUsage);
    else error('사용법: eln mission --usage | run | status | reply | cancel');
  });

  cmd.command('run')
    .option('--agent <name>', 'codex or claude')
    .option('--prompt <text>', 'Mission prompt')
    .option('--prompt-file <path>', 'Read the prompt from a UTF-8 file')
    .option('--out <path>', 'Internal result file required for fail-closed completion')
    .option('--dry-run', 'Resolve and print request without creating a job')
    .option('--json', 'Emit JSON')
    .option('--output-format <format>', 'text or json', 'text')
    .action(async (opts: { agent?: string; prompt?: string; promptFile?: string; out?: string; dryRun?: boolean; json?: boolean; outputFormat?: string; usage?: boolean }, command: Command) => {
      if (opts.usage || command.optsWithGlobals().usage) { out({ json: true }, missionUsage.commands.run); return; }
      if (!opts.agent) { error('--agent 는 필수입니다\n'); process.exitCode = 2; return; }
      if (!opts.out) { error('--out 은 필수입니다\n'); process.exitCode = 2; return; }
      if (!['codex', 'claude'].includes(opts.agent)) { error('--agent 는 codex 또는 claude 여야 합니다\n'); process.exitCode = 2; return; }
      if ((opts.prompt === undefined) === (opts.promptFile === undefined)) { error('--prompt 와 --prompt-file 중 하나만 지정하세요\n'); process.exitCode = 2; return; }
      let prompt = opts.prompt ?? '';
      try { if (opts.promptFile) prompt = readFileSync(resolve(opts.promptFile), 'utf8'); }
      catch (e) { error(`프롬프트 파일 읽기 실패: ${String(e)}\n`); process.exitCode = 1; return; }
      if (!prompt.trim()) { error('프롬프트가 비었습니다\n'); process.exitCode = 2; return; }
      const targetOutputPath = resolve(opts.out);
      if (opts.outputFormat && !['text', 'json'].includes(opts.outputFormat)) { error('--output-format 은 text 또는 json 이어야 합니다\n'); process.exitCode = 2; return; }
      if (opts.dryRun) { out(opts, { agent: opts.agent, promptChars: prompt.length, outputConfigured: true, cwd: process.cwd(), resolved: true }); return; }
      const store = await storeAt();
      let record: MissionOutRecord | undefined;
      try {
        const missionId = randomUUID();
        const outputPath = `${targetOutputPath}.eln-mission-${missionId}.tmp`;
        record = store.create({ missionId, agent: opts.agent as 'codex' | 'claude', prompt, cwd: process.cwd(), outputPath, targetOutputPath });
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dirname(targetOutputPath), { recursive: true });
        let workerPid: number;
        if (deps.startWorker) workerPid = deps.startWorker(await root(), record.missionId);
        else {
          const { spawn } = await import('node:child_process');
          const entry = process.argv[1];
          if (!entry) throw new Error('CLI 엔트리 경로를 확인할 수 없습니다');
          const stateRoot = await root();
          const child = spawn(process.execPath, [entry, 'mission', '__worker', record.missionId], {
            cwd: record.cwd, detached: true, stdio: 'ignore', env: missionChildEnv(stateRoot, record.missionId),
          });
          if (!child.pid) throw new Error('미션 워커 PID 생성 실패');
          child.unref();
          workerPid = child.pid;
        }
        await store.setPids(record.missionId, { workerPid });
      out(opts, { id: record.missionId, missionId: record.missionId, status: 'running', artifacts: [] });
      } catch (e) {
        if (record) {
          try { await store.finish(record.missionId, { status: 'failed', error: redactSecretText(String(e)) }); }
          catch (stateError) { debug.log('agent-mission', 'terminal-write-failed', { missionId: record.missionId, error: redactSecretText(String(stateError)) }, { level: 'error' }); }
        }
        error(`미션 시작 실패: ${String(e)}\n`); process.exitCode = 1;
      }
    });

  cmd.command('status <missionId>').alias('get')
    .option('--json', 'Emit JSON').option('--output-format <format>', 'text or json', 'text')
    .action(async (missionId: string, opts: { json?: boolean; outputFormat?: string; usage?: boolean }, command: Command) => {
      if (opts.usage || command.optsWithGlobals().usage) { out({ json: true }, missionUsage.commands.status); return; }
      const store = await storeAt();
      const record = store.read(missionId);
      if (!record) { error(`미션을 찾을 수 없습니다: ${missionId}\n`); process.exitCode = 1; return; }
      const lockStale = store.lockStale(missionId);
      if (lockStale && !deps.emit) {
        const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
        await registerStandaloneLogSink('agent-mission');
        debug.log('agent-mission', 'lock-stale', { missionId, recovery: 'manual-or-retry', observedBy: 'status' });
      }
      const publicRecord = {
        id: record.missionId, missionId: record.missionId, agent: record.agent,
        status: record.status === 'completed' ? 'done' : record.status,
        lockStale,
        ...(record.result !== undefined ? { body: record.result, artifacts: [record.targetOutputPath] }
          : record.error !== undefined ? { body: record.error, artifacts: [] as string[] }
            : { artifacts: [] as string[] }),
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        ...(record.doneReceived ? { doneReceived: true } : {}),
        ...(record.result !== undefined ? { result: record.result } : {}),
        ...(record.error !== undefined ? { error: record.error } : {}),
      };
      const visibleReplies = store.replies(missionId).filter((event) => !event.done || record.status === 'completed');
      out(opts, { ...publicRecord, replies: visibleReplies });
    });

  cmd.command('reply [args...]')
    .option('--mission <missionId>', 'Explicit mission ID (works with a separately selected --config-dir)')
    .option('--done', 'Mark this as the final reply')
    .option('--kind <kind>', 'Reserved message kind: ask, answer, or correct')
    .option('--defaults <text>', 'Default values attached to an ask')
    .option('--deadline <value>', 'Requested deadline attached to an ask')
    .option('--scope <text>', 'Correction scope')
    .option('--[no-]stop', 'Correction stop request')
    .option('--priority <value>', 'Correction priority')
    .option('--json', 'Emit JSON').option('--output-format <format>', 'text or json', 'text')
    .action(async (rawArgs: string[], opts: { mission?: string; done?: boolean; kind?: string; defaults?: string; deadline?: string; scope?: string; stop?: boolean; priority?: string; json?: boolean; outputFormat?: string; usage?: boolean }, command: Command) => {
      if (opts.usage || command.optsWithGlobals().usage) { out({ json: true }, missionUsage.commands.reply); return; }
      const args = [...rawArgs];
      const missionId = opts.mission?.trim() || args.shift();
      if (!missionId) { error('--mission <missionId> 또는 positional <missionId> 가 필요합니다\n'); process.exitCode = 2; return; }
      let text = args.join(' ');
      if (!text.trim()) text = await (deps.readStdin ?? (async () => (await import('../cli/piped-stdin.js')).readPipedStdin()))();
      try {
        const event = await (await replyStoreAt(missionId)).reply(missionId, text, opts.done, {
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.defaults !== undefined ? { defaults: opts.defaults } : {}),
          ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        });
        out(opts, { missionId, accepted: true, sequence: event.sequence, done: event.done });
      } catch (e) { error(`${String(e)}\n`); process.exitCode = 1; }
    });

  cmd.command('cancel <missionId>')
    .option('--json', 'Emit JSON').option('--output-format <format>', 'text or json', 'text')
    .action(async (missionId: string, opts: { json?: boolean; outputFormat?: string; usage?: boolean }, command: Command) => {
      if (opts.usage || command.optsWithGlobals().usage) { out({ json: true }, missionUsage.commands.cancel); return; }
      const store = await storeAt();
      try {
        const { record, transitioned } = await store.cancel(missionId);
        if (record.workerPid && transitioned) {
          try { process.kill(-record.workerPid, 'SIGTERM'); } catch { try { process.kill(record.workerPid, 'SIGTERM'); } catch { /* worker already exited */ } }
        }
        out(opts, { id: missionId, missionId, status: record.status === 'completed' ? 'done' : record.status, cancelled: record.status === 'cancelled' });
      } catch (e) { error(`${String(e)}\n`); process.exitCode = 1; }
    });

  cmd.command('__worker <missionId>', { hidden: true }).action(async (missionId: string) => {
    await runMissionOutWorker(await root(), missionId);
  });
  return cmd;
}
