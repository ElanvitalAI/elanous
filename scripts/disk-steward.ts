#!/usr/bin/env bun
/**
 * 디스크 관리자 손 실행 입구(DISK-STEWARD-CORE). 정식 CLI·넥서스 틱 배선은 후속 칸(WIRE·HOST-AGENT) 몫이다.
 *
 *   bun scripts/disk-steward.ts run [--apply] [--json] [--repo <dir>]
 *   bun scripts/disk-steward.ts request <path> --kind <worktree|graph-context|pod-dir|tmp> [--owner o] [--reason r]
 *
 * ⭐ `run` 은 기본 dry-run 이다 — `--apply` 를 줘야 지운다.
 */
import { requestReclaim, RECLAIM_KINDS, type ReclaimKind } from '../src/disk-steward/ledger.js';
import { defaultListOpenPrs, runDiskSteward } from '../src/disk-steward/steward.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const [sub, target] = argv;
  if (sub === 'request') {
    const kind = flag('--kind') as ReclaimKind | undefined;
    if (!target || !kind || !(RECLAIM_KINDS as readonly string[]).includes(kind)) {
      console.error(`usage: request <abs-path> --kind <${RECLAIM_KINDS.join('|')}>`);
      return 2;
    }
    const r = requestReclaim({ path: target, kind, owner: flag('--owner'), reason: flag('--reason'), requester: 'cli:disk-steward' });
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  if (sub === 'run') {
    const repo = flag('--repo') ?? process.cwd();
    const r = await runDiskSteward({ apply: argv.includes('--apply') }, { listOpenPrs: () => defaultListOpenPrs(repo) });
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
    else {
      const { entries, ...summary } = r;
      console.log(JSON.stringify(summary));
      for (const e of entries) console.log(`${e.action}\t${e.kind}\t${e.path}\t${e.reason}`);
    }
    return r.outcome === 'pr-list-unavailable' || r.outcome === 'live-list-unavailable' || r.failed > 0 ? 1 : 0;
  }
  console.error('usage: disk-steward.ts run [--apply] [--json] [--repo <dir>] | request <path> --kind <kind>');
  return 2;
}

process.exitCode = await main();
