// `--test-state-dir <dir>` global CLI flag (2026-05-13 ·
// config-dir-unify).
//
// Internal-only flag used to propagate the `--test` mode's nexus
// state root to bg-launch'd child processes WITHOUT relying on the
// removed `ELANOUS_NEXUS_DIR` environment variable. The flag is
// extracted *before* Commander parses (same pattern as
// `--config-dir` in `config-dir-flag.ts`) and routed through
// `setTestStateRoot()` so every consumer of `nexusRootDir()` sees
// the override transparently.
//
// Surface:
//   - User-facing: never. `--test` is the public flag; this is the
//     wire that carries the test layout's stateDir to the daemon
//     child.
//   - bg-launch: re-appends `--test-state-dir <dir>` to the child
//     argv when the parent has a test state root active.
//
// Resolution: last occurrence wins; empty / whitespace dropped.

export interface TestStateDirFlagResult {
  /** Directory the caller passed, or undefined when the flag was absent. */
  dir: string | undefined;
  /** A new argv array with the flag tokens removed. */
  argv: string[];
}

/** Pure extractor — mirrors `extractConfigDirFlag`. */
export function extractTestStateDirFlag(argv: readonly string[]): TestStateDirFlagResult {
  const out: string[] = [];
  let found: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--test-state-dir') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next.trim().length > 0) {
        found = next.trim();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const eqMatch = /^--test-state-dir=(.*)$/.exec(tok);
    if (eqMatch) {
      const v = eqMatch[1]!.trim();
      if (v.length > 0) found = v;
      i += 1;
      continue;
    }
    out.push(tok);
    i += 1;
  }
  return { dir: found, argv: out };
}

/** Removes the flag from `process.argv` + calls `setTestStateRoot`. */
export function applyTestStateDirFlagFromArgv(): string | undefined {
  const { dir, argv } = extractTestStateDirFlag(process.argv);
  if (dir === undefined) return undefined;
  // Lazy import to avoid pulling node:fs etc. when consumers only need
  // the pure extractor.
  process.argv = argv;
  applyIsolatedRoot(dir);
  return dir;
}

/** ★ 격리 루트 적용 본체 (2026-07-26 · P2 로 추출) — `--test-state-dir`(내부·데몬 자식)와
 *  전역 `--test`(사람·에이전트) **두 입구가 공유**한다. 종전엔 이 기계가 internal-only 플래그
 *  뒤에만 있어 사람이 부를 입구가 없었고, 그래서 문서 174곳에 수동 주문이 화석으로 남았다.
 *
 *  하는 일: nexus state root ⊕ ELANOUS_STATE_DIR ⊕ config-dir 을 **한 뿌리로** 세우고,
 *  config 사본이 없으면 물질화하며, config 경로가 test 루트 밖이면 **기동을 거부**한다. */
export function applyIsolatedRoot(dir: string): void {
  const { setTestStateRoot } = require('../nexus/paths.js') as typeof import('../nexus/paths.js');
  setTestStateRoot(dir);

  // The presence of `--test-state-dir` means "I am the isolated test daemon"
  // (pwa-test re-appends it to the daemon child only). Complete the isolation
  // so an operating (production) environment is NEVER touched:
  //  1. Relocate ALL mutable state (sessions · acp · surface · codex-threads)
  //     under the test root — otherwise the daemon writes into prod ~/.elanous.
  //  2. ISO-2 (2026-07-13 · 대표 결정): config 도 **완전 분기** — 테스트
  //     프로세스는 운영 config.json 을 아예 열지 않는다. 물질화된 test-safe
  //     사본(<testRoot>/config.json · `elanous config sync-test`)만 읽고 쓴다.
  //     종전 in-memory overlay(buildTestSafeDaemonConfig 를 getUserConfig 에
  //     거는 방식)는 은퇴 — overlay 뷰가 디스크에 박제되는 오염 사건(#4029)과
  //     "공유 config write-through" 함정 클래스의 원천 제거.
  if (!process.env.ELANOUS_STATE_DIR?.trim()) process.env.ELANOUS_STATE_DIR = dir;
  try {
    const cfgDir = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
    const current = cfgDir.getElanousConfigDirOverride();
    if (current !== dir) {
      if (current !== undefined) {
        // bg-launch 가 운영 config-dir 를 관성으로 물려준 경우 등 — 격리가 이긴다.
        console.error(`[test-isolation] --config-dir ${current} 는 --test 격리와 충돌 — ${dir} 로 강제`);
      }
      cfgDir.setElanousConfigDir(dir);
    }
    // config 사본 보장 — 없으면 운영에서 물질화(최초 무마찰), 있으면 drift 경고만
    // (자동 덮어쓰기 금지 — 명시적 sync 원칙). 유닛 테스트(NODE_ENV=test)는
    // 실 운영 config/secrets 를 temp 로 복사하지 않도록 sync 스킵.
    if (process.env.NODE_ENV !== 'test') {
      const sync = require('./config-test-sync.js') as typeof import('./config-test-sync.js');
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      if (!existsSync(join(dir, 'config.json'))) {
        const r = sync.syncTestConfig(dir);
        console.error(`[test-isolation] 운영 config 물질화 → ${r.testConfigPath} (telegram=${r.telegramMode})`);
      } else if (sync.isTestConfigStale(dir)) {
        console.error(`[test-isolation] ⚠️ 운영 config 가 테스트 사본보다 최신 — 'elanous config sync-test' 로 갱신 권장`);
      }
      // 부팅 불변식 — 테스트 프로세스의 config 경로는 반드시 test 루트 안.
      // (위 강제로 항상 참이어야 하나, 미래 회귀를 기동 거부로 잡는다.)
      const paths = require('../nexus/config/paths.js') as typeof import('../nexus/config/paths.js');
      if (!paths.userConfigPath().startsWith(dir)) {
        console.error(`[test-isolation] 불변식 위반: config 경로(${paths.userConfigPath()})가 test 루트(${dir}) 밖 — 기동 거부`);
        process.exit(1);
      }
    }
  } catch (e) {
    // config 격리를 보장할 수 없으면 운영 오염 위험 — 조용히 계속하지 않는다.
    console.error(`[test-isolation] config 분기 실패: ${e instanceof Error ? e.message : String(e)} — 기동 거부`);
    process.exit(1);
  }

}
