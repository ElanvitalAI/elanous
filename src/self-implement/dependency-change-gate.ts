import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { pwaReachableSrcFiles } from './pwa-import-graph.js';

export type DependencyChangeGateResult = {
  ran: boolean;
  passed: boolean;
  failures: Array<{ step: 'root-tsc' | 'pwa-build'; lines: string[] }>;
  skipped?: string;
  trigger?: 'dependency' | 'pwa-reachable';
  pwaReachableChanged?: string[];
  measured?: boolean;
};

type CommandResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

type Run = (command: string, args: readonly string[], options: { cwd: string; timeout: number }) => CommandResult;

const TIMEOUT_MS = 300_000;
const defaultRun: Run = (command, args, options) => spawnSync(command, [...args], {
  ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});

/** A dependency change can invalidate consumers outside the changed-file typecheck scope. */
export function runDependencyChangeGate({ cwd, changedFiles, run = defaultRun }: {
  cwd: string;
  changedFiles: readonly string[];
  run?: Run;
}): DependencyChangeGateResult {
  const normalized = changedFiles.map((file) => file.replace(/^\.\//, ''));
  const dependency = normalized.some((file) => ['package.json', 'bun.lock', 'apps/pwa/package.json'].includes(file));
  const reachable = normalized.some((file) => file.startsWith('src/'))
    ? pwaReachableSrcFiles(cwd) : new Set<string>();
  const changed = normalized.filter((file) => reachable.has(file));
  if (!dependency && changed.length === 0) return { ran: false, passed: true, failures: [] };
  const trigger = dependency ? 'dependency' as const : 'pwa-reachable' as const;
  const pwaReachableChanged = changed.slice(0, 10);
  const details = { trigger, pwaReachableChanged };
  const hasRootConfig = existsSync(join(cwd, 'tsconfig.json'));
  if (dependency && !hasRootConfig && changed.length === 0) {
    return { ran: false, passed: true, failures: [], skipped: 'no-tsconfig', ...details };
  }
  const pwaPresent = existsSync(join(cwd, 'apps/pwa'));
  // The build needs `next` resolvable from apps/pwa — its own node_modules or a workspace-hoisted root one.
  // An empty apps/pwa/node_modules is not «installed», and hoisted deps are not «missing».
  const missingDeps = !['apps/pwa/node_modules/next/package.json', 'node_modules/next/package.json']
    .some((path) => existsSync(join(cwd, path)));
  if (missingDeps && (pwaPresent || !dependency)) {
    debug.log('self-implement', 'gate.pwa-reachable', { trigger, changed: pwaReachableChanged, skipped: 'pwa-deps-missing' });
  }
  if (!dependency && missingDeps) {
    return { ran: false, passed: true, measured: false, failures: [], skipped: 'pwa-deps-missing', ...details };
  }

  const failures: DependencyChangeGateResult['failures'] = [];
  let ran = false;
  for (const [step, command, args] of [
    ...(dependency && hasRootConfig ? [['root-tsc', 'bunx', ['tsc', '--noEmit', '-p', 'tsconfig.json']]] : []),
    ...(pwaPresent && !missingDeps ? [['pwa-build', 'bun', ['bin/elanous.mjs', '--test', 'nexus', 'build']]] : []),
  ] as Array<['root-tsc' | 'pwa-build', string, string[]]>) {
    let result: CommandResult;
    ran = true;
    try {
      result = run(command, args, { cwd, timeout: TIMEOUT_MS });
    } catch (error) {
      result = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (result.status === 0 && !result.error && !result.signal) continue;
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const diagnosticLines = output.split(/\r?\n/).filter((line) => step === 'root-tsc' ? line.includes('error TS') : Boolean(line.trim()));
    const unmeasured = result.error || result.signal || result.status === null || diagnosticLines.length === 0;
    const lines = diagnosticLines.slice(0, unmeasured ? 19 : 20);
    if (unmeasured) {
      lines.push(`[${step}] ${result.error?.message?.replace(/\s+/g, ' ') ?? (result.signal ? `signal=${result.signal}` : `exit=${result.status}`)} — 검사 실패 또는 측정 불가 (timeout=${TIMEOUT_MS}ms)`);
    }
    failures.push({ step, lines });
  }
  if (!dependency) debug.log('self-implement', 'gate.pwa-reachable', { trigger, changed: pwaReachableChanged, skipped: undefined });
  return { ran, passed: failures.length === 0, failures, ...details,
    ...(pwaPresent && missingDeps ? { skipped: 'pwa-deps-missing', measured: false } : !dependency ? { measured: true } : {}),
  };
}
