import { spawnSync } from 'node:child_process';

const PACKAGE_MANAGERS = ['brew', 'apt', 'npm', 'pip', 'bun'] as const;
const CLI_TOOLS = ['git', 'jq', 'rg', 'sed', 'awk', 'curl', 'ffmpeg', 'docker', 'kubectl', 'gh', 'codex', 'claude'] as const;

export interface EnvProfile {
  os: string;
  shell: string | null;
  packageManagers: string[];
  tools: string[];
  credentials: Record<string, boolean>;
  network: boolean;
  disk: { availableKb: number } | null;
}

export interface EnvProfileDeps {
  which?: (name: string) => boolean;
  exec?: (command: string, args: string[]) => { status: number | null; stdout: string };
  env?: NodeJS.ProcessEnv;
}

const defaultExec: NonNullable<EnvProfileDeps['exec']> = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '' };
};

const defaultWhich: NonNullable<EnvProfileDeps['which']> = (name) =>
  spawnSync('which', [name], { stdio: 'ignore', timeout: 3_000 }).status === 0;

/** Collects a bounded, non-secret snapshot; no credential value is read or returned. */
export function collectEnvProfile(deps: EnvProfileDeps = {}): EnvProfile {
  const which = deps.which ?? defaultWhich;
  const exec = deps.exec ?? defaultExec;
  const env = deps.env ?? process.env;
  const available = (name: string): boolean => {
    try { return which(name); } catch { return false; }
  };
  const run = (command: string, args: string[]): { status: number | null; stdout: string } | null => {
    try { return exec(command, args); } catch { return null; }
  };

  const packageManagers = PACKAGE_MANAGERS.filter(available);
  const tools = CLI_TOOLS.filter(available);
  const credentials = {
    github: Object.hasOwn(env, 'GH_TOKEN') || Object.hasOwn(env, 'GITHUB_TOKEN'),
    openai: Object.hasOwn(env, 'OPENAI_API_KEY'),
    anthropic: Object.hasOwn(env, 'ANTHROPIC_API_KEY'),
  };
  const network = tools.includes('curl') && run('curl', ['--head', '--silent', '--output', '/dev/null', '--max-time', '3', 'https://example.com'])?.status === 0;
  const diskResult = run('df', ['-kP', '.']);
  const diskFields = diskResult?.status === 0
    ? diskResult.stdout.trim().split(/\r?\n/).slice(1).join(' ').trim().split(/\s+/)
    : [];
  const availableKb = diskFields.length >= 6
    && diskFields.slice(1, 4).every((field) => /^\d+$/.test(field))
    && /^\d+%$/.test(diskFields[4]!)
    ? Number(diskFields[3]) : NaN;

  return {
    os: process.platform,
    shell: env.SHELL ?? null,
    packageManagers,
    tools,
    credentials,
    network,
    disk: Number.isFinite(availableKb) && availableKb >= 0 ? { availableKb } : null,
  };
}
