#!/usr/bin/env bun
import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// qwen-pipeline-bench.ts · empirical comparison matrix.
//
// Models (5):
//   - qwen3.6-think      → LocalProvider · qwen3.6-35b-a3b-ud-mlx (default thinking)
//   - qwen3.6-no_think   → same as above + `/no_think` user-message prefix
//   - qwen3.5-think      → LocalProvider · qwen3.5-35b-a3b (sibling)
//   - haiku-4.5          → AnthropicProvider · cloud "small/fast" baseline
//   - grok-4.20          → GrokProvider · cloud long-context peer (2M · $1.25/$2.50)
//
// Scenarios (4):
//   - analysis        — single-turn text Q
//   - coding          — single-turn code emission
//   - debugging       — single-turn tool_use (1 call)
//   - multi-turn-agent — tool loop ≥ 2 calls (bash → read_file → final text)
//
// Output: per-cell metrics + summary table. Failures captured, not thrown.
//
// Usage: bun scripts/qwen-pipeline-bench.ts [--models a,b,c] [--scenarios x,y]
//
// Pre-req: LM Studio with qwen3.6 + qwen3.5 loaded; ANTHROPIC_API_KEY +
// XAI_API_KEY in env. Missing keys → that model is skipped (logged).

import { LocalProvider, AnthropicProvider, GrokProvider, streamLLMWithTools } from '../src/llm.js';
import { refreshInventory, _resetManagerForTesting } from '../src/llm/local-manager/manager.js';
import type { LLMMessage, LLMStreamEvent, LLMProvider } from '../src/llm.js';

process.env['LOCAL_LLM_URL'] = process.env['LOCAL_LLM_URL'] || 'http://localhost:1234/v1';

interface ModelConfig {
  label: string;
  provider: LLMProvider;
  model: string;
  /** Prepend `/no_think` to the user message — qwen-only signal. */
  noThink?: boolean;
  /** Skip this model when this env var is missing. */
  requireEnv?: string;
}

const ALL_MODELS: ModelConfig[] = [
  { label: 'qwen3.6-think',    provider: LocalProvider,     model: 'local-llm:local:qwen3.6-35b-a3b-ud-mlx' },
  { label: 'qwen3.6-no_think', provider: LocalProvider,     model: 'local-llm:local:qwen3.6-35b-a3b-ud-mlx', noThink: true },
  { label: 'qwen3.5-think',    provider: LocalProvider,     model: 'local-llm:local:qwen3.5-35b-a3b' },
  { label: 'haiku-4.5',        provider: AnthropicProvider, model: 'claude-haiku-4-5',     requireEnv: 'ANTHROPIC_API_KEY' },
  { label: 'grok-4.20',        provider: GrokProvider,      model: 'grok-4.20',            requireEnv: 'XAI_API_KEY' },
];

interface CellResult {
  modelLabel: string;
  scenarioName: string;
  ok: boolean;
  ms: number;
  ttftMs: number | null;
  visibleChars: number;
  reasoningChars: number;
  toolCalls: number;
  turnsUsed?: number;
  completedFinalText?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  preview: string;
  error?: string;
}

const READ_FILE_FAKE = (path: string): string => {
  // Stable fake content so all models see the same data.
  return `# ${path} (faked content)\n` +
    `def render(items):\n` +
    `    # items can contain None — that's the bug\n` +
    `    total = sum(items)\n` +
    `    return total\n`;
};
const BASH_FAKE = (cmd: string): string => {
  if (cmd.includes('find') && cmd.includes('.py')) {
    return [
      './src/billing/invoice.py',
      './src/billing/totals.py',
      './scripts/dev.py',
    ].join('\n');
  }
  return `(faked output for: ${cmd})`;
};

async function probeAndConfirmLocal(): Promise<void> {
  console.log('▶ Refreshing local LLM inventory…');
  _resetManagerForTesting();
  const inv = await refreshInventory();
  const loaded = inv.models.filter(m => m.runtime === 'lmstudio' && m.loaded === true);
  console.log(`  loaded models: ${loaded.length}`);
  for (const m of loaded.slice(0, 10)) console.log(`    ✓ ${m.id} [${m.capabilities?.join(',') ?? '?'}]`);
  console.log('');
}

function selectModels(filter?: string): ModelConfig[] {
  const set = filter ? new Set(filter.split(',').map(s => s.trim())) : null;
  const out: ModelConfig[] = [];
  for (const m of ALL_MODELS) {
    if (set && !set.has(m.label)) continue;
    if (m.requireEnv && !process.env[m.requireEnv]) {
      console.log(`  ⏭  skip ${m.label}: ${m.requireEnv} not set`);
      continue;
    }
    out.push(m);
  }
  return out;
}

interface SingleTurnInput {
  scenarioName: string;
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  maxTokens: number;
}

async function runSingleTurn(
  model: ModelConfig,
  input: SingleTurnInput,
): Promise<CellResult> {
  const t0 = Date.now();
  let ttftMs: number | null = null;
  let visibleChars = 0;
  let reasoningChars = 0;
  let toolCalls = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  const previewBuf: string[] = [];
  let previewLen = 0;
  const messages = mutateMessagesForModel(model, input.messages);
  try {
    const events = model.provider.streamChat!(messages, {
      model: model.model,
      maxTokens: input.maxTokens,
      temperature: 0.3,
      ...(input.tools ? { tools: input.tools } : {}),
    });
    for await (const ev of events as AsyncGenerator<LLMStreamEvent>) {
      if (ttftMs === null) ttftMs = Date.now() - t0;
      if (ev.type === 'text') {
        visibleChars += ev.delta.length;
        if (previewLen < 240) {
          previewBuf.push(ev.delta);
          previewLen += ev.delta.length;
        }
      } else if (ev.type === 'reasoning' && ev.kind !== 'summary_part_added') {
        reasoningChars += ev.delta.length;
      } else if (ev.type === 'tool_call') {
        toolCalls++;
        if (previewLen < 240) {
          const s = `[tool: ${ev.name}(${JSON.stringify(ev.args).slice(0, 80)})]`;
          previewBuf.push(s);
          previewLen += s.length;
        }
      } else if (ev.type === 'usage') {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
        reasoningTokens = ev.usage.reasoningOutputTokens;
      }
    }
  } catch (err: any) {
    return {
      modelLabel: model.label,
      scenarioName: input.scenarioName,
      ok: false,
      ms: Date.now() - t0,
      ttftMs,
      visibleChars,
      reasoningChars,
      toolCalls,
      preview: previewBuf.join('').slice(0, 240),
      error: err?.message ?? String(err),
    };
  }
  return {
    modelLabel: model.label,
    scenarioName: input.scenarioName,
    ok: true,
    ms: Date.now() - t0,
    ttftMs,
    visibleChars,
    reasoningChars,
    toolCalls,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    preview: previewBuf.join('').slice(0, 240),
  };
}

function mutateMessagesForModel(model: ModelConfig, msgs: LLMMessage[]): LLMMessage[] {
  if (!model.noThink) return msgs;
  // Prepend `/no_think` to the first user message — qwen prompt-level signal.
  const out = [...msgs];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role === 'user') {
      const orig = typeof out[i]!.content === 'string' ? out[i]!.content as string : '';
      out[i] = { ...out[i]!, content: `/no_think ${orig}` };
      break;
    }
  }
  return out;
}

async function runMultiTurn(model: ModelConfig): Promise<CellResult> {
  const t0 = Date.now();
  let ttftMs: number | null = null;
  let visibleChars = 0;
  let reasoningChars = 0;
  let toolCalls = 0;
  let turnsUsed = 0;
  const previewBuf: string[] = [];
  let previewLen = 0;
  const messages: LLMMessage[] = mutateMessagesForModel(model, [{
    role: 'user',
    content:
      'Find Python files in this repo, then read the first one and tell me ' +
      "what's wrong with it. Use the bash and read_file tools — don't guess. " +
      'After you have the answer, give a short one-line diagnosis.',
  }]);
  const tools: LLMToolSpec[] = [
    {
      name: 'bash',
      description: 'Run a shell command and return its stdout.',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string', description: 'Shell command to run.' } },
        required: ['cmd'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the local filesystem and return its contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative or absolute path.' } },
        required: ['path'],
      },
    },
  ];
  try {
    const finalText = await streamLLMWithTools(messages, {
      onText: (delta, _full) => {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        visibleChars += delta.length;
        if (previewLen < 240) {
          previewBuf.push(delta);
          previewLen += delta.length;
        }
      },
      onReasoning: (ev) => {
        if (ev.kind === 'summary_delta') {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          reasoningChars += ev.delta.length;
        }
      },
      onToolCall: (call) => {
        toolCalls++;
        if (previewLen < 240) {
          const s = `[tool: ${call.name}(${JSON.stringify(call.args).slice(0, 60)})] `;
          previewBuf.push(s);
          previewLen += s.length;
        }
      },
      dispatchTool: async (name, args) => {
        if (name === 'bash') return { stdout: BASH_FAKE(String((args as any).cmd ?? '')) };
        if (name === 'read_file') return { content: READ_FILE_FAKE(String((args as any).path ?? '')) };
        return { error: `unknown tool ${name}` };
      },
      onTurnEnd: () => { turnsUsed++; },
    }, {
      provider: model.provider,
      model: model.model,
      tools,
      maxTokens: 4096,
      maxTurns: 6,
      temperature: 0.3,
    });
    return {
      modelLabel: model.label,
      scenarioName: 'multi-turn-agent',
      ok: true,
      ms: Date.now() - t0,
      ttftMs,
      visibleChars,
      reasoningChars,
      toolCalls,
      turnsUsed,
      completedFinalText: finalText.trim().length > 0,
      preview: previewBuf.join('').slice(0, 240),
    };
  } catch (err: any) {
    return {
      modelLabel: model.label,
      scenarioName: 'multi-turn-agent',
      ok: false,
      ms: Date.now() - t0,
      ttftMs,
      visibleChars,
      reasoningChars,
      toolCalls,
      turnsUsed,
      preview: previewBuf.join('').slice(0, 240),
      error: err?.message ?? String(err),
    };
  }
}

const SCENARIOS: SingleTurnInput[] = [
  {
    scenarioName: 'analysis',
    messages: [{
      role: 'user',
      content:
        'Read this Python snippet and give me 3 specific concrete improvements. ' +
        'One sentence per improvement, no preamble:\n\n' +
        '```py\ndef parse_csv(path):\n  rows = []\n  for line in open(path).readlines():\n' +
        '    rows.append(line.strip().split(","))\n  return rows\n```',
    }],
    maxTokens: 4096,
  },
  {
    scenarioName: 'coding',
    messages: [{
      role: 'user',
      content:
        'Write a TypeScript function `chunkArray<T>(arr: T[], size: number): T[][]` ' +
        'that splits an array into fixed-size chunks. Throw `RangeError` when size < 1. ' +
        'Reply with ONLY the function in a single ```ts code block, no commentary.',
    }],
    maxTokens: 4096,
  },
  {
    scenarioName: 'debugging',
    messages: [{
      role: 'user',
      content:
        'I see this error trace. Use the `read_file` tool to inspect the offending file ' +
        'before answering — pick the most likely path from the trace.\n\n' +
        '```\nTraceback (most recent call last):\n' +
        '  File "src/billing/invoice.py", line 42, in render\n' +
        '    total = sum(items)\n' +
        'TypeError: unsupported operand type(s) for +: \'int\' and \'NoneType\'\n```',
    }],
    tools: [{
      name: 'read_file',
      description: 'Read a file from the local filesystem.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }],
    maxTokens: 4096,
  },
];

function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtN(n: number | undefined): string {
  return n === undefined ? '—' : String(n);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelsArg = argv.find(a => a.startsWith('--models='))?.slice('--models='.length);
  const scenariosArg = argv.find(a => a.startsWith('--scenarios='))?.slice('--scenarios='.length);
  console.log('# qwen 3.6 pipeline bench (comparative)');
  console.log(`  date: ${new Date().toISOString()}`);
  console.log('');

  await probeAndConfirmLocal();
  const models = selectModels(modelsArg);
  if (models.length === 0) {
    console.log('No usable models. Exit.');
    process.exit(1);
  }
  console.log(`▶ Active models: ${models.map(m => m.label).join(', ')}`);
  console.log('');

  const scenarioFilter = scenariosArg ? new Set(scenariosArg.split(',')) : null;
  const scenariosToRun = SCENARIOS.filter(s => !scenarioFilter || scenarioFilter.has(s.scenarioName));
  const includeMultiTurn = !scenarioFilter || scenarioFilter.has('multi-turn-agent');

  const cells: CellResult[] = [];
  for (const m of models) {
    console.log(`──── ${m.label} ────`);
    for (const s of scenariosToRun) {
      process.stdout.write(`  ${s.scenarioName.padEnd(11)} … `);
      const r = await runSingleTurn(m, s);
      cells.push(r);
      const tag = r.ok ? '✓' : '✗';
      console.log(
        `${tag} ${fmtMs(r.ms).padStart(7)}  ` +
        `vis=${String(r.visibleChars).padStart(4)}  ` +
        `think=${String(r.reasoningChars).padStart(4)}  ` +
        `tools=${r.toolCalls}  ` +
        `tok(in/out${r.reasoningTokens !== undefined ? '/think' : ''})=` +
        `${fmtN(r.inputTokens)}/${fmtN(r.outputTokens)}` +
        (r.reasoningTokens !== undefined ? `/${fmtN(r.reasoningTokens)}` : '') +
        (r.error ? `  err=${r.error.slice(0, 40)}` : ''),
      );
    }
    if (includeMultiTurn) {
      process.stdout.write(`  multi-turn  … `);
      const r = await runMultiTurn(m);
      cells.push(r);
      const tag = r.ok ? '✓' : '✗';
      console.log(
        `${tag} ${fmtMs(r.ms).padStart(7)}  ` +
        `vis=${String(r.visibleChars).padStart(4)}  ` +
        `think=${String(r.reasoningChars).padStart(4)}  ` +
        `tools=${r.toolCalls}  turns=${r.turnsUsed ?? 0}  ` +
        `final=${r.completedFinalText ? 'y' : 'n'}` +
        (r.error ? `  err=${r.error.slice(0, 40)}` : ''),
      );
    }
    console.log('');
  }

  // Summary table — one row per (model, scenario)
  console.log('# Summary table');
  console.log('');
  const header = ['model', 'scenario', 'ok', 'wall', 'ttft', 'visible', 'reason', 'tools', 'turns', 'final'];
  const rows = [header];
  for (const c of cells) {
    rows.push([
      c.modelLabel,
      c.scenarioName,
      c.ok ? '✓' : '✗',
      fmtMs(c.ms),
      c.ttftMs === null ? '—' : fmtMs(c.ttftMs),
      String(c.visibleChars),
      String(c.reasoningChars),
      String(c.toolCalls),
      c.turnsUsed === undefined ? '' : String(c.turnsUsed),
      c.completedFinalText === undefined ? '' : (c.completedFinalText ? 'y' : 'n'),
    ]);
  }
  const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]!.length)));
  for (const r of rows) {
    console.log('  ' + r.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  }
  console.log('');

  // Aggregate · per-model average wall time / total visible / total reasoning
  console.log('# Per-model aggregates');
  console.log('');
  const agg: Record<string, { count: number; totalMs: number; totalVis: number; totalReason: number; toolCalls: number; ok: number }> = {};
  for (const c of cells) {
    const a = (agg[c.modelLabel] ||= { count: 0, totalMs: 0, totalVis: 0, totalReason: 0, toolCalls: 0, ok: 0 });
    a.count++;
    a.totalMs += c.ms;
    a.totalVis += c.visibleChars;
    a.totalReason += c.reasoningChars;
    a.toolCalls += c.toolCalls;
    if (c.ok) a.ok++;
  }
  console.log('  model                  ok  avgWall   visTotal  reasonTotal  toolCalls  reason:vis');
  for (const [label, a] of Object.entries(agg)) {
    const avgMs = a.count > 0 ? a.totalMs / a.count : 0;
    const ratio = a.totalVis > 0 ? (a.totalReason / a.totalVis).toFixed(2) + 'x' : '—';
    console.log(
      `  ${label.padEnd(22)} ${a.ok}/${a.count}  ` +
      `${fmtMs(Math.round(avgMs)).padStart(7)}  ` +
      `${String(a.totalVis).padStart(8)}  ` +
      `${String(a.totalReason).padStart(11)}  ` +
      `${String(a.toolCalls).padStart(9)}  ` +
      `${ratio.padStart(10)}`,
    );
  }
  console.log('');
  console.log(`# done · ${cells.filter(c => c.ok).length}/${cells.length} cells passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
