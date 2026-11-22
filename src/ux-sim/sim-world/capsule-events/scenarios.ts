// C1 background-agent axis: actual TUI and child REPL; the LLM is the external fake device.
// The C1 wake axes: this scene measures the background Agent end (exactly one wake turn within 20s, duplicates 0);
// the harness child end frame is measured by capsule-events/C1-HARNESS (B4/B5 queue-bridge) and the mail axis keeps
// its own red row capsule-events/C1-MAIL. Capsule behavior is always enabled; measure one default configuration.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';
import { simWorldScenarios as c5Scenarios } from './c5-wakeup.js';
import { simWorldScenarios as c6Scenarios } from './c6-boot-backlog.js';

const c1Scene: SimWorldScenario = {
  id: 'C1',
  title: 'background Agent completion wakes an idle seat (default capsule behavior)',
  async run(ctx) {
    const root = ctx.universeRoot;
    const capture = join(root, 'requests.jsonl');
    const args = { description: 'c1 worker', prompt: 'slow-child task', run_in_background: true, max_turns: 1 };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const delivered = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => JSON.stringify(row.messages).includes('<task id=')) : [];
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C1_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_DELAY_MS: '2500', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow-child',
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'c1-parent', name: 'Agent', args }) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          { label: 'parent settled', text: 'c1-parent', until: screen => /Turn done|○ done/.test(screen), timeoutMs: 30_000 },
          { label: 'completion triggers next turn', until: () => delivered().length > 0, timeoutMs: 20_000 },
        ],
      });
      const count = delivered().length;
      ctx.recorder.event('c1-agent-delivery', { count, exitCode: run.exitCode });
      if (run.exitCode === 0 && count === 1) return { ok: true };
      return { ok: false, reason: 'background agent completion delivered more than once', diff: `exit ${run.exitCode}, deliveries ${count}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('N03 timed out waiting for «completion triggers next turn»')) throw error;
      ctx.recorder.event('c1-agent-timeout', { count: delivered().length });
      return { ok: false, reason: 'background agent end never wakes the turn', diff: message };
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c1Scene, ...c5Scenarios, ...c6Scenarios];
