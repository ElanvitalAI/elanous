import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { rollupRunUsage } from './run-usage-rollup.js';
import { reemitPtyUsage } from './pty-usage-reemit.js';

test('three Codex turns emit run-scoped PTY usage once across repeated scans and fresh ledger connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-usage-'));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const sinks = spyOn(debug, 'isAnySinkEnabled').mockReturnValue(true);
  try {
    const sessions = join(dir, 'codex', 'sessions', '2026', '09', '26');
    mkdirSync(sessions, { recursive: true });
    const now = new Date().toISOString();
    const lines = [
      { type: 'session_meta', payload: { id: 'fixture-session', cwd: join(dir, 'worktree') }, turn_context: { model: 'gpt-fixture' } },
      ...[[11, 3, 2], [17, 5, 4], [23, 7, 6]].map(([input_tokens, output_tokens, cached_tokens], i) => ({
        ts: now, event_msg: { type: 'token_count', id: `turn-${i}`, token_count: { input_tokens, output_tokens, cached_tokens } },
      })),
    ];
    writeFileSync(join(sessions, 'fixture.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
    const opts = { codexHome: join(dir, 'codex'), runId: 'run-fixture', workdir: join(dir, 'worktree'), sessionId: 'fixture-session', ledgerPath: join(dir, 'ledger.sqlite'),
      role: 'implement', stage: 'implement', account: 'verified-fixture-account' };
    expect(reemitPtyUsage(opts)).toBe(3);
    expect(reemitPtyUsage(opts)).toBe(0);
    expect(reemitPtyUsage({ ...opts, runId: 'another-run' })).toBe(0);
    const rows = log.mock.calls.filter(([category, event]) => category === 'llm.usage' && event === 'llm-usage');
    expect(rows).toHaveLength(3);
    expect(rows.map(([, , data]) => data)).toEqual([0, 1, 2].map((i) => ({
      runId: 'run-fixture', role: 'implement', stage: 'implement', account: 'verified-fixture-account',
      substrate: 'pty', site: 'pty-rollup:codex', turnId: `codex:turn-${i}`,
      model: 'gpt-fixture', provider: 'codex', billingProvider: 'codex', billing: 'subscription',
      inputTokens: [11, 17, 23][i], outputTokens: [3, 5, 7][i], cacheReadInputTokens: [2, 4, 6][i],
      cost: { kind: 'unknown', model: 'gpt-fixture' },
    })));
    const report = rollupRunUsage(rows.map(([, , data]) => data as Parameters<typeof rollupRunUsage>[0][number]));
    expect(report).toMatchObject([{ runId: 'run-fixture', calls: 3, inputTokens: 51, outputTokens: 15, cacheReadInputTokens: 12, unknownCostCalls: 3, usdKnown: 0 }]);
    const otherHome = join(dir, 'other-codex');
    const otherSessions = join(otherHome, 'sessions');
    mkdirSync(otherSessions, { recursive: true });
    writeFileSync(join(otherSessions, 'fixture.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
    expect(reemitPtyUsage({ ...opts, codexHome: otherHome, runId: 'other-run' })).toBe(3);
    expect(log.mock.calls.filter(([category, event]) => category === 'llm.usage' && event === 'llm-usage')).toHaveLength(6);
  } finally {
    log.mockRestore();
    sinks.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping children in one CODEX_HOME keep turns with their own run regardless of exit order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-overlap-'));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const sinks = spyOn(debug, 'isAnySinkEnabled').mockReturnValue(true);
  try {
    const codexHome = join(dir, 'shared');
    const sessions = join(codexHome, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const at = new Date().toISOString();
    for (const [name, workdir, input] of [['first', join(dir, 'worktree-a'), 19], ['second', join(dir, 'worktree-b'), 37]] as const) {
      writeFileSync(join(sessions, `${name}.jsonl`), [
        { type: 'session_meta', payload: { id: name, cwd: workdir } },
        { ts: at, event_msg: { type: 'token_count', id: `${name}-turn`, token_count: { input_tokens: input, output_tokens: 2 } } },
      ].map((line) => JSON.stringify(line)).join('\n'));
    }
    const common = { codexHome, ledgerPath: join(dir, 'ledger.sqlite'), sinceMs: Date.now() - 1000 };
    const a = { ...common, runId: 'run-a', workdir: join(dir, 'worktree-a'), sessionId: 'first' };
    const b = { ...common, runId: 'run-b', workdir: join(dir, 'worktree-b'), sessionId: 'second' };
    expect(reemitPtyUsage(b)).toBe(1);
    expect(reemitPtyUsage(a)).toBe(1);
    expect(reemitPtyUsage(a)).toBe(0);
    expect(reemitPtyUsage(b)).toBe(0);
    writeFileSync(join(sessions, 'ambiguous.jsonl'), [
      { type: 'session_meta', payload: { id: 'third-session', cwd: a.workdir } },
      { ts: at, event_msg: { type: 'token_count', id: 'third-turn', token_count: { input_tokens: 99, output_tokens: 2 } } },
    ].map((line) => JSON.stringify(line)).join('\n'));
    expect(reemitPtyUsage(a)).toBe(0); // Same cwd does not establish which session belongs to this child.
    expect(reemitPtyUsage({ ...a, sessionId: '' })).toBe(0);
    const c = { ...a, runId: 'run-c', sessionId: 'third-session' };
    expect(reemitPtyUsage(c)).toBe(1);
    expect(reemitPtyUsage(c)).toBe(0);
    const rows = log.mock.calls.filter(([category, event]) => category === 'llm.usage' && event === 'llm-usage');
    expect(rows.map(([, , data]) => {
      const usage = data as { runId: string; turnId: string; inputTokens: number };
      return [usage.runId, usage.turnId, usage.inputTokens];
    })).toEqual([
      ['run-b', 'codex:second-turn', 37], ['run-a', 'codex:first-turn', 19], ['run-c', 'codex:third-turn', 99],
    ]);
  } finally {
    log.mockRestore();
    sinks.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
