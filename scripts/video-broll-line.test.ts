import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './video-broll-line.js';
import { BROLL } from '../src/video-pipeline/recipes/broll.js';
import { CHARACTER } from '../src/video-pipeline/recipes/character.js';
import { FILM } from '../src/video-pipeline/recipes/film.js';
import { FREE_LINE } from '../src/video-pipeline/recipes/free-line.js';
import { HYPERFRAMES } from '../src/video-pipeline/recipes/hyperframes.js';
import { UPSTREAM } from '../src/video-pipeline/recipes/upstream.js';
import { VLOG } from '../src/video-pipeline/recipes/vlog.js';
import { ALL_RECIPES, DEFAULT_WALKER, loadWalker, walkLine, type GraphSpecLike, type WalkerApi } from '../src/video-pipeline/walk-line.js';

const walker: WalkerApi = {
  readGraphSpec: (path) => ({ spec: parseYaml(readFileSync(path, 'utf8')) as GraphSpecLike }),
  async walkGraph(spec, step, opts) {
    const steps: { node: string; visit: number }[] = [];
    const visits = new Map<string, number>();
    let next = spec.nodes[0]!.node_id;
    while (steps.length < opts.maxSteps) {
      const visit = (visits.get(next) ?? 0) + 1;
      visits.set(next, visit);
      steps.push({ node: next, visit });
      if (['delivered', 'skipped', 'blocked', 'unobserved'].includes(next)) return { terminal: next, stopReason: 'terminal', steps };
      const node = spec.nodes.find((n) => n.node_id === next)!;
      const outcome = await step(node);
      const edge = outcome === null ? undefined : spec.edges.find((e) => e.from === next && (e.to || e.map?.[outcome]));
      next = outcome === null ? opts.unobservedNode : edge?.to ?? edge?.map?.[outcome] ?? opts.unobservedNode;
    }
    return { terminal: null, stopReason: 'budget-exceeded', steps };
  },
};

const fixture = () => {
  // Real path: on macOS tmpdir() is under /var, a link to /private/var, and the script canonicalizes inputs.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'broll-cli-')));
  const video = join(dir, 'video.mp4');
  const words = join(dir, 'words.json');
  const clipsDir = join(dir, 'clips');
  writeFileSync(video, 'base');
  writeFileSync(words, JSON.stringify([{ word: 'hello', start: 0, end: 1 }]));
  return { dir, video, words, clipsDir };
};

describe('video-broll-line', () => {
  it('registers BROLL recipes without overwriting existing names', () => {
    const names = Object.keys(BROLL);
    expect(names).toHaveLength(5);
    expect(names.every((name) => ALL_RECIPES[name] === BROLL[name])).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    const existing = { ...UPSTREAM, ...FREE_LINE, ...VLOG, ...FILM, ...CHARACTER, ...HYPERFRAMES };
    expect(names.filter((name) => name in existing)).toEqual([]);
  });

  it('walks align → plan → clips → assemble → qc and prints terminal + clips in the last JSON line', async () => {
    const { video, words, clipsDir } = fixture();
    const output: string[] = [];
    const registerLogSink = mock(async (_surface: string) => true);
    const createAgent = mock(({ clipsDir: cwd }: { clipsDir: string; backend: string }) => async () => {
      const file = join(cwd, 'slot-000000.mp4');
      writeFileSync(file, 'clip');
      return file;
    });
    const run = mock((bin: string, args: readonly string[]) => {
      const destination = args.at(-1)!;
      if (bin === 'ffmpeg') {
        const source = args[args.indexOf('-i') + 1] ?? '';
        writeFileSync(destination, destination.endsWith('.rgb') ? Buffer.alloc(32 * 18 * 3, source === video ? 0 : 140) : 'render');
      }
      return { ok: true, code: 0, signal: null, out: bin === 'ffprobe' ? '1' : '', err: '' };
    });
    const code = await main(['--video', video, '--words', words, '--clips-dir', clipsDir, '--density', '1', '--json'], {
      loadWalker: async () => walker,
      walk: walkLine,
      createAgent: createAgent as unknown as typeof import('../src/video-pipeline/broll-agent.js').createBrollAgent,
      run,
      registerLogSink,
      writeJson: async (s) => { output.push(s); },
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(createAgent.mock.calls[0]![0].clipsDir).toBe(clipsDir);
    expect(createAgent.mock.calls[0]![0].backend).toBe('codex');
    expect(registerLogSink.mock.calls[0]![0]).toBe('video-broll-line');
    const last = JSON.parse(output.at(-1)!);
    expect(last.terminal).toBe('delivered');
    expect(last.clips).toBe(1);
    expect(last.skipped).toBe(0);
    expect(existsSync(last.rendered_path)).toBe(true);
    expect(run).toHaveBeenCalled();
  });

  it.skipIf(!existsSync(process.env.GRAPH_WALKER ?? DEFAULT_WALKER))('walks the actual B-roll declaration with loadWalker through terminal + clip evidence', async () => {
    const { video, words, clipsDir } = fixture();
    const output: string[] = [];
    const createAgent = mock(({ clipsDir: cwd }: { clipsDir: string; backend: string }) => async () => {
      const file = join(cwd, 'slot-000000.mp4');
      writeFileSync(file, 'clip');
      return file;
    });
    const run = mock((bin: string, args: readonly string[]) => {
      if (bin === 'ffmpeg') {
        const source = args[args.indexOf('-i') + 1] ?? '';
        const destination = args.at(-1)!;
        writeFileSync(destination, destination.endsWith('.rgb') ? Buffer.alloc(32 * 18 * 3, source === video ? 0 : 140) : 'render');
      }
      return { ok: true, code: 0, signal: null, out: bin === 'ffprobe' ? '1' : '', err: '' };
    });
    const code = await main(['--video', video, '--words', words, '--clips-dir', clipsDir, '--density', '1', '--json'], {
      loadWalker,
      createAgent: createAgent as unknown as typeof import('../src/video-pipeline/broll-agent.js').createBrollAgent,
      run,
      registerLogSink: async () => true,
      writeJson: async (line) => { output.push(line); },
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const last = JSON.parse(output.at(-1)!);
    expect(last).toMatchObject({ terminal: 'delivered', clips: 1, skipped: 0 });
    expect(existsSync(last.rendered_path)).toBe(true);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalled();
  });

  it('rejects an unknown --agent with exit 2 before walking', async () => {
    const { video, words } = fixture();
    const loadWalker = mock(async () => walker);
    const code = await main(['--video', video, '--words', words, '--agent', 'unknown'], { loadWalker });
    expect(code).toBe(2);
    expect(loadWalker).not.toHaveBeenCalled();
  });
});
