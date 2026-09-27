// ── 인스턴스 스코프 로그 레벨 (LF7-c · 2026-07-13) ───────────────────────────
//
// 런타임 레벨 노브를 공유 config(debug.level)에서 state dir 스코프 파일로
// 이관한다. 멀티 엘라누스에서 테스트 A 가 diag 로 올린 게 prod/테스트 B 의
// 레벨을 흔들면 안 된다 — config 본체(토큰 등)는 공유 유지, 레벨만 로컬.
//
// 우선순위(데몬 부팅): ELANOUS_DEBUG_LEVEL env > 이 파일 > config debug.level.
// config 의 debug.level 은 "인스턴스 파일이 없을 때의 기본값"으로 강등 —
// `elanous logs level <lvl>` 은 더 이상 config.json 을 만지지 않는다
// (overlay persist 사건 2026-07-13 의 오염 벡터 원천 제거).
//
// 파일: `<stateRoot>/logs/level.json` — logs.db 와 같은 루트(격리 동형).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { dirname, join } from 'node:path';

import type { DebugLevel } from '../../debug/log.js';

const VALID_LEVELS: readonly DebugLevel[] = ['off', 'trail', 'diag', 'normal', 'verbose', 'detail', 'keytrace'];

export function scopedLevelPath(): string {
  return join(elanousStateRoot(), 'logs', 'level.json');
}

interface ScopedLevelFile {
  level?: unknown;
  /** OH9(2026-07-24) — 렌더 로그 발화 여부(축은 level 과 직교). true = 렌더 로그
   *  ON(비억제) · false = 억제(무음). 부재(undefined) = 부팅 시드로 폴백.
   *  `elanous logs level --render on|off` 가 이 한 필드를 관리한다. */
  render?: unknown;
  updatedAt?: unknown;
  pid?: unknown;
}

/** 기존 파일을 읽어 patch 만 병합 후 원자적 write(tmp→rename). config 무접촉.
 *  level 과 render 가 독립 setter 로 갱신돼도 서로를 덮지 않게 read-merge. */
function mergeScopedLevelFile(patch: Partial<Pick<ScopedLevelFile, 'level' | 'render'>>, path: string): void {
  let existing: ScopedLevelFile = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf-8')) as ScopedLevelFile; } catch { existing = {}; }
  }
  const next: ScopedLevelFile = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
}

/** 레벨 영속 — 인스턴스 로컬 파일에 원자적 write(tmp→rename). config 무접촉.
 *  render 필드가 있으면 보존(read-merge). */
export function persistScopedDebugLevel(level: DebugLevel, path: string = scopedLevelPath()): void {
  mergeScopedLevelFile({ level }, path);
}

/** 렌더 무음 스위치 영속 — level 과 같은 파일의 `render` 필드에 read-merge.
 *  `render` = 렌더 로그 발화 여부(true=ON/비억제 · false=억제). config 무접촉. */
export function persistScopedRenderLogs(render: boolean, path: string = scopedLevelPath()): void {
  mergeScopedLevelFile({ render }, path);
}

/** 부팅 시 읽기 — 없음/파손/무효값은 null (config 기본값으로 fallback). */
export function readScopedDebugLevel(path: string = scopedLevelPath()): DebugLevel | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ScopedLevelFile;
    return typeof parsed.level === 'string' && (VALID_LEVELS as readonly string[]).includes(parsed.level)
      ? parsed.level as DebugLevel
      : null;
  } catch {
    return null;
  }
}

/** 그 레벨에서 **핫패스 게이트**(`if (debug.enabled)` · 122 사이트)가 열리나.
 *
 *  ⚠️ 레벨은 **단조가 아니다** — `enabled = mirror || verbose || diag` 인데
 *  `detail` 은 `diag=false`(mirror 로 열림)이고 `trail` 은 파일만 켜고 전부 닫는다.
 *  그래서 "레벨을 올린다"로는 이 질문에 답할 수 없고 술어가 따로 필요하다. */
export function hotPathGateOpen(level: DebugLevel): boolean {
  return level !== 'off' && level !== 'trail';
}

/** 부팅 시작 레벨 해석 — env > 인스턴스 스코프 파일 > config, **그리고 테스트 우주 바닥**.
 *
 *  ⭐ 테스트 바닥(2026-07-27): 격리 인스턴스는 **자기 config 를 본다** — 운영에서 diag/detail 을
 *     켜둬도 `.elanous-test` 우주는 그걸 모른다. 그래서 자식 PTY·L2 TUI 를 격리로 띄우면
 *     관측 해상도가 조용히 떨어져 있었다(실측: 운영 게이트는 열려 있는데 테스트는 아님).
 *     테스트 우주에서 게이트가 닫히는 레벨로 시작하면 **`diag` 로 올린다** —
 *     파일 ON + 핫패스 ON, mirror 는 OFF 라 화면은 조용하다(진단용 정확한 조합).
 *  ⚠️ **명시를 덮지 않는다** — env 와 **스코프 파일**(`elanous logs level <lvl>` 의 영속처)은
 *     사람의 명시이므로 바닥이 손대지 않는다. 바닥이 걸리는 유일한 자리는 **config 상속값**이다.
 *     내리는 일은 절대 없다(관측을 줄이는 방향으로는 이 함수가 움직이지 않는다).
 *  ⚠️ 운영(prod)에는 무접촉 — `isTestInstance` 판정은 호출측이 **리졸버 SSOT**
 *     (`resolveInstance().kind === 'test'`)로 넘긴다. "루트가 `~/.elanous` 가 아니면 테스트"
 *     같은 자체 비교를 쓰면 별도 운영 인스턴스·커스텀 루트까지 test 로 오판한다(리뷰 must-fix). */
export function resolveStartupDebugLevel(input: {
  envLevel?: string | undefined;
  scopedLevel?: DebugLevel | null;
  configLevel: DebugLevel;
  isTestInstance: boolean;
}): { level: DebugLevel; source: 'env' | 'scoped' | 'config' | 'test-floor' } {
  const env = input.envLevel?.trim().toLowerCase();
  if (env && (VALID_LEVELS as readonly string[]).includes(env)) {
    return { level: env as DebugLevel, source: 'env' };
  }
  // ⭐ 스코프 파일은 **사람의 명시**다 — `elanous logs level off` 가 여기에 영속한다.
  //   바닥이 그걸 덮으면 "꺼둔 게 재기동마다 되살아나는" 것이라 명시를 무시하는 셈이다
  //   (리뷰 must-fix — 내가 계약으로 적어놓고 코드는 env 만 예외로 뒀다).
  if (input.scopedLevel) return { level: input.scopedLevel, source: 'scoped' };
  // 남은 것은 config 뿐 — 격리 우주의 config 는 운영에서 sync 된 **상속 기본값**이고,
  // 바로 이게 "운영에서 diag 를 켜도 테스트 우주는 모른다" 는 갭의 자리다. 여기만 바닥을 깐다.
  if (input.isTestInstance && !hotPathGateOpen(input.configLevel)) {
    return { level: 'diag', source: 'test-floor' };
  }
  return { level: input.configLevel, source: 'config' };
}

/** 렌더 발화 여부 읽기 — 명시(boolean)면 그 값, 부재/파손이면 null(시드로 폴백).
 *  true = 렌더 로그 ON(비억제) · false = 억제. 우선순위 최상위(사용자 명시). */
export function readScopedRenderLogs(path: string = scopedLevelPath()): boolean | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ScopedLevelFile;
    return typeof parsed.render === 'boolean' ? parsed.render : null;
  } catch {
    return null;
  }
}

/** Render suppression: explicit scoped setting wins, then config override; dashboard opts into essential suppression. */
export function resolveRenderSuppressed(input: {
  scopedRender: boolean | null;
  configRenderLogs?: boolean | undefined;
  defaultSuppressed?: boolean | undefined;
}): boolean {
  if (input.scopedRender !== null) return !input.scopedRender;
  if (input.configRenderLogs === true) return false;
  return input.defaultSuppressed ?? false;
}
