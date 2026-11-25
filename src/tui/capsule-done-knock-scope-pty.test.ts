import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import {
  TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_RESPONSE_RULES_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
} from '../ux-sim/fake-llm.js';
import { TEST_FIXED_SEARCH_ENV, TEST_FIXED_SEARCH_HITS } from '../web-search/test-fixed-search.js';

// CAPSULE-DONE-KNOCK-SCOPE — ONE real Next TUI session, one run id:
//  (1) a research turn runs its INTERNAL fanout (three awaited Agent workers, answered from the fixed test search provider)
//      → no `capsule-done` frame, no automatic turn;
//  (2) a DIRECT background Agent (the model's own Agent call with run_in_background) → exactly one `capsule-done` frame and
//      exactly one automatic turn (positive control — proves the detector can see a knock at all).
// Evidence = the same run's logs.db rows (data.runId) plus the screen. No fixed sleeps: every wait polls with a deadline.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const FANOUT_ASK = 'FANOUT-GO what is the latest fixed widget standard news';
const BG_ASK = 'BG-GO start the background probe';
const [ALPHA, BETA] = TEST_FIXED_SEARCH_HITS;
const FINDING = `Fixed finding: [${ALPHA.title}](${ALPHA.url}) and [${BETA.title}](${BETA.url})`;

const preparation = JSON.stringify({
  route: { needsFreshFacts: true, needsCitations: true, localOnly: false, reason: 'fixed test route' },
  outputContract: {
    deliverable: 'Fixed memo', format: 'Short memo',
    sections: [{ id: 'findings', title: 'Findings', purpose: 'State the fixed findings.' }],
    completionCriteria: ['Every finding cites a fixed source.'],
  },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: index + 1, prompt: `fixed question ${index + 1}`, searchTerms: [`fixed term ${index + 1}`], sectionId: 'findings',
  })),
});

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

// Rows are ordered by (ts_ms, id) — a stable total order; comparisons below are non-strict so a same-millisecond tie never flips them.
// Rows are ordered by their own timestamp: row ids follow insertion order, and the TUI and its chat child flush separately.
interface Row { at: number; id: number; category: string; event: string; data: Record<string, unknown> }

function runRows(root: string, runId: string): Row[] {
  const store = LogStore.openReadOnly(join(root, 'logs', 'logs.db'));
  try {
    return store.query({ limit: 20_000 })
      .map((row) => ({ at: row.ts_ms, id: row.id, category: row.category, event: row.event, data: row.data ? JSON.parse(row.data) as Record<string, unknown> : {} }))
      .filter((row) => row.data.runId === runId)
      .sort((a, b) => a.at - b.at || a.id - b.id);
  } finally { store.close(); }
}

test('internal fanout completion opens no automatic turn; a direct background Agent opens exactly one', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'capsule-knock-'));
  const runId = `capsule-knock-${Date.now().toString(36)}`;
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const marks: Record<string, string> = {};
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, runId: `ux-${runId}`, rows: 40, cols: 130,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_RUN_ID: runId,
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'REPLY-OTHER',
        [TEST_FIXED_SEARCH_ENV]: '1',
        // The newest user message that carries a marker picks the first matching rule, so the narrow markers come first.
        [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify([
          { when: 'single preparation call', text: preparation },
          { when: 'Research this question from the angle', text: FINDING },
          { when: 'BGPROBE', text: 'CHILD-BG-DONE' },
          { when: 'capsule:', text: 'REPLY-KNOCK' },
          { when: 'FANOUT-GO', text: 'REPLY-FANOUT' },
          { when: 'BG-GO', text: 'REPLY-BG' },
        ]),
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify([
          { when: 'Research this question from the angle', name: 'OmniSearch', args: { query: 'fixed widget standard' } },
          { when: 'BG-GO', name: 'Agent', args: { description: 'bg probe', prompt: 'BGPROBE run in the background', reason: 'fixture', run_in_background: true } },
        ]),
        // Only the background child is slow, so its completion lands after its own turn has gone idle.
        [TEST_FAKE_LLM_DELAY_MS_ENV]: '4000', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: 'BGPROBE',
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen), timeoutMs: 120_000 },
      steps: [
        { label: 'internal fanout turn answers', text: FANOUT_ASK, timeoutMs: 240_000,
          until: (screen) => { marks.fanout = screen; return screen.includes('REPLY-FANOUT'); } },
        { label: 'direct background Agent turn answers', text: BG_ASK, timeoutMs: 240_000,
          until: (screen) => { marks.bg = screen; return screen.includes('REPLY-BG'); } },
        { label: 'the one automatic turn answers', text: '', enter: false, timeoutMs: 240_000,
          until: (screen) => { marks.knock = screen; return screen.includes('REPLY-KNOCK'); } },
      ],
    });
    expect(run.exitCode).toBe(0);

    const rows = runRows(root, runId);
    const starts = rows.filter((row) => row.event === 'turn-life:turn-start');
    const human = starts.filter((row) => row.data.door === 'human');
    const automatic = starts.filter((row) => row.data.door !== 'human');
    const workers = rows.filter((row) => row.category === 'agent.done' && String(row.data.agent).startsWith('research-'));
    const served = rows.filter((row) => row.category === 'research.search' && row.event === 'provider-complete');
    const emitted = rows.filter((row) => row.event === 'turn-life:capsule-done-emitted');
    const knocks = rows.filter((row) => row.event === 'turn-life:capsule-done-knock');

    // The fanout really ran in turn 1: three research workers finished (awaited) on the fixed provider, before turn 2 began.
    const turn2 = human[1]!.at;
    expect(human).toHaveLength(2);
    expect(workers.filter((row) => row.at <= turn2).map((row) => row.data.agent).sort())
      .toEqual(['research-counterevidence', 'research-news-filings', 'research-primary-data']);
    expect(workers.filter((row) => row.at <= turn2).every((row) => row.data.taskState === 'done')).toBe(true);
    expect(served.filter((row) => row.data.provider === 'exa' && Number(row.data.hits) > 0).length).toBeGreaterThan(0);
    // No real model was reachable: every provider resolution of the run is the fake one.
    const resolved = rows.filter((row) => row.category === 'research.turn' && row.event === 'provider-resolved');
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((row) => row.data.provider === 'test-fake-llm')).toBe(true);
    // Internal fanout: no automatic turn between its completion and the next human turn, and no capsule frame for its workers.
    expect(automatic.filter((row) => row.at <= turn2)).toHaveLength(0);
    // Positive control: the direct background Agent is the ONE capsule frame, one knock, one automatic turn, after its own turn.
    expect(emitted).toHaveLength(1);
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.data.capsuleId).toBe(emitted[0]!.data.capsuleId);
    // Attribution: the capsule and the knock belong to the DIRECT Agent call the test asked for — the one background spawn
    // (its task id, logged at start) whose dispatch was the 'bg probe' request, and that same task is what finished.
    const dispatched = rows.filter((row) => row.category === 'agent.spawn' && row.event === 'dispatch' && row.data.description === 'bg probe');
    const bgStarts = rows.filter((row) => row.category === 'agent.spawn' && row.event === 'background');
    const bgDone = rows.filter((row) => row.category === 'agent.done' && row.event === 'background-finish');
    expect(dispatched).toHaveLength(1);
    expect(bgStarts).toHaveLength(1);
    expect(bgStarts[0]!.data.cid).toBe(dispatched[0]!.data.cid);
    const directTaskId = String(bgStarts[0]!.data.taskId);
    expect(directTaskId.length).toBeGreaterThan(0);
    expect(emitted[0]!.data.capsuleId).toBe(directTaskId);
    expect(knocks[0]!.data.capsuleId).toBe(directTaskId);
    expect(bgDone.map((row) => row.data.taskId)).toEqual([directTaskId]);
    expect(bgDone[0]!.data.taskState).toBe('done');
    // Negative control: the three research workers (by agent id) have no capsule frame and no knock; the only capsule is the direct one.
    const workerIds = ['research-counterevidence', 'research-news-filings', 'research-primary-data'];
    const workerSpawns = rows.filter((row) => row.category === 'agent.spawn' && row.event === 'dispatch' && workerIds.includes(String(row.data.resolvedAgent)));
    expect([...new Set(workerSpawns.map((row) => row.data.resolvedAgent))].sort()).toEqual(workerIds);
    const workerCids = new Set(workerSpawns.map((row) => row.data.cid));
    for (const id of workerIds) {
      expect(emitted.filter((row) => row.data.agent === id || row.data.label === id)).toHaveLength(0);
      expect(workers.filter((row) => row.data.agent === id && row.data.taskState === 'done').length).toBeGreaterThan(0);
    }
    expect(rows.filter((row) => row.category === 'agent.spawn' && row.event === 'background' && workerCids.has(row.data.cid))).toHaveLength(0);
    expect(emitted.filter((row) => row.at <= turn2)).toHaveLength(0);
    expect(knocks.filter((row) => row.at <= turn2)).toHaveLength(0);
    expect(emitted.map((row) => row.data.capsuleId)).toEqual([directTaskId]);
    expect(automatic).toHaveLength(1);
    expect(automatic[0]!.at).toBeGreaterThanOrEqual(turn2);
    expect(automatic[0]!.id).toBeGreaterThan(human[1]!.id);
    expect(marks.fanout).not.toContain('REPLY-KNOCK');
    expect(marks.knock).toContain('REPLY-KNOCK');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);
