// 같은 꼴 이웃 스윕 — 수정 라운드 직전에 «이번 수정과 같은 호출부» 전수 목록을 낸다 (HARNESS-NEIGHBOR-SWEEP · 0.3.28)
//
// S: 11-17 리뷰 지적의 약 70% 가 실패 경로·같은 꼴 이웃 결함이었다 — 한 곳을 고치고 같은 호출을 하는 이웃은 그대로 남았다.
// C: 약한 모델은 «무엇이 또 같은가»를 상상하지 못한다. 하니스가 대신 구조로 찾아 맥락에 실어 주지 않으면 같은 지적이 다음 라운드에 또 온다.
// Q: 수정 라운드마다, 정규식이 아니라 구조(AST)로, 크기를 묶어서, 실패해도 라운드를 막지 않고 이웃을 찾으려면?
// A: 바뀐 줄 범위 안의 호출식(callee)을 AST 로 뽑고 → 같은 callee 호출을 저장소 전체에서 AST 로 찾고 →
//    덜 흔한 callee 부터(더 구체적인 이웃부터) 상한까지 `file:line — 한 줄` 로 낸다.
//    엔진 = ast-grep 바이너리(있으면) → TypeScript 컴파일러 API(의존성 · 폴백) → 둘 다 없으면 tool-missing.
//    ⛔ 모양 판정에 정규식을 쓰지 않는다(R-SIG) — callee 는 AST 노드에서만 나온다.
//
// 정본: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md 칸 4 · 주입 지점 = harness-seams.ts execute(rework).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { AST_GREP_MAX_BUFFER, AST_GREP_TIMEOUT_MS } from '../skills/tools/ast-grep.js';
// SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 게이트 원천(실제 원천 스토어 → env → free fail-closed).
import type { MembershipResolver } from '../plugins/smart-router/consumer.js';
import { authorizeRouterFeatureAtEntry } from '../plugins/smart-router/full-wire.js';
import { createMemberTierStore, memberTierResolver } from '../members/tier-store.js';

// ── 모드 · 상수 ───────────────────────────────────────────────────────────

/** off = 계산도 안 함 · shadow(기본) = 계산해 사건(개수만)만 남김 · on = 수정 라운드 맥락에 주입. */
export type NeighborSweepMode = 'off' | 'shadow' | 'on';
export const NEIGHBOR_SWEEP_ENV = 'ELANOUS_HARNESS_NEIGHBOR_SWEEP';

/** 생략·무효값 = shadow. 켜기는 명시 `on` 만. 등급 게이트(router.neighbor_sweep · advanced 전용) 미달이면
 *  계산도 하지 않는다(off — fail-closed). 원천 미주입 시 실제 회원 등급 원천(member-tier-store→env→free)으로 판정. */
export function resolveNeighborSweepMode(
  raw: unknown,
  membership: MembershipResolver = memberTierResolver(createMemberTierStore()),
): NeighborSweepMode {
  const grant = authorizeRouterFeatureAtEntry('router.neighbor_sweep', membership);
  if (!grant.allowed) return 'off';
  return raw === 'on' || raw === 'off' ? raw : 'shadow';
}

/** 수정 라운드의 계기 — 리뷰어 must-fix 이거나, 결정론 게이트(타입 래칫·시험) 실패를 고치는 래칫 편집. */
export type NeighborSweepTrigger = 'review-mustfix' | 'ratchet-edit';

// 출처: harness-seams.ts groundingPromptBlock 이 자식 프롬프트에 싣는 grounding 사실 상한(facts.slice(0, 20)) —
//   같은 프롬프트 안 한 블록의 줄 예산을 맞춘다. callee 수도 이 값으로 묶는다(이웃 한 줄 없이 callee 만 늘면 의미가 없다).
export const NEIGHBOR_SWEEP_MAX_SITES = 20;
// 출처: src/skills/tools/ast-grep.ts AST_GREP_TIMEOUT_MS — 자식이 AstGrep 도구 한 번에 쓰는 예산을 스윕 «전체» 예산으로 쓴다.
export const NEIGHBOR_SWEEP_DEADLINE_MS = AST_GREP_TIMEOUT_MS;
// 출처: 이 칸의 실측(11-18 mshq) — ast-grep 저장소 전체 한 번 걷기 0.75s(callee 3개 · 일치 6.5천 건) 의 2배 남짓.
//   shadow 는 «동작 변화 0» 이어야 하므로 수정 라운드 지연을 이 안으로 묶고, event-loop watchdog stall 임계(5000ms) 아래에 둔다.
export const NEIGHBOR_SWEEP_SHADOW_BUDGET_MS = 2_000;
// 출처: src/skills/tools/ast-grep.ts oneLine 의 180자 접기 — AstGrep 요약 줄과 같은 폭.
const NEIGHBOR_LINE_CHARS = 180;

// ── 입력·출력 형태 ────────────────────────────────────────────────────────

/** 바뀐 줄 범위(새 쪽 · 1-기준 · 양끝 포함). */
export interface ChangedHunk {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** 엔진이 찾은 호출식 하나. callee 는 AST 노드(식별자·멤버 접근)의 원문. */
export interface StructuralCall {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly callee: string;
  readonly text: string;
}

/** callee 하나에 대한 저장소 전체 검색 결과 — total 은 전부 센 값, sample 은 상한까지만 보관. */
export interface CalleeSites {
  readonly total: number;
  readonly sample: readonly StructuralCall[];
}

export type NeighborSweepOutcome = 'ok' | 'empty' | 'tool-missing' | 'timeout' | 'error';

export interface NeighborSweepResult {
  readonly outcome: NeighborSweepOutcome;
  readonly engine: 'ast-grep' | 'typescript' | 'none';
  readonly hunks: number;
  readonly callees: number;
  readonly sites: readonly StructuralCall[];
  /** 바뀐 줄 밖의 같은 callee 호출 총수(상한 전). */
  readonly totalSites: number;
  readonly truncated: boolean;
  /** 실패 이유(관측용 · 문면 아님 · 오류 이름/코드). */
  readonly reason?: string;
}

// ── 순수 함수 ─────────────────────────────────────────────────────────────

function overlaps(call: StructuralCall, hunks: readonly ChangedHunk[]): boolean {
  return hunks.some((h) => h.file === call.file && call.line <= h.endLine && call.endLine >= h.startLine);
}

/** `$` 가 든 callee 는 ast-grep 패턴에서 메타변수(`$A`)로 읽혀 «아무 호출»에나 맞는다. 엔진과 무관하게 여기서 뺀다
 *  (두 엔진이 같은 집합을 받도록 엔진 밖 순수 층에서 거른다 · 이스케이프 문법이 없다). */
export function isSweepableCallee(callee: string): boolean {
  return callee.length > 0 && !callee.includes('$');
}

/** 순수 — 바뀐 줄 범위와 겹치는 호출식의 callee 를 나온 순서대로 중복 없이 · 상한까지.
 *  시험 파일의 호출은 뺀다 — 이웃 쪽(sitesOf)이 시험 파일을 빼므로 callee 쪽도 같은 기준이어야 상한을 시험 헬퍼가 차지하지 않는다. */
export function calleesInHunks(hunks: readonly ChangedHunk[], changedCalls: readonly StructuralCall[], maxCallees: number = NEIGHBOR_SWEEP_MAX_SITES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const call of changedCalls) {
    if (out.length >= maxCallees) break;
    if (isTestFile(call.file) || !isSweepableCallee(call.callee) || seen.has(call.callee) || !overlaps(call, hunks)) continue;
    seen.add(call.callee);
    out.push(call.callee);
  }
  return out;
}

/** 순수 — 같은 callee 이웃을 고른다. 바뀐 줄 자신은 빼고, 덜 흔한 callee 부터(구체적일수록 같은 결함일 확률이 높다),
 *  같은 callee 안에서는 file·line 순, 전체를 maxSites 로 자른다. totalSites 는 바뀐 줄을 뺀 전체 수. */
export function selectNeighborSites(input: {
  readonly hunks: readonly ChangedHunk[];
  readonly callees: readonly string[];
  readonly sitesByCallee: ReadonlyMap<string, CalleeSites>;
  readonly maxSites?: number;
}): { sites: StructuralCall[]; totalSites: number; truncated: boolean } {
  const maxSites = input.maxSites ?? NEIGHBOR_SWEEP_MAX_SITES;
  const groups = input.callees.map((callee) => {
    const found = input.sitesByCallee.get(callee);
    const sample = (found?.sample ?? []).filter((site) => site.callee === callee && !overlaps(site, input.hunks));
    const selfHits = (found?.sample ?? []).filter((site) => site.callee === callee && overlaps(site, input.hunks)).length;
    // sample 이 상한에 차면 바뀐 줄 자기 호출이 sample 밖에 남을 수 있다 — 그때 total 은 그만큼 크게 잡힌다(근사 · 관측용).
    const total = Math.max(sample.length, (found?.total ?? 0) - selfHits);
    return { callee, total, sample: [...sample].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
  }).filter((group) => group.total > 0);
  groups.sort((a, b) => a.total - b.total || a.callee.localeCompare(b.callee));
  const sites: StructuralCall[] = [];
  let totalSites = 0;
  for (const group of groups) {
    totalSites += group.total;
    for (const site of group.sample) {
      if (sites.length >= maxSites) break;
      sites.push(site);
    }
  }
  return { sites, totalSites, truncated: totalSites > sites.length };
}

/** 순수 — 주입 문면. 한 줄 = `file:line — 호출 원문(접음)`. 이웃이 없으면 ''. */
export function renderNeighborSection(result: NeighborSweepResult, trigger: NeighborSweepTrigger): string {
  if (!result.sites.length) return '';
  const head = `[같은 꼴 이웃 — 이번 수정과 같은 호출부(${result.engine} · 계기 ${trigger} · ${result.sites.length}/${result.totalSites}). 같은 결함이 있으면 함께 고치고, 아니면 건드리지 마라]`;
  const rows = result.sites.map((site) => `- ${site.file}:${site.line} — ${foldLine(site.text)}`);
  return [head, ...rows].join('\n');
}

function foldLine(text: string): string {
  const folded = text.split(/\s+/).filter(Boolean).join(' ');
  return folded.length > NEIGHBOR_LINE_CHARS ? `${folded.slice(0, NEIGHBOR_LINE_CHARS - 3)}...` : folded;
}

/** 순수 — `git diff -U0` 의 새 쪽 줄 범위. 삭제만 있는 덩어리는 그 자리 한 줄로 둔다. 지운 파일(/dev/null)은 뺀다. */
export function parseNewSideHunks(patch: string): ChangedHunk[] {
  const hunks: ChangedHunk[] = [];
  let file: string | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : null;
      continue;
    }
    if (!file || !line.startsWith('@@ ')) continue;
    const plus = line.split(' ').find((token) => token.startsWith('+'));
    if (!plus) continue;
    const [startRaw, countRaw] = plus.slice(1).split(',');
    const start = Number(startRaw);
    const count = countRaw === undefined ? 1 : Number(countRaw);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) continue;
    const startLine = Math.max(1, start);
    hunks.push({ file, startLine, endLine: count === 0 ? startLine : startLine + count - 1 });
  }
  return hunks;
}

// ── 시한이 있는 비동기 실행 ─────────────────────────────────────────────────
//
// 스윕 경로의 모든 자식(ast-grep 탐지 · git · ast-grep scan)은 이 하나로 돈다. spawnSync 는 이벤트 루프를 막아
//   하니스의 예산 타이머가 못 울리므로 쓰지 않는다. 시한이 오면 SIGKILL 하고 timedOut 으로 돌려준다(던지지 않는다).

export interface BoundedRunResult {
  /** 종료 코드. 시한 초과·실행 실패면 null. */
  readonly code: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  /** 실행 실패(바이너리 없음 ENOENT · 출력 상한 초과)의 오류 이름. */
  readonly error?: string;
}

export interface BoundedRunOptions {
  readonly cwd: string;
  readonly deadlineAt: number;
  /** 있으면 stdout 을 모으지 않고 줄마다 넘긴다(큰 출력). */
  readonly onLine?: (line: string) => void;
}

export type BoundedRunner = (command: string, args: readonly string[], opts: BoundedRunOptions) => Promise<BoundedRunResult>;

export const runBounded: BoundedRunner = (command, args, opts) => {
  // 자식 하나의 시한은 AstGrep 도구 1회 예산을 넘지 않는다(setTimeout 상한 넘침도 막는다).
  const remaining = Math.min(opts.deadlineAt - Date.now(), AST_GREP_TIMEOUT_MS);
  if (remaining <= 0) return Promise.resolve({ code: null, stdout: '', timedOut: true });
  return new Promise((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolveRun({ code: null, stdout: '', timedOut: false, error: error instanceof Error ? error.name : 'spawn-failed' });
      return;
    }
    let collected = '';
    let pending = '';
    let bytes = 0;
    let settled = false;
    const finish = (result: BoundedRunResult, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) { try { child.kill('SIGKILL'); } catch { /* 이미 끝남 */ } }
      resolveRun(result);
    };
    const timer = setTimeout(() => finish({ code: null, stdout: '', timedOut: true }, true), remaining);
    const emitLines = (chunk: string): void => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) opts.onLine!(line);
        newline = pending.indexOf('\n');
      }
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > AST_GREP_MAX_BUFFER) { finish({ code: null, stdout: '', timedOut: false, error: 'output-over-buffer' }, true); return; }
      if (opts.onLine) emitLines(chunk); else collected += chunk;
    });
    child.on('error', (error) => finish({ code: null, stdout: '', timedOut: false, error: error.name === 'Error' ? (error as NodeJS.ErrnoException).code ?? 'Error' : error.name }, false));
    child.on('close', (code) => {
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      finish({ code, stdout: collected, timedOut: false }, false);
    });
  });
};

/** ast-grep 바이너리 탐지(비동기 · 시한). 시한 초과면 NeighborSweepTimeout. 없으면 null. */
export async function probeAstGrep(run: BoundedRunner, cwd: string, deadlineAt: number): Promise<string | null> {
  for (const name of ['ast-grep', 'sg']) {
    const result = await run(name, ['--version'], { cwd, deadlineAt });
    if (result.timedOut) throw new NeighborSweepTimeout();
    if (result.code === 0) return name;
  }
  return null;
}

// ── 엔진 ──────────────────────────────────────────────────────────────────

export interface StructuralEngine {
  readonly name: 'ast-grep' | 'typescript';
  callsIn(files: readonly string[], cwd: string, deadlineAt: number): Promise<StructuralCall[]>;
  sitesOf(callees: readonly string[], cwd: string, deadlineAt: number, keepPerCallee: number): Promise<Map<string, CalleeSites>>;
}

export class NeighborSweepTimeout extends Error {
  constructor() { super('neighbor sweep deadline exceeded'); this.name = 'NeighborSweepTimeout'; }
}

const TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;
const TSX_EXTENSIONS = ['.tsx'] as const;
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'] as const;

function isSourceFile(file: string): boolean {
  return [...TS_EXTENSIONS, ...TSX_EXTENSIONS].some((ext) => file.endsWith(ext)) && !file.endsWith('.d.ts');
}
function isTestFile(file: string): boolean {
  return TEST_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

function addSite(map: Map<string, { total: number; sample: StructuralCall[] }>, call: StructuralCall, keep: number): void {
  const entry = map.get(call.callee) ?? { total: 0, sample: [] };
  entry.total++;
  if (entry.sample.length < keep) entry.sample.push(call);
  map.set(call.callee, entry);
}

// ast-grep — 인라인 규칙(JSON 문자열 = YAML)으로 한 번의 걷기에 여러 callee 를 찾는다. 출력은 줄 단위 스트림으로 읽어
//   메모리를 «일치 수 × 작은 레코드»로 묶는다(흔한 callee 는 수 MB 가 나온다 · 실측 debug.log 6.5천 건 = 11.8MB).
// 두 엔진이 같은 callee 집합을 받는다 — 식별자 · this · 그 위의 속성 접근 사슬(`a.b`·`a?.b`·`this.#p`)만.
//   `foo().bar`·`a[0].b`·`a!.b`·`super.x`·동적 import·태그 템플릿은 둘 다 뺀다(TS 쪽 calleeText 와 같은 경계).
//   pattern `$F($$$ARGS)` 은 제네릭 호출 `gen<T>()` 를 놓쳐서 kind 규칙(call_expression · function 칸 · arguments 칸)으로 잡는다.
const CALLEE_CHAIN = {
  any: [
    { kind: 'identifier' },
    { kind: 'this' },
    { all: [
      { kind: 'member_expression' },
      { has: { field: 'object', matches: 'chain' } },
      { has: { field: 'property', any: [{ kind: 'property_identifier' }, { kind: 'private_property_identifier' }] } },
    ] },
  ],
};

function astGrepRules(rules: readonly { id: string; callee: string }[]): string {
  return rules.flatMap((rule) => ['TypeScript', 'Tsx'].map((language) => JSON.stringify({
    id: `${rule.id}:${language}`,
    language,
    utils: { chain: CALLEE_CHAIN },
    rule: {
      kind: 'call_expression',
      all: [
        { has: { field: 'function', all: [{ pattern: rule.callee }, { matches: 'chain' }] } },
        { has: { field: 'arguments', kind: 'arguments' } },
      ],
    },
  }))).join('\n---\n');
}

/** 멤버 사슬 사이 공백·줄바꿈을 지운다 — 사슬은 식별자뿐이라 의미가 바뀌지 않고, TS 엔진의 callee 문자열과 같아진다. */
function normalizeCallee(text: string): string {
  return text.split(/\s+/).join('');
}

async function runAstGrepScan(run: BoundedRunner, bin: string, cwd: string, rules: string, paths: readonly string[], deadlineAt: number, excludeTests: boolean, onMatch: (match: Record<string, unknown>) => void): Promise<void> {
  const args = ['scan', '--inline-rules', rules, '--json=stream', '--color', 'never', ...(excludeTests ? TEST_SUFFIXES.flatMap((s) => ['--globs', `!**/*${s}`]) : []), '--', ...paths];
  const result = await run(bin, args, {
    cwd, deadlineAt,
    onLine: (line) => { try { onMatch(JSON.parse(line) as Record<string, unknown>); } catch { /* 깨진 줄은 버린다 */ } },
  });
  if (result.timedOut) throw new NeighborSweepTimeout();
  if (result.error) throw new Error(`ast-grep ${result.error}`);
  // ast-grep 은 일치 없음에서 1 로 끝난다.
  if (result.code !== 0 && result.code !== 1) throw new Error(`ast-grep exit ${result.code}`);
}

function matchToCall(match: Record<string, unknown>, callee: string): StructuralCall | null {
  const range = match.range as { start?: { line?: number }; end?: { line?: number } } | undefined;
  const file = typeof match.file === 'string' ? match.file : '';
  const start = range?.start?.line;
  const end = range?.end?.line;
  if (!file || typeof start !== 'number' || typeof end !== 'number') return null;
  return { file, line: start + 1, endLine: end + 1, callee, text: typeof match.text === 'string' ? match.text : '' };
}

export function astGrepEngine(bin: string, run: BoundedRunner = runBounded): StructuralEngine {
  return {
    name: 'ast-grep',
    async callsIn(files, cwd, deadlineAt) {
      const paths = files.filter((file) => isSourceFile(file) && existsSync(join(cwd, file)));
      if (!paths.length) return [];
      const calls: StructuralCall[] = [];
      await runAstGrepScan(run, bin, cwd, astGrepRules([{ id: 'call', callee: '$F' }]), paths, deadlineAt, false, (match) => {
        const meta = match.metaVariables as { single?: { F?: { text?: unknown } } } | undefined;
        const callee = meta?.single?.F?.text;
        const call = typeof callee === 'string' ? matchToCall(match, normalizeCallee(callee)) : null;
        if (call) calls.push(call);
      });
      return calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    },
    async sitesOf(callees, cwd, deadlineAt, keepPerCallee) {
      const map = new Map<string, { total: number; sample: StructuralCall[] }>();
      if (!callees.length) return map;
      const rules = astGrepRules(callees.map((callee, index) => ({ id: `n${index}`, callee })));
      await runAstGrepScan(run, bin, cwd, rules, ['.'], deadlineAt, true, (match) => {
        const ruleId = typeof match.ruleId === 'string' ? match.ruleId : '';
        const index = Number(ruleId.slice(1, ruleId.indexOf(':')));
        const callee = Number.isSafeInteger(index) ? callees[index] : undefined;
        const call = callee !== undefined ? matchToCall(match, callee) : null;
        if (call) addSite(map, call, keepPerCallee);
      });
      return map;
    },
  };
}

// TypeScript 컴파일러 API — ast-grep 이 없는 호스트(Pod 이미지)의 구조 폴백. callee = 식별자 또는 멤버 접근 사슬.
function calleeText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleeText(expr.expression);
    return base === null ? null : `${base}${expr.questionDotToken ? '?.' : '.'}${expr.name.text}`;
  }
  return null;
}

function scanCalls(cwd: string, file: string, visit: (call: StructuralCall) => void): void {
  const source = readFileSync(join(cwd, file), 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression);
      if (callee !== null) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        visit({ file, line: start, endLine: end, callee, text: source.slice(node.getStart(sf), node.getEnd()) });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

const yieldTurn = (): Promise<void> => new Promise((resolvePromise) => setImmediate(resolvePromise));

export function typescriptEngine(
  listFiles: (cwd: string, deadlineAt: number) => readonly string[] | Promise<readonly string[]> = (cwd, deadlineAt) => gitSourceFiles(runBounded, cwd, deadlineAt),
): StructuralEngine {
  return {
    name: 'typescript',
    async callsIn(files, cwd, deadlineAt) {
      const calls: StructuralCall[] = [];
      for (const file of files) {
        if (!isSourceFile(file) || !existsSync(join(cwd, file))) continue;
        if (Date.now() > deadlineAt) throw new NeighborSweepTimeout();
        scanCalls(cwd, file, (call) => calls.push(call));
        await yieldTurn();
      }
      return calls;
    },
    async sitesOf(callees, cwd, deadlineAt, keepPerCallee) {
      const map = new Map<string, { total: number; sample: StructuralCall[] }>();
      if (!callees.length) return map;
      const wanted = new Set(callees);
      for (const file of await listFiles(cwd, deadlineAt)) {
        if (!isSourceFile(file) || isTestFile(file)) continue;
        if (Date.now() > deadlineAt) throw new NeighborSweepTimeout();
        try { scanCalls(cwd, file, (call) => { if (wanted.has(call.callee)) addSite(map, call, keepPerCallee); }); } catch { /* 읽기 실패 파일은 건너뛴다 */ }
        await yieldTurn();
      }
      return map;
    },
  };
}

/** 읽기 전용 git 한 번(비동기 · 시한). 시한 초과면 NeighborSweepTimeout · 실패 종료면 ''. */
async function gitRead(run: BoundedRunner, cwd: string, args: readonly string[], deadlineAt: number): Promise<string> {
  const result = await run('git', args, { cwd, deadlineAt });
  if (result.timedOut) throw new NeighborSweepTimeout();
  return result.code === 0 ? result.stdout : '';
}

async function gitSourceFiles(run: BoundedRunner, cwd: string, deadlineAt: number): Promise<string[]> {
  return (await gitRead(run, cwd, ['ls-files', '-z'], deadlineAt)).split('\0').filter(Boolean);
}

/** fork 기준 가지 — self-implement/seams.ts defaultBranchRef 와 같은 순서(origin/HEAD → origin/main·master → main·master).
 *  그쪽은 spawnSync 라 예산 타이머를 막으므로 같은 판정을 시한 있는 비동기로 다시 둔다. */
async function defaultBranchRefBounded(run: BoundedRunner, cwd: string, deadlineAt: number): Promise<string | null> {
  const sym = (await gitRead(run, cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], deadlineAt)).trim();
  if (sym.startsWith('refs/remotes/')) return sym.slice('refs/remotes/'.length);
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await gitRead(run, cwd, ['rev-parse', '--verify', '--quiet', ref], deadlineAt)).trim()) return ref;
  }
  return null;
}

// ── 조립 ──────────────────────────────────────────────────────────────────

/** 바뀐 줄 범위 → 같은 callee 이웃. 실패는 던지지 않고 outcome 으로 돌려준다(수정 라운드를 막지 않는다). */
export async function sweepNeighbors(input: {
  readonly hunks: readonly ChangedHunk[];
  readonly cwd: string;
  readonly engine: StructuralEngine | null;
  readonly maxSites?: number;
  readonly deadlineMs?: number;
  /** 절대 시한 — 있으면 deadlineMs 보다 앞선다(바깥에서 git·탐지 시간까지 센 시한을 그대로 넘긴다). */
  readonly deadlineAt?: number;
  readonly now?: () => number;
}): Promise<NeighborSweepResult> {
  const maxSites = input.maxSites ?? NEIGHBOR_SWEEP_MAX_SITES;
  const base = { hunks: input.hunks.length, callees: 0, sites: [] as StructuralCall[], totalSites: 0, truncated: false };
  if (!input.engine) return { ...base, outcome: 'tool-missing', engine: 'none' };
  const engine = input.engine;
  const deadlineAt = input.deadlineAt ?? (input.now ?? Date.now)() + (input.deadlineMs ?? NEIGHBOR_SWEEP_DEADLINE_MS);
  try {
    const files = [...new Set(input.hunks.map((hunk) => hunk.file))].filter((file) => !isTestFile(file));
    const changedCalls = await engine.callsIn(files, input.cwd, deadlineAt);
    const callees = calleesInHunks(input.hunks, changedCalls, maxSites);
    if (!callees.length) return { ...base, outcome: 'empty', engine: engine.name };
    // 바뀐 줄 자신도 sample 에 들 수 있으니 한 callee 에서 maxSites + 그 callee 의 자기 호출 수만큼 남긴다.
    const selfCalls = changedCalls.filter((call) => overlaps(call, input.hunks)).length;
    const sitesByCallee = await engine.sitesOf(callees, input.cwd, deadlineAt, maxSites + selfCalls);
    const picked = selectNeighborSites({ hunks: input.hunks, callees, sitesByCallee, maxSites });
    return { ...base, callees: callees.length, ...picked, outcome: picked.sites.length ? 'ok' : 'empty', engine: engine.name };
  } catch (error) {
    const timeout = error instanceof NeighborSweepTimeout;
    return { ...base, outcome: timeout ? 'timeout' : 'error', engine: engine.name, reason: error instanceof Error ? error.name : 'unknown' };
  }
}

/** 작업 트리의 바뀐 줄 범위 — fork(merge-base) 대비 diff(커밋·미커밋) ⊕ untracked 는 파일 전체. 읽기 전용 git 만 쓴다.
 *  접두를 a/·b/ 로 못 박는다 — 사용자 설정 diff.noprefix·mnemonicPrefix 가 `+++ b/` 를 바꾸면 덩어리가 조용히 0 이 된다. */
export async function worktreeChangedHunks(cwd: string, deadlineAt: number, run: BoundedRunner = runBounded): Promise<ChangedHunk[]> {
  const baseRef = await defaultBranchRefBounded(run, cwd, deadlineAt);
  const fork = baseRef ? (await gitRead(run, cwd, ['merge-base', 'HEAD', baseRef], deadlineAt)).trim() : '';
  const patch = await gitRead(run, cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', fork || 'HEAD', '--'], deadlineAt);
  const hunks = parseNewSideHunks(patch);
  for (const file of (await gitRead(run, cwd, ['ls-files', '--others', '--exclude-standard', '-z'], deadlineAt)).split('\0').filter(Boolean)) {
    hunks.push({ file, startLine: 1, endLine: Number.MAX_SAFE_INTEGER });
  }
  return hunks.filter((hunk) => isSourceFile(hunk.file));
}

export interface NeighborSweepRunOptions {
  /** 스윕 전체 시한(ms) — 시작 시각부터 센다. 탐지·git·엔진 모두 이 한 시한 안에서 돈다. */
  readonly deadlineMs: number;
  /** false 면 ast-grep 이 없을 때 TS 폴백 없이 tool-missing 으로 끝낸다(shadow). */
  readonly allowFallback: boolean;
}

/** 하니스 수정 라운드용 기본 스윕 — 시작 시각에 시한을 하나 정하고, 탐지 → git → 엔진이 모두 그 시한을 나눠 쓴다. */
export async function sweepWorktreeNeighbors(
  cwd: string,
  opts: NeighborSweepRunOptions = { deadlineMs: NEIGHBOR_SWEEP_DEADLINE_MS, allowFallback: true },
  deps: { readonly run?: BoundedRunner; readonly now?: () => number } = {},
): Promise<NeighborSweepResult> {
  const deadlineAt = (deps.now ?? Date.now)() + opts.deadlineMs;
  const run = deps.run ?? runBounded;
  const failed = (outcome: NeighborSweepOutcome, reason: string): NeighborSweepResult => ({ outcome, engine: 'none', hunks: 0, callees: 0, sites: [], totalSites: 0, truncated: false, reason });
  try {
    const bin = await probeAstGrep(run, cwd, deadlineAt);
    const engine = bin ? astGrepEngine(bin, run) : opts.allowFallback ? typescriptEngine((root, at) => gitSourceFiles(run, root, at)) : null;
    if (!engine) return failed('tool-missing', 'no-ast-grep-shadow');
    const hunks = await worktreeChangedHunks(cwd, deadlineAt, run);
    return await sweepNeighbors({ hunks, cwd, engine, deadlineAt });
  } catch (error) {
    return failed(error instanceof NeighborSweepTimeout ? 'timeout' : 'error', error instanceof Error ? error.name : 'unknown');
  }
}
