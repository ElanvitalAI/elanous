import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';
import { Database } from 'bun:sqlite';
import { ensureBacktestTables } from '../src/domains/backtest-store.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./retro-cycle.ts', import.meta.url).pathname;

function runRetro(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'retro-cycle-test-'));
  try {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('retro cycle flags', () => {
  it('recognizes only the supported injected argv while consuming the period value', () => {
    const contract = {
      boolean: ['--collect-only'],
      valued: ['--period'],
    } as const;

    expect(unknownCronFlag(['--period', 'monthly', '--collect-only'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-onlyy'], contract)).toBe('--collect-onlyy');
    expect(unknownCronFlag(['--period', '--collect-only'], { boolean: ['--collect-only'], valued: [] })).toBe('--period');
  });

  it('rejects an unknown flag before the retro cycle starts', () => {
    const result = runRetro('--collect-onlyy');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('⛔ 모르는 플래그: --collect-onlyy');
    expect(output).not.toContain('retro weekly:');
  });

  // ⛔ 이 PR 이 «고친 것»이 바로 이 성질이다 — 초안은 모듈 최상위 `throw` 라 크론 로그로
  //   스택 트레이스가 샜다. 「거부한다」만 물면 그 회귀를 «못 잡는다».
  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runRetro('--collect-onlyy');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('retro-cycle.ts:');
  });

  it('places the shared guard before period parsing and retro side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--collect-only'], valued: ['--period'] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("const pIdx = process.argv.indexOf('--period');"));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('mkdirSync(REPORT_DIR'));
  });

  it('preserves the default weekly fallback and monthly parsing in the top-level argv contract', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("const period = (pIdx >= 0 ? process.argv[pIdx + 1] : 'weekly') as RetroPeriod;");
    expect(source).toContain("if (!['weekly', 'monthly', 'quarterly', 'annual'].includes(period))");
  });

  it('carries the entrypoint runId through JSON, autonomy refs and registered lifecycle logs with and without a proposal', () => {
    const root = mkdtempSync(join(tmpdir(), 'retro-cycle-e4-entrypoint-'));
    try {
      for (const includeProposal of [false, true]) {
        const caseRoot = join(root, includeProposal ? 'proposal' : 'no-proposal');
        const home = join(caseRoot, 'home');
        const state = join(caseRoot, 'state');
        const config = join(caseRoot, 'config');
        const conatus = join(caseRoot, 'conatus');
        for (const dir of [home, state, config, conatus]) mkdirSync(dir, { recursive: true });

        if (includeProposal) {
          const backtest = new Database(join(conatus, 'backtest.db'));
          try {
            ensureBacktestTables(backtest);
            backtest.prepare('INSERT INTO portfolio_experiments (id, run_date, concept, strategy) VALUES (?, ?, ?, ?)')
              .run('mock-exp-1', '2026-11-01', 'momentum-ts', 'mock-strategy');
            backtest.prepare('INSERT INTO promotions (ts, exp_id, stage, reason, observe_days, decided_by, fund) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run('2026-11-01T00:00:00.000Z', 'mock-exp-1', 'live-candidate', 'fixture only', 0, 'test', 'mock');
          } finally { backtest.close(); }
        }

        const result = spawnSync(process.execPath, [script, '--collect-only', '--period', 'weekly'], {
          cwd: new URL('..', import.meta.url).pathname,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: root,
            ELANOUS_STATE_DIR: state,
            ELANOUS_CONFIG_DIR: config,
            CONATUS_DATA_DIR: conatus,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as { runId: string; hasProposal: boolean };
        expect(report.runId).toMatch(/^retro-/);
        expect(report.hasProposal).toBe(includeProposal);

        const actions = new Database(join(state, 'surface_events.db'), { readonly: true });
        let actionRefs: { runId?: string; reportPath?: string };
        try {
          const row = actions.prepare("SELECT refs FROM events WHERE domain='elanous' AND kind='autonomy' ORDER BY ts DESC LIMIT 1")
            .get() as { refs?: string } | null;
          expect(row?.refs).toBeDefined();
          actionRefs = JSON.parse(row!.refs!) as { runId?: string; reportPath?: string };
        } finally { actions.close(); }
        expect(actionRefs!.runId).toBe(report.runId);
        expect(actionRefs!.reportPath).toBe((JSON.parse(result.stdout) as { reportPath: string }).reportPath);

        const logs = new Database(join(state, 'logs', 'logs.db'), { readonly: true });
        try {
          const rows = logs.prepare("SELECT event, data FROM logs WHERE category='retro.cycle' ORDER BY id")
            .all() as Array<{ event: string; data: string }>;
          const lifecycle = rows.map((row) => ({ event: row.event, data: JSON.parse(row.data) as { runId?: string } }));
          expect(lifecycle.map((item) => item.event)).toEqual(includeProposal ? ['collected', 'proposed'] : ['collected']);
          expect(lifecycle.every((item) => item.data.runId === report.runId)).toBe(true);
        } finally { logs.close(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
