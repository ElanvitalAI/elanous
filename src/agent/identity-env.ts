// ── PTY 정체성 전파 SSOT (P0.5 · 2026-07-26) ──────────────────────────────
//
// 근본(실측): `getCapturedEnv()`(shell-env-bootstrap.ts · F3)는 `$SHELL -l -i -c printenv`
// 로그인 셸 스냅샷을 캐시하고, 모든 PTY spawn 이 `process.env` 대신 그 스냅샷을 env 베이스로
// 쓴다. 시드 allowlist 에 `ELANOUS_*` 가 하나도 없어서 **프로세스가 런타임에 심은 정체성이
// PTY 경계에서 통째로 소실**된다.
//
//   셸이 정의(rc 유래·ANTHROPIC_API_KEY·PATH) → 로그인 셸이 재생산 → ✅ 생존
//   프로세스가 런타임에 설정(ELANOUS_STATE_DIR 등) → 로그인 셸이 알 리 없음 → ❌ 소실
//
// 실측 결과: 격리된 elanous(`--test`)가 띄운 PTY 안에서 elanous 를 실행하면 두 축이 모두 비어
// **완전한 prod(`~/.elanous`)로 떨어진다**(축 어긋남이 아니라 격리 완전 소실). 부수로
// `ELANOUS_NEST_DEPTH` 도 잃어 재귀 depth cap(fork-bomb 가드)이 우회된다.
//
// 설계 = 내부 문서 `DESIGN-instance-leader-and-default-test-2026-07-26` §1d·§4e.
//
// ⚠️ 이 버그는 **캡처가 성공할 때만** 존재한다 — 캡처 실패 시 `process.env` 폴백이라 정체성이
// 보존된다. CI·헤드리스는 `$SHELL -l -i` 가 실패/타임아웃하기 쉬워 **버그가 부재**하므로,
// 회귀 테스트는 반드시 `setCapturedEnvForTesting()` 으로 캡처를 고정해야 한다(위양성 방지).

import { debug } from '../debug/log.js';
import { getCapturedEnv, capturedEnvAvailable } from '../shell-env-bootstrap.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { treeDerivedRootFor } from '../instance/resolve.js';

/** Pin a child state root together with its origin; only reuse a parent's tag for the same root. */
export function stateDirSourceForChild(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ELANOUS_STATE_DIR === root && env.ELANOUS_STATE_DIR_SOURCE?.trim()) {
    return env.ELANOUS_STATE_DIR_SOURCE;
  }
  const current = resolveCurrentInstance();
  return root === treeDerivedRootFor(process.cwd()) || (current.root === root && current.layer === 'default')
    ? 'derived' : 'explicit';
}

// ── 전파 allowlist ─────────────────────────────────────────────────────────
//
// **옵트인(allowlist)인 이유**: 새 `ELANOUS_*` 가 생겼을 때 기본값이 "전파 안 함"이어야 안전하다.
// denylist 는 잊으면 **새는 쪽으로** 실패한다.
//
// 여기 있는 것은 전부 "이 프로세스가 어느 인스턴스/공간에 속하는가"를 말하는 **정체성 마커**이며,
// 자식이 그 정체성을 물려받는 것이 정의상 옳다.
const IDENTITY_ENV_KEYS = [
  'ELANOUS_STATE_DIR',        // 격리 뿌리 — 본건
  // ⛔⭐⭐⭐⭐ **뿌리와 «같이» 가야 한다 — 안 그러면 한 홉 뒤에 「파생」이 「명시」로 둔갑한다.**
  //   🚨 2026-08-19 실측: 이 키를 allowlist 에 «안 넣어서» 딱지가 ***한 홉만*** 살았다.
  //     둘째 홉에서 `identity.ELANOUS_STATE_DIR` 이 «이미 있어» 아래 합성 분기가 안 돌고,
  //     `identityEnv()` 는 allowlist 밖이라 딱지를 «안 옮긴다» ⇒ 손자가 파생 뿌리를 명시로 읽는다.
  //     ⇒ 실물 결과: 쿼터 신호가 갱신 안 되는 우주를 봐서 전 계정 unknown ⇒ 회전이 100% 계정 선택 ⇒ 429.
  //   📌 이 파일 머리말이 경고한 바로 그 형태다 — ***"좁은 allowlist … 정체성이 소실"***.
  'ELANOUS_STATE_DIR_SOURCE', // 그 뿌리가 «파생»인가 «명시»인가 — 뿌리와 «한 벌»이다
  'ELANOUS_CONTROL_INBOX_DIR', // 부모가 해석한 제어 inbox — 중첩 PTY도 같은 대기 자리를 본다
  'ELANOUS_NEST_DEPTH',       // 재귀 cap(fork-bomb 가드) — 잃으면 자식이 자기를 depth 0 으로 인식
  'ELANOUS_HARNESS_SPACE',    // 하니스 공간 kind ┐ harnessSpaceEnv() 가 한 벌로 세팅 — 셋이 같이
  'ELANOUS_HARNESS_SPACE_ID', // 하니스 공간 id   │ 가야 getHarnessSpace() 가 공간을 복원한다
  'ELANOUS_RUN_ID',           // run 상관관계     ┘
  'ELANOUS_SESSION_ID',       // 세션 귀속
  'ELANOUS_ORIGIN_ROOT',      // 최초 실행 시작 주체(set-once)
  'ELANOUS_ORIGIN_AGENT',     // 외부 에이전트 이름(set-once·external-agent일 때만)
  'ELANOUS_ORIGIN_SESSION',   // 외부 에이전트 세션(set-once·있을 때만)
  'ELANOUS_CONTROLLER',       // 현재 프로세스의 상위 PTY/run 제어자(층마다 갱신 가능)
  'ELANOUS_CONTROL_CHANNELS', // 자식을 조작할 수 있는 관 목록(쉼표 구분)
  'ELANOUS_PTY_CHAIN_ORIGIN', // PTY 실행 사슬의 tree/worktree 출발지(실행 출신과 별도 축)
] as const;

/** ⛔⭐⭐⭐ **래칫용 — `buildPtyEnv` 가 «합성»하는 키 목록**(2026-08-19 · `OBS-T118` 후속).
 *
 * 🚨 왜 있나 — 나는 `ELANOUS_STATE_DIR_SOURCE` 를 «합성»만 하고 ***allowlist 에 안 넣었다***.
 *   그래서 딱지가 ***한 홉만*** 살았고, 손자가 「파생」을 「명시」로 읽어 429 가 «네 번» 났다.
 *   ⇒ 🔑 사람이 매번 「둘 다 했나」를 기억하는 대신 ***기계가 잡게 한다***(대표 *"절차 말고 도구가"*).
 * ⛔ 새 키를 합성하면 «여기»와 `IDENTITY_ENV_KEYS` 에 «둘 다» 넣어라 — 테스트가 그것을 문다. */
export const SYNTHESIZED_IDENTITY_ENV_KEYS = [
  'ELANOUS_STATE_DIR',
  'ELANOUS_STATE_DIR_SOURCE',
] as const;

export type OriginRoot = 'external-agent' | 'elanous-internal' | 'human-cli' | 'scheduler';

export function deriveChildController(env: NodeJS.ProcessEnv, pid: number): string {
  const ptyId = env.ELANOUS_PTY_ID?.trim();
  if (ptyId) return `pty:${ptyId}`;
  const originAgent = env.ELANOUS_ORIGIN_AGENT?.trim();
  if (originAgent) return `agent:${originAgent}`;
  return `pid:${pid}`;
}

/**
 * 최초 CLI 진입점에서 실행 시작 주체를 한 번 결정한다.
 *
 * ROOT·AGENT·SESSION은 부모가 이미 정한 값을 절대 덮지 않는다. controller는 프로세스
 * 계층마다 달라질 수 있으므로, 제공될 때만 현재 호출자가 갱신한다.
 */
export function establishExecutionOrigin(
  env: NodeJS.ProcessEnv = process.env,
  controller?: string,
  sessionId?: string,
): OriginRoot {
  const explicitSession = sessionId?.trim();
  if (explicitSession && env.ELANOUS_ORIGIN_SESSION === undefined) {
    env.ELANOUS_ORIGIN_SESSION = explicitSession;
  }
  const existingRoot = env.ELANOUS_ORIGIN_ROOT?.trim();
  if (!existingRoot) {
    const agent = env.AI_AGENT?.trim();
    if (agent) {
      env.ELANOUS_ORIGIN_ROOT = 'external-agent';
      env.ELANOUS_ORIGIN_AGENT = agent;
      const claudeSession = env.CLAUDE_CODE_SESSION_ID?.trim();
      if (claudeSession && env.ELANOUS_ORIGIN_SESSION === undefined) {
        env.ELANOUS_ORIGIN_SESSION = claudeSession;
      }
    } else {
      env.ELANOUS_ORIGIN_ROOT = 'human-cli';
    }
  }
  if (controller?.trim()) env.ELANOUS_CONTROLLER = controller;
  return (env.ELANOUS_ORIGIN_ROOT?.trim() || 'human-cli') as OriginRoot;
}

// ── 의도적 제외 ────────────────────────────────────────────────────────────
//
// 1. **shadow-root env**(아래) — `--config-dir`/`ELANOUS_STATE_DIR` 을 우회해 스토어를 인스턴스
//    뿌리 밖으로 빼돌린다(instance-root-coherence.ts SHADOW_ROOT_ENVS · 은퇴 대상).
//    ⚠️ **정확한 보장 범위**: 이 목록은 "process overlay 에서 **승격하지 않는다**"일 뿐,
//    사용자가 `.zshrc` 에서 export 했다면 captured 로그인 env 에 실려 **그대로 통과**한다
//    (captured 는 셸 계보의 정본이라 여기서 걷어내지 않는다 — 그건 별개 축이고
//    `assertInstanceRootCoherence` 가 부팅에서 시끄럽게 만든다).
// 2. **자격증명**(`*_API_KEY` 등) — config 경유가 정본. env 사본을 늘리지 않는다.
//    (근거: INCIDENT-escalate-provider-apikey-desync-401-2026-07-26 §I3 — credential 해석
//     우주가 이미 둘이라 env 경로를 늘리면 비균일성이 커진다.)
// 3. **PATH·셸 계보** — ★절대 금지. captured env 가 정본이고, 덮으면 F3 이 고친
//    "`.zprofile` 전용 PATH 소실 → command not found" 회귀가 그대로 재발한다.
// 4. **`ELANOUS_HARNESS_ROLE`·`ELANOUS_HARNESS_BOUNDARY`·`ELANOUS_HARNESS_DETACHED`** — 정체성이
//    아니라 **행위 스위치**다. 전파하면 격리 수복과 무관한 **동작 변경**이 된다:
//      - ROLE: 스포너의 세포 role. PTY 자식이 같은 role 이라는 보장이 없고, 공간(SPACE)만
//        전파돼도 `getHarnessRole()` 폴백이 executor 를 준다(명시 전파는 오히려 오라벨 위험).
//      - BOUNDARY: 자식에게 쓰기 게이팅을 활성화. 안전 방향이나 별도 판단이 필요.
//      - DETACHED: "subprocess 로 재위임 말 것" 재귀 가드. 전파하면 위임 의미론이 PTY 를
//        넘어 확장된다(`skills/tools/solve-mission.ts` 가 이 값으로 인프로세스를 결정).
//    ⇒ 본 변경의 불변식이 "기존 호출자 동작 무변경"이므로 **제외**. 필요하면 각각을 근거와 함께
//      별도로 승격할 것(재검토 후보).
const SHADOW_ROOT_ENV_KEYS = [
  'ELANOUS_HOME', 'ELANOUS_DIR', 'ELANOUS_NEXUS_DIR', 'ELANOUS_TASKS_DIR', 'ELANOUS_TASKS_DB',
] as const;

/** 전파 대상 정체성 마커만 추린다(순수). 값이 없거나 빈 문자열이면 키 자체를 만들지 않는다 —
 *  빈 값이 captured env 의 유효한 값을 덮어 지우는 것을 막는다. */
/** ⛔ 래칫이 «실제로 판정에 쓰이는» 목록을 보게 한다 — 사본을 만들면 둘이 갈린다. */
export function identityEnvKeys(): readonly string[] { return IDENTITY_ENV_KEYS; }

export function identityEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of IDENTITY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/** process overlay 에 있으나 전파에서 제외한 shadow-root 개수(관측용 — 값 금지).
 *  ⚠️ captured 로그인 env 에 실린 동명 변수는 세지 않는다(위 §1 보장 범위 참조). */
export function blockedIdentityEnvCount(env: NodeJS.ProcessEnv = process.env): number {
  let count = 0;
  for (const key of SHADOW_ROOT_ENV_KEYS) if (env[key]) count++;
  return count;
}

/** PTY env 합성 — **이 순서를 바꾸지 말 것**.
 *
 *    { ...getCapturedEnv(), ...identityEnv(), ...callerEnv }
 *      ↑ 셸 계보(PATH)      ↑ 프로세스 정체성  ↑ 호출자가 최종 승자
 *
 *  `process.env` 를 통째로 섞는 것은 **오답**이다 — 부모의 얕은 PATH 가 로그인 셸 PATH 를 덮어
 *  F3 회귀를 일으킨다. 좁은 allowlist 를 captured **위에** 얹는 것이 핵심.
 *
 *  ⚠️ `identityEnv()` 는 **호출 시점에** `process.env` 를 다시 읽는다. `getCapturedEnv()` 는
 *  프로세스당 1회 캐시라, 정체성을 캐시 안에 주입하는 구현으로 가면 최초 캡처 이후 바뀌는 값
 *  (`ELANOUS_RUN_ID` · 나중에 세팅되는 `ELANOUS_NEST_DEPTH`)이 얼어붙는다. */
export function buildPtyEnv(
  callerEnv: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
  opts: { readonly unset?: readonly string[] } = {},
): Record<string, string> {
  const captured = getCapturedEnv();
  const identity = identityEnv(env);
  let fallbackStateDir: string | undefined;
  // ⛔⭐⭐ **딱지는 「없을 때 붙인다」가 아니라 「파생이면 붙인다」다**(자기치유 · 2026-08-19).
  //   🚨 종전엔 뿌리를 «합성할 때만» 붙였다. 그러면 어느 홉에서든 딱지가 한 번 떨어지면
  //     ***그 아래로는 영영 「명시」로 읽힌다***. ⇒ 값이 파생 뿌리와 «같으면» 다시 붙인다.
  //   ⛔ 사람이 «명시»한 값에는 안 붙는다 — 그 값은 파생 뿌리와 다를 것이기 때문이다.
  {
    const current = resolveCurrentInstance();
    if (current.kind === 'test' && identity.ELANOUS_STATE_DIR === current.root) {
      identity.ELANOUS_STATE_DIR_SOURCE = 'derived';
    }
  }
  if (!identity.ELANOUS_STATE_DIR) {
    const current = resolveCurrentInstance();
    if (current.kind === 'test') {
      fallbackStateDir = current.root;
      identity.ELANOUS_STATE_DIR = fallbackStateDir;
      // ⛔⭐⭐⭐⭐ **자식에게 「이 값이 «어디서 왔나»」를 같이 준다**(2026-08-19 · `OBS-T114`).
      //
      // 🚨 왜 필요한가 — 자식이 받는 것은 ***그냥 `ELANOUS_STATE_DIR` 문자열 하나***라서,
      //   「사람이 «명시»로 격리했다」와 「트리에서 «파생»돼 여기서 채워 넣었다」를 ***구분할 수 없다.***
      //   ⇒ 실물 사고: 쿼터 신호가 그 값을 「명시 격리」로 읽고 자기 우주를 봤고, 그 우주엔
      //     신호를 갱신하는 사람이 없어 ***전 계정이 `unknown`*** 이 됐다. 그러자 회전이
      //     ***이미 100% 인 계정을 골라*** 429 로 죽었다(같은 골이 «세 번»).
      //   📏 같은 시각 «부모» CLI 는 값을 정상으로 읽었다 — 즉 갈린 것은 코드가 아니라 ***맥락***이었다.
      // ⭐ 이 파일은 그 구분을 ***이미 계산하고 있었다***(`stateDirSource: 'fallback' | 'env'`) —
      //   그런데 ***로그로만 냈고 자식에게는 안 줬다***. 그것이 이 결함의 정확한 형태다(`F41`).
      // ⛔ 지우지 마라 — 지우면 자식이 다시 「파생」을 「명시」로 읽는다.
      identity.ELANOUS_STATE_DIR_SOURCE = 'derived';
    }
  }
  const result: Record<string, string> = { ...captured, ...identity, ...callerEnv };
  // ⛔⭐⭐ **호출자가 «지운» 키는 캡처본에서도 지운다**(09-26 실측 · agent-mission codex 401).
  //   호출자 env 에서 키를 빼는 것만으로는 부족하다 — 위 합성이 로그인 셸 캡처본을 «먼저» 깔기 때문에
  //   지운 키가 캡처본에서 되살아난다(`OPENAI_API_KEY` 가 구독 전용 스크럽을 뚫고 자식에 닿았다 = 과금 경로 누출).
  //   ⇒ 지울 키는 «이름으로» 받아 합성 «뒤»에 적용한다. 호출자가 같은 키를 «명시»했으면 그 값이 이긴다.
  const unsetApplied: string[] = [];
  for (const key of opts.unset ?? []) {
    if (Object.hasOwn(callerEnv, key) || !Object.hasOwn(result, key)) continue;
    delete result[key];
    unsetApplied.push(key);
  }
  const stateDirSource: 'env' | 'fallback' | 'absent' = !result.ELANOUS_STATE_DIR
    ? 'absent'
    : fallbackStateDir === result.ELANOUS_STATE_DIR && !Object.hasOwn(callerEnv, 'ELANOUS_STATE_DIR')
      ? 'fallback'
      : 'env';
  // 관측(제1원칙 · 설계 §11 N2): 정적 ratchet 은 "새 spawn 사이트가 헬퍼를 안 거치는 것"을 잡고,
  // 이 런타임 관측은 "무엇이 실제로 전파/차단됐나"를 잡는다. 둘 다 필요하다.
  // ★ 키 이름만 남긴다 — 값은 절대 금지(자격증명 유출 방지).
  try {
    debug.log('instance.identity', 'pty-env-propagated', {
      propagated: Object.keys(identity),
      stateDirSource,
      blocked: blockedIdentityEnvCount(env),
      captureOk: capturedEnvAvailable(),
      unsetApplied,
    });
  } catch { /* 관측 실패가 spawn 을 막지 않는다 */ }
  return result;
}
