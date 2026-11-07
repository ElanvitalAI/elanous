// ── 인스턴스 정체성 — 격리 상태 루트(ELANOUS_STATE_DIR) → 표시 이름 (2026-07-16) ──
//
// LF7(통합 로그 패브릭)이 "쓰기는 물리 격리·읽기는 read-only 연합" 을 세우며 로그 행에
// `instance` 컬럼(prod · test:<repo>)을 스탬프했다. 세션 저장소도 같은 격리 경계
// (ELANOUS_STATE_DIR) 위에 있으므로 **동일한 인스턴스명 유도**를 공유한다 — 로그와 세션이
// 같은 인스턴스를 같은 이름으로 부른다(연합 뷰 정합·제1원칙 자기인지).
//
// ⚠️ 인스턴스 정체성 = **리졸브된 state 루트**이지 raw env 가 아니다 (2026-07-27 정정).
//   - 운영 루트(`~/.elanous`) → 'prod' (글로벌 데몬·크론 등 모두 같은 인스턴스)
//   - `<repo>/.elanous-test` → `test:<repo>`
//   - 그 외 루트(예: ~/.elanous/telegram-test) → `test:<dir 이름>`
//
// 이름 유도(우선순위): setInstanceName() 오버라이드 → effectiveInstanceRoot() → env 폴백.
// 오버라이드는 데몬/러너 부팅이 config(logs.instanceName)에서 1회 주입(user-config 순환
// 의존 회피 — 본 모듈은 config 를 읽지 않는다).
//
// ⚠️ 왜 env 가 아니라 리졸버인가 — 실측된 마스킹 사건(2026-07-27):
//   3층(트리 파생 test) 스위치를 켠 뒤, 이름은 env 로·경로는 리졸버로 갈라져 **한 프로세스가
//   test 스토어에 쓰면서 자기를 'prod' 라 스탬프**했다. 결과가 둘이었다 —
//     ① `elanous logs` 기본 연합(P5)에서 내 우주와 운영이 **둘 다 `⟨prod⟩`** 로 찍혀 출처 구분 불가.
//        태그의 존재 이유(어느 우주의 로그인가)가 통째로 무력화됐다.
//     ② 행의 `instance` 컬럼이 거짓 — 격리 스토어의 행이 운영 것으로 박제됐다.
//   근본은 "정체성의 축이 둘"이라는 것이었다. `logsDbPath()`(→`elanousStateRoot()`)가 이미
//   리졸버를 타므로, **이름도 같은 리졸버를 타야** 경로와 이름이 영원히 같은 우주를 가리킨다.
//   env(2층)는 리졸버 안에 이미 층으로 들어있어 종전 동작(명시 stateDir)은 그대로 보존된다.

import { basename, dirname } from 'node:path';
import { logDiagnostic } from './mss/logging/diagnostic-sink.js';

let instanceNameOverride: string | undefined;
/** 리졸버 폴백 관측을 프로세스당 1회로 묶는 래치(핫패스 소음·자기재귀 방지). */
let fallbackObserved = false;
/** 로그 1행마다 도는 이름 유도의 메모 — 리졸브된 루트가 그대로면 재계산 생략. */
let nameMemo: { root: string; name: string } | undefined;

/** 데몬/러너 부팅 1회 — config 의 instanceName 을 주입. 빈 문자열 무시. */
export function setInstanceName(name: string | undefined): void {
  const trimmed = name?.trim();
  instanceNameOverride = trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** ⛔⭐⭐ 이름 문자 집합(영숫자·하이픈)으로 **단사** 인코딩한다. 손실 치환(`[^A-Za-z0-9-]` → `-`)은
 *  `elanous-drive-A_B` 와 `elanous-drive-A-B` 를 **같은 이름으로 충돌**시켜, 가르려던 목적 자체를
 *  무너뜨린다(무인 리뷰 must-fix · 2026-08-02).
 *  ⇒ 두 갈래로 나눈다:
 *     ⓐ 이미 안전하고 `-` 로 시작하지 않으면 **그대로**(흔한 경우 · `elanous-drive-PGfXzo`).
 *     ⓑ 아니면 선행 `-` 를 붙이고 이스케이프(`-`→`--` · 그 밖은 `-`+**6자리** hex).
 *  ⚠️ 폭은 6이다 — 4자리면 비-BMP 에서 단사가 깨진다(`U+10000` 과 `U+1000` 뒤의 `0` 이 둘 다
 *     `-10000`). 코드포인트 최대가 `0x10FFFF` 라 6자리면 **고정폭**이 보장된다(무인 리뷰 must-fix).
 *     ⓐ 의 출력은 결코 `-` 로 시작하지 않고 ⓑ 는 항상 그러므로 두 갈래가 안 겹친다 ⇒ **단사**. */
export function encodeInstanceNameSegment(raw: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(raw)) return raw;
  let out = '-';
  for (const ch of raw) {
    if (/[A-Za-z0-9]/.test(ch)) { out += ch; continue; }
    if (ch === '-') { out += '--'; continue; }
    out += `-${ch.codePointAt(0)!.toString(16).padStart(6, '0')}`;
  }
  return out;
}

/** 명시 stateDir → 인스턴스 이름(순수). `<repo>/.elanous-test` → `test:<repo>`. */
export function instanceNameForStateDir(stateDir: string): string {
  const base = basename(stateDir);
  if (base === '.elanous-test') return `test:${basename(dirname(stateDir))}`;
  // ⛔ 일회용 자식 뿌리는 관례상 `/elanous-drive-*/state` 로 끝난다. 그 basename 을 쓰면
  //    **그런 스토어가 전부 `test:state` 하나로 접힌다**(2026-08-02 실측 — 70개 넘음).
  //    ⇒ 변별력 없는 basename 이면 부모 디렉토리 이름으로 가른다.
  const parentBase = basename(dirname(stateDir));
  const discriminatingBase = base === 'state' && parentBase.startsWith('elanous-drive-')
    ? encodeInstanceNameSegment(parentBase)
    : base;
  return `test:${discriminatingBase}`;
}

/** 리졸브된 state 루트 → 인스턴스 이름(순수). 운영 루트면 'prod'.
 *  ⓘ 모듈 내부 전용 — 외부 소비처가 0 이라 공개 표면으로 두지 않는다(리뷰 should-fix). */
function instanceNameForRoot(root: string, prodRoot: string): string {
  return root === prodRoot ? 'prod' : instanceNameForStateDir(root);
}

/** 현재 프로세스의 인스턴스 이름 — 로그·세션 공용 출처 스탬프.
 *
 *  ⚠️ 로그 1행마다 불린다(핫패스). 여기서 관측을 남기면 자기 자신을 무한히 부르므로
 *     **debug.log 를 넣지 마라** — 등록/스킵 같은 콜드패스에서 남긴다. */
export function resolveInstanceName(): string {
  if (instanceNameOverride) return instanceNameOverride;
  // 경로와 같은 리졸버를 탄다(정체성 축 일원화). 리졸버는 명시 --config-dir(1층) →
  // ELANOUS_STATE_DIR(2층) → 트리 파생(3층) → 운영(4층) 순으로 이미 층을 갖고 있다.
  try {
    const { effectiveInstanceRoot, prodInstanceRoot } =
      require('./instance/resolve.js') as typeof import('./instance/resolve.js');
    const root = effectiveInstanceRoot();
    // 핫패스 가드(리뷰 should-fix) — 리졸버 자신은 트리 탐색(fs walk)을 memoRoot 로 이미
    // 메모하지만, 운영 루트 계산(homedir+normalize)은 매번이었다. 루트가 안 바뀌면 이름을
    // 그대로 돌려준다. 루트 값 자체를 키로 쓰므로 스위치/오버라이드 변화는 자동 반영.
    if (nameMemo && nameMemo.root === root) return nameMemo.name;
    const name = instanceNameForRoot(root, prodInstanceRoot());   // 운영 루트는 리졸버 SSOT
    nameMemo = { root, name };
    return name;
  } catch (e) {
    // 리졸버 미가용(부팅 초기·순환 등) — 종전 env 유도로 폴백. 이름이 없어서 죽지는 않는다.
    //
    // ⚠️ 이 폴백은 **경로·이름 분리를 되살리는 자리**다(리뷰 지적). 조용히 넘기면 이 트랙이
    //   고친 마스킹이 그대로 재발하고도 아무도 모른다. 그렇다고 핫패스에서 매 행 관측을
    //   남기면 로그가 자기를 무한히 부르므로, **프로세스당 1회만** 남긴다.
    if (!fallbackObserved) {
      fallbackObserved = true;
      try {
        logDiagnostic('instance.identity', 'name-resolver-failed', {
          error: e instanceof Error ? e.message : String(e),
          envStateDir: process.env.ELANOUS_STATE_DIR?.trim() ?? null,
          why: '리졸버 실패 — env 유도로 폴백. 경로(리졸버)와 이름(env)이 갈릴 수 있으니 조사 필요',
        }, { level: 'warn' });
      } catch { /* 관측조차 불가한 부팅 초기 — 이름 유도는 계속한다 */ }
    }
    const stateDir = process.env.ELANOUS_STATE_DIR?.trim();
    return stateDir ? instanceNameForStateDir(stateDir) : 'prod';
  }
}
