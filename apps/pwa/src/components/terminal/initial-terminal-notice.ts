// 초기 터미널 이름 발급 상태 → 사람이 읽는 문면. (대표 2026-08-18 지시)
//
// ⛔ 왜 컴포넌트 밖인가 — 화면 문면을 렌더 «안»에 두면 실패 경로를 태우려면 브라우저 effect 를
//    돌려야 하고, SSR 계약 테스트로는 원리상 못 잡는다(무인 리뷰 must-fix 2026-08-18 `#10105`).
//    ⇒ 같은 파일의 `pty-terminal-list.ts` 가 이미 쓰는 형태다 — *"components only render this result"*.
//
// ⛔ 그리고 이 자리가 「침묵 금지」의 화면 쪽 절반이다. 발급이 로컬로 내려간 사실은 «사유와 함께»
//    사람에게 보여야 한다. 관측 쪽 절반은 `webterm.tabs.initial`(TerminalTabs) 이 갖는다.

import type { InitialTerminalState } from './TerminalTabs';

/** ⛔ export 하지 않는다 — 이 타입의 «소비자»는 같은 파일의 함수뿐이다(전수 0).
 *  ⚠️ 그리고 export 하면 tsc 게이트가 「기존 타입에 필수 필드 추가」로 읽어 저장소 전체 검사로
 *  승격하고, 무관한 기존 부채 52건으로 FAIL 한다(2026-08-18 실측). 새 타입엔 깨질 호출자가 «없다».
 *  📌 그 게이트 오탐은 별건으로 등재한다 — 여기서 우회하는 게 아니라 이 타입이 실제로 내부용이다. */
interface InitialTerminalNotice {
  /** 이름을 기다리는 중이라 터미널을 아직 안 그린다. */
  placeholder: string | null;
  /** 데몬 발급을 못 받고 로컬 이름으로 내려갔을 때만 뜨는 경고. 그 외엔 null. */
  fallbackBanner: string | null;
}

/** ⛔ `restored-tab` 은 «폴백이 아니다» — 저장된 탭을 그대로 쓴 정상 경로라 경고를 띄우지 않는다. */
export function initialTerminalNotice(
  state: InitialTerminalState,
  hasTerminalId: boolean,
): InitialTerminalNotice {
  const localFallback = state.status === 'ready'
    && state.issuedBy === 'local'
    && state.fallbackReason !== 'restored-tab';
  // ⛔ 사유가 «없으면» 사유를 지어내지 않는다 — `daemon-unavailable` 은 확인 안 한 단정이었다
  //    (무인 리뷰 must-fix `UNKNOWN-DEFAULT OUTPUT ASSERTION` · 2026-08-18 `#10105`).
  //    ⇒ 「모른다」를 «값으로» 보존한다. 「모름」과 「특정 사유」는 다른 칸이다.
  const reason = state.status === 'ready' && state.fallbackReason ? state.fallbackReason : '사유 미상';
  return {
    placeholder: hasTerminalId
      ? null
      : state.status === 'pending'
        ? (state.slow ? '데몬이 느립니다 — 터미널을 만드는 중… (기다리는 중)' : '터미널 이름을 준비하는 중…')
        : `터미널 이름을 로컬에서 정했습니다 (${reason}).`,
    fallbackBanner: localFallback
      ? `터미널 이름을 로컬에서 정했습니다 (${reason}). 데몬 발급을 확인하지 못했습니다.`
      : null,
  };
}
