// 물리(BT) 키보드 감지 — 웹터미널 보조 키 줄 숨김 (TERM4 · 대표 2026-10-02 11:5x 폴드8
// «키보드 인식이 안 돼서 ESC·TAB 키 가이드까지 나왔다»)
//
// 화상 키보드가 «보낼 수 없는» 키가 한 번이라도 오면 물리 키보드로 본다:
//   - Esc · Tab · 화살표 · F1~F12 · Ctrl/⌘/Alt 조합 — iOS·안드로이드 화상 키보드에 없다.
//   - 안드로이드에서는 글자 키도 증거다 — 안드로이드 화상 키보드는 keyCode 229(조합 중)로 보낸다.
//     iOS 화상 키보드는 글자 키를 실제 값으로 보내므로 iOS 에서는 글자 키를 증거로 쓰지 않는다.

export const HW_KEYBOARD_KEY = 'elanous.pwa.hwKeyboard';

type KeyLike = Pick<KeyboardEvent, 'key' | 'keyCode' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const SOFT_KEYBOARD_ABSENT = /^(Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F([1-9]|1[0-2]))$/;

export function isHardwareKeyEvidence(e: KeyLike, userAgent: string): boolean {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process') return false;
  if (SOFT_KEYBOARD_ABSENT.test(e.key)) return true;
  if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) return true;
  if (/Android/i.test(userAgent) && e.key.length === 1) return true;
  return false;
}

export function readHardwareKeyboard(storage: StorageLike | null | undefined): boolean {
  try { return storage?.getItem(HW_KEYBOARD_KEY) === '1'; } catch { return false; }
}

export function writeHardwareKeyboard(storage: StorageLike | null | undefined, present: boolean): void {
  try { storage?.setItem(HW_KEYBOARD_KEY, present ? '1' : '0'); } catch { /* 기억 못 해도 지금 화면은 그대로 */ }
}
