// 스모크 — elanous 자체 구현 파이프라인의 goal-loop 엔진(driveHeadlessElanous)이
// gemma 를 격리 worktree 에서 실제 반복 구동하는지 실증. (임시 probe · 2026-07-20)
//
// 핸드오프 미검증 3항 검증:
//   ① driveHeadlessElanous(PTY) 로 자식 elanous 구동되나
//   ② goal-loop 실제 반복 발동하나 (logs.db goal-loop-hook / goal.loop)
//   ③ config-dir/ELANOUS_STATE_DIR 격리가 자식에 전파되나
//
// 사용: bun run scripts/smoke-headless-goalloop.ts

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { driveHeadlessElanous } from '../src/self-implement/headless-elanous-driver.js';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

async function main(): Promise<void> {
  const dir = join(repoRoot, '.elanous-test', 'bench', `smoke-${head}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // 베이스 config = .elanous-test/config.json (이미 local/gemma + goalLoop{maxIterations:10} · 아밍은 명시 goalLoop).
  const baseCfg = join(repoRoot, '.elanous-test', 'config.json');
  if (!existsSync(baseCfg)) { console.error('베이스 config 없음:', baseCfg); process.exit(2); }
  cpSync(baseCfg, join(dir, 'config.json'));

  // 격리 worktree.
  const wt = join(dir, 'worktree');
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'ignore' }); } catch { /* 없음 */ }
  execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });

  const goal = [
    'Create a file named `sum.ts` in the current directory that exports a function',
    '`sum(a: number, b: number): number` returning a + b.',
    'Also create `sum.test.ts` with a bun:test case asserting sum(2, 3) === 5.',
    'Run `bun test sum.test.ts` and confirm it passes before declaring the goal complete.',
  ].join(' ');

  console.error(`\n🔬 smoke · driveHeadlessElanous · gemma · dir=${dir}`);
  console.error(`   goal: ${goal.slice(0, 80)}…\n`);

  const t0 = Date.now();
  const r = await driveHeadlessElanous({
    repoRoot,
    cwd: wt,
    prompt: goal,
    configDir: dir,
    stateDir: dir,
    bootSec: 10,
    maxWaitSec: 420,
    cols: 200,
    rows: 55,
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`smoke 결과 (${secs}s)`);
  console.log(`  reachedCompletion: ${r.reachedCompletion}`);
  console.log(`  toolCalls(⏺): ${r.toolCalls}`);
  console.log(`  transcript chars: ${r.transcript.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // git diff — 실제 산출물.
  execFileSync('git', ['add', '-A', '-N'], { cwd: wt, stdio: 'ignore' });
  const diffStat = execFileSync('git', ['diff', '--stat'], { cwd: wt, encoding: 'utf8' }).trim();
  console.log('\n[git diff --stat]\n' + (diffStat || '(변경 없음)'));

  console.log('\n[transcript tail 1500]\n' + r.summary.slice(-1500));
  console.error(`\n📂 격리 dir 보존: ${dir}`);
  console.error(`   관측:  bun bin/elanous.mjs logs --category goal --config-dir ${dir}  (또는 goal-loop-hook / self-implement)`);
}

main().catch((e) => { console.error('smoke 실패:', e); process.exit(1); });
