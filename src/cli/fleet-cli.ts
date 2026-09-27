import type { Command } from 'commander';
import * as ui from '../ui.js';
import { writeStdoutJson } from './stdout-json.js';

export function registerFleetCommands(program: Command): void {
  // ── fleet (멀티 인스턴스 통합 뷰 · §10 Control Plane/Fleet) ──
  const fleetCmd = program.command('fleet')
    .description('멀티 elanous 인스턴스 통합 뷰(READ-ONLY 연합) — 등록 인스턴스·보유 스토어 매트릭스. `logs instances` 일반화(kubectl get nodes 등가). 연합 조회는 `session list --all-instances` 등.');

  fleetCmd
    .command('list', { isDefault: true })
    .description('등록 인스턴스 나열 — name·alive·repo·state-dir·보유 스토어(logs/sessions/tasks/memory)')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const { buildFleetView } = await import('../domains/fleet.js');
      const view = buildFleetView();
      if (opts.json) { await writeStdoutJson(JSON.stringify(view, null, 2) + '\n'); return; }
      ui.header(`Fleet (${view.length} instances · ${view.filter((v) => v.alive).length} alive)`);
      for (const i of view) {
        const flag = i.alive ? '●' : '○';
        const s = i.stores;
        const stores = [s.logs ? 'logs' : '', s.sessions ? 'sessions' : '', s.tasks ? 'tasks' : '', s.memory ? 'memory' : '', s.opsEvents ? 'ops' : '', s.schedules ? 'sched' : '', s.mandate ? 'mandate' : '', s.frame ? 'frame' : ''].filter(Boolean).join(',');
        const kindTag = i.kind === 'test' ? ui.dim(' [test]') : '';
        console.log(`  ${flag} ${i.name.padEnd(24)}${kindTag} ${(i.liveness === 'remote' ? `remote@${i.hostname ?? 'unknown'}` : i.alive ? `pid=${i.pid}` : 'dead').padEnd(11)} [${stores}]`);
        console.log(ui.dim(`      ${i.stateDir}${i.repoPath ? `  ← ${i.repoPath}` : ''}`));
      }
      ui.info(ui.dim('연합 조회: session list · ops status · self recall `--all-instances` · fleet screen `--all`(격리 test 기본 제외·--include-test 로 포함)'));
    });

  fleetCmd
    .command('screen')
    .description('등록 elanous 인스턴스의 PTY 화면 프레임을 read-only로 조회한다')
    .option('--all', '등록 인스턴스 전체를 연합 조회한다(격리 test 기본 제외)')
    .option('--include-test', '--all 연합에 격리 test 인스턴스를 포함한다')
    .option('--json', '구조화된 프레임 행을 출력한다')
    .action(async (opts: { all?: boolean; includeTest?: boolean; json?: boolean }) => {
      const { existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { instanceStorePaths, ptyManifestTargets } = await import('../domains/fleet.js');
      const { listPtyManifestAt } = await import('../pty-shell/pty-manifest.js');
      const { stripScreenAnsi } = await import('../harness/harness-screen.js');
      const currentStateDir = process.env.ELANOUS_STATE_DIR?.trim() || join(homedir(), '.elanous');
      const targets: Array<{ name: string; dbPath: string }> = [];
      if (opts.all) {
        // ⭐⭐ 열거는 `ptyManifestTargets`(SSOT) 한 곳이다 — `pty list --all` 과 **같은 함수**를 쓴다.
        //    ⛔ 여기서 따로 조립하면 두 창구가 조용히 갈린다(2026-07-30 리뷰 must-fix).
        targets.push(...ptyManifestTargets({ includeTest: opts.includeTest === true }));
      } else {
        targets.push({ name: process.env.ELANOUS_INSTANCE_NAME?.trim() || 'prod', dbPath: instanceStorePaths(currentStateDir).frame });
      }
      const rows = targets.flatMap((target) => existsSync(target.dbPath)
        ? listPtyManifestAt(target.dbPath).map((row) => ({ ...row, instance: row.instance || target.name }))
        : [])
        .sort((a, b) => a.frameAt - b.frameAt || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      if (opts.json) { await writeStdoutJson(JSON.stringify(rows, null, 2) + '\n'); return; }
      if (rows.length === 0) { console.log('(화면 프레임 없음)'); return; }
      for (const row of rows) {
        console.log(`── ${row.instance} · ${row.id} · ${row.kind} · ${new Date(row.frameAt).toISOString()} ──`);
        console.log(stripScreenAnsi(row.frame));
      }
    });
}
