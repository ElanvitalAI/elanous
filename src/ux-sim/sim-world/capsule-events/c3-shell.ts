// C3 shell axis (내부 문서 `TURN-CAPSULE-EVENTS` §3.6 C3 · A2 · no switch since R1 #38713): a long Bash call must not hold the main
// turn — past the 10s sync cap it moves to the background, the turn settles, and the shell's completion comes back as a
// new turn. Real Next TUI and child REPL; the LLM is the external fake device. The Esc-survival and mail/person axes of
// C3 are not measured here (Esc needs B2). Partial axis under the canonical id (sim owners #90474; the old mail «C3» is C1-MAIL).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

/** Bash sleeps far past the 10s cap; the turn must settle before the shell ends. 출처: §3.6 C3 «idle 복귀 ≤ 20s». */
const SHELL_SECONDS = 30;
const SETTLE_LIMIT_MS = 20_000;
/** After the first delivery, how long a second (duplicate) one is watched for. 출처: 알림 배수는 턴 시작 1회 — 그 턴 한 번 길이면 충분. */
const DUPLICATE_WINDOW_MS = 5_000;

const c3Shell: SimWorldScenario = {
  id: 'C3',
  title: 'a long Bash call detaches and its completion opens a new turn',
  async run(ctx) {
    const root = ctx.universeRoot;
    const capture = join(root, 'requests.jsonl');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const delivered = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => /<task id=\\?"shell-/.test(JSON.stringify(row.messages))) : [];
    const command = `sleep ${SHELL_SECONDS}; echo C3_SHELL_DONE`;
    let settled = false;
    let firstDeliveryAt = 0;
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C3_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'c3-parent', name: 'Bash', args: { command, timeout: 120_000 } }) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          { label: 'parent settled', text: 'c3-parent', until: screen => /Turn done|○ done/.test(screen), timeoutMs: SETTLE_LIMIT_MS },
          { label: 'completion triggers next turn', until: () => { settled = true; return delivered().length > 0; }, timeoutMs: (SHELL_SECONDS + 20) * 1000 },
          // A duplicate notice would arrive as a second request shortly after the first; watch a bounded window for it.
          { label: 'no duplicate delivery', until: () => { firstDeliveryAt ||= Date.now(); return Date.now() - firstDeliveryAt >= DUPLICATE_WINDOW_MS; },
            timeoutMs: DUPLICATE_WINDOW_MS + 5_000 },
        ],
      });
      const count = delivered().length;
      ctx.recorder.event('c3-shell-delivery', { count, exitCode: run.exitCode });
      if (run.exitCode !== 0) return { ok: false, reason: 'tui exited with an error', diff: `exit ${run.exitCode}, deliveries ${count}` };
      if (count > 1) return { ok: false, reason: 'shell capsule completion delivered more than once', diff: `deliveries ${count}` };
      if (count === 0) return { ok: false, reason: 'shell capsule end never wakes the turn', diff: 'deliveries 0 after the wait' };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out waiting for «parent settled»/.test(message)) {
        ctx.recorder.event('c3-shell-held', { limitMs: SETTLE_LIMIT_MS });
        return { ok: false, reason: 'long Bash holds the main turn', diff: message };
      }
      if (settled && /timed out waiting for «completion triggers next turn»/.test(message)) {
        ctx.recorder.event('c3-shell-no-wake', { count: delivered().length });
        return { ok: false, reason: 'shell capsule end never wakes the turn', diff: message };
      }
      throw error;
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c3Shell];
