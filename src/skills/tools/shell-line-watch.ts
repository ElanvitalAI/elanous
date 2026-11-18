// ── ELN-OP-SEAT-FEATURES ① (PR-1a): RunShell bg 라인 와처 — «긴 명령의 줄마다 턴에 사건 주입» ──
//
// 🚨 무엇을 푸는가: RunShell(mode='bg') 의 사건은 «완료» 하나뿐이었다(`enqueueShellCompletionNotice`).
//   긴 백그라운드 명령이 수십 줄을 뿜는 동안 부모 자리 LLM 은 중간 줄을 전혀 못 보고 쉬고 있었다
//   (MVP-B §3-1 ① — 유일 실제 갭).
// ⭐ 이 모듈이 그 갭을 줄 단위로 메운다: bg 셸 핸들의 출력 청크를 구독해 완결 줄로 쪼개고,
//   ⑴ `watchPattern`(정규식)에 걸리는 줄 «마다», ⑵ `watchMinLines`(임계 줄 수)에 도달하는 순간,
//   공용 TaskNotificationQueue 에 <task-notification>(taskId 앞칸 `shell-watch:`) 한 건을 넣는다.
//   큐의 onEnqueue 를 구독하는 agent-wake(src/dashboard/input/agent-wake.ts — 구독 «하나»)가
//   쉬는 자리 TUI 의 다음 턴을 열고(origin 'child-complete') 턴 preamble drain 이 알림을 실어 온다.
//   enqueue 재활용 — src/agent/task-notification.ts 는 손대지 않는다(추가 전용 · STEP0 §7).
//   관측 = debug.log('shell.line-watch', 'armed'|'hit'|'notice-cap-reached'|'stopped'|'unavailable')
//   침묵 = 비매치 줄은 큐 주입 0(시험 ②) · 정규식 오타는 즉시 throw · 꼬리줄(줄바꿈 없음)은 완료 시 flush
//   힐링 = 같은 패턴이 폭발적으로 반복돼도 notice 상한(20)에서 자동 정지.
//   매칭 창 = 앞 240 + 뒤 240 유한 창 «각각» 테스트(ReDoS 방어 ⊕ 매치 완전성 · 창 밖 중간은 문서화된 대가) — terra mustFix 1.
//   진행 계약 = 중간 알림은 진행(state 'running' · taskId `shell-watch:`) · 완료는 프로세스 종료 때 1회(state 'done' · taskId `shell:`) — JUD #38537 must ⓑ.
//   캡·독립·분리 = pending 상한(64k 코드포인트, 꼬리 유지) ① · match/lines 독립 발화 ② · 스트림별 pending 조립 ③ — JUD #38537 must ①②③.

import type { OutputChunk, ShellHandle } from '../../shell-runner/types.js';
import type { TaskNotificationQueue } from '../../agent/task-notification.js';
import { globalTaskNotificationQueue } from '../../agent/task-notification.js';
import { debug, redactSecretText } from '../../debug/log.js';

/** JS regex source → RegExp; throws a caller-friendly error on invalid input. */
export function compileShellLineWatchPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`RunShell watchPattern is not a valid regex: ${reason}`);
  }
}

export interface ShellLineWatchSpec {
  /** Regex source; each complete output line matching it fires one notice. */
  pattern?: string;
  /** Fire one notice when the complete-line count reaches this threshold. */
  minLines?: number;
}

/** Parse + validate the RunShell tool args. null when no watch is requested. */
export function shellLineWatchSpecFromArgs(raw: Record<string, unknown>): ShellLineWatchSpec | null {
  const pattern = typeof raw.watchPattern === 'string' && raw.watchPattern.trim().length > 0 ? raw.watchPattern : undefined;
  const minLinesRaw = raw.watchMinLines;
  const minLines = typeof minLinesRaw === 'number' && Number.isFinite(minLinesRaw) && minLinesRaw >= 1 ? Math.floor(minLinesRaw) : undefined;
  if (pattern === undefined && minLines === undefined) return null;
  if (pattern !== undefined) compileShellLineWatchPattern(pattern);
  return { ...(pattern !== undefined ? { pattern } : {}), ...(minLines !== undefined ? { minLines } : {}) };
}

export type ShellLineWatchHitKind = 'match' | 'lines';

export interface ShellLineWatchHit {
  kind: ShellLineWatchHitKind;
  /** 1-based index of the triggering line within the watched run. */
  lineIndex: number;
  /**
   * Triggering line — redacted, capped for the notice payload. A line over the cap carries
   * the front-240 window, or the tail-240 window when only the tail matched — terra mustFix 1:
   * 매칭은 앞·뒤 두 창 «모두» 에 돌고, payload 는 매치를 실은 창을 에코한다.
   */
  line: string;
  /**
   * true ⇔ the raw line exceeded SHELL_LINE_WATCH_LINE_CAP — payload 는 창(절두)이지 온줄이 아니다.
   * terra mustFix 2: consumeLine 이 원줄 길이를 hit 에 전파한다(죽은 필드·거짓 완결 금지).
   */
  truncated: boolean;
}

/** Pathological `yes`-style output must not flood the queue or wake a turn per line. */
export const SHELL_LINE_WATCH_MAX_NOTICES = 20;
/** Per-line echo cap inside the notification output (code points, not bytes). */
export const SHELL_LINE_WATCH_LINE_CAP = 240;
/**
 * JUD #38537 must ① — per-stream pending cap (code points). A process that emits
 * unbounded newline-free output must not grow pending without limit (memory
 * exhaustion / OOM). Policy (deterministic): when the newline-free residue of a
 * stream exceeds the cap, drop the overflow head and keep only the trailing CAP
 * code points. The dropped prefix can never re-form a complete line — it contains
 * no '\n' by construction (the cap is applied after line splitting).
 */
export const SHELL_LINE_WATCH_PENDING_CAP = 64_000;

/** Which stream a chunk belongs to — mirrors OutputChunk['stream'] (src/shell-runner/types.ts). */
export type ShellLineWatchStream = OutputChunk['stream'];

export interface LineWatchCore {
  /**
   * Append a chunk to the given stream's pending buffer. JUD #38537 must ③ —
   * stdout/stderr are assembled separately ('pty' is its own single stream: a PTY
   * mux is one line by design). Default 'pty' keeps the single-buffer semantics.
   */
  push(chunk: string, stream?: ShellLineWatchStream): void;
  /** Flush each stream's trailing line that arrived without a trailing newline. */
  flush(): void;
  stop(): void;
  lineCount(): number;
  /** Total buffered length across streams — observable pending-cap contract (JUD #38537 must ①). */
  pendingLength(): number;
}

/** Pure detection core — no I/O. Simulation tests drive this with fake chunks. */
export function createLineWatchCore(opts: { spec: ShellLineWatchSpec; onHit: (hit: ShellLineWatchHit) => void; maxNotices?: number }): LineWatchCore {
  const pattern = opts.spec.pattern !== undefined ? compileShellLineWatchPattern(opts.spec.pattern) : null;
  const maxNotices = opts.maxNotices ?? SHELL_LINE_WATCH_MAX_NOTICES;
  const pendings = new Map<ShellLineWatchStream, string>(); // JUD #38537 must ③ — 스트림별 pending 조립
  let completeLines = 0;
  let notices = 0;
  let stopped = false;
  const fire = (kind: ShellLineWatchHitKind, rawLine: string, truncated: boolean) => {
    if (stopped) return;
    if (notices >= maxNotices) {
      stopped = true;
      debug.log('shell.line-watch', 'notice-cap-reached', { maxNotices });
      return;
    }
    notices += 1;
    const safe = redactSecretText(rawLine);
    const chars = Array.from(safe);
    // payload 방어 캡은 유지(rawLine 은 창 ≤CAP 로 오지만, fire 는 색출 책임을 스스로도 진다) — terra mustFix 2 truncated 전파.
    const payload = chars.length > SHELL_LINE_WATCH_LINE_CAP ? chars.slice(0, SHELL_LINE_WATCH_LINE_CAP).join('') : safe;
    opts.onHit({ kind, lineIndex: completeLines, line: payload, truncated: truncated || chars.length > SHELL_LINE_WATCH_LINE_CAP });
  };
  const consumeLine = (rawLine: string) => {
    completeLines += 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // terra mustFix 1 — 매칭 창: 앞 240 + 뒤 240 «각각» 유한 창(pending 꼬리 유지와 같은 방식). 정규식 입력은 항상
    //   ≤240 코드포인트(ReDoS 방어 — JUD #38537 must ⓑ 유지)이면서, 긴 줄 «뒤쪽» 매치도 조용히 누락하지 않는다(매치 완전성).
    //   두 창을 이어붙여 테스트하지 않는다 — 창 경계를 가로지르는 가짜 매치를 만들지 않기 위해. 줄당 최대 1회 'match'.
    const chars = Array.from(line);
    const overCap = chars.length > SHELL_LINE_WATCH_LINE_CAP; // terra mustFix 2 — 원줄 캡 초과 여부를 hit 에 전파
    const head = overCap ? chars.slice(0, SHELL_LINE_WATCH_LINE_CAP).join('') : line;
    const tail = overCap ? chars.slice(-SHELL_LINE_WATCH_LINE_CAP).join('') : null;
    if (pattern) {
      if (pattern.test(head)) fire('match', head, overCap);
      else if (tail !== null && pattern.test(tail)) fire('match', tail, overCap);
    }
    // JUD #38537 must ② — 매치·임계 검사는 독립: 임계 줄 자체가 매치이기도 하면 'match'+'lines' 둘 다 발화
    //   (조기 return 때문에 fire('lines') 가 영구 누락되던 결함 — 최소한 lines 는 반드시 발화).
    if (opts.spec.minLines !== undefined && completeLines === opts.spec.minLines) fire('lines', head, overCap);
  };
  return {
    push(chunk: string, stream: ShellLineWatchStream = 'pty') {
      if (stopped || chunk.length === 0) return;
      let pending = pendings.get(stream) ?? '';
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        consumeLine(line);
        if (stopped) {
          pendings.clear();
          return;
        }
        nl = pending.indexOf('\n');
      }
      // JUD #38537 must ① — 개행 없는 잔여 pending 상한: 초과분(머리)은 버리고 꼬리 CAP 코드포인트만 유지(결정적).
      if (pending.length > SHELL_LINE_WATCH_PENDING_CAP) {
        pending = Array.from(pending).slice(-SHELL_LINE_WATCH_PENDING_CAP).join('');
      }
      pendings.set(stream, pending);
    },
    flush() {
      if (stopped) return;
      for (const [stream, pending] of pendings) {
        if (pending.length === 0) continue;
        pendings.set(stream, '');
        consumeLine(pending);
        if (stopped) {
          pendings.clear();
          return;
        }
      }
    },
    stop() {
      stopped = true;
      pendings.clear();
    },
    lineCount() {
      return completeLines;
    },
    pendingLength() {
      let total = 0;
      for (const pending of pendings.values()) total += pending.length;
      return total;
    },
  };
}

export interface ShellLineWatchStart {
  stop(): void;
}

/**
 * Attach the core to a real bg ShellHandle: chunks → lines → hits → queue.
 * Auto-stops on handle settle (flushes a trailing un-newlined line first).
 * Returns null when the engine offers no chunk stream (fail-soft, logged).
 */
export function startShellLineWatch(input: { handle: ShellHandle; spec: ShellLineWatchSpec; label?: string; queue?: TaskNotificationQueue }): ShellLineWatchStart | null {
  const queue = input.queue ?? globalTaskNotificationQueue;
  if (typeof input.handle.onChunk !== 'function') {
    debug.log('shell.line-watch', 'unavailable', { handle: input.handle.id });
    return null;
  }
  const startedAt = Date.now();
  let seq = 0;
  const core = createLineWatchCore({
    spec: input.spec,
    onHit: (hit) => {
      seq += 1;
      const taskId = `shell-watch:${input.handle.id}:${seq}`;
      queue.enqueue({
        taskId,
        agentName: 'RunShell',
        ...(input.label !== undefined && input.label !== '' ? { label: input.label } : {}),
        state: 'running', // JUD #38537 must ⓑ — 중간 줄은 진행 상태(완료는 프로세스 종료 때 shell: · state done)
        output: [
          `RunShell bg line-watch handle=${input.handle.id} ${hit.kind}`,
          `taskId=${taskId}`,
          `lineIndex=${hit.lineIndex}`,
          `line=${JSON.stringify(hit.line)}`,
          ...(hit.truncated ? ['lineTruncated=true'] : []),
          `elapsed=${Date.now() - startedAt}ms`,
        ].join(' '),
        truncated: hit.truncated,
        durationMs: Date.now() - startedAt,
        finishedAt: Date.now(),
      });
      debug.log('shell.line-watch', 'hit', { taskId, kind: hit.kind, lineIndex: hit.lineIndex });
    },
  });
  // JUD #38537 must ③ — 청크를 스트림 태그와 함께 넘겨 stdout/stderr 부분 줄이 서로 엉키지 않게 조립('pty' 는 한 줄기).
  const unsubscribe = input.handle.onChunk((chunk) => core.push(chunk.bytes, chunk.stream));
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    unsubscribe();
    core.flush();
    core.stop();
    debug.log('shell.line-watch', 'stopped', { handle: input.handle.id, lines: core.lineCount() });
  };
  input.handle.result.then(settle, settle);
  debug.log('shell.line-watch', 'armed', {
    handle: input.handle.id,
    ...(input.spec.pattern !== undefined ? { pattern: input.spec.pattern } : {}),
    ...(input.spec.minLines !== undefined ? { minLines: input.spec.minLines } : {}),
  });
  return { stop: settle };
}
