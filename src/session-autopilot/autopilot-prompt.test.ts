// SESSION-AUTOPILOT — prompt snapshot: the one stable line lists the mode words + on/off verbs; the ON paragraph rides
// the volatile tail (the state file is pinned for this process through ELANOUS_AUTOPILOT_STATE_FILE).
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../user-config/types.js';
import { buildReplSystemPromptParts } from '../repl/index.js';
import { buildAutopilotTools } from './autopilot-tool.js';

const home = mkdtempSync(join(tmpdir(), 'autopilot-prompt-'));
const saved = process.env.ELANOUS_AUTOPILOT_STATE_FILE;
afterAll(() => {
  if (saved === undefined) delete process.env.ELANOUS_AUTOPILOT_STATE_FILE; else process.env.ELANOUS_AUTOPILOT_STATE_FILE = saved;
  rmSync(home, { recursive: true, force: true });
});
const cfg = { llm: {} } as UserConfig;

test('the stable prompt line and the tool description list the words and the on/off verbs', () => {
  const parts = buildReplSystemPromptParts({ cfg, enabledToolNames: ['autopilot_set'], cwd: '/workspace/user', seatBootDeps: { home, env: {} } });
  for (const word of ['«자율주행»', '«오토파일럿»', '«autopilot»', '«자동 운행»', '«알아서 운전»', '시작·켜·on', '끝·꺼·해제·종료·off', 'autopilot_set({on:true, goal?} | {on:false})']) {
    expect(parts.stable ?? '').toContain(word);
  }
  const description = buildAutopilotTools()[0]!.description;
  for (const example of ['«자율주행 시작»', '«오토파일럿 켜줘»', '«autopilot on»', '«자율주행 꺼»', '«오토파일럿 끝»']) expect(description).toContain(example);
  const without = buildReplSystemPromptParts({ cfg, enabledToolNames: ['Bash'], cwd: '/workspace/user', seatBootDeps: { home, env: {} } });
  expect(without.stable ?? '').not.toContain('«오토파일럿»');
});

test('while ON the decision-autonomy paragraph and the goals ride the volatile context; OFF → absent', () => {
  const file = join(home, 'ap', 'state.json');
  mkdirSync(join(home, 'ap'), { recursive: true });
  process.env.ELANOUS_AUTOPILOT_STATE_FILE = file;
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: '0.3.35 개발', turns: [] }));
  writeFileSync(join(home, 'ap', 'goals.json'), JSON.stringify([{ id: 'demo', level: 'mid', title: 'AI&B 데모', owner: 'person', status: 'active', source: 'person' }]));
  const on = buildReplSystemPromptParts({ cfg, enabledToolNames: undefined, cwd: '/workspace/user', seatBootDeps: { home, env: {} } });
  const text = on.volatile.join('\n');
  expect(text).toContain('## 🚗 자율주행 켜짐 · 목표: 0.3.35 개발');
  expect(text).toContain('사람에게는 돈·보안 사고·되돌릴 수 없는 행동·방향 결정만 결정 카드(decisions raise)로 올린다.');
  expect(text).toContain('- [mid] AI&B 데모 · no due date');
  expect(on.stable ?? '').not.toContain('자율주행 켜짐');
  writeFileSync(file, JSON.stringify({ v: 1, on: false, turns: [] }));
  const off = buildReplSystemPromptParts({ cfg, enabledToolNames: undefined, cwd: '/workspace/user', seatBootDeps: { home, env: {} } });
  expect(off.volatile.join('\n')).not.toContain('자율주행');
});
