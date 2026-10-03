// ── Intent Gate — narrow-waist 수용 게이트 (V1 · 2026-07-09) ────────────────
//
// 자연어 의도 제출을 받는 수용 게이트. V1 = 명시
// 마커만(대표 §8): 마커면 미션, 아니면 passthrough(기존 chat/agent 동작).
//
// ⛔ 2026-08-03 문면 정정([T] 39차 전수 · 원장 `JDG-T18`) — 종전 문면은 *"모든 채널(텔레그램·
//   PWA·음성)의 … 단일 허리"* 였는데 **실측과 갈렸다**. 실제로 `submitIntent` 를 부르는 곳은
//   셋이고(telegram · tui · api) `pwa`·`voice`·`cli` 를 넘기는 자리는 **0곳**이다. 게다가 PWA 는
//   `nexus/api/autopilot-api.ts` 에서 **자기 문으로** 미션을 만든다(`triageGoal` → `createMissionWithSlug`).
//   그 문은 `parseMissionMarker`·`saveMissionOrigin`·`captureTaste`·`spawnMissionPrepare` 를 **안 탄다**.
//   ⇒ ⭐ 즉 여기는 **「단일 허리」가 아니라 「여러 문 중 하나」**다. 그것이 의도인지 누락인지는
//      아직 안 쟀다(`JDG-T18` 처분 ⓑ·ⓒ). ⛔ **그러니 이 파일을 「모든 NL 이 지나는 곳」으로 읽지 마라.**
//   ⚠️ `IntentChannel` 에 `pwa`·`voice`·`cli` 가 남아 있는 것은 **미래 배선 자리**이지 현재 배선이 아니다.
// 미션이면 triageGoal(luna 주도·휴리스틱 floor)로 실행모델·tier 를 붙여 Mission(planning) 생성.
// ★ tier 분류 luna 승격(2026-07-16 대표 지시) — 종전 heuristicTriage(키워드)는 "강화" 같은 의미-큰·
//   키워드-빈약 골을 light 오분류했다(dogfood 실측). 이제 luna 가 semantic scope 로 판정(slug/domain 과
//   같은 Promise.all·hot-path 무증가). [[feedback_mission_fabric_llm_logic_balance_2026_07_16]].
// Task/Workflow 분해는 lazy(구체화·실행 임박 시) — 미션은 가볍게 태어난다.
//
// 설계 SoT: 내부 문서 `DESIGN-intent-narrow-waist-2026-07-09` §3.2·§8.

import { TaskStore } from '../task-orchestrator/store.js';
import { createMission, listMissions, normalizeMissionSource, generateMissionSlug, type MissionSource } from '../autopilot/mission-registry.js';
import { triageGoal, isExecutionModel, type TriageCallable } from '../autopilot/triage.js';
import { resolveDomain, buildDomainPrompt, type DomainClassify } from '../autopilot/domain/resolve.js';
import { judge } from '../llm/judge-layer.js';
import type { ResolveRoleProviderFn, StreamLlmFn } from '../intake-plane/runtime-callables.js';
import { isDomain } from '../autopilot/domain/types.js';
import { autoDecomposeMission, shouldPhaseDecompose } from '../autopilot/mission-engine.js';
import { saveMissionOrigin, type MissionOrigin } from '../autopilot/mission-origin.js';
import { parseMissionMarker } from './marker.js';
import { spawnMissionPrepare } from '../autopilot/mission-prepare-spawn.js';
import { debug } from '../debug/log.js';
import { captureTaste } from '../domains/taste-capture.js';
import { captureSentiment } from '../domains/taste-sentiment.js';

export type IntentChannel = 'telegram' | 'pwa' | 'voice' | 'cli' | 'api' | 'tui';

export interface SubmitIntentInput {
  /** 사람 언어 문장 원문(마커 포함 가능). */
  text: string;
  /** 입력 채널(어댑터 식별·관측). */
  channel: IntentChannel;
  /** 미션 source(기본 'human-intent' = 사람 포착·구 'intake' 리네임). */
  source?: MissionSource;
  /** 스토어 seam(테스트/재사용). 없으면 내부에서 열고 닫음. */
  store?: TaskStore;
  /** 시각 seam(결정론). */
  now?: Date;
  /** human-intent 미션 준비(외부조사 게이트 + 크기적응 분해/승인) 트리거 seam(테스트 격리).
   *  없으면 scripts/se-mission-prepare.ts 를 detached spawn. forceDecompose = 분해 검증 마커
   *  (크기 무관 강제 멀티페이즈 분해 + 리서치·HITL 까지만). */
  spawnPrepare?: (missionId: string, opts?: { forceDecompose?: boolean }) => void;
  /** ★ 발신 origin(채널/chatId/botId) — 준비 완료 알림을 "던진 그 대화창"으로 되돌리기 위해
   *  미션에 심는다(대표 지시 2026-07-11 채널 정정). 없으면 report 채널 폴백. */
  origin?: MissionOrigin;
  /** id title 생성 seam(테스트 격리·luna 우회). 없으면 generateMissionSlug(luna) 디폴트. */
  slugFn?: (goal: string) => Promise<string>;
  /** ★ triage 분류 seam(테스트 격리·luna 우회·2026-07-16). 없으면 classify 역할 judge —
   *  단 NODE_ENV=test 는 미주입(휴리스틱 baseline)으로 실 LLM 호출 방지. */
  triageClassify?: TriageCallable;
  /** ★ 도메인 분류 seam(테스트 격리·luna 우회·2026-07-20). 없으면 classify 역할 judge —
   *  단 NODE_ENV=test 는 미주입(키워드 baseline)으로 실 LLM 호출 방지. */
  domainClassify?: DomainClassify;
  /** Injectable transport for testing the production judge path without network access. */
  judgeDeps?: { streamLLM: StreamLlmFn; resolveRoleProvider: ResolveRoleProviderFn };
}

export type SubmitIntentResult =
  | { route: 'passthrough' }
  | {
      route: 'mission';
      missionId: string;
      goal: string;
      executionModel: string;
      tier: string;
      engine: string;
      /** V4 자동 분해 — 생성된 backlog 태스크 id(승인 전 실행 안 함). */
      taskId?: string;
      /** scheduler 미션이면 골에서 추론한 cron 추천. */
      inferredCron?: string;
      /** ★ human-intent 자동 승인됨(대표 결정 2026-07-10) — 대표가 직접 던진 골은 즉시 실행. */
      autoApproved?: boolean;
      /** 자동 승인 시 실제 배선된 cron(scheduler) 또는 활성 태스크 수. */
      scheduledCron?: string;
      activated?: number;
      /** ★ heavy(큰) 미션 — 리즈닝 멀티페이즈 분해 트리거됨. human-intent 라도 자동 실행
       *  안 함(대표 지시 2026-07-11). 분해 완료 시 플랜 초안 + backlog 페이즈가 HITL 검토 대상. */
      heavy?: boolean;
      needsPhaseReview?: boolean;
      /** ★ human-intent 미션 준비(외부조사 게이트+크기적응) detached 트리거됨(대표 지시 2026-07-11).
       *  research→교정필요면 HITL, clean 이면 heavy 분해(HITL)/light 승인·실행. 즉시 자동승인 제거. */
      needsResearchGate?: boolean;
      /** ★ 분해 검증 마커("미션 분해 검증 …") — 크기 무관 강제 멀티페이즈 분해(리서치 포함)
       *  후 HITL 까지만(실행 없음·대표 지시 2026-07-11). */
      verifyDecompose?: boolean;
    };

/** narrow-waist 게이트 진입점 — 채널 무관. 마커면 Mission(planning) 생성·반환.
 *  ★ human-intent(대표가 직접 던진 골)는 자동 승인·실행(대표 결정) · discovery 등은 proposed(승인대기). */
export async function submitIntent(input: SubmitIntentInput): Promise<SubmitIntentResult> {
  // ── 관측(제1원칙) — 라우팅 결정을 logs.db 에 남긴다. 계측 부재 시 "미션:" 이 왜
  //   passthrough 됐는지(마커 불일치·triage throw 등) 재구성 불가였던 사각 수복
  //   (2026-07-17 대표 실사례: "미션 : " 공백콜론이 조용히 chat 으로 샘). ★조회:
  //   elanous logs --category intent.gate
  const textPreview = (input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

  // ★ Layer2 Taste 수집(P4·D1) — 마커/passthrough 무관 **모든 프롬프트**를 비동기 fire-soft 로
  //   distill→surface_events(kind:'taste'). config OFF 면 즉시 no-op. await 안 함(hot-path 무증가).
  //   passthrough 는 아래에서 early-return 하므로 반드시 마커 분기 前에 건다.
  void captureTaste({ text: input.text ?? '', channel: input.channel, now: input.now }).catch(() => {});
  // ★ Layer2 감정 2층(P5b·D3) — Layer1 행동신호(정정·좌절·중단·만족·무LLM) fire-soft 각인
  //   (category:'taste.sentiment'). weak reward 는 P6 gate 가 소비. config OFF/무신호면 no-op.
  void captureSentiment({ text: input.text ?? '', channel: input.channel, now: input.now }).catch(() => {});

  const marker = parseMissionMarker(input.text);
  if (!marker.isMission) {
    debug.log('intent.gate', 'route.passthrough', {
      channel: input.channel,
      source: input.source ?? 'human-intent',
      reason: 'no-mission-marker',
      textPreview,
    });
    return { route: 'passthrough' };
  }
  debug.log('intent.gate', 'route.mission', {
    channel: input.channel,
    source: input.source ?? 'human-intent',
    goalPreview: marker.goal.replace(/\s+/g, ' ').trim().slice(0, 100),
    forceDecompose: marker.forceDecompose === true,
  });

  const store = input.store ?? new TaskStore();
  const owns = !input.store;
  try {
    // 도메인 맥락 해소(§3.8·D5) — 키워드가 모호하면 최근 미션 도메인으로 기울인다
    // ("반도체 조사"→최근 투자 활동이면 investment). high 면 키워드 그대로.
    const recentDomains = listMissions(store, { limit: 8 }).map((r) => r.domain).filter(isDomain);
    // ★ triage(classify 역할·tier semantic 판정) + 도메인 해소 + LLM slug 를 병렬로(hot-path 무증가).
    //   triageClassify 미주입 & test 면 휴리스틱 baseline(실 LLM 우회).
    const triageClassify = input.triageClassify
      ?? (process.env.NODE_ENV === 'test' && !input.judgeDeps ? undefined : async (prompt: string) => {
        const decision = await judge({ site: 'intent.triage', prompt, ...input.judgeDeps, schema: (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
          const row = value as Record<string, unknown>;
          if (!isExecutionModel(row.executionModel) || (row.tier !== 'light' && row.tier !== 'heavy') ||
            (row.rationale !== undefined && typeof row.rationale !== 'string')) return null;
          return row;
        } });
        return decision.ok ? JSON.stringify(decision.value) : '';
      });
    // ★ 도메인도 의미 판정(2026-07-20) — 키워드는 주제 vs 행위유형을 못 갈라 "요약 기능 구현" 을
    //   business(리서치·PR없음)로 오라우팅. judge 가 semantic 판정(강앵커 high 는 키워드 신뢰).
    const domainClassify = input.domainClassify
      ?? (process.env.NODE_ENV === 'test' && !input.judgeDeps ? undefined : async (goal, ctx) => {
        const decision = await judge({ site: 'intent.domain', prompt: buildDomainPrompt(goal, ctx), ...input.judgeDeps, schema: (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
          const domain = (value as Record<string, unknown>).domain;
          return isDomain(domain) ? domain : null;
        } });
        return decision.ok ? decision.value : null;
      });
    const [resolved, slug, triage] = await Promise.all([
      resolveDomain(marker.goal, { recentDomains, classify: domainClassify }),
      (input.slugFn ?? generateMissionSlug)(marker.goal),
      triageGoal({ goal: marker.goal }, triageClassify ? { classify: triageClassify } : {}),
    ]);
    // ★ 관측(제1원칙) — 도메인 판정을 logs.db 에 남긴다. via=llm + keyword≠domain 이면 luna override.
    //   조회: elanous logs --category intent.gate (event=domain.resolved).
    debug.log('intent.gate', 'domain.resolved', {
      domain: resolved.domain,
      via: resolved.via,
      keyword: resolved.keywordDomain,
      overridden: resolved.keywordDomain !== resolved.domain,
      confidence: resolved.confidence,
      candidates: resolved.candidates,
      executionModel: triage.executionModel,
      tier: triage.tier,
      engine: triage.engine,
    });
    const m = createMission(store, {
      goal: marker.goal,
      source: input.source ?? 'human-intent',
      triage: {
        executionModel: triage.executionModel,
        domain: resolved.domain,
        tier: triage.tier,
        engine: triage.engine,
        rationale: triage.rationale,
        confidence: triage.confidence,
      },
      now: input.now,
      slug,
    });
    const baseCommon = {
      route: 'mission' as const,
      missionId: m.id,
      goal: marker.goal,
      executionModel: triage.executionModel,
      tier: triage.tier,
      engine: triage.engine,
    };
    const source = normalizeMissionSource(input.source);
    // 분해 검증 마커(forceDecompose)면 크기 무관 강제 멀티페이즈 분해(리서치 포함·HITL 까지만).
    const forceDecompose = marker.forceDecompose === true;
    const heavy = forceDecompose || shouldPhaseDecompose({ tier: triage.tier });

    // ★ human-intent(대표가 직접 던진 골) → 외부조사 게이트 + 크기적응 준비를 detached prepare
    //   로 위임(대표 지시 2026-07-11). prepare: omni-crawl 보강 → heavy 분해(HITL 검토)/light
    //   placeholder. 즉시 자동승인은 제거 — 작은 미션도 외부조사 후 게이팅(수렴점=사람 확인).
    //   heavy(또는 분해 검증)면 즉시 placeholder 없이 분해를 prepare 가 수행.
    if (source === 'human-intent') {
      // ★ 발신 origin 저장 — 준비 완료 알림을 던진 그 대화창으로 되돌리기 위해(채널 정정).
      if (input.origin) { try { saveMissionOrigin(m.id, input.origin); } catch { /* fail-soft */ } }
      let taskId: string | undefined;
      if (!heavy) {
        const d = autoDecomposeMission(m.id, { store });   // 작은 미션 placeholder(빠른 응답)
        if (d.ok) taskId = d.taskId;
      }
      try { (input.spawnPrepare ?? spawnMissionPrepare)(m.id, { forceDecompose }); } catch { /* fail-soft */ }
      return {
        ...baseCommon,
        ...(heavy ? { heavy: true, needsPhaseReview: true } : {}),
        ...(forceDecompose ? { verifyDecompose: true } : {}),
        ...(taskId ? { taskId } : {}),
        needsResearchGate: true,
      };
    }

    // ── discovery 등 자율 미션 — proposed(승인 대기). 기존 단일 자동 분해(실행 안 함). ──
    const decomposed = autoDecomposeMission(m.id, { store });
    return {
      ...baseCommon,
      ...(decomposed.ok && decomposed.taskId ? { taskId: decomposed.taskId } : {}),
      ...(decomposed.inferredCron ? { inferredCron: decomposed.inferredCron } : {}),
    };
  } catch (err) {
    // ★ 관측(제1원칙) — marker 는 잡혔으나 triage(luna)/slug/분해에서 throw 하면
    //   호출부(telegram 등)가 미션 등록 실패로 chat 폴백할 수 있다. 조용히 새지 않게 기록.
    debug.log('intent.gate', 'route.error', {
      channel: input.channel,
      goalPreview: marker.goal.replace(/\s+/g, ' ').trim().slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    }, { level: 'error' });
    throw err;
  } finally {
    if (owns) store.close();
  }
}
