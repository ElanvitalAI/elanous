import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = join(import.meta.dir, '..');
const temp = mkdtempSync(join(root, 'scripts', '.explainer-entry-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('video-pipeline walk production entry', () => {
  it('loads explainer-line.yaml and dispatches its script recipe through walkLine', () => {
    const statePath = join(temp, 'state.json');
    const walkerPath = join(temp, 'walker.ts');
    writeFileSync(statePath, JSON.stringify({}));
    writeFileSync(walkerPath, `
      import { readFileSync } from 'node:fs';
      import { parse } from 'yaml';
      export function readGraphSpec(path: string) { return { spec: parse(readFileSync(path, 'utf8')) }; }
      export async function walkGraph(spec: any, step: any, opts: any) {
        const steps = [];
        let current = spec.entry_node;
        while (current && steps.length < opts.maxSteps) {
          steps.push({ node: current, visit: 1 });
          if (spec.terminal_nodes.includes(current)) return { terminal: current, stopReason: 'terminal', steps };
          const node = spec.nodes.find((item: any) => item.node_id === current);
          const outcome = await step(node);
          if (outcome === null) current = opts.unobservedNode;
          else {
            const edge = spec.edges.find((item: any) => item.from === current && outcome in (item.map ?? {}));
            if (!edge) return { terminal: null, stopReason: 'no-edge', steps };
            current = edge.map[outcome];
          }
        }
        return { terminal: null, stopReason: 'budget-exceeded', steps };
      }
    `);

    const result = spawnSync('bun', [join(import.meta.dir, 'video-pipeline.ts'), 'walk', '--graph', 'explainer-line', '--state', statePath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GRAPH_WALKER: walkerPath },
    });

    if (result.status !== 1) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { terminal: string; path: string; trace: { node: string; recipe: string }[]; unknownRecipe: string | null };
    expect(output.terminal).toBe('needs-human');
    expect(output.path).toBe('script→needs-human');
    expect(output.trace).toEqual([expect.objectContaining({ node: 'script', recipe: 'explainer-script' })]);
    expect(output.unknownRecipe).toBeNull();
  });

  it('walks confirmed briefing input through production recipes and the Telegram callback', async () => {
    const statePath = join(temp, 'full-state.json');
    const walkerPath = join(temp, 'full-walker.ts');
    const out = join(temp, 'full-out');
    const fakeBin = join(temp, 'fake-bin');
    const driver = join(temp, 'fake-tool.mjs');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      briefing: { id: 'briefing-1', title: '확정 브리핑', summary: '확인된 결론', confirmed: true },
      facts: [{ id: 'fact-1', title: '근거 하나', text: '확인된 사실입니다.', sourceId: 'source-1' }],
      sources: [{ id: 'source-1', label: '공식 자료', url: 'https://example.test/source' }],
      chart_plan: [{ factId: 'fact-1', kind: 'bar', title: '확인된 수치', points: [{ label: 'A', value: 2 }, { label: 'B', value: 3 }] }],
      telegram_chat_id: 'chat-test',
    }));
    writeFileSync(walkerPath, `
      import { readFileSync } from 'node:fs';
      import { parse } from 'yaml';
      export function readGraphSpec(path: string) { return { spec: parse(readFileSync(path, 'utf8')) }; }
      export async function walkGraph(spec: any, step: any, opts: any) {
        const steps = []; let current = spec.entry_node;
        while (current && steps.length < opts.maxSteps) {
          steps.push({ node: current, visit: 1 });
          if (spec.terminal_nodes.includes(current)) return { terminal: current, stopReason: 'terminal', steps };
          const node = spec.nodes.find((item: any) => item.node_id === current);
          const outcome = await step(node);
          if (outcome === null) current = opts.unobservedNode;
          else {
            const edge = spec.edges.find((item: any) => item.from === current && outcome in (item.map ?? {}));
            if (!edge) return { terminal: null, stopReason: 'no-edge', steps };
            current = edge.map[outcome];
          }
        }
        return { terminal: null, stopReason: 'budget-exceeded', steps };
      }
    `);
    writeFileSync(driver, `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const args = process.argv.slice(2), kind = process.env.FAKE_KIND;
      const jsonPath = args.find((arg) => arg.endsWith('.json'));
      if (kind === 'bun') {
        const script = JSON.parse(readFileSync(jsonPath, 'utf8'));
        const beats = [...script.intro.beats, ...script.chapters.flatMap((c) => c.beats), ...script.outro.beats];
        const keys = [...script.intro.beats.map((_, i) => 'i-' + i), ...script.chapters.flatMap((c, ci) => c.beats.map((_, i) => 'c' + (ci + 1) + '-' + i)), ...script.outro.beats.map((_, i) => 'o-' + i)];
        const dir = join(dirname(jsonPath), 'source', 'vo'); mkdirSync(dir, { recursive: true });
        for (const [i, key] of keys.entries()) {
          writeFileSync(join(dir, key + '.mp3'), 'mock audio');
          writeFileSync(join(dir, key + '.json'), JSON.stringify({ alignment: { characters: [...beats[i].vo], character_end_times_seconds: [0.25, 1], character_start_times_seconds: [0.1, 0.2] } }));
        }
      } else if (kind === 'node') {
        const project = args[2] || dirname(jsonPath), hf = join(project, 'hf'); mkdirSync(hf, { recursive: true });
        const script = JSON.parse(readFileSync(jsonPath, 'utf8'));
        const chapter = script.chapters[0];
        writeFileSync(join(hf, 'index.html'), '<html data-width="1920" data-height="1080" data-duration="' + script.target_seconds + '" data-chart-kind="' + chapter.chart?.kind + '" data-source-caption="' + chapter.beats[0].cap + '"></html>');
        writeFileSync(join(project, 'timeline.json'), '{}');
      } else if (kind === 'npx') {
        if (args[1] === 'check') process.stdout.write(JSON.stringify({ ok: true, lint: { errorCount: 0 }, runtime: { errorCount: 0 }, layout: { errorCount: 0 } }));
        else if (args[1] === 'render') writeFileSync(args[args.indexOf('-o') + 1], 'mock video bytes');
      } else if (kind === 'ffprobe') {
        process.stdout.write(JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '60' } }));
      } else if (kind === 'ffmpeg') {
        process.stderr.write('{"input_i":"-14","input_tp":"-1.5"}');
      } else process.exitCode = 3;
    `);
    for (const [name, kind] of [['bun', 'bun'], ['node', 'node'], ['npx', 'npx'], ['ffprobe', 'ffprobe'], ['ffmpeg', 'ffmpeg']]) {
      const wrapper = join(fakeBin, name);
      writeFileSync(wrapper, `#!/bin/sh\nFAKE_KIND=${kind} exec '${process.execPath}' '${driver}' "$@"\n`);
      chmodSync(wrapper, 0o755);
    }

    let requestPath = '';
    let requestBody = '';
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requestPath = new URL(request.url).pathname;
      requestBody = await request.text();
      return Response.json({ ok: true, result: { message_id: 12345 } });
    } });
    try {
      const child = spawn(process.execPath, [join(import.meta.dir, 'video-pipeline.ts'), 'walk', '--graph', 'explainer-line', '--state', statePath, '--out', out, '--json'], {
        cwd: root,
        env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`, GRAPH_WALKER: walkerPath,
          TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` },
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const status = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? -1));
      });
      if (status !== 0) throw new Error(stderr || stdout);
      const output = JSON.parse(stdout) as { terminal: string; path: string; trace: { node: string; outcome: string }[] };
      expect(output.terminal).toBe('delivered');
      expect(output.path).toBe('script→scene→vo→build→render→qc→deliver→delivered');
      expect(output.trace.map((row) => row.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'pass', 'ok']);
      expect(requestPath).toBe('/bottest-token/sendVideo');
      expect(requestBody).toContain('name="briefing.mp4"');
      expect(requestBody).toContain('name="video"');
      expect(requestBody).toContain('mock video bytes');
      expect(requestBody).toContain('chat-test');
      const sourceScript = JSON.parse(readFileSync(join(out, 'script.json'), 'utf8')) as { chapters: { chart?: { kind: string }; beats: { cap: string }[]; sourceUrl?: string }[] };
      expect(sourceScript.chapters[0]?.chart).toBeUndefined();
      const buildDir = readdirSync(out).find((name) => name.startsWith('.explainer-build-'));
      expect(buildDir).toBeDefined();
      const buildScript = JSON.parse(readFileSync(join(out, buildDir!, 'script.json'), 'utf8')) as {
        target_seconds: number; chapters: { chart?: { kind: string }; beats: { cap: string }[]; sourceUrl?: string }[];
      };
      expect(buildScript.target_seconds).toBe(60);
      expect(buildScript.chapters[0]?.chart?.kind).toBe('bar');
      expect(buildScript.chapters[0]?.beats[0]?.cap).toContain('Source: 공식 자료');
      expect(buildScript.chapters[0]?.sourceUrl).toBe('https://example.test/source');

      const noTokenOut = join(temp, 'no-token-out');
      const noTokenChild = spawn(process.execPath, [join(import.meta.dir, 'video-pipeline.ts'), 'walk', '--graph', 'explainer-line', '--state', statePath, '--out', noTokenOut, '--json'], {
        cwd: root,
        env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`, GRAPH_WALKER: walkerPath,
          TELEGRAM_BOT_TOKEN: '', TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` },
        stdio: 'pipe',
      });
      let noTokenStdout = '';
      let noTokenStderr = '';
      noTokenChild.stdout.setEncoding('utf8').on('data', (chunk: string) => { noTokenStdout += chunk; });
      noTokenChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { noTokenStderr += chunk; });
      const noTokenStatus = await new Promise<number>((resolve, reject) => {
        noTokenChild.once('error', reject);
        noTokenChild.once('close', (code) => resolve(code ?? -1));
      });
      const noTokenOutput = JSON.parse(noTokenStdout) as { terminal: string; path: string; trace: { node: string; outcome: string }[] };
      expect(noTokenStatus).toBe(1);
      if (noTokenStatus !== 1) throw new Error(noTokenStderr || noTokenStdout);
      expect(noTokenOutput.terminal).toBe('needs-human');
      expect(noTokenOutput.path).toBe('script→scene→vo→build→render→qc→deliver→needs-human');
      expect(noTokenOutput.trace.find((row) => row.node === 'deliver')?.outcome).toBe('no-recipient');
    } finally {
      server.stop();
    }
  }, 20_000);

  it('uploads the rendered file through the production CLI Telegram delivery callback', async () => {
    const statePath = join(temp, 'delivery-state.json');
    const walkerPath = join(temp, 'delivery-walker.ts');
    const videoPath = join(temp, 'briefing.mp4');
    writeFileSync(videoPath, 'mock-video-bytes');
    writeFileSync(statePath, JSON.stringify({
      hf_render_path: videoPath,
      briefing: { id: 'briefing-1', title: '확정 브리핑' },
      telegram_chat_id: 'chat-test',
    }));
    writeFileSync(walkerPath, `
      import { readFileSync } from 'node:fs';
      import { parse } from 'yaml';
      export function readGraphSpec(path: string) {
        const spec = parse(readFileSync(path, 'utf8'));
        spec.entry_node = 'deliver';
        return { spec };
      }
      export async function walkGraph(spec: any, step: any, opts: any) {
        const steps = [];
        let current = spec.entry_node;
        while (current && steps.length < opts.maxSteps) {
          steps.push({ node: current, visit: 1 });
          if (spec.terminal_nodes.includes(current)) return { terminal: current, stopReason: 'terminal', steps };
          const node = spec.nodes.find((item: any) => item.node_id === current);
          const outcome = await step(node);
          const edge = spec.edges.find((item: any) => item.from === current && outcome in (item.map ?? {}));
          if (!edge) return { terminal: null, stopReason: 'no-edge', steps };
          current = edge.map[outcome];
        }
        return { terminal: null, stopReason: 'budget-exceeded', steps };
      }
    `);

    let requestPath = '';
    let requestBody = '';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = await request.text();
        return Response.json({ ok: true, result: { message_id: 12345 } });
      },
    });
    try {
      const child = spawn('bun', [join(import.meta.dir, 'video-pipeline.ts'), 'walk', '--graph', 'explainer-line', '--state', statePath, '--json'], {
        cwd: root,
        env: { ...process.env, GRAPH_WALKER: walkerPath, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` },
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const status = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? -1));
      });
      if (status !== 0) throw new Error(stderr || stdout);
      const output = JSON.parse(stdout) as { terminal: string; path: string };
      expect(output.terminal).toBe('delivered');
      expect(output.path).toBe('deliver→delivered');
      expect(requestPath).toBe('/bottest-token/sendVideo');
      expect(requestBody).toContain('name="briefing.mp4"');
      expect(requestBody).toContain('video/mp4');
      expect(requestBody).toContain('name="video"');
      expect(requestBody).toContain('mock-video-bytes');
      expect(requestBody).toContain('chat-test');
    } finally {
      server.stop();
    }
  });
});
