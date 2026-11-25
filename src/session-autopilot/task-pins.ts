// AUTOPILOT-TASK-GOAL-PIN (owner 11-25 07:1x) — «기존에 오토파일럿 골과 그냥 골 셋팅과 구분 · 그냥 골 셋팅은 오토파일럿 골
// 세팅에 표시되지 않고 채팅창 하단에 pin 형태로 · 피닝도 너무 많으면 끝도 없으니 기준을 세워주세요».
//
// S: every goal the model set through autopilot_set became the autopilot goal — a one-afternoon deliverable replaced the
//    seat's version goal in the 🚗 AUTO chip and the 🎯 block.
// C: two kinds. AUTOPILOT goal (standing version goal · crown P0) stays in the chip. TASK goal (a multi-step deliverable
//    with a done criterion) is a pin at the bottom of the chat area, just above the input — and pins must not pile up.
// A: pure pin rules here (the controller keeps `pins` in its state file; the TUI draws `taskPinRows`):
//    - a pin needs a done criterion AND a deadline (refused otherwise)
//    - at most PIN_MAX (3) pins; a 4th evicts the lowest-priority pin (oldest among equals) — logged
//    - the same text again replaces that pin (no duplicate)
//    - unpinned on goal_done · on deadline + 30 min (moved to one «expired» line, shown 30 min) · when replaced
//
// 세 얼굴:
//   관측 = debug.log('autopilot', 'pin-set' | 'pin-replaced' | 'pin-evicted' | 'pin-done' | 'pin-expired', {id, text, …})
//   인지 = addPin() picks the eviction victim · expirePins() finds overdue pins
//   수복과 인계 = an overdue pin leaves the screen by itself (one expired line) · the model closes one with goal_done

export type PinPriority = 0 | 1 | 2;
export interface TaskPin { id: string; text: string; done: string; deadline: number; priority: PinPriority; at: number;
  /** GOAL-DRIVE-NARROW — an explicit task (crown→pin directive). Absent = judged by the life's structured done check. */
  task?: boolean }
export interface ExpiredPin { text: string; deadline: number; at: number }

export const PIN_MAX = 3;
/** A pin stays this long past its deadline, then it moves to the one «expired» line. */
export const PIN_EXPIRE_GRACE_MS = 30 * 60_000;
/** The «expired» line stays this long. */
export const PIN_EXPIRED_SHOW_MS = 30 * 60_000;

/** `P0`/`P1`/`P2` (or 0/1/2) → priority; anything else = P1. */
export function pinPriority(value: unknown): PinPriority {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(/^p/iu, '')) : NaN;
  return n === 0 || n === 2 ? n : 1;
}

export interface PinChange { pins: TaskPin[]; replaced?: TaskPin; evicted?: TaskPin }

/** Add one pin: the same text replaces its pin; beyond PIN_MAX the lowest-priority (oldest among equals) is evicted. */
export function addPin(pins: readonly TaskPin[], pin: TaskPin): PinChange {
  const same = pins.find((p) => p.text === pin.text);
  if (same) return { pins: pins.map((p) => (p.id === same.id ? pin : p)), replaced: same };
  if (pins.length < PIN_MAX) return { pins: [...pins, pin] };
  const victim = [...pins].sort((a, b) => b.priority - a.priority || a.at - b.at)[0]!;
  return { pins: [...pins.filter((p) => p.id !== victim.id), pin], evicted: victim };
}

/** Pins whose deadline + grace has passed leave; the latest of them becomes the expired line. */
export function expirePins(pins: readonly TaskPin[], now: number): { pins: TaskPin[]; expired: TaskPin[] } {
  const expired = pins.filter((p) => now >= p.deadline + PIN_EXPIRE_GRACE_MS);
  return expired.length ? { pins: pins.filter((p) => !expired.includes(p)), expired } : { pins: [...pins], expired: [] };
}

/** The pin goal_done closes: the one whose text matches, else the newest. */
export function pinToClose(pins: readonly TaskPin[], text: string | undefined): TaskPin | undefined {
  const t = text?.trim();
  return (t ? pins.find((p) => p.text === t) : undefined) ?? [...pins].sort((a, b) => a.at - b.at).at(-1);
}

const clock = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** One on-screen pin row (English · UX surface): `id` is the pin's id (absent on the expired line). */
export interface PinEntry { id?: string; at?: number; row: string }

/** The rows above the input: «📌 i/n <text> · done when: <done> · due hh:mm» each, then the one expired line while it shows. */
export function taskPinEntries(pins: readonly TaskPin[] | undefined, expired: ExpiredPin | undefined, now: number): PinEntry[] {
  const list = [...(pins ?? [])].sort((a, b) => a.priority - b.priority || a.at - b.at);
  const rows: PinEntry[] = list.map((p, i) => ({ id: p.id, at: p.at, row: `📌 ${i + 1}/${list.length} ${p.text} · done when: ${p.done} · due ${clock(p.deadline)}${p.priority === 0 ? ' · P0' : ''}` }));
  if (expired && now - expired.at < PIN_EXPIRED_SHOW_MS) rows.push({ row: `⌛ Pin expired: ${expired.text} (due ${clock(expired.deadline)})` });
  return rows;
}

export const taskPinRows = (pins: readonly TaskPin[] | undefined, expired: ExpiredPin | undefined, now: number): string[] =>
  taskPinEntries(pins, expired, now).map((e) => e.row);

/** The pin lines for the model's turn input (inside the one goal block) — empty when no pin. */
export function taskPinFeed(pins: readonly TaskPin[] | undefined): string {
  if (!pins?.length) return '';
  return `\n📌 작업 골(핀 ${pins.length}/${PIN_MAX}) — 자율주행 골이 아니다 · 끝나면 autopilot_set({goal_done:true, kind:"task", goal:"<그 줄>"}):\n`
    + pins.map((p) => `- ${p.text} · 완료: ${p.done} · ⏰${clock(p.deadline)}`).join('\n');
}
