// ── CFG-STORE2-HISTORY-REVERT · config 감사 이력 장치 (ux-sim L2) ──
//
// 실 CLI(`src/index.ts` 의 `config` 명령 트리)를 «같은 격리 config 저장소» 위에서 여러 번 부른다.
// in-process-cli.ts 의 턴 하나는 자기 temp 뿌리를 만들고 지운다 — set → history → revert 한 바퀴는
// 같은 저장소·같은 감사 원장이 이어져야 하므로 이 장치는 stateRoot 를 소유하고 재사용한다
// (InProcessCliOptions.stateRoot · 정리는 dispose 가 한다).
//
// ⛔ 경계
//   • 저장소는 이 장치의 temp 뿌리뿐이다 — 실제 ~/.elanous 를 건드리지 않는다(in-process-cli 격리 그대로).
//   • 여기서 값을 «만들지» 않는다 — 값·감사 행은 실 CLI 의 set/unset/history/revert 가 만든 것만 관측한다.
//   • 비밀 원문은 이 장치의 어떤 접근자도 새로 노출하지 않는다: 원장·stdout 을 그대로 돌려줄 뿐이다.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigHistory, type ConfigChangeRow } from '../cli/config-audit.js';
import { simInProcessCli } from './in-process-cli.js';

/** 장치가 실 CLI 에 넘긴 인자와 그 턴의 결과. */
export interface ConfigAuditTurn {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 실 CLI `config` 명령 트리를 격리 HOME 위에서 돌리는 장치. */
export interface CliConfigAuditDevice {
  /** 격리된 config 뿌리(= config.json 과 config-changes.db 가 사는 자리). */
  readonly stateRoot: string;
  /** 사용자 config 파일 자리. */
  readonly configPath: string;
  /** 감사 원장(config_changes) 파일 자리. */
  readonly ledgerPath: string;
  /** 임의 인자 한 턴 — 허용 목록 밖 명령은 장치가 거부한다. */
  run(...args: string[]): Promise<ConfigAuditTurn>;
  set(path: string, value: unknown): Promise<ConfigAuditTurn>;
  unset(path: string): Promise<ConfigAuditTurn>;
  history(path: string): Promise<ConfigAuditTurn>;
  revert(path: string): Promise<ConfigAuditTurn>;
  /** 그 키의 감사 행(시간 오름차순) — 실 CLI 가 남긴 원장 그대로. */
  ledger(path: string): ConfigChangeRow[];
  /** 저장된 config 에서 그 자리의 값(없으면 undefined). */
  value(path: string): unknown;
  /** 원장 파일 원문(비밀 원문 부재 검사용). */
  ledgerText(): string;
  /** 격리 뿌리 제거. 두 번 불러도 안전. */
  dispose(): void;
}

const ALLOWED_PATHS: readonly (readonly string[])[] = [
  ['config', 'set'],
  ['config', 'unset'],
  ['config', 'get'],
  ['config', 'history'],
  ['config', 'revert'],
];

/** 점 표기 경로로 값 하나를 꺼낸다. */
function pick(root: unknown, path: string): unknown {
  let node = root;
  for (const segment of path.split('.').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** CLI 인자 형태 — 문자열은 그대로(사용자 config 문법), 그 밖은 JSON. */
function argValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 격리 config 저장소 + 감사 원장을 함께 들고 있는 장치를 만든다. */
export function createCliConfigAuditDevice(): CliConfigAuditDevice {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ux-sim-config-audit-'));
  const configPath = join(stateRoot, 'config.json');
  const ledgerPath = join(stateRoot, 'config-changes.db');

  const run = async (...args: string[]): Promise<ConfigAuditTurn> => {
    try {
      const result = await simInProcessCli(args, { allowPaths: ALLOWED_PATHS, stateRoot });
      return { args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      // 거부된 명령(허용 목록 밖·미등록 하위 명령)도 «한 턴» 이다 — 던지지 않고 실패 턴으로 돌려준다.
      return { args, exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  };

  const readConfig = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  return {
    stateRoot,
    configPath,
    ledgerPath,
    run,
    set: (path, value) => run('config', 'set', path, argValue(value)),
    unset: (path) => run('config', 'unset', path),
    history: (path) => run('config', 'history', path),
    revert: (path) => run('config', 'revert', path),
    ledger: (path) => readConfigHistory(path, ledgerPath),
    value: (path) => pick(readConfig(), path),
    ledgerText: () => {
      try {
        return readFileSync(ledgerPath, 'utf8');
      } catch {
        return '';
      }
    },
    dispose: () => rmSync(stateRoot, { recursive: true, force: true }),
  };
}
