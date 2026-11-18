#!/usr/bin/env bun
// NEXT-TUI-UX-SIM-PACK — `bun scripts/ux-sim/next-tui-ux-pack.ts [--scenario a,b] [--width 120,60] [--compare classic] [--out dir]`
// Scripted fake-LLM turns → real Next TUI in a real PTY + headless terminal → frame text/ANSI → declared judges.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDir, runUxPackScenario, UX_PACK_SCENARIOS, uxPackSummary, type UxPackResult } from '../../src/ux-sim/next-tui-ux-pack.js';

const repoRoot = resolve(import.meta.dir, '..', '..');
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const list = (value: string | undefined) => value?.split(',').map((item) => item.trim()).filter(Boolean);

const known = new Set(UX_PACK_SCENARIOS.map((scenario) => scenario.id));
const requested = list(option('scenario')) ?? [...known];
const unknown = requested.filter((id) => !known.has(id));
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(', ')} · known: ${[...known].join(', ')}`);
  process.exit(2);
}
// 출처: seat-state/ELN-DOGFOOD/ASK-NEXT-TUI-UX-SIM-PACK-1117.md — default widths 120 and 60.
const widths = (list(option('width')) ?? ['120', '60']).map(Number);
if (widths.some((width) => !Number.isInteger(width) || width < 20)) {
  console.error('--width takes comma-separated column counts');
  process.exit(2);
}
// 출처: src/tui/entry-tool-flow-pty.test.ts rows — enough history above the composer for every scenario.
const rows = Number(option('rows') ?? '40');
const surfaces: ('next' | 'classic')[] = option('compare') === 'classic' ? ['next', 'classic'] : ['next'];
const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
const hqPack = join(homedir(), 'elanous-hq', 'seat-state', 'UX', 'ux-pack');
const outDir = resolve(option('out') ?? (existsSync(join(homedir(), 'elanous-hq', 'seat-state')) ? hqPack : join(repoRoot, '.ux-pack')), sha);
ensureDir(outDir);

const results: UxPackResult[] = [];
for (const id of requested) {
  const scenario = UX_PACK_SCENARIOS.find((candidate) => candidate.id === id)!;
  for (const cols of widths) {
    for (const tui of surfaces) {
      const started = Date.now();
      const result = await runUxPackScenario({ scenario, cols, rows, outDir, repoRoot, tui });
      results.push(result);
      const verdict = result.error ? `✗ error ${result.error}` : result.judges.every((judge) => judge.pass) ? '✓' : '✗';
      console.log(`${verdict}  ${id} · ${tui} · ${cols} cols · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
}
const summary = uxPackSummary(results, `# Next TUI UX pack · ${sha} · ${new Date().toISOString()}`);
writeFileSync(join(outDir, 'summary.md'), summary);
console.log(`\n${summary}\nframes: ${outDir}`);
process.exit(results.some((result) => result.error || result.judges.some((judge) => !judge.pass)) ? 1 : 0);
