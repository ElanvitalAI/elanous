// OR-MODEL-NAMESPACE (대표 2026-10-10 «OpenRouter 로 Claude 계열이 안 도는 이유를 먼저 고쳐라»).
//
// S: 구현 자식 모델 해석(`resolveImplementationChildModel`)은 `openrouter/<vendor>/<model>` 을 호스트의
//    `discovery-snapshot.json` 에 «있는 id» 로만 받는다.
// C: 스냅숏은 갱신이 멎으면 늙는다(09-23 판) — 그 뒤 OpenRouter 에 올라온 모델(claude-haiku-5.5 등)은
//    «있는데도» 거부된다. 거부 사유는 「없다」지만 사실은 「우리 스냅숏이 모른다」다.
// A: 스냅숏에 없을 때만 공개 `/api/v1/models` 를 «한 번» 묻는다(기존 `openrouterSource` 재사용 · 키 불요).
//    있으면 그 항목을 스냅숏에 합치고 카탈로그를 다시 읽는다. 없으면 지금처럼 거부.
//    ⛔ 네트워크 실패·시간 초과는 «거부»(fail-closed) — 「확인 못 함」을 「있다」로 접지 않는다.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../../debug/log.js';
import { isolatedCatalogTestUniverse, reloadCatalog } from '../loader.js';
import { defaultDiscoveryCachePath, readDiscoveryCache, type DiscoverySnapshot } from './cache.js';
import { openrouterSource } from './sources/openrouter.js';
import type { DiscoveredModel } from './types.js';

export const OPENROUTER_LIVE_RESOLVE_TIMEOUT_MS = 10_000;
export const OPENROUTER_SNAPSHOT_STALE_DAYS = 7;
const NAMESPACED_OPENROUTER_ID = /^openrouter\/([^/\s]+\/[^/\s]+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 이 프로세스에서 라이브로 확인한 id — 스냅숏 쓰기가 실패해도 같은 프로세스의 재해석은 통과시킨다. */
const liveVerified = new Set<string>();

export function isLiveVerifiedOpenRouterModel(id: string): boolean {
  return liveVerified.has(id);
}

export function __resetOpenRouterLiveResolveForTests(): void {
  liveVerified.clear();
}

/** `openrouter/<vendor>/<model>` → `<vendor>/<model>`(스냅숏·OpenRouter 의 id). 형식이 아니면 undefined. */
export function upstreamOpenRouterId(id: string): string | undefined {
  return NAMESPACED_OPENROUTER_ID.exec(id)?.[1];
}

/** 카탈로그 로더가 «접는» 스냅숏 경로. 시험 런타임에서 명시 경로가 없으면 undefined(실 `~/.elanous` 를 안 건드린다). */
export function foldSnapshotPath(): string | undefined {
  const explicit = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT?.trim();
  if (explicit) return explicit;
  if (isolatedCatalogTestUniverse()) return undefined;
  return defaultDiscoveryCachePath();
}

export function snapshotAgeDays(snapshot: DiscoverySnapshot | null, now: number = Date.now()): number | undefined {
  if (!snapshot?.generatedAt) return undefined;
  const t = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

export function readFoldSnapshotAgeDays(now: number = Date.now()): number | undefined {
  const path = foldSnapshotPath();
  return path ? snapshotAgeDays(readDiscoveryCache({ cachePath: path }), now) : undefined;
}

function persistMergedModel(path: string, model: DiscoveredModel, now: number): boolean {
  try {
    const existing = readDiscoveryCache({ cachePath: path });
    const snapshot: DiscoverySnapshot = existing ?? {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      sources: [],
      models: [],
    };
    if (!snapshot.models.some((m) => m.provider === 'openrouter' && m.id === model.id)) {
      snapshot.models.push(model);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export type OpenRouterLiveLookup =
  | { found: true; id: string; merged: DiscoveredModel; persisted: boolean; snapshotAgeDays?: number }
  | { found: false; id: string; error?: string; snapshotAgeDays?: number };

/** 스냅숏에 없는 `openrouter/<vendor>/<model>` 을 공개 `/models` 에 «한 번» 묻는다.
 *  found → 스냅숏에 합치고(가능하면) 카탈로그를 다시 읽는다. error → 확인 못 함(호출자가 거부). */
export async function liveLookupOpenRouterModel(
  id: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number; persist?: boolean } = {},
): Promise<OpenRouterLiveLookup> {
  const now = opts.now ?? Date.now;
  const path = foldSnapshotPath();
  const ageDays = path ? snapshotAgeDays(readDiscoveryCache({ cachePath: path }), now()) : undefined;
  const age = ageDays !== undefined ? { snapshotAgeDays: ageDays } : {};
  const upstream = upstreamOpenRouterId(id);
  if (!upstream) {
    debug.log('registry.discovery', 'child-model-live-resolve', { id, found: false, ...age, error: 'not-namespaced' });
    return { found: false, id, error: 'not-namespaced', ...age };
  }
  const result = await openrouterSource.run({
    timeoutMs: opts.timeoutMs ?? OPENROUTER_LIVE_RESOLVE_TIMEOUT_MS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    now,
  });
  if (!result.ok) {
    const error = result.error ?? 'unknown';
    debug.log('registry.discovery', 'child-model-live-resolve', { id, found: false, ...age, error });
    return { found: false, id, error, ...age };
  }
  const merged = result.models.find((m) => m.id === upstream);
  if (!merged) {
    debug.log('registry.discovery', 'child-model-live-resolve', { id, found: false, ...age });
    return { found: false, id, ...age };
  }
  liveVerified.add(id);
  // ⚠️ 잠금 없는 read-modify-write — discovery 크론과 같은 순간이면 한쪽 쓰기가 사라질 수 있다(감시 항목 · 다음 조회가 다시 합친다).
  const persisted = path && opts.persist !== false ? persistMergedModel(path, merged, now()) : false;
  if (persisted) reloadCatalog();
  debug.log('registry.discovery', 'child-model-live-resolve', { id, found: true, ...age, persisted });
  return { found: true, id, merged, persisted, ...age };
}
