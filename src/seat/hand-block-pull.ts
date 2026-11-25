// GOAL-BLOCK-NOT-HUMAN ⊕ HAND-PULL-ON-BLOCK (live 11-25 19:05 · rail 31 · 0.3.36 P0) — a HAND seat never stops at «⏸ Blocked —
// a person is needed». Its plan ended blocked (another seat's approval · HOLD · decision) or waiting (a reply · a new
// decision): that is the cell waiting, not the hand. The runtime opens ONE internal turn: park the cell with
// `eln work block <cell> --on <seat> --reason …`, then `eln work next` in the same turn.
//
// Structured only: the plan outcome kind (blocked · waiting) ⊕ the seat role ⊕ whether this turn moved anything
// (turnMadeProgress over the turn's tool rows). Never the reply prose. Bounded: once per {@link HAND_BLOCK_PULL_EVERY_MS}.
//
// 세 얼굴: 관측 = debug.log('tui.goal-continue', 'hand-block-pull', {…}) ⊕ the notice line · 판단 근거 = {@link decideHandBlockPull}
// · 수복과 인계 = the internal turn (block + work next) · the awaited seat's coordinator gets one exception mail (cell-block.ts).

/** At most one runtime block+next turn per hand per this window. */
export const HAND_BLOCK_PULL_EVERY_MS = 10 * 60_000;

export type HandPlanStop =
  | { readonly kind: 'blocked'; readonly step: string; readonly reason: string; readonly code?: string }
  | { readonly kind: 'waiting'; readonly step: string; readonly wake: { readonly kind: string; readonly target: string } };

/** Block codes that are the hand's own problem (a tool refusal · a provider failure) — those still stop for a person. */
export const HAND_OWN_BLOCK_CODES: readonly string[] = ['TOOL_DENIED', 'PROVIDER_ERROR'];

/** Is this plan stop «my cell waits on someone else» for a hand (so it must not raise ✋)? */
export function isHandCellWait(stop: HandPlanStop): boolean {
  if (stop.kind === 'waiting') return true;
  return stop.code === undefined || !HAND_OWN_BLOCK_CODES.includes(stop.code);
}

export type HandBlockPullVerdict =
  | { readonly act: true; readonly prompt: string }
  | { readonly act: false; readonly reason: 'not-hand' | 'own-block' | 'progressed' | 'cap' };

export function decideHandBlockPull(input: {
  readonly hand: boolean;
  readonly stop: HandPlanStop;
  /** The turn made a succeeded state-changing call (turnMadeProgress). */
  readonly progressed: boolean;
  /** Epoch ms of the last runtime block+next turn for this session (undefined = none). */
  readonly lastAt?: number;
  readonly now: number;
  /** The hand's open (yellow) cells, from the checklist — named in the prompt so the model blocks the right one. */
  readonly cells?: readonly string[];
}): HandBlockPullVerdict {
  if (!input.hand) return { act: false, reason: 'not-hand' };
  if (!isHandCellWait(input.stop)) return { act: false, reason: 'own-block' };
  if (input.progressed) return { act: false, reason: 'progressed' };
  if (input.lastAt !== undefined && input.now - input.lastAt < HAND_BLOCK_PULL_EVERY_MS) return { act: false, reason: 'cap' };
  return { act: true, prompt: handBlockPullPrompt(input.stop, input.cells ?? []) };
}

export function handBlockPullPrompt(stop: HandPlanStop, cells: readonly string[]): string {
  const what = stop.kind === 'blocked'
    ? `막힘(${stop.code ?? 'block'}): ${(stop.reason || stop.step).slice(0, 160)}`
    : `기다림(${stop.wake.kind} ${stop.wake.target}): ${stop.step.slice(0, 160)}`;
  const cellHint = cells.length ? `내 열린 칸: ${cells.slice(0, 5).join(' · ')}. ` : '';
  return `🚗 자율주행 · 내 칸이 다른 자리를 기다린다 — ${what}\n`
    + '손 자리는 이 상태로 사람을 기다리지 않는다. ' + cellHint
    + '① 기다리는 칸마다 `eln work block <칸> --on <기다리는 자리> --reason "<한 줄>"` 로 보드에 돌려놓는다(그 자리 조율자에게 한 번 알림 · 답이 오면 칸이 나에게 먼저 돌아온다). '
    + '② 같은 턴에 바로 `eln work next` 로 다음 칸을 가져가 시작한다. `eln work next` 가 exit 3 이면 «일감 0» 한 줄로 턴을 닫는다.';
}
