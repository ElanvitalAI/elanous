// ── Self-Evolution SE3 · 격리 데몬 인스턴스 (2026-07-09) ───────────────────
//
// 대표: "global elanous link 외에 worktree로 디렉토리를 만들고 신규 피처를 만들어라. 포트도
// 정식과 별도로, 테스트용 config·디렉토리도 지정. 테스트 버전으로 무결하게 완성하는 법도
// 확립하라." → 격리 인스턴스 = worktree(별 브랜치) + 별 config-dir + 별 포트. 정식 서비스
// (:31415·main·pilot link·~/.elanous) 절대 무오염.
//
// 안전 assertion(치명): 포트 != 정식(31415) · config-dir 이 worktree 하위(홈 ~/.elanous 아님)
// · 테스트 config 는 매매/발송 disarmed. worktree 생성/제거는 기존 git-fs/worktree 재사용.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWorktree, linkWorktreeDependencies, removeWorktree, worktreeParentDir, worktreeDirName } from '../../git-fs/worktree.js';
import { configuredWorktreeRoot, getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { runGitCommand } from '../../git-fs/runner.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../../nexus/default-port.js';

/** 정식 데몬 포트 — 격리는 이 포트를 절대 쓰지 않는다. */
export const PRODUCTION_PORT = DEFAULT_NEXUS_HTTP_PORT;
/** 격리 포트 범위(정식 회피). */
export const ISOLATED_PORT_BASE = 31416;
export const ISOLATED_PORT_SPAN = 84; // 31416~31499

/** slug → 결정론 포트(정식 회피·범위 내). */
export function isolatedPort(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  const port = ISOLATED_PORT_BASE + (h % ISOLATED_PORT_SPAN);
  return port === PRODUCTION_PORT ? port + 1 : port;
}

export interface IsolatedPlan {
  slug: string;
  branch: string;          // se/<slug>
  worktreePath: string;    // <repo>.worktrees/se-<slug>
  configDir: string;       // <worktree>/.elanous-se  (홈 ~/.elanous 아님)
  testStateDir: string;    // <worktree>/.elanous-se/nexus
  port: number;
}

/** 격리 인스턴스 경로·포트 계획.
 *  ⛔⭐ `worktreeRoot` 를 «인자로» 받는다 — 안 주면 그때 `getUserConfig()` 를 읽는다.
 *  ⚠️ 그래서 이 함수는 「순수」가 아니다: 인자를 생략한 호출은 전역 config 을 읽는다.
 *  🩹 그 사실을 숨기지 않고 계약에 적는다(리뷰 should-fix ① — 문서가 「순수·fs 접근 없음」이라
 *     말하는 동안 구현이 전역을 읽고 있었다). ⇒ ***테스트는 인자를 주어 전역과 홈 디렉터리를 안 건드린다.*** */
export function planIsolatedInstance(repoRoot: string, slug: string, worktreeRoot?: string): IsolatedPlan {
  const branch = `se/${slug}`;
  const root = worktreeRoot ?? configuredWorktreeRoot();
  const worktreePath = join(worktreeParentDir(repoRoot, root), worktreeDirName(branch));
  const configDir = join(worktreePath, '.elanous-se');
  return {
    slug, branch, worktreePath, configDir,
    testStateDir: join(configDir, 'nexus'),
    port: isolatedPort(slug),
  };
}

/** 안전 검증(치명·무오염 보증). 위반 시 throw. */
export function assertIsolationSafe(plan: IsolatedPlan): void {
  if (plan.port === PRODUCTION_PORT) throw new Error(`격리 위반: 정식 포트(${PRODUCTION_PORT}) 사용 금지`);
  if (!plan.configDir.startsWith(`${plan.worktreePath}/`)) throw new Error('격리 위반: config-dir 이 worktree 하위 아님');
  const productionConfigRoot = join(homedir(), '.elanous');
  if (plan.worktreePath === productionConfigRoot || dirname(plan.configDir) === productionConfigRoot) {
    throw new Error('격리 위반: 홈 ~/.elanous 운영 config 오염');
  }
  if (!plan.branch.startsWith('se/')) throw new Error('격리 위반: 브랜치가 se/ 접두 아님');
}

/** 부팅 필수 인프라 키 — 정식 config 에서 격리로 상속(설계: "테스트 config=정식 sparse
 *  copy·비밀 재사용"). LLM provider 없으면 데몬이 setup-status 게이트로 부팅 거부(dogfood
 *  발견 2026-07-10). 채널(telegram/discord/voice)·finance·dispatch·autopilot 은 상속 안 함
 *  (disarmed 유지·정식 분리). 상속 후 disarmed 키가 override 하므로 재-arm 위험 없음. */
export const BOOT_INHERIT_KEYS = ['llm', 'mcp', 'skills', 'acp', 'lsp'] as const;

/** 정식 config.json 에서 부팅 필수 키만 추출(fail-soft·없으면 {}). */
export function readInheritedConfig(prodConfigPath: string = join(homedir(), '.elanous/config.json')): Record<string, unknown> {
  try {
    const full = JSON.parse(readFileSync(prodConfigPath, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of BOOT_INHERIT_KEYS) if (k in full) out[k] = full[k];
    return out;
  } catch { return {}; }
}

/** 테스트 config(정식 sparse copy·비밀 재사용·매매/발송 disarmed) — 격리 데몬이 부팅은
 *  하되 실매매/발송/자율은 못 하게. inherit=정식에서 상속한 부팅 필수 키(llm 등). */
export function buildTestConfig(
  port: number,
  inherit: Record<string, unknown> = {},
  worktreeRoot = configuredWorktreeRoot(),
): Record<string, unknown> {
  const inheritedTools = inherit.tools && typeof inherit.tools === 'object' && !Array.isArray(inherit.tools)
    ? inherit.tools as Record<string, unknown>
    : {};
  const inheritedSelfImplement = inheritedTools.selfImplement && typeof inheritedTools.selfImplement === 'object' && !Array.isArray(inheritedTools.selfImplement)
    ? inheritedTools.selfImplement as Record<string, unknown>
    : {};
  return {
    ...inherit,                          // 부팅 필수(llm/mcp/skills/acp/lsp) — disarmed 키가 아래서 override.
    __self_evolution_isolated: true,
    tools: { ...inheritedTools, selfImplement: { ...inheritedSelfImplement, worktreeRoot } },
    nexus: { httpPort: port },
    // 매매/발송/자율 dispatch 전부 disarmed(정식과 완전 분리).
    dispatch: { enabled: false },
    finance: { dispatch: { enabled: false }, dig: { autoGoal: { enabled: false } }, replay: { autoGoal: { enabled: false } } },
    // 자율 경계도 전부 off(격리 안에서도 merge/reboot 없음).
    autopilot: { absorb: { armed: false }, merge: { armed: false }, reboot: { armed: false } },
  };
}

/** ★ 격리 worktree deps 준비 — git worktree 는 빌드 산출물이 없다. 정식 repo 의
 *  node_modules(dogfood 2026-07-09: 없으면 게이트 모듈로드 실패) + apps/pwa/out(dogfood
 *  2026-07-10: 없으면 setup-status PWA build 게이트로 데몬 부팅 거부) 를 심링크(즉시·
 *  재빌드 불필요·읽기공유 안전). */
export function ensureWorktreeDeps(repoRoot: string, plan: IsolatedPlan): void {
  const dependencyLinks = linkWorktreeDependencies(repoRoot, plan.worktreePath, ['node_modules', 'apps/pwa/out']);
  debug.log('autopilot.build', 'isolated-instance.dependencies', { repoRoot, worktreePath: plan.worktreePath, dependencyLinks });
}

export interface CreateIsolatedDeps {
  createWorktree?: typeof createWorktree;
  /** node_modules/pwa 심링크 스킵(테스트). */
  skipDeps?: boolean;
  /** 정식 config 상속 override(테스트). 미지정 시 ~/.elanous/config.json 에서 부팅 필수 키. */
  inherit?: Record<string, unknown>;
  /** ★ se 스택 base 위에 origin/main 반영 seam(테스트 주입). 기본=실제 git fetch+merge. */
  mergeMain?: (worktreePath: string) => 'merged' | 'up-to-date' | 'conflict-abort' | 'error';
  /** ⛔⭐ worktree 뿌리 override. 미지정 시 `tools.selfImplement.worktreeRoot`(기본 `~/.elanous/worktrees`).
   *  ***테스트는 이것을 반드시 주입한다*** — 안 주면 실제 홈 디렉터리 아래에 worktree·config 이 만들어지고
   *  `rmSync(tmp)` 로는 안 지워져 사용자 디렉터리에 잔존물이 남는다(리뷰 must-fix ①). */
  worktreeRoot?: string;
}

/** ★ 구조적 정합(대표 2026-07-21·INCIDENT PR머지↔스택 갭) — se 스택 worktree 에 origin/main 을 반영해
 *  완주 중 개별 머지된 PR 을 잇는다. fetch → merge(--no-edit·-X theirs). ★-X theirs = 충돌 라인은 검증된
 *  origin/main(머지된 PR·리뷰 통과)을 우선 채택(대표 2026-07-21·라이브 705308: walker 자체 산출물과 main 의
 *  같은 파일 수정이 충돌해 conflict-abort→미반영 반복). main 이 검증된 정본이므로 충돌 시 우선이 안전.
 *  그래도 실패(비-충돌 에러)면 abort·base 유지(fail-soft). */
export function defaultMergeMainIntoWorktree(worktreePath: string): 'merged' | 'up-to-date' | 'conflict-abort' | 'error' {
  try {
    // fetch 실패 → stale origin/main 을 merge 해 잘못 정합하지 않도록 error(자동 정합 계약 보호).
    const fetched = runGitCommand(worktreePath, ['fetch', 'origin', 'main', '--quiet'], { encoding: 'utf8' });
    if (fetched.status !== 0) return 'error';
    const mg = runGitCommand(worktreePath, ['merge', '--no-edit', '-X', 'theirs', 'origin/main'], { encoding: 'utf8' });
    if (mg.status === 0) return /Already up to date|Already up-to-date/.test(mg.stdout) ? 'up-to-date' : 'merged';
    // 비정상 종료 — 충돌만 abort(base 유지). 충돌이 아닌 에러(merge 미시작 등)는 abort 없이 error 로 분류.
    const out = `${mg.stdout}\n${mg.stderr}`;
    if (!/CONFLICT|Automatic merge failed|conflict/i.test(out)) return 'error';
    const aborted = runGitCommand(worktreePath, ['merge', '--abort'], { encoding: 'utf8' });
    return aborted.status === 0 ? 'conflict-abort' : 'error'; // abort 실패 = base 보장 불가 → error
  } catch { return 'error'; }
}

/** 격리 인스턴스 생성 — worktree(별 브랜치) + deps 심링크 + 테스트 config(부팅 필수 키 상속). */
export function createIsolatedInstance(repoRoot: string, slug: string, base: string | undefined, deps: CreateIsolatedDeps = {}): IsolatedPlan {
  // ⛔⭐ 뿌리를 «한 번» 해석해서 세 자리(plan · mkWt · buildTestConfig)에 «같은 값»으로 내린다.
  //    종전엔 세 자리가 각자 getUserConfig() 를 다시 읽어, 테스트가 어느 하나만 주입해도
  //    나머지가 «전역 기본 = 홈 아래»로 새어 실제 사용자 디렉터리에 산출물을 남겼다(리뷰 must-fix ①).
  const worktreeRoot = deps.worktreeRoot ?? configuredWorktreeRoot();
  const plan = planIsolatedInstance(repoRoot, slug, worktreeRoot);
  assertIsolationSafe(plan);
  const mkWt = deps.createWorktree ?? createWorktree;
  // ★ 페이즈 스택 base 유효성(대표 2026-07-13) — origin/se/<slug> 스택 base 가 로컬 remote-tracking
  //   에 없으면(직전 페이즈 push 실패·미생성) main 으로 fallback 해 전체 페이즈 즉사 대신 독립 빌드로
  //   진행(정직·경고). 'main'/'HEAD'/undefined 는 그대로. read-only rev-parse.
  let safeBase = base;
  if (safeBase && safeBase !== 'main' && safeBase !== 'HEAD') {
    const ok = runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${safeBase}^{commit}`], { encoding: 'utf8' }).status === 0;
    if (!ok) { console.warn(`[isolated] base ref 없음(${safeBase}) → main fallback (페이즈 스택 유실·독립 빌드)`); safeBase = 'main'; }
  }
  // ★ 재실행 견고화(대표 지시 2026-07-12) — 안정 브랜치명(se/…-<phaseHex>)은 재실행·재구현
  //   시 같은 이름이 재등장한다. 이전 세대 브랜치/worktree 가 롤백에서 안 지워지고 남으면
  //   `worktree add -b` 가 "branch already exists" 로 하드 실패(dogfood: KGS 페이즈 즉사).
  //   SE 격리는 항상 base 에서 새로 구현하므로 resetExisting=true(고아 정리 후 -B 재생성).
  mkWt({ repoRoot, branch: plan.branch, worktreeRoot, resetExisting: true, ...(safeBase ? { base: safeBase } : {}) });
  // ★ 구조정합(origin/main 반영)은 async LLM 지능형 충돌 해결이라 sync createIsolatedInstance 밖(호출부
  //   nocturnal-deps.createInstance)에서 수행한다(mergeMainIntoWorktreeWithLlm). 여기는 worktree 생성만.
  if (!deps.skipDeps) ensureWorktreeDeps(repoRoot, plan);
  mkdirSync(plan.configDir, { recursive: true });
  const inherit = deps.inherit ?? readInheritedConfig();
  writeFileSync(join(plan.configDir, 'config.json'), JSON.stringify(buildTestConfig(plan.port, inherit, worktreeRoot), null, 2));
  return plan;
}

export interface DisposeDeps { removeWorktree?: typeof removeWorktree }

/** 격리 인스턴스 제거(worktree prune). force=변경 있어도 제거. */
export function disposeIsolatedInstance(repoRoot: string, plan: IsolatedPlan, force = true, deps: DisposeDeps = {}): void {
  assertIsolationSafe(plan); // 정식 경로 제거 방지 이중 확인
  const rmWt = deps.removeWorktree ?? removeWorktree;
  rmWt(repoRoot, plan.worktreePath, force);
}
