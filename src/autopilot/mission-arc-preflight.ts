// ── 아크 정의 시점 grounded pre-flight (RFC-mission-arcs §14b · A7-L2 · 2026-07-14) ──
//
// 반-인플레이션 핵심 감지기(대표 지시: "불필요하게 아크를 부풀려 나누는 것 방지"). 분류 게이트
// (classifyArcs)가 만든 아크를 materialize·빌드하기 **전에**, 각 아크의 deliverable 이 실제 코드에
// 근거를 두는지 grounded(코드 실독)로 판정한다. 허상 아크(arc2 임베딩 supersede 선례 — 잘못된 파일
// embedding-tier-map.ts + 존재하지 않는 golden-set fixture + 규칙기반 이미 존재)를 HITL 승인 게이트에
// 표면화 → 사람이 keep/narrow/descope/merge 결정(자율경계·§8 역제안).
//
// #4128(페이즈 실행 grounded no-op 게이트)과 대칭 — 같은 grounded 원리를 "아크 정의" 고도에.
// verifyPhaseAlreadySatisfied 와 다르게 "이미 충족?"이 아니라 "근거 있는 deliverable 인가?"를 묻는다
// (정의 시점엔 페이즈 미구현이라 grounding 실패가 정상 — 허상 신호는 잘못된 파일·없는 전제·과대).
//
// 제1원칙: 판정을 debug.log('mission.arc.preflight') 로 관측. fail-soft — ground/LLM/파싱 오류는
// founded/keep(도구 실패로 실작업을 자동 차단하지 않음. HITL 게이트가 여전히 승인 통제).

import { tierModel } from '../llm/model-defaults.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { MissionArc } from '../task-orchestrator/mission.js';
import { adaptiveGround, extractSymbols, type GroundingDeps } from './mission-grounding-ladder.js';

export type ArcPreflightVerdict = NonNullable<MissionArc['preflightVerdict']>;

/** 아크 페이즈 텍스트(제목+설명) — 파일 참조 추출·판정 컨텍스트. */
export interface ArcPhaseText {
  id: string;
  title: string;
  description?: string;
}

export interface ArcPreflightDeps {
  /** 코드베이스 grounding(기본 adaptiveGround). 테스트 주입. */
  ground?: (goal: string) => Promise<{ grounded: boolean; context: string; files: string[] }>;
  /** 파일 존재 확인(기본 실 fs). 테스트 주입. */
  fileExists?: (path: string, repoRoot: string) => boolean;
  /** grounded 파일 내용 읽기(기본 실 fs·상한). 테스트 주입. */
  readFiles?: (files: string[], repoRoot: string) => string;
  /** LLM 판정(기본 streamLLM·sol). 테스트 주입·NODE_ENV=test 는 미주입 시 founded 폴백. */
  judge?: (prompt: string) => Promise<string>;
  /** adaptiveGround의 외부 경계 주입. 공유 구현과 기본 생산 배선은 유지한다. */
  groundingDeps?: Partial<GroundingDeps>;
  repoRoot?: string;
}

/** 소스/문서 파일 경로 참조 추출(순수) — 페이즈 텍스트에서 언급된 파일. 허상 신호(없는 파일) 판정용. */
export function extractFileRefs(text: string): string[] {
  const refs = new Set<string>();
  const re = /(?:src|scripts|docs|test|tests|packages)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;
  for (const m of text.matchAll(re)) refs.add(m[0]);
  return [...refs];
}

function defaultFileExists(path: string, repoRoot: string): boolean {
  try { readFileSync(join(repoRoot, path)); return true; } catch { return false; }
}

function defaultReadFiles(files: string[], repoRoot: string): string {
  const parts: string[] = [];
  for (const f of files.slice(0, 6)) {
    try {
      const body = readFileSync(join(repoRoot, f), 'utf-8').split('\n').slice(0, 100).join('\n');
      parts.push(`### ${f}\n${body}`);
    } catch { /* 접근 실패 스킵 */ }
  }
  return parts.join('\n\n');
}

async function defaultJudge(prompt: string): Promise<string> {
  const { streamLLM } = await import('../llm.js');
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    model: process.env.ELANOUS_ARC_PREFLIGHT_MODEL || process.env.ELANOUS_DECOMPOSE_MODEL || tierModel('better'),
    reasoningEffort: 'medium',
  });
}

function buildPreflightPrompt(
  arc: MissionArc, phaseText: string, groundContext: string, code: string,
  missingFiles: string[], existingRefs: string[] = [],
): string {
  return [
    '역할: 자율 미션의 "아크"(응집 서브골)가 **실제 코드에 근거를 둔 buildable deliverable 인지** 판정한다.',
    '허상 아크의 세 신호(하나라도 강하면 founded 아님):',
    '  1) mirage — 페이즈가 지목한 파일이 아크 의도와 무관하다(예: "임베딩 supersede"인데 지목 파일은',
    '     모델 티어 선택 config). 또는 존재하지 않는 전제(예: "기존 golden-set fixture 재사용"인데 그런 fixture 없음).',
    '  2) over_scope — 아크가 요구하는 산출이 이미 코드에 대부분 존재하거나(중복), 스코프가 "한 파일 수정"',
    '     수준이 아니라 별도 미션급 대공사다(예: 규칙기반이 이미 작동하는데 의미기반 판정기 신설).',
    '  3) founded — 위 문제없이 지목 코드 위에서 스코프대로 구현 가능.',
    '주의: 정의 시점이라 아직 미구현인 게 정상이다. "아직 구현 안 됨"은 mirage 가 아니다(그건 당연).',
    '  mirage 는 오직 잘못된 파일·존재하지 않는 전제일 때. 애매하면 founded(HITL 이 최종 판단).',
    '주의(전제 실재·중요): 아래 "지목 파일 중 실재 확인됨" 목록은 fs 로 존재가 확정된 파일이다. 그 파일을',
    '  "없다/없는 전제"로 근거 삼아 mirage 판정하지 마라 — 관련 코드가 짧게 보이거나 안 보여도 파일은 실재한다.',
    '  같은 실재 파일을 다른 아크는 쓰고 이 아크에선 "없다"고 하는 모순 금지. 실재 확인 목록이 진실이다.',
    '주의(over_scope): 구현 아크가 여러 파일을 새로 만드는 것은 정상이며 "대공사"가 아니다. over_scope 는',
    '  오직 (a) 산출이 이미 코드에 대부분 존재(중복)하거나 (b) 명백히 별도 미션 여러 개급(성숙도 여러 단계)',
    '  일 때만이다. 아크-페이즈 정합성 문제("페이즈가 의도/계약을 정의 안 함")나 "새로 만들 게 많다"는',
    '  over_scope 가 아니다 → founded(분해 품질은 별도 granularity 게이트·HITL 소관).',
    '',
    `## 아크\n이름: ${arc.name}\n의도: ${arc.intent.slice(0, 400)}`,
    `통합 acceptance: ${arc.acceptance.length ? arc.acceptance.join(' / ').slice(0, 400) : '(없음)'}`,
    '',
    `## 아크 페이즈(지목 작업)\n${phaseText.slice(0, 1500)}`,
    '',
    `## 페이즈가 지목했으나 코드베이스에 없는 파일\n${missingFiles.length ? missingFiles.join(', ') : '(없음 — 지목 파일 모두 실재하거나 파일 지목 없음)'}`,
    '',
    `## 지목 파일 중 실재 확인됨(fs 검증 — 이 파일들은 "없는 전제"가 아니다)\n${existingRefs.length ? existingRefs.join(', ') : '(파일 지목 없음)'}`,
    '',
    `## grounding(아크 의도로 찾은 실제 관련 코드)\n${groundContext.slice(0, 3500)}`,
    '',
    `## 관련 코드 실독\n${code.slice(0, 6000)}`,
    '',
    'JSON 한 줄만: {"verdict":"founded|mirage|over_scope","reason":"한 줄 근거(file:line 가능하면)","action":"keep|narrow|descope|merge"}',
    'action: founded→keep · mirage→descope · over_scope→narrow(핵심만 남기고 나머지 후속 미션) 또는 descope.',
  ].join('\n');
}

/** LLM 출력 → 판정. 파싱 실패/애매 → founded/keep(보수적·자동 차단 안 함). 순수. */
export function parsePreflightVerdict(raw: string): ArcPreflightVerdict {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { verdict: 'founded', reason: '판정 파싱 실패(보수적 founded)', action: 'keep' };
    const o = JSON.parse(m[0]) as { verdict?: unknown; reason?: unknown; action?: unknown };
    const verdict = o.verdict === 'mirage' || o.verdict === 'over_scope' ? o.verdict : 'founded';
    const action = o.action === 'narrow' || o.action === 'descope' || o.action === 'merge' ? o.action : 'keep';
    return {
      verdict,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '',
      // verdict/action 정합: founded 는 keep 로 고정(허상 아닌데 descope 방지).
      action: verdict === 'founded' ? 'keep' : action,
    };
  } catch {
    return { verdict: 'founded', reason: '판정 오류(보수적 founded)', action: 'keep' };
  }
}

/** mirage 오탐 가드(순수·대표 2026-07-20 라이브 dce057 재발 수복) — judge 가 "아직 미구현/실제 코드
 *  없음"을 mirage 근거로 든 경우 founded 로 강등. preflight 프롬프트가 "미구현은 mirage 아님"을 명시
 *  (buildPreflightPrompt line 86)하는데도 judge 가 구현·배선 아크를 "코드가 확인되지 않음"으로 허상 판정
 *  하는 체계적 오탐(조사 아크=founded / 구현 아크=mirage). 정당한 mirage 는 (a) 잘못된 파일 지목 또는
 *  (b) 없는 전제 — 지목 파일이 모두 실재(missingFiles 0)하는데 "코드 없음"만 근거면 (a)·(b) 아님 → 강등.
 *  missingFiles>0(잘못된 파일 신호 실재) 또는 미구현 외 근거면 판정 유지(과교정 방지). */
export function guardMirageFalsePositive(
  v: ArcPreflightVerdict, missingFiles: readonly string[],
  opts: { fileExists?: (path: string) => boolean } = {},
): ArcPreflightVerdict {
  if (v.verdict !== 'mirage') return v;
  if (missingFiles.length > 0) return v; // 잘못된 파일 지목 신호가 실재 → 정당한 mirage 가능성, 유지
  // ★ (C·라이브 8cd731 arc0) reason 이 "없는 전제"로 지목한 full-path 파일이 실제로 실재하면 근거 거짓 → 강등.
  //   컨텍스트 유실(B)로 sol 이 실재 파일을 "없다"고 오판한 오탐을 fs 로 확정 반증(B 재료수복이 1차 방어,
  //   이 가드가 2차). basename-only 지목은 못 잡으나 프롬프트의 "실재 확인" 명시가 예방한다.
  if (opts.fileExists) {
    const claimedInReason = extractFileRefs(v.reason).filter((f) => opts.fileExists!(f));
    if (claimedInReason.length > 0) {
      return { verdict: 'founded', reason: `[오탐가드] mirage 근거가 지목한 파일 실재(${claimedInReason.slice(0, 2).join(', ')}) → 강등 ← ${v.reason.slice(0, 140)}`, action: 'keep' };
    }
  }
  const unbuiltSignal = /미구현|아직 (없|구현|만들|작성)|구현되지 ?않|작성되지 ?않|배선되지 ?않|코드가? ?(아직 )?(없|확인되지|존재하지|발견되지)|(실제|해당) ?코드가? ?(확인|존재|발견)되?지 ?않|not (yet )?(implement|writ|built|wired)|no (such |matching )?code|does(n'?t| not) exist yet/i.test(v.reason);
  if (!unbuiltSignal) return v; // "없는 전제" 등 미구현 외 근거면 유지
  return { verdict: 'founded', reason: `[오탐가드] 미구현 근거 mirage 강등(지목 파일 실재) ← ${v.reason.slice(0, 180)}`, action: 'keep' };
}

/** over_scope 오탐 가드(순수·대표 2026-07-20) — over_scope 는 정의상 (a) 산출이 이미 코드에 대부분
 *  존재(중복) 또는 (b) 별도 미션 여러 개급 대공사(성숙도 여러 단계)일 때만이다(buildPreflightPrompt
 *  line 83-84). 그런데 judge 가 아크-페이즈 정합성 문제("페이즈가 구현 계약을 정의 안 함")나 구현 아크의
 *  정상 크기("새로 만들 게 많다")를 over_scope 로 오분류하는 소지(라이브 bc37d7). reason 에 중복·별도
 *  미션급 신호가 하나도 없으면 정의 밖 근거 → founded 강등(정합성/분해품질은 granularity 게이트·HITL
 *  소관이지 over_scope 아님). 둘 중 하나라도 있으면 판정 유지(과교정 방지). mirage 가드와 대칭. */
export function guardOverScopeFalsePositive(v: ArcPreflightVerdict): ArcPreflightVerdict {
  if (v.verdict !== 'over_scope') return v;
  const r = v.reason;
  // (a) 중복 신호 또는 (b) 별도 미션급 대공사 신호 — 정당한 over_scope.
  const duplicateSignal = /이미 (있|존재|구현|작동|충분|대부분)|중복|already (exist|implement|present)|duplicat|redundan/i.test(r);
  const megaScopeSignal = /별도 미션|여러 미션|미션 여러|미션급|성숙도|여러 단계|separate mission|multiple mission|its own mission/i.test(r);
  if (duplicateSignal || megaScopeSignal) return v; // 정당한 over_scope 유지
  return { verdict: 'founded', reason: `[오탐가드] over_scope 근거에 중복·별도미션급 신호 없음(정의 밖·founded 강등) ← ${r.slice(0, 160)}`, action: 'keep' };
}

/** 아크 1개 grounded pre-flight. fail-soft — 도구 오류는 founded/keep(HITL 게이트가 통제). */
export async function preflightArc(
  arc: MissionArc, phases: readonly ArcPhaseText[], deps: ArcPreflightDeps = {},
): Promise<ArcPreflightVerdict> {
  try {
    const mine = phases.filter((p) => arc.phaseIds.includes(p.id));
    const phaseText = mine.map((p) => `- ${p.title}${p.description ? `\n  ${p.description}` : ''}`).join('\n');
    const repoRoot = deps.repoRoot ?? process.cwd();
    const exists = deps.fileExists ?? defaultFileExists;
    const refs = extractFileRefs(`${arc.intent}\n${phaseText}`);
    const missingFiles = refs.filter((f) => !exists(f, repoRoot));
    const existingRefs = refs.filter((f) => exists(f, repoRoot));

    // ★ 소비자 통일(G3·2026-07-14) — 얕은 단발 대신 adaptiveGround(상황 따라 디깅). deps.ground 주입
    //   (테스트·커스텀) 시엔 얕은 경로 보존(하위호환). refs=페이즈 파일참조를 grounding 시드로.
    const query = `[아크: ${arc.name}] ${arc.intent}\n${phaseText.slice(0, 600)}`;
    let groundContext: string;
    let code = '';
    if (deps.ground) {
      const g = await deps.ground(query);
      groundContext = g.context;
      code = g.files.length ? (deps.readFiles ?? defaultReadFiles)(g.files, repoRoot) : '';
    } else {
      const r = await adaptiveGround(query, { seedFiles: refs, symbols: extractSymbols(`${arc.intent}\n${phaseText}`) }, {
        repoRoot,
        ...deps.groundingDeps,
      });
      groundContext = r.context;
      // ★ (B) 컨텍스트 유실 수복(라이브 8cd731) — adaptiveGround 가 실독한 파일 본문을 sol 로 전달. 종전엔
      //   code='' 방치로 "관련 코드 실독"(6000자) 슬롯이 비어, sol 이 실재 파일을 "없는 전제"로 mirage 오판.
      code = r.files.length ? (deps.readFiles ?? defaultReadFiles)(r.files, repoRoot) : '';
    }
    const judge = deps.judge ?? (process.env.NODE_ENV === 'test' ? undefined : defaultJudge);
    if (!judge) return { verdict: 'founded', reason: 'judge 미주입(test) — 보수적 founded', action: 'keep' };
    const raw = await judge(buildPreflightPrompt(arc, phaseText, groundContext, code, missingFiles, existingRefs));
    const rawVerdict = parsePreflightVerdict(raw);
    const v = guardOverScopeFalsePositive(guardMirageFalsePositive(rawVerdict, missingFiles, { fileExists: (f) => exists(f, repoRoot) }));
    const mirageDemoted = rawVerdict.verdict === 'mirage' && v.verdict === 'founded';
    const overScopeDemoted = rawVerdict.verdict === 'over_scope' && v.verdict === 'founded';
    // ★ 관측 보강(대표 지시) — sol 에 넘긴 "재료" 크기를 남겨 mirage 근본을 조회로 구분: groundChars/codeChars
    //   가 작으면 (B) 재료부실, existingRefs>0 인데 mirage 면 (C) 로직 오탐 신호, refsTotal>0·missingFiles>0 면 (A) 탐색.
    debug.log('mission.arc.preflight', v.verdict, {
      arcId: arc.arcId, name: arc.name, action: v.action,
      reason: v.reason.slice(0, 120), missingFiles: missingFiles.slice(0, 4),
      groundChars: groundContext.length, codeChars: code.length,
      existingRefs: existingRefs.slice(0, 6), refsTotal: refs.length,
      ...(mirageDemoted ? { mirageFalsePositiveGuarded: true } : {}),
      ...(overScopeDemoted ? { overScopeFalsePositiveGuarded: true } : {}),
    });
    return v;
  } catch (e) {
    debug.log('mission.arc.preflight', 'error', { arcId: arc.arcId, error: e instanceof Error ? e.message.slice(0, 120) : '' }, { level: 'error' });
    return { verdict: 'founded', reason: 'pre-flight 오류(fail-soft·founded)', action: 'keep' };
  }
}

/** 전 아크 pre-flight → 판정 배열(선언 순). 각 아크의 preflightVerdict 는 호출측이 붙인다. */
export async function preflightArcs(
  arcs: readonly MissionArc[], phases: readonly ArcPhaseText[], deps: ArcPreflightDeps = {},
): Promise<ArcPreflightVerdict[]> {
  const out: ArcPreflightVerdict[] = [];
  for (const arc of arcs) out.push(await preflightArc(arc, phases, deps));
  return out;
}
