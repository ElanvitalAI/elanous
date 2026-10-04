import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildDashboardStatusLines, type DashboardStatusLinesInput } from './dashboard-status-lines.js';

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

test('dashboard /status reads current seats and fails closed when the read throws', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const getDashboardStatusLines = () => {');
  const end = source.indexOf('bootDashboardSlashExecutor({', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const status = source.slice(start, end);
  expect(status).toContain('let seatsNow: string | null = null;');
  expect(status).toContain('seatsNowLine(readSlashContextNow([]), Date.now())');
  expect(status).toMatch(/try\s*\{[\s\S]*readSlashContextNow\(\[\]\)[\s\S]*\}\s*catch\s*\(error\)\s*\{[\s\S]*debug\.log\('dashboard\.status', 'seats-unreadable'/);
  expect(status).toContain('return buildDashboardStatusLines({\n      seatsNow,');
});

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
      '연결: 데몬 모름 안 붙음',
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
