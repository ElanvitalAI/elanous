/** ⛔ 격리(test) 우주는 운영 Obsidian 볼트에 «쓰지» 않는다 — 읽기는 그대로(볼트는 단일 지식 창구 · 대표 2026-09-26).
 *
 *  🩸 2026-09-26(🅕 실측): 격리 config 물질화가 운영 `obsidian.vault` 를 그대로 가져오고, 격리 데몬의 PWA 저장이
 *    실제 볼트에 사본을 만들었다 → Obsidian Sync 가 모든 기기로 퍼뜨린다(되돌리기 어렵다).
 *  규칙: 우주가 `test` 이면, 쓰려는 경로가 «그 격리 우주 폴더 안» 또는 «OS 임시 폴더 안»(시험이 임시 볼트를 명시한 경우)일 때만 허용.
 *  ⊕ 설정 `obsidian.testVault`(시험 볼트 · 예 `elantest`)가 있으면 그 안도 허용한다 — 운영 볼트(`obsidian.vault`)는 여전히 막는다.
 *  모든 볼트 쓰기 창구(노트 저장 · 자동 조사 · 이미지 첨부 · 쓰기 문 `PUT /v1/vault/file`)가 쓰기 «직전»에 부른다. */
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { getUserConfig } from '../user-config.js';

export class VaultWriteBlockedError extends Error {
  readonly code = 'vault-write-blocked-test-universe';
  constructor(readonly target: string) {
    super(`격리(test) 우주에서는 운영 Obsidian 볼트에 쓰지 않는다 — ${target}. 쓰기를 시험하려면 임시 볼트를 먼저 정하라(설정 obsidian.testVault · 격리 폴더 · OS 임시 폴더 안).`);
    this.name = 'VaultWriteBlockedError';
  }
}

export interface VaultWriteGuardDeps {
  readonly instance?: () => { kind: string; root: string };
  readonly tmp?: () => string;
  readonly testVault?: () => string | undefined;
}

function configuredTestVault(): string | undefined {
  try { return getUserConfig().obsidian?.testVault?.trim() || undefined; } catch { return undefined; }
}

function within(child: string, parent: string): boolean {
  const c = resolve(child); const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** 쓰기 직전에 부른다 — 막히면 `VaultWriteBlockedError` 를 던진다. */
export function assertVaultWriteAllowed(absPath: string, deps: VaultWriteGuardDeps = {}): void {
  const inst = (deps.instance ?? (() => resolveCurrentInstance()))();
  if (inst.kind !== 'test') return;
  if (within(absPath, inst.root) || within(absPath, (deps.tmp ?? tmpdir)())) return;
  const testVault = (deps.testVault ?? configuredTestVault)();
  if (testVault && within(absPath, testVault)) return;
  debug.log('vault.write', 'blocked-test-universe', { target: absPath, universeRoot: inst.root });
  throw new VaultWriteBlockedError(absPath);
}
