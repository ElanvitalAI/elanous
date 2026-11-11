// 범용 스킬 조합 executor (근본 수습·2026-07-23) — 도메인 하드코딩 탈피 + 자율 스킬 조합.
//
// ⚠️ 대표 지적(2026-07-23): (1) domain-presets 하드코딩 스위치는 스킬 늘 때마다 시스템 층 수술 = 비확장.
//   (2) 발표 같은 복합 미션은 **단일 스킬로 안 되고 여러 스킬 조합**(문서조사→덱생성→렌더→이미지)이 필요.
//   dogfood 관측으로 ③조합 부재가 확정됨 → 이 파일이 근본 수습이다:
//     enhance+memory 나침반(anti-drift) → discover(luna 발견) → planChain(LLM: 어떤 스킬을 어떤 순서로)
//       → execute chain(Write 허용·원문 나침반+아티팩트 전달) → observe.
//   1스킬이면 단일 실행, 여러 스킬이면 체인 — 자율 판단. 스킬이 늘어도 시스템 층 수술 불필요.
//
// ⚠️ 이 경로 = **원 콘텐츠 드리프트 경로**(발표덱 사고): 플래너가 원문을 스킬별 한문장 task 로 치환하면 실행
//   스킬이 원문(구체 사실)을 못 봐 일반화로 샌다. P3(2026-07-23)에서 **enhance(verbatim+커버리지 체크리스트) +
//   entry-independent 기억**을 compass 로 각 스킬에 실어 근원을 닫았다(agent-mission/self-implement 동형·재발명0).
//
// 배선: resolveDomainExecute(domain='skill' 또는 미매칭) → 이 executor. 예) `elanous harness run "PPT 만들어줘" --domain skill`.
// 재사용: pickSkillsViaLlm(luna) + getSkillIndex(설명) + streamLLM(체인 계획) + parseSkillMd/executeSkill(Write 허용·web-executor 패턴).
// 관측(제1원칙): harness.skill-compose — discover-start/discovered/planned-chain/step-start/step-progress/step-done/published.
// 안전: BLOCK 규율(Agent 배치·고비용) · 체인 상한 MAX_STEPS. 부작용 스킬 capability tier 는 로드맵.

import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import type { DomainExecute, DomainExecuteCtx, DomainExecuteResult } from './skill-executor.js';
import { runGitCommand } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';
import type { IngestionEntry } from '../agent-substrate/execution/ingestion-policy.js';

const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('harness.skill-compose', event, data); } catch { /* fail-soft */ }
};

const BLOCK_PATTERNS: readonly RegExp[] = [/stochastic/i, /-panel$/i, /consensus/i];
const MAX_STEPS = 4;

/** 산출 아티팩트 추출(순수) — 스킬 출력에서 생성 파일 경로(.pptx/.html/…) 또는 게시 URL. 없으면 null. */
export function parseSkillArtifact(text: string): string | null {
  const url = text.match(/https?:\/\/[^\s)"'`\]]+/i);
  const file = text.match(/([~.]?\/[\w./\-]+\.(?:pptx|key|pdf|html|htm|png|jpg|jpeg|svg|md|docx|xlsx))(?=[\s`"')\]]|$)/i);
  return (file?.[1]?.trim() ?? url?.[0]) ?? null;
}

export type SkillArtifactEvidenceSource = 'fs' | 'regex' | 'none';

export interface SelectedSkillArtifacts {
  artifacts: string[];
  verifiedArtifacts: string[];
  source: SkillArtifactEvidenceSource;
}

/** Filesystem observations outrank output citations; a matching citation only chooses the display order. */
export function selectSkillArtifacts(newFiles: readonly string[], regexArt: string | null, cwd: string): SelectedSkillArtifacts {
  if (newFiles.length) {
    const artifacts = regexArt
      ? [...newFiles.filter((file) => sameArtifact(file, regexArt, cwd)), ...newFiles.filter((file) => !sameArtifact(file, regexArt, cwd))]
      : [...newFiles];
    return { artifacts, verifiedArtifacts: artifacts, source: 'fs' };
  }
  if (regexArt) return { artifacts: [regexArt], verifiedArtifacts: [regexArt], source: 'regex' };
  return { artifacts: [], verifiedArtifacts: [], source: 'none' };
}

/** 스킬 후보(이름+설명) — luna 발견 결과. planChain LLM 이 설명을 보고 조합을 짠다. */
export interface SkillCandidate { name: string; description: string }
/** 조합 스텝 — 어떤 스킬에 어떤 하위 과제를. */
export interface SkillStep { skill: string; task: string }

/** planChain LLM 응답(JSON 배열)을 관대하게 파싱 → SkillStep[]. 후보에 없는 skill·빈 항목 제거. 순수. */
export function parseSkillChainPlan(raw: string, candidates: readonly SkillCandidate[]): SkillStep[] {
  const names = new Set(candidates.map((c) => c.name));
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const steps: SkillStep[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const skill = (it as { skill?: unknown }).skill;
    const task = (it as { task?: unknown }).task;
    if (typeof skill !== 'string' || !names.has(skill)) continue;
    steps.push({ skill, task: typeof task === 'string' && task.trim() ? task.trim() : '' });
  }
  return steps.slice(0, MAX_STEPS);
}

export interface ComposedSkillDeps {
  /** objective 에 관련한 스킬 후보(이름+설명)를 luna 로 발견. 기본 pickSkillsViaLlm + getSkillIndex. */
  discover: (objective: string) => Promise<SkillCandidate[] | null>;
  /** objective + 후보 → 실행할 스킬 체인(순서). LLM 판정. null/[]=단일 top 폴백. 기본 streamLLM. */
  planChain: (objective: string, candidates: readonly SkillCandidate[]) => Promise<SkillStep[] | null>;
  /** 한 스킬을 **Write 허용**(비격리)으로 **worktree cwd 에서** 실행 → 출력. priorContext=이전 단계 산출(체인 문맥).
   *  cwd=산출 파일이 떨어질 워크트리(fs 아티팩트 검출 대상). 기본 parseSkillMd+executeSkill(cwd 전달·파일저장 지시). */
  runSkill: (skill: string, task: string, priorContext: string, cwd: string, onProgress?: (delta: string) => void) => Promise<string>;
  /** ★ anti-drift 인핸싱 명시 override(P3·2026-07-23) — undefined 면 capability/진입정책이 결정(기본 ON).
   *  false 면 강제 OFF(원문만 나침반·체크리스트 없음). resolveActiveCapabilities 의 explicitEnhance 로 전달. */
  enhance?: boolean;
  /** 진입 클래스(§6e) — enhance mode-gating. 기본 elanous-apparatus(하니스=elanous 가 프롬프트 prep). 중첩/외부는 external-verbatim. */
  entry?: IngestionEntry;
}

/**
 * ★ 범용 스킬 조합 executor — objective → luna 발견 → LLM 이 스킬 체인 계획 → 순차 실행(아티팩트 전달) → 게시.
 * 도메인 프리셋에 안 걸리는 어떤 스킬(들)이든 자율 조합. 단일이면 1스텝, 복합이면 여러 스텝(문서조사→덱→PPT→이미지).
 * changes:[] · outcome:'published'(아티팩트=워크트리 밖 산출). 각 단계 관측(제1원칙·진행 버블).
 */
export function buildGenericSkillExecute(deps: ComposedSkillDeps): DomainExecute {
  return async (ctx: DomainExecuteCtx): Promise<DomainExecuteResult> => {
    const objective = ctx.priorFindings && ctx.priorFindings.length
      ? `${ctx.objective}\n\n[이전 지적 — 반영해 재생성]\n${ctx.priorFindings.map((f) => `- ${f}`).join('\n')}`
      : ctx.objective;
    const progress = (msg: string): void => { try { ctx.onProgress?.(msg); } catch { /* fail-soft */ } };

    // ★ substrate 편입(P3 부채 해소·2026-07-23) — 이 실행의 롤·capability 를 선언·관측(executor:skill).
    //   agent-mission/self-implement 시드와 동형. 선언된 capability 가 아래 enhance/memory behavior 를 **구동**한다
    //   (descriptor→살아있는 아키텍처·PLAN §L1/§L2·§6e). 진입 정책(elanous-apparatus)이 enhance mode-gate.
    const { resolveActiveCapabilities } = await import('../agent-substrate/execution/capabilities.js');
    const { describeRole } = await import('../agent-substrate/execution/roles.js');
    const caps = resolveActiveCapabilities('skill', {
      entry: deps.entry ?? 'elanous-apparatus',
      ...(deps.enhance !== undefined ? { explicitEnhance: deps.enhance } : {}),
    });
    observe('role', { role: describeRole({ role: 'executor', executorKind: 'skill' }), capabilities: [...caps.active] });

    // 0) ★ anti-drift 나침반(P3·2026-07-23) — 이 executor 가 **원 드리프트 경로**다: 플래너가 objective 를
    //   스킬별 한문장 task 로 치환하면 실행 스킬이 원문(구체 수치·고유명사·요구 장수·표/다이어그램)을 못 봐서
    //   "임원 키노트" 식 일반화로 샌다. 그래서 (a) enhance 로 원문 verbatim 보존 + 커버리지 체크리스트를 얹고
    //   (b) entry-independent 기억(항상 ON·프롬프트 무접촉·가산 블록)을 더해 **compass** 를 만들어 각 스킬에
    //   나침반으로 실어준다(§3 실행 루프). agent-mission/self-implement 와 동형(재발명 0·prompt-enhance·memory-context 재사용).
    //   ★ enhance/memory 활성 여부 = capability 구동(선언 ∩ 진입정책). 미활성이어도 compass 베이스=원문이라 한문장 치환 드리프트는 닫힘.
    let enhancedBase = objective;   // enhance 미활성 시 원문 자체가 나침반(그것만으로도 한문장 치환 드리프트는 닫힘)
    if (caps.has('enhance')) {
      try {
        const { enhancePrompt } = await import('../prompt-enhance/enhance.js');
        const enh = await enhancePrompt(objective);
        enhancedBase = enh.enhanced;   // 원문을 fenced 로 통째 보존 + 커버리지 체크리스트(누락 판정 기준)
        observe('enhance', { checklist: enh.checklist.length, enhancedBy: enh.enhancedBy, origChars: enh.original.length, enhancedChars: enh.enhanced.length, verbatimPreserved: enh.verbatimPreserved });
      } catch (e) { observe('enhance-failed', { error: errStr(e) }); }
    } else observe('enhance', { active: false, reason: 'capability-gated' });
    let compass = enhancedBase;
    if (caps.has('memory')) try {
      const { recallMemoryContext } = await import('../agent-substrate/execution/memory-context.js');
      const mem = await recallMemoryContext(objective.slice(0, 300), { limit: 5 });
      if (mem) { compass = `${compass}\n\n${mem}`; observe('memory', { injected: true, chars: mem.length }); }
      else observe('memory', { injected: false });
    } catch (e) { observe('memory-failed', { error: errStr(e) }); }

    // 1) 발견(luna) — 후보 스킬(이름+설명). ⚠️ 원문 objective 로(enhanced 는 fenced verbose→키워드 신호 희석).
    observe('discover-start', { objective: objective.slice(0, 100) });
    progress('🔎 관련 스킬 탐색(luna)…');
    let candidates: SkillCandidate[] | null = null;
    try { candidates = await deps.discover(objective); }
    catch (e) { observe('discover-failed', { error: errStr(e) }); }
    const safe = (candidates ?? []).filter((c) => !BLOCK_PATTERNS.some((b) => b.test(c.name)));
    if (!safe.length) { observe('no-skill', { picks: candidates?.length ?? 0 }); return { ok: false, summary: '적합 실행 스킬 미발견(luna 무결과 또는 전부 BLOCK)', changes: [] }; }
    observe('discovered', { candidates: safe.map((c) => c.name).slice(0, 10) });

    // 2) 조합 계획(LLM) — 어떤 스킬을 어떤 순서로. 실패/빈결과=단일 top 폴백.
    progress(`🧩 스킬 조합 계획 (후보 ${safe.length})…`);
    let steps: SkillStep[] | null = null;
    try { steps = await deps.planChain(objective, safe); }
    catch (e) { observe('plan-failed', { error: errStr(e) }); }
    if (!steps || !steps.length) steps = [{ skill: safe[0]!.name, task: objective }];
    steps = steps.filter((s) => safe.some((c) => c.name === s.skill)).slice(0, MAX_STEPS);
    if (!steps.length) steps = [{ skill: safe[0]!.name, task: objective }];
    observe('planned-chain', { steps: steps.map((s) => s.skill) });
    progress(`🧩 계획: ${steps.map((s) => s.skill).join(' → ')}`);

    // 3) 체인 실행 — 각 스킬 Write 허용, 이전 산출을 다음 문맥으로 전달. 아티팩트 수집.
    const artifacts: Array<{ skill: string; artifact: string }> = [];
    // Regex output may cite existing files. Terminal promotion uses filesystem evidence when available,
    // with regex citations retained only as a no-new-file fallback.
    const initialFiles = new Set(fsSnapshot(ctx.cwd));
    const verifiedArtifacts: string[] = [];
    let priorContext = '';
    for (let i = 0; i < steps.length; i++) {
      const { skill } = steps[i]!;
      // ★ anti-drift(P3): 플래너 한문장 task 뒤에 원문 나침반(compass)을 실어 스킬이 원문 사실을 직접 보게 한다.
      //   plannerTask = 이 스킬의 구체 역할(scope) · compass = 원문 SSOT(누락·요약·일반화 금지 기준). scope+facts 분리.
      const plannerTask = steps[i]!.task || objective;
      const artifactRoot = resolve(ctx.cwd, '.elanous-skill-artifacts');
      if (lstatArtifactRootIsSymlink(artifactRoot)) {
        const error = `artifact root must not be a symbolic link: ${artifactRoot}`;
        observe('step-failed', { i, skill, error });
        progress(`⚠️ [${i + 1}/${steps.length}] ${skill} 실패`);
        continue;
      }
      const outputRoot = resolve(artifactRoot, `step-${i + 1}`);
      rmSync(outputRoot, { recursive: true, force: true });
      mkdirSync(outputRoot, { recursive: true });
      const task = `${plannerTask}\n\n[원문 나침반 — 아래가 최종 권위(SSOT). 구체 수치·고유명사·요구 장수·표/다이어그램을 하나도 누락·요약·일반화하지 말 것. 위 과제는 이 원문 안에서의 네 역할이다]\n${compass}\n\n[산출 위치] 결과 파일은 반드시 이 절대 경로 아래에 새로 만들어 저장하라: ${outputRoot}\n파일을 만들지 않고 텍스트만 답하는 것은 금지한다. 결과를 위 경로 아래 실제 새 파일로 저장하라.`;
      observe('step-start', { i, skill, task: plannerTask.slice(0, 80) });
      progress(`▶ [${i + 1}/${steps.length}] ${skill} 실행…`);
      // ★ 수리(dogfood 관측·2026-07-23): fs 스냅샷 — 스킬 실행 前 워크트리 파일. 실행 後 신규 파일 = 신뢰 아티팩트
      //   (regex 출력파싱은 스킬이 읽은 템플릿/문서 경로를 오인 = false-positive 실측). cwd 전달로 산출이 워크트리에 떨어짐.
      const before = new Set(fsSnapshot(ctx.cwd));
      let output = '';
      let ticks = 0;
      try {
        output = await deps.runSkill(skill, task, priorContext, ctx.cwd, (delta) => {
          ticks += 1;
          if (ticks % 25 === 0) { observe('step-progress', { i, skill, ticks, tail: delta.slice(-60) }); progress(`▶ [${i + 1}/${steps.length}] ${skill} · ${ticks}`); }
        });
      } catch (e) { observe('step-failed', { i, skill, error: errStr(e) }); progress(`⚠️ [${i + 1}/${steps.length}] ${skill} 실패`); continue; }
      const newFiles = fsSnapshot(ctx.cwd).filter((f) => !before.has(f));
      const selected = selectSkillArtifacts(newFiles, parseSkillArtifact(output), ctx.cwd);
      for (const artifact of selected.artifacts) artifacts.push({ skill, artifact });
      verifiedArtifacts.push(...selected.verifiedArtifacts);
      const primary = selected.artifacts[0] ?? null;
      priorContext = `[이전 단계 '${skill}' 산출]\n${primary ? `아티팩트: ${primary}\n` : ''}${output.slice(-1000)}`;
      observe('step-done', { i, skill, source: selected.source, newFiles: newFiles.length, artifact: primary?.slice(-60) ?? null, chars: output.length, tail: output.slice(-160) });
      progress(`✓ [${i + 1}/${steps.length}] ${skill}${primary ? ` → ${primary}` : ' (아티팩트 미검출)'}`);
    }

    // 4) 결과 — 아티팩트 하나라도 있으면 published, 전무면 실패(진단용 출력 tail 관측됨).
    if (!artifacts.length) { observe('no-artifact', { steps: steps.map((s) => s.skill) }); return { ok: false, summary: `스킬 조합 [${steps.map((s) => s.skill).join(' → ')}] 실행했으나 산출 아티팩트 미검출`, changes: [] }; }
    const refs = artifacts.map((a) => a.artifact);
    // Regex-only fallbacks remain published references but cannot prove a new filesystem artifact.
    const finalFiles = new Set(fsSnapshot(ctx.cwd));
    const verifiedRefs = verifiedArtifacts.filter((artifact) => finalFiles.has(artifact) && !initialFiles.has(artifact));
    observe('published', { artifacts: refs, verifiedArtifacts: verifiedRefs, chain: steps.map((s) => s.skill) });
    const base = {
      ok: true,
      summary: `스킬 조합 [${steps.map((s) => s.skill).join(' → ')}] → ${refs.join(', ')}`,
      changes: [],
    };
    return verifiedRefs.length
      ? { ...base, outcome: 'published', ref: verifiedRefs.join(' · '), nonCodeEvidence: 'artifact-created' as const }
      : { ...base, outcome: 'published' as const };
  };
}

const errStr = (e: unknown): string => String((e as { message?: string })?.message ?? e).slice(0, 120);

const lstatArtifactRootIsSymlink = (artifactRoot: string): boolean => {
  try { return lstatSync(artifactRoot).isSymbolicLink(); }
  catch { return false; }
};

/** cwd 상대/절대 표기 양쪽을 같은 기준 절대 경로로 바꿔 producer ref와 신규 artifact를 비교한다. */
const sameArtifact = (file: string, ref: string, cwd: string): boolean =>
  normalize(resolve(cwd, file)) === normalize(resolve(cwd, ref));

/** 실행 시점의 전체 tracked+untracked 파일 스냅샷. 기존 clean 파일을 신규 artifact로 오인하지 않는다. */
const fsSnapshot = (cwd: string): string[] => {
  if (!cwd) return [];
  try {
    const result = runGitCommand(cwd, ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return String(result.stdout ?? '')
      .split('\0')
      .filter(Boolean)
      .map((file) => normalize(resolve(cwd, file)));
  } catch { return []; }
};

/** production 기본 — luna 발견(설명 포함) + LLM 체인 계획 + Write 허용 executeSkill(비격리·web-executor 패턴). */
export function defaultGenericSkill(): ComposedSkillDeps {
  return {
    discover: async (objective) => {
      const { pickSkillsViaLlm } = await import('../autopilot/mission-codebase-gate.js');
      const { getSkillIndex } = await import('../skills/index.js');
      const index = getSkillIndex();
      if (!index.length) return null;
      const picks = await pickSkillsViaLlm(objective, index as never, 8);
      if (!picks || !picks.length) return null;
      const byName = new Map(index.map((e) => [e.name, e]));
      return picks.map((n) => ({ name: n, description: (byName.get(n)?.description ?? '').slice(0, 400) }));
    },
    planChain: async (objective, candidates) => {
      const { streamRoleLlm } = await import('../llm/role-stream.js');
      const menu = candidates.map((c) => `- ${c.name}: ${c.description}`).join('\n');
      const prompt = [
        '너는 elanous 하니스의 스킬 조합 플래너다. 주어진 objective 를 완수하기 위해 아래 후보 스킬(executor) 중',
        '필요한 것들을 골라 **실행 순서(체인)**를 짠다. 한 스킬로 충분하면 1개, 여러 산출/단계가 필요하면 여러 개',
        `(최대 ${MAX_STEPS}개). 각 스킬은 파일/웹을 실제로 생성한다(예: frontend-slides=웹 슬라이드덱 HTML,`,
        'native-deck=PPT pptx, diagram-master=다이어그램/이미지, content-to-web=웹 게시). 앞 단계 산출은 다음',
        '단계 문맥으로 전달되니, 예컨대 "웹 덱 → 같은 내용 PPT" 처럼 이어지게 task 를 써라.',
        '',
        `## objective\n${objective.slice(0, 1200)}`,
        '',
        `## 후보 스킬\n${menu}`,
        '',
        'JSON 배열만 출력: [{"skill":"<후보 이름>","task":"<이 스킬이 할 구체 하위과제 한 문장>"}, ...]',
      ].join('\n');
      const raw = await streamRoleLlm('planning', [{ role: 'user', content: prompt }], () => {}, { reasoningEffort: 'high' });
      return parseSkillChainPlan(raw, candidates);
    },
    runSkill: async (skill, task, priorContext, cwd, onProgress) => {
      const { parseSkillMd, executeSkill } = await import('../skills/runner.js');
      const manifest = parseSkillMd(skill);   // ★ withResearchIsolation 미적용 — Write 허용(파일 생성)
      if (!manifest) throw new Error(`skill manifest 없음: ${skill}`);
      // ★ 수리(dogfood): 헤드리스 스킬은 안 시키면 텍스트만 냄 → 파일 저장 명시 + cwd 전달(워크트리 산출·fs 검출).
      const writeInstruction = `\n\n[출력 규율] 산출 결과물(HTML/PPTX/이미지/문서 등)을 반드시 아래 디렉토리에 **실제 파일로 write** 하라(텍스트로만 답하지 말 것): ${cwd}\n마지막 줄에 최종 산출 파일의 절대경로를 출력하라.`;
      const full = (priorContext ? `${task}\n\n${priorContext}` : task) + writeInstruction;
      let buffered = '';
      // executeSkill 은 caller cwd 를 안 받는다(스킬 Write 는 지시된 절대경로에 씀) → writeInstruction 의 절대경로가
      //   워크트리를 가리키므로 산출이 워크트리에 떨어지고, 상위 executor 의 fsSnapshot(changedFiles)이 검출한다.
      const r = await executeSkill(manifest, full, (delta, all) => { buffered = all; onProgress?.(delta); });
      return r.fullResponse || buffered;
    },
  };
}
