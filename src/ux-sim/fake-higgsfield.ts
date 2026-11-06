import type { CommandRunner } from '../ad-pipeline/higgsfield-backend.js';
import { createHash } from 'node:crypto';

type FakeHiggsfieldOutcome = 'completed' | 'failed';

interface FakeHiggsfieldOptions {
  readonly seed: string;
  readonly deviceOptIn: true;
  readonly maxSubmissions?: number;
  readonly outcome?: FakeHiggsfieldOutcome;
  readonly now?: () => number;
  readonly resultUrlTtlMs?: number;
}

interface FakeHiggsfieldCall {
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
}

interface FakeHiggsfieldLedger {
  readonly submissions: number;
  readonly polls: number;
  readonly calls: readonly FakeHiggsfieldCall[];
}

interface FakeJob {
  polls: number;
  completedAt?: number;
}

const DEFAULT_RESULT_URL_TTL_MS = 60_000;

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  bytes[12] = '4';
  bytes[16] = ((Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFakeHiggsfieldRunner(options: FakeHiggsfieldOptions): CommandRunner & {
  readonly ledger: FakeHiggsfieldLedger;
} {
  if (options.deviceOptIn !== true) {
    throw new Error('Fake Higgsfield submissions require deviceOptIn: true.');
  }
  const maxSubmissions = options.maxSubmissions ?? Number.POSITIVE_INFINITY;
  if (maxSubmissions !== Number.POSITIVE_INFINITY && (maxSubmissions < 0 || !Number.isInteger(maxSubmissions))) {
    throw new Error('Fake Higgsfield maxSubmissions must be a non-negative integer.');
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.resultUrlTtlMs ?? DEFAULT_RESULT_URL_TTL_MS;
  if (ttlMs < 0 || !Number.isFinite(ttlMs)) throw new Error('Fake Higgsfield resultUrlTtlMs must be non-negative.');

  const jobs = new Map<string, FakeJob>();
  const calls: FakeHiggsfieldCall[] = [];
  let submissions = 0;
  let polls = 0;

  const runner: CommandRunner & { readonly ledger: FakeHiggsfieldLedger } = {
    get ledger() {
      return {
        submissions,
        polls,
        calls: calls.map((call) => ({ ...call, argv: [...call.argv] })),
      };
    },
    async run(argv, runOptions) {
      calls.push({ argv: [...argv], timeoutMs: runOptions?.timeoutMs });
      const commandIndex = argv.findIndex((arg, index) =>
        arg === 'generate' && (argv[index + 1] === 'create' || argv[index + 1] === 'get'),
      );
      const command = commandIndex >= 0 ? argv.slice(commandIndex) : [];
      if (command[0] === 'generate' && command[1] === 'create') {
        if (submissions >= maxSubmissions) {
          return { stdout: '', stderr: 'HIGGSFIELD_SUBMISSION_LIMIT: submission limit exceeded', exitCode: 1 };
        }
        const id = deterministicUuid(`${options.seed}:${submissions}`);
        submissions += 1;
        jobs.set(id, { polls: 0 });
        return { stdout: id, stderr: '', exitCode: 0 };
      }
      if (command[0] === 'generate' && command[1] === 'get' && command.at(-1) === '--json') {
        const id = command[2];
        const job = id ? jobs.get(id) : undefined;
        if (!job) return { stdout: '', stderr: 'HIGGSFIELD_JOB_NOT_FOUND: unknown job id', exitCode: 1 };
        polls += 1;
        job.polls += 1;
        if (job.polls === 1) return { stdout: JSON.stringify({ status: 'queued' }), stderr: '', exitCode: 0 };
        if (job.polls === 2) return { stdout: JSON.stringify({ status: 'in_progress' }), stderr: '', exitCode: 0 };
        if (options.outcome === 'failed') {
          return { stdout: JSON.stringify({ status: 'failed' }), stderr: '', exitCode: 0 };
        }
        job.completedAt ??= now();
        const expired = now() - job.completedAt >= ttlMs;
        return {
          stdout: JSON.stringify({ status: 'completed', ...(expired ? {} : { result_url: `https://fake-higgsfield.invalid/${id}.mp4` }) }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: 'HIGGSFIELD_UNSUPPORTED_COMMAND: unsupported argv', exitCode: 2 };
    },
  };
  return runner;
}
