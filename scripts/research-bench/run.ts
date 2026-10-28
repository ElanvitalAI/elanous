#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateLlmCost } from '../../src/budget/llm-cost.js';

export interface ResearchQuestion {
  id: string;
  domain: 'finance' | 'technology' | 'market';
  bloom: string[];
  requiresHigherOrder: boolean;
  prompt: string;
}

export interface HarnessAdapter {
  command: string;
  args: string[];
  cwd?: string;
  model: string;
  toolPolicyId: string;
  maxTurns: number;
  timeoutMs: number;
  usageSource: 'elanous-logs' | 'claude-stream-json';
  usageCommand?: string;
  usageArgs?: string[];
  usageTimeoutMs?: number;
  officialPricing?: { inputPerM: number; outputPerM: number; cacheReadPerM: number; cacheWritePerM: number; sourceUrl: string };
}

export interface AdapterConfig {
  version: 2;
  baselineProbe: { command: string; args: string[] };
  cells: Record<string, { description: string; elanous: HarnessAdapter; claudeCode?: HarnessAdapter }>;
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = resolve(ROOT, 'questions.json');
const CELL_DESIGNS = [
  { id: 'A0', group: 'control', bloomCeiling: 0, layout: 'baseline', claudeCode: true },
  { id: 'A1', group: 'bloom-ablation', bloomCeiling: 3, layout: 'baseline', claudeCode: true },
  { id: 'A2', group: 'bloom-ablation', bloomCeiling: 5, layout: 'baseline', claudeCode: true },
  { id: 'A3', group: 'bloom-ablation', bloomCeiling: 6, layout: 'baseline', claudeCode: true },
  { id: 'B', group: 'product', bloomCeiling: 0, layout: 'product-default', claudeCode: true },
  { id: 'P1', group: 'layout-ablation', bloomCeiling: 6, layout: 'linear-1-to-6', claudeCode: false },
  { id: 'P5', group: 'layout-ablation', bloomCeiling: 6, layout: 'p5-front6-parallel-bottom-loop-4-5', claudeCode: false },
  { id: 'P5-no-front6', group: 'layout-ablation', bloomCeiling: 6, layout: 'p5-without-front6', claudeCode: false },
] as const;
const PLACEHOLDERS = ['{prompt}', '{questionId}', '{runId}', '{cellId}', '{bloomCeiling}', '{layout}'] as const;
const API_STOP_USD = 160;
const PRICE_SOURCES = ['https://platform.claude.com/docs/en/build-with-claude/prompt-caching', 'https://www.anthropic.com/claude/opus'];
const BLOOM_STAGE_INSTRUCTIONS: Record<number, string> = {
  3: 'Structure the work explicitly through Bloom stages 1–3: state relevant facts, explain the governing concepts, and apply them to the evidence.',
  5: 'Structure the work explicitly through Bloom stages 1–5: state relevant facts, explain concepts, apply evidence, decompose causes/gaps/contradictions, then evaluate source strength and strongest counterevidence.',
  6: 'Structure the work explicitly through Bloom stages 1–6: state facts, explain concepts, apply evidence, analyze causes/gaps/contradictions, evaluate source strength and counterevidence, then synthesize a conditional scenario/output.',
};
const LAYOUT_INSTRUCTIONS: Record<string, string> = {
  'linear-1-to-6': 'Follow one linear sequence exactly once: stages 1→2→3→4→5→6. Do not parallelize or loop back.',
  'p5-front6-parallel-bottom-loop-4-5': 'First reverse-design the target answer with stage 6 (define answer shape only, no speculative findings). Then establish stage 2 axes; gather stages 1 and 3 in parallel for each axis; run a central stage 4/5 loop that adds or deepens only evidence-backed gaps and records why it stops; finally synthesize with stage 6 from evaluated evidence only.',
  'p5-without-front6': 'Establish stage 2 axes; gather stages 1 and 3 in parallel for each axis; run a central stage 4/5 loop that adds or deepens only evidence-backed gaps and records why it stops; finally synthesize with stage 6 from evaluated evidence only. Do not reverse-design the output before research.',
};

export function validateQuestions(value: unknown): ResearchQuestion[] {
  if (!Array.isArray(value) || value.length !== 10) throw new Error('questions.json must contain exactly 10 questions');
  const questions = value as ResearchQuestion[];
  const ids = new Set<string>();
  const domains = new Set<string>();
  const blooms = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !q.id.trim() || ids.has(q.id)) throw new Error('question ids must be non-empty and unique');
    if (!['finance', 'technology', 'market'].includes(q.domain)) throw new Error(`unsupported domain: ${q.domain}`);
    if (!Array.isArray(q.bloom) || !q.bloom.length || typeof q.prompt !== 'string' || !q.prompt.trim()) throw new Error(`invalid question: ${q.id}`);
    ids.add(q.id); domains.add(q.domain); q.bloom.forEach(stage => blooms.add(stage));
  }
  if (domains.size !== 3) throw new Error('questions must cover finance, technology, and market');
  for (const stage of ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']) {
    if (!blooms.has(stage)) throw new Error(`questions omit Bloom stage: ${stage}`);
  }
  if (questions.filter(q => q.requiresHigherOrder && q.bloom.some(stage => stage === 'analyze' || stage === 'evaluate')).length < 4) throw new Error('at least four questions must require Bloom analyze/evaluate');
  return questions;
}

export function validateConfig(config: AdapterConfig, totalCapUsd?: number): void {
  if (config.version !== 2 || (totalCapUsd !== undefined && (!Number.isFinite(totalCapUsd) || totalCapUsd <= 0))) throw new Error('config version 2 and positive total cost cap are required');
  if (!config.baselineProbe?.command || !Array.isArray(config.baselineProbe.args)) throw new Error('config requires a baseline version probe');
  const requiredCells = CELL_DESIGNS.map(cell => cell.id);
  for (const cellId of requiredCells) {
    const cell = config.cells?.[cellId];
    if (!cell?.elanous || !cell.elanous.command) throw new Error(`${cellId}: Elanous adapter is required`);
    if (CELL_DESIGNS.find(item => item.id === cellId)!.claudeCode && (!cell.claudeCode || !cell.claudeCode.command)) throw new Error(`${cellId}: Claude Code adapter is required`);
    for (const [name, adapter] of [['elanous', cell.elanous], ...(cell.claudeCode ? [['claudeCode', cell.claudeCode] as const] : [])] as const) {
    if (!Array.isArray(adapter.args) || !adapter.args.some(arg => arg.includes('{prompt}'))) throw new Error(`${name} args must include the prompt placeholder`);
    if (!Number.isInteger(adapter.maxTurns) || adapter.maxTurns < 1) throw new Error(`${name} requires positive maxTurns`);
    if (!Number.isInteger(adapter.timeoutMs) || adapter.timeoutMs < 1000) throw new Error(`${name} timeoutMs must be at least 1000`);
    if (name === 'elanous' && (adapter.usageSource !== 'elanous-logs' || !adapter.usageCommand || !adapter.usageArgs?.some(arg => arg.includes('{sessionId}')) || !adapter.args.some(arg => arg.startsWith('ELANOUS_STATE_DIR=')))) throw new Error('Elanous adapters must pass an isolated ELANOUS_STATE_DIR and read per-session llm-usage logs');
    if (name === 'claudeCode' && adapter.usageSource !== 'claude-stream-json') throw new Error('Claude Code adapters must emit stream-json usage events');
  }
  }
  for (const cellId of ['A0', 'A1', 'A2', 'A3'] as const) {
    const cell = config.cells[cellId]; const a = cell.elanous; const b = cell.claudeCode!;
    if (a.model !== b.model || a.toolPolicyId !== b.toolPolicyId || a.maxTurns !== b.maxTurns || a.timeoutMs !== b.timeoutMs || JSON.stringify(a.officialPricing) !== JSON.stringify(b.officialPricing)) throw new Error(`${cellId}: controlled arm requires matching model, tool, turn, timeout, and pricing conditions`);
    if (cellId !== 'A0') {
      const baseline = config.cells.A0.elanous;
      if (a.model !== baseline.model || a.toolPolicyId !== baseline.toolPolicyId || a.maxTurns !== baseline.maxTurns || a.timeoutMs !== baseline.timeoutMs || JSON.stringify(a.officialPricing) !== JSON.stringify(baseline.officialPricing) || JSON.stringify(b.officialPricing) !== JSON.stringify(config.cells.A0.claudeCode!.officialPricing)) throw new Error(`${cellId}: Bloom ablation must match A0 model/tool/turn/timeout/pricing`);
    }
  }
  if (totalCapUsd !== undefined && (!Number.isFinite(totalCapUsd) || totalCapUsd < API_STOP_USD || totalCapUsd > 200)) throw new Error('approved API spend cap must be between $160 stop threshold and $200 maximum');
}

export function makeRunPlan(questions: ResearchQuestion[], config: AdapterConfig, runId: string, pilot = false, smokePairs = 0) {
  const selected = smokePairs > 0
    ? (['finance', 'technology', 'market'] as const).slice(0, smokePairs).map(domain => questions.find(question => question.domain === domain)!).filter(Boolean)
    : pilot
    ? (['finance', 'technology', 'market'] as const).map(domain => questions.find(question => question.domain === domain)!).filter(Boolean)
    : questions;
  const designs = smokePairs > 0 ? CELL_DESIGNS.filter(design => design.id === 'A0') : CELL_DESIGNS;
  return {
    runId,
    questionCount: selected.length,
    ...(smokePairs > 0 ? { smokePairs: selected.length } : {}),
    calls: selected.flatMap((question, questionIndex) => designs.flatMap((design, cellIndex) => {
      const harnesses = design.claudeCode
        ? ((questionIndex + cellIndex) % 2 === 0 ? ['elanous', 'claudeCode'] as const : ['claudeCode', 'elanous'] as const)
        : ['elanous'] as const;
      return harnesses.map(harness => ({ questionId: question.id, domain: question.domain, cell: design.id, group: design.group, bloomCeiling: design.bloomCeiling, layout: design.layout, harness }));
    })),
    apiCalls: selected.length * designs.length,
    phase: smokePairs > 0 ? 'execution-validation-smoke' : pilot ? 'pilot' : 'full',
  };
}

export function buildPrompt(question: ResearchQuestion, call: { cell: string; bloomCeiling: number; layout: string }, date: string): string {
  const bloomDirective = call.bloomCeiling > 0 ? `\n\n${BLOOM_STAGE_INSTRUCTIONS[call.bloomCeiling] ?? BLOOM_STAGE_INSTRUCTIONS[6]}` : '';
  const layoutDirective = LAYOUT_INSTRUCTIONS[call.layout] ? `\n\nExperimental procedure: ${LAYOUT_INSTRUCTIONS[call.layout]}` : '';
  return `Date: ${date}. Research with web sources and cite original URLs for material claims. Mark unknowns instead of guessing. Do not create or edit files. Keep within eight tool turns.\n\n${question.prompt}${bloomDirective}${layoutDirective}`;
}

function interpolate(args: string[], values: Record<(typeof PLACEHOLDERS)[number], string>): string[] {
  return args.map(arg => PLACEHOLDERS.reduce((result, marker) => result.replaceAll(marker, values[marker]), arg));
}

export function execute(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ stdout: string; stderr: string; code: number | null; durationMs: number; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const envNames = new Set(['ELANOUS_STATE_DIR', 'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'ELANOUS_ESCALATE_PROVIDER', 'ELANOUS_ESCALATE_MODEL']);
    const envAssignments = Object.fromEntries(args.flatMap(arg => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
      return match && envNames.has(match[1]!) ? [[match[1]!, match[2]!]] : [];
    }));
    const launchArgs = command.split('/').at(-1) === 'env' ? args : args.filter(arg => !/^(ELANOUS_STATE_DIR|ELANOUS_LLM_PROVIDER|ELANOUS_LLM_MODEL|ELANOUS_ESCALATE_PROVIDER|ELANOUS_ESCALATE_MODEL)=/.test(arg));
    const child = spawn(command, launchArgs, { shell: false, ...(cwd ? { cwd } : {}), env: { ...process.env, ...envAssignments }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => { stdout += part; if (stdout.length > 8_000_000) { child.kill('SIGTERM'); reject(new Error('adapter stdout exceeded 8 MB')); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part: string) => { stderr += part; if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); });
    child.on('error', error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolvePromise({ stdout, stderr, code, durationMs: Date.now() - startedAt, timedOut }); });
  });
}

async function latestSessionId(args: string[], startedAt: string): Promise<string | undefined> {
  const stateRoot = args.find(arg => arg.startsWith('ELANOUS_STATE_DIR='))?.slice('ELANOUS_STATE_DIR='.length);
  if (!stateRoot) return undefined;
  try {
    const sessions = JSON.parse(await readFile(resolve(stateRoot, 'sessions/index.json'), 'utf8')) as Array<{ id?: string; createdAt?: string }>;
    return sessions.filter(session => typeof session.id === 'string' && typeof session.createdAt === 'string' && Date.parse(session.createdAt) >= Date.parse(startedAt))
      .sort((left, right) => Date.parse(right.createdAt!) - Date.parse(left.createdAt!))[0]?.id;
  } catch { return undefined; }
}

async function recoveredSessionAnswer(args: string[], sessionId: string): Promise<string | undefined> {
  const stateRoot = args.find(arg => arg.startsWith('ELANOUS_STATE_DIR='))?.slice('ELANOUS_STATE_DIR='.length);
  if (!stateRoot) return undefined;
  try {
    const lines = (await readFile(resolve(stateRoot, 'sessions', `${sessionId}.jsonl`), 'utf8')).split(/\r?\n/).filter(Boolean);
    const assistantRows = lines.flatMap(line => {
      try { const row = JSON.parse(line); return row.role === 'assistant' && typeof row.content === 'string' ? [row] : []; } catch { return []; }
    });
    return assistantRows.at(-1)?.content;
  } catch { return undefined; }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function parseJsonLines(value: string): Record<string, any>[] {
  return value.split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; } });
}

export function usageCostUsd(usage: { model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }, officialPricing?: HarnessAdapter['officialPricing']): number {
  if (officialPricing) return (usage.inputTokens * officialPricing.inputPerM + usage.outputTokens * officialPricing.outputPerM + (usage.cacheReadInputTokens ?? 0) * officialPricing.cacheReadPerM + (usage.cacheCreationInputTokens ?? 0) * officialPricing.cacheWritePerM) / 1_000_000;
  const estimate = estimateLlmCost(usage);
  if (estimate.kind === 'unknown' || estimate.kind === 'partial') throw new Error(`no complete catalog price for model ${usage.model}`);
  return estimate.usd;
}

export async function verifyConfiguredBaseline(config: AdapterConfig, baselineSha: string): Promise<string> {
  const probe = await execute(config.baselineProbe.command, config.baselineProbe.args, 20_000);
  if (probe.timedOut || probe.code !== 0) throw new Error(`baseline version probe failed: ${probe.stderr.slice(-1200) || `exit ${probe.code}`}`);
  const version = probe.stdout.trim();
  if (!version.split(/\s+/).includes(baselineSha)) throw new Error(`baseline version probe did not report ${baselineSha}: ${version || '(empty)'}`);
  return version;
}

export function validateCliArgs(argv: string[]): void {
  const booleanFlags = new Set(['--dry-run', '--live', '--pilot', '--full', '--no-cost-cap']);
  const valueFlags = new Set(['--config', '--max-total-cost-usd', '--out', '--approval-ref', '--baseline-sha', '--smoke-pairs', '--resume']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (booleanFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    i++;
  }
  if (argv.includes('--pilot') && argv.includes('--full')) throw new Error('--pilot and --full are mutually exclusive');
  if ((argv.includes('--pilot') || argv.includes('--full')) && argv.includes('--smoke-pairs')) throw new Error('--smoke-pairs conflicts with --pilot/--full');
  if (argv.includes('--no-cost-cap') && argv.includes('--max-total-cost-usd')) throw new Error('--no-cost-cap conflicts with --max-total-cost-usd');
  if (argv.includes('--no-cost-cap') && !argv.includes('--live')) throw new Error('--no-cost-cap requires --live');
  if (argv.includes('--no-cost-cap') && !argv.includes('--approval-ref')) throw new Error('--no-cost-cap requires --approval-ref (for example OP#42096)');
  if (argv.includes('--approval-ref') && !argv.includes('--no-cost-cap')) throw new Error('--approval-ref requires --no-cost-cap');
  if (argv.includes('--resume') && !argv.includes('--live')) throw new Error('--resume requires --live');
  if (argv.includes('--live') && !argv.includes('--no-cost-cap') && !argv.includes('--max-total-cost-usd')) throw new Error('--live requires --max-total-cost-usd or --no-cost-cap');
  if (argv.includes('--live') && !argv.includes('--pilot') && !argv.includes('--full') && !argv.includes('--smoke-pairs')) throw new Error('--live requires exactly one of --pilot, --full, or --smoke-pairs');
  if (argv.includes('--live') && argv.includes('--smoke-pairs')) {
    const value = Number(argv[argv.indexOf('--smoke-pairs') + 1]);
    if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error('--smoke-pairs must be an integer from 1 to 3');
  }
  if (argv.includes('--live') && !/^[0-9a-f]{40}$/i.test(argv[argv.indexOf('--baseline-sha') + 1] ?? '')) throw new Error('--live requires --baseline-sha with a full 40-character commit SHA');
}

export function completedCallKeys(records: Array<Record<string, unknown>>): Set<string> {
  return new Set(records.map(record => `${record.questionId}:${record.cell}:${record.harness}`));
}

export function claudeAuthSummary(stdout: string): Record<string, unknown> {
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    return Object.fromEntries(['loggedIn', 'authMethod', 'subscriptionType', 'hasApiKey']
      .filter(key => typeof status[key] === 'boolean' || typeof status[key] === 'string')
      .map(key => [key, status[key]]));
  } catch {
    return { parseError: 'claude auth status returned non-JSON output' };
  }
}

export function buildResumeEvent(records: Array<Record<string, unknown>>, ledger: TimeoutLedger, at = new Date().toISOString()): Record<string, unknown> {
  return {
    at,
    savedCallCount: records.length,
    savedFailureCount: records.filter(record => Number(record.exitCode) !== 0 || Boolean(record.error)).length,
    apiSpendUsd: ledger.cumulativeApiSpendUsd,
    accountingIncomplete: Boolean(ledger.accountingIncomplete),
  };
}

export function nextClaudeExitOneCount(previousCount: number, exitCode: unknown): number {
  return Number(exitCode) === 1 ? previousCount + 1 : 0;
}

export function shouldSkipCallAfterClaudeFailures(harness: string, cellId: string, skippedCells: ReadonlySet<string>): boolean {
  return harness === 'claudeCode' && skippedCells.has(cellId);
}

async function claudeFailureDiagnostics(command: string): Promise<Record<string, unknown>> {
  const [version, auth] = await Promise.all([
    execute(command, ['--version'], 10_000),
    execute(command, ['auth', 'status', '--json'], 10_000),
  ]);
  return {
    sampledAt: new Date().toISOString(),
    version: version.code === 0 ? version.stdout.trim().slice(0, 200) : `unavailable (exit ${version.code ?? 'null'})`,
    auth: auth.code === 0 ? claudeAuthSummary(auth.stdout) : { unavailable: `exit ${auth.code ?? 'null'}` },
  };
}

async function collectUsage(adapter: HarnessAdapter, stdout: string, fallbackSessionId?: string): Promise<{ usage: Array<Record<string, unknown>>; apiSpendUsd: number; sessionId?: string }> {
  if (adapter.usageSource === 'claude-stream-json') {
    const events = parseJsonLines(stdout);
    const usage = events.flatMap(event => {
      const raw = event.message?.usage ?? event.usage;
      if (!raw) return [];
      const reportedModel = event.message?.model ?? event.model;
      const model = typeof reportedModel === 'string' ? reportedModel : 'unknown';
      const inputTokens = raw.input_tokens ?? raw.inputTokens;
      const outputTokens = raw.output_tokens ?? raw.outputTokens;
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return [];
      const tokens = { model, inputTokens, outputTokens, cacheReadInputTokens: raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0, cacheCreationInputTokens: raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0 };
      let apiEquivalentUsd: number | undefined;
      try { apiEquivalentUsd = usageCostUsd(tokens, model === adapter.model ? adapter.officialPricing : undefined); } catch { /* retain the token record; mark its price unknown */ }
      return [{ ...tokens, apiSpendUsd: 0, apiEquivalentUsd, billing: 'subscription' }];
    });
    if (!usage.length) throw new Error('Claude stream-json contained no token usage; refusing to advance the spend ledger');
    return { usage, apiSpendUsd: 0 };
  }
  const response = parseJsonLines(stdout).find(row => typeof row.sessionId === 'string');
  const sessionId = response?.sessionId ?? fallbackSessionId;
  if (!sessionId) throw new Error('Elanous JSON response and isolated session index did not include sessionId');
  const usageArgs = (adapter.usageArgs ?? []).map(arg => arg.replaceAll('{sessionId}', sessionId));
  const result = await execute(adapter.usageCommand!, usageArgs, adapter.usageTimeoutMs ?? Math.min(adapter.timeoutMs, 30_000), adapter.cwd);
  if (result.timedOut) throw new Error(`Elanous usage log query timed out after ${adapter.timeoutMs}ms`);
  if (result.code !== 0) throw new Error(`Elanous usage log query exited ${result.code}: ${result.stderr.slice(-1200)}`);
  const rows = parseJsonLines(result.stdout).filter(row => row.session_id === sessionId && row.event === 'llm-usage');
  const usage = rows.map(row => {
    const data = row.data ?? {}; const cost = data.cost ?? {};
    if (typeof data.inputTokens !== 'number' || typeof data.outputTokens !== 'number') throw new Error('Elanous usage event omitted token counts');
    const billing = data.billing ?? 'unknown';
    const tokens = { model: data.model, inputTokens: data.inputTokens, outputTokens: data.outputTokens, cacheReadInputTokens: data.cacheReadInputTokens ?? 0, cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0 };
    let officialModelCost: number | undefined;
    try { officialModelCost = usageCostUsd(tokens, data.model === adapter.model ? adapter.officialPricing : undefined); } catch { /* fall back to the provider's recorded model-catalog estimate below */ }
    const knownCatalogCost = ['known', 'actual', 'included'].includes(cost.kind) && typeof cost.usd === 'number';
    if (billing === 'api' && officialModelCost === undefined && !knownCatalogCost) throw new Error(`unknown API price for ${data.model}; refusing to advance the spend ledger`);
    const apiSpendUsd = billing === 'api' ? (officialModelCost ?? cost.usd) : 0;
    if (billing === 'unknown') throw new Error(`unknown billing route for ${data.model}; refusing to advance the spend ledger`);
    return { ...tokens, apiSpendUsd, billing, apiEquivalentUsd: officialModelCost ?? cost.apiEquivalentUsd ?? (knownCatalogCost ? cost.usd : undefined), priceSource: adapter.officialPricing?.sourceUrl ?? cost.source ?? (knownCatalogCost ? 'model-catalog' : undefined) };
  });
  if (!usage.length) throw new Error('Elanous session had no llm-usage events; refusing to advance the spend ledger');
  return { usage, apiSpendUsd: usage.reduce((sum, row) => sum + Number(row.apiSpendUsd ?? 0), 0), sessionId };
}

interface TimeoutLedger {
  runId: string;
  maxApiSpendUsd: number | null;
  stopBeforeNextPairAtUsd: number | null;
  cumulativeApiSpendUsd: number;
  accountingIncomplete?: boolean;
  records: unknown[];
}

export async function processTimedOutInvocation(input: {
  adapter: HarnessAdapter;
  args: string[];
  call: object;
  prompt: string;
  startedAt: string;
  result: Awaited<ReturnType<typeof execute>>;
  outDir: string;
  records: Record<string, unknown>[];
  ledger: TimeoutLedger;
}): Promise<{ stop: boolean }> {
  const { adapter, args, call, prompt, startedAt, result, outDir, records, ledger } = input;
  const sessionId = adapter.usageSource === 'elanous-logs' ? await latestSessionId(args, startedAt) : undefined;
  const recoveredAnswer = sessionId ? await recoveredSessionAnswer(args, sessionId) : undefined;
  let usage: Awaited<ReturnType<typeof collectUsage>> | undefined;
  let usageError: string | undefined;
  try { usage = await collectUsage(adapter, result.stdout, sessionId); }
  catch (error) { usageError = error instanceof Error ? error.message : String(error); }
  if (usage) ledger.cumulativeApiSpendUsd += usage.apiSpendUsd;
  const finishedAt = new Date().toISOString();
  const record = {
    ...call,
    startedAt,
    finishedAt,
    elapsedMs: result.durationMs,
    exitCode: result.code,
    timedOut: true,
    error: `adapter timed out after ${adapter.timeoutMs}ms`,
    ...(usageError ? { usageError } : {}),
    model: adapter.model,
    promptSha256: sha256(prompt),
    ...(usage ? { usage: usage.usage, apiSpendUsd: usage.apiSpendUsd, sessionId: usage.sessionId } : sessionId ? { sessionId } : {}),
    stdout: result.stdout,
    ...(recoveredAnswer ? { recoveredAnswer, recoveredAnswerSource: 'isolated-session-final-assistant-message' } : {}),
    stderr: result.stderr.slice(-1200),
  };
  records.push(record);
  ledger.records.push({
    ...call,
    finishedAt,
    elapsedMs: result.durationMs,
    timeout: true,
    ...(usage ? { usage: usage.usage, apiSpendUsd: usage.apiSpendUsd } : { usageError }),
    sessionId,
    cumulativeApiSpendUsd: ledger.cumulativeApiSpendUsd,
  });
  if (usageError) ledger.accountingIncomplete = true;
  await writeFile(resolve(outDir, `${ledger.runId}.results.json`), JSON.stringify(records, null, 2));
  await writeFile(resolve(outDir, `${ledger.runId}.ledger.json`), JSON.stringify(ledger, null, 2));
  return { stop: Boolean(usageError) };
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const live = argv.includes('--live');
  const pilot = argv.includes('--pilot');
  const smokePairs = Number(argv.includes('--smoke-pairs') ? argv[argv.indexOf('--smoke-pairs') + 1] : 0);
  const noCostCap = argv.includes('--no-cost-cap');
  validateCliArgs(argv);
  if (dryRun === live) {
    throw new Error('usage: run.ts --dry-run | --live (--pilot|--full|--smoke-pairs <count>) --baseline-sha <sha> --config <json> (--max-total-cost-usd <usd>|--no-cost-cap --approval-ref <OP#id>) --out <seat-state/OP/evidence/path>');
  }
  const questions = validateQuestions(JSON.parse(await readFile(QUESTIONS_PATH, 'utf8')));
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', providerCalls: 0, questions: questions.map(({ id, domain, bloom, requiresHigherOrder }) => ({ id, domain, bloom, requiresHigherOrder })), cells: CELL_DESIGNS, smokePairCalls: 6, pilotCalls: 39, fullCalls: 130, elanousApiCallsPilot: 24, elanousApiCallsFull: 80, maxApiSpendUsd: 200, stopBeforeNextPairAtUsd: API_STOP_USD, controlArmConditionsRequired: ['same model', 'same tool policy', 'same turns', 'same timeout'], priceSources: PRICE_SOURCES, layoutCells: 'Elanous only; same Opus model' }, null, 2)}\n`);
    return;
  }
  const getArg = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const configPath = getArg('--config'); const outDirArg = getArg('--out'); const cap = noCostCap ? undefined : Number(getArg('--max-total-cost-usd')); const approvalRef = getArg('--approval-ref'); const baselineSha = getArg('--baseline-sha')!;
  if (!configPath || !outDirArg) throw new Error('--config and --out are required for live mode');
  const outDir = resolve(outDirArg);
  const evidenceRoot = resolve(process.env.HOME ?? '', 'elanous-hq/seat-state/OP/evidence');
  const outRelative = relative(evidenceRoot, outDir);
  if (!outRelative || outRelative.startsWith('..') || isAbsolute(outRelative)) throw new Error('--out must be under seat-state/OP/evidence');
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8')) as AdapterConfig;
  validateConfig(config, cap);
  const resumeId = getArg('--resume');
  const runId = resumeId ?? randomUUID();
  if (smokePairs > 3) throw new Error('--smoke-pairs must be an integer from 1 to 3');
  const baselineVersion = await verifyConfiguredBaseline(config, baselineSha);
  const plan = makeRunPlan(questions, config, runId, pilot, smokePairs);
  await mkdir(outDir, { recursive: true });
  const maxApiSpendUsd = cap ?? null;
  const stopBeforeNextPairAtUsd = noCostCap ? null : API_STOP_USD;
  const manifestPath = resolve(outDir, `${runId}.manifest.json`);
  const resultsPath = resolve(outDir, `${runId}.results.json`);
  const ledgerPath = resolve(outDir, `${runId}.ledger.json`);
  const manifest = { ...plan, baselineSha, baselineVersion, maxApiSpendUsd, stopBeforeNextPairAtUsd, ...(approvalRef ? { uncappedApprovalRef: approvalRef } : {}), priceSources: PRICE_SOURCES, questionHashes: Object.fromEntries(questions.map(q => [q.id, sha256(q.prompt)])) };
  if (resumeId) {
    const priorManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest & { runId: string; resumeEvents?: Record<string, unknown>[] };
    if (priorManifest.runId !== resumeId || priorManifest.baselineSha !== baselineSha || JSON.stringify(priorManifest.calls) !== JSON.stringify(plan.calls)) throw new Error('--resume manifest does not match this baseline and call plan');
    const resumeEvents = [...(priorManifest.resumeEvents ?? []), buildResumeEvent(JSON.parse(await readFile(resultsPath, 'utf8')), JSON.parse(await readFile(ledgerPath, 'utf8')) as TimeoutLedger)];
    await writeFile(manifestPath, JSON.stringify({ ...priorManifest, resumeEvents }, null, 2));
  } else {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, startedAt: new Date().toISOString() }, null, 2));
  }
  const records: Record<string, unknown>[] = resumeId ? JSON.parse(await readFile(resultsPath, 'utf8')) : [];
  const ledger: TimeoutLedger = resumeId ? JSON.parse(await readFile(ledgerPath, 'utf8')) : { runId, maxApiSpendUsd, stopBeforeNextPairAtUsd, cumulativeApiSpendUsd: 0, records: [] };
  if (ledger.runId !== runId) throw new Error('--resume ledger run id mismatch');
  for (const record of records) {
    if (record.harness === 'claudeCode' && Number(record.exitCode) !== 0 && !String(record.stderr ?? '').trim() && !record.claudeDiagnostics) {
      record.claudeDiagnostics = await claudeFailureDiagnostics(config.cells[String(record.cell)]!.claudeCode!.command);
    }
  }
  if (resumeId) await writeFile(resultsPath, JSON.stringify(records, null, 2));
  const completedCalls = completedCallKeys(records);
  const claudeExitOneCounts = new Map<string, number>();
  const skippedCells = new Set<string>();
  const teamclaudeStatuses = new Map<string, string>();
  for (const record of records) {
    const cell = String(record.cell ?? '');
    if (typeof record.teamclaudeStatus === 'string') teamclaudeStatuses.set(cell, record.teamclaudeStatus);
    if (record.harness === 'claudeCode') {
      const next = nextClaudeExitOneCount(claudeExitOneCounts.get(cell) ?? 0, record.exitCode);
      claudeExitOneCounts.set(cell, next);
      if (next >= 3) skippedCells.add(cell);
    }
  }
  let activePair = '';
  let stoppedAtThreshold = false;
  for (const call of plan.calls) {
    if (completedCalls.has(`${call.questionId}:${call.cell}:${call.harness}`)) continue;
    if (shouldSkipCallAfterClaudeFailures(call.harness, call.cell, skippedCells)) {
      if (!teamclaudeStatuses.has(call.cell)) {
        const status = await execute('teamclaude', ['status'], 10_000, config.cells[call.cell].claudeCode?.cwd);
        teamclaudeStatuses.set(call.cell, (status.stdout || status.stderr).trim().split('\n').slice(0, 1).join(' ').slice(0, 500) || `teamclaude status exited ${status.code}`);
      }
      const row = { ...call, finishedAt: new Date().toISOString(), exitCode: null, skipped: true, error: 'configuration skipped after three Claude Code exit 1 failures', teamclaudeStatus: teamclaudeStatuses.get(call.cell) };
      records.push(row);
      completedCalls.add(`${call.questionId}:${call.cell}:${call.harness}`);
      await writeFile(resultsPath, JSON.stringify(records, null, 2));
      continue;
    }
    const pairKey = `${call.questionId}:${call.cell}`;
    if (!noCostCap && activePair && pairKey !== activePair && ledger.cumulativeApiSpendUsd >= API_STOP_USD) { stoppedAtThreshold = true; break; }
    activePair = pairKey;
    const q = questions.find(item => item.id === call.questionId)!;
    const adapter = config.cells[call.cell][call.harness]!;
    const prompt = buildPrompt(q, call, new Date().toISOString().slice(0, 10));
    const args = interpolate(adapter.args, { '{prompt}': prompt, '{questionId}': q.id, '{runId}': runId, '{cellId}': call.cell, '{bloomCeiling}': String(call.bloomCeiling), '{layout}': call.layout });
    const startedAt = new Date().toISOString();
    let rawResult: Awaited<ReturnType<typeof execute>> | undefined;
    try {
      const result = await execute(adapter.command, args, adapter.timeoutMs, adapter.cwd);
      rawResult = result;
      if (result.timedOut) {
        const outcome = await processTimedOutInvocation({ adapter, args, call, prompt, startedAt, result, outDir, records, ledger });
        if (outcome.stop) break;
        continue;
      }
      if (result.code !== 0) throw new Error(`${call.harness} exited ${result.code}: ${result.stderr.slice(-1200)}`);
      const usage = await collectUsage(adapter, result.stdout);
      ledger.cumulativeApiSpendUsd += usage.apiSpendUsd;
      const record = { ...call, startedAt, finishedAt: new Date().toISOString(), elapsedMs: result.durationMs, exitCode: result.code, model: adapter.model, promptSha256: sha256(prompt), usage: usage.usage, apiSpendUsd: usage.apiSpendUsd, sessionId: usage.sessionId, stdout: result.stdout };
      records.push(record);
      ledger.records.push({ ...call, finishedAt: record.finishedAt, elapsedMs: result.durationMs, usage: usage.usage, apiSpendUsd: usage.apiSpendUsd, cumulativeApiSpendUsd: ledger.cumulativeApiSpendUsd });
      await writeFile(resultsPath, JSON.stringify(records, null, 2));
      await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
    } catch (error) {
      const record: Record<string, unknown> = { ...call, startedAt, finishedAt: new Date().toISOString(), exitCode: rawResult?.code, error: error instanceof Error ? error.message : String(error), stdout: rawResult?.stdout, stderr: rawResult?.stderr?.slice(-1200) };
      if (call.harness === 'claudeCode' && !String(record.stderr ?? '').trim()) record.claudeDiagnostics = await claudeFailureDiagnostics(adapter.command);
      records.push(record);
      ledger.records.push({ ...call, finishedAt: new Date().toISOString(), exitCode: rawResult?.code, failed: true, accounting: adapter.usageSource === 'claude-stream-json' ? 'subscription-billed; no API spend' : 'unknown' });
      if (call.harness === 'claudeCode') {
        const next = nextClaudeExitOneCount(claudeExitOneCounts.get(call.cell) ?? 0, rawResult?.code);
        claudeExitOneCounts.set(call.cell, next);
        if (next >= 3) {
          skippedCells.add(call.cell);
          const status = await execute('teamclaude', ['status'], 10_000, adapter.cwd);
          record.teamclaudeStatus = (status.stdout || status.stderr).trim().split('\n').slice(0, 1).join(' ').slice(0, 500) || `teamclaude status exited ${status.code}`;
          teamclaudeStatuses.set(call.cell, String(record.teamclaudeStatus));
        }
      }
      if (adapter.usageSource !== 'claude-stream-json') ledger.accountingIncomplete = true;
      await writeFile(resultsPath, JSON.stringify(records, null, 2));
      await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
      completedCalls.add(`${call.questionId}:${call.cell}:${call.harness}`);
      continue;
    }
  }
  process.stdout.write(`${JSON.stringify({ runId, completedCalls: records.length, cumulativeApiSpendUsd: ledger.cumulativeApiSpendUsd, accountingIncomplete: Boolean(ledger.accountingIncomplete), ...(ledger.accountingIncomplete ? { stopReason: 'usage-accounting-incomplete' } : {}), stoppedAt80Percent: stoppedAtThreshold, output: outDir })}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => { console.error(`research-bench: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
