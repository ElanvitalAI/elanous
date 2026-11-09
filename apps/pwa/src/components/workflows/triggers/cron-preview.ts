// Surface-unification ROADMAP §B1 (2026-05-11) — cron expression →
// human-readable preview. Minimal mini-parser covering the patterns
// the preset buttons emit + a "Custom" fallback so unknown expressions
// still render something useful. Pure helper · unit-test driven.

export interface CronPreview {
  /** Human-readable summary (e.g. "Every day at 09:00"). */
  text: string;
  /** True when the preview matched a known pattern; false when we fell
   *  back to "Custom" — the editor can dim the badge in that case. */
  matched: boolean;
}

const MINUTE = /^\*\/(\d+) \* \* \* \*$/;
const HOUR = /^0 \*\/(\d+) \* \* \*$/;
const DAILY = /^(\d+) (\d+) \* \* \*$/;
const WEEKDAYS = /^(\d+) (\d+) \* \* 1-5$/;
const WEEKLY = /^(\d+) (\d+) \* \* ([0-6])$/;
const MONTHLY = /^(\d+) (\d+) (\d+) \* \*$/;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function previewCron(expr: string): CronPreview {
  const trimmed = expr.trim();
  if (!trimmed) return { text: '(empty expression)', matched: false };

  const m1 = trimmed.match(MINUTE);
  if (m1) {
    const n = Number(m1[1]);
    return { text: `Every ${n} minute${n === 1 ? '' : 's'}`, matched: true };
  }
  const m2 = trimmed.match(HOUR);
  if (m2) {
    const n = Number(m2[1]);
    return { text: `Every ${n} hour${n === 1 ? '' : 's'}`, matched: true };
  }
  const m3 = trimmed.match(WEEKDAYS);
  if (m3) {
    return { text: `Every weekday at ${pad2(Number(m3[2]))}:${pad2(Number(m3[1]))}`, matched: true };
  }
  const m4 = trimmed.match(WEEKLY);
  if (m4) {
    const day = DAY_NAMES[Number(m4[3])];
    return { text: `Every ${day} at ${pad2(Number(m4[2]))}:${pad2(Number(m4[1]))}`, matched: true };
  }
  const m5 = trimmed.match(DAILY);
  if (m5) {
    return { text: `Every day at ${pad2(Number(m5[2]))}:${pad2(Number(m5[1]))}`, matched: true };
  }
  const m6 = trimmed.match(MONTHLY);
  if (m6) {
    return {
      text: `Day ${Number(m6[3])} of every month at ${pad2(Number(m6[2]))}:${pad2(Number(m6[1]))}`,
      matched: true,
    };
  }

  return { text: `Custom: ${trimmed}`, matched: false };
}

export interface CronPreset {
  /** Stable id surfaced as `data-preset` for tests. */
  id: string;
  /** Button label rendered to the user. */
  label: string;
  /** The cron expression the preset writes into the input. */
  expression: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: 'every-5-min', label: 'Every 5 min', expression: '*/5 * * * *' },
  { id: 'every-hour', label: 'Hourly', expression: '0 */1 * * *' },
  { id: 'daily-9am', label: 'Daily 9am', expression: '0 9 * * *' },
  { id: 'weekdays-9am', label: 'Weekdays 9am', expression: '0 9 * * 1-5' },
  { id: 'weekly-mon-9am', label: 'Mon 9am', expression: '0 9 * * 1' },
  { id: 'monthly-1st-9am', label: '1st 9am', expression: '0 9 1 * *' },
];
