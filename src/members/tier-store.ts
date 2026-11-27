// SMART-ROUTER-TIER-FULL-WIRE (ROSTER-0333 칸 43 · OP #132082) — 실제 회원 등급 원천 스토어.
//
// jud3 checklist 0.3.33 완료선 «plugins/ 스마트 라우터 플러그인 꾸러미 + src/members/ 등급 권한» 의
// «src/members/» 축: 회원 계정의 등급을 읽는 **호스트 소유 원천**. 게이트(consumer.ts authorizeRouterFeature)는
// 이 원천이 공급하는 등급만 판정하고 — env 폴백은 원천이 등급을 모를 때만, env 마저 없으면 free(fail-closed).
// 그래프 입력이 스스로 등급을 만들 수 없다(consumer.ts 머리 계약 · gcp-architect-expand 선례와 같은 구조).
//
// 등급 원장 = 호스트 파일(기본 elanousStateRoot()/member-tier.json — 운영 ~/.elanous · {"tier":"pro"} 스키마). 파일이 없거나
// 읽을 수 없으면 null(«모름») — 절대 기본 등급을 지어내지 않는다(«모름»을 free 로 바꾸는 건 resolver 의 폭백
// 단계에서만 일어난다).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import type { MembershipResolver } from '../plugins/smart-router/consumer.js';

/**
 * 기본 원장 경로 — elanousStateRoot() 리졸버 경유(isolation-gate PLAN §0: homedir+'.elanous' 하드코딩 금지).
 * 호출 시점 해석이라 ELANOUS_STATE_DIR test↔prod 격리가 성립하고, 운영 기본은 ~/.elanous/member-tier.json(동치).
 */
export function defaultMemberTierLedgerPath(): string {
  return join(elanousStateRoot(), 'member-tier.json');
}

/** 회원 등급 원천 — 호스트 소유. 등급을 모르면 null(지어내지 않는다). */
export interface MemberTierStore {
  currentTier(): string | null;
}

export interface MemberTierStoreOptions {
  /** 시험·호스트 주입 — 원장 파일 대신 고정 등급. 'missing'/'unknown' 은 «모름» 처리. */
  fixture?: string;
  /** 원장 파일 경로(기본 elanousStateRoot()/member-tier.json — 운영 ~/.elanous/member-tier.json). */
  ledgerPath?: string;
}

/** 원장 파일 읽기 — 스키마 {"tier":"free|pro|advanced"}. 없으면·깨지면 null. */
function readTierFromLedger(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tier?: unknown };
    return typeof parsed.tier === 'string' ? parsed.tier : null;
  } catch {
    return null;
  }
}

/** 실제 회원 등급 원천 스토어 — 원장 파일(또는 시험 fixture)에서 등급을 읽는다. */
export function createMemberTierStore(options: MemberTierStoreOptions = {}): MemberTierStore {
  if (options.fixture !== undefined) {
    if (options.fixture === 'missing' || options.fixture === 'unknown') return { currentTier: () => null };
    return { currentTier: () => options.fixture as string };
  }
  const path = options.ledgerPath ?? defaultMemberTierLedgerPath();
  return { currentTier: () => readTierFromLedger(path) };
}

/**
 * 회원 등급 resolver(원천 → env 폴백 → free) — **실제 원천이 정본**이다.
 * 원천이 등급을 알려주면 env 는 무시된다(env 로 등급 상승 우회 금지 — 시험 ② «원천 우선» 단언).
 * 원천이 모르면 env 폴백(ELANOUS_ROUTER_TIER · 기존 envMembershipResolver 계약 유지),
 * env 도 없으면 free(fail-closed).
 */
export function memberTierResolver(store: MemberTierStore, env: NodeJS.ProcessEnv = process.env): MembershipResolver & { tierSource: string } {
  return {
    currentTier: () => store.currentTier() ?? env.ELANOUS_ROUTER_TIER ?? 'free',
    /** 진입점 게이트 판정 출력에 실리는 등급 출처 표기(full-wire authorizeRouterFeatureAtEntry). */
    tierSource: 'member-tier-store',
  };
}
