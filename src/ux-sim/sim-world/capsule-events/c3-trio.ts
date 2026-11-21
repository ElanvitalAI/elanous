// C3-TRIO full axis — CAPSULE-A2-BASH-DETACH 완료선 실물(정본 §3.6 C3 :805): 10분 Bash 3개를 띄운 뒤
// 우편·사람 입력 — 메인 턴 idle 복귀 ≤20s · 우편·사람 즉시 턴 · Bash 완료 3건 각 사건 턴.
// Real Next TUI and child REPL; only the external LLM is faked. The three Bash calls ride ONE
// assistant message (a real parallel batch), each past the 10s sync cap so all three detach.
// Esc-survival stays on the canonical C3 (B2); this scenario id is new (JUD-B #119325 경로 승인).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsgStore } from '../../../msg/msg-store.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldScenario } from '../types.js';

/** Each Bash sleeps past the 10s sync cap (sim time budget: not 10 real minutes). */
const SHELL_SECONDS = 25;
/** §3.6 C3 «메인 턴 idle 복귀 ≤ 20s». */
const SETTLE_LIMIT_MS = 20_000;
/** The 15s real mail poll needs its baseline before the post (C2 precedent). */
const MAIL_BASELINE_MS = 16_000;
/** After the last expected delivery, how long a duplicate is watched for. */
const DUPLICATE_WINDOW_MS = 5_000;

const SHELL_FRAME = /<task id=\\?"shell-([^"\\]+)/g;

const c3Trio: SimWorldScenario = {
  id: 'C3-TRIO',
  title: 'three detached Bash, then mail and a person — idle ≤20s, each completion its own turn',
  async run(ctx) {
    const seat = 'SIMSEAT';
    const root = join(ctx.universeRoot, 'seats', seat);
    const home = join(ctx.universeRoot, 'home');
    const capture = join(root, 'requests.jsonl');
    const db = join(root, 'msg', 'messages.db');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
    mkdirSync(join(root, 'msg'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    new MsgStore(db).close();
    const rows = (): Array<{ messages?: unknown }> => existsSync(capture)
      ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { messages?: unknown })
      : [];
    const text = (): string => rows().map(row => JSON.stringify(row.messages)).join('\n');
    /** Every capsule-done shell frame across all captured requests, per unique shell id. */
    const shellFrames = (): string[] => [...text().matchAll(SHELL_FRAME)].map(m => m[1]);
    const uniqueShells = (): Set<string> => new Set(shellFrames());
    /** Captured rows carry the FULL conversation history, so «the string anywhere» would count every
     *  request made after the delivery (mail 1 + person 1 + 3 completion turns = 5). A turn the mail
     * or the person opened shows it as the LAST human message — same meaning as the fake LLM's own
     * lastHumanText (tool-result tails are not a person's turn-opening input). */
    const lastHumanText = (row: { messages?: unknown }): string => {
      const messages = Array.isArray(row.messages) ? row.messages : [];
      const last = messages.at(-1) as { role?: unknown; content?: unknown } | undefined;
      if (!last || last.role !== 'user') return '';
      const content = last.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      if (content.some((block) => (block as { type?: unknown }).type === 'tool_result')) return '';
      return content
        .map((block) => (block as { type?: unknown; text?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : '')
        .join('');
    };
    const mailTurns = (): number => rows().filter(row => lastHumanText(row).includes('C3-TRIO isolated mail')).length;
    const personTurns = (): number => rows().filter(row => lastHumanText(row).includes('c3-trio-person')).length;

    let baselineStarted: number | undefined;
    let typedAt = 0;
    let settledAt = 0;
    let posted = false;
    let personTyped = false;
    let lastExpectAt = 0;
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        env: {
          HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C3-TRIO_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'c3-trio-parent',
            parallel: [1, 2, 3].map(i => ({ name: 'Bash', args: { command: `sleep ${SHELL_SECONDS}; echo C3_TRIO_DONE_${i}`, timeout: 120_000 } })) }),
        },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        steps: [
          // Mail poll baseline first (C2 precedent): the watcher cursor must exist before the post.
          { label: 'mail baseline', until: () => { baselineStarted ??= Date.now(); return Date.now() - baselineStarted >= MAIL_BASELINE_MS; }, timeoutMs: MAIL_BASELINE_MS + 10_000 },
          // §3.6 C3 «메인 턴 idle 복귀 ≤ 20s» — three past-cap Bash in one batch must not hold the turn.
          { label: 'parent settled', text: 'c3-trio-parent', until: screen => {
            typedAt ||= Date.now();
            if (!settledAt && /Turn done|○ done/.test(screen)) settledAt = Date.now();
            return settledAt > 0;
          }, timeoutMs: SETTLE_LIMIT_MS },
          // While the three shells run backgrounded: a mail and a person line each open their own turn.
          { label: 'mail delivered', until: () => {
            if (!posted) {
              posted = true;
              const store = new MsgStore(db);
              try { store.post({ from: 'OP', to: seat, body: 'C3-TRIO isolated mail', intent: 'request' }); } finally { store.close(); }
            }
            return mailTurns() > 0;
          }, timeoutMs: 40_000 },
          { label: 'person turn delivered', text: 'c3-trio-person', until: () => {
            personTyped = true;
            return personTurns() > 0;
          }, timeoutMs: 20_000 },
          // §3.6 C3 «Bash 완료 3건 각 사건 턴» — three distinct shell ids, one turn each.
          { label: 'three completion turns', until: () => uniqueShells().size >= 3, timeoutMs: (SHELL_SECONDS + 25) * 1000 },
          // A duplicate would arrive as one more frame for an already-counted id shortly after.
          { label: 'no duplicate delivery', until: () => {
            lastExpectAt ||= Date.now();
            return Date.now() - lastExpectAt >= DUPLICATE_WINDOW_MS;
          }, timeoutMs: DUPLICATE_WINDOW_MS + 5_000 },
        ],
      });
      const settleMs = typedAt && settledAt ? settledAt - typedAt : -1;
      const frames = shellFrames();
      const ids = uniqueShells();
      ctx.recorder.event('c3-trio-delivery', {
        settleMs, mailTurns: mailTurns(), personTurns: personTurns(), personTyped,
        shellTurns: frames.length, uniqueShells: ids.size, exitCode: run.exitCode,
      });
      if (run.exitCode !== 0) return { ok: false, reason: 'tui exited with an error', diff: `exit ${run.exitCode}` };
      if (settleMs < 0 || settleMs > SETTLE_LIMIT_MS)
        return { ok: false, reason: 'three long Bash hold the main turn past 20s', diff: `settle ${settleMs}ms > ${SETTLE_LIMIT_MS}ms` };
      if (mailTurns() !== 1)
        return { ok: false, reason: 'mail turn not delivered exactly once', diff: `mail turns ${mailTurns()}` };
      if (personTurns() !== 1)
        return { ok: false, reason: 'person turn not delivered exactly once', diff: `person turns ${personTurns()}` };
      if (ids.size !== 3)
        return { ok: false, reason: 'shell completions did not open three turns', diff: `unique shell ids ${ids.size}: ${[...ids].join(',')}` };
      if (frames.length !== 3)
        return { ok: false, reason: 'shell completion delivered more than once', diff: `frames ${frames.length} for ids ${ids.size}` };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out waiting for «parent settled»/.test(message)) {
        ctx.recorder.event('c3-trio-held', { limitMs: SETTLE_LIMIT_MS, posted, personTyped });
        return { ok: false, reason: 'three long Bash hold the main turn', diff: message };
      }
      if (/timed out waiting for «three completion turns»/.test(message)) {
        ctx.recorder.event('c3-trio-no-wake', { uniqueShells: uniqueShells().size, mailTurns: mailTurns(), personTurns: personTurns() });
        return { ok: false, reason: 'shell completions did not open three turns in time', diff: message };
      }
      throw error;
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c3Trio];