/**
 * GRAPH-WIZARD 단계 서재 — 마법사가 짓는 그래프의 `cmd:` 노드가 «이름만»이 아니라 실제로 도는 부품.
 *
 * 노드 하나 = 서재의 단계 하나(⊕ 인자). recipes.yaml 은 `elanous graph step <단계> --arg …` 를 부른다.
 * 단계는 기존 CLI 만 쓴다(research · ask --bare · notify · self review · gh) — 새 실행 경로를 만들지 않는다.
 * 계약: 표준출력 마지막 줄 = JSON {outcome, text?} (graph runner 의 lastJsonObject 가 읽는다).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { queryInstalledPack } from '../knowledge/query.js';

export interface WizardStepSpec {
  id: string;
  /** LLM 에게 보이는 한 줄 — 언제 쓰나 · arg 가 무엇인가. */
  use: string;
  /** 이 단계가 낼 수 있는 결과(간선 map 키). */
  outcomes: string[];
  timeoutMs: number;
}

export const WIZARD_STEPS: readonly WizardStepSpec[] = [
  { id: 'web-search', use: '웹/뉴스를 검색해 결과를 모은다. arg = 검색어(예: "오늘 AI 뉴스")', outcomes: ['ok', 'fail'], timeoutMs: 120_000 },
  { id: 'summarize', use: '앞 단계 결과를 요약한다. arg = 요약 지시(예: "핵심 5줄, 한국어")', outcomes: ['ok', 'fail'], timeoutMs: 300_000 },
  { id: 'llm', use: '앞 단계 결과를 LLM 으로 가공한다(표로 정리·분류·초안 작성 등). arg = 지시', outcomes: ['ok', 'fail'], timeoutMs: 300_000 },
  { id: 'check', use: '앞 단계 결과가 기준을 만족하는지 LLM 이 판정한다. arg = 기준. 결과 ok(통과) · rework(다시)', outcomes: ['ok', 'rework', 'fail'], timeoutMs: 300_000 },
  { id: 'telegram-send', use: '앞 단계 결과를 텔레그램(대표 채널)으로 보낸다. arg 없음', outcomes: ['ok', 'fail'], timeoutMs: 60_000 },
  { id: 'notify-me', use: '실패·포기 같은 사건을 나(대표)에게 알린다. arg = 알림 문구', outcomes: ['ok', 'fail'], timeoutMs: 60_000 },
  { id: 'gh-pr-review', use: 'GitHub PR 을 엘라누스 리뷰어로 리뷰한다. arg = PR 번호(없으면 실행 입력 input.pr). 결과 ok(must-fix 없음) · must-fix', outcomes: ['ok', 'must-fix', 'fail'], timeoutMs: 900_000 },
  { id: 'gh-pr-merge', use: 'GitHub PR 을 squash 머지한다. arg = PR 번호(없으면 input.pr)', outcomes: ['ok', 'fail'], timeoutMs: 300_000 },
  { id: 'knowledge-rag', use: '설치된 지식 팩만 검색해 인용 가능한 근거를 낸다. arg = pack:<slug>@<version>; 실행 입력 input.query 또는 앞 단계 결과로 검색하며 둘 다 없으면 팩의 색인에서 가져온다', outcomes: ['ok', 'fail'], timeoutMs: 120_000 },
  { id: 'custom', use: '위 단계로 안 되는 외부 연동(노션·슬랙 업로드 등). 실행하면 «아직 구현되지 않음»으로 실패한다. arg = 무엇을 해야 하는지', outcomes: ['ok', 'fail'], timeoutMs: 60_000 },
];

/** 재시도 상한 — 넘으면 생성 검증이 문제로 되먹인다(조용히 줄이지 않는다). */
export const WIZARD_MAX_RETRIES = 10;

export const WIZARD_STEP_IDS: ReadonlySet<string> = new Set(WIZARD_STEPS.map((s) => s.id));

export interface WizardNodeStep { label?: string; step?: string; arg?: string; /** 단계 안 재시도 횟수(실패 시 다시 · 노드·간선을 늘리지 않는다). */ retries?: number }

const ELANOUS_BIN = resolve(import.meta.dir, '../../bin/elanous.mjs');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 노드 → recipes.yaml. cmd 노드는 서재 단계를, hitl 노드는 한국어 승인 문구를. */
/**
 * 단계 명령의 머리 — 기본은 PATH 의 `elanous`(설치본 갱신을 따라간다 · 판 폴더 절대경로를 박지 않는다).
 * 작업 트리에서 실물로 돌릴 땐 ELANOUS_WIZARD_BIN='bun <트리>/bin/elanous.mjs' 로 바꾼다.
 */
export function wizardStepBin(): string {
  return process.env.ELANOUS_WIZARD_BIN?.trim() || 'elanous';
}

export function recipesYamlFor(nodes: ReadonlyArray<{ nodeId: string; recipe: string }>, steps: Record<string, WizardNodeStep>, bin = wizardStepBin()): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const match = /^(cmd|approval):([a-z0-9][a-z0-9-]*)$/.exec(node.recipe);
    if (!match || seen.has(match[2]!)) continue;
    seen.add(match[2]!);
    const meta = steps[node.nodeId] ?? {};
    if (match[1] === 'approval') {
      out.push(`${match[2]}:\n  approval: ${JSON.stringify(`${meta.label ?? node.nodeId} — 승인할까요?`)}`);
      continue;
    }
    const spec = WIZARD_STEPS.find((s) => s.id === meta.step) ?? WIZARD_STEPS.find((s) => s.id === 'custom')!;
    const arg = meta.arg ?? (spec.id === 'custom' ? (meta.label ?? node.nodeId) : '');
    const retries = meta.retries && meta.retries > 0 ? meta.retries : 0;
    const command = `${bin} graph step ${spec.id}${arg ? ` --arg ${shellQuote(arg)}` : ''}${retries ? ` --retries ${retries}` : ''}`;
    out.push(`${match[2]}:\n  command: ${JSON.stringify(command)}\n  timeout_ms: ${spec.timeoutMs * (retries + 1)}`);
  }
  return out.length ? `${out.join('\n')}\n` : '{}\n';
}

interface GraphContext { graphId?: string; runId?: string; nodeId?: string; input?: unknown; outputs?: Record<string, unknown> }

function readContext(): GraphContext {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as GraphContext; } catch { return {}; }
}

/** 앞 단계 결과를 사람이 읽는 글로 — 각 결과의 text 를 우선, 아니면 JSON. */
export function previousText(ctx: GraphContext, limit = 12_000): string {
  const parts = Object.entries(ctx.outputs ?? {}).map(([id, value]) => {
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return `[${id}]\n${(value as { text: string }).text}`;
    if (typeof value === 'string') return `[${id}]\n${value}`;
    return value == null ? '' : `[${id}]\n${JSON.stringify(value)}`;
  }).filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > limit ? text.slice(-limit) : text;
}

function runElanous(args: string[], input?: string, timeoutMs = 300_000): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync('bun', [ELANOUS_BIN, ...args], { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

function lastJson(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t) as Record<string, unknown>; } catch { /* keep looking */ }
  }
  return undefined;
}

function prNumber(arg: string | undefined, ctx: GraphContext): string | undefined {
  const fromInput = ctx.input && typeof ctx.input === 'object' ? (ctx.input as { pr?: unknown }).pr : undefined;
  const raw = (arg?.trim() || (fromInput === undefined ? '' : String(fromInput))).replace(/^#/, '');
  return /^\d+$/.test(raw) ? raw : undefined;
}

function ask(prompt: string): { ok: boolean; text: string; error?: string } {
  const r = runElanous(['ask', '--bare', '--json', prompt]);
  const reply = lastJson(r.stdout)?.reply;
  return typeof reply === 'string' && r.code === 0 ? { ok: true, text: reply } : { ok: false, text: '', error: r.stderr.slice(-500) || 'ask failed' };
}

export interface StepResult { outcome: string; text?: string; error?: string }

/** 단계 안 재시도 — 실패면 최대 retries 번 더. 노드·간선을 늘리지 않고 «다시 시도»를 표현한다. */
export function runWizardStepWithRetries(step: string, arg: string | undefined, retries = 0, run: typeof runWizardStep = runWizardStep): StepResult & { tries: number } {
  let tries = 0;
  let result: StepResult = { outcome: 'fail' };
  for (; tries <= Math.max(0, retries); ) {
    tries += 1;
    result = run(step, arg);
    if (result.outcome !== 'fail') break;
    debug.log('graph.wizard', 'step-retry', { step, tries, max: retries + 1 });
  }
  return { ...result, tries };
}

/** `elanous graph step <id> --arg …` 의 몸. 부르는 쪽은 그래프 러너(cmd 노드)다. */
export function runWizardStep(step: string, arg: string | undefined, ctx: GraphContext = readContext()): StepResult {
  const prev = previousText(ctx);
  const started = Date.now();
  let result: StepResult;
  switch (step) {
    case 'knowledge-rag': {
      const query = ctx.input && typeof ctx.input === 'object' && typeof (ctx.input as { query?: unknown }).query === 'string'
        ? (ctx.input as { query: string }).query : prev.trim();
      if (!arg) { result = { outcome: 'fail', error: 'knowledge-rag: pack id(arg) required' }; break; }
      try {
        const hits = queryInstalledPack(arg, query);
        result = hits.length ? { outcome: 'ok', text: hits.slice(0, 5).map(hit => `[${hit.ref}] ${hit.title}: ${hit.body}`).join('\n') }
          : { outcome: 'fail', error: `knowledge-rag: no matches in ${arg}` };
      } catch (error) { result = { outcome: 'fail', error: error instanceof Error ? error.message : String(error) }; }
      break;
    }
    case 'web-search': {
      const query = arg?.trim() || (ctx.input && typeof ctx.input === 'object' && typeof (ctx.input as { query?: unknown }).query === 'string' ? (ctx.input as { query: string }).query : '');
      if (!query) { result = { outcome: 'fail', error: 'web-search: 검색어(arg)가 없다' }; break; }
      const r = runElanous(['research', '--json', '--limit', '5', query], undefined, 120_000);
      const out = lastJson(r.stdout);
      const total = (out?.metadata as { totalHits?: number } | undefined)?.totalHits ?? 0;
      result = r.code === 0 && typeof out?.output === 'string' && total > 0 ? { outcome: 'ok', text: out.output } : { outcome: 'fail', error: `검색 결과 없음 (${r.stderr.slice(-300)})` };
      break;
    }
    case 'summarize':
    case 'llm': {
      const instruction = arg?.trim() || (step === 'summarize' ? '핵심만 한국어로 간결하게 요약하라.' : '앞 결과를 정리하라.');
      const r = ask(`${instruction}\n\n--- 입력 ---\n${prev || '(입력 없음)'}`);
      result = r.ok ? { outcome: 'ok', text: r.text } : { outcome: 'fail', error: r.error };
      break;
    }
    case 'check': {
      const r = ask(`아래 결과가 기준을 만족하는지 판정하라. 기준: ${arg?.trim() || '내용이 충실하고 사실에 맞다'}\n첫 줄에 PASS 또는 REWORK 만, 둘째 줄에 이유 한 줄.\n\n--- 결과 ---\n${prev || '(없음)'}`);
      result = !r.ok ? { outcome: 'fail', error: r.error } : { outcome: /^\s*PASS/i.test(r.text) ? 'ok' : 'rework', text: r.text };
      break;
    }
    case 'telegram-send':
    case 'notify-me': {
      const body = step === 'notify-me' ? `${arg?.trim() || '그래프 알림'}${ctx.graphId ? ` (${ctx.graphId})` : ''}` : (prev || arg || '');
      if (!body.trim()) { result = { outcome: 'fail', error: '보낼 내용이 없다' }; break; }
      const r = runElanous(['notify', '--stdin', '--json', ...(step === 'notify-me' ? ['--kind', 'ops-alert'] : [])], body, 60_000);
      result = lastJson(r.stdout)?.ok === true ? { outcome: 'ok', text: '보냄' } : { outcome: 'fail', error: '발송 실패 — elanous logs --category outbound.send' };
      break;
    }
    case 'gh-pr-review': {
      const pr = prNumber(arg, ctx);
      if (!pr) { result = { outcome: 'fail', error: 'PR 번호가 없다(arg 또는 input.pr)' }; break; }
      const r = runElanous(['self', 'review', pr, '--json'], undefined, 900_000);
      const out = lastJson(r.stdout) as { mustFix?: unknown[]; verdict?: string } | undefined;
      result = !out ? { outcome: 'fail', error: r.stderr.slice(-300) || 'review failed' }
        : { outcome: (out.mustFix?.length ?? 0) > 0 ? 'must-fix' : 'ok', text: JSON.stringify({ verdict: out.verdict, mustFix: out.mustFix }) };
      break;
    }
    case 'gh-pr-merge': {
      const pr = prNumber(arg, ctx);
      if (!pr) { result = { outcome: 'fail', error: 'PR 번호가 없다(arg 또는 input.pr)' }; break; }
      const r = runElanous(['gh', 'pr', 'merge', pr, '--squash'], undefined, 300_000);
      result = r.code === 0 ? { outcome: 'ok', text: `PR #${pr} 머지` } : { outcome: 'fail', error: r.stderr.slice(-300) };
      break;
    }
    default:
      result = { outcome: 'fail', error: `아직 구현되지 않은 단계: ${arg ?? step} — recipes.yaml 의 이 줄을 실제 명령으로 바꾸라` };
  }
  debug.log('graph.wizard', 'step', { step, graphId: ctx.graphId, nodeId: ctx.nodeId, outcome: result.outcome, ms: Date.now() - started });
  return result;
}
