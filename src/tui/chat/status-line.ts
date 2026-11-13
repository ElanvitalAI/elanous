import { fitLogLine, safeStatusText } from './log-view.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface NextTuiStatusLineInput {
  readonly turnState: string;
  readonly model: string;
  readonly queued: number;
  readonly backgroundTasks: number;
  readonly width: number;
  readonly elapsedMs?: number;
  readonly measuredUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface NextTuiCompactStatusLineInput {
  readonly state: string;
  readonly model?: string;
  readonly queued: number;
  readonly activeChildren: number;
  readonly columns: number;
  readonly elapsedMs?: number;
  readonly measuredUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

function turnTelemetry(elapsedMs: number | undefined, usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined, compact = false): string {
  if (elapsedMs === undefined) return '';
  const seconds = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}초`;
  const tokens = `${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`;
  return compact ? `${seconds} · ${tokens}t` : `경과 ${seconds} · 토큰 ${tokens}`;
}

/** Only elapsed time may be approximated; provider token counts must stay exact. */
function compactElapsed(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '?';
  const digits = String(Math.max(0, Math.floor(value)));
  if (digits.length <= 5) return digits;
  return `≈${digits[0]}${digits[1] === '0' ? '' : `.${digits[1]}`}e${digits.length - 1}`;
}

function minimumTelemetry(elapsedMs: number | undefined, usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined): string {
  if (elapsedMs === undefined) return '';
  const seconds = Math.max(0, elapsedMs) / 1000;
  const elapsed = String(Math.floor(seconds)).length <= 4 ? `${seconds.toFixed(1)}초` : `${compactElapsed(seconds)}초`;
  return `${elapsed}·${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}t`;
}

function smallestElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const digits = String(Math.floor(seconds));
  return digits.length <= 4 ? `${seconds.toFixed(1)}s` : `~${digits[0]}e${digits.length - 1}s`;
}

/** Keep the shown duration monotonic even if a clock source is replaced in a device. */
export function nextTuiElapsedMs(startedAtMs: number, nowMs: number, previousMs = 0): number {
  return Math.max(previousMs, 0, nowMs - startedAtMs);
}

function clean(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactState(value: string): string {
  const cleaned = clean(value);
  const head = cleaned.split(' · ')[0] ?? '';
  if (/실패/iu.test(head)) return cleaned;
  if (/Bash 실행|도구 실행|실행 중인 도구/iu.test(head)) return '도구 실행';
  if (/응답 중/iu.test(head)) return '스트리밍';
  if (/실행 중/iu.test(head)) return '스트리밍';
  if (/취소/iu.test(head)) return cleaned;
  if (/로그 탐색/iu.test(head)) return '로그';
  if (/조회 중/iu.test(head)) return '조회';
  if (/완료/iu.test(head)) return '완료';
  if (/전송|입력 대기/iu.test(head)) return '대기';
  return cleaned || '대기';
}

function takeCells(value: string, cells: number): string {
  if (cells <= 0) return '';
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(value)) {
    const width = Bun.stringWidth(segment);
    if (used + width > cells) break;
    result += segment;
    used += width;
  }
  return result;
}

function modelWithoutProvider(value: string): string {
  const cleanValue = clean(value) || '?';
  const slash = cleanValue.lastIndexOf('/');
  return slash >= 0 ? cleanValue.slice(slash + 1) || '?' : cleanValue;
}

/** One-line status with compact labels and failure/cancellation meaning preserved. */
export function formatNextTuiStatusLine(input: NextTuiStatusLineInput): string {
  const width = Math.max(1, Math.floor(input.width));
  const state = clean(input.turnState) || '대기';
  const shortState = width <= 32 && /응답 중/iu.test(state) ? '응답 중' : compactState(state);
  const model = clean(input.model) || '?';
  const shortModel = modelWithoutProvider(model);
  const queued = Math.max(0, Math.floor(input.queued));
  const backgroundTasks = Math.max(0, Math.floor(input.backgroundTasks));
  const telemetry = turnTelemetry(input.elapsedMs, input.measuredUsage);
  const shortTelemetry = turnTelemetry(input.elapsedMs, input.measuredUsage, true);
  const minimum = minimumTelemetry(input.elapsedMs, input.measuredUsage);
  const metricState = /실패/iu.test(shortState) ? '실패' : /취소/iu.test(shortState) ? '취소' : shortState;
  const candidates = [
    ...(telemetry ? [
      `턴 ${shortState} · 모델 ${model} · ${telemetry} · 대기 ${queued} · 배경 ${backgroundTasks}`,
      `턴 ${shortState} · ${shortModel} · ${telemetry} · Q${queued} · B${backgroundTasks}`,
      `턴 ${shortState} · ${shortTelemetry} · Q${queued} · B${backgroundTasks}`,
      `${shortState} · ${shortTelemetry} · Q${queued} · B${backgroundTasks}`,
      `턴 ${metricState} · ${minimum} · Q${queued} · B${backgroundTasks}`,
      `${metricState}·${minimum}·Q${queued}·B${backgroundTasks}`,
      ...(input.measuredUsage?.inputTokens !== undefined && input.measuredUsage?.outputTokens !== undefined
        ? [`${input.measuredUsage.inputTokens}/${input.measuredUsage.outputTokens}t${smallestElapsed(input.elapsedMs!)}`,
          `${metricState}·${input.measuredUsage.inputTokens}/${input.measuredUsage.outputTokens}t`]
        : []),
    ] : []),
    `턴 ${shortState} · 모델 ${model} · 대기 ${queued} · 배경 ${backgroundTasks}`,
    `턴 ${shortState} · 모델 ${shortModel} · 대기 ${queued} · 배경 ${backgroundTasks}`,
    `턴 ${shortState} · ${shortModel} · 대기${queued} · 배경${backgroundTasks}`,
    `${shortState} · ${shortModel} · Q${queued} · B${backgroundTasks}`,
    `${shortState} · ${shortModel} · Q${queued} · B${backgroundTasks}`,
  ];
  const fits = candidates.find((candidate) => Bun.stringWidth(candidate) <= width);
  if (fits) return fits;

  const suffix = `·Q${queued}·B${backgroundTasks}`;
  const fallbackState = /실패/iu.test(shortState) ? '실패' : /취소/iu.test(shortState) ? '취소' : shortState;
  const firstModel = [...segmenter.segment(shortModel)][0]?.segment ?? '?';
  const stateWithModelInitial = `${fallbackState}·${firstModel}${suffix}`;
  const preserveOutcome = /실패|취소/iu.test(shortState);
  if (preserveOutcome) {
    const outcomeWithModel = `${fallbackState}·${shortModel}${suffix}`;
    if (Bun.stringWidth(outcomeWithModel) <= width) return outcomeWithModel;
    if (Bun.stringWidth(stateWithModelInitial) <= width) return stateWithModelInitial;
    const stateWithCounters = `${fallbackState}${suffix}`;
    if (Bun.stringWidth(stateWithCounters) <= width) return stateWithCounters;
    return takeCells(fallbackState, width);
  }
  if (Bun.stringWidth(stateWithModelInitial) <= width) return stateWithModelInitial;

  const stateRoomWithModel = width - Bun.stringWidth(shortModel) - Bun.stringWidth(suffix) - Bun.stringWidth('·');
  if (stateRoomWithModel > 0) {
    const visibleState = takeCells(fallbackState, stateRoomWithModel);
    if (visibleState) return `${visibleState}·${shortModel}${suffix}`;
  }
  const initialAndCountersWidth = Bun.stringWidth(`·${firstModel}${suffix}`);
  const stateRoomWithInitial = width - initialAndCountersWidth;
  if (stateRoomWithInitial > 0 && Bun.stringWidth(shortState) > stateRoomWithInitial) {
    const clippedState = stateRoomWithInitial > 1
      ? `${takeCells(shortState, stateRoomWithInitial - 1)}…`
      : takeCells(shortState, stateRoomWithInitial);
    if (clippedState) return `${clippedState}·${firstModel}${suffix}`;
  }
  const stateWithCounters = `${fallbackState}${suffix}`;
  if (Bun.stringWidth(stateWithCounters) <= width) return stateWithCounters;

  const stateCells = Bun.stringWidth(fallbackState);
  const finalStateRoom = Math.max(0, width - Bun.stringWidth(suffix));
  const finalState = stateCells > finalStateRoom && finalStateRoom > 0
    ? `${takeCells(fallbackState, Math.max(0, finalStateRoom - 1))}…`
    : takeCells(fallbackState, finalStateRoom);
  const minimumBody = `${finalState}${suffix}`;
  return Bun.stringWidth(minimumBody) <= width ? minimumBody : takeCells(suffix, width);
}

/** State-first compact footer used by the standard Next TUI status contract. */
export function nextTuiStatusLine(input: NextTuiCompactStatusLineInput): string {
  const state = safeStatusText(input.state).trim();
  const model = input.model ? safeStatusText(input.model).trim() : '';
  const parts = [
    state,
    turnTelemetry(input.elapsedMs, input.measuredUsage, true),
    model,
    input.queued > 0 ? `대기 ${input.queued}` : '',
    input.activeChildren > 0 ? `하위 ${input.activeChildren}` : '',
  ].filter(Boolean);
  const fits = (value: string) => Bun.stringWidth(value) <= Math.max(1, input.columns);
  while (parts.length > 1 && !fits(parts.join(' · '))) parts.pop();
  return fitLogLine(parts.join(' · '), input.columns);
}
