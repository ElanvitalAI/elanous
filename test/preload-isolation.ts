// ── bun test 전역 격리 preload (PLAN 1-A 3층 · 계약) ─────────────────────────
//
// 왜: test→운영 스토어 누출이 4번 반복됐다(PTY #5246·세션 #5252·env.TZ·conatus
// #5262). 근본은 `elanousStateRoot()`(src/autopilot/state-paths.ts) 등 resolver 가
// ELANOUS_STATE_DIR 미설정 시 `~/.elanous`(운영)를 반환하고, `bun test` 프로세스에
// 전역 격리 훅이 없어 격리가 **테스트 파일 개개의 자율 규율**에만 의존한 데 있다.
// 개별 스토어마다 인라인 `NODE_ENV==='test'` 리다이렉트(안전망)를 흩뿌리면 새
// 스토어가 가드를 빠뜨릴 때 또 샌다.
//
// 이 preload = **최상단 3층(계약)**: bun test 프로세스 전체에 격리 ELANOUS_STATE_DIR 을
// 강제해, 개별 모듈 규율과 무관하게 일괄 격리한다. 개별 안전망을 대체가 아니라
// **보완**(최종 방어선)한다 — resolver 는 첫 순위로 process.env.ELANOUS_STATE_DIR 을
// 존중하므로(state-paths·session·conatus·pty-manifest 동형), 여기서 세팅하면 전
// 스토어가 그 하위로 일관되게 격리된다.
//
// ⚠️ **미설정일 때만** 강제한다(`??=` 의미). 개별 테스트(elanous-state-dir-isolation·
// instance identity·fleet 등)가 프로세스 시작 후 자기 ELANOUS_STATE_DIR 을 세팅/복원/
// 삭제하는 것을 절대 덮으면 안 된다 — 무회귀의 핵심.
//
// ⚠️ 값은 tmpdir() 하위(`elanous-test-global-<pid>`) — 기존 안전망(session·conatus 의
// `tmpdir()/elanous-test-*-<pid>`)과 동형. `homedir()`+`.elanous` 하드코딩은 격리 게이트
// (scripts/ci-isolation-hardcode-gate.ts) 위반이자 격리의 정반대이므로 금지.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { GIT_LOCATION_ENV_KEYS } from '../scripts/test-deterministic.js';
import { debug } from '../src/debug/log.js';

const clearedGitKeys = GIT_LOCATION_ENV_KEYS.filter((key) => Object.hasOwn(process.env, key));
for (const key of clearedGitKeys) delete process.env[key];
if (clearedGitKeys.length > 0) debug.log('test.preload', 'git-location-env-cleared', { keys: clearedGitKeys });

// ⛔⭐⭐⭐ 2026-08-05 인시던트 — **이 그물이 «자격증명»을 안 덮고 있었다.**
//   `saveTokens('openai-codex', …)` 은 «기본으로» 미러를 쓰고, 그 대상은 CODEX_HOME 미설정 시
//   사용자의 «진짜» `~/.codex/auth.json` 이다. 테스트가 그것을 픽스처로 덮어
//   (access_token = {"alg":"none"}…"sig" · refresh_token = "d-r") 공식 codex CLI 와
//   `elanous provider codex usage` 가 «둘 다» 401 로 죽었다.
//   ⇒ 위 4회 반복과 «같은 계급»이고, 다른 점은 잃는 것이 상태가 아니라 «로그인»이라는 것뿐이다.
//   ⚠️ 이 층은 「잊음」을 막는다. 「env 를 명시적으로 지운 테스트」는 못 막으므로
//     `mirrorCodexAuth` 의 큰소리 가드(2층)와 «짝»이다 — 어느 한쪽만으로는 안 닫힌다.
if (!process.env.CODEX_HOME?.trim()) {
  const isolatedCodex = join(tmpdir(), `elanous-test-codex-home-${process.pid}`);
  mkdirSync(isolatedCodex, { recursive: true });
  process.env.CODEX_HOME = isolatedCodex;
  process.on('exit', () => {
    try { rmSync(isolatedCodex, { recursive: true, force: true }); } catch { /* fail-soft */ }
  });
}

delete process.env.ELANOUS_LLM_PROVIDER;
delete process.env.ELANOUS_LLM_MODEL;
delete process.env.ELANOUS_ESCALATE_PROVIDER;
delete process.env.ELANOUS_ESCALATE_MODEL;

// ssh fleet 은 «설정»이다(~/.elanous/ssh-hosts.json) — 시험이 운영자의 실제 fleet 을 읽지 않게
// 없는 경로로 못 박는다. fleet 이 필요한 시험은 `setSshHostsForTesting(TEST_FLEET)` 로 주입한다.
process.env.ELANOUS_SSH_HOSTS_PATH = join(tmpdir(), `elanous-test-ssh-hosts-${process.pid}`, 'absent.json');
delete process.env.ELANOUS_MEDIA_HOST;

// The GitHub App key is machine-level (~/.elanous/secrets/github-app). A test that reaches it mints a real
// bot token on the network, and that token can end up in a real gh under a temp HOME (10-01 keychain dialogs).
// Point the App config at nothing; App tests pass `configPath` explicitly.
process.env.ELANOUS_GITHUB_APP_CONFIG_PATH = join(tmpdir(), `elanous-test-github-app-${process.pid}`, 'absent.json');

const inheritedHarnessRun = Boolean(process.env.ELANOUS_RUN_ID?.trim());
if (inheritedHarnessRun || !process.env.ELANOUS_STATE_DIR?.trim()) {
  const isolated = join(tmpdir(), `elanous-test-global-${process.pid}`);
  mkdirSync(isolated, { recursive: true });
  process.env.ELANOUS_STATE_DIR = isolated;
  if (inheritedHarnessRun) {
    delete process.env.ELANOUS_STATE_DIR_SOURCE;
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
    delete process.env.ELANOUS_CONTROL_INBOX_DIR;
  }
  // 우리가 생성한 경우에만 프로세스 종료 시 정리 — CI 장기 러너 누적 방지(전역 preload라
  // 영향 넓음). fail-soft: 정리 실패가 테스트를 깨지 않게 try/catch. 하니스 정체성을
  // 물려받은 시험은 부모 상태를 덮어쓰지 않고 새 디렉터리를 정리한다.
  process.on('exit', () => {
    try { rmSync(isolated, { recursive: true, force: true }); } catch { /* fail-soft */ }
  });
}

// 실행 루프 관문(dispatchTask · #21964) — `runDevPipeline` 의 기본 관문은 예산·기억 조회를 실제로 돌려
// 한 번에 수 초가 걸린다. 파이프라인 시험 수십 개가 5초 제한에 걸렸다(09-29 · main 에서 7건 · #22005 에서 20건).
// 관문을 재는 시험은 dispatchTask 나 dispatchTaskDeps 를 주입하므로 이 값과 무관하게 돈다. 미설정일 때만.
process.env.ELANOUS_EXECUTION_LOOP_DISPATCH ??= 'off';
