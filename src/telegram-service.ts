// `elanous telegram service` — 넥서스 밖 텔레그램 폴러(`elanous telegram run`)의 서비스 정의를 «보여 주기만» 한다.
//
// ⛔ 쓰지도 싣지도 않는다: launchd 는 `RunAtLoad` 파일을 LaunchAgents 에 «두기만» 해도 다음 로그인에 켜진다.
//   켜기(파일 설치 ⊕ `telegram.poller=standalone`)는 RFC-nexus-restart-minimization §R2 «켜기 전 볼 것» 뒤에 사람이 한다.
// 넥서스 서비스와 같은 규칙: 최소 PATH 라 인터프리터 ⊕ 스크립트 절대경로 · 설치본이면 `current` 고정 경로.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { prodInstanceRoot } from './instance/resolve.js';
import { renderLaunchdPlist, stableInstalledScriptPath } from './nexus/install/launchd.js';
import { renderSystemdServiceUnit } from './nexus/install/systemd.js';

export const TELEGRAM_LAUNCHD_LABEL = 'com.elanous.telegram';
export const TELEGRAM_SYSTEMD_UNIT_NAME = 'elanous-telegram.service';

export interface TelegramServiceFile {
  platform: 'darwin' | 'linux';
  path: string;
  content: string;
  /** 켜는 명령(사람이 친다 · 이 명령은 안 친다). */
  enable: string[];
}

export function telegramRunCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
  exists?: (p: string) => boolean,
): string[] {
  if (execPath && script) return [execPath, stableInstalledScriptPath(script, exists), 'telegram', 'run'];
  return ['elanous', 'telegram', 'run'];
}

export function renderTelegramServiceFile(opts: {
  platform: NodeJS.Platform;
  home?: string;
  /** 서비스 로그 폴더 — 기본 = 운영 뿌리 `logs/`(서비스는 운영 전용). */
  logDir?: string;
  command: string[];
  uid?: number;
}): TelegramServiceFile | null {
  const home = opts.home ?? homedir();
  const logDir = opts.logDir ?? join(prodInstanceRoot(), 'logs');
  const common = {
    command: opts.command,
    workingDirectory: home,
    stdoutPath: join(logDir, 'telegram-run.out.log'),
    stderrPath: join(logDir, 'telegram-run.err.log'),
  };
  if (opts.platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${TELEGRAM_LAUNCHD_LABEL}.plist`);
    const uid = opts.uid ?? 0;
    return {
      platform: 'darwin',
      path,
      content: renderLaunchdPlist({ ...common, label: TELEGRAM_LAUNCHD_LABEL }),
      enable: [`launchctl bootstrap gui/${uid} ${path}`],
    };
  }
  if (opts.platform === 'linux') {
    const path = join(home, '.config', 'systemd', 'user', TELEGRAM_SYSTEMD_UNIT_NAME);
    return {
      platform: 'linux',
      path,
      content: renderSystemdServiceUnit({ ...common, description: 'elanous telegram poller — standalone Q&A bot outside the nexus' }),
      enable: ['systemctl --user daemon-reload', `systemctl --user enable --now ${TELEGRAM_SYSTEMD_UNIT_NAME}`],
    };
  }
  return null;
}

export interface TelegramServiceInstallDeps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  mkdir: (path: string) => void;
  rename: (from: string, to: string) => void;
  /** SEC2: a replaced plist may carry an emergency EnvironmentVariables token — its backup is kept owner-only. */
  chmod: (path: string, mode: number) => void;
  run: (command: string, args: string[]) => { status: number | null; stderr: string };
}

export interface TelegramServiceInstallResult {
  ok: boolean;
  path?: string;
  backup?: string;
  steps: string[];
  reason: string;
}

/**
 * 서비스 파일을 «쓰고 켠다»(대표 2026-09-25 텔레그램 분리 운영 전환).
 * ⛔ 운영 설정이 `telegram.poller=standalone` 이 «아니면» 거부 — 넥서스가 여전히 폴링하는데 러너를 띄우면 잠금 싸움만 한다.
 * 전환 순서(RFC §R2): ① config set telegram.poller standalone ② 이 명령(러너는 넥서스가 잠금을 놓을 때까지 15초마다 재시도)
 *   ③ 넥서스 재시작 → 넥서스가 폴링을 놓는 순간 러너가 이어받는다.
 */
export function installTelegramService(
  file: TelegramServiceFile,
  poller: string | undefined,
  uid: number,
  deps: TelegramServiceInstallDeps,
): TelegramServiceInstallResult {
  if (poller !== 'standalone') {
    return { ok: false, steps: [], reason: `telegram.poller=${poller ?? 'nexus(기본)'} — 먼저 \`elanous config set telegram.poller '"standalone"'\` (운영 config)` };
  }
  const steps: string[] = [];
  let backup: string | undefined;
  deps.mkdir(join(file.path, '..'));
  if (deps.exists(file.path)) {
    if (deps.readFile(file.path) !== file.content) {
      backup = `${file.path}.bak-${Date.now()}`;
      // Restrict before moving: if chmod fails nothing has moved and the live plist stays in place.
      deps.chmod(file.path, 0o600);
      deps.rename(file.path, backup);
      steps.push(`backup ${backup} (0600)`);
    } else {
      steps.push('service file unchanged');
    }
  }
  if (!deps.exists(file.path)) { deps.writeFile(file.path, file.content); steps.push(`wrote ${file.path}`); }
  const commands: Array<[string, string[], boolean]> = file.platform === 'darwin'
    ? [
        // 이미 실려 있으면 내리고(없으면 실패해도 무방) 다시 싣는다 — 새 파일 내용이 먹게.
        ['launchctl', ['bootout', `gui/${uid}/${TELEGRAM_LAUNCHD_LABEL}`], false],
        ['launchctl', ['bootstrap', `gui/${uid}`, file.path], true],
      ]
    : [
        ['systemctl', ['--user', 'daemon-reload'], true],
        ['systemctl', ['--user', 'enable', '--now', TELEGRAM_SYSTEMD_UNIT_NAME], true],
        ['systemctl', ['--user', 'restart', TELEGRAM_SYSTEMD_UNIT_NAME], true],
      ];
  for (const [command, args, required] of commands) {
    const r = deps.run(command, args);
    steps.push(`${command} ${args.join(' ')} → ${r.status}`);
    if (required && r.status !== 0) return { ok: false, path: file.path, backup, steps, reason: `${command} ${args.join(' ')} 실패: ${r.stderr.trim() || r.status}` };
  }
  return { ok: true, path: file.path, backup, steps, reason: '서비스를 켰다 — 넥서스가 폴링을 놓으면(재시작) 러너가 이어받는다' };
}
