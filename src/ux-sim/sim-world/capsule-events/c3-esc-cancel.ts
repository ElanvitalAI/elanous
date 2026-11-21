// §3.6 C3 Esc axis: the real Next TUI starts a Bash capsule, then Esc cancels a
// different active turn. The shell must survive Esc. The restored prompt may
// hold the completion notice, so this axis does not assert a new turn.
// Only the external LLM is replaced by the fake provider.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

const SETTLE_LIMIT_MS = 20_000;
const REALTIME = process.env.ELANOUS_SIM_REALTIME === '1';
// Bash has a 600-second product hard cap. Leave 0.6 seconds for command
// startup and use the full ten-minute wall window including TUI setup.
const SHELL_HOLD_SECONDS = REALTIME ? 599.4 : 32;
const SHELL_TIMEOUT_MS = 600_000;

const c3Esc: SimWorldScenario = {
  id: 'C3-ESC',
  title: 'Esc cancels a turn while a detached long Bash survives',
  async run(ctx) {
    const scenarioStartedAt = Date.now();
    const root = ctx.universeRoot;
    const capture = join(root, 'requests.jsonl');
    const marker = join(root, 'c3-esc-shell-done');
    const captured = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)) : [];
    let escapedBeforeShellEnd = false;
    let escaped = false;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        artifactPath: join(ctx.universeRoot, 'c3-esc-seat-pty.json'),
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C3_ESC_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_DELAY_MS: '20000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'c3-esc-busy-turn',
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'c3-esc-parent', name: 'Bash',
            args: { command: REALTIME
              ? `for tick in 1 2 3 4 5 6; do sleep ${SHELL_HOLD_SECONDS / 6}; printf 'C3_ESC_PROGRESS_%s\\n' "$tick"; done; echo C3_ESC_SHELL_DONE > '${marker}'`
              : `sleep ${SHELL_HOLD_SECONDS}; echo C3_ESC_SHELL_DONE > '${marker}'`, timeout: SHELL_TIMEOUT_MS } }) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          { label: 'shell parent settled', text: 'c3-esc-parent', until: screen => /Turn done|○ done/.test(screen), timeoutMs: SETTLE_LIMIT_MS },
          { label: 'other turn running', text: 'c3-esc-busy-turn',
            until: () => captured().some(row => JSON.stringify(row.messages).includes('c3-esc-busy-turn')),
            timeoutMs: 15_000 },
          { label: 'Esc while shell alive', keys: '\x1b', until: screen => {
            if (!screen.includes('Response cancelled')) return false;
            escaped = true;
            escapedBeforeShellEnd = !existsSync(marker);
            return true;
          }, timeoutMs: 5_000 },
          { label: 'shell survives Esc', until: () => existsSync(marker), timeoutMs: (SHELL_HOLD_SECONDS + 15) * 1000 },
        ],
      });
      const shellSurvived = existsSync(marker);
      const resultPending = run.frames.some(frame => frame.screen.includes('Results ready'));
      const scenarioWallMs = Date.now() - scenarioStartedAt;
      ctx.recorder.event('c3-esc', { shellSeconds: SHELL_HOLD_SECONDS, scenarioWallMs, escaped, escapedBeforeShellEnd, shellSurvived, resultPending, exitCode: run.exitCode });
      if (!escaped || !escapedBeforeShellEnd) return { ok: false, reason: 'Esc did not occur while Bash was alive', diff: `escaped ${escaped}, before-end ${escapedBeforeShellEnd}` };
      if (!shellSurvived) return { ok: false, reason: 'Bash did not complete after Esc', diff: 'completion marker absent' };
      if (REALTIME && scenarioWallMs < 600_000)
        return { ok: false, reason: 'Bash finished before the 10-minute wall', diff: `${scenarioWallMs}ms` };
      if (run.exitCode !== 0) return { ok: false, reason: 'C3 Esc TUI exited with an error', diff: `exit ${run.exitCode}` };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.recorder.event('c3-esc-failure', { escaped, escapedBeforeShellEnd, shellSurvived: existsSync(marker),
        message });
      if (escaped && !existsSync(marker)) return { ok: false, reason: 'Bash did not complete after Esc', diff: message };
      return { ok: false, reason: 'C3 Esc scenario could not observe completion', diff: message };
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c3Esc];
