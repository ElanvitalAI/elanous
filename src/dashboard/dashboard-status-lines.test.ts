import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboardStatusLines, dashboardStatusSummaryLines, type DashboardStatusLinesInput } from './dashboard-status-lines.js';
import { renderDashboardStatusLines } from './index.js';
import { executeImmediateDashboardSlash } from './input/slash-executor.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { seatLedgerPath } from '../seat-loop/seat-loop.js';
import * as runningRuns from '../self-implement/running-runs.js';
import { bunSpawnPty } from '../pty-shell/bun-native-pty.js';

const input: DashboardStatusLinesInput = {
  provider: 'openai-codex',
  model: 'gpt-6',
  reasoning: 'high',
  daemonAddress: 'wss://daemon.example:443/acp?token=secret',
  daemonConnected: true,
  accountName: 'work',
  sessionSurfaceLines: ['surface: chat', 'session: local'],
  view: 'V1',
  focus: 'input',
  cwd: '/tmp/work',
  preview: 'file',
  starterClosed: 'none',
  chatOnly: 'off',
  acp: 'idle',
};

test('dashboard /status renders a seat without scanning run ledgers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-seats-'));
  const previousOverride = getElanousConfigDirOverride();
  const now = new Date();
  const query = spyOn(runningRuns, 'queryRunningRuns');
  setElanousConfigDir(root);
  try {
    mkdirSync(join(root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(seatLedgerPath('TC', root, now), JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'working',
      item: { source: 'checklist', id: 'TUI-STATUS', title: 'Seat ledger visible' } }) + '\n');
    const result = executeImmediateDashboardSlash({ name: 'status', args: [] }, {
      getStatusLines: () => renderDashboardStatusLines(input, now.getTime()),
    });
    expect(result?.logLines).toContain('지금 자리들: CTO Seat ledger visible · 방금');
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    if (previousOverride) setElanousConfigDir(previousOverride);
    else resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('booted dashboard dispatches its registered /status without a run scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-status-boot-'));
  try {
    const child = bunSpawnPty(process.execPath, [join(import.meta.dir, '../../test/fixtures/dashboard-status-boot.fixture.ts')], {
      env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), DASHBOARD_STATUS_TEST_ROOT: root } as Record<string, string>,
      cols: 80,
      rows: 24,
    });
    let output = '';
    const code = await new Promise<number | null>((resolve) => {
      child.onData(chunk => { output += chunk; });
      child.onExit(event => resolve(event.exitCode));
    });
    if (code !== 0) throw new Error(`booted /status exited ${code}: ${output}`);
    expect(output).toContain('DASHBOARD_STATUS_PROBE={"seatVisible":true,"queryCalls":0}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

describe('buildDashboardStatusLines', () => {
  test('puts model, daemon attachment and account first, preserving all detailed lines', () => {
    expect(buildDashboardStatusLines(input)).toEqual([
      '모델: openai-codex/gpt-6 (high)',
      '연결: 데몬 wss://daemon.example 붙음',
      '계정: work',
      '',
      '자세히',
      '  surface: chat',
      '  session: local',
      '  view: V1',
      '  focus: input',
      '  cwd: /tmp/work',
      '  preview: file',
      '  starterClosed: none',
      '  chatOnly: off',
      '  acp: idle',
    ]);
  });

  test('inserts the current seats immediately after account and preserves the remaining lines', () => {
    const baseline = buildDashboardStatusLines(input);
    const seatsNow = '지금 자리들: CTO Context door · 3분 전';
    expect(buildDashboardStatusLines({ ...input, seatsNow })).toEqual([
      ...baseline.slice(0, 3), seatsNow, ...baseline.slice(3),
    ]);
    expect(buildDashboardStatusLines({ ...input, seatsNow: null })).toEqual(baseline);
  });

  test('unknown model, address and unverified account are explicit', () => {
    const lines = buildDashboardStatusLines({ ...input, provider: ' ', model: null, reasoning: undefined, daemonAddress: undefined, daemonConnected: false, accountName: undefined });
    expect(lines.slice(0, 3)).toEqual([
      '모델: 모름/모름 (모름)',
      '연결: 혼자 돎(데몬 없음)',
      '계정: 모름',
    ]);
    expect(buildDashboardStatusLines({ ...input, accountName: '  ' })[2]).toBe('계정: 모름');
  });

  test('a non-Codex provider without a verified account does not claim the default account', () => {
    expect(buildDashboardStatusLines({ ...input, provider: 'anthropic', accountName: undefined })[2]).toBe('계정: 모름');
  });

  test('the confirmed default Codex account is shown as 기본', () => {
    expect(buildDashboardStatusLines({ ...input, accountName: 'default' })[2]).toBe('계정: 기본');
  });

  test('never exposes daemon URL credentials, token or query values', () => {
    const lines = buildDashboardStatusLines({
      ...input,
      daemonAddress: 'wss://user:password@daemon.example:8443/acp?api_key=secret#fragment',
    });
    expect(lines[1]).toBe('연결: 데몬 wss://daemon.example:8443 붙음');
    expect(lines.join('\n')).not.toMatch(/password|secret|api_key|fragment/);
  });
});

describe('TUI-SLASH-DECIDE-NOW C — /status default is human words, --debug adds the detail block', () => {
  const getStatusLines = () => buildDashboardStatusLines(input);

  test('default: model · connection · account only, no internal field names', () => {
    const result = executeImmediateDashboardSlash({ name: 'status', args: [] }, { getStatusLines });
    expect(result?.logLines).toEqual([
      '모델: openai-codex/gpt-6 (high)',
      '연결: 데몬 wss://daemon.example 붙음',
      '계정: work',
      '  자세히: /status --debug',
    ]);
    expect(result!.logLines!.join('\n')).not.toMatch(/surface:|chatOnly|acp:|starterClosed/);
    // The seats line is part of the default view.
    const seatsNow = '지금 자리들: CTO Context door · 3분 전';
    expect(dashboardStatusSummaryLines(buildDashboardStatusLines({ ...input, seatsNow })).slice(0, 4)).toEqual([
      '모델: openai-codex/gpt-6 (high)', '연결: 데몬 wss://daemon.example 붙음', '계정: work', seatsNow,
    ]);
    expect(executeImmediateDashboardSlash({ name: 'st', args: [] }, { getStatusLines })?.logLines)
      .toEqual(result?.logLines);
  });

  test('--debug: the full block, unchanged', () => {
    const result = executeImmediateDashboardSlash({ name: 'status', args: ['--debug'] }, { getStatusLines });
    expect(result?.logLines).toEqual(buildDashboardStatusLines(input));
    expect(result!.logLines!).toContain('자세히');
    expect(result!.logLines!).toContain('  chatOnly: off');
    expect(executeImmediateDashboardSlash({ name: 'status', args: ['--verbose'] }, { getStatusLines })).toBeNull();
  });

  test('no daemon: plain words, never «데몬 모름 안 붙음»', () => {
    const lines = buildDashboardStatusLines({ ...input, daemonAddress: undefined, daemonConnected: false });
    expect(lines[1]).toBe('연결: 혼자 돎(데몬 없음)');
    expect(buildDashboardStatusLines({ ...input, daemonAddress: 'not a url', daemonConnected: false })[1]).toBe('연결: 혼자 돎(데몬 없음)');
    expect(buildDashboardStatusLines({ ...input, daemonAddress: undefined, daemonConnected: true })[1]).toBe('연결: 데몬 붙음');
    expect(buildDashboardStatusLines({ ...input, daemonConnected: false })[1]).toBe('연결: 데몬 wss://daemon.example 안 붙음');
    const summary = dashboardStatusSummaryLines(lines).join('\n');
    expect(summary).not.toContain('데몬 모름');
    expect(summary).not.toContain('모름 안 붙음');
  });

  test('lines without a detail block pass through untouched', () => {
    expect(dashboardStatusSummaryLines(['Dashboard status', '  view: log'])).toEqual(['Dashboard status', '  view: log']);
  });
});
