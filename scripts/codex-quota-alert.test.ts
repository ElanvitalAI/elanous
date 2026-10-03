import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './codex-quota-alert.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./codex-quota-alert.ts', import.meta.url).pathname;

describe('codex quota alert poller log sink', () => {
  test('two balance ticks persist the day ledger without sending a duplicate NT1 state', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-alert-pace-'));
    const rows = { rows: [{ provider: 'codex', accountName: 'team', subscription: { remainingPercent: 0 }, credits: { balance: 100, hasCredits: true, usedPercent: 100 } }] };
    const child = `
      import { mock } from 'bun:test';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = ${JSON.stringify(root)};
      process.env.ELANOUS_STATE_DIR = root;
      const rows = ${JSON.stringify(rows)};
      mock.module(${JSON.stringify(join(import.meta.dir, '../src/domains/outbound-alert.ts'))}, () => ({ sendOutbound: (text) => { console.log('ALERT:' + text); return true; } }));
      const { runCodexQuotaAlert } = await import(${JSON.stringify(script)});
      const readUsage = () => ({ rows: rows.rows });
      const statePath = join(root, 'conatus/codex_quota_alert_state.json');
      await runCodexQuotaAlert({ readUsage, statePath });
      const ledgerPath = join(root, 'budget/codex-credit-day.json');
      const first = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      rows.rows[0].credits.balance = 80;
      await runCodexQuotaAlert({ readUsage, statePath });
      const second = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      console.log('LEDGER:' + JSON.stringify({ first: first.accounts.team, second: second.accounts.team }));
    `;
    try {
      // A separate process confines the child_process and outbound stubs to this poller test.
      const run = spawnSync('bun', ['-e', child], { encoding: 'utf8', cwd: join(import.meta.dir, '..'), env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CODEX_QUOTA_POLICY: 'credits' } });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('LEDGER:');
      expect(JSON.parse(run.stdout.split('LEDGER:')[1]!.trim())).toEqual({ first: { dayOpen: 100, balance: 100 }, second: { dayOpen: 100, balance: 80 } });
      expect(run.stdout).toContain('NT1 상태 동일 또는 경고 조건 없음 — 무발송');
      expect(run.stdout).not.toContain('ALERT:');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('CLI entry registers the prescribed sink before the poller runs', async () => {
    const calls: string[] = [];
    await main({
      ensureCronNodePath: () => { calls.push('path'); },
      registerStandaloneLogSink: async surface => { calls.push(`sink:${surface}`); return true; },
      runCodexQuotaAlert: async () => { calls.push('poll'); },
    });
    expect(calls).toEqual(['path', 'sink:codex-quota-alert', 'poll']);
  });

  test('false sink registration is named and the poller continues', async () => {
    const calls: string[] = [];
    await main({
      ensureCronNodePath: () => { calls.push('path'); },
      registerStandaloneLogSink: async () => false,
      runCodexQuotaAlert: async () => { calls.push('poll'); },
      error: line => { calls.push(`error:${line}`); },
    });
    expect(calls).toEqual([
      'path',
      'error:⚠️ registerStandaloneLogSink(codex-quota-alert) failed; continuing quota poll',
      'poll',
    ]);
  });

  test('thrown sink registration is named and the poller continues', async () => {
    const calls: string[] = [];
    await main({
      ensureCronNodePath: () => { calls.push('path'); },
      registerStandaloneLogSink: async () => { throw new Error('SINK_UNAVAILABLE'); },
      runCodexQuotaAlert: async () => { calls.push('poll'); },
      error: line => { calls.push(`error:${line}`); },
    });
    expect(calls).toEqual([
      'path',
      'error:⚠️ registerStandaloneLogSink(codex-quota-alert) failed; continuing quota poll: SINK_UNAVAILABLE',
      'poll',
    ]);
  });

  test('importing the poller module has no standalone sink side effect', () => {
    const entry = join(import.meta.dir, './codex-quota-alert.ts');
    const sink = join(import.meta.dir, '../src/domains/standalone-log-sink.ts');
    const probe = `
      import { mock } from 'bun:test';
      let calls = 0;
      mock.module(${JSON.stringify(sink)}, () => ({
        registerStandaloneLogSink: async () => { calls++; return true; },
      }));
      await import(${JSON.stringify(entry)});
      console.log(JSON.stringify({ calls }));
    `;
    const run = spawnSync('bun', ['-e', probe], { cwd: join(import.meta.dir, '..'), encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout.trim())).toEqual({ calls: 0 });
  });

  test('the poller source calls registerStandaloneLogSink("codex-quota-alert") before observations', () => {
    const source = readFileSync(script, 'utf8');
    const sinkCall = "registerStandaloneLogSink)('codex-quota-alert')";
    expect(source).toContain("import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';");
    expect(source).toContain(sinkCall);
    expect(source.indexOf(sinkCall)).toBeLessThan(source.indexOf('runCodexQuotaAlert)()'));
    expect(source).toContain('if (import.meta.main) await main();');
  });
});
