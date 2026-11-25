// RELEASE-GOAL-FROM-LEDGER (OP trace 11-25 L4) — the war-room body and the autopilot chip read the current release
// from the ledgers (PLAN `status: current` · `release:` · optional hourly targets), never from a typed string.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveReleaseGoal, planFrontMatter, planReleaseAt, releaseGoalLine } from './release-goal.js';
import { resolveStandingGoal, standingGoalText } from '../session-autopilot/autopilot.js';

function world(plans: Record<string, string[]>): { hqRoot: string; ledgerRoot: string } {
  const hqRoot = mkdtempSync(join(tmpdir(), 'release-goal-hq-'));
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'release-goal-ledger-'));
  const dir = join(hqRoot, 'seat-state', 'OP', 'plans');
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(plans)) writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
  return { hqRoot, ledgerRoot };
}

const NOW = Date.parse('2026-11-25T06:00:00.000Z'); // 15:00 KST

describe('release goal from the ledgers', () => {
  test('the current plan (not the released one) names version, publish time and targets', () => {
    const w = world({
      'PLAN-0.3.35.md': ['---', 'version: 0.3.35', 'status: released', 'release: 2026-11-25 06:00 KST', '---', '# PLAN-0.3.35 — old'],
      'PLAN-0.3.36.md': ['---', 'version: 0.3.36', 'status: current', 'release: 2026-11-26 06:00 KST (컷 04:00 · 예행 먼저)', 'green_per_hour: 12', 'idle_max: 2', '---', '# PLAN 0.3.36 — 중요 테마'],
    });
    const goal = deriveReleaseGoal({ ...w, packageVersion: '0.3.35-dev.0' });
    expect(goal).toEqual({ version: '0.3.36', versionSource: 'plan', published: false, publishAt: '2026-11-25T21:00:00.000Z', cutAt: null,
      targets: { landPerHour: 10, greenPerHour: 12, idleMax: 2, source: 'plan' } });
    expect(releaseGoalLine(goal, NOW)).toBe('0.3.36 발행 11-26 06:00 (15h) · 착지 10/h · 초록 12/h · 유휴 ≤2 [plan · targets plan]');
  });

  test('a plan without targets says the targets are the standing default; no plan → the package version, unscheduled', () => {
    const w = world({ 'PLAN-0.3.37.md': ['---', 'status: current', 'release: 2026-11-26 18:00 KST', '---'] });
    expect(releaseGoalLine(deriveReleaseGoal({ ...w, packageVersion: '0.3.36-dev.0' }), NOW)).toBe('0.3.37 발행 11-26 18:00 (D-1 3h) · 착지 10/h · 초록 10/h · 유휴 ≤0 [plan · targets default]');
    const empty = world({});
    expect(releaseGoalLine(deriveReleaseGoal({ ...empty, packageVersion: '0.3.38-dev.0' }), NOW)).toBe('0.3.38 발행 unscheduled · 착지 10/h · 초록 10/h · 유휴 ≤0 [package · targets default]');
  });

  test('the autopilot chip note follows the plan targets; without plan targets the chip text is unchanged', () => {
    const w = world({ 'PLAN-0.3.36.md': ['---', 'status: current', 'green_per_hour: 15', '---'] });
    const standing = resolveStandingGoal({ ...w, packageVersion: '0.3.35-dev.0', now: NOW });
    expect(standing && standingGoalText(standing)).toBe('0.3.36 개발 — 로스터 착지 · 초록 +15/h');
    const plain = world({ 'PLAN-0.3.36.md': ['---', 'status: current', '---'] });
    const bare = resolveStandingGoal({ ...plain, packageVersion: '0.3.35-dev.0', now: NOW });
    expect(bare && standingGoalText(bare)).toBe('0.3.36 개발');
  });

  test('front-matter parsing', () => {
    expect(planFrontMatter('---\nstatus: current\nrelease: 2026-11-26 06:00 KST\n---\n# x')).toEqual({ status: 'current', release: '2026-11-26 06:00 KST' });
    expect(planFrontMatter('# no front matter')).toEqual({});
    expect(planReleaseAt({ release: 'TBD' })).toBeNull();
  });
});
