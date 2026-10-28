// V1 — rerun the hand-measured TUI checks (scripts/lib/tui-regress-checks.ts) on a real PTY, every release.
//
//   bun scripts/tui-regress.ts [--only R2,R5] [--json]
//
// ⛔ Not under `bun test`: a real PTY of the real TUI is outside the test gate (NODE_ENV=test turns the PTY
// manifest off, and the run takes ~1 minute). Each check gets a fresh temp config/state dir and its own PTY;
// the temporary config/state directory is removed when the check ends. Failed checks preserve their screens and
// effective config under TUI_REGRESS_ARTIFACTS (or the default temp artifact root) for diagnosis.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPty } from '../src/pty-shell/registry.js';
import { ERASE, inputRow, TUI_REGRESS_CHECKS, type TuiCheck, type Verdict } from './lib/tui-regress-checks.js';
import { preserveTuiRegressFailure } from './lib/tui-regress-evidence.js';
import { debug } from '../src/debug/log.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';

const COLS = 160;
const ROWS = 50;
const BOOT_TIMEOUT_MS = 60_000;
const BOOT_POLL_MS = 200;
const RUN_EVENT = 'tui-regress.completed';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type TuiRegressResult = Verdict & { bootMs: number };

async function waitForInputPrompt(handle: ReturnType<typeof startPty>): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    if (inputRow(await handle.renderScreen())) return Date.now() - startedAt;
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`TUI 입력 프롬프트 준비 시간 초과 (${BOOT_TIMEOUT_MS}ms)`);
}

async function runCheck(check: TuiCheck, runId: string, verificationCommand: string): Promise<TuiRegressResult> {
  const dir = mkdtempSync(join(tmpdir(), `tui-regress-${check.id}-`));
  const cli = join(import.meta.dir, '..', 'bin', 'elanous.mjs');
  if (check.role && check.role !== 'owner') {
    // A config written from scratch has onboarding unfinished → bare entry would take the first-run (web-first) path,
    // not the TUI. Mark onboarding done so the check sees the same TUI as an existing user.
    spawnSync(process.execPath, [cli, '--config-dir', dir, 'config', 'set', 'tui.role', check.role], { stdio: 'ignore' });
    spawnSync(process.execPath, [cli, '--config-dir', dir, 'config', 'set', 'onboarding.completed', 'true'], { stdio: 'ignore' });
  }
  const handle = startPty({
    cmd: process.execPath, args: [cli, '--config-dir', dir, '--test-state-dir', dir],
    cols: COLS, rows: ROWS, workdir: join(import.meta.dir, '..'),
    env: { ...process.env, ELANOUS_DRIVE_TUI: '1', ELANOUS_STATE_DIR: dir },
  });
  const snaps: Record<string, string> = {};
  let bootMs = 0;
  let bootStartedAt = Date.now();
  let bootComplete = false;
  try {
    bootStartedAt = Date.now();
    bootMs = await waitForInputPrompt(handle);
    bootComplete = true;
    for (const step of check.steps) {
      if (step.kind === 'type') handle.write(step.text);
      else if (step.kind === 'key') handle.write(step.data);
      else if (step.kind === 'erase') handle.write(ERASE.repeat(step.count));
      else if (step.kind === 'wait') await sleep(step.ms);
      else snaps[step.as] = await handle.renderScreen();
    }
    // TUI_REGRESS_DUMP=<id> prints that check's screens (to see why a verdict failed).
    if (!json && process.env.TUI_REGRESS_DUMP === check.id) for (const [k, v] of Object.entries(snaps)) console.log(`--- ${check.id}:${k}\n${v.split('\n').filter((l) => l.trim()).join('\n')}`);
    const verdict = check.judge(snaps);
    if (!verdict.ok) {
      const artifactDir = preserveTuiRegressFailure({
        runId,
        event: RUN_EVENT,
        verificationCommand,
        artifactRoot: process.env.TUI_REGRESS_ARTIFACTS || join(tmpdir(), 'elanous-tui-regress-failures'),
        configDir: dir,
        check: { id: check.id, title: check.title, role: check.role ?? 'owner' },
        screens: snaps,
        pty: { cols: COLS, rows: ROWS, bootMs },
        environment: {
          driveTui: '1',
          nodeEnv: process.env.NODE_ENV ?? null,
          credentialVariablesPresent: Object.keys(process.env).filter((key) => /API.?KEY|TOKEN|SECRET|CREDENTIAL/i.test(key)),
        },
        verdict,
      });
      return { ...verdict, bootMs, reason: `${verdict.reason} · 증거 보존: ${artifactDir}` };
    }
    return { ...verdict, bootMs };
  } catch (error) {
    if (!bootComplete) bootMs = Date.now() - bootStartedAt;
    const verdict: Verdict = { ok: false, reason: `실행 오류: ${String(error).slice(0, 120)}` };
    try { snaps.failure = await handle.renderScreen(); } catch { /* PTY may already be gone */ }
    try {
      const artifactDir = preserveTuiRegressFailure({
        runId,
        event: RUN_EVENT,
        verificationCommand,
        artifactRoot: process.env.TUI_REGRESS_ARTIFACTS || join(tmpdir(), 'elanous-tui-regress-failures'),
        configDir: dir,
        check: { id: check.id, title: check.title, role: check.role ?? 'owner' },
        screens: snaps,
        pty: { cols: COLS, rows: ROWS, bootMs },
        environment: {
          driveTui: '1',
          nodeEnv: process.env.NODE_ENV ?? null,
          credentialVariablesPresent: Object.keys(process.env).filter((key) => /API.?KEY|TOKEN|SECRET|CREDENTIAL/i.test(key)),
        },
        verdict,
      });
      return { ...verdict, bootMs, reason: `${verdict.reason} · 증거 보존: ${artifactDir}` };
    } catch (preserveError) {
      return { ...verdict, bootMs, reason: `${verdict.reason} · 증거 보존 실패: ${String(preserveError).slice(0, 120)}` };
    }
  } finally {
    try { handle.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const json = args.includes('--json');
const checks = TUI_REGRESS_CHECKS.filter((check) => !only || only.has(check.id));
if (checks.length === 0) { console.error('tui-regress: 고른 칸이 없다 (--only 확인)'); process.exit(2); }
const runId = `run-${randomUUID()}`;
const verificationCommand = `bun scripts/tui-regress.ts${only ? ` --only ${[...only].join(',')}` : ''} --json`;
await registerStandaloneLogSink('tui-regress');

const results: { id: string; title: string; ok: boolean; reason: string; bootMs: number }[] = [];
for (const check of checks) {
  const verdict = await runCheck(check, runId, verificationCommand);
  results.push({ id: check.id, title: check.title, ...verdict });
  if (!json) console.log(`${check.id} ${verdict.ok ? '✅' : '❌'} ${check.title} — ${verdict.reason}`);
}
const fail = results.filter((r) => !r.ok).length;
debug.log('tui-regress', RUN_EVENT, {
  runId,
  verificationCommand,
  outcome: fail === 0 ? 'pass' : 'fail',
  results: results.map(({ id, ok, bootMs }) => ({ id, ok, bootMs })),
});
debug.flush();
if (json) console.log(JSON.stringify({ runId, event: RUN_EVENT, verificationCommand, results, pass: results.length - fail, fail }));
else console.log(`tui-regress: pass ${results.length - fail} · fail ${fail}`);
process.exit(fail ? 1 : 0);
