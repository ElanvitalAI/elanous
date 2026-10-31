// ── 스트림 컴포지터 — 스트리밍 모드 + progress 렌더 (C5-enh · 2026-07-16) ──────────────
//
// 설계 §6-8·§5.2·§10-1. openclaw `off|progress|partial|block` 스트리밍 모드 + 🧠추론/💬커멘터리/
// ⚙️툴 컴포지터를 channel-agnostic 순수 함수로 추출. telegram/discord sink 가 공유(라이브핸들 상태 →
// 렌더 텍스트). finalize collapse 는 각 sink 가(모드 무관·항상 full text).
//
// 모드 시맨틱:
//  - off      : 스트리밍 프리뷰 없음(중간 편집 억제) — finalize 만. 저소음/고비용회피.
//  - progress : compact 상태 뷰 — 🧠 추론 헤더 + ⚙️ 툴 라인 + 💬 최신 텍스트 tail(커멘터리). 답변
//               본문을 다 흘리지 않고 "진행 상황"을 보여줌(가장 풍부한 표면·기본값).
//  - partial  : 답변 텍스트 델타를 그대로 흘림 + ⚙️ 툴 tail(현 C5b/c 행동·full stream).
//  - block    : partial 과 동일 렌더이되 **블록 경계(빈 줄)에서만** 편집(flicker 감소·sink 가 cadence).
//
// 순수 로직 — I/O 없음. sink 가 CompositorState 를 누적하고 이 모듈이 텍스트를 낸다.

export type StreamingMode = 'off' | 'progress' | 'partial' | 'block';

export function isStreamingMode(v: unknown): v is StreamingMode {
  return v === 'off' || v === 'progress' || v === 'partial' || v === 'block';
}

/** 툴 활동 1줄 — call 시 push, result 시 done. */
export interface ToolLine {
  id: string;
  name: string;
  done: boolean;
  ok?: boolean;
}

/** 컴포지터 누적 상태 — sink 라이브핸들이 소유. onChunk 이 갱신, 렌더가 소비. */
export interface CompositorState {
  /** 누적 답변 텍스트(assistant delta). */
  text: string;
  /** 최신 🧠 추론(모드 gated·progress 에서만 표기). */
  reasoning: string;
  /** ⚙️ 툴 활동(순서 보존). */
  toolLines: ToolLine[];
  /** id → toolLines 인덱스(result 매칭). */
  toolIndex: Map<string, number>;
}

export function createCompositorState(): CompositorState {
  return { text: '', reasoning: '', toolLines: [], toolIndex: new Map() };
}

/** 청크 이벤트를 상태에 반영(순수·in-place). delta/reasoning/tool 을 흡수. */
export function applyChunk(
  state: CompositorState,
  ev: { delta?: string; textOperation?: 'replace'; reasoning?: string; tool?: { id: string; name: string; phase: 'call' | 'result'; ok?: boolean } },
): void {
  if (ev.textOperation === 'replace') state.text = ev.delta ?? '';
  else if (ev.delta) state.text += ev.delta;
  if (ev.reasoning) state.reasoning = ev.reasoning; // keep-latest(추론은 누적 아닌 최신 요약)
  if (ev.tool) {
    if (ev.tool.phase === 'call') {
      if (!state.toolIndex.has(ev.tool.id)) {
        state.toolIndex.set(ev.tool.id, state.toolLines.length);
        state.toolLines.push({ id: ev.tool.id, name: ev.tool.name, done: false });
      }
    } else {
      const i = state.toolIndex.get(ev.tool.id);
      if (i != null && state.toolLines[i]) {
        state.toolLines[i]!.done = true;
        if (ev.tool.ok != null) state.toolLines[i]!.ok = ev.tool.ok;
      }
    }
  }
}

export interface ComposeOpts {
  /** ⚙️ 툴 tail 최대 줄. 기본 6. */
  maxToolLines?: number;
  /** progress 💬 커멘터리 tail 최대 글자. 기본 280. */
  commentaryChars?: number;
  /** progress 🧠 추론 헤더 최대 글자. 기본 200. */
  reasoningChars?: number;
}

function toolLineText(t: ToolLine): string {
  if (!t.done) return `⚙️ ${t.name} …`;
  return `⚙️ ${t.name} ${t.ok === false ? '✗' : '✓'}`;
}

/** 뒤에서 maxChars 글자를 취하되 줄 경계를 존중(중간 줄 잘림 최소화). */
function tailByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(text.length - maxChars);
  const nl = slice.indexOf('\n');
  return nl >= 0 && nl < slice.length - 1 ? `…${slice.slice(nl + 1)}` : `…${slice}`;
}

/**
 * 라이브 프리뷰 텍스트 렌더. 모드별 분기. null 반환 = 편집 억제(off·빈 상태).
 * finalize 는 이 함수를 쓰지 않는다(항상 full text collapse).
 */
export function composeStream(state: CompositorState, mode: StreamingMode, opts: ComposeOpts = {}): string | null {
  if (mode === 'off') return null;
  const maxToolLines = opts.maxToolLines ?? 6;
  const tail = state.toolLines.length
    ? state.toolLines.slice(-maxToolLines).map(toolLineText).join('\n')
    : '';

  if (mode === 'partial' || mode === 'block') {
    // full stream — 답변 본문 + ⚙️ 툴 tail(현 C5b/c inline 행동).
    if (!state.text && !tail) return null;
    return tail ? (state.text ? `${state.text}\n\n${tail}` : tail) : state.text;
  }

  // progress — compact 상태: 🧠 추론 헤더 + ⚙️ 툴 라인 + 💬 최신 텍스트 tail.
  const parts: string[] = [];
  if (state.reasoning) parts.push(`🧠 ${tailByChars(state.reasoning.trim(), opts.reasoningChars ?? 200)}`);
  if (tail) parts.push(tail);
  if (state.text.trim()) parts.push(`💬 ${tailByChars(state.text.trim(), opts.commentaryChars ?? 280)}`);
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

/** block 모드 cadence — 새 블록 경계(빈 줄)를 지났는지. sink 가 편집 트리거 판정에 사용. */
export function crossedBlockBoundary(prevText: string, nextText: string): boolean {
  const prevBlocks = prevText.split(/\n\s*\n/).length;
  const nextBlocks = nextText.split(/\n\s*\n/).length;
  return nextBlocks > prevBlocks;
}
