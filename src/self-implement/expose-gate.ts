import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';

type ExposeMode = 'warn' | 'strict';
type ProcessResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };
type ExposeResult = { passed: boolean; log: string };

/** The rubric only accepts root-level public Markdown documents. */
export function publicExposureFiles(changed: readonly string[]): string[] {
  return [...new Set(changed.filter((file) => /^release\/public\/docs\/[^/]+\.md$/.test(file)))];
}

export function runExposeGate(
  cwd: string,
  changed: readonly string[],
  mode: ExposeMode,
  run: (command: string, args: string[], cwd: string) => ProcessResult = (command, args, dir) => {
    const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', timeout: 300_000 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  },
): ExposeResult {
  const files = publicExposureFiles(changed);
  if (files.length === 0) return { passed: true, log: '' };
  let unreviewed: number | null = null;
  let failed: number | null = null;
  let docs: number | null = null;
  let error = '';
  try {
    const result = run('bun', ['scripts/expose-rubric-check.ts', '--json', '--files', ...files], cwd);
    if (result.status !== 0 || result.error) throw new Error(result.stderr?.trim() || result.error?.message || `exit ${result.status}`);
    const parsed = JSON.parse(result.stdout ?? '') as Record<string, unknown>;
    const lists = ['missing', 'orphan', 'failing', 'internal', 'unreviewed', 'unjudged'] as const;
    if (!Number.isSafeInteger(parsed.docs) || (parsed.docs as number) < 0 || !lists.every((key) => Array.isArray(parsed[key]))) {
      throw new Error('invalid exposure rubric JSON');
    }
    docs = parsed.docs as number;
    unreviewed = new Set([...(parsed.missing as string[]), ...(parsed.unjudged as string[])]).size;
    failed = new Set([...(parsed.orphan as string[]), ...(parsed.failing as Array<{ path: string }>).map((item) => item.path), ...(parsed.internal as string[])]).size;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  try { debug.log('self-implement.gate', 'expose', { files, unreviewed, failed, mode }); } catch { /* observation must not change judgment */ }
  const log = docs === null
    ? `[expose] 못 쟀다 — ${error}`
    : `[expose] ${files.length}개 · 미판정 ${unreviewed} · fail ${failed}`;
  return { passed: mode === 'warn' || (docs !== null && unreviewed === 0 && failed === 0), log };
}
