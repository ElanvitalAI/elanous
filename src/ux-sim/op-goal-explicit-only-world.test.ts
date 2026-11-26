// OP-GOAL-EXPLICIT-ONLY sim (대표 11-26 04:5x «two questions became goals with deadlines») — synthetic person turns on a
// fake clock against the REAL createAutopilot + dispatchAutopilotTool. Each seed shuffles a stream of questions,
// requests with a deadline, explicit «set it as a goal» asks and crown goal mails. The fake model behaves like
// tonight's OP: it tries to pin EVERY line (with a deadline). Only the explicit asks and the crown goal may land.
// Expectations are literals (independent of the product constants).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot } from '../session-autopilot/autopilot.js';
import { dispatchAutopilotTool } from '../session-autopilot/autopilot-tool.js';

const root = mkdtempSync(join(tmpdir(), 'op-goal-explicit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

type Line = { kind: 'question' | 'request' | 'explicit' | 'invented-quote'; text: string; quote?: string };
const LINES: readonly Line[] = [
  { kind: 'question', text: 'TC 칸 지금 어디까지 왔어?' },
  { kind: 'question', text: 'Why is the 0.3.36 roster still yellow?' },
  { kind: 'request', text: '07:00 까지 REL 에 컷 상태 확인해서 알려줘' },
  { kind: 'request', text: 'Check the pregate on #40210 by 06:40 and tell me' },
  { kind: 'explicit', text: '데모 덱 정리, 이걸 골로 잡아줘 — 10시까지', quote: '이걸 골로 잡아줘' },
  { kind: 'explicit', text: 'Make this a goal: green 10 cells by 09:00', quote: 'Make this a goal' },
  { kind: 'invented-quote', text: 'How many cells are green right now?', quote: '골로 잡아' },
];

async function run(seed: number): Promise<string[]> {
  const dir = mkdtempSync(join(root, `s${seed}-`));
  const file = join(dir, 'autopilot.json');
  let t = Date.parse('2026-11-26T05:00:00+09:00');
  const pilot = createAutopilot({ file, now: () => t });
  pilot.set({ on: true }, 'slash');
  const r = rng(seed);
  const verdicts: string[] = [];
  for (let i = 0; i < 21; i++) {
    t += 31 * 60_000; // past the pin-change rate window each time
    const line = LINES[Math.floor(r() * LINES.length)]!;
    pilot.noteTurnStart('human', line.text);
    // The over-eager fake model: every line becomes a goal attempt with a deadline and a size estimate.
    const out = await dispatchAutopilotTool('autopilot_set', { on: true, goal: `G${i} ${line.text.slice(0, 20)}`, done_criterion: 'done line',
      deadline: '23:59', expected_turns: 4, ...(line.quote ? { explicit_ask: line.quote } : {}) }, { cwd: dir, file, now: () => t }) as { ok?: boolean };
    verdicts.push(`${line.kind}:${out.ok === true ? 'pinned' : 'refused'}`);
  }
  return verdicts;
}

describe('OP-GOAL-EXPLICIT-ONLY sim (fake clock)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}: only explicit asks pin; questions, requests and invented quotes are refused`, async () => {
      const v = await run(seed);
      expect(v.length).toBe(21);
      for (const one of v) {
        const [kind, verdict] = one.split(':');
        expect(verdict).toBe(kind === 'explicit' ? 'pinned' : 'refused');
      }
    });
  }

  test('edge: an autonomous (mail/self-wake) turn cannot pin even with a quote', async () => {
    const dir = mkdtempSync(join(root, 'auto-'));
    const file = join(dir, 'autopilot.json');
    const t = Date.parse('2026-11-26T05:10:00+09:00');
    const pilot = createAutopilot({ file, now: () => t });
    pilot.set({ on: true }, 'slash');
    pilot.noteTurnStart('auto', '이걸 골로 잡아줘');
    const out = await dispatchAutopilotTool('autopilot_set', { on: true, goal: 'X', done_criterion: 'd', deadline: '23:59', expected_turns: 4, explicit_ask: '이걸 골로 잡아줘' }, { cwd: dir, file, now: () => t });
    expect(out).toEqual({ error: '골은 사람·대표 지시만 바꾼다 — 보통 우편·요청은 약속 원장·체크리스트에 적는다' });
  });

  test('edge: a crown goal mail still opens the goal with no model and no quote', () => {
    const dir = mkdtempSync(join(root, 'crown-'));
    const file = join(dir, 'autopilot.json');
    const t = Date.parse('2026-11-26T05:20:00+09:00');
    const pilot = createAutopilot({ file, now: () => t, seat: 'OP' });
    pilot.set({ on: true }, 'slash');
    const changed = pilot.observeMail([{ goal: '0.3.37 P0 셋 착지', crownDirective: '9001', sender: 'OP', msgId: 9001 }]);
    expect(changed).toBe(true);
    expect(pilot.state().goal).toBe('[지시] 0.3.37 P0 셋 착지');
  });
});
