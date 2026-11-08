import type { ShootBackend, ShootCommand } from './shoot-run.js';

export interface CommandRunner {
  run(
    argv: readonly string[],
    options?: { readonly timeoutMs?: number },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number; readonly raw?: Uint8Array }>;
}

export interface HiggsfieldBackendOptions {
  readonly runner: CommandRunner;
  readonly allowSpend?: boolean;
  readonly cliPath?: string;
  readonly submitTimeoutMs?: number;
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 20 * 60 * 1000;
const UUID_LIKE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commandText(argv: readonly string[]): string {
  return argv.join(' ');
}

function requireSpendAllowed(argv: readonly string[], allowSpend: boolean): void {
  if (!allowSpend) throw new Error(`Higgsfield spending is disabled; would run: ${commandText(argv)}`);
}

function requirePrompt(args: readonly string[]): void {
  const promptIndexes = args.reduce<number[]>((indexes, arg, index) => {
    if (arg === '--prompt') indexes.push(index);
    return indexes;
  }, []);
  if (promptIndexes.length !== 1) throw new Error('Higgsfield submission requires exactly one --prompt value.');

  const prompt = args[promptIndexes[0]! + 1];
  if (!prompt || !prompt.trim() || prompt.startsWith('-')) {
    throw new Error('Higgsfield submission requires a non-empty --prompt value.');
  }
}

async function runOrThrow(
  runner: CommandRunner,
  argv: readonly string[],
  options?: { readonly timeoutMs?: number },
): Promise<string> {
  const result = await runner.run(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Higgsfield command failed with exit code ${result.exitCode}.`);
  }
  return result.stdout;
}

function parseJobId(stdout: string): string {
  const jobId = stdout.trim();
  if (!UUID_LIKE_JOB_ID.test(jobId)) throw new Error(`Higgsfield returned an invalid job id: ${jobId}`);
  return jobId;
}

function parsePollResult(stdout: string): { readonly status: string; readonly resultUrl?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Higgsfield returned invalid JSON while polling.');
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { status?: unknown }).status !== 'string') {
    throw new Error('Higgsfield poll result requires a string status.');
  }
  const { status, result_url: resultUrl } = parsed as {
    readonly status: string;
    readonly result_url?: unknown;
  };
  if (resultUrl !== undefined && resultUrl !== null && typeof resultUrl !== 'string') {
    throw new Error('Higgsfield poll result has an invalid result_url.');
  }
  return typeof resultUrl === 'string' ? { status, resultUrl } : { status };
}

export function createHiggsfieldBackend(options: HiggsfieldBackendOptions): ShootBackend {
  const cliPath = options.cliPath ?? 'higgsfield';
  const allowSpend = options.allowSpend ?? false;
  const submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

  return {
    async submit(command: ShootCommand): Promise<string> {
      const argv = [cliPath, 'generate', 'create', command.jobType, ...command.args,
        ...(command.durationSeconds === undefined ? [] : ['--duration', String(command.durationSeconds)])];
      requirePrompt(command.args);
      requireSpendAllowed(argv, allowSpend);
      return parseJobId(await runOrThrow(options.runner, argv, { timeoutMs: submitTimeoutMs }));
    },
    async poll(jobId: string): Promise<{ readonly status: string; readonly resultUrl?: string }> {
      const argv = [cliPath, 'generate', 'get', jobId, '--json'];
      return parsePollResult(await runOrThrow(options.runner, argv));
    },
  };
}
