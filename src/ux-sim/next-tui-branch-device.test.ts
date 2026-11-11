import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('next TUI memory and decide branches reuse classic behavior in an isolated PTY world', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'next-tui-memory-decide-'));
  const root = join(parent, 'world');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
    }));
    const cwdSlug = realpathSync(root).replace(/\//g, '-').replace(/^-/, '-');
    const memoryDir = join(root, '.claude', 'projects', cwdSlug, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory index\n- anchor: isolated TUI memory fixture\n');
    writeFileSync(join(memoryDir, 'anchor.md'), 'description: SIM memory anchor\ntype: note\n\nMEMORY-FACT-733\n');
    const ledger = new DecisionLedger({
      stateDir: root,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
      resolveVersion: () => ({ released: '0.3.9', dev: '0.3.9-dev.0', codename: 'test' }),
    });
    ledger.raise({
      title: 'SIM-DECISION-733', category: 'irreversible', raisedAt: '2026-11-10T00:00:00.000Z',
      scqa: { s: '시뮬 입력', c: '격리 저장소에서 답을 선택한다' },
      options: [{ key: 'a', label: '진행', consequence: '실행' }, { key: 'b', label: '보류', consequence: '대기' }],
      recommendation: { option: 'a', why: '장치 검증' }, raisedBy: { agent: 'sim', track: 'OP' },
    });

    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      runId: 'next-tui-memory-decide-733',
      env: {
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] unexpected chat turn',
      },
      ready: { label: 'boot', until: 'elanous next ·' },
      steps: [
        { label: 'memory list canonical', text: '/memory list', until: 'anchor' },
        { label: 'memory show alias', text: '/mem show anchor', until: 'MEMORY-FACT-733' },
        { label: 'memory reload canonical', text: '/memory reload', until: 'reload deferred' },
        { label: 'decision list canonical', text: '/decide', until: 'SIM-DECISION-733' },
        { label: 'decision show alias', text: '/dec 1', until: 'SIM-DECISION-733' },
        { label: 'decision confirm prompt canonical', text: '/decide 1 a', until: '/decide 1 a 확인' },
        { label: 'decision answer confirmation alias', text: '/dec 1 a 확인', until: (screen) => screen.includes('SIM-DECISION-733 → 진행') && screen.includes('열린 결정 없음') },
      ],
    });
    expect(run.frames.map((frame) => frame.label)).toEqual([
      'boot', 'memory list canonical', 'memory show alias', 'memory reload canonical', 'decision list canonical', 'decision show alias',
      'decision confirm prompt canonical', 'decision answer confirmation alias',
    ]);
    expect(run.frames[1]?.screen).toContain('SIM memory anchor');
    expect(run.frames[2]?.screen).toContain('MEMORY-FACT-733');
    expect(run.frames[3]?.screen).toContain('reload deferred');
    expect(run.frames[4]?.screen).toContain('SIM-DECISION-733');
    expect(run.frames[5]?.screen).toContain('SIM-DECISION-733');
    expect(run.frames[6]?.screen).toContain('/decide 1 a 확인');
    expect(run.frames[7]?.screen).toContain('SIM-DECISION-733 → 진행');
    expect(run.frames.at(-1)?.screen).not.toContain('[fake-llm] unexpected chat turn');
    expect(new DecisionLedger({ stateDir: root }).list({ status: 'decided' })).toMatchObject([
      { title: 'SIM-DECISION-733', choice: 'a', decidedBy: { kind: 'human' } },
    ]);
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 90_000);
