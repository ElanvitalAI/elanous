// V1 — rerun the hand-measured TUI checks (scripts/lib/tui-regress-checks.ts) on a real PTY, every release.
//
//   bun scripts/tui-regress.ts [--only R2,R5] [--json]
//
// ⛔ Not under `bun test`: a real PTY of the real TUI is outside the test gate (NODE_ENV=test turns the PTY
// manifest off, and the run takes ~1 minute). Each check gets a fresh temp config/state dir and its own PTY;
// both are removed when the check ends, so the run leaves no process or folder behind.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPty } from '../src/pty-shell/registry.js';
import { ERASE, TUI_REGRESS_CHECKS, type TuiCheck, type Verdict } from './lib/tui-regress-checks.js';

const COLS = 160;
const ROWS = 50;
const BOOT_MS = 9_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runCheck(check: TuiCheck): Promise<Verdict> {
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
  try {
    await sleep(BOOT_MS);
    for (const step of check.steps) {
      if (step.kind === 'type') handle.write(step.text);
      else if (step.kind === 'key') handle.write(step.data);
      else if (step.kind === 'erase') handle.write(ERASE.repeat(step.count));
      else if (step.kind === 'wait') await sleep(step.ms);
      else snaps[step.as] = await handle.renderScreen();
    }
    // TUI_REGRESS_DUMP=<id> prints that check's screens (to see why a verdict failed).
    if (!json && process.env.TUI_REGRESS_DUMP === check.id) for (const [k, v] of Object.entries(snaps)) console.log(`--- ${check.id}:${k}\n${v.split('\n').filter((l) => l.trim()).join('\n')}`);
    return check.judge(snaps);
  } catch (error) {
    return { ok: false, reason: `실행 오류: ${String(error).slice(0, 120)}` };
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

const results: { id: string; title: string; ok: boolean; reason: string }[] = [];
for (const check of checks) {
  const verdict = await runCheck(check);
  results.push({ id: check.id, title: check.title, ...verdict });
  if (!json) console.log(`${check.id} ${verdict.ok ? '✅' : '❌'} ${check.title} — ${verdict.reason}`);
}
const fail = results.filter((r) => !r.ok).length;
if (json) console.log(JSON.stringify({ results, pass: results.length - fail, fail }));
else console.log(`tui-regress: pass ${results.length - fail} · fail ${fail}`);
process.exit(fail ? 1 : 0);
