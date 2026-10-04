import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { CliUserError } from './cli-user-error.js';
import { awaitLandingMergesDrained, disableLandingFreeze, enableLandingFreeze, readLandingFreeze, landingFreezeMessage } from '../release-loop/landing-freeze.js';
import { pendingFrozenMerges, sweepFrozenMerges } from '../self-implement/frozen-merges.js';

export function registerFreezeCommands(program: Command): void {
  const freeze = program.command('freeze').description('착지 동결 상태 on/off/status');
  freeze.command('on').option('--reason <text>', '동결 이유').option('--until <timestamp>', '끝 시각(타임존 포함 ISO)')
    .option('--wait-seconds <n>', '이미 동결 검사를 지난 병합이 끝나기를 기다릴 최대 초', '600')
    .action(async (opts: { reason?: string; until?: string; waitSeconds: string }) => {
      const waitSeconds = Number(opts.waitSeconds);
      if (!/^\d+$/.test(opts.waitSeconds.trim()) || !Number.isSafeInteger(waitSeconds) || waitSeconds > 86_400) {
        throw new CliUserError(`잘못된 --wait-seconds: ${opts.waitSeconds}`, '0 이상 86400 이하의 정수 초');
      }
      const state = enableLandingFreeze(opts);
      debug.log('harness.merge', 'freeze-on', state);
      const drained = await awaitLandingMergesDrained(undefined, { timeoutMs: waitSeconds * 1000 });
      debug.log('harness.merge', 'freeze-drain', drained);
      console.log(landingFreezeMessage(state));
      if (!drained.drained) {
        console.error(`⚠ 동결 전에 시작한 병합 ${drained.pending}건이 아직 진행 중 — 끝나면 더 이상 병합이 시작되지 않는다`);
        process.exitCode = 2;
      }
    });
  freeze.command('off').description('동결을 풀고 보류된 병합을 바로 이어 한다').action(async () => {
    disableLandingFreeze();
    debug.log('harness.merge', 'freeze-off', {});
    console.log('동결 해제');
    await resume();
  });
  freeze.command('resume').description('동결이 풀렸으면 보류된 병합을 지금 이어 한다').action(async () => { await resume(); });
  freeze.command('status').option('--json', '상태 JSON').action((opts: { json?: boolean }) => {
    const state = readLandingFreeze();
    const pending = pendingFrozenMerges();
    if (opts.json) console.log(JSON.stringify({ frozen: state !== null, freeze: state, pendingMerges: pending }));
    else console.log(`${state ? landingFreezeMessage(state) : '동결 없음'} · 보류 병합 ${pending}건`);
  });
}

async function resume(): Promise<void> {
  const result = await sweepFrozenMerges();
  debug.log('harness.merge', 'freeze-resume', result);
  console.log(`보류 병합 이어 하기: 병합 ${result.merged}건 · 남음 ${result.pending}건`);
}
