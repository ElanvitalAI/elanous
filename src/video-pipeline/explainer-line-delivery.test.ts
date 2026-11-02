import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { ALL_RECIPES, walkLine, type GraphSpecLike, type WalkerApi } from './walk-line.js';
import { explainerBuild, explainerDeliver, explainerQc, explainerScene, explainerScript, explainerVo } from './recipes/explainer.js';
import type { Recipe } from './recipes/types.js';
import type { RunResult } from './recipes/ffmpeg.js';

const declaration = resolve(import.meta.dir, '../../graphs/video/explainer-line.yaml');
const mockWalker: WalkerApi = {
  readGraphSpec: () => ({}),
  async walkGraph(spec, step, opts) {
    const steps: { node: string; visit: number }[] = [];
    let current: string | null = spec.nodes[0]?.node_id ?? null;
    while (current && steps.length < opts.maxSteps) {
      steps.push({ node: current, visit: 1 });
      const node = spec.nodes.find((item) => item.node_id === current)!;
      const outcome = await step(node);
      if (outcome === null) return { terminal: opts.unobservedNode, stopReason: 'terminal', steps };
      const edge = spec.edges.find((item) => item.from === current && (item.to !== undefined || outcome in (item.map ?? {})));
      if (!edge) return { terminal: null, stopReason: 'no-edge', steps };
      current = edge.to ?? edge.map![outcome]!;
      if (['delivered', 'needs-human', 'blocked', 'unobserved'].includes(current)) {
        steps.push({ node: current, visit: 1 });
        return { terminal: current, stopReason: 'terminal', steps };
      }
    }
    return { terminal: null, stopReason: 'budget-exceeded', steps };
  },
};

describe('DEMO1104-VIDEO-OUTPUT: mock briefing delivery', () => {
  it('runs the declared script → scene → voice → build → render → QC → Telegram delivery path', async () => {
    const graph = parse(readFileSync(declaration, 'utf8')) as {
      graph_id: string;
      nodes: { node_id: string; recipe?: string }[];
      edges: { from: string; to?: string; map?: Record<string, string> }[];
      target_seconds: number;
    };
    const workdir = mkdtempSync(join(tmpdir(), 'explainer-line-delivery-'));
    const project = join(workdir, 'project');
    mkdirSync(project, { recursive: true });
    const scriptPath = join(project, 'script.json');
    writeFileSync(scriptPath, JSON.stringify({
      intro: { beats: [{ vo: '요약' }] },
      chapters: [{ factId: 'fact-1', sourceId: 'source-1', title: '근거', beats: [{ vo: '확인된 근거' }] }],
      outro: { beats: [{ vo: '결론' }] },
    }));
    const delivered: string[] = [];
    const reached: string[] = [];
    const state: Record<string, unknown> = {
      script_path: scriptPath,
      facts: [{ id: 'fact-1', text: '확정된 사실', sourceId: 'source-1' }],
      sources: [{ id: 'source-1', label: '출처 1', url: 'https://example.test/source' }],
      chart_plan: [{ factId: 'fact-1', kind: 'line', title: '기준 변화', points: [{ label: '전', value: 1 }, { label: '후', value: 2 }] }],
      briefing: { id: 'mock-briefing-1', title: '확정 브리핑', confirmed: true },
      sendTelegramVideo: async (file: string, briefing: unknown) => {
        expect(briefing).toEqual({ id: 'mock-briefing-1', title: '확정 브리핑', confirmed: true });
        delivered.push(file);
        return 'mock-telegram-message-1';
      },
    };
    const run = (bin: string, args: readonly string[], _timeoutMs: number, cwd?: string): RunResult => {
      if (bin === 'bun') {
        const voDir = join(project, 'source', 'vo');
        mkdirSync(voDir, { recursive: true });
        for (const key of ['i-0', 'c1-0', 'o-0']) {
          writeFileSync(join(voDir, `${key}.mp3`), 'mock voice');
          writeFileSync(join(voDir, `${key}.json`), JSON.stringify({ alignment: { character_end_times_seconds: [0.25, 1] } }));
        }
      } else if (bin === 'node') {
        mkdirSync(join(project, 'hf'), { recursive: true });
        writeFileSync(join(project, 'hf', 'index.html'), '<html>mock composition</html>');
        writeFileSync(join(project, 'timeline.json'), '{}');
      } else if (bin === 'ffmpeg') {
        return { ok: true, code: 0, signal: null, err: '{"input_i":"-14","input_tp":"-1.5"}', out: '' };
      } else if (bin === 'ffprobe') {
        return { ok: true, code: 0, signal: null, err: '', out: '60' };
      }
      return { ok: true, code: 0, signal: null, err: '', out: '' };
    };
    const recipes: Record<string, Recipe> = {
      ...ALL_RECIPES,
      'explainer-script': explainerScript(),
      'explainer-scene': explainerScene(),
      'explainer-vo': explainerVo({ run }),
      'explainer-build': explainerBuild({ run }),
      'hyperframes-render': async (ctx) => {
        reached.push('render');
        expect(ctx.state.scene_plan).toEqual([{ factId: 'fact-1', sourceId: 'source-1', title: '근거', diagram: 'chart',
          chart: { factId: 'fact-1', kind: 'line', title: '기준 변화', points: [{ label: '전', value: 1 }, { label: '후', value: 2 }] },
          beats: [{ vo: '확인된 근거' }] }]);
        expect(ctx.state.chart_plan).toEqual([{ factId: 'fact-1', kind: 'line', title: '기준 변화', points: [{ label: '전', value: 1 }, { label: '후', value: 2 }] }]);
        const videoPath = join(workdir, 'briefing.mp4');
        writeFileSync(videoPath, 'mock rendered video');
        return { outcome: 'ok', produced: { hf_render_path: videoPath } };
      },
      'explainer-qc': explainerQc({ run }),
      'explainer-deliver': async (ctx) => {
        reached.push('deliver');
        return explainerDeliver()(ctx);
      },
    };
    const result = await walkLine({ spec: graph as GraphSpecLike, walker: mockWalker, state, workdir, recipes,
      onStep: (row) => { if (!reached.includes(row.node)) reached.push(row.node); } });

    expect(graph.target_seconds).toBe(60);
    expect(result.trace.map((row) => row.node)).toEqual(['script', 'scene', 'vo', 'build', 'render', 'qc', 'deliver']);
    expect(state.scene_plan).toEqual([{ factId: 'fact-1', sourceId: 'source-1', title: '근거', diagram: 'chart',
      chart: { factId: 'fact-1', kind: 'line', title: '기준 변화', points: [{ label: '전', value: 1 }, { label: '후', value: 2 }] },
      beats: [{ vo: '확인된 근거' }] }]);
    expect(state.evidence_captions).toEqual([{ id: 'source-1', label: '출처 1', url: 'https://example.test/source' }]);
    expect(state.hf_render_path).toBe(join(workdir, 'briefing.mp4'));
    expect(readFileSync(String(state.hf_render_path), 'utf8')).toBe('mock rendered video');
    expect(delivered).toEqual([join(workdir, 'briefing.mp4')]);
    expect(state.telegram_message_id).toBe('mock-telegram-message-1');
    expect(result.terminal).toBe('delivered');
    expect(reached).toEqual(['script', 'scene', 'vo', 'build', 'render', 'qc', 'deliver']);
    rmSync(workdir, { recursive: true, force: true });
  });
});
