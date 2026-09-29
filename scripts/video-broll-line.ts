#!/usr/bin/env bun
/** Walk the B-roll declaration with a per-slot authoring agent and a measured render. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';
import { writeStdoutJson } from '../src/cli/stdout-json.js';
import { createBrollAgent } from '../src/video-pipeline/broll-agent.js';
import type { BrollAgent, BrollRun } from '../src/video-pipeline/recipes/broll.js';
import { exitCodeOf, formatStep, loadWalker, walkLine } from '../src/video-pipeline/walk-line.js';
import { parseArgv, type FlagKind } from './lib/argv.js';

const FLAGS: Record<string, FlagKind> = {
  '--video': 'value', '--audio': 'value', '--words': 'value', '--clips-dir': 'value',
  '--density': 'value', '--agent': 'value', '--clip-timeout-sec': 'value', '--json': 'bool',
};

export interface BrollLineDeps {
  loadWalker?: typeof loadWalker;
  walk?: typeof walkLine;
  createAgent?: typeof createBrollAgent;
  run?: BrollRun;
  registerLogSink?: typeof registerStandaloneLogSink;
  writeJson?: (line: string) => Promise<void>;
}

export async function main(argv: readonly string[], deps: BrollLineDeps = {}): Promise<number> {
  const parsed = parseArgv(argv, { known: FLAGS, label: 'video-broll-line' });
  const { values, flags } = parsed;
  const backend = values.agent ?? 'codex';
  const density = Number(values.density ?? 5);
  const timeoutSec = Number(values['clip-timeout-sec'] ?? 600);
  const errors = [...parsed.errors];
  if (!values.video) errors.push('--video <경로> 가 필요하다');
  if (Boolean(values.audio) === Boolean(values.words)) errors.push('--audio <경로> 또는 --words <json> 중 하나가 필요하다');
  if (!['codex', 'claude', 'elanous'].includes(backend)) errors.push('--agent 는 codex|claude|elanous 중 하나다');
  if (!Number.isFinite(density) || density <= 0) errors.push('--density 는 양수다');
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) errors.push('--clip-timeout-sec 는 양수다');
  for (const file of [values.video, values.audio, values.words]) {
    if (file && !existsSync(resolve(file))) errors.push(`입력 파일을 찾을 수 없다: ${file}`);
  }
  let words: unknown;
  if (values.words && existsSync(resolve(values.words))) {
    try { words = JSON.parse(readFileSync(resolve(values.words), 'utf8')); }
    catch { errors.push('--words JSON 을 읽을 수 없다'); }
  }
  if (errors.length) { for (const error of errors) console.error(`⛔ ${error}`); return 2; }

  await (deps.registerLogSink ?? registerStandaloneLogSink)('video-broll-line');
  const walker = await (deps.loadWalker ?? loadWalker)();
  if (!walker) { console.error('➖ 워커를 못 찾았다 — GRAPH_WALKER 를 지정하라'); return 2; }
  const { spec, error } = walker.readGraphSpec(join(import.meta.dir, '../graphs/video/broll-line.yaml'));
  if (!spec) { console.error(`⛔ B-roll 선언을 못 읽었다: ${error}`); return 2; }

  const video = realpathSync(resolve(values.video!));
  const requestedDir = resolve(values['clips-dir'] ?? join(homedir(), 'Movies', 'monad', 'broll',
    `${parse(video).name}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(requestedDir, { recursive: true });
  // Recipes compare real paths; on macOS /var is a link to /private/var, so the work folder must be canonical.
  const clipsDir = realpathSync(requestedDir);
  const workdir = clipsDir;
  const agent = (deps.createAgent ?? createBrollAgent)({
    backend: backend as 'codex' | 'claude' | 'elanous', clipsDir,
    skillDir: join(import.meta.dir, '../skills/motion-broll'),
  });
  const state: Record<string, unknown> = {
    base_video: video,
    ...(values.audio ? { audio_path: resolve(values.audio) } : { aligned_words: words }),
    clips_dir: clipsDir,
    density_target: density,
    clip_timeout_ms: timeoutSec * 1000,
    broll_agent: agent satisfies BrollAgent,
    ...(deps.run ? { broll_run: deps.run } : {}),
  };
  const quiet = flags.has('json');
  const result = await (deps.walk ?? walkLine)({ spec, walker, state, workdir,
    onStep: (row) => { if (!quiet) console.log(formatStep(row, 11)); },
  });
  const summary = {
    terminal: result.terminal,
    clips: Array.isArray(state.broll_clips) ? state.broll_clips.length : 0,
    skipped: Array.isArray(state.skipped_clips) ? state.skipped_clips.length : 0,
    rendered_path: typeof state.rendered_path === 'string' ? state.rendered_path : null,
  };
  await (deps.writeJson ?? writeStdoutJson)(JSON.stringify(summary) + '\n');
  return exitCodeOf(result.terminal);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
