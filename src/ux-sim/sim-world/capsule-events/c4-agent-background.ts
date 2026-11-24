// §3.6 C4: an Agent capsule stays active while an urgent seat mail opens a
// short turn. The completed Agent later opens its own turn. Real Next TUI,
// child REPL, mail store and Agent tool; only the external LLM is faked.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsgStore } from '../../../msg/msg-store.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import { PASSIVE_RESULT_IDLE_WAKE_MS } from '../../../tui/core/queue.js';
import type { SimWorldScenario } from '../types.js';

const SEAT = 'SIMSEAT';
const PARENT_LIMIT_MS = 20_000;
const URGENT_LIMIT_MS = 20_000;
// A silent 20-minute fake provider response trips the model stream idle
// watchdog. The realtime lane instead runs three actual Bash work segments
// inside the Agent child, keeping the provider protocol responsive.
const REALTIME = process.env.ELANOUS_SIM_REALTIME === '1';
const AGENT_SEGMENT_SECONDS = 400;
const AGENT_HOLD_MS = REALTIME ? AGENT_SEGMENT_SECONDS * 3_000 : 40_000;

const c4Agent: SimWorldScenario = {
  id: 'C4', title: 'urgent mail gets a short turn during a background Agent; completion gets a later turn',
  async run(ctx) {
    const scenarioStartedAt = Date.now();
    const root = join(ctx.universeRoot, 'seats', SEAT);
    const home = join(ctx.universeRoot, 'home');
    const capture = join(root, 'requests.jsonl');
    const db = join(root, 'msg', 'messages.db');
    const workMarker = join(root, 'agent-work-segments');
    const workStartedMarker = join(root, 'agent-work-started');
    const workEndedMarker = join(root, 'agent-work-ended');
    const workPid = join(root, 'agent-work-pid');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    mkdirSync(join(root, 'msg'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    new MsgStore(db).close();
    const captured = () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)) : [];
    const newestUser = (row: { messages?: Array<{ role?: string; content?: unknown }> }) => {
      const message = row.messages?.slice().reverse().find(item => item.role === 'user');
      return JSON.stringify(message?.content ?? '');
    };
    const paintedAnswerAfter = (screen: string, marker: string) => {
      const at = screen.lastIndexOf(marker);
      return at >= 0 && screen.slice(at).includes('C4_REPLY') && /Worked for|Turn done/.test(screen.slice(at));
    };
    // The six-level-evidence preparation call also lands in requests.jsonl with the raw request embedded
    // after `Request: "…"` (its newest user starts with 'Prepare the result contract'), so a bare substring
    // count double-counts every turn: urgent 2 = prep + the one serving, agent 2 = prep + the one turn.
    const turnRows = () => captured().filter(row => !newestUser(row).startsWith('"Prepare the result contract'));
    const urgentTurns = () => turnRows().filter(row => newestUser(row).includes('C4 urgent request'));
    const agentTurns = () => turnRows().filter(row => newestUser(row).includes('캡슐 완료: agent c4 worker'));
    let baselineStarted = 0;
    let parentSubmittedAt = 0;
    let parentSettledAt = 0;
    let urgentPostedAt = 0;
    let urgentDeliveredAt = 0;
    let agentDeliveredAt = 0;
    let urgentAtAgentAlive = false;
    let urgentAgentPid = 0;
    let progressVisible = false;
    let duplicateWindowAt = 0;
    try {
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 40, cols: 100,
        artifactPath: join(ctx.universeRoot, 'c4-agent-seat-pty.json'),
        env: { HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'C4_REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          ELANOUS_TEST_FAKE_LLM_DELAY_MS: REALTIME ? '0' : String(AGENT_HOLD_MS),
          ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow-child',
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([
            { when: 'c4-parent', name: 'Agent', args: { description: 'c4 worker', prompt: 'slow-child task', max_turns: REALTIME ? 5 : 1 } },
            ...(REALTIME ? [{ when: 'slow-child task', calls: [1, 2, 3].map(segment => ({
              name: 'Bash', args: { command: `${segment === 1 ? `: > '${workStartedMarker}'; ` : ''}printf '%s' "$$" > '${workPid}'; for tick in 1 2 3 4; do sleep ${AGENT_SEGMENT_SECONDS / 4}; printf 'C4_WORK_PROGRESS_%s\\n' "$tick"; done; echo ${segment} >> '${workMarker}'${segment === 3 ? `; : > '${workEndedMarker}'` : ''}`, timeout: 500_000 },
            })) }] : []),
          ]) },
        ready: { label: 'boot', until: 'Ctrl+Q quit' },
        onStepInput(label) { if (label === 'parent settled') parentSubmittedAt = Date.now(); },
        steps: [
          { label: 'mail baseline', until: () => { baselineStarted ||= Date.now(); return Date.now() - baselineStarted >= 16_000; }, timeoutMs: 25_000 },
          { label: 'parent settled', text: 'c4-parent', until: screen => {
            progressVisible ||= /⧗ Background|1 background running/.test(screen);
            if (!/Turn done|○ done/.test(screen)) return false;
            parentSettledAt = Date.now();
            return true;
          }, timeoutMs: PARENT_LIMIT_MS },
          { label: 'urgent mail turn', until: screen => {
            progressVisible ||= /⧗ Background|1 background running/.test(screen);
            if (!urgentPostedAt) {
              if (agentTurns().length !== 0) throw new Error('Agent completed before urgent mail arrived');
              const store = new MsgStore(db);
              try { store.post({ from: 'OP', to: SEAT, body: 'C4 urgent request', intent: 'alert', priority: 100 }); }
              finally { store.close(); }
              urgentPostedAt = Date.now();
            }
            if (urgentTurns().length === 0 || !paintedAnswerAfter(screen, 'C4 urgent request')) return false;
            urgentDeliveredAt = Date.now();
            if (REALTIME && existsSync(workPid)) {
              urgentAgentPid = Number(readFileSync(workPid, 'utf8').trim());
              let ps = '';
              try {
                process.kill(urgentAgentPid, 0);
                ps = execFileSync('ps', ['-p', String(urgentAgentPid), '-o', 'pid=,etime=,args='], { encoding: 'utf8' }).trim();
              } catch { /* The missing process is recorded below as a failed observation. */ }
              urgentAtAgentAlive = ps.length > 0 && existsSync(workStartedMarker) && !existsSync(workEndedMarker);
              ctx.recorder.event('c4-urgent-agent-live', { at: urgentDeliveredAt, pid: urgentAgentPid, ps,
                startMarkerPresent: existsSync(workStartedMarker), endMarkerAbsent: !existsSync(workEndedMarker), alive: urgentAtAgentAlive });
            }
            return true;
          }, timeoutMs: URGENT_LIMIT_MS + 3_000 },
          { label: 'Agent completion turn', until: screen => {
            if (agentTurns().length === 0 || !paintedAnswerAfter(screen, '캡슐 완료: agent c4 worker')) return false;
            agentDeliveredAt = Date.now();
            return true;
          }, timeoutMs: AGENT_HOLD_MS + 25_000 + PASSIVE_RESULT_IDLE_WAKE_MS }, // Agent 완료 알림도 idle 120s passive ripen 뒤(#39609·#39666) — #39881 C1 줄포리, C4는 이전 예산이 ripen 전 만료되어 N03 타임아웃.
          { label: 'no duplicate completion', until: () => { duplicateWindowAt ||= Date.now(); return Date.now() - duplicateWindowAt >= 3_000; }, timeoutMs: 8_000 },
        ],
      });
      progressVisible ||= run.frames.some(frame => /⧗ Background|1 background running/.test(frame.screen));
      const urgentCount = urgentTurns().length;
      const agentCount = agentTurns().length;
      const segmentsDone = existsSync(workMarker) ? readFileSync(workMarker, 'utf8').split('\n').filter(Boolean).length : 0;
      const agentRunMs = existsSync(workStartedMarker) && existsSync(workEndedMarker)
        ? statSync(workEndedMarker).mtimeMs - statSync(workStartedMarker).mtimeMs : 0;
      const parentMs = parentSettledAt - parentSubmittedAt;
      const urgentMs = urgentDeliveredAt - urgentPostedAt;
      const scenarioWallMs = Date.now() - scenarioStartedAt;
      ctx.recorder.event('c4-agent-mail', { agentHoldMs: AGENT_HOLD_MS, agentRunMs, segmentsDone, scenarioWallMs, parentMs, urgentMs,
        urgentAtAgentAlive, urgentAgentPid, progressVisible, urgentCount, agentCount,
        urgentBeforeAgent: urgentDeliveredAt < agentDeliveredAt, exitCode: run.exitCode });
      if (run.exitCode !== 0) return { ok: false, reason: 'C4 TUI exited with an error', diff: `exit ${run.exitCode}` };
      if (!parentSubmittedAt || parentMs > PARENT_LIMIT_MS) return { ok: false, reason: 'Agent held the main turn', diff: `parent ${parentMs}ms` };
      if (!urgentPostedAt || urgentMs > URGENT_LIMIT_MS || urgentCount !== 1)
        return { ok: false, reason: 'urgent mail missed its short turn', diff: `urgent ${urgentMs}ms, turns ${urgentCount}` };
      if (agentCount !== 1 || urgentDeliveredAt >= agentDeliveredAt)
        return { ok: false, reason: 'Agent completion did not open one later turn', diff: `agent turns ${agentCount}, urgent before ${urgentDeliveredAt < agentDeliveredAt}` };
      if (REALTIME && segmentsDone !== 3)
        return { ok: false, reason: 'Agent did not complete 20 minutes of work', diff: `segments ${segmentsDone}/3` };
      if (REALTIME && !urgentAtAgentAlive)
        return { ok: false, reason: 'Agent was not alive when urgent mail was answered', diff: `pid ${urgentAgentPid}` };
      if (REALTIME && agentRunMs < 1_200_000)
        return { ok: false, reason: 'Agent work ended before 20 minutes', diff: `${agentRunMs}ms` };
      if (REALTIME && scenarioWallMs < 1_200_000)
        return { ok: false, reason: 'Agent completed before the 20-minute wall', diff: `${scenarioWallMs}ms` };
      if (!progressVisible) return { ok: false, reason: 'Agent progress line was not visible', diff: 'no Background line in PTY frames' };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.recorder.event('c4-agent-mail-failure', { message, urgentPostedAt, urgentCount: urgentTurns().length, agentCount: agentTurns().length });
      if (/timed out waiting for «parent settled»/.test(message)) return { ok: false, reason: 'Agent held the main turn', diff: message };
      if (/timed out waiting for «urgent mail turn»/.test(message)) return { ok: false, reason: 'urgent mail missed its short turn', diff: message };
      if (/timed out waiting for «Agent completion turn»/.test(message)) return { ok: false, reason: 'Agent completion did not open one later turn', diff: message };
      return { ok: false, reason: 'C4 scenario could not complete', diff: message };
    }
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [c4Agent];
