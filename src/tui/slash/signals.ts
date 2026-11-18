// TUI-SLASH-SIGNALS — Next TUI `/signals` 슬래시 묶음(관측 전용).
//
// classic 의 /signals 는 dashboard 전용 registry/runtime 에 살지만, 이 handler 는 Next TUI 가
// 직접 소유한다. src/input/control-signal-observer.ts 의 실제 defaultControlSignalObserver()
// 싱글턴에서 읽기 API(list·latest·countsByKind)만 소비한다 — observer mutation(clear·detach)과
// signal emission(버스 발행)은 명시적으로 범위 밖이며, dashboard/index.ts 는 import 하지 않는다.

import { defaultControlSignalObserver } from '../../input/control-signal-observer.js';
import type { ControlSignal } from '../../input/control-signal.js';

/** `/signals`가 ctx 에서 쓰는 것만(구조 타입 — NextTuiContext 가 이 계약을 만족한다). */
export interface SignalsSlashContext {
  chatLines: string[];
  setChatScrollOffset(value: number): void;
  muted(text: string): string;
  accent(text: string): string;
  text(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  info(text: string): string;
}

const SIGNALS_USAGE = 'usage: /signals [help|status|latest|list [kind]]';

function signalClock(createdAt: string): string {
  return createdAt.slice(11, 19);
}

/** 관측된 신호 한 줄 요약 — 관측 API가 보증하는 필드(kind·urgency·createdAt·scope.sessionId)만 읽는다. */
function signalSummary(signal: ControlSignal): string {
  const sessionId = signal.scope?.sessionId;
  return `[${signal.urgency}] ${signal.kind} · ${signalClock(signal.createdAt)}${sessionId ? ` · session ${sessionId}` : ''}`;
}

function signalsHelp(ctx: SignalsSlashContext): void {
  ctx.chatLines.push(ctx.accent('❯ /signals help'));
  ctx.chatLines.push(ctx.warning(`  ${SIGNALS_USAGE}`));
  ctx.chatLines.push(ctx.muted('  · status — observed signal counts by kind'));
  ctx.chatLines.push(ctx.muted('  · latest — the newest signal'));
  ctx.chatLines.push(ctx.muted('  · list [kind] — signal list (optional kind filter)'));
  ctx.chatLines.push(ctx.muted('  · clear and emit are outside this command (observation only)'));
  ctx.setChatScrollOffset(-1);
}

function signalsStatus(ctx: SignalsSlashContext): void {
  ctx.chatLines.push(ctx.accent('❯ /signals status'));
  const counts = defaultControlSignalObserver().countsByKind();
  const kinds = Object.keys(counts).sort();
  const total = kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  if (total === 0) {
    ctx.chatLines.push(ctx.muted('  No signals observed (0 total)'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(ctx.text(`  ${total} signals total · ${kinds.length} kinds`));
  for (const kind of kinds) {
    ctx.chatLines.push(ctx.muted(`  · ${kind} ×${counts[kind] ?? 0}`));
  }
  ctx.setChatScrollOffset(-1);
}

function signalsLatest(ctx: SignalsSlashContext): void {
  ctx.chatLines.push(ctx.accent('❯ /signals latest'));
  const latest = defaultControlSignalObserver().latest();
  if (!latest) {
    ctx.chatLines.push(ctx.muted('  No latest signal — no control-signal has been observed yet'));
  } else {
    ctx.chatLines.push(`  ${ctx.info(signalSummary(latest))}`);
  }
  ctx.setChatScrollOffset(-1);
}

function signalsList(args: string[], ctx: SignalsSlashContext): void {
  const kind = (args[1] ?? '').trim();
  const signals = defaultControlSignalObserver().list(kind ? { kind } : undefined);
  ctx.chatLines.push(ctx.accent(`❯ /signals list${kind ? ` ${kind}` : ''} (${signals.length})`));
  if (signals.length === 0) {
    ctx.chatLines.push(ctx.muted('  No signals observed'));
  }
  for (const [index, signal] of signals.entries()) {
    ctx.chatLines.push(`  ${ctx.muted(`${index + 1}. ${signalSummary(signal)}`)}`);
  }
  ctx.setChatScrollOffset(-1);
}

/** `/signals` 본체 — 관측 전용. help·status·latest·list 만 실행하고 clear·emit 은 거절한다. */
export async function handleSignalsSlash(args: string[], ctx: SignalsSlashContext): Promise<void> {
  const sub = (args[0] ?? 'status').toLowerCase();
  ctx.chatLines.push('');
  if (sub === 'help') {
    signalsHelp(ctx);
    return;
  }
  if (sub === 'status') {
    signalsStatus(ctx);
    return;
  }
  if (sub === 'latest') {
    signalsLatest(ctx);
    return;
  }
  if (sub === 'list') {
    signalsList(args, ctx);
    return;
  }
  ctx.chatLines.push(ctx.accent(`❯ /signals ${sub}`));
  if (sub === 'clear' || sub === 'emit') {
    ctx.chatLines.push(ctx.error(`  ✗ out of scope — /signals is observation only (${sub} is not supported)`));
  } else {
    ctx.chatLines.push(ctx.warning(`  unknown subcommand: ${sub}`));
  }
  ctx.chatLines.push(ctx.warning(`  ${SIGNALS_USAGE}`));
  ctx.setChatScrollOffset(-1);
}
