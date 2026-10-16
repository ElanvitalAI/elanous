// ── config/dotfile syntax gate (#25 P3 · 2026-07-21) ─────────────────────────────────
//
// 단일 파일 타겟(config/dotfile ~/.zshrc·~/.elanous/config.json)은 manifest 테스트가 없다 → 대신
// **syntax check** 로 게이트한다(DESIGN §3): 잘못된 문법을 실위치에 적용하면 셸/앱이 깨진다 →
// 적용 전 반드시 파싱/검사. 확장자·basename 으로 검사기 선택. 미지 형식은 skip-with-warn(HITL diff 로 검증).
//
// ⚠️ 안전(§4·크리티컬): 이 게이트가 통과해야 apply-in-place 가 진행된다(fail 이면 적용 차단).
//   셸 검사는 `zsh -n`/`bash -n`(구문만·미실행). JSON/TOML 은 인-프로세스 파싱(외부 프로세스 불필요).

import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface ConfigGateResult {
  passed: boolean;
  /** 실제 검사를 돌렸나(false=미지 형식 skip). */
  checked: boolean;
  /** 검사기 라벨(관측·진단). */
  label: string;
  log: string;
}

const SHELL_TIMEOUT_MS = 15_000;

/** config/dotfile 파일의 문법을 검사. 확장자/basename 으로 검사기 선택. 미지 형식=skip(passed·checked=false).
 *  파일을 읽지 못하면 fail(적용 차단·보수적). */
export function runConfigSyntaxGate(filePath: string): ConfigGateResult {
  const name = basename(filePath).toLowerCase();

  // ① 셸 rc — zsh/bash 계열은 `-n`(no-exec·구문검사)로. fish 등은 미지원(skip).
  const isZsh = /(^|\.)(zshrc|zshenv|zprofile|zlogin|zlogout)$/.test(name) || name.endsWith('.zsh');
  const isBash = /(^|\.)(bashrc|bash_profile|bash_login|profile|bash_aliases)$/.test(name) || name.endsWith('.bash') || name.endsWith('.sh');
  if (isZsh || isBash) {
    const shell = isZsh ? 'zsh' : 'bash';
    const r = spawnSync(shell, ['-n', filePath], { encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
    // 셸 미설치(status=null·ENOENT) → 검사 불가로 skip(차단 아님·HITL diff 로 검증).
    if (r.error || r.status === null) return { passed: true, checked: false, label: `${shell} -n (미설치)`, log: String(r.error?.message ?? 'shell 없음') };
    return { passed: r.status === 0, checked: true, label: `${shell} -n`, log: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000) };
  }

  // ② JSON — 인-프로세스 파싱.
  if (name.endsWith('.json') || name.endsWith('.jsonc')) {
    try {
      JSON.parse(stripJsonc(readFileSync(filePath, 'utf8')));
      return { passed: true, checked: true, label: 'JSON.parse', log: 'ok' };
    } catch (e) {
      return { passed: false, checked: true, label: 'JSON.parse', log: String((e as { message?: string })?.message ?? e).slice(0, 500) };
    }
  }

  // ③ TOML — 인-프로세스 경량 파싱(Bun.TOML 있으면 사용·없으면 skip).
  if (name.endsWith('.toml')) {
    const toml = (globalThis as { Bun?: { TOML?: { parse(s: string): unknown } } }).Bun?.TOML;
    if (!toml) return { passed: true, checked: false, label: 'TOML (파서 없음)', log: 'Bun.TOML 미가용 → skip' };
    try {
      toml.parse(readFileSync(filePath, 'utf8'));
      return { passed: true, checked: true, label: 'Bun.TOML.parse', log: 'ok' };
    } catch (e) {
      return { passed: false, checked: true, label: 'Bun.TOML.parse', log: String((e as { message?: string })?.message ?? e).slice(0, 500) };
    }
  }

  // ④ 미지 형식(.md·.txt·확장자 없음 등) — skip(HITL diff 로 검증). 차단하지 않음.
  return { passed: true, checked: false, label: 'skip(미지 형식)', log: `${name} — syntax 검사기 없음 → HITL diff 로 검증` };
}

/** JSONC 최소 스트립(줄 `//`·블록 `/* *​/` 주석 제거) — .jsonc/일부 config 관용. 문자열 내 `//` 보존 시도. */
function stripJsonc(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 블록 주석
    .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');    // 줄 주석(스킴 `://` 은 앞 문자로 회피)
}
