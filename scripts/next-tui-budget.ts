#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { collectNextTuiRuntimeClosure, NEXT_TUI_READY_SCREEN_TCL_REGEX } from './lib/next-tui-budget.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../src/tui/core/registry.js';

const root = resolve(import.meta.dir, '..');
const entry = join(root, 'src/tui/entry.ts');
const args = new Set(Bun.argv.slice(2));
const supported = ['--closure', '--startup', '--test', '--rss', '--route'];
const unknown = [...args].filter((arg) => !supported.includes(arg));
if (unknown.length || args.size === 0) {
  console.error(`Usage: bun scripts/next-tui-budget.ts ${supported.join(' | ')}`);
  process.exit(2);
}
if ((args.has('--startup') || args.has('--rss')) && !args.has('--test')) {
  console.error('--startup and --rss require --test to keep the TUI in an isolated universe');
  process.exit(2);
}

function measureTuiStartup(): { startupMs: number; rssKb: number; rssMb: number; action: string; output: string } {
  const universe = mkdtempSync(join(tmpdir(), 'next-tui-budget-'));
  writeFileSync(join(universe, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const expectScript = [
    'set timeout 60',
    'set started [clock milliseconds]',
    'spawn -noecho sh -c {stty rows 40 cols 120; exec bun bin/elanous.mjs --test="$NEXT_TUI_TEST_ROOT" --config-dir "$NEXT_TUI_TEST_ROOT" --tui next}',
    'expect {',
    ` -re {${NEXT_TUI_READY_SCREEN_TCL_REGEX}} {`,
    '  set elapsed [expr {[clock milliseconds]-$started}]',
    '  set children [split [exec pgrep -P [pid]] "\\n"]',
    '  set childpid [lindex $children 0]',
    '  set rss [string trim [exec ps -o rss= -p $childpid]]',
    '  puts "READY_MS=$elapsed RSS_KB=$rss"',
    '  send -- "/help\\r"',
    '  expect {',
    '   -re {Commands} { puts ACTION_OK=help; send -- "\\021"; expect eof }',
    '   timeout { send -- "\\021"; exit 5 }',
    '   eof { exit 4 }',
    '  }',
    ' }',
    ' timeout { exit 3 }',
    ' eof { exit 4 }',
    '}',
  ].join('\n');
  const env = {
    PATH: process.env.PATH,
    TERM: 'xterm-256color',
    HOME: universe,
    LANG: process.env.LANG ?? 'C.UTF-8',
    NEXT_TUI_TEST_ROOT: universe,
    ELANOUS_SKIP_LOGIN_ENV: '1',
    ELANOUS_SESSION_ROOT: join(universe, 'sessions'),
    ELANOUS_TEST_FAKE_LLM: '1',
    ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
  };
  const result = (() => {
    try {
      return spawnSync('expect', ['-c', expectScript], { cwd: root, env, encoding: 'utf8', timeout: 70_000, maxBuffer: 1_000_000 });
    } finally {
      rmSync(universe, { recursive: true, force: true });
    }
  })();
  const output = result.stdout ?? '';
  const ready = /READY_MS=(\d+) RSS_KB=(\d+)/u.exec(output);
  if (result.status !== 0 || !ready || !output.includes('ACTION_OK=help')) {
    throw new Error(`isolated next TUI PTY did not produce a ready screen and /help action (status=${result.status}; ${result.stderr ?? ''}; ${output.slice(-1200)})`);
  }
  const startupMs = Number(ready[1]);
  const rssKb = Number(ready[2]);
  return { startupMs, rssKb, rssMb: Math.round((rssKb / 1024) * 10) / 10, action: 'help rendered', output };
}

function measureRouteP99(): { status: 'measured'; p99Ms: number; routeId: string; samples: number; matched: number } {
  const routeInputs = ['/help', '/new', '도움말', '/signals', '/unknown'];
  const routeId = resolveNextTuiRoute('/help', NEXT_TUI_INPUT_CONTEXT)?.id;
  if (routeId !== 'help.next') throw new Error('next TUI route registry did not resolve /help');
  // Source: one fixed ten-thousand-lookup sample set covers each production route input equally.
  const sampleCount = 10_000;
  const durations = new Float64Array(sampleCount);
  let matched = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    if (resolveNextTuiRoute(routeInputs[index % routeInputs.length]!, NEXT_TUI_INPUT_CONTEXT)) matched += 1;
    durations[index] = performance.now() - start;
  }
  durations.sort();
  // Source: p99 is the nearest-rank 99th percentile of the measured lookup durations.
  const p99Ms = durations[Math.ceil(sampleCount * 0.99) - 1]!;
  return { status: 'measured', p99Ms, routeId, samples: sampleCount, matched };
}

const report: Record<string, unknown> = {
  entry: 'src/tui/entry.ts',
  measuredAt: new Date().toISOString(),
  ...(args.has('--closure') ? { closure: collectNextTuiRuntimeClosure(root, 'src/tui/entry.ts').metric } : {}),
  ...(args.has('--startup') || args.has('--rss') ? {
    live: (() => {
      try {
        const measured = measureTuiStartup();
        return { status: 'measured', startupMs: measured.startupMs, rssKb: measured.rssKb, rssMb: measured.rssMb, action: measured.action };
      } catch (error) { return { status: 'unmeasured', reason: error instanceof Error ? error.message : String(error) }; }
    })(),
  } : {}),
  ...(args.has('--route') ? { route: measureRouteP99() } : {}),
};

console.log(JSON.stringify(report, null, 2));
if ((report.live && (report.live as { status: string }).status !== 'measured') || (report.route && (report.route as { status: string }).status !== 'measured')) {
  process.exitCode = 1;
}
