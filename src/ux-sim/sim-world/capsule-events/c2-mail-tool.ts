// C2 partial axis: real seat TUI, real Bash dispatch, isolated mail ledger and fake LLM.
// The tool is shorter than 10 seconds; only the external model is faked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsgStore } from '../../../msg/msg-store.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

const c2: SimWorldScenario = {
  id: 'C2', title: 'mail arriving during a short tool reaches the next turn',
  async run(ctx) {
    const seat = 'SIMSEAT';
    const root = join(ctx.universeRoot, 'seats', seat);
    const home = join(ctx.universeRoot, 'home');
    const capture = join(root, 'requests.jsonl');
    const db = join(root, 'msg', 'messages.db');
    const toolDone = join(root, 'c2-tool-done');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
    mkdirSync(join(root, 'msg'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    new MsgStore(db).close();
    let posted = false;
    let messageId = 0;
    let baselineStarted: number | undefined;
    const delivered = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => JSON.stringify(row.messages).includes('C2 isolated request')) : [];
    const receipts = () => {
      const store = new MsgStore(db);
      try { return store.listReceipts({ messageId }).map(row => `${row.state}:${row.source}`); }
      finally { store.close(); }
    };
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: { HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C2_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'c2-parent', name: 'Bash', args: { command: 'sleep 8; touch c2-tool-done' } }) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          // Allow the 15-second real mail poll to establish its baseline before the request.
          { label: 'mail baseline', until: () => { baselineStarted ??= Date.now(); return Date.now() - baselineStarted >= 16_000; }, timeoutMs: 25_000 },
          { label: 'short tool running', text: 'c2-parent', until: screen => /Running Bash|Bash\s*[·(]/.test(screen), timeoutMs: 20_000 },
          { label: 'mail delivered', timeoutMs: 35_000, until: screen => {
            if (!posted) {
              if (!/Running Bash|Bash\s*[·(]/.test(screen) || existsSync(toolDone)) throw new Error('C2 tool was not visibly running when mail was posted');
              const store = new MsgStore(db);
              try { messageId = store.post({ from: 'OP', to: seat, body: 'C2 isolated request', intent: 'request' }).id; }
              finally { store.close(); }
              posted = true;
            }
            return delivered().length > 0;
          } },
        ],
      });
      if (!existsSync(toolDone)) throw new Error('C2 tool completion marker missing');
      ctx.recorder.event('c2-mail-delivery', { posted, toolDone: true, receipts: receipts(), deliveries: delivered().length, exitCode: run.exitCode });
      if (run.exitCode !== 0 || delivered().length !== 1)
        return { ok: false, reason: 'C2 mail delivered more than once', diff: `exit ${run.exitCode}; deliveries ${delivered().length}` };
      return { ok: false, reason: 'C2 remaining timing axes unmeasured', diff: 'one mail delivered; model-roundtrip and tool-duration budgets not independently measured' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!posted || !message.startsWith('N03 timed out waiting for «mail delivered»')) throw error;
      if (!existsSync(toolDone)) throw new Error('C2 tool completion marker missing');
      ctx.recorder.event('c2-mail-timeout', { posted, toolDone: true, receipts: receipts(), deliveries: delivered().length });
      return { ok: false, reason: 'mail not delivered after short tool', diff: message };
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c2];
