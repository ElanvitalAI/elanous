/**
 * PRECHECK-CORE-SIZE (0.3.38 P1 · 대표 11-27 «판단의 루브릭이나 원칙이 없는 거 아닐까요?») — the ONE goal rubric module.
 *
 * S: the pre-launch precheck (#40391) only counted target paths (> 8). The hard canary NOTICE-TURN-QUIET-CLOSE (4 paths,
 *    3 modules) passed un-split; its own pre-launch decomposition had already proposed 2 pieces, and after 3 gate reworks
 *    the run supervisor stopped it with exactly that split (decomposable-no-progress).
 * C: there was no explicit rubric — the decomposition was a recommendation only, and nothing turned it into a verdict.
 * A: score seven axes (behaviors · blast radius · uncertainty · verification cost · size · dependencies · tier) with
 *    evidence from the goal and the repo, deterministically; the behaviors axis takes the decomposer's pieces (the LLM
 *    judgment node) as evidence. Verdict ladder (graphs/policies/goal-precheck-rubric.yaml verdict_order):
 *    hand · probe-first · split (CORE + FU list) · launch. The same module names CORE/FU for the run supervisor and gives
 *    the verification-cost FU line to GOAL-REVISE — one rubric, no second copy.
 *
 * 세 얼굴: 관측 = 골 문서 «## 사전 검토» 의 축별 점수·근거 줄 ⊕ ask-launch 관측 goal-rubric · 판단 근거 = YAML 루브릭 ·
 *          수복과 인계 = split 은 CORE 만 발사하고 FU 목록을 남긴다 · probe-first/hand 는 발사하지 않고 이유를 남긴다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { security4Hits } from '../judge-butler/done-when.js';

export type RubricVerdict = 'launch' | 'split' | 'probe-first' | 'hand';
export type RubricTier = 'luna' | 'terra' | 'sol';
export type RubricAxisId = 'behaviors' | 'blast_radius' | 'uncertainty' | 'verification_cost' | 'size' | 'dependencies' | 'security_over_spec';

export interface GoalRubric {
  readonly behaviors: { readonly maxCore: number; readonly nonBehaviorMarkers: readonly string[] };
  readonly blastRadius: { readonly maxModules: number; readonly hotFileCommits7d: number };
  readonly uncertainty: { readonly markers: readonly string[] };
  readonly verificationCost: { readonly markers: readonly string[] };
  readonly size: { readonly maxTargetPaths: number; readonly maxNewFiles: number };
  readonly dependencies: { readonly markers: readonly string[] };
  readonly securityOverSpec: { readonly markers: readonly string[]; readonly keepMarkers: readonly string[]; readonly scopeWideningMarkers: readonly string[] };
  readonly edges: { readonly markers: readonly string[] };
  readonly verdictOrder: readonly RubricVerdict[];
  readonly tier: { readonly lunaMax: number; readonly terraMax: number };
}

export interface RubricAxisScore { readonly id: RubricAxisId; readonly score: 0 | 1 | 2; readonly evidence: string }

export interface RubricResult {
  readonly verdict: RubricVerdict;
  readonly reason: string;
  readonly tier: RubricTier;
  readonly axes: readonly RubricAxisScore[];
  /** split only: the CORE piece (one behavior) and the FU pieces. */
  readonly core?: string;
  readonly fu: readonly string[];
  /** Security hardening demanded outside the security-4 paths — relaxed (the lines, verbatim). */
  readonly relaxedSecurity: readonly string[];
}

export interface RubricInput {
  readonly document: string;
  readonly targetPaths: readonly string[];
  /** The pre-launch decomposer's pieces (LLM judgment node); undefined = not measured. */
  readonly pieces?: readonly string[];
  /** Commits touching the path in the last 7 days; undefined = unmeasured. */
  readonly churn?: (path: string) => number | undefined;
  /** Is this PR still open / this cell still not green? undefined = unmeasured (not a dependency verdict). */
  readonly dependencyOpen?: (ref: string) => boolean | undefined;
}

const VERDICTS: readonly RubricVerdict[] = ['hand', 'probe-first', 'split', 'launch'];

export const goalRubricPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'goal-precheck-rubric.yaml');

const posInt = (v: unknown, key: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`goal rubric: ${key} must be a non-negative integer`);
  return v;
};
const strList = (v: unknown, key: string): string[] => {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) throw new Error(`goal rubric: ${key} must be a list of strings`);
  return (v as string[]).map((s) => s.trim());
};

/** Parse + validate (pure). A malformed rubric throws — a broken policy is loud, never silently defaulted. */
export function parseGoalRubric(text: string): GoalRubric {
  const y = (parse(text) ?? {}) as Record<string, unknown>;
  const axes = (y.axes ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const a = (k: string): Record<string, unknown> => axes[k] ?? {};
  const order = strList(y.verdict_order, 'verdict_order');
  if (order.length !== VERDICTS.length || VERDICTS.some((v) => !order.includes(v))) throw new Error(`goal rubric: verdict_order must list ${VERDICTS.join(', ')}`);
  const tier = (y.tier ?? {}) as Record<string, unknown>;
  const lunaMax = posInt(tier.luna_max, 'tier.luna_max'); const terraMax = posInt(tier.terra_max, 'tier.terra_max');
  if (terraMax < lunaMax) throw new Error('goal rubric: tier.terra_max must be ≥ tier.luna_max');
  return {
    behaviors: { maxCore: posInt(a('behaviors').max_core, 'axes.behaviors.max_core'), nonBehaviorMarkers: strList(a('behaviors').non_behavior_markers, 'axes.behaviors.non_behavior_markers') },
    blastRadius: { maxModules: posInt(a('blast_radius').max_modules, 'axes.blast_radius.max_modules'), hotFileCommits7d: posInt(a('blast_radius').hot_file_commits_7d, 'axes.blast_radius.hot_file_commits_7d') },
    uncertainty: { markers: strList(a('uncertainty').markers, 'axes.uncertainty.markers') },
    verificationCost: { markers: strList(a('verification_cost').markers, 'axes.verification_cost.markers') },
    size: { maxTargetPaths: posInt(a('size').max_target_paths, 'axes.size.max_target_paths'), maxNewFiles: posInt(a('size').max_new_files, 'axes.size.max_new_files') },
    dependencies: { markers: strList(a('dependencies').markers, 'axes.dependencies.markers') },
    securityOverSpec: { markers: strList(a('security_over_spec').markers, 'axes.security_over_spec.markers'), keepMarkers: strList(a('security_over_spec').keep_markers, 'axes.security_over_spec.keep_markers'), scopeWideningMarkers: strList(a('security_over_spec').scope_widening_markers, 'axes.security_over_spec.scope_widening_markers') },
    edges: { markers: strList(a('edges').markers, 'axes.edges.markers') },
    verdictOrder: order as RubricVerdict[],
    tier: { lunaMax, terraMax },
  };
}

let cached: { path: string; rubric: GoalRubric } | null = null;
export function loadGoalRubric(path = goalRubricPath()): GoalRubric {
  if (cached?.path === path) return cached.rubric;
  if (!existsSync(path)) throw new Error(`goal rubric missing: ${path}`);
  const rubric = parseGoalRubric(readFileSync(path, 'utf8'));
  cached = { path, rubric };
  return rubric;
}

/** Top-level module of a repo-relative path: `src/<dir>` for src, else the first segment. */
export function moduleOf(path: string): string {
  const parts = path.replace(/^\.\//u, '').split('/').filter(Boolean);
  if (parts[0] === 'src' && parts.length > 2) return `src/${parts[1]}`;
  return parts[0] ?? path;
}

const PATH_TOKEN = /(?:src|scripts|docs|graphs|test|apps)\/[\w./@-]+/gu;

/** Target paths a decomposer piece names (its «대상 경로:» line, else any path tokens). */
export function piecePaths(piece: string): string[] {
  const line = /대상\s*경로\s*:\s*([^\n]+)/u.exec(piece)?.[1] ?? piece;
  return [...new Set(line.match(PATH_TOKEN) ?? [])];
}

/** Group pieces by the module set they touch; pieces inside the same single module are steps of one behavior. */
export function behaviorGroups(pieces: readonly string[]): string[][] {
  const groups: { modules: Set<string>; pieces: string[] }[] = [];
  for (const piece of pieces) {
    const modules = new Set(piecePaths(piece).map(moduleOf));
    const home = groups.find((g) => modules.size > 0 && [...modules].every((m) => g.modules.has(m)) && g.modules.size === 1 && modules.size === 1);
    if (home) home.pieces.push(piece);
    else groups.push({ modules, pieces: [piece] });
  }
  return groups.map((g) => g.pieces);
}

function doneWhenLines(document: string): string[] {
  const lines = document.split(/\r?\n/u);
  const at = lines.findIndex((l) => /^\s*완료선\s*:/u.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*-\s+\S/u.test(l)) { out.push(l.trim()); continue; }
    if (l.trim() === '') { if (out.length) break; continue; }
    break;
  }
  return out;
}

const hit = (text: string, markers: readonly string[]): string[] => markers.filter((m) => text.includes(m));
const firstLine = (s: string): string => s.split('\n')[0]!.trim();

/** Score a goal against the rubric (pure apart from the injected readers). */
export function scoreGoalRubric(input: RubricInput, rubric: GoalRubric = loadGoalRubric()): RubricResult {
  const { document, targetPaths } = input;
  const axes: RubricAxisScore[] = [];
  let groups: string[][] | undefined;

  // (1) behaviors — CORE = exactly one.
  let behaviors: number;
  let behaviorLines: string[] = [];
  if (input.pieces && input.pieces.length > 0) {
    groups = behaviorGroups(input.pieces);
    behaviors = groups.length;
    axes.push({ id: 'behaviors', score: behaviors <= rubric.behaviors.maxCore ? 0 : 2,
      evidence: `분해기 조각 ${input.pieces.length} → 행동 묶음 ${behaviors}(같은 모듈 안 조각 = 한 행동)` });
  } else {
    const lines = doneWhenLines(document).filter((l) => hit(l, rubric.behaviors.nonBehaviorMarkers).length === 0);
    behaviorLines = lines;
    behaviors = lines.length;
    axes.push({ id: 'behaviors', score: behaviors <= rubric.behaviors.maxCore ? 0 : behaviors === 2 ? 1 : 2,
      evidence: `분해기 미측정 · 완료선 행동 줄 ${behaviors}(비행동 표지 제외)` });
  }

  // (2) blast radius — modules · hot files · security-4.
  const modules = [...new Set(targetPaths.map(moduleOf))];
  const churnByPath = new Map(targetPaths.map((p) => [p, input.churn ? input.churn(p) : undefined] as const));
  const hot = targetPaths.filter((p) => (churnByPath.get(p) ?? 0) >= rubric.blastRadius.hotFileCommits7d);
  const churnUnmeasured = targetPaths.filter((p) => churnByPath.get(p) === undefined);
  const sec4 = security4Hits(targetPaths);
  const blast = modules.length > rubric.blastRadius.maxModules ? 2 : (modules.length > 1 || hot.length > 0) ? 1 : 0;
  axes.push({ id: 'blast_radius', score: (sec4.length ? 2 : blast) as 0 | 1 | 2,
    evidence: `모듈 ${modules.length}(${modules.join(' · ') || '없음'})${hot.length ? ` · 핫파일 ${hot.join(' · ')}` : ''}${churnUnmeasured.length ? ` · 핫파일 미측정 ${churnUnmeasured.length}` : ''}${sec4.length ? ` · 보안 4종 ${sec4.join(' · ')}` : ''}` });

  // (3) uncertainty.
  const unsure = hit(document, rubric.uncertainty.markers);
  axes.push({ id: 'uncertainty', score: unsure.length ? 2 : 0, evidence: unsure.length ? `표지 ${unsure.join(' · ')}` : '원인·설계 미정 표지 없음' });

  // (4) verification cost.
  const costly = hit(document, rubric.verificationCost.markers);
  axes.push({ id: 'verification_cost', score: costly.length ? 1 : 0, evidence: costly.length ? `${costly.join(' · ')} → E4 증거 칸 FU` : '시험 우주·단위 시험으로 닫힘' });

  // (5) size.
  const newFiles = (/신설\s*:\s*([^\n]+)/u.exec(document)?.[1]?.match(PATH_TOKEN) ?? []).length;
  const sizeScore = targetPaths.length > rubric.size.maxTargetPaths || newFiles > rubric.size.maxNewFiles ? 2 : targetPaths.length > rubric.size.maxTargetPaths / 2 ? 1 : 0;
  axes.push({ id: 'size', score: sizeScore as 0 | 1 | 2, evidence: `대상 경로 ${targetPaths.length} · 신설 ${newFiles}` });

  // (6) dependencies.
  const depLines = document.split(/\r?\n/u).filter((l) => hit(l, rubric.dependencies.markers).length > 0);
  const refs = [...new Set(depLines.flatMap((l) => l.match(/#\d+|[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+/gu) ?? []))];
  const depState = new Map(refs.map((r) => [r, input.dependencyOpen ? input.dependencyOpen(r) : undefined] as const));
  const open = refs.filter((r) => depState.get(r) === true);
  const unknownDeps = refs.filter((r) => depState.get(r) === undefined);
  axes.push({ id: 'dependencies', score: open.length ? 2 : 0, evidence: refs.length
    ? `선행 ${refs.join(' · ')}${open.length ? ` · 열림 ${open.join(' · ')}` : ''}${unknownDeps.length ? ` · 미측정 ${unknownDeps.join(' · ')}` : open.length ? '' : ' · 모두 닫힘'}` : '선행 없음' });

  // (7) security over-spec — hardening demanded outside the security-4 paths is relaxed (대표 «보안 과하게 넣지 마라»).
  const relaxedSecurity = securityOverSpecLines(document, targetPaths, rubric);
  axes.push({ id: 'security_over_spec', score: 0, evidence: relaxedSecurity.length
    ? `보안 4종 경로 밖 보안 강화 요구 ${relaxedSecurity.length}줄 → 완화(요구하지 않는다)` : sec4.length ? '보안 4종 경로 — 보안 요구 유지' : '과잉 보안 요구 없음' });

  const total = axes.reduce((s, a) => s + a.score, 0);
  const tier: RubricTier = total <= rubric.tier.lunaMax ? 'luna' : total <= rubric.tier.terraMax ? 'terra' : 'sol';

  // Verdict ladder in YAML order: the first verdict whose condition holds.
  const conditions: Record<RubricVerdict, string | null> = {
    hand: sec4.length ? `보안 4종 경로(${sec4.join(' · ')}) — 손·Terra` : open.length ? `선행 열림(${open.join(' · ')}) — 기다린다` : null,
    'probe-first': unsure.length ? `원인·설계 미정(${unsure.join(' · ')}) — 탐색 칸 먼저` : null,
    split: behaviors > rubric.behaviors.maxCore ? `행동 ${behaviors} > ${rubric.behaviors.maxCore} — CORE 하나만 발사`
      : modules.length > rubric.blastRadius.maxModules ? `모듈 ${modules.length} > ${rubric.blastRadius.maxModules} — CORE 먼저`
      : sizeScore === 2 ? `크기 초과(대상 ${targetPaths.length} · 신설 ${newFiles}) — CORE 먼저` : null,
    launch: '한 행동 · 반경 안 · 원인 알려짐',
  };
  const verdict = rubric.verdictOrder.find((v) => conditions[v] !== null) ?? 'launch';
  let core: string | undefined;
  let fu: string[] = [];
  if (verdict === 'split') {
    if (groups && groups.length > 1) { core = groups[0]!.map(firstLine).join(' / '); fu = groups.slice(1).map((g) => g.map(firstLine).join(' / ')); }
    else if (input.pieces && input.pieces.length > 1) { core = firstLine(input.pieces[0]!); fu = input.pieces.slice(1).map(firstLine); }
    else if (behaviorLines.length > 1) { const bare = behaviorLines.map((l) => l.replace(/^[-*]\s*/u, '')); core = bare[0]!; fu = bare.slice(1); }
    // No CORE can be built (one piece but too wide) → the caller must not launch the whole goal (review must-fix).
  }
  if (costly.length) fu = [...fu, `E4 증거 칸 — ${costly.join(' · ')}`];
  return { verdict, reason: conditions[verdict]!, tier, axes, ...(core ? { core } : {}), fu, relaxedSecurity };
}

/** Lines demanding security hardening while no target path is a security-4 path (empty when one is). */
export function securityOverSpecLines(document: string, targetPaths: readonly string[], rubric: GoalRubric = loadGoalRubric()): string[] {
  if (security4Hits(targetPaths).length > 0) return [];
  // The policy pack itself and harness records name these words to forbid them — they are never demands.
  const out: string[] = [];
  let skip = false;
  for (const raw of document.split(/\r?\n/u)) {
    const l = raw.trim();
    if (/^#{1,6}\s/u.test(l)) { skip = /^#{1,6}\s*(정책 팩|사전 검토|판정값 재조정|발사 전 분해 권고|CORE 분할)/u.test(l); continue; }
    if (skip || !l || l.includes(SECURITY_RELAX_NOTE)) continue;
    if (hit(l, rubric.securityOverSpec.markers).length > 0 && hit(l, rubric.securityOverSpec.keepMarkers).length === 0) out.push(l);
  }
  return out;
}

export const SECURITY_RELAX_NOTE = '(완화 — 보안 4종 경로 밖 보안 강화 요구는 정책상 하지 않는다 · PRECHECK-CORE-SIZE)';

/** Mark the over-spec security lines in place (outside lines only change; the verbatim ask is quoted in the record). */
export function relaxSecurityOverSpec(document: string, result: RubricResult): string {
  if (result.relaxedSecurity.length === 0) return document;
  const set = new Set(result.relaxedSecurity);
  return document.split('\n').map((l) => set.has(l.trim()) && !l.includes(SECURITY_RELAX_NOTE) ? `${l} ${SECURITY_RELAX_NOTE}` : l).join('\n');
}

/** The `## 사전 검토` lines for a rubric result (appended to the precheck record). */
export function renderRubricLines(result: RubricResult): string[] {
  return [
    `- 루브릭 판정: ${result.verdict} — ${result.reason} · 권장 모델 등급 ${result.tier}`,
    ...result.axes.map((a) => `- 축 ${a.id}: ${a.score} — ${a.evidence}`),
    ...(result.core ? [`- CORE(이 런이 구현): ${result.core}`] : []),
    ...result.fu.map((f, i) => `- FU ${i + 1}: ${f}`),
    ...result.relaxedSecurity.map((l) => `- 보안 과잉 완화: «${l.slice(0, 160)}»`),
  ];
}

/** Insert a «## CORE 분할» block before the first heading so the child implements only the CORE piece. */
export function applyCoreSplit(document: string, result: RubricResult): string {
  if (result.verdict !== 'split' || !result.core) return document;
  const block = [
    '## CORE 분할(PRECHECK-CORE-SIZE)',
    '- 이 런은 아래 CORE 하나만 구현한다. FU 줄은 구현하지 않고 PR 본문 «범위 밖=FU» 에 그대로 옮긴다.',
    `- CORE: ${result.core}`,
    ...result.fu.map((f, i) => `- FU ${i + 1}: ${f}`),
    '', '',
  ].join('\n');
  const at = document.search(/^#{1,6} /mu);
  return at < 0 ? `${block}${document}` : `${document.slice(0, at)}${block}${document.slice(at)}`;
}

/** Run supervisor reuse: name CORE and FU for a decomposition proposal with the same grouping rule. */
export function rubricSplitLine(pieces: readonly string[]): string {
  const groups = behaviorGroups(pieces);
  const core = (groups[0] ?? []).map(firstLine).join(' / ');
  const fu = groups.slice(1).map((g) => g.map(firstLine).join(' / '));
  return `CORE(루브릭 행동 묶음 1): ${core}${fu.length ? ` · FU: ${fu.join(' · ')}` : ''}`;
}

/** GOAL-REVISE reuse: the verification-cost FU line for a goal (live infra / new sim world → separate E4 cell). */
export function rubricVerificationFu(document: string, rubric: GoalRubric = loadGoalRubric()): string | undefined {
  const costly = hit(document, rubric.verificationCost.markers);
  return costly.length ? `E4 증거 칸 FU — ${costly.join(' · ')}(루브릭 verification_cost)` : undefined;
}

/** GOAL-REVISE reuse: is this review finding an edge (→ FU cell) rather than the CORE behavior? */
export function isEdgeFinding(finding: string, rubric: GoalRubric = loadGoalRubric()): boolean {
  // a finding naming a real risk or defect is never an edge, whatever words it uses (review must-fix)
  return hit(finding, rubric.edges.markers).length > 0 && hit(finding, rubric.securityOverSpec.keepMarkers).length === 0;
}

/** A review finding that demands widening the security-4 path list (outside those paths, with no named risk). */
export function isSecurityScopeWidening(finding: string, targetPaths: readonly string[], rubric: GoalRubric = loadGoalRubric()): boolean {
  return security4Hits(targetPaths).length === 0
    && hit(finding, rubric.securityOverSpec.scopeWideningMarkers).length > 0
    && hit(finding, rubric.securityOverSpec.keepMarkers).length === 0;
}
