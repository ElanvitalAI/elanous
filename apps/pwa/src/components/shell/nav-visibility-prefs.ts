// 메뉴 노출 설정(보는 사람 기기별) — 설정 화면이 쓰고 사이드바가 읽는다.
// ⛔ localStorage 는 막혀 있을 수 있다(사생활 창·차단) — 읽기·쓰기 모두 실패를 삼키고 «꺼짐»으로 본다.

export const NAV_PREFS_EVENT = 'elanous:nav-prefs';

export function readFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch { /* 저장이 막혀도 화면은 이번 창에서만 바뀐다 */ }
  try { window.dispatchEvent(new Event(NAV_PREFS_EVENT)); } catch { /* SSR */ }
}
