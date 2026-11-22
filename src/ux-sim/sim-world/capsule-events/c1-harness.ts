// C1 harness-child end axis (내부 문서 `TURN-CAPSULE-EVENTS` §3.3 ③-4 CAPSULE-B4-HARNESS-DONE-FRAME · CAPSULE-B5
// queue-bridge): a harness child the chat child runs (RunShell mode:'bg') files its completion only in the child's own
// task-notification queue; the B4 converter (capsuleDoneFromHarnessNotification) turns it into one `capsule-done` frame
// (repl/index.ts watchQueueCapsuleDone), the TUI queues one notice and knocks the idle door (capsule-done-knock), and
// exactly one next turn opens — the C1 budget: from idle, ≤20s, duplicates 0.
// Real Next TUI and child REPL on a PTY; the LLM is the external fake device.
// Unmeasured here: the self-implement-stop ('harness' kind) terminal stop, graph-run frames, busy-turn (mid-turn box)
// behavior, and the mail axis (capsule-events/C1-MAIL keeps its own row).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

/** The harness child must outlive the parent turn, so the seat is idle when it ends (§3.6 C1 «idle 복귀 ≤ 20s»). */
const SHELL_SECONDS = 15;
/** C1 wake budget: from the idle boundary, the completion turn must open within 20s. */
const WAKE_LIMIT_MS = 20_000;
/** After the first delivery, how long a second (duplicate) one is watched for. */
const DUPLICATE_WINDOW_MS = 5_000;

const c1Harness: SimWorldScenario = {
  id: 'C1-HARNESS',
  title: 'a finished harness child wakes the idle seat exactly once',
  async run(ctx) {
    const root = ctx.universeRoot;
    const capture = join(root, 'requests.jsonl');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // The queue-bridged RunShell bg completion carries taskId `shell:<handle>:<n>` (queue-bridge.ts bridgedCapsuleKind)
    // — distinct from the A2 detached-Bash capsule ids (`shell-<b36>-<n>`, measured by C3) and from `shell-watch:`
    // progress lines (state 'running' is not a completion).
    const delivered = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { messages?: unknown })
      .filter(row => /<task id=\\?"shell:/.test(JSON.stringify(row.messages))) : [];
    let idleAt = 0;
    let wakeAt = 0;
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C1_HARNESS_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
            when: 'c1-harness-parent', name: 'RunShell',
            args: { command: ['/bin/sh', '-c', `sleep ${SHELL_SECONDS}; echo C1_HARNESS_CHILD_DONE`], mode: 'bg', description: 'c1 harness child' },
          }) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          { label: 'parent settled', text: 'c1-harness-parent', until: screen => /Turn done|○ done/.test(screen), timeoutMs: 30_000 },
          { label: 'harness child end wakes the turn', timeoutMs: WAKE_LIMIT_MS, until: () => {
            if (idleAt === 0) idleAt = Date.now();
            if (delivered().length > 0 && wakeAt === 0) wakeAt = Date.now();
            return delivered().length > 0;
          } },
          // A duplicate notice would arrive as a second request shortly after the first; watch a bounded window for it.
          { label: 'no duplicate delivery', until: () => { if (wakeAt === 0) wakeAt = Date.now(); return Date.now() - wakeAt >= DUPLICATE_WINDOW_MS; },
            timeoutMs: DUPLICATE_WINDOW_MS + 5_000 },
        ],
      });
      const count = delivered().length;
      ctx.recorder.event('c1-harness-delivery', { count, wakeWithinMs: idleAt > 0 && wakeAt > 0 ? wakeAt - idleAt : null, exitCode: run.exitCode });
      if (run.exitCode !== 0)
        return { ok: false, reason: 'C1 harness TUI did not exit cleanly', diff: `exit ${run.exitCode}, deliveries ${count}` };
      if (count === 0)
        return { ok: false, reason: 'harness child end never wakes the turn',
          diff: `no <task id="shell:…"> request within ${WAKE_LIMIT_MS}ms of the idle boundary (${SHELL_SECONDS}s child)` };
      if (count > 1)
        return { ok: false, reason: 'harness child completion delivered more than once', diff: `deliveries ${count}` };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.recorder.event('c1-harness-wake-timeout', { count: delivered().length });
      if (/timed out waiting for «harness child end wakes the turn»/.test(message))
        return { ok: false, reason: 'harness child end never wakes the turn', diff: message };
      if (/timed out waiting for «parent settled»/.test(message))
        return { ok: false, reason: 'C1 harness parent turn did not settle', diff: message };
      return { ok: false, reason: 'C1 harness child wake run failed', diff: message };
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c1Harness];
