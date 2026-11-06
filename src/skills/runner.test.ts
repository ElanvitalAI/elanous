import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMMessage, LLMProvider, StreamWithToolsHandlers } from '../llm.js';
import * as llmActual from '../llm.js';
import {
  FOLD_LIMITS,
  foldHint,
  renderLogEntry,
  type FoldMode,
  type LogEntry,
  type RenderOpts,
} from '../log-entry.js';
import type { ExecuteSkillOpts, SkillManifest } from './runner.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, '');
const body = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
const toolBody = (text: string): LogEntry => ({ kind: 'tool-body', text });

const TOOL_OUTPUT = body(4);
/** When set, the mocked tool loop throws this exact object (SK1 failure path). */
let streamFailure: Error | null = null;
let streamWaitForAbort = false;
let observedStreamSignal: AbortSignal | undefined;
let mermaidDispatchCount = 0;
let mermaidDispatchResult: unknown;
let streamToolCall: { name: string; args: Record<string, unknown> } = {
  name: 'Read', args: { file_path: '/tmp/demo.txt' },
};

const testProvider: LLMProvider = {
  name: 'test',
  defaultModel: 'test-model',
  available: () => true,
  async *chat() { yield 'ok'; },
};

const skillRunnerSpies = [
  spyOn(llmActual, 'getProvider').mockReturnValue(testProvider),
  spyOn(llmActual, 'resolveDefaultProvider').mockReturnValue(testProvider),
  spyOn(llmActual, 'isModelCompatible').mockReturnValue(true),
  spyOn(llmActual, 'streamLLMWithTools').mockImplementation(async (
    _messages: LLMMessage[],
    handlers: StreamWithToolsHandlers,
    opts?: { signal?: AbortSignal },
  ) => {
    if (streamWaitForAbort) {
      observedStreamSignal = opts?.signal;
      return await new Promise<string>((_resolve, reject) => {
        if (opts?.signal?.aborted) reject(opts.signal.reason ?? new Error('aborted'));
        else opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (streamFailure) throw streamFailure;
    const call = { id: 'call-1', ...streamToolCall };
    handlers.onToolCall?.(call);
    const result = call.name === 'MermaidRender'
      ? await handlers.dispatchTool(call.name, call.args, { callId: call.id }).then((toolResult) => {
        mermaidDispatchCount += 1;
        mermaidDispatchResult = toolResult;
        return toolResult;
      })
      : TOOL_OUTPUT;
    handlers.onToolResult?.({ id: call.id, name: call.name, result });
    return 'ok';
  }),
];

const {
  executeSkill,
  skillFoldRenderOpts,
  parseSkillMd,
  tierMeetsMin,
  listSkillNames,
} = await import('./runner.js');

// Every executeSkill run now appends to <state>/skills/feedback.jsonl — keep this
// whole file on a throwaway state root (SK1 tests below nest their own).
const fileStateRoot = mkdtempSync(join(tmpdir(), 'runner-test-state-'));
const fileStatePrev = process.env.ELANOUS_STATE_DIR;
beforeAll(() => { process.env.ELANOUS_STATE_DIR = fileStateRoot; });
afterAll(() => {
  for (const spy of skillRunnerSpies) spy.mockRestore();
  if (fileStatePrev === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = fileStatePrev;
  rmSync(fileStateRoot, { recursive: true, force: true });
});

const demoManifest: SkillManifest = {
  name: 'demo-fold',
  description: 'demo',
  content: '# demo',
  skillDir: '/tmp/demo-fold-skill',
};

async function runExecuteSkill(foldMode?: FoldMode, extraOpts: Partial<ExecuteSkillOpts> = {}) {
  const folds: Array<{ entry: LogEntry; renderOpts: RenderOpts }> = [];
  let display = '';
  const opts: ExecuteSkillOpts = {
    ...extraOpts,
    onFoldableEntry: (entry, renderOpts) => {
      folds.push({ entry, renderOpts });
    },
  };
  if (foldMode !== undefined) opts.foldMode = foldMode;
  const result = await executeSkill(demoManifest, '', (_delta, full) => {
    display = full;
  }, opts);
  return { display, folds, result };
}

describe('executeSkill cancellation', () => {
  test('passes AbortSignal to streamLLMWithTools and settles when the stream aborts', async () => {
    const controller = new AbortController();
    streamWaitForAbort = true;
    observedStreamSignal = undefined;
    const run = executeSkill(demoManifest, '', () => {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('follow-up budget exhausted')), 5);

    try {
      await expect(run).rejects.toThrow('follow-up budget exhausted');
      const observed = observedStreamSignal as AbortSignal | undefined;
      expect(observed).toBe(controller.signal);
      expect(observed?.aborted).toBe(true);
    } finally {
      streamWaitForAbort = false;
      observedStreamSignal = undefined;
    }
  });
});

describe('skillFoldRenderOpts', () => {
  test('omitted foldMode keeps the empty RenderOpts that renderLogEntry already defaults to line', () => {
    expect(skillFoldRenderOpts()).toEqual({});
    expect(skillFoldRenderOpts(undefined)).toEqual({});

    const lines = body(FOLD_LIMITS.TOOL_BODY + 2);
    const viaHelper = renderLogEntry(toolBody(lines), skillFoldRenderOpts());
    const viaDefault = renderLogEntry(toolBody(lines));
    expect(viaHelper).toEqual(viaDefault);
    expect(viaHelper.map(strip)).toEqual([
      ...Array.from({ length: FOLD_LIMITS.TOOL_BODY }, (_, i) => `line ${i + 1}`),
      foldHint('line', 2),
    ]);
  });

  test('task-unit foldMode reaches the first tool-body paint through the same RenderOpts the runner registers', () => {
    const lines = body(4);
    const opts = skillFoldRenderOpts('task-unit');
    expect(opts).toEqual({ foldMode: 'task-unit' });
    expect(renderLogEntry(toolBody(lines), opts).map(strip)).toEqual([foldHint('line', 4)]);
  });
});

describe('executeSkill foldMode seam', () => {
  test('tool-result first paint and onFoldableEntry share foldMode from opts', async () => {
    const folded = await runExecuteSkill('task-unit');
    const unfolded = await runExecuteSkill();

    const foldedBodies = folded.folds.filter((f) => f.entry.kind === 'tool-body');
    const unfoldedBodies = unfolded.folds.filter((f) => f.entry.kind === 'tool-body');
    expect(foldedBodies).toHaveLength(1);
    expect(unfoldedBodies).toHaveLength(1);

    expect(foldedBodies[0]!.entry).toEqual(toolBody(TOOL_OUTPUT));
    expect(unfoldedBodies[0]!.entry).toEqual(toolBody(TOOL_OUTPUT));
    expect(foldedBodies[0]!.renderOpts).toEqual({ foldMode: 'task-unit' });
    expect(unfoldedBodies[0]!.renderOpts).toEqual({});

    const foldedPaint = renderLogEntry(toolBody(TOOL_OUTPUT), { foldMode: 'task-unit' }).map(strip);
    const unfoldedPaint = renderLogEntry(toolBody(TOOL_OUTPUT)).map(strip);
    expect(foldedPaint).toEqual([foldHint('line', 4)]);
    expect(unfoldedPaint).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
    expect(foldedPaint).not.toEqual(unfoldedPaint);

    const foldedDisplay = strip(folded.display);
    const unfoldedDisplay = strip(unfolded.display);
    expect(foldedDisplay).toContain(foldHint('line', 4));
    expect(foldedDisplay).not.toContain('line 2');
    expect(unfoldedDisplay).toContain('line 1');
    expect(unfoldedDisplay).toContain('line 2');
    expect(unfoldedDisplay).toContain('line 3');
    expect(unfoldedDisplay).toContain('line 4');
    expect(unfoldedDisplay).not.toContain(foldHint('line', 4));
  }, 20_000);
});

describe('executeSkill final response', () => {
  test('exposes the final assistant response separately from the rendered tool transcript', async () => {
    const { display, result } = await runExecuteSkill();

    expect(result.fullResponse).toBe(display);
    expect(result.fullResponse).toContain('Read');
    expect(result.finalResponse).toBe('ok');
    expect(result.finalResponse).not.toContain('Read');
  }, 20_000);
});

describe('DIAG-LITE: production runner executes MermaidRender with zero Python calls', () => {
  test('dispatches through executeSkill and the production MermaidRender handler', async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'mermaid-render-fake-bin-'));
    const pythonCallLog = join(fakeBin, 'python-calls.log');
    const previousPath = process.env.PATH;
    for (const command of ['python3', 'python', 'uv']) {
      const shimPath = join(fakeBin, command);
      writeFileSync(shimPath, `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(pythonCallLog)}\nexit 97\n`);
      chmodSync(shimPath, 0o755);
    }
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    mermaidDispatchCount = 0;
    mermaidDispatchResult = undefined;
    streamToolCall = {
      name: 'MermaidRender',
      args: { source: 'flowchart LR\n  A[Start] --> B[End]', format: 'ascii' },
    };

    try {
      const { display, result } = await runExecuteSkill();

      expect(result.finalResponse).toBe('ok');
      expect(result.fullResponse).toBe(display);
      expect(mermaidDispatchCount).toBe(1);
      expect(display).toContain('MermaidRender');
      const assertRenderedAsciiDiagram = (output: unknown): void => {
        expect(typeof output).toBe('string');
        const rendered = String(output);
        expect(rendered).toContain('+-----+');
        expect(rendered).toContain('|Start|');
        expect(rendered).toContain('|End|');
        expect(rendered).toContain('------->');
      };
      assertRenderedAsciiDiagram(mermaidDispatchResult);
      streamToolCall = {
        name: 'MermaidRender',
        args: { source: 'flowchart LR\n  A[Start] --> B[End]', format: 'ascii' },
      };
      await expect(runExecuteSkill(undefined, {
        mermaidRenderer: () => { throw new Error('forced renderer failure'); },
      })).rejects.toThrow('mermaid render failed: forced renderer failure');
      expect(existsSync(pythonCallLog)).toBe(false);

      // A malformed diagram is surfaced by the production renderer as an error, never a successful render.
      mermaidDispatchCount = 0;
      mermaidDispatchResult = undefined;
      streamToolCall = { name: 'MermaidRender', args: { source: 'not a diagram', format: 'ascii' } };
      await runExecuteSkill();
      expect(mermaidDispatchCount).toBe(1);
      expect(String(mermaidDispatchResult)).toStartWith('Error:');
      expect(String(mermaidDispatchResult)).not.toContain('+-----+');
    } finally {
      streamToolCall = { name: 'Read', args: { file_path: '/tmp/demo.txt' } };
      mermaidDispatchCount = 0;
      mermaidDispatchResult = undefined;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }
  }, 20_000);
});

const DIAG_LITE_REPO_ROOT = join(import.meta.dir, '..', '..');
const DIAG_LITE_SKILLS_DIR = join(DIAG_LITE_REPO_ROOT, 'skills');

describe('DIAG-LITE: diagram-master 계약은 실제 runner 함수로 고정한다', () => {
  test('parseSkillMd reads the shipped SKILL.md frontmatter contract', () => {
    expect(listSkillNames(DIAG_LITE_SKILLS_DIR)).toContain('diagram-master');
    const manifest = parseSkillMd('diagram-master', DIAG_LITE_SKILLS_DIR);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe('diagram-master');
    expect(manifest!.minTier).toBe('T2');
    expect(manifest!.category).toBe('visual');
    expect(manifest!.composes).toEqual(['show-image']);
    expect(manifest!.description).toContain('Mermaid');
    expect(manifest!.content).toContain('MermaidRender');
    expect(manifest!.content).toContain('선택 애드온');
    expect(manifest!.skillDir.endsWith(join('skills', 'diagram-master'))).toBe(true);
  });

  test('tierMeetsMin keeps the shipped T2 threshold behavior', () => {
    expect(tierMeetsMin('T2', 'T2')).toBe(true);
    expect(tierMeetsMin('T1', 'T2')).toBe(true);
    expect(tierMeetsMin('T3', 'T2')).toBe(false);
    expect(tierMeetsMin('T2', undefined)).toBe(true);
  });

  // UNMEASURED where npm is absent (the release gate Pod image ships bun only) — skipped, not counted as a pass.
  test.skipIf(!Bun.which('npm'))('the npm package includes diagram PNG examples and excludes the optional venv', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: DIAG_LITE_REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const packageInfo = (JSON.parse(output) as Array<{ files: Array<{ path: string }> }>)[0]!;
    const paths = new Set(packageInfo.files.map((file) => file.path));
    expect(paths.has('skills/diagram-master/references/examples/ref_grid_architecture.png')).toBe(true);
    expect(paths.has('skills/diagram-master/references/examples/ref_layered_flow.png')).toBe(true);
    expect([...paths].some((path) => path.includes('skills/diagram-master/references/.venv/'))).toBe(false);
  }, 60_000); // npm pack --dry-run takes >5s on Linux gate Pods (0.3.5 cut)
});

type LedgerLine = { skill: string; outcome: string; failureKind?: string; runId: string };
const readLedger = (root: string): LedgerLine[] =>
  readFileSync(join(root, 'skills', 'feedback.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerLine);

describe('executeSkill feedback ledger (SK1)', () => {
  test('success and thrown runs each leave one line under the state root; the original error object is rethrown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sk1-runner-'));
    const prevState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const manifest: SkillManifest = { ...demoManifest, name: 'sk1-in-process' };
      const ok = await executeSkill(manifest, '', () => {});
      expect(ok.fullResponse).toContain('line 4');

      const boom = new RangeError('provider exploded');
      streamFailure = boom;
      let caught: unknown;
      try {
        await executeSkill(manifest, '', () => {});
      } catch (error) {
        caught = error;
      } finally {
        streamFailure = null;
      }
      expect(caught).toBe(boom);

      const lines = readLedger(root).filter((l) => l.skill === 'sk1-in-process');
      expect(lines.map((l) => l.outcome)).toEqual(['success', 'failure']);
      expect(lines[0]!.failureKind).toBeUndefined();
      expect(lines[1]!.failureKind).toBe('RangeError');
      expect(lines[0]!.runId).not.toBe(lines[1]!.runId);
      expect(existsSync(join(demoManifest.skillDir, '.skill-feedback.jsonl'))).toBe(false);
    } finally {
      streamFailure = null;
      streamWaitForAbort = false;
      observedStreamSignal = undefined;
      if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prevState;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('unwritable state root: result and original error pass through, one record-failed per run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sk1-unwritable-'));
    const blocker = join(root, 'a-file');
    writeFileSync(blocker, 'not a directory');
    const prevState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = join(blocker, 'state');
    const skill = `sk1-unwritable-${Date.now()}`;
    const failed = () => debug.events(5000).filter((e) => e.category === 'skill.feedback'
      && e.event === 'record-failed' && (e.data as { skill?: string } | undefined)?.skill === skill).length;
    try {
      const manifest: SkillManifest = { ...demoManifest, name: skill };
      const ok = await executeSkill(manifest, '', () => {});
      expect(ok.fullResponse).toContain('line 4');
      expect(failed()).toBe(1);

      const boom = new SyntaxError('bad turn');
      streamFailure = boom;
      let caught: unknown;
      try {
        await executeSkill(manifest, '', () => {});
      } catch (error) {
        caught = error;
      } finally {
        streamFailure = null;
      }
      expect(caught).toBe(boom);
      expect(failed()).toBe(2);
      expect(readFileSync(blocker, 'utf8')).toBe('not a directory');
    } finally {
      streamFailure = null;
      streamWaitForAbort = false;
      observedStreamSignal = undefined;
      if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prevState;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('a separate process with ELANOUS_STATE_DIR writes <state>/skills/feedback.jsonl through the real root resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sk1-spawn-'));
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const runner = join(import.meta.dir, 'runner.ts');
      const code = `
        const { executeSkill } = await import(${JSON.stringify(runner)});
        const provider = { name: 'sk1-test', defaultModel: 'sk1-model', available: () => true,
          async *chat() { yield 'pong'; } };
        const r = await executeSkill(
          { name: 'sk1-spawn-skill', description: 'sk1', content: '# sk1', skillDir: ${JSON.stringify(join(root, 'no-skill-dir'))} },
          '', () => {}, { provider, maxTurns: 1 });
        console.log('SK1_RESULT ' + JSON.stringify(r.fullResponse));
        process.exit(0);
      `;
      const env: Record<string, string> = { ...process.env as Record<string, string>, ELANOUS_STATE_DIR: root };
      const child = Bun.spawn(['bun', '-e', code], {
        cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe', timeout: 110_000, killSignal: 'SIGKILL',
      });
      proc = child;
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode === 0 ? 'ok' : `exit ${exitCode}\n${stderr.slice(-2000)}`).toBe('ok');
      expect(stdout).toContain('SK1_RESULT');
      expect(existsSync(join(root, 'skills', 'feedback.jsonl'))).toBe(true);
      const successes = readLedger(root).filter((l) => l.skill === 'sk1-spawn-skill' && l.outcome === 'success');
      expect(successes).toHaveLength(1);
      expect(existsSync(join(root, 'no-skill-dir'))).toBe(false);
    } finally {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
