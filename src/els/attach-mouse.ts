/** ELS-MOUSE (OP #100984): SGR 1006 마우스 — 파서와 화면 영역 해석(순수 함수). */

import type { KeyEvent } from './attach-keys.js';

/** SGR 1006 리포트: ESC [ < button ; x ; y (M|m) */
export interface MouseReport {
  readonly button: number;   // 0=좌 1=중 2=우 · |32 드래그 · |64 휠
  readonly x: number;        // 1 기반 열
  readonly y: number;        // 1 기준 행
  readonly release: boolean; // 'm' = release
  readonly bytes: string;    // 원본 시퀀스(통과용)
}

export type MouseSegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mouse'; readonly report: MouseReport };

const SGR_MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
const SGR_MOUSE_TAIL = /\u001b\[<[0-9;]*[Mm]?$/;

/** 스트림을 텍스트 세그먼트와 마우스 이벤트로 나눈다. 불완전한 SGR 꼬리는 보관해 다음 feed에 이어진다. */
export function splitMouse(text: string): { segments: readonly MouseSegment[]; pending: string } {
  const segments: MouseSegment[] = [];
  let at = 0;
  SGR_MOUSE.lastIndex = 0;
  for (let match = SGR_MOUSE.exec(text); match !== null; match = SGR_MOUSE.exec(text)) {
    if (match.index > at) segments.push({ kind: 'text', text: text.slice(at, match.index) });
    segments.push({ kind: 'mouse', report: { button: Number(match[1]), x: Number(match[2]), y: Number(match[3]), release: match[4] === 'm', bytes: match[0] } });
    at = match.index + match[0].length;
  }
  const rest = text.slice(at);
  const tail = SGR_MOUSE_TAIL.exec(rest);
  if (tail) {
    if (tail.index > 0) segments.push({ kind: 'text', text: rest.slice(0, tail.index) });
    return { segments, pending: tail[0] };
  }
  if (rest) segments.push({ kind: 'text', text: rest });
  return { segments, pending: '' };
}

/** 마우스 해석용 화면 배치: 사이드바 항목(행→첫 pane)·탭 범위·화면 크기. */
export interface MouseLayout {
  readonly cols: number;
  readonly rows: number;              // 화면 전체 행(1 기반; 마지막 행은 상태줄)
  readonly sidebarWidth: number;      // 0 = 사이드바 닫힘
  readonly sidebar: readonly { readonly y: number; readonly ws: string; readonly pane: string }[]; // y = 화면 행(1 기반)
  readonly sidebarNew?: { readonly y: number; readonly from: number; readonly to: number }; // ELS-SIDEBAR-HERDR-CLEAN: the word «new» in the list's last line (열 0 기반)
  readonly tabs: readonly { readonly from: number; readonly to: number; readonly pane: string }[]; // 탭 중앙 오프셋(0 기반)
  readonly plus?: { readonly from: number; readonly to: number }; // ELS-NEW-TAB-NAME-WIDGET: «+» 칸(중앙 0 기반)
}

export type MouseAction =
  | { readonly kind: 'select'; readonly pane: string }
  | { readonly kind: 'new-tab' } // «+» 클릭: 새 탭 이름 입력줄을 연다
  | { readonly kind: 'scroll'; readonly lines: number } // 양수 = 과거로
  | { readonly kind: 'passthrough'; readonly bytes: string };

const WHEEL_UP = 64, WHEEL_DOWN = 65;

/** 리포트를 화면 배치로 해석: 사이드바/탭 클릭은 선택, 휠은 스크롤백, 나머지는 pane 프로그램 통과. */
export function interpretMouse(report: MouseReport, layout: MouseLayout): MouseAction | null {
  const { x, y } = report;
  if (report.release || y >= layout.rows || x < 1 || x > layout.cols) return null;
  const wheel = report.button & 0x40;
  if (wheel) {
    const lines = report.button === WHEEL_UP ? 3 : report.button === WHEEL_DOWN ? -3 : 0;
    return lines !== 0 ? { kind: 'scroll', lines } : null;
  }
  if (layout.sidebarWidth > 0 && x <= layout.sidebarWidth) {
    const box = layout.sidebarNew;
    if (box && y === box.y && x - 1 >= box.from && x - 1 < box.to) return { kind: 'new-tab' };
    const hit = layout.sidebar.find((item) => item.y === y);
    return hit ? { kind: 'select', pane: hit.pane } : null;
  }
  const left = layout.sidebarWidth > 0 ? layout.sidebarWidth + 1 : 0; // 사이드바 칸 + 구분선
  if (y === 1 && layout.tabs.length > 0) {
    const col = x - left - 1; // 탭 범위는 중앙 0 기준
    const tab = layout.tabs.find((t) => col >= t.from && col < t.to);
    if (layout.plus && col >= layout.plus.from && col < layout.plus.to) return { kind: 'new-tab' };
    return tab ? { kind: 'select', pane: tab.pane } : { kind: 'passthrough', bytes: report.bytes };
  }
  return { kind: 'passthrough', bytes: report.bytes };
}

/** keys 라우터용: 마우스 리포트를 MouseEvent KeyEvent로 감싼다. */
export function mouseEvent(report: MouseReport): KeyEvent {
  return { kind: 'mouse', report };
}

/** ELS-WHEEL-HISTORY (herdr encode_mouse_wheel · encode_alternate_scroll): the bytes a wheel notch becomes for a pane that
 *  takes it itself. `x`/`y` are 1-based PANE coordinates (the els chrome to the left and above already taken off).
 *  `mouse-sgr` → SGR 1006 report · `mouse-x10` → legacy `ESC [ M` report · `arrows` → three ↑/↓ (alternate scroll).
 *  null for `host` (the els scrollback takes it) or a button that is not a wheel notch. */
export function wheelBytes(route: 'mouse-sgr' | 'mouse-x10' | 'arrows' | 'host', button: number, x: number, y: number): string | null {
  if (button !== WHEEL_UP && button !== WHEEL_DOWN) return null;
  const px = Math.max(1, x), py = Math.max(1, y);
  if (route === 'mouse-sgr') return `\u001b[<${button};${px};${py}M`;
  if (route === 'mouse-x10') return px > 223 || py > 223 ? null : `\u001b[M${String.fromCharCode(32 + button, 32 + px, 32 + py)}`;
  if (route === 'arrows') return (button === WHEEL_UP ? '\u001b[A' : '\u001b[B').repeat(3);
  return null;
}

/** ELS-WHEEL-HISTORY (single-pane view · `els side attach <pane>`): the view now asks the terminal for SGR mouse reports, so
 *  every report is decided here and never reaches the pane raw. The pane sits at the top-left (same coordinates), the
 *  status line is the last row. A wheel follows the frame's route (the pane's own mouse report · ↑/↓ · els scrollback);
 *  other reports go to the pane only while it tracks its own mouse (a shell would print them as junk). A report split
 *  across two reads is held until its tail arrives. */
export function createPaneViewMouse(): { feed: (text: string, route: 'mouse-sgr' | 'mouse-x10' | 'arrows' | 'host', rows: number) => { send: string; scroll: number } } {
  let pending = '';
  return {
    feed(text, route, rows) {
      const split = splitMouse(pending + text);
      pending = split.pending;
      let send = '';
      let scroll = 0;
      for (const segment of split.segments) {
        if (segment.kind === 'text') { send += segment.text; continue; }
        const report = segment.report;
        if (report.y >= rows) continue;                                  // the status line takes no pointer
        if ((report.button & 0x40) !== 0) {
          if (report.release) continue;
          const bytes = wheelBytes(route, report.button, report.x, report.y);
          if (bytes !== null) send += bytes;
          else if (route === 'host') scroll += report.button === WHEEL_UP ? 3 : report.button === WHEEL_DOWN ? -3 : 0;
          continue;
        }
        if (route === 'mouse-sgr') send += report.bytes;
      }
      return { send, scroll };
    },
  };
}
