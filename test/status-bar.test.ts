// ── Status bar tests ──

import { describe, test, expect } from 'bun:test';
import {
  workingDirSegment, sessionCwdSegment, gitSegment, modelSegment,
  contextUsageSegment, tmuxSegment, sshSegment, hostSegment,
  ctxBarSegment, elapsedSegment, costSegment, speedSegment,
  ptyShellCountSegment, runningAgentsSegment, controllerSegment, shellRollupSegment, dockStripSegment, workspaceDockDensityForCols,
  backgroundJobsSegment,
  renderPrimaryStatus, renderSecondaryStatus, renderStatusLines,
  vwSegment,
  type StatusBarState,
} from '../src/status/bar';
import type { ActiveProviderInfo } from '../src/provider-summary';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens';
import { createDashboardMouseWiring, fitStatusSegments, statusSegmentKind, truncateToVisibleWidth, clampPillsToWidth } from '../src/dashboard/input/mouse-wiring';
import { debug } from '../src/debug/log';
import { visibleWidth } from '../src/tui';

function providerInfo(p: Partial<ActiveProviderInfo> = {}): ActiveProviderInfo {
  return {
    provider: p.provider ?? 'openai-codex',
    model: p.model ?? 'gpt-5.4-mini',
    auth: p.auth ?? 'oauth',
    authDetail: p.authDetail ?? 'OAuth — 58min left',
    note: p.note,
  };
}

function strip(s: string): string {
  // Strip ANSI escape sequences for content-level assertions.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('workingDirSegment', () => {
  test('basename only, folder icon', () => {
    expect(strip(workingDirSegment('/Users/me/projects/elanous'))).toContain('📁 elanous');
  });

  test('home directory collapses to ~', () => {
    const saved = process.env.HOME;
    process.env.HOME = '/Users/me';
    expect(strip(workingDirSegment('/Users/me'))).toContain('📁 ~');
    if (saved !== undefined) process.env.HOME = saved;
  });

  test('root fallback when basename empty', () => {
    expect(strip(workingDirSegment('/')).length).toBeGreaterThan(0);
  });
});

describe('sessionCwdSegment', () => {
  test('renders compact parent/current path outside HOME', () => {
    const saved = process.env.HOME;
    process.env.HOME = '/Users/someone-else';
    const s = strip(sessionCwdSegment('/opt/project'));
    expect(s).toContain('📁');
    expect(s).toContain('opt/project');
    if (saved !== undefined) process.env.HOME = saved;
  });

  test('collapses deep HOME path to parent/current', () => {
    const saved = process.env.HOME;
    process.env.HOME = '/Users/me';
    const s = strip(sessionCwdSegment('/Users/me/source/project/foo'));
    expect(s).toContain('📁');
    expect(s).toContain('project/foo');
    if (saved !== undefined) process.env.HOME = saved;
  });

  test('exact HOME collapses to ~', () => {
    const saved = process.env.HOME;
    process.env.HOME = '/Users/me';
    const s = strip(sessionCwdSegment('/Users/me'));
    expect(s).toContain('📁');
    expect(s).toContain('~');
    if (saved !== undefined) process.env.HOME = saved;
  });

  test('keeps the final project segment visible on long paths', () => {
    const long = '/Users/me/a/b/c/d/e/f/g/h/i/j/k/deep-project-name';
    const s = strip(sessionCwdSegment(long, {}, 20));
    expect(s).toContain('deep-project-name');
  });
});

describe('gitSegment', () => {
  test('no branch → "no git"', () => {
    expect(strip(gitSegment('/tmp/nope'))).toContain('no git');
  });

  test('legacy string arg → labeled', () => {
    expect(strip(gitSegment('/tmp', 'main'))).toContain('main');
  });

  test('state object with clean branch', () => {
    const s = strip(gitSegment('/tmp', { branch: 'main', dirtyTotal: 0 }));
    expect(s).toContain('⌥ main');
    expect(s).not.toContain('*');
    expect(s).not.toContain('+');
    expect(s).not.toContain('-');
  });

  test('dirty renders *N suffix', () => {
    const s = strip(gitSegment('/tmp', { branch: 'main', dirtyTotal: 3 }));
    expect(s).toContain('⌥ main');
    expect(s).toContain('*3');
  });

  test('ahead renders +N suffix', () => {
    const s = strip(gitSegment('/tmp', { branch: 'main', ahead: 2 }));
    expect(s).toContain('+2');
  });

  test('behind renders -N suffix', () => {
    const s = strip(gitSegment('/tmp', { branch: 'main', behind: 1 }));
    expect(s).toContain('-1');
  });

  test('dirty + ahead together', () => {
    const s = strip(gitSegment('/tmp', { branch: 'main', dirtyTotal: 3, ahead: 2 }));
    expect(s).toContain('*3');
    expect(s).toContain('+2');
  });

  test('long branch names are truncated for status width stability', () => {
    const s = strip(gitSegment('/tmp', { branch: 'feat/chat-input-focus-and-at-picker', dirtyTotal: 0 }));
    expect(s).toContain('feat/chat-input-foc…');
  });

  test('detached HEAD renders short SHA', () => {
    const s = strip(gitSegment('/tmp', { detachedSha: 'abc1234def5678' }));
    expect(s).toContain('HEAD@abc1234');
  });
});

describe('modelSegment', () => {
  // 2026-05-05 — render rule changed: cloud shows model only (no
  // `provider/` prefix), local shows last segment of the local-llm
  // spec + ` (l)` suffix. Earlier `${provider}/${model}` produced
  // noisy strings like `local/local-llm:local:qwen3.6-...` for the
  // local path; user requested the prefix collapse.
  test('cloud → model only (no provider prefix)', () => {
    const s = strip(modelSegment(providerInfo()));
    expect(s).toContain('gpt-5.4-mini');
    expect(s).not.toContain('openai-codex');
    expect(s).not.toContain('/');
  });

  test('no model → provider name fallback', () => {
    const s = strip(modelSegment(providerInfo({ model: '(none)' })));
    expect(s).not.toContain('(none)');
    expect(s).toContain('openai-codex');
  });

  test('local-llm:<node>:<modelId> → keeps node as local marker (local:<modelId>)', () => {
    const s = strip(modelSegment(providerInfo({
      provider: 'local',
      model: 'local-llm:local:qwen3.6-35b-a3b-ud-mlx',
    })));
    expect(s).toContain('local:qwen3.6-35b-a3b-ud-mlx');
    expect(s).not.toContain('local-llm:');
    expect(s).not.toContain('(l)');
  });

  test('local-llm:<node>:<modelId> on remote node → keeps node name', () => {
    const s = strip(modelSegment(providerInfo({
      provider: 'local',
      model: 'local-llm:node-b:qwen2.5-72b-instruct',
    })));
    expect(s).toContain('node-b:qwen2.5-72b-instruct');
    expect(s).not.toContain('local-llm:');
    expect(s).not.toContain('(l)');
  });

  test('legacy local:<modelId> spec — passes through unchanged', () => {
    const s = strip(modelSegment(providerInfo({
      provider: 'local',
      model: 'local:llama-3-8b',
    })));
    expect(s).toContain('local:llama-3-8b');
    expect(s).not.toContain('(l)');
  });

  test('local provider with bare model (no prefix) → synthesises local: marker', () => {
    const s = strip(modelSegment(providerInfo({
      provider: 'local',
      model: 'tinyllama-1b',
    })));
    expect(s).toContain('local:tinyllama-1b');
    expect(s).not.toContain('(l)');
  });

  // 2026-05-05 — compact mode (caller sets when termCols < 100):
  // truncate model id at the first parameter-size marker (\d+b/B) so
  // the pill still fits on narrow terminals. Node prefix preserved.
  test('compact: local-llm spec truncates at parameter size', () => {
    const s = strip(modelSegment(
      providerInfo({ provider: 'local', model: 'local-llm:local:qwen3.6-35b-a3b-ud-mlx' }),
      { compact: true },
    ));
    expect(s).toContain('local:qwen3.6-35b');
    expect(s).not.toContain('a3b');
    expect(s).not.toContain('ud-mlx');
  });

  test('compact: remote node truncates at parameter size, keeps node', () => {
    const s = strip(modelSegment(
      providerInfo({ provider: 'local', model: 'local-llm:node-b:qwen2.5-72b-instruct' }),
      { compact: true },
    ));
    expect(s).toContain('node-b:qwen2.5-72b');
    expect(s).not.toContain('instruct');
  });

  test('compact: cloud model with no \\d+b marker stays unchanged', () => {
    const s = strip(modelSegment(
      providerInfo({ provider: 'anthropic', model: 'claude-opus-4-6' }),
      { compact: true },
    ));
    expect(s).toContain('claude-opus-4-6');
    expect(s).not.toContain('anthropic');
  });

  test('compact: grok with version dot stays unchanged (no b marker)', () => {
    const s = strip(modelSegment(
      providerInfo({ provider: 'grok', model: 'grok-4.3' }),
      { compact: true },
    ));
    expect(s).toContain('grok-4.3');
  });

  test('compact: 7b / 120B sizes both match (case-insensitive)', () => {
    const s1 = strip(modelSegment(
      providerInfo({ provider: 'local', model: 'local-llm:local:llama-3-7b-instruct' }),
      { compact: true },
    ));
    expect(s1).toContain('local:llama-3-7b');
    expect(s1).not.toContain('instruct');
    const s2 = strip(modelSegment(
      providerInfo({ provider: 'local', model: 'local-llm:local:gpt-oss-120B-quant' }),
      { compact: true },
    ));
    expect(s2).toContain('local:gpt-oss-120B');
    expect(s2).not.toContain('quant');
  });

  test('compact: false (default) keeps full model id', () => {
    const s = strip(modelSegment(
      providerInfo({ provider: 'local', model: 'local-llm:local:qwen3.6-35b-a3b-ud-mlx' }),
    ));
    expect(s).toContain('local:qwen3.6-35b-a3b-ud-mlx');
  });
});

describe('status meta segments', () => {
  test('contextUsageSegment renders used amount only', () => {
    expect(strip(contextUsageSegment(14500))).toBe('ctx 15k');
    expect(strip(contextUsageSegment(950))).toBe('ctx 950');
  });

  test('tmux/ssh/host segments are flat metadata', () => {
    expect(strip(tmuxSegment('workbench'))).toBe('🪟 workbench');
    expect(strip(sshSegment('ssh'))).toBe('↔ ssh');
    expect(strip(hostSegment('mbp'))).toBe('🖥 mbp');
  });
});

describe('ctxBarSegment', () => {
  test('0% filled when used=0', () => {
    const s = strip(ctxBarSegment(0, 1000, 10));
    expect(s).toContain('100% remain');
    expect(s).toContain('0.0k/1k');
    expect(s).toContain('░░░░░░░░░░');
  });

  test('50% fill', () => {
    const s = strip(ctxBarSegment(500, 1000, 10));
    expect(s).toContain('50% remain');
    const filled = (s.match(/█/g) || []).length;
    expect(filled).toBe(5);
  });

  test('over budget clamps to 0% remain', () => {
    const s = strip(ctxBarSegment(2000, 1000, 10));
    expect(s).toContain('0% remain');
  });

  test('max=0 → empty string', () => {
    expect(ctxBarSegment(0, 0)).toBe('');
  });
});

describe('elapsedSegment', () => {
  test('sub-minute: "Xs"', () => {
    expect(strip(elapsedSegment(7))).toContain('7s');
  });

  test('minutes: "Xm Ys"', () => {
    expect(strip(elapsedSegment(135))).toContain('2m 15s');
  });

  test('hours: "Xh 0Ym"', () => {
    expect(strip(elapsedSegment(3720))).toContain('1h 02m');
  });

  test('renderStatusModule migration — icon ⏱ stays in text + visible width preserved', () => {
    // PR-5 migration: visual identity preserved (icon-in-text avoids
    // the inline separator).
    expect(strip(elapsedSegment(7))).toBe('⏱ 7s');
    expect(strip(elapsedSegment(135))).toBe('⏱ 2m 15s');
    expect(strip(elapsedSegment(3720))).toBe('⏱ 1h 02m');
  });

  test('emits raw SGR (truecolor) — chalk-environment-deterministic', () => {
    // Pre-migration the segment used chalk.hex which silently passes
    // through under FORCE_COLOR=0. Post-migration renderStatusModule
    // emits raw \x1b[38;2;r;g;bm regardless.
    const out = elapsedSegment(7);
    expect(out).toContain('\x1b[38;2;');
  });

  test('subtext color: ctp.subtext1 by default (legacy/no-theme path)', () => {
    // ctp.subtext1 = #bac2de → 186,194,222 (Catppuccin Mocha)
    const out = elapsedSegment(7);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out);
    expect(m).not.toBeNull();
    expect(`${m![1]},${m![2]},${m![3]}`).toBe('186,194,222');
  });
});

describe('costSegment / speedSegment', () => {
  test('cost formats 2 decimals', () => {
    expect(strip(costSegment(0))).toContain('$0.00');
    expect(strip(costSegment(1.237))).toContain('$1.24');
  });

  test('speed null → --', () => {
    expect(strip(speedSegment(null))).toContain('--t/s');
  });

  test('speed finite → "X.Xt/s"', () => {
    expect(strip(speedSegment(42.2))).toContain('42.2t/s');
  });

  // ── Pick A PR-S1: renderStatusModule migration ────────────────────

  test('cost: renderStatusModule migration — icon 💰 stays in text + visible width preserved', () => {
    expect(strip(costSegment(0))).toBe('💰 $0.00');
    expect(strip(costSegment(1.237))).toBe('💰 $1.24');
    expect(strip(costSegment(99.99))).toBe('💰 $99.99');
  });

  test('cost: emits raw SGR (truecolor) — chalk-environment-deterministic', () => {
    const out = costSegment(1.5);
    expect(out).toContain('\x1b[38;2;');
  });

  test('cost: subtext color (ctp.subtext1 = 186,194,222) on legacy path', () => {
    const out = costSegment(0);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out);
    expect(m).not.toBeNull();
    expect(`${m![1]},${m![2]},${m![3]}`).toBe('186,194,222');
  });

  test('cost: theme path resolves through statusToneColor("subtext")', () => {
    const out = costSegment(2.5, { theme: DEFAULT_THEME_TOKENS });
    expect(strip(out)).toBe('💰 $2.50');
    // theme path also emits raw SGR — same renderer
    expect(out).toContain('\x1b[38;2;');
  });

  test('speed: renderStatusModule migration — icon 🚀 stays in text + visible width preserved', () => {
    expect(strip(speedSegment(null))).toBe('🚀 --t/s');
    expect(strip(speedSegment(0.1))).toBe('🚀 0.1t/s');
    expect(strip(speedSegment(42.2))).toBe('🚀 42.2t/s');
  });

  test('speed: emits raw SGR (truecolor) — chalk-environment-deterministic', () => {
    const out = speedSegment(5.5);
    expect(out).toContain('\x1b[38;2;');
  });

  test('speed: subtext color (186,194,222) on legacy path', () => {
    const out = speedSegment(null);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out);
    expect(`${m![1]},${m![2]},${m![3]}`).toBe('186,194,222');
  });

  test('speed: NaN / non-finite → "--t/s"', () => {
    expect(strip(speedSegment(Number.NaN))).toBe('🚀 --t/s');
    expect(strip(speedSegment(Number.POSITIVE_INFINITY))).toBe('🚀 --t/s');
  });
});

describe('ptyShellCountSegment', () => {
  test('zero → empty (hidden)', () => {
    expect(ptyShellCountSegment(0)).toBe('');
    expect(ptyShellCountSegment(-1)).toBe('');
  });

  test('singular label for 1', () => {
    const s = strip(ptyShellCountSegment(1));
    expect(s).toContain('⚡ 1 shell');
    expect(s).not.toContain('shells');
  });

  test('plural label for 2+', () => {
    expect(strip(ptyShellCountSegment(2))).toContain('⚡ 2 shells');
    expect(strip(ptyShellCountSegment(8))).toContain('⚡ 8 shells');
  });

  test('theme option preserves content', () => {
    const s = strip(ptyShellCountSegment(3, { theme: DEFAULT_THEME_TOKENS }));
    expect(s).toContain('3 shells');
  });

  // ── Pick A PR-S1: renderStatusModule migration ────────────────────

  test('renderStatusModule migration — icon ⚡ stays in text + visible width preserved', () => {
    expect(strip(ptyShellCountSegment(1))).toBe('⚡ 1 shell');
    expect(strip(ptyShellCountSegment(2))).toBe('⚡ 2 shells');
    expect(strip(ptyShellCountSegment(99))).toBe('⚡ 99 shells');
  });

  test('emits raw SGR (truecolor) — chalk-environment-deterministic', () => {
    const out = ptyShellCountSegment(1);
    expect(out).toContain('\x1b[38;2;');
  });

  test('yellow tone (ctp.yellow = 249,226,175) on legacy path', () => {
    // ctp.yellow = #f9e2af → 249,226,175 (Catppuccin Mocha yellow)
    const out = ptyShellCountSegment(1);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(out);
    expect(m).not.toBeNull();
    expect(`${m![1]},${m![2]},${m![3]}`).toBe('249,226,175');
  });

  test('zero still empty post-migration (early return preserved)', () => {
    expect(ptyShellCountSegment(0)).toBe('');
    expect(ptyShellCountSegment(-5)).toBe('');
  });
});

describe('runningAgentsSegment', () => {
  test('zero and negative counts are hidden', () => {
    expect(runningAgentsSegment(0)).toBe('');
    expect(runningAgentsSegment(-1)).toBe('');
  });

  test('uses a singular label for one running agent', () => {
    expect(strip(runningAgentsSegment(1))).toBe('◇ 1 agent');
  });

  test('uses a plural label and emits ANSI for multiple running agents', () => {
    const out = runningAgentsSegment(3);
    expect(strip(out)).toBe('◇ 3 agents');
    expect(out).toContain('\x1b[38;2;');
  });

  test('theme option preserves content', () => {
    expect(strip(runningAgentsSegment(2, { theme: DEFAULT_THEME_TOKENS }))).toBe('◇ 2 agents');
  });
});

describe('controllerSegment', () => {
  test('renders the external controller as a mauve truecolor module', () => {
    const output = controllerSegment('pty:pty_abcd1234');
    expect(strip(output)).toBe('⛭ pty:pty_abcd1234');
    expect(output).toContain('\x1b[38;2;');
  });

  test('truncates a long controller to 24 characters with an ellipsis', () => {
    const output = strip(controllerSegment('agent:claude-code_2-1-270_agent_extra_long_name'));
    const label = output.slice('⛭ '.length);
    expect(label).toHaveLength(24);
    expect(label).toEndWith('…');
  });

  test('hides undefined and whitespace-only controllers', () => {
    expect(controllerSegment(undefined)).toBe('');
    expect(controllerSegment('   ')).toBe('');
  });
});

describe('DashboardStatusInput controller wiring', () => {
  const buildLine = (controller?: string) => createDashboardMouseWiring({
    termSize: () => ({ rows: 24, cols: 120 }),
    getRotation: () => [],
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: () => ({ dispose: () => {} }),
    redraw: () => {},
  }).buildStatusLine({
    swd: '/Users/test/project',
    providerInfo: providerInfo(),
    runningAgents: 2,
    controller,
  });

  test('places the controller immediately after running agents', () => {
    const line = strip(buildLine('pty:pty_x'));
    expect(line.indexOf('◇ 2 agents')).toBeLessThan(line.indexOf('⛭ pty:pty_x'));
  });

  test('omitting controller preserves the pre-controller status line', () => {
    expect(strip(buildLine())).toBe(' 📁 test/project  │ no git │ gpt-5.4-mini │ ◇ 2 agents');
  });
});

describe('SP-B — shellRollupSegment', () => {
  test('empty when both counts are zero', () => {
    expect(shellRollupSegment({ running: 0, backgrounded: 0 })).toBe('');
  });

  test('running only → 🐚 2▶', () => {
    const s = strip(shellRollupSegment({ running: 2, backgrounded: 0 }));
    expect(s).toBe('🐚 2▶');
  });

  test('backgrounded only → 🐚 1⏸', () => {
    const s = strip(shellRollupSegment({ running: 0, backgrounded: 1 }));
    expect(s).toBe('🐚 1⏸');
  });

  test('both counts → 🐚 2▶ 1⏸', () => {
    const s = strip(shellRollupSegment({ running: 2, backgrounded: 1 }));
    expect(s).toBe('🐚 2▶ 1⏸');
  });

  test('theme option preserves content', () => {
    const s = strip(shellRollupSegment({ running: 1, backgrounded: 0 }, { theme: DEFAULT_THEME_TOKENS }));
    expect(s).toBe('🐚 1▶');
  });
});

describe('TUI-BG-JOB-VISIBILITY — backgroundJobsSegment', () => {
  test('백그라운드 1 → «⧗ 백그라운드 1»', () => {
    expect(strip(backgroundJobsSegment({ background: 1 }))).toBe('⧗ 백그라운드 1');
  });

  test('0 → 세그먼트 없음 (끝나면 사라짐)', () => {
    expect(backgroundJobsSegment({ background: 0 })).toBe('');
    expect(backgroundJobsSegment(null)).toBe('');
    expect(backgroundJobsSegment(undefined)).toBe('');
    expect(backgroundJobsSegment({ background: -1 })).toBe('');
    expect(backgroundJobsSegment({ background: Number.NaN })).toBe('');
  });

  test('theme option preserves content', () => {
    expect(strip(backgroundJobsSegment({ background: 3 }, { theme: DEFAULT_THEME_TOKENS }))).toBe('⧗ 백그라운드 3');
  });
});

describe('TUI-BG-JOB-VISIBILITY — 상태줄 배선', () => {
  const build = (backgroundJobs?: { background: number }) =>
    createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => [],
      setActiveModel: () => {},
      getRecentWds: () => [],
      setSessionWd: () => {},
      pushModalSurface: () => ({ dispose: () => {} }),
      redraw: () => {},
    }).buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: providerInfo(),
      runningAgents: 2,
      controller: 'pty:pty_x',
      ...(backgroundJobs ? { backgroundJobs } : {}),
    });

  test('유휴여도 bg 1 → 상태줄에 «⧗ 백그라운드 1» · 기존 세그먼트 순서 그대로', () => {
    const line = strip(build({ background: 1 }));
    expect(line).toContain('⧗ 백그라운드 1');
    expect(line.indexOf('◇ 2 agents')).toBeLessThan(line.indexOf('⛭ pty:pty_x'));
    expect(line.indexOf('⛭ pty:pty_x')).toBeLessThan(line.indexOf('⧗ 백그라운드 1'));
  });

  test('bg 0 → 줄이 이전과 바이트 동일(ANSI 포함 원본 문자열)', () => {
    expect(build({ background: 0 })).toBe(build());
    expect(strip(build())).not.toContain('⧗');
  });
});

describe('tf-bg-ghost — 상태줄은 프레임 폭을 넘지 않는다', () => {
  // 라이브 결함(10-17 · #28743 head f1a8b9f): «⧗ 백그라운드 1» 이 붙자 160칸 화면의 상태줄이 166칸이 돼
  //   마지막 줄 자동 줄바꿈 → 화면 스크롤 → 차분 렌더러가 모르는 사이 스피너 줄이 유령으로 남았다.
  const wiring = (cols: number) => createDashboardMouseWiring({
    termSize: () => ({ rows: 40, cols }),
    getRotation: () => [],
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: () => ({ dispose: () => {} }),
    redraw: () => {},
  });
  // 라이브 화면과 같은 꼴(긴 작업 트리 · 긴 controller · ctx · host · 🐚).
  const liveInput = (backgroundJobs?: { background: number }) => ({
    swd: '/Users/user/elanous-hq/work/tf-bg-visibility',
    providerInfo: providerInfo({ model: 'gpt-6-luna' }),
    controller: 'agent:claude-code_2-1-270_agent_extra_long_name',
    runningAgents: 2,
    contextUsedTokens: 15_000,
    host: 'MacBookProM5-long-host-label',
    elapsedSec: 125,
    shellCount: 1,
    shellRollup: { running: 1, backgrounded: 0 },
    ...(backgroundJobs ? { backgroundJobs } : {}),
  });

  test('160칸 · bg 1 → 폭 ≤ 159 ⊕ «⧗ 백그라운드 1» 은 남는다', () => {
    const line = wiring(160).buildStatusLine(liveInput({ background: 1 }));
    expect(visibleWidth(line)).toBeLessThanOrEqual(159);
    expect(strip(line)).toContain('⧗ 백그라운드 1');
  });

  test('좁은 화면(100·60·20칸)에서도 폭을 넘지 않는다', () => {
    for (const cols of [100, 60, 20]) {
      const line = wiring(cols).buildStatusLine(liveInput({ background: 2 }));
      expect(visibleWidth(line)).toBeLessThanOrEqual(cols - 1);
    }
  });

  test('반증: 맞춤이 없으면 같은 입력이 폭을 넘는다(이 시험이 무는 조건이 실재)', () => {
    const line = wiring(400).buildStatusLine(liveInput({ background: 1 }));
    expect(visibleWidth(line)).toBeGreaterThan(159);
  });

  test('폭 안이면 줄이 그대로(건너뜀 0)', () => {
    const wide = wiring(400).buildStatusLine(liveInput({ background: 1 }));
    const fit = fitStatusSegments([10, 5, 5], 3, 400);
    expect(fit.dropped).toEqual([]);
    expect(wiring(1000).buildStatusLine(liveInput({ background: 1 }))).toBe(wide);
  });

  test('필수 «⧗» 는 폭이 빠듯해도 남고 앞의 선택 세그먼트가 대신 빠진다', () => {
    // 첫 칸 10 · 선택 30 · 필수 8 · 구분자 3 · 폭 25 → 선택(30)은 필수 몫(3+8)을 남길 수 없어 빠진다.
    const fit = fitStatusSegments([10, 30, 8], 3, 25, [false, false, true]);
    expect(fit.placed.map((p) => p.index)).toEqual([0, 2]);
    expect(fit.dropped).toEqual([1]);
    expect(fit.width).toBeLessThanOrEqual(25);
    // 반증: 필수 표시가 없으면 같은 폭에서 «⧗» 자리(2)가 빠질 수 있다.
    expect(fitStatusSegments([10, 10, 8], 3, 25).dropped).toEqual([2]);
    expect(fitStatusSegments([10, 10, 8], 3, 25, [false, false, true]).placed.map((p) => p.index)).toEqual([0, 2]);
  });

  test('실화면 꼴 · 앞 세그먼트가 길어도 «⧗ 백그라운드 1» 은 남는다(100·80칸)', () => {
    for (const cols of [100, 80]) {
      const line = strip(wiring(cols).buildStatusLine(liveInput({ background: 1 })));
      expect(line).toContain('⧗ 백그라운드 1');
      expect(visibleWidth(line)).toBeLessThanOrEqual(cols - 1);
    }
  });

  test('관측 overflow-fit 은 건너뛴 «종류» 가 바뀔 때만 — 같은 집합의 리사이즈·값 변화엔 다시 안 남긴다', () => {
    const events: Array<Record<string, unknown>> = [];
    const orig = debug.log;
    (debug as { log: typeof debug.log }).log = ((cat: string, ev: string, data?: Record<string, unknown>) => {
      if (cat === 'status.bar' && ev === 'overflow-fit') events.push(data ?? {});
    }) as typeof debug.log;
    try {
      let cols = 120;
      const w = createDashboardMouseWiring({
        termSize: () => ({ rows: 40, cols }),
        getRotation: () => [], setActiveModel: () => {}, getRecentWds: () => [], setSessionWd: () => {},
        pushModalSurface: () => ({ dispose: () => {} }), redraw: () => {},
      });
      const kindsOf = (line: string): string[] =>
        [...new Set(strip(line).split(' │ ').map((seg) => statusSegmentKind(seg)))].sort();
      const line0 = w.buildStatusLine(liveInput({ background: 1 }));
      const first = events.length;
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBe(1);
      expect((events[0]!.dropped as string[]).length).toBeGreaterThan(0);
      // 폭을 한 칸 바꾸고 값(ctx)을 바꿔도 «건너뛴 종류» 가 같으면 다시 안 남긴다.
      cols = 121;
      const line1 = w.buildStatusLine(liveInput({ background: 1 }));
      const line2 = w.buildStatusLine({ ...liveInput({ background: 1 }), contextUsedTokens: 16_000 });
      expect(kindsOf(line1)).toEqual(kindsOf(line0));
      expect(kindsOf(line2)).toEqual(kindsOf(line0));
      expect(events.length).toBe(first);
      // 넉넉해지면(건너뜀 0) 한 줄 · 그 뒤 같은 상태 반복은 0.
      cols = 1000;
      const before = events.length;
      w.buildStatusLine(liveInput({ background: 1 }));
      w.buildStatusLine(liveInput({ background: 1 }));
      expect(events.length).toBe(before + 1);
      expect(events.at(-1)!.dropped).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = orig;
    }
  });

  test('truncateToVisibleWidth — 실폭이 예산 이하가 될 때까지 · 0 이면 빈 문자열', () => {
    const wide = '📁🐚📁🐚📁🐚📁🐚 백그라운드 백그라운드';
    // ⚡ 는 truncate(코드포인트 폭)가 1칸으로 세지만 실폭 2칸 — truncate(…, 5) 가 9칸을 낸다(재시도 상한이 있으면 못 맞춘다).
    const bolts = '⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡';
    for (const budget of [1, 2, 3, 5, 9, 17]) {
      expect(visibleWidth(truncateToVisibleWidth(wide, budget))).toBeLessThanOrEqual(budget);
      expect(visibleWidth(truncateToVisibleWidth(bolts, budget))).toBeLessThanOrEqual(budget);
    }
    expect(truncateToVisibleWidth(wide, 0)).toBe('');
    expect(truncateToVisibleWidth('abc', 10)).toBe('abc');
  });

  test('clampPillsToWidth — 보이는 폭 밖 pill 은 빼고 걸친 pill 은 줄인다', () => {
    const pills = [
      { name: 'workingDir' as const, startCol: 0, endCol: 8 },
      { name: 'model' as const, startCol: 6, endCol: 14 },
      { name: 'mode' as const, startCol: 12, endCol: 16 },
    ];
    expect(clampPillsToWidth(pills, 10)).toEqual([
      { name: 'workingDir', startCol: 0, endCol: 8 },
      { name: 'model', startCol: 6, endCol: 10 },
    ]);
  });

  test('statusSegmentKind — 첫 낱말만', () => {
    expect(statusSegmentKind('\x1b[33mctx 15k\x1b[0m')).toBe('ctx');
    expect(statusSegmentKind('🐚 1⏸')).toBe('🐚');
  });

  test('fitStatusSegments — 넘치는 것만 건너뛰고 뒤의 작은 것은 넣는다 · 첫 칸은 늘 둔다', () => {
    const fit = fitStatusSegments([10, 20, 3], 3, 20);
    expect(fit.placed.map((p) => p.index)).toEqual([0, 2]);
    expect(fit.dropped).toEqual([1]);
    expect(fit.placed[1]).toEqual({ index: 2, startCol: 13, width: 3 });
    expect(fit.width).toBe(16);
    expect(fitStatusSegments([30], 3, 10).placed.map((p) => p.index)).toEqual([0]);
  });
});

describe('U6 — dockStripSegment', () => {
  test('full density includes first label hint', () => {
    const s = strip(dockStripSegment(2, 'Switch model'));
    expect(s).toContain('🗂 2 docked');
    expect(s).toContain('Switch model');
  });

  test('compact density keeps docked count but drops label hint', () => {
    const s = strip(dockStripSegment(2, 'Switch model', { density: 'compact' }));
    expect(s).toContain('🗂 2 parked');
    expect(s).not.toContain('Switch model');
  });

  test('count-only density keeps smallest stable shell', () => {
    const s = strip(dockStripSegment(2, 'Switch model', { density: 'count-only' }));
    expect(s).toContain('🗂 2');
    expect(s).not.toContain('docked');
    expect(s).not.toContain('Switch model');
  });

  test('full density truncates long labels', () => {
    const s = strip(dockStripSegment(1, 'Very long docked window label', {
      density: 'full',
      maxLabelWidth: 10,
    }));
    expect(s).toContain('🗂 1 docked');
    expect(s).toContain('…');
  });

  test('full density includes dormant count when present', () => {
    const s = strip(dockStripSegment(1, 'Switch model', {
      density: 'full',
      dormantCount: 2,
    }));
    expect(s).toContain('🗂 1 docked · 2 dormant');
    expect(s).toContain('Switch model');
  });

  test('dormant-only shell still renders a parked affordance', () => {
    const compact = strip(dockStripSegment(0, 'Search', {
      density: 'compact',
      dormantCount: 1,
    }));
    const full = strip(dockStripSegment(0, 'Search', {
      density: 'full',
      dormantCount: 1,
    }));
    expect(compact).toContain('🗂 1 parked');
    expect(full).toContain('🗂 1 dormant');
  });
});

describe('U6 — workspaceDockDensityForCols', () => {
  test('iPad-scale narrow width falls back to count-only', () => {
    expect(workspaceDockDensityForCols(72)).toBe('count-only');
  });

  test('medium width keeps compact summary', () => {
    expect(workspaceDockDensityForCols(100)).toBe('compact');
  });

  test('wide width keeps full summary', () => {
    expect(workspaceDockDensityForCols(140)).toBe('full');
  });
});

describe('renderPrimaryStatus / renderSecondaryStatus', () => {
  const state: StatusBarState = {
    cwd: '/Users/me/repo',
    providerInfo: providerInfo(),
  };

  test('primary has wd + git + model', () => {
    const s = strip(renderPrimaryStatus(state));
    expect(s).toContain('repo');
    expect(s).toContain('no git');
    expect(s).toContain('gpt-5.4-mini');   // 2026-05-05 modelSegment now shows model only (provider omitted)
  });

  test('primary with elapsed adds the elapsed pill', () => {
    const s = strip(renderPrimaryStatus({ ...state, elapsedSec: 42 }));
    expect(s).toContain('42s');
  });

  test('primary can include context + tmux + host metadata', () => {
    const s = strip(renderPrimaryStatus({
      ...state,
      contextUsedTokens: 15234,
      tmuxLabel: 'workbench',
      host: 'mbp',
    }));
    expect(s).toContain('ctx 15k');
    expect(s).toContain('🖥 mbp');
    expect(s).toContain('🪟 workbench');
    expect(s).not.toContain('↔ ssh');
  });

  test('primary shows ssh metadata only when tmux metadata is absent', () => {
    const s = strip(renderPrimaryStatus({
      ...state,
      sshLabel: 'ssh',
      host: 'mbp',
    }));
    expect(s).toContain('🖥 mbp');
    expect(s).toContain('↔ ssh');
    expect(s).not.toContain('🪟');
  });

  test('primary prefers tmux metadata over ssh metadata', () => {
    const s = strip(renderPrimaryStatus({
      ...state,
      tmuxLabel: 'workbench',
      sshLabel: 'ssh',
      host: 'mbp',
    }));
    expect(s).toContain('🪟 workbench');
    expect(s).not.toContain('↔ ssh');
    expect(s).toContain('🖥 mbp');
  });

  test('secondary empty when no optional stats given', () => {
    expect(renderSecondaryStatus(state)).toBe('');
  });

  test('secondary has ctx + cost + t/s when provided', () => {
    const s = strip(renderSecondaryStatus({
      ...state,
      ctx: { used: 1500, max: 24000 },
      costUsd: 0.15,
      tokensPerSec: 35.5,
    }));
    expect(s).toContain('CTX');
    expect(s).toContain('$0.15');
    expect(s).toContain('35.5t/s');
  });

  test('renderStatusLines skips empty secondary', () => {
    const lines = renderStatusLines(state);
    expect(lines.length).toBe(1);
  });

  test('renderStatusLines returns both when stats present', () => {
    const lines = renderStatusLines({ ...state, ctx: { used: 0, max: 1000 } });
    expect(lines.length).toBe(2);
  });

  test('theme option preserves status content', () => {
    const s = strip(renderPrimaryStatus(state, { theme: DEFAULT_THEME_TOKENS }));
    expect(s).toContain('repo');
    expect(s).toContain('gpt-5.4-mini');   // 2026-05-05 modelSegment now shows model only (provider omitted)
  });
});

describe('VW-U1 vwSegment — virtual-window indicator', () => {
  test('returns empty string when no summary provided', () => {
    expect(vwSegment(null)).toBe('');
  });

  test('returns empty when single window with single pane', () => {
    const out = vwSegment({ windowId: 1, paneIdx: 1, paneTotal: 1, windowTotal: 1 });
    expect(out).toBe('');
  });

  test('renders win:N·P/T when there are multiple panes', () => {
    const out = strip(vwSegment({ windowId: 2, paneIdx: 1, paneTotal: 3, windowTotal: 1 }));
    expect(out).toContain('🪟');
    expect(out).toContain('win:2');
    expect(out).toContain('1/3');
  });

  test('renders the pill when there are multiple windows even in single-pane', () => {
    const out = strip(vwSegment({ windowId: 3, paneIdx: 1, paneTotal: 1, windowTotal: 2 }));
    expect(out).toContain('win:3');
    expect(out).toContain('1/1');
  });

  test('zoomed flag tags the payload', () => {
    const out = strip(vwSegment({
      windowId: 1, paneIdx: 2, paneTotal: 4, windowTotal: 1, zoomed: true,
    }));
    expect(out).toContain('[zoomed 2/4]');
  });

  test('theme option still renders the indicator', () => {
    const out = strip(vwSegment(
      { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 2 },
      { theme: DEFAULT_THEME_TOKENS },
    ));
    expect(out).toContain('win:1');
  });
});
