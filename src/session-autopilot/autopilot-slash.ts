// SESSION-AUTOPILOT — `/autopilot on [goal] | off | resume | hold | goals | status` (deterministic; same controller as the tool).
import type { SessionAutopilot } from './autopilot.js';
import { activeGoals, timeToDue } from './goals.js';

export const AUTOPILOT_SLASH_USAGE = 'usage: /autopilot on [goal] | off | resume | hold | goals | status';

export function runAutopilotSlash(pilot: SessionAutopilot, args: readonly string[], now: () => number = Date.now): string[] {
  const [sub = 'status', ...rest] = args;
  switch (sub) {
    case 'on': {
      const goal = rest.join(' ').trim();
      return [pilot.set({ on: true, ...(goal ? { goal } : {}) }, 'slash').text];
    }
    case 'off': return [pilot.set({ on: false }, 'slash').text];
    case 'resume': return [pilot.set({ on: true }, 'slash').text];
    case 'hold': return [pilot.set({ on: true, hold: true }, 'slash').text];
    case 'goals': {
      pilot.refresh();
      const goals = activeGoals(pilot.goals());
      if (goals.length === 0) return ['🚗 목표 없음 — 사람이 정한다 (말로 하거나 autopilot_goal_set)'];
      return ['🚗 목표', ...goals.map((g) => `  [${g.level}] ${g.title} · ${timeToDue(g.due, now())}${g.source === 'seed' ? ' (seed)' : ''} · id ${g.id}`)];
    }
    case 'status': {
      pilot.refresh();
      return [pilot.statusText() || '🚗 자율주행 꺼짐'];
    }
    default: return [AUTOPILOT_SLASH_USAGE];
  }
}
