// ── 긴 붙여넣기 자리표시 `paste-fold` (TUI-PASTE-ECHO · 0.2.36 · 2026-10-22 · 대표 P0 «classic·next 둘 다») ──────
//
// 🚨 무엇을 푸는가: 여러 줄을 붙여넣으면 입력창이 그 줄 수만큼 펼쳐져 화면을 덮거나(classic) 끝 몇 줄만
//   «↵» 로 이어 보인다(next) — 무엇이 몇 줄 들어갔는지 한눈에 안 보인다(10-22 설치본 재현).
// ⭐ 긴 붙여넣기는 입력창에 «[붙여넣음 #k · N줄 · M자]» 토큰 한 덩어리로 넣고 원문은 여기 쥔다.
//   제출할 때 토큰을 원문으로 되돌린다 — 모델이 받는 글은 붙여넣은 글 전부다. 짧은 글은 그대로 넣는다.
// ⛔ 토큰을 지우면 그 붙여넣기도 빠진다(사람이 지운 것) · 토큰 글자를 손으로 고치면 원문 대신 그 글이 간다.
//
// 세 얼굴:
//   관측 = debug.log('tui.paste', 'folded', { id, lines, chars }) · 'expanded' { count, chars }
//   인지 = 줄 수 ≥ PASTE_FOLD_MIN_LINES 또는 글자 ≥ PASTE_FOLD_MIN_CHARS
//   힐링 = 자리표시로 보이고 제출 때 원문 전체 · 실패 없음(접지 않으면 원문 그대로)

import { debug } from '../debug/log.js';

export const PASTE_FOLD_MIN_LINES = 4;
export const PASTE_FOLD_MIN_CHARS = 800;

export interface PasteFold {
  /** 붙여넣은 글 — 길면 자리표시 토큰, 짧으면 그대로. */
  fold(text: string): string;
  /** 제출 글 — 남아 있는 토큰을 원문으로 되돌린다. */
  expand(text: string): string;
  /** 쥐고 있는 붙여넣기 수. */
  size(): number;
  /** 아직 살아 있는 글(입력칸·대기열)에 없는 토큰의 원문을 놓는다 — 지운 붙여넣기 회수. 놓은 수. */
  retainOnly(liveTexts: readonly string[]): number;
  /** 다른 입력칸(턴 중 typeahead)이 접은 토큰·원문 짝을 넘겨받는다 — 넘김 뒤에도 토큰으로 보이고 제출 때 펴진다. */
  adopt(pairs: ReadonlyArray<readonly [token: string, raw: string]>): void;
}

export function pasteFoldToken(id: number, text: string): string {
  const lines = text.split('\n').length;
  return `[붙여넣음 #${id} · ${lines}줄 · ${text.length}자]`;
}

export function shouldFoldPaste(text: string): boolean {
  return text.split('\n').length >= PASTE_FOLD_MIN_LINES || text.length >= PASTE_FOLD_MIN_CHARS;
}

export function createPasteFold(log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d)): PasteFold {
  const held = new Map<string, string>();
  let seq = 0;
  return {
    fold(text) {
      // 표시(줄 수·글자 수)만 정규화한다 — 끝 줄바꿈 하나는 터미널이 붙이는 것 · CRLF 는 한 줄바꿈.
      //   쥐는 것·제출하는 것은 붙여넣은 원문 그대로다(r1 must-fix).
      const shown = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
      if (!shouldFoldPaste(shown)) return text;
      const token = pasteFoldToken(++seq, shown);
      held.set(token, text);
      log('tui.paste', 'folded', { id: seq, lines: shown.split('\n').length, chars: shown.length });
      return token;
    },
    expand(text) {
      if (held.size === 0) return text;
      // 한 번에 훑는다 — 펼친 원문 안에 다른 토큰 글이 있어도 다시 치환하지 않는다(지운 붙여넣기가 되살아나지 않게 · r3 must-fix).
      const tokens = [...held.keys()].filter((t) => text.includes(t));
      if (tokens.length === 0) return text;
      const re = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      const used = new Set<string>();
      const out = text.replace(re, (m) => { used.add(m); return held.get(m) ?? m; });
      for (const t of used) held.delete(t);
      log('tui.paste', 'expanded', { count: used.size, chars: out.length });
      return out;
    },
    retainOnly(liveTexts) {
      // 입력칸·대기열 어디에도 없는 토큰(사람이 지운 것)의 원문을 놓는다 — 메모리 누적·나중에 같은 글을 쳤을 때 되살아남 방지(r3 must-fix).
      let dropped = 0;
      for (const token of [...held.keys()]) {
        if (!liveTexts.some((t) => t.includes(token))) { held.delete(token); dropped++; }
      }
      if (dropped > 0) log('tui.paste', 'dropped', { count: dropped, held: held.size });
      return dropped;
    },
    adopt(pairs) {
      for (const [token, raw] of pairs) {
        held.set(token, raw);
        const id = Number(/^\[붙여넣음 #(\d+) /.exec(token)?.[1] ?? 0);
        if (id > seq) seq = id;
      }
      if (pairs.length > 0) log('tui.paste', 'adopted', { count: pairs.length, held: held.size });
    },
    size: () => held.size,
  };
}
