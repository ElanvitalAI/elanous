import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppGenerationBackend } from './app-jobs.js';

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HiggsfieldCliSessionRunner {
  run(argv: readonly string[], options?: { readonly timeoutMs?: number }): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

export interface HiggsfieldCliSessionBackendOptions {
  /** CLI credentials are owner-wide, so this adapter is explicitly bound to the one authorized test app. */
  readonly appSlug: 'voice-note';
  readonly runner?: HiggsfieldCliSessionRunner;
  readonly cliPath?: string;
  readonly allowSpend?: boolean;
  readonly tempRoot?: string;
  readonly now?: () => number;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  env.HOME = process.env.HOME || homedir();
  env.PATH = process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin';
  for (const name of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LANG', 'LC_ALL'] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function createProcessRunner(cliPath: string): HiggsfieldCliSessionRunner {
  return {
    run(argv, options) {
      return new Promise((resolve) => {
        execFile(cliPath, [...argv], {
          encoding: 'utf8',
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: childEnvironment(),
        }, (error, stdout) => {
          const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
          resolve({ stdout: typeof stdout === 'string' ? stdout : '', exitCode });
        });
      });
    },
  };
}

function json(stdout: string, label: string): unknown {
  try { return JSON.parse(stdout); } catch { throw new Error(`Higgsfield CLI ${label} returned invalid JSON`); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uploadId(stdout: string): string {
  const parsed = json(stdout, 'upload');
  if (!record(parsed) || typeof parsed.id !== 'string' || !UUID.test(parsed.id)) throw new Error('Higgsfield CLI upload ID is invalid');
  return parsed.id;
}

function productId(stdout: string): string {
  const parsed = json(stdout, 'product creation');
  if (!record(parsed) || typeof parsed.id !== 'string' || !UUID.test(parsed.id) || parsed.status !== 'completed') {
    throw new Error('Higgsfield CLI product result is invalid');
  }
  return parsed.id;
}

function createdJobId(stdout: string): string {
  const parsed = json(stdout, 'generation');
  const jobId = Array.isArray(parsed) ? parsed.length === 1 ? parsed[0] : undefined : record(parsed) ? parsed.id : undefined;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new Error('Higgsfield CLI generation ID is invalid');
  return jobId;
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password
    || (!host.endsWith('.higgsfield.ai') && !host.endsWith('.cloudfront.net'))) return undefined;
  return url.toString();
}

function pollResult(stdout: string): { readonly status: string; readonly resultUrl?: string } {
  const parsed = json(stdout, 'poll');
  if (!record(parsed) || typeof parsed.status !== 'string') throw new Error('Higgsfield CLI poll result is invalid');
  if (parsed.status !== 'completed') return { status: parsed.status };
  const resultUrl = safeResultUrl(parsed.result_url);
  return resultUrl ? { status: parsed.status, resultUrl } : { status: parsed.status };
}

async function runOrThrow(runner: HiggsfieldCliSessionRunner, argv: readonly string[], label: string, timeoutMs?: number): Promise<string> {
  let result: { readonly stdout: string; readonly exitCode: number };
  try { result = await runner.run(argv, { timeoutMs }); } catch { throw new Error(`Higgsfield CLI ${label} failed`); }
  if (result.exitCode !== 0) throw new Error(`Higgsfield CLI ${label} failed`);
  return result.stdout;
}

function fileExtension(mimeType: string): '.jpg' | '.png' | '.webp' | undefined {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return undefined;
}

/** Uses the owner's already-authenticated Higgsfield CLI session without reading, exporting, or persisting its token. */
export function createHiggsfieldCliSessionBackend(options: HiggsfieldCliSessionBackendOptions): AppGenerationBackend {
  if (options.appSlug !== 'voice-note') throw new Error('Higgsfield CLI session is not enabled for this app');
  const runner = options.runner ?? createProcessRunner(options.cliPath ?? 'higgsfield');
  const allowSpend = options.allowSpend ?? false;
  const now = options.now ?? Date.now;
  const root = options.tempRoot ?? tmpdir();

  return {
    async submit(input) {
      if (!allowSpend) throw new Error('Higgsfield CLI session spending is disabled');
      const extension = fileExtension(input.mimeType);
      if (!extension || !(input.image instanceof Uint8Array) || input.image.byteLength === 0 || input.image.byteLength > MAX_IMAGE_BYTES) {
        throw new Error('Higgsfield CLI image input is invalid');
      }
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8_000) throw new Error('Higgsfield CLI prompt is invalid');

      const tempDir = await mkdtemp(join(root, 'nexus-higgsfield-'));
      const imagePath = join(tempDir, `voice-note-product${extension}`);
      try {
        await writeFile(imagePath, input.image, { mode: 0o600, flag: 'wx' });
        const uploaded = await runOrThrow(runner, ['upload', 'create', imagePath, '--json'], 'image upload');
        const uploadedId = uploadId(uploaded);
        const title = `voice-note app product ${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
        const product = await runOrThrow(runner, ['marketing-studio', 'products', 'create', '--title', title,
          '--image', uploadedId, '--json'], 'product creation');
        const id = productId(product);
        const generated = await runOrThrow(runner, ['generate', 'create', 'marketing_studio_video',
          '--prompt', input.prompt.trim(), '--mode', 'product_showcase', '--product-ids', JSON.stringify([id]),
          '--duration', '5', '--resolution', '480p', '--json'], 'video submission', DEFAULT_TIMEOUT_MS);
        return createdJobId(generated);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    async poll(jobId) {
      if (!UUID.test(jobId)) throw new Error('Higgsfield CLI job ID is invalid');
      const output = await runOrThrow(runner, ['generate', 'get', jobId, '--json'], 'poll');
      return pollResult(output);
    },
  };
}
