// [ELN-SEAT-IDLE-QUEUE-STALL] els stall alert — a busy pane that produces no new output for STALL_MS
// alerts the owner (one mail + one receipt line per episode). No journal writes: only `list` + `frame`.

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STALL_MS, startStallAlert, stallAlertBody, stallMsFromEnv, type StallAlertPayload } from '../src/els/stall-alert.js';
import type { ElsCore } from '../src/els/core.js';

function fakeCore(screens: Record<string, string>): { core: ElsCore; screens: Record<string, string> } {
  const core = {
    list: () => ({ exitCode: 0 as const, message: JSON.stringify({ panes: Object.keys(screens).map((pane) => ({
      pane, address: `local:ws/tab/${pane}`, workspace: 'ws', title: `title-${pane}`, state: 'busy', ptyId: `pty-${pane}`,
    })) }) }),
    frame: async (ref: string) => screens[ref] === undefined
      ? { exitCode: 1 as const, message: `unknown ${ref}` }
      : { exitCode: 0 as const, message: screens[ref]! },
  };
  return { core: core as unknown as ElsCore, screens };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('els stall alert', () => {
  test('default stall threshold is 5 minutes', () => {
    expect(DEFAULT_STALL_MS).toBe(5 * 60_000);
  });

  test('a busy screen unchanged past stallMs alerts once (mail + receipt), never again while unchanged', async () => {
    const { core, screens } = fakeCore({ p1: 'Turn running' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 1_000, pollMs: 2, now: () => clock,
      post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);            // a few polls: first sight records the episode start
      expect(posted).toEqual([]);
      clock += 999;               // one ms short of the threshold
      await sleep(20);
      expect(posted).toEqual([]);
      clock += 1;                 // past the threshold
      await sleep(30);
      expect(posted.length).toBe(1);
      expect(posted[0]!.pane).toBe('p1');
      expect(posted[0]!.address).toBe('local:ws/tab/p1');
      expect(posted[0]!.stalledMs).toBeGreaterThanOrEqual(1_000);
      clock += 60_000;            // still the same unchanged screen — no second alert
      await sleep(30);
      expect(posted.length).toBe(1);
      const receipt = readFileSync(join(stateRoot, 'els', 'stall-alerts.jsonl'), 'utf8').trim().split('\n');
      expect(receipt.length).toBe(1);
      const row = JSON.parse(receipt[0]!) as { at: string; pane: string; address: string; stalledMs: number };
      expect(row.pane).toBe('p1');
      expect(row.address).toBe('local:ws/tab/p1');
      expect(row.stalledMs).toBeGreaterThanOrEqual(1_000);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('new output restarts the episode — no alert until the new screen itself stalls', async () => {
    const { core, screens } = fakeCore({ p1: 'Turn running' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 1_000, pollMs: 2, now: () => clock,
      post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      clock += 900;               // almost stalled...
      screens.p1 = 'Turn running\nnew output';  // ...but new output resets the clock
      await sleep(20);
      expect(posted).toEqual([]);
      clock += 900;               // 900ms since the change — no alert yet
      await sleep(20);
      expect(posted).toEqual([]);
      clock += 200;               // past the threshold measured from the change
      await sleep(30);
      expect(posted.length).toBe(1);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('an idle screen never alerts, however long it sits unchanged', async () => {
    const { core } = fakeCore({ p1: 'just a prompt, no turn' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 1, pollMs: 2, now: () => clock,
      post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      clock += 3_600_000;         // an hour of the same idle screen
      await sleep(30);
      expect(posted).toEqual([]);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('a pane that leaves the list is forgotten (no alert for a dead pane)', async () => {
    const { core, screens } = fakeCore({ p1: 'Turn running' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 1_000, pollMs: 2, now: () => clock,
      post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      delete screens.p1;          // the pane exits
      clock += 600_000;           // long past any threshold, but the episode is gone
      await sleep(30);
      expect(posted).toEqual([]);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('stallMs 0 disables the watcher outright', async () => {
    const { core } = fakeCore({ p1: 'Turn running' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 0, pollMs: 2, now: () => clock,
      post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      clock += 3_600_000;
      await sleep(20);
      expect(posted).toEqual([]);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('the mail body is one fact line plus the four rescue lines', () => {
    const body = stallAlertBody({ pane: 'p1', address: 'local:ws/tab/p1', workspace: 'ws', title: 'title-p1',
      stalledMs: 300_000, at: '2026-11-19T00:00:00.000Z' });
    const lines = body.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('[els stall] local:ws/tab/p1 (title-p1)');
    expect(lines[0]).toContain('5min');
    expect(lines[1]).toBe('1. els read p1  # see the last screen with your own eyes');
    expect(lines[2]).toBe('2. els ls  # is the pane still live, which workspace is it in');
    expect(lines[3].startsWith('3. decide:')).toBe(true);
    expect(lines[4]).toContain("els send p1");
  });

  // ---- ELS-STALL-ALERT-FIX (OP #102300 · TC #102306): the RED of 11-19 17:26 — eln's working row ticks every second ----
  function tickingCore(screen: (n: number) => string): ElsCore {
    let n = 0;
    return {
      list: () => ({ exitCode: 0 as const, message: JSON.stringify({ panes: [{ pane: 'p1', address: 'local:ws/tab/p1', workspace: 'ws', title: 'same-tool', state: 'busy', ptyId: 'pty-p1' }] }) }),
      frame: async () => ({ exitCode: 0 as const, message: screen(n++) }),
    } as unknown as ElsCore;
  }
  const SPIN = ['⠋', '⠙', '⠹', '⠸'];

  test('the 17:26 RED: only the spinner and the elapsed tick (sleep 600, threshold 20 s) → one mail + one receipt, no repeat', async () => {
    const core = tickingCore((n) => `\u001b[2m${SPIN[n % 4]} Running Bash(sleep 600) (${n}s • esc to interrupt)\u001b[22m\nTurn running · fake same-tool pane`);
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 20_000, pollMs: 2, now: () => clock, post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      expect(posted).toEqual([]);
      clock += 20_000;
      await sleep(30);
      expect(posted.map((p) => [p.kind, p.tool, p.stalledMs])).toEqual([['no-output', 'Bash', 20_000]]);
      expect(stallAlertBody(posted[0]!).split('\n')[0]).toContain('busy, no new output for 0min');
      clock += 60_000;
      await sleep(30);
      expect(posted).toHaveLength(1);
      expect(readFileSync(join(stateRoot, 'els', 'stall-alerts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('9차-a: a pane redrawing only «⠋ Running Bash(…) (Ns • esc to interrupt)» — no «Turn running» line — alerts once too', async () => {
    // 출처: TC-H-CC-2 evidence ELS-SMALLWINS-L3-1119.md 9차-a (설치본 5cbe95941d3e · 96 s · 영수증 0) — codex/Claude Code 꼴 작업 줄.
    const core = tickingCore((n) => `${SPIN[n % 4]} Running Bash(sleep 600) (${n}s • esc to interrupt)`);
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 20_000, pollMs: 2, now: () => clock, post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      expect(posted).toEqual([]);
      clock += 20_000;
      await sleep(30);
      expect(posted.map((p) => [p.kind, p.tool, p.stalledMs])).toEqual([['no-output', 'Bash', 20_000]]);
      clock += 60_000;
      await sleep(30);
      expect(posted).toHaveLength(1);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('output keeps coming but the same tool stays on the working row for the threshold → one «same tool» mail; another tool starts over', async () => {
    let tool = 'Bash';
    const core = tickingCore((n) => `${SPIN[n % 4]} Running ${tool}(make) (${n}s • esc to interrupt)\nTurn running\nbuild line ${n}`);
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const posted: StallAlertPayload[] = [];
    let clock = 0;
    const alert = startStallAlert(core, { stateRoot, stallMs: 20_000, pollMs: 2, now: () => clock, post: (payload) => { posted.push(payload); } });
    try {
      await sleep(20);
      clock += 20_000;
      await sleep(30);
      expect(posted.map((p) => [p.kind, p.tool])).toEqual([['same-tool', 'Bash']]);
      expect(stallAlertBody(posted[0]!).split('\n')[0]).toContain('busy, the same tool Bash for 0min');
      clock += 60_000;
      await sleep(30);
      expect(posted).toHaveLength(1);
      tool = 'Read';
      await sleep(20);
      clock += 20_000;
      await sleep(30);
      expect(posted.map((p) => [p.kind, p.tool])).toEqual([['same-tool', 'Bash'], ['same-tool', 'Read']]);
    } finally {
      alert.stop();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // ---- JUD-B #103245 must (OP #103256): ELANOUS_ELS_STALL_MS=0 really turns the watcher off — the real path, nothing injected ----
  test('ELANOUS_ELS_STALL_MS: 0 / negative / not a number → the watcher does not start; unset → it starts (no stallMs/post/poll injected)', () => {
    expect([stallMsFromEnv(undefined), stallMsFromEnv(''), stallMsFromEnv('20000'), stallMsFromEnv('0'), stallMsFromEnv('-5'), stallMsFromEnv('off')])
      .toEqual([DEFAULT_STALL_MS, DEFAULT_STALL_MS, 20_000, 0, 0, 0]);
    const { core } = fakeCore({ p1: 'Turn running' });
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const saved = process.env.ELANOUS_ELS_STALL_MS;
    try {
      for (const value of ['0', '-5', 'off']) {
        process.env.ELANOUS_ELS_STALL_MS = value;
        const alert = startStallAlert(core, { stateRoot });          // the production path: only the state root
        expect([value, alert.enabled]).toEqual([value, false]);
        alert.stop();
      }
      delete process.env.ELANOUS_ELS_STALL_MS;
      const on = startStallAlert(core, { stateRoot });
      expect(on.enabled).toBe(true);
      on.stop();
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_ELS_STALL_MS; else process.env.ELANOUS_ELS_STALL_MS = saved;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // JUD-B #103399 FU: the threshold really comes from ELANOUS_ELS_STALL_MS on the start path (stallMs is never injected).
  test('ELANOUS_ELS_STALL_MS positive → that threshold on the start path; empty → the 5-minute default (stallMs not injected)', async () => {
    const saved = process.env.ELANOUS_ELS_STALL_MS;
    const stateRoot = mkdtempSync(join(tmpdir(), 'els-stall-'));
    const run = async (env: string, advance: number): Promise<number> => {
      process.env.ELANOUS_ELS_STALL_MS = env;
      const { core } = fakeCore({ p1: 'Turn running' });
      const posted: StallAlertPayload[] = [];
      let clock = 0;
      const alert = startStallAlert(core, { stateRoot, pollMs: 2, now: () => clock, post: (payload) => { posted.push(payload); } });
      try {
        expect(alert.enabled).toBe(true);
        await sleep(20);
        clock += advance;
        await sleep(30);
        return posted.length;
      } finally { alert.stop(); }
    };
    try {
      expect(await run('1000', 999)).toBe(0);              // one ms short of the env threshold
      expect(await run('1000', 1_000)).toBe(1);            // at it
      expect(await run('', 1_000)).toBe(0);                // empty → the default, not 1 s
      expect(await run('', DEFAULT_STALL_MS)).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_ELS_STALL_MS; else process.env.ELANOUS_ELS_STALL_MS = saved;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
