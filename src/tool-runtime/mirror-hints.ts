import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── VW-term-infra Bundle B-1 · B1-3 — mirror hint metadata ──
//
// Phase 5 "user chord ↔ LLM tool" symmetry 의 첫 단계 — **metadata
// only** wrapping of `LLMToolSpec` 으로 tool 이 자기 대응 chord 를
// selfdescribe. CI guard + 양방향 registry 는 Bundle B-2 이후 (대상
// tool 이 쌓이면).
//
// API shape:
//   withChordHint(buildSetFocusPolicyTool(), '^B p')
//     → LLMToolSpec + 내부 `_chordHint: '^B p'` 필드
//   getChordHint(spec)
//     → '^B p' or undefined
//
// 단방향 metadata · symmetry registry 는 나중 · 지금은 LLM 응답에
// "이 tool 사용시 user 는 ^B p 로도 부를 수 있음" 힌트 공급만.



/** Marker field added to LLMToolSpec when a chord hint is attached.
 *  Underscore prefix · type widening avoids clashing with user-supplied
 *  spec keys. */
export interface ChordHintMarker {
  readonly _chordHint?: string;
}

export type LLMToolSpecWithMirror = LLMToolSpec & ChordHintMarker;

/** Attach a chord hint to an LLM tool spec. Returns a shallow-copy
 *  with the hint; original spec is untouched so multiple hint
 *  decorations compose predictably. */
export function withChordHint<T extends LLMToolSpec>(
  spec: T,
  chord: string,
): T & ChordHintMarker {
  if (!chord || chord.length === 0) return spec;
  return { ...spec, _chordHint: chord };
}

/** Read the chord hint off an LLM tool spec. Returns undefined when
 *  the spec wasn't decorated. */
export function getChordHint(spec: LLMToolSpec): string | undefined {
  const s = spec as LLMToolSpec & Partial<ChordHintMarker>;
  return typeof s._chordHint === 'string' && s._chordHint.length > 0
    ? s._chordHint : undefined;
}

/** Copy chord hint from one spec onto another. Useful when a tool
 *  rebuilds its spec (e.g. registry-level shape massage) and wants
 *  the hint preserved without repeating the literal string. */
export function copyChordHint<T extends LLMToolSpec>(
  from: LLMToolSpec,
  to: T,
): T & ChordHintMarker {
  const h = getChordHint(from);
  return h ? withChordHint(to, h) : to;
}
