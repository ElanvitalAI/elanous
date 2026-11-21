// `elanous update --auto on|off|status` — 설치본의 자동 갱신(09-26 요청 · 로드맵 09-26 #1).
//
// macOS  → ~/Library/LaunchAgents/com.elanous.update.plist  (StartCalendarInterval 매일 04:17)
// Linux  → ~/.config/systemd/user/elanous-update.{service,timer}  (OnCalendar 매일 04:17 · Persistent · 30분 무작위 지연)
// 둘 다 `self-update --restart --alert` 를 부른다 — 넥서스 서비스와 같은 방식으로 bun 실행 파일 ⊕ `current` 고정 경로를
// 박는다(`nexusRunCommand`) · 판이 바뀌어도 깨지지 않는다.
//
// ⛔ 이미 크론이 `self-update` 를 부르는 기계(운영 맥의 야간 갱신)에서는 켜지 않는다 — 이중 갱신은 서로의 판 정리를
//    밟는다. 그 크론 줄을 이름으로 대고 멈춘다(`status` 도 그 줄을 보여 준다).

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nexusRunCommand } from '../nexus/install/launchd.js';
import { runCli as defaultRunCli, type RunCli } from '../nexus/config/secrets/cli-helper.js';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export const UPDATE_LAUNCHD_LABEL = 'com.elanous.update';
export const UPDATE_SYSTEMD_UNIT = 'elanous-update';
export const UPDATE_HOUR = 4;
export const UPDATE_MINUTE = 17;

export const CATCH_UP_INTERVAL_SEC = 900;

export interface CatchUpMode { seat: string }

export type AutoAction = 'on' | 'off' | 'status';

export interface AutoUpdateDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  /** 서비스가 부를 명령 — 기본 = bun ⊕ 이 elanous 의 고정 경로 ⊕ `self-update --restart --alert`. */
  command?: string[];
  exists?: (path: string) => boolean;
  write?: (path: string, body: string) => void;
  remove?: (path: string) => void;
  runCli?: RunCli;
  /** `crontab -l` 본문(시험 seam) — 못 읽으면 null. */
  readCrontab?: () => string | null;
  log?: (line: string) => void;
}

export interface AutoUpdateResult {
  exitCode: number;
  /** 무엇이 갱신을 부르는가 — 에이전트/타이머 ⊕ 크론 줄. */
  schedulers: string[];
}

export function updateCommand(mode?: CatchUpMode): string[] {
  const run = nexusRunCommand();
  // nexusRunCommand = [bun, <elanous.mjs>, 'nexus', 'run'] — 앞 둘만 쓴다(폴백 ['elanous','nexus','run'] 도 같은 자리).
  const head = run.slice(0, run.length - 2);
  return mode ? [...head, 'self-update', '--catch-up', '--seat', mode.seat, '--restart', '--alert'] : [...head, 'self-update', '--restart', '--alert'];
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderUpdatePlist(command: string[], home: string, logPath: string, mode?: CatchUpMode): string {
  const schedule = mode
    ? `  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${CATCH_UP_INTERVAL_SEC}</integer>`
    : `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${UPDATE_HOUR}</integer>
    <key>Minute</key>
    <integer>${UPDATE_MINUTE}</integer>
  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${UPDATE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
${schedule}
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function unitQuote(arg: string): string {
  return /[\s"\\]/.test(arg) ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg;
}

export function renderUpdateUnits(command: string[], home: string, mode?: CatchUpMode): { service: string; timer: string } {
  const when = mode
    ? `OnBootSec=1min\nOnUnitActiveSec=${CATCH_UP_INTERVAL_SEC / 60}min`
    : `OnCalendar=*-*-* ${String(UPDATE_HOUR).padStart(2, '0')}:${String(UPDATE_MINUTE).padStart(2, '0')}:00\nRandomizedDelaySec=30m`;
  return {
    service: `[Unit]
Description=elanous self-update (auto)

[Service]
Type=oneshot
WorkingDirectory=${home}
ExecStart=${command.map(unitQuote).join(' ')}
`,
    timer: `[Unit]
Description=elanous self-update (daily)

[Timer]
${when}
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

/** 크론이 이미 self-update 를 부르나 — 주석이 아닌 줄만. */
export function cronSelfUpdateLines(crontab: string | null): string[] {
  if (!crontab) return [];
  return crontab.split('\n').filter((line) => !line.trimStart().startsWith('#') && /\bself-update\b/.test(line));
}

function defaultReadCrontab(): string | null {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

export async function runAutoUpdate(action: AutoAction, deps: AutoUpdateDeps = {}, mode?: CatchUpMode): Promise<AutoUpdateResult> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? ((p: string, b: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b, { mode: 0o644 }); });
  const remove = deps.remove ?? ((p: string) => { if (existsSync(p)) unlinkSync(p); });
  const run = deps.runCli ?? defaultRunCli;
  const log = deps.log ?? ((line: string) => console.log(line));
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const cronLines = cronSelfUpdateLines((deps.readCrontab ?? defaultReadCrontab)());

  const plist = join(home, 'Library', 'LaunchAgents', `${UPDATE_LAUNCHD_LABEL}.plist`);
  const unitDir = join(home, '.config', 'systemd', 'user');
  const service = join(unitDir, `${UPDATE_SYSTEMD_UNIT}.service`);
  const timer = join(unitDir, `${UPDATE_SYSTEMD_UNIT}.timer`);
  const own = platform === 'darwin' ? (exists(plist) ? [`launchd ${plist}`] : []) : platform === 'linux' ? (exists(timer) ? [`systemd ${timer}`] : []) : [];
  const schedulers = [...own, ...cronLines.map((l) => `cron ${l.trim()}`)];
  debug.log('self-update.auto', action, { platform, own: own.length, cron: cronLines.length });

  if (platform !== 'darwin' && platform !== 'linux') {
    log(`⛔ elanous update --auto: ${platform} 은 아직 지원하지 않는다(macOS launchd · Linux systemd 만).`);
    return { exitCode: 2, schedulers };
  }

  if (action === 'status') {
    if (schedulers.length === 0) log('자동 갱신: 꺼짐 — 켜려면 elanous update --auto on');
    else for (const s of schedulers) log(`자동 갱신: ${s}`);
    return { exitCode: 0, schedulers };
  }

  if (action === 'on') {
    if (cronLines.length > 0) {
      log(`⛔ 이미 크론이 self-update 를 부른다 — 이중 갱신은 서로의 판 정리를 밟는다. 켜지 않는다:\n${cronLines.map((l) => `  ${l.trim()}`).join('\n')}`);
      return { exitCode: 1, schedulers };
    }
    if (mode && !['OP', 'TC', 'MK', 'UX'].includes(mode.seat)) { log('⛔ --catch-up 은 --seat OP|TC|MK|UX 가 필요하다.'); return { exitCode: 2, schedulers }; }
    const command = deps.command ?? updateCommand(mode);
    const cadence = mode ? `부팅·깨어남 즉시 + ${CATCH_UP_INTERVAL_SEC / 60}분마다(desiredSha 따라잡기)` : `매일 ${UPDATE_HOUR}:${String(UPDATE_MINUTE).padStart(2, '0')}`;
    if (platform === 'darwin') {
      const logPath = join(elanousStateRoot(), 'logs', 'self-update-auto.log');   // 우주 해석기로(격리 게이트)
      write(plist, renderUpdatePlist(command, home, logPath, mode));
      await run(['launchctl', 'bootout', `gui/${uid}/${UPDATE_LAUNCHD_LABEL}`]);   // 이전 판이 올라가 있으면 내린다(없으면 실패해도 괜찮다)
      const boot = await run(['launchctl', 'bootstrap', `gui/${uid}`, plist]);
      if (boot.exitCode !== 0) { log(`⛔ launchctl bootstrap 실패: ${boot.stderr.trim()}`); return { exitCode: 1, schedulers }; }
      log(`✅ 자동 갱신 켬 — ${cadence} · ${plist} · 로그 ${logPath}`);
      return { exitCode: 0, schedulers: [`launchd ${plist}`] };
    }
    const units = renderUpdateUnits(command, home, mode);
    write(service, units.service);
    write(timer, units.timer);
    for (const cmd of [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${UPDATE_SYSTEMD_UNIT}.timer`]]) {
      const r = await run(cmd);
      if (r.exitCode !== 0) { log(`⛔ ${cmd.join(' ')} 실패: ${r.stderr.trim()}`); return { exitCode: 1, schedulers }; }
    }
    log(`✅ 자동 갱신 켬 — ${cadence}(놓치면 부팅 뒤) · ${timer} · 로그 journalctl --user -u ${UPDATE_SYSTEMD_UNIT}`);
    return { exitCode: 0, schedulers: [`systemd ${timer}`] };
  }

  // off
  if (platform === 'darwin') {
    await run(['launchctl', 'bootout', `gui/${uid}/${UPDATE_LAUNCHD_LABEL}`]);
    remove(plist);
  } else {
    await run(['systemctl', '--user', 'disable', '--now', `${UPDATE_SYSTEMD_UNIT}.timer`]);
    remove(timer);
    remove(service);
    await run(['systemctl', '--user', 'daemon-reload']);
  }
  log(`자동 갱신 끔${cronLines.length ? ` — ⚠️ 크론은 여전히 self-update 를 부른다(이 명령은 크론을 건드리지 않는다):\n${cronLines.map((l) => `  ${l.trim()}`).join('\n')}` : ''}`);
  return { exitCode: 0, schedulers: cronLines.map((l) => `cron ${l.trim()}`) };
}
