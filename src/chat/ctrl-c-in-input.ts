/** U1a — how long an empty-input Ctrl+C stays armed (and its hint stays on screen). */
export const CTRL_C_ARM_MS = 2_000;

export function resolveCtrlCInInput({ text, now, armedAt }: {
  text: string;
  now: number;
  armedAt: number | null;
}): { action: 'clear-input' | 'arm-exit' | 'exit'; armedAt: number | null; hint: string | null } {
  if (text.length > 0) return { action: 'clear-input', armedAt: null, hint: null };
  if (armedAt !== null && now >= armedAt && now - armedAt <= CTRL_C_ARM_MS) {
    return { action: 'exit', armedAt: null, hint: null };
  }
  return { action: 'arm-exit', armedAt: now, hint: '한 번 더 누르면 나갑니다 · /quit' };
}
