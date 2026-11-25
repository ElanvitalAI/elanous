// RELEASE-GOAL-FROM-LEDGER (L4) — the standing OPS targets and the chip note built from targets. No imports: the
// autopilot loads this at boot; the plan/schedule resolver (release-goal.ts) stays lazy.

/** Standing OPS targets (FEATURE-SHIP-ACCELERATION §1: land 10/h · green 10/h · idle 0) — used only when a plan names none. */
export const STANDING_TARGETS: Readonly<{ landPerHour: number; greenPerHour: number; idleMax: number }> = { landPerHour: 10, greenPerHour: 10, idleMax: 0 };

/** «로스터 착지 · 초록 +10/h» — the chip's numeric note, built from targets (never typed by hand). */
export const releaseGoalNote = (targets: { greenPerHour: number }): string => `로스터 착지 · 초록 +${targets.greenPerHour}/h`;
